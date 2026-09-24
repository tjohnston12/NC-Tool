// test-nc-auth.js — run with an ABSOLUTE path:
//   node "<repo>/NC Tool/_tests/test-nc-auth.js"
// Zero dependencies; no browser, no network, no credentials.
//
// Why this exists: until 2026-09-23 api/ncs.js decided everything from
// `x-user-role` / `x-app-role` — headers the caller sets — and never read the
// session cookie. The NC register holds every non-conformance raised against
// the Operator, with responsible parties, action plans and correspondence.
//
// What this pins:
//   · no session -> 401 on every route and method, before Airtable is touched
//   · a header is not a session and cannot upgrade a role
//   · NC'S OWN two rules, which are not DMT's or Assets'
//   · the name that signs a comment comes from the session
//   · a 401 is a 401 and never a 500
//   · the digest's cron guard fails CLOSED

const path = require('path');

const API      = path.join(__dirname, '..', 'api');
const authPath = path.join(API, '_auth.js');
const NCS      = path.join(API, 'ncs.js');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ` — ${x}` : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w),
  `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

process.env.AIRTABLE_PAT = 'stub-pat';
process.env.NC_BASE_ID   = 'appStub';

let session = null, authCalls = 0, airtableCalls = 0, authFails = false;
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('auth.mrdc-htra.com')) {
    authCalls++;
    if (authFails) throw new Error('auth unreachable');
    if (!session) return { ok: false, status: 401, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => session };
  }
  airtableCalls++;
  return { ok: true, status: 200, json: async () => ({ records: [], id: 'rec1', fields: {} }) };
};

const ncs  = require(NCS);
const AUTH = require(authPath);

const mkRes = () => {
  const r = { code: 0, body: null, headers: {} };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.getHeader = k => r.headers[k];
  return r;
};
const mkReq = (o = {}) => ({
  method: o.method || 'GET', query: o.query || {}, body: o.body, url: '/api/ncs',
  headers: Object.assign({},
    o.cookie === false ? {} : { cookie: 'htra_session=abc' },
    o.origin ? { origin: o.origin } : {},
    o.headers || {}),
});
const call = async (o) => { const res = mkRes(); await ncs(mkReq(o), res); return res; };

const S = (orgRole, appRole, opts = {}) => ({
  ok: true, allowed: opts.allowed !== false,
  user: { name: opts.name || 'Test Person', email: 't@mrdc.ca', role: orgRole,
          source: opts.source || 'employee', employeeId: 'recEmp1' },
  apps: ['NC'], appRole,
});

(async () => {

/* ── 1. No session — the state production was in ───────────────────────── */
{
  session = null;
  const routes = [
    ['ncs list',     {}],
    ['ncs stats',    { query: { stats: '1' } }],
    ['ncs managers', { query: { managers: '1' } }],
    ['ncs PATCH',    { method: 'PATCH', body: { id: 'rec1', fields: {} } }],
    ['ncs POST',     { method: 'POST',  body: { fields: {} } }],
    ['ncs comment',  { method: 'POST',  body: { action: 'comment', id: 'rec1', text: 'x' } }],
    ['ncs followup', { method: 'POST',  body: { action: 'followup', id: 'rec1' } }],
  ];
  for (const [label, o] of routes) {
    airtableCalls = 0;
    const res = await call({ ...o, cookie: false });
    eq(label + ' with no cookie is 401', res.code, 401);
    eq('  ...and never reached Airtable', airtableCalls, 0);
  }
}

/* ── 2. A header is not a session ──────────────────────────────────────── */
{
  session = null;
  const res = await call({ cookie: false,
    headers: { 'x-user-role': 'Owner', 'x-app-role': 'Admin', 'x-user-name': 'Someone' } });
  eq('x-user-role: Owner with no cookie is still 401', res.code, 401);
}

/* ── 3. NC'S OWN RULES, which are not the other apps' ──────────────────────
   ⚠️ canWork admits an ORG Manager. Neither DMT nor Assets grants an org
   Manager anything, so copying either of their gate lines into this repo would
   lock NC's managers out of the CAPA workflow. Pinned per combination. */
{
  const flags = async (orgRole, appRole) => {
    session = S(orgRole, appRole);
    const c = await AUTH.getCaller(mkReq({}));
    return [c.isAdmin, c.canWork];
  };
  const cases = [
    ['Owner',      'User',    [true,  true ]],
    ['Admin',      'User',    [true,  true ]],
    ['Employee',   'Admin',   [true,  true ]],
    ['Employee',   'Manager', [false, true ]],
    ['Manager',    'User',    [false, true ]],   // ← NC's own: an ORG Manager works NCs
    ['Supervisor', 'User',    [false, false]],
    ['Employee',   'User',    [false, false]],
    ['Employee',   '',        [false, false]],
  ];
  for (const [org, app, want] of cases)
    eq(`isAdmin / canWork — org ${org} / app ${app || '(none)'}`, await flags(org, app), want);
}

/* ── 4. An Owner with no NC Role is still an admin ─────────────────────────
   ⚠️ auth does NOT promote an Owner to an app Admin — appRoleForEmployee()
   returns plain 'User' when the per-app field is empty. A gate reading only the
   app role would refuse an Owner who runs the app today. */
{
  session = S('Owner', 'User');
  const c = await AUTH.getCaller(mkReq({}));
  ok('an Owner with NO NC Role is still an admin', c.isAdmin === true, JSON.stringify(c));
  eq('  while their app role really is only User', c.appRole, 'User');
}

/* ── 5. A contractor works no non-conformances ─────────────────────────────*/
{
  session = S('Admin', 'Admin', { source: 'admin' });
  const c = await AUTH.getCaller(mkReq({}));
  eq('an Admins-table session is not an NC admin', c.isAdmin, false);
  eq('  ...and cannot work one', c.canWork, false);
}

/* ── 6. The signature on a comment comes from the session ──────────────────
   Same shape as the DMT's email `sentBy` and the registry's last_edited_by. */
{
  session = S('Employee', 'Admin', { name: 'Pat Manager' });
  const c = await AUTH.getCaller(mkReq({ headers: { 'x-user-name': 'Someone Else' } }));
  eq('the caller name is the session name, not the header', c.name, 'Pat Manager');
}

/* ── 7. Not signed in, auth down, no cookie ────────────────────────────────*/
{
  session = S('Owner', 'User', { allowed: false });
  eq('a signed-in caller without NC access is 401', (await call({})).code, 401);

  session = S('Owner', 'User'); authFails = true;
  const down = await call({});
  authFails = false;
  eq('auth unreachable is 401', down.code, 401);
  ok('and not a 500', down.code !== 500, String(down.code));

  session = null; authCalls = 0;
  await call({ cookie: false });
  eq('no cookie does not even call the auth service', authCalls, 0);
}

/* ── 8. Source assertions ──────────────────────────────────────────────────*/
{
  const fs = require('fs');
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const src = strip(fs.readFileSync(NCS, 'utf8'));
  ok('ncs.js reads no x-user-* header', !/req\.headers\['x-(user|app)-/.test(src));
  const h = src.indexOf('module.exports = async');
  const guard = src.indexOf('await requireCaller(req, res)', h);
  const tryAt = src.indexOf('\n  try {', h);
  ok('and resolves the caller before its try block', guard > 0 && tryAt > 0 && guard < tryAt,
     `guard ${guard}, try ${tryAt} — the guard must come first or the 401 becomes a 500`);
  ok('credentialed CORS, or the cookie never arrives',
     /Access-Control-Allow-Credentials/.test(src));
  ok('x-user-* stays in the preflight allow-list until the page stops sending it',
     /Access-Control-Allow-Headers[^\n]*x-user-name/.test(src),
     'dropping these fails the preflight before the request is even sent');

  /* ⚠️ The digest's cron guard. §2b: "an auth guard conditional on a secret
     existing is not a guard" — the old form skipped itself whenever the
     variable was unset or renamed, on an endpoint that sends real email.
     nc-followup.js was already fixed; nc-digest.js was not, until 2026-09-23. */
  for (const f of ['nc-digest.js', 'nc-followup.js']) {
    const s2 = strip(fs.readFileSync(path.join(API, f), 'utf8'));
    ok(f + ' fails CLOSED when CRON_SECRET is unset',
       /\(!CRON_SECRET \|\| token !== CRON_SECRET\)/.test(s2),
       'the fail-open `CRON_SECRET && token !== CRON_SECRET` form is back');
  }
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }

})();
