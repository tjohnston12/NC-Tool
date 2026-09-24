// test-cron-guards.js — run with an ABSOLUTE path:
//   node "<repo>/NC Tool/_tests/test-cron-guards.js"
// Zero dependencies; no browser, no network, no credentials, NO EMAIL.
//
// Three endpoints in this repo are Vercel crons: nc-digest (sends the weekly
// digest), nc-followup (sends chase mail AND writes records) and nc-mail-intake
// (writes records from mail). All three guard themselves the same way.
//
// Fixed here, 2026-09-24: `?preview=1` skipped the guard entirely on nc-digest
// and nc-followup, so anyone with the URL could read live NC data — numbers,
// statuses, dates and RESPONSIBLE PERSON names. Verified against production
// first: an anonymous GET /api/nc-followup?preview=1 returned 200.
// nc-mail-intake never had the hole; these two had drifted from it.
//
// ⚠️ STILL UNRESOLVED and deliberately pinned as-is below: `isCron` is
// `!!req.headers['x-vercel-cron']` in all three — a header the caller sets.
// api/cron-header-probe.js exists to settle whether Vercel strips an inbound
// copy, without firing a real digest at real people.

const path = require('path'), fs = require('fs');
const API = path.join(__dirname, '..', 'api');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ` — ${x}` : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w),
  `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

process.env.AIRTABLE_PAT = 'stub-pat';
process.env.NC_BASE_ID   = 'appStub';
process.env.CRON_SECRET  = 'test-cron-secret';

let session = null, sentMail = 0;
global.fetch = async (url, opt = {}) => {
  const u = String(url);
  if (u.includes('auth.mrdc-htra.com')) {
    if (!session) return { ok: false, status: 401, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => session };
  }
  // ⚠️ If a test ever reaches this, something tried to SEND. The count is asserted.
  if (u.includes('resend.com')) { sentMail++; return { ok: true, status: 200, json: async () => ({ id: 'stub' }) }; }
  return { ok: true, status: 200, json: async () => ({ records: [], id: 'rec1', fields: {} }) };
};

const load = (f) => { delete require.cache[path.join(API, f)]; return require(path.join(API, f)); };
let digest   = load('nc-digest.js');
let followup = load('nc-followup.js');
const mailIntake = load('nc-mail-intake.js');
const auditFiles = load('nc-audit-files.js');
const probe      = load('cron-header-probe.js');

const mkRes = () => {
  const r = { code: 0, body: null, headers: {}, sent: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.send = b => { r.sent = b; return r; };
  r.end = () => r; r.setHeader = (k, v) => { r.headers[k] = v; }; r.getHeader = k => r.headers[k];
  return r;
};
const call = async (h, o = {}) => {
  const res = mkRes();
  await h({ method: o.method || 'GET', query: o.query || {}, url: '/api/x',
            body: o.body, headers: Object.assign({},
              o.cron ? { 'x-vercel-cron': '1' } : {},
              o.cookie ? { cookie: 'htra_session=abc' } : {},
              o.auth ? { authorization: 'Bearer ' + o.auth } : {},
              o.headers || {}) }, res);
  return res;
};
const S = () => ({ ok: true, allowed: true,
  user: { name: 'Troy Johnston', email: 't@mrdc.ca', role: 'Admin', source: 'employee', employeeId: 'recE' },
  apps: ['NC'], appRole: 'Admin' });

(async () => {

/* ── 1. THE FIX — preview is no longer a free pass ───────────────────────── */
for (const [name, h] of [['nc-digest', digest], ['nc-followup', followup]]) {
  session = null; sentMail = 0;
  const anon = await call(h, { query: { preview: '1' } });
  eq(`${name}?preview=1 anonymous is 401`, anon.code, 401);
  eq(`  ...and sent nothing`, sentMail, 0);

  const bare = await call(h, {});
  eq(`${name} with nothing at all is 401`, bare.code, 401);

  const badTok = await call(h, { query: { preview: '1', token: 'wrong' } });
  eq(`${name}?preview=1 with a wrong token is 401`, badTok.code, 401);
}

/* ── 2. The ways in that should still work ───────────────────────────────── */
for (const [name, h] of [['nc-digest', digest], ['nc-followup', followup]]) {
  session = null; sentMail = 0;
  const tok = await call(h, { query: { preview: '1', token: 'test-cron-secret' } });
  ok(`${name}?preview=1 with the token works`, tok.code !== 401, String(tok.code));
  eq(`  ...and still sends nothing`, sentMail, 0);

  const viaHeader = await call(h, { query: { preview: '1' }, auth: 'test-cron-secret' });
  ok(`${name} accepts the token as a Bearer header too`, viaHeader.code !== 401, String(viaHeader.code));

  /* A signed-in NC user may preview — it keeps the cron secret out of URLs and
     server logs, which is where a ?token= ends up. */
  session = S(); sentMail = 0;
  const signedIn = await call(h, { query: { preview: '1' }, cookie: true });
  ok(`${name}?preview=1 works for a signed-in NC user`, signedIn.code !== 401, String(signedIn.code));
  eq(`  ...and still sends nothing`, sentMail, 0);

  session = { ok: true, allowed: false, user: { name: 'X', role: 'Employee', source: 'employee' }, apps: [], appRole: 'User' };
  const noAccess = await call(h, { query: { preview: '1' }, cookie: true });
  eq(`${name} refuses a signed-in caller without NC access`, noAccess.code, 401);

  /* ⚠️ A SESSION IS NOT A LICENCE TO FIRE. Being signed in permits ?preview=1,
     which sends and writes nothing — it must NOT permit a real run. A mutant
     that resolved the session unconditionally (dropping the `preview ?` test)
     survived the first sweep: it would have let any signed-in NC user trigger
     the live digest or the chase mail just by visiting the URL. */
  session = S(); sentMail = 0;
  const realRun = await call(h, { cookie: true });
  eq(`${name} refuses a REAL run to a signed-in user with no token`, realRun.code, 401);
  eq(`  ...and nothing was sent`, sentMail, 0);
}

/* ── 3. Fail CLOSED when CRON_SECRET is unset ────────────────────────────── */
{
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const d2 = load('nc-digest.js'), f2 = load('nc-followup.js');
  session = null;
  for (const [name, h] of [['nc-digest', d2], ['nc-followup', f2]]) {
    eq(`${name} refuses a manual run when CRON_SECRET is unset`,
       (await call(h, { query: { token: 'anything' } })).code, 401);
    eq(`${name} refuses preview too when CRON_SECRET is unset`,
       (await call(h, { query: { preview: '1' } })).code, 401);
  }
  process.env.CRON_SECRET = saved;
  digest = load('nc-digest.js'); followup = load('nc-followup.js');
}

/* ── 4. nc-mail-intake was already right — do not let it drift back ──────── */
{
  session = null;
  eq('nc-mail-intake?preview=1 with no token is 401',
     (await call(mailIntake, { query: { preview: '1' } })).code, 401);
  ok('nc-mail-intake?preview=1 with the token is allowed',
     (await call(mailIntake, { query: { preview: '1', token: 'test-cron-secret' } })).code !== 401);
}

/* ── 5. ⚠️ THE HEADER IS NOT A CREDENTIAL ─────────────────────────────────
   This section previously pinned the opposite, as current-but-not-correct
   behaviour, with a note to change it deliberately once measured. It was
   measured on 2026-09-24 with api/cron-header-probe.js: a client-supplied
   `x-vercel-cron: 1` ARRIVES AT THE FUNCTION — Vercel does not strip it. So the
   header granted anyone with the URL the right to fire real email and write
   records. The trust is gone from all four endpoints. */
{
  session = null; sentMail = 0;
  for (const [name, h] of [['nc-digest', digest], ['nc-followup', followup],
                           ['nc-mail-intake', mailIntake], ['nc-audit-files', auditFiles]]) {
    const spoof = await call(h, { cron: true });
    eq(`${name} refuses a spoofed x-vercel-cron header`, spoof.code, 401);
    eq(`  ...and with preview too`, (await call(h, { cron: true, query: { preview: '1' } })).code, 401);

    /* A refused request that LOOKS like a cron run is a broken schedule, and
       must be loud rather than silent — the body names the likely cause. */
    ok(`${name} says so when a cron-looking request is refused`,
       /CRON_SECRET may not be reaching/.test((spoof.body && spoof.body.hint) || ''),
       JSON.stringify(spoof.body));

    // the token is now the only way in
    ok(`${name} still admits a valid token`,
       (await call(h, { query: { token: 'test-cron-secret', preview: '1' } })).code !== 401);
  }
  eq('nothing was sent while probing the guard', sentMail, 0);

  /* ⚠️ A SESSION IS NOT A LICENCE TO FIRE — nc-audit-files too. It sends email,
     and a mutant that resolved the session unconditionally survived the first
     sweep on this file: any signed-in NC user could have triggered the real
     reminder by visiting the URL. Preview only. */
  session = S(); sentMail = 0;
  eq('nc-audit-files refuses a REAL send to a signed-in user with no token',
     (await call(auditFiles, { cookie: true })).code, 401);
  eq('  ...and sent nothing', sentMail, 0);
  ok('  ...but still allows that user to preview',
     (await call(auditFiles, { cookie: true, query: { preview: '1' } })).code !== 401);

  /* `caller.allowed` is the auth service's own App Access check for NC. Being
     signed in to the platform is not the same as having NC — a mutant dropping
     that half survived a sweep on this file. */
  session = { ok: true, allowed: false, user: { name: 'X', role: 'Employee', source: 'employee' }, apps: [], appRole: 'User' };
  eq('nc-audit-files refuses a signed-in caller without NC access',
     (await call(auditFiles, { cookie: true, query: { preview: '1' } })).code, 401);
}

/* ── 5b. nc-audit-files had the FAIL-OPEN form as well ────────────────────
   `CRON_SECRET && token !== CRON_SECRET` — with the variable unset the whole
   condition is false, so a bare GET would have SENT the reminder. */
{
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const fresh = load('nc-audit-files.js');
  session = null; sentMail = 0;
  eq('nc-audit-files refuses everything when CRON_SECRET is unset',
     (await call(fresh, {})).code, 401);
  eq('  ...including a spoofed cron header', (await call(fresh, { cron: true })).code, 401);
  eq('  ...and sent nothing', sentMail, 0);
  process.env.CRON_SECRET = saved; load('nc-audit-files.js');
}

/* ── 6. The probe tells you what arrived, and never leaks a secret ───────── */
{
  const plain = await call(probe, {});
  eq('probe answers', plain.code, 200);
  eq('  ...and reports the header absent when it was not sent', plain.body.xVercelCronPresent, false);

  const withHdr = await call(probe, { cron: true });
  eq('probe reports the header present when it was sent', withHdr.body.xVercelCronPresent, true);
  eq('  ...and its value', withHdr.body.xVercelCronValue, '1');

  const secrets = await call(probe, { cookie: true, auth: 'test-cron-secret' });
  eq('probe reports a cookie only as a boolean', secrets.body.cookiePresent, true);
  eq('probe reports authorization only as a boolean', secrets.body.authorizationPresent, true);
  const blob = JSON.stringify(secrets.body);
  ok('⚠️ the probe never echoes the cron secret', blob.indexOf('test-cron-secret') < 0, blob);
  ok('⚠️ nor the session cookie', blob.indexOf('htra_session') < 0, blob);
  ok('the probe sends no email and writes nothing', sentMail === 0);
  ok('it says it is temporary', /TEMPORARY/i.test(plain.body.note || ''));
}

/* ── 7. Source assertions ────────────────────────────────────────────────── */
{
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  for (const f of ['nc-digest.js', 'nc-followup.js', 'nc-mail-intake.js', 'nc-audit-files.js']) {
    const src = strip(fs.readFileSync(path.join(API, f), 'utf8'));
    ok(f + ' no longer lets preview skip the guard',
       !/!isCron && !preview|!tokenOk && !preview/.test(src),
       'the `&& !preview` form is back — that is the anonymous read');
    /* ⚠️ The header must not appear in any guard condition again. It may only be
       READ, to make a refused cron run loud. */
    ok(f + ' does not trust x-vercel-cron as a credential',
       !/!isCron\b/.test(src) && !/!looksLikeCron\b/.test(src),
       'a request header is not a credential — measured spoofable 2026-09-24');
    ok(f + ' still names a refused cron-looking request',
       /looksLikeCron/.test(src),
       'a broken schedule must be loud, not silent');
    /* Fail-closed is proved behaviourally in section 3; this only pins the
       SHAPE, so the `CRON_SECRET && token !== CRON_SECRET` form — which skips
       itself whenever the variable is unset or renamed — cannot come back.
       Two spellings are in use: `!!CRON_SECRET && token === CRON_SECRET`
       (digest, followup) and `!expected || String(token)...` (mail-intake). */
    ok(f + ' still fails closed on a missing CRON_SECRET',
       /!!CRON_SECRET && token === CRON_SECRET|!expected \|\| String\(token\)/.test(src),
       'an auth guard conditional on a secret merely existing is not a guard');
    ok(f + ' does not use the fail-OPEN form',
       !/[^!]CRON_SECRET && token !== CRON_SECRET/.test(src));
  }
  const p = strip(fs.readFileSync(path.join(API, 'cron-header-probe.js'), 'utf8'));
  ok('the probe reads no Airtable and sends no mail',
     !/airtable|resend/i.test(p), 'it must stay inert');
  ok('the probe never echoes a raw header map',
     !/json\([^)]*headers\s*[,}]/.test(p) && !/\.\.\.h\b/.test(p),
     'echoing all headers would expose cookie and authorization');
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }
})();
