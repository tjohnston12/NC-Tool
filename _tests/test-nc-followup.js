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
const API = path.join(__dirname, '..');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ' — ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

const ALL_STATUSES = ['New', 'Containment', 'Root Cause', 'Corrective Action',
                      'Ready for Review', 'Letter Sent', 'Verification', 'Closed', 'Cancelled'];
const MUST_SKIP  = ['Closed', 'Cancelled', 'Letter Sent', 'Ready for Review', 'Verification'];
const MUST_CHASE = ['New', 'Containment', 'Root Cause', 'Corrective Action'];
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
  MAILS = []; PATCHES = []; LAST_FORMULA = null;
}

// Stub fetch. Mirrors the two behaviours that matter: Airtable's filterByFormula
// and its fields[] NARROWING. A stub that answers more generously than the real
// service tests nothing (working-agreement §2b).
function installFetch() {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
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
  eq('exactly the four active statuses are chased', chased.sort(), MUST_CHASE.map(s => s.replace(/\s/g, '')).sort());
  ok('every send was stamped so it cannot re-nag tomorrow', PATCHES.length === MAILS.length,
     `${PATCHES.length} patches vs ${MAILS.length} mails`);
  ok('the stamp writes Action Plan Reminder Sent',
     PATCHES.every(p => 'Action Plan Reminder Sent' in p.body.fields));

  // The formula must carry all five — the JS guard alone would still fetch them.
  for (const st of MUST_SKIP) {
    ok(`the Airtable formula excludes '${st}' server-side`,
       LAST_FORMULA.includes(`{Status}!='${st}'`), LAST_FORMULA);
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
  eq('with the formula defeated, the JS guard still blocks all five', leaked, []);
  ok('and the active four still go out', MAILS.length === MUST_CHASE.length, `${MAILS.length}`);
  global.fetch = realFetch;

  // ── 3. Preview writes and sends nothing ───────────────────────────────────
  seed(); installFetch();
  const r3 = res();
  await followup({ method: 'GET', headers: {}, query: { preview: '1' } }, r3);
  ok('preview returns 200', r3.code === 200);
  ok('preview sends no email', MAILS.length === 0);
  ok('preview writes nothing', PATCHES.length === 0);
  ok('preview reports the skipped statuses', Array.isArray(r3.body.skipped_statuses));
  eq('preview lists only chaseable NCs',
     (r3.body.ncs || []).map(n => n.status).sort(), [...MUST_CHASE].sort());

  // ── 4. The manual button in ncs.js ────────────────────────────────────────
  process.env.NC_TABLE = 'Non Conformances';
  const ncs = require(path.join(API, 'ncs.js'));
  const manual = async (recId) => {
    seed(); installFetch();
    const r = res();
    await ncs({
      method: 'POST', url: '/api/ncs',
      headers: { 'x-user-role': 'Owner', 'x-app-role': 'Admin', 'x-user-name': 'Troy Johnston', origin: 'https://www.mrdc-htra.com' },
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
