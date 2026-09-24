/*
 * api/cron-header-probe.js — TEMPORARY DIAGNOSTIC. DELETE AFTER USE.
 * ---------------------------------------------------------------------------
 * Added 2026-09-24 to settle one question that could not be answered safely any
 * other way:
 *
 *   Does Vercel STRIP a client-supplied `x-vercel-cron` request header before
 *   the function sees it?
 *
 * All three NC crons guard themselves with `const isCron = !!req.headers
 * ['x-vercel-cron']` — an OR-branch that grants access with NO secret at all.
 * If a caller can set that header and have it survive to the function, the
 * CRON_SECRET on nc-digest, nc-followup and nc-mail-intake is decorative.
 *
 * ⚠️ The only conclusive test on the real endpoints FIRES THE DIGEST at live
 * recipients, or makes nc-mail-intake write records. This endpoint exists so
 * the question can be answered without doing either: it sends no email, writes
 * nothing, and reads no data — it reports only which headers arrived.
 *
 * HOW TO USE (from a browser tab already on https://nc.mrdc-htra.com, so the
 * request is same-origin and no CORS preflight is involved):
 *
 *   await fetch('/api/cron-header-probe').then(r => r.json())
 *   await fetch('/api/cron-header-probe', { headers: { 'x-vercel-cron': '1' } })
 *         .then(r => r.json())
 *
 * If the second call reports xVercelCronPresent: true, the header survived and
 * the bypass is real. If false, Vercel strips it and the guards are sound.
 *
 * ⚠️ It deliberately reports header NAMES and presence only — never values,
 * apart from `x-vercel-cron`'s own (Vercel sets it to "1"). `cookie` and
 * `authorization` carry a session and the cron secret; echoing either from an
 * unauthenticated endpoint would create a worse hole than the one being
 * measured.
 */

module.exports = async (req, res) => {
  const h = req.headers || {};
  const has = k => Object.prototype.hasOwnProperty.call(h, k);

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    note: 'TEMPORARY DIAGNOSTIC — delete api/cron-header-probe.js once answered',
    method: req.method,

    // the whole point
    xVercelCronPresent: has('x-vercel-cron'),
    xVercelCronValue: has('x-vercel-cron') ? String(h['x-vercel-cron']) : null,

    // context, names only
    vercelHeaderNames: Object.keys(h).filter(n => n.toLowerCase().startsWith('x-vercel-')).sort(),

    // presence only — these carry secrets
    authorizationPresent: !!h['authorization'],
    cookiePresent: !!h['cookie'],
  });
};
