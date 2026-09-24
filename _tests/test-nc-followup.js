/*
 * test-nc-followup.js — who the action-plan chaser may email, and who it may not
 * -----------------------------------------------------------------------------
 * Run:  node _tests/test-nc-followup.js
 * No network: fetch is stubbed, so no Airtable write and no Resend send can escape.
 *
 * Why this suite exists (2026-09-03).
 *
 * Troy: "check the rule for sending email reminders for NCNs and make sure it is
 * not sending an email for an action plan on NCNs that are in closed status."
 *
 * Closed and Cancelled were already excluded and were verified clean against the
 * live base. The real leak was one status along: the cron was chasing 15 NCNs at
 * **Letter Sent (4), Ready for Review (8) and Verification (3)** — some weekly for
 * years (OMNCN0612, raised 2017-05-31). In all three the responder has finished
 * and handed the NC on, and the email asserts "no action plan has been started
 * within 5 working days", which is simply not true of them.
 *
 * Two independent things are pinned here, because there are TWO senders:
 *   1. api/nc-followup.js  — the weekday cron. Skips all five statuses.
 *   2. api/ncs.js POST {action:'followup'} — a manual button. Had NO status check
 *      at all, so an admin could fire a chaser at a Closed NC. Now refuses on
 *      Closed/Cancelled (409) and deliberately still allows the three workflow
 *      statuses, because its email reports whichever is true rather than asserting.
 *
 * The trap this suite is built around: **Airtable returns only the fields you
 * name in fields[]**. 'Status' was not requested, so any JS-side status check
 * would have read undefined and passed everything. The stub below enforces that
 * narrowing — it returns only the requested fields, exactly like the real API.
 */
'use strict';
const path = require('path');
// ⚠️ '..', 'api' — the handlers live in NC Tool/api/. This said just '..' until
// 2026-09-17, so the suite could only ever run in a scratch directory where the
// files had been copied to the repo root; from the repo as committed it threw
// MODULE_NOT_FOUND before a single assertion ran. Worse, a stale copy sitting at
// that root makes it run GREEN against the old code — which is how a run of this
// suite passed 46/46 against a file that had just been rewritten.
const API = path.join(__dirname, '..', 'api');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ' — ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

const ALL_STATUSES = ['New', 'Containment', 'Root Cause', 'Corrective Action',
                      'Ready for Review', 'Letter Sent', 'Verification', 'Closed', 'Cancelled'];
/* 2026-09-17: this is now an ALLOW-list of two, not a deny-list of five.
 * Root Cause and Corrective Action moved from chase to skip after the cron
 * emailed 65 NCNs — 55 at Corrective Action, 6 at Root Cause, raised as far back
 * as 2012 — to five managers and Troy. See CHASE_STATUSES in nc-followup.js. */
const MUST_CHASE = ['New', 'Containment'];
const MUST_SKIP  = ['Root Cause', 'Corrective Action',
                    'Ready for Review', 'Letter Sent', 'Verification', 'Closed', 'Cancelled'];
eq('the two sets partition every status', [...MUST_SKIP, ...MUST_CHASE].sort(), [...ALL_STATUSES].sort());

process.env.AIRTABLE_PAT = 'pat_test';
process.env.NC_BASE_ID   = 'appTEST';
process.env.RESEND_API_KEY = 'rs_test';
process.env.CRON_SECRET  = 'secret';

// ── The world ───────────────────────────────────────────────────────────────
const RAISED = '2020-01-06';            // long past any 5-working-day deadline
let DB, MAILS, PATCHES, LAST_FORMULA;

function seed() {
  DB = ALL_STATUSES.map((st, i) => ({
    id: 'rec' + String(i).padStart(14, '0'),
    fields: {
      'NC #': 'NC-' + st.replace(/\s/g, ''),
      'Status': st,
      'Responsible Person': 'Derek Melanson',
      'Date Raised': RAISED,
      // 'Action Plan Started' deliberately absent — that is what the cron looks for
    },
  }));
  // Two rows the status vocabulary does not cover. An allow-list must send
  // nothing about either; the old deny-list would have chased both.
  DB.push({
    id: 'recUNKNOWN00001',
    fields: { 'NC #': 'NC-UnknownStatus', 'Status': 'Awaiting Reply from NBHC',
              'Responsible Person': 'Derek Melanson', 'Date Raised': RAISED },
  });
  DB.push({
    id: 'recNOSTATUS0001',
    fields: { 'NC #': 'NC-NoStatus', 'Responsible Person': 'Derek Melanson', 'Date Raised': RAISED },
  });
  MAILS = []; PATCHES = []; LAST_FORMULA = null;
}

