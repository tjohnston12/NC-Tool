/*
 * api/_auth.js — server-side identity for the NC API.
 * ---------------------------------------------------------------------------
 * Ported from mrdc-assets-api / road-patrol-api / facility-safety-api
 * (2026-09-23). Same shape; the NC-specific parts are called out below.
 *
 * Until 2026-09-23 api/ncs.js decided everything from `x-user-role` /
 * `x-app-role` — headers the caller sets — and never read the session cookie.
 * The NC register holds every non-conformance raised against the Operator,
 * with responsible-party names, action plans and correspondence.
 *
 * ⚠️ SESSION ONLY, NO SERVICE KEY. ncs.js has no machine caller: the DMT's
 * intake posts to /api/nc-intake, which has its own INTAKE_SECRET and is
 * untouched by this. Adding a key here would widen the surface for nothing —
 * if a machine ever needs ncs.js, add it then, with the caller that needs it.
 *
 * ⚠️ THE TWO GATES ARE NC'S OWN AND THEY ARE NOT THE OTHER APPS':
 *     isAdmin = orgRole Admin/Owner            OR appRole Admin
 *     canWork = isAdmin OR appRole Manager     OR **orgRole Manager**
 * An org Manager counts as able to work an NC here. Neither DMT nor Assets
 * admits an org Manager to anything, so copying either of their lines would
 * quietly lock NC's managers out of the CAPA workflow.
 *
 * ⚠️ APP MUST STAY 'NC' — the key into auth's APP_ROLE_FIELD ('NC' -> 'NC Role',
 * fldaWMZ13EynyAALB). A name auth does not recognise returns an empty role, and
 * appAllowed() refuses it outright because it will not be in anyone's App
 * Access. Note auth does NOT promote an Owner to an app Admin: an Owner with no
 * NC Role resolves to appRole 'User', which is why orgRole is kept separate.
 */

const AUTH_URL = process.env.AUTH_URL || 'https://auth.mrdc-htra.com';
const APP = 'NC';

/* Resolve the signed-in caller from the forwarded session cookie, or null.
   Never throws: a failure to reach auth is an unauthenticated caller, not a
   500, so a flaky auth service cannot be made to look like an open door. */
async function getCaller(req) {
  const cookie = req.headers.cookie || '';
  if (!/(?:^|;\s*)htra_session=/.test(cookie)) return null;
  let d;
  try {
    const r = await fetch(`${AUTH_URL}/api/session?app=${APP}`, { headers: { cookie } });
    if (!r.ok) return null;
    d = await r.json();
  } catch (_) {
    return null;
  }
  if (!d || !d.ok || !d.user) return null;

  const orgRole = d.user.role || '';
  const appRole = d.appRole || '';
  // An Admins-table session carries a third vocabulary ('Contractor'). A
  // contractor is not staff and works no non-conformances.
  const isStaff = d.user.source === 'employee';

  const isAdmin = isStaff && (orgRole === 'Admin' || orgRole === 'Owner' || appRole === 'Admin');

  return {
    user: d.user,
    apps: Array.isArray(d.apps) ? d.apps : [],
    orgRole, appRole, isStaff,
    // From the validated session, never from x-user-name — this is stamped into
    // comments, action plans and the follow-up correspondence.
    name: d.user.name || '',
    employeeId: d.user.employeeId || '',
    isAdmin,
    canWork: isAdmin || (isStaff && (appRole === 'Manager' || orgRole === 'Manager')),
    allowed: d.allowed !== false,
  };
}

/* Guard a handler: a signed-in person with NC in their App Access.
   ⚠️ Call this BEFORE the handler's try/catch, or the 401 is swallowed by the
   catch and re-reported as a 500 (§2b). */
async function requireCaller(req, res) {
  const caller = await getCaller(req);
  if (!caller || !caller.allowed) {
    res.status(401).json({ ok: false, error: 'Not signed in' });
    return null;
  }
  return caller;
}

module.exports = { getCaller, requireCaller, APP };