// Stub fetch. Mirrors the two behaviours that matter: Airtable's filterByFormula
// and its fields[] NARROWING. A stub that answers more generously than the real
// service tests nothing (working-agreement §2b).
function installFetch() {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    /* ⚠️ api/ncs.js validates the session server-side since 2026-09-23, so its
       handler calls the auth service before doing anything. Without this the
       manual-button block below gets 401 on every call and its assertions read
       as "the status guard is broken" when the guard was never reached. */
    if (u.includes('auth.mrdc-htra.com')) {
      return { ok: true, status: 200, json: async () => ({
        ok: true, allowed: true, appRole: 'Admin',
        user: { name: 'Troy Johnston', email: 'tjohnston@mrdc.ca', role: 'Owner',
                source: 'employee', employeeId: 'recEMP' },
        apps: ['NC'],
      }) };
    }
    if (u.startsWith('https://api.resend.com/emails')) {
      MAILS.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ id: 'msg_1' }) };
    }
    if (u.includes('/Employees') || u.includes(process.env.EMPLOYEES_TABLE || 'Employees')) {
      return { ok: true, status: 200, json: async () => ({ records: [
        { id: 'recEMP', fields: { Name: 'Derek Melanson', Email: 'dmelanson@mrdc.ca' } },
      ] }) };
    }
    const parsed = new URL(u);
    if ((opts.method || 'GET') === 'PATCH') {
      const id = parsed.pathname.split('/').pop();
      PATCHES.push({ id, body: JSON.parse(opts.body) });
      const rec = DB.find(r => r.id === id) || { id, fields: {} };
      return { ok: true, status: 200, json: async () => rec };
    }
    // A single-record GET (used by ncs.js)
    const tail = parsed.pathname.split('/').pop();
    const direct = DB.find(r => r.id === tail);
    if (direct) return { ok: true, status: 200, json: async () => direct };

    // A list GET: apply the formula, then narrow to the requested fields.
    const formula = parsed.searchParams.get('filterByFormula') || '';
    LAST_FORMULA = formula;
    const want = parsed.searchParams.getAll('fields[]');
    let rows = DB;
    for (const m of formula.matchAll(/\{Status\}!='([^']+)'/g)) {
      rows = rows.filter(r => r.fields['Status'] !== m[1]);
    }
    // The allow-list form: OR({Status}='New',{Status}='Containment'). The stub has
    // to honour it, or it answers more generously than Airtable would and the
    // server-side narrowing goes untested (working-agreement §2b).
    const allow = [...formula.matchAll(/\{Status\}='([^']+)'/g)].map(m => m[1]);
    if (allow.length) rows = rows.filter(r => allow.includes(r.fields['Status']));
    if (/\{Action Plan Started\}=''/.test(formula)) {
      rows = rows.filter(r => !r.fields['Action Plan Started']);
    }
    if (/\{Date Raised\}!=''/.test(formula)) {
      rows = rows.filter(r => !!r.fields['Date Raised']);
    }
    const records = rows.map(r => {
      if (!want.length) return { id: r.id, fields: { ...r.fields } };
      const f = {};
      for (const k of want) if (k in r.fields) f[k] = r.fields[k];   // ← the narrowing
      return { id: r.id, fields: f };
    });
    return { ok: true, status: 200, json: async () => ({ records }) };
  };
}

function res() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

(async () => {
  // ── 1. The cron ───────────────────────────────────────────────────────────
  const followup = require(path.join(API, 'nc-followup.js'));
  const runCron = async (query = {}) => {
    seed(); installFetch();
    const r = res();
    await followup({ method: 'GET', headers: { 'x-vercel-cron': '1' }, query }, r);
    return r;
  };

  let r = await runCron();
  ok('the cron ran', r.code === 200, JSON.stringify(r.body));
  const mailed = MAILS.map(m => String(m.subject).replace(/^NC NC-| — .*$/g, ''));
  const chased = [...new Set(MAILS.map(m => (m.subject.match(/^NC NC-(\S+)/) || [])[1]))];

  for (const st of MUST_SKIP) {
    const key = st.replace(/\s/g, '');
    ok(`'${st}' is NOT emailed`, !chased.includes(key), `chased: ${chased.join(', ')}`);
    ok(`'${st}' is NOT stamped as reminded`,
       !PATCHES.some(p => (DB.find(d => d.id === p.id) || {fields:{}}).fields['Status'] === st));
  }
  for (const st of MUST_CHASE) {
    ok(`'${st}' IS still emailed`, chased.includes(st.replace(/\s/g, '')), `chased: ${chased.join(', ')}`);
  }
  eq('exactly the two pre-analysis statuses are chased', chased.sort(), MUST_CHASE.map(s => s.replace(/\s/g, '')).sort());
  ok('every send was stamped so it cannot re-nag tomorrow', PATCHES.length === MAILS.length,
     `${PATCHES.length} patches vs ${MAILS.length} mails`);
  ok('the stamp writes Action Plan Reminder Sent',
     PATCHES.every(p => 'Action Plan Reminder Sent' in p.body.fields));

  // The formula must narrow server-side too — the JS guard alone would still
  // fetch every open NC across the wire.
  for (const st of MUST_CHASE) {
    ok(`the Airtable formula asks for '${st}' server-side`,
       LAST_FORMULA.includes(`{Status}='${st}'`), LAST_FORMULA);
  }
  for (const st of MUST_SKIP) {
    ok(`the Airtable formula does not ask for '${st}'`,
       !LAST_FORMULA.includes(`{Status}='${st}'`), LAST_FORMULA);
  }
  ok("the formula still requires an empty Action Plan Started", /\{Action Plan Started\}=''/.test(LAST_FORMULA));

  // ── 2. The JS guard is real, not decorative ───────────────────────────────
  // Prove it independently of the formula: if the formula silently stopped
  // applying (typo, renamed choice, service change), nothing may go out.
  seed(); installFetch();
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('resend') && !u.includes('Employees') && (opts.method || 'GET') === 'GET') {
      const p = new URL(u);
      if (p.searchParams.get('filterByFormula')) {
        p.searchParams.delete('filterByFormula');       // formula stops working
        return realFetch(p.toString(), opts);
      }
    }
    return realFetch(url, opts);
  };
  let r2 = res();
  await followup({ method: 'GET', headers: { 'x-vercel-cron': '1' }, query: {} }, r2);
  const leaked = MAILS.map(m => (m.subject.match(/^NC NC-(\S+)/) || [])[1])
                      .filter(k => MUST_SKIP.some(s => s.replace(/\s/g, '') === k));
  eq('with the formula defeated, the JS guard still blocks every skipped status', leaked, []);
  ok('and the two chaseable ones still go out', MAILS.length === MUST_CHASE.length, `${MAILS.length}`);
  global.fetch = realFetch;

  // ── 3. Preview writes and sends nothing ───────────────────────────────────
  seed(); installFetch();
  const r3 = res();
  await followup({ method: 'GET', headers: {}, query: { preview: '1', token: 'secret' } }, r3);
  ok('preview returns 200', r3.code === 200);
  ok('preview sends no email', MAILS.length === 0);
  ok('preview writes nothing', PATCHES.length === 0);
  ok('preview reports the skipped statuses', Array.isArray(r3.body.skipped_statuses));
  eq('preview lists only chaseable NCs',
     (r3.body.ncs || []).map(n => n.status).sort(), [...MUST_CHASE].sort());
  eq('preview names the statuses it chases', (r3.body.chase_statuses || []).sort(), [...MUST_CHASE].sort());
  eq('preview still reports the complement, for the deploy checklist',
     (r3.body.skipped_statuses || []).sort(), [...MUST_SKIP].sort());

  // ── 3b. A status nobody thought about sends nothing ───────────────────────
  // This is the whole reason the rule is an allow-list. Both of these rows are
  // open, past their deadline and have no action plan — under a deny-list they
  // would each have been emailed about.
  {
    seed(); installFetch();
    const rr = res();
    await followup({ method: 'GET', headers: { 'x-vercel-cron': '1' }, query: {} }, rr);
    const subjects = MAILS.map(m => m.subject).join(' | ');
    ok('an unrecognised status is not chased', !/UnknownStatus/.test(subjects), subjects);
    ok('a record with no status at all is not chased', !/NoStatus/.test(subjects), subjects);
    ok('and neither is stamped as reminded',
       !PATCHES.some(p => p.id === 'recUNKNOWN00001' || p.id === 'recNOSTATUS0001'));
    eq('still exactly the two chaseable ones', MAILS.length, MUST_CHASE.length);
  }

  // ── 3c. The 7-day window is reported, not just applied ────────────────────
  // Reading `overdue_to_start: 0` between firings is what made a live problem
  // look solved on 2026-09-14. Preview must show the suppressed ones too.
  {
    seed(); installFetch();
    const recent = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    for (const row of DB) if (MUST_CHASE.includes(row.fields['Status'])) {
      row.fields['Action Plan Reminder Sent'] = recent;
    }
    const rr = res();
    await followup({ method: 'GET', headers: {}, query: { preview: '1', token: 'secret' } }, rr);
    eq('nothing goes out inside the 7-day window', rr.body.overdue_to_start, 0);
    eq('but they are counted as still being chased', rr.body.chased_recently, MUST_CHASE.length);
    eq('and the window itself is stated', rr.body.remind_every_days, 7);
  }

  // ── 3d. The guard fails CLOSED when CRON_SECRET is missing ────────────────
  // The old form skipped the check entirely if the variable was unset, so
  // deleting or renaming an env var silently opened a real-email endpoint.
  {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    delete require.cache[require.resolve(path.join(API, 'nc-followup.js'))];
    const fresh = require(path.join(API, 'nc-followup.js'));
    seed(); installFetch();
    const rr = res();
    await fresh({ method: 'GET', headers: {}, query: {} }, rr);
    eq('no secret set, no header, no preview → 401', rr.code, 401);
    eq('and nothing was emailed', MAILS.length, 0);
    eq('and nothing was written', PATCHES.length, 0);

    seed(); installFetch();
    const rc = res();
    await fresh({ method: 'GET', headers: { 'x-vercel-cron': '1' }, query: {} }, rc);
    eq('Vercel Cron still gets in on its own header', rc.code, 200);

    seed(); installFetch();
    const rp = res();
    /* ⚠️ Re-expressed 2026-09-24, deliberately. This used to assert "preview is
       still open" — preview skipped the guard entirely, which let anyone with
       the URL read live NC data including responsible-person names. It is now
       gated like everything else, and with CRON_SECRET unset there is no token
       that can satisfy it, so preview must be refused too. */
    await fresh({ method: 'GET', headers: {}, query: { preview: '1', token: 'secret' } }, rp);
    eq('and preview is refused too when CRON_SECRET is unset', rp.code, 401);
    eq('preview sent nothing', MAILS.length, 0);

    if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;
    delete require.cache[require.resolve(path.join(API, 'nc-followup.js'))];
  }

  // ── 4. The manual button in ncs.js ────────────────────────────────────────
  process.env.NC_TABLE = 'Non Conformances';
  const ncs = require(path.join(API, 'ncs.js'));
  const manual = async (recId) => {
    seed(); installFetch();
    const r = res();
    await ncs({
      method: 'POST', url: '/api/ncs',
      /* The cookie is what authenticates now; the x-user-* headers are left in
         place deliberately, to prove they neither help nor are needed. */
      headers: { cookie: 'htra_session=test-session',
                 'x-user-role': 'Owner', 'x-app-role': 'Admin', 'x-user-name': 'Troy Johnston',
                 origin: 'https://www.mrdc-htra.com' },
      query: {}, body: { action: 'followup', id: recId },
    }, r);
    return r;
  };
  for (const st of ['Closed', 'Cancelled']) {
    const rec = DB ? null : null;
    seed();
    const id = DB.find(d => d.fields['Status'] === st).id;
    const rr = await manual(id);
    ok(`manual follow-up on a ${st} NC is refused`, rr.code === 409, `got ${rr.code} ${JSON.stringify(rr.body)}`);
    ok(`manual follow-up on a ${st} NC sends no email`, MAILS.length === 0, JSON.stringify(MAILS.map(m => m.subject)));
    ok(`the refusal names the status`, rr.body && /closed|cancelled/i.test(rr.body.error || ''), JSON.stringify(rr.body));
  }
  for (const st of ['New', 'Letter Sent', 'Ready for Review', 'Verification']) {
    seed();
    const id = DB.find(d => d.fields['Status'] === st).id;
    const rr = await manual(id);
    ok(`manual follow-up on a ${st} NC is still allowed`, rr.code === 200, `got ${rr.code} ${JSON.stringify(rr.body)}`);
    ok(`manual follow-up on a ${st} NC did send`, MAILS.length > 0);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exit(1); }
})().catch(e => { console.log('HARNESS ERROR: ' + e.stack); process.exit(1); });
