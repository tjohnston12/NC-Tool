/*
 * NC — /api/nc-followup
 * ---------------------
 * Daily (weekday) check for action plans not started within 5 working days of
 * the NC being issued. For each overdue-to-start open NC it emails the
 * responsible person + the NC admin, and stamps "Action Plan Reminder Sent" so
 * it does not nag more than once every REMIND_EVERY_DAYS.
 *
 * WHICH NCs ARE CHASED: see CHASE_STATUSES below. This email states, as a fact,
 * that no action plan has been started — so it must never reach someone whose
 * NC has already moved past the point where an action plan is owed.
 *
 * Triggered by Vercel Cron (see vercel.json). Manual: /api/nc-followup?preview=1
 * (lists candidates without sending), or ?token=<CRON_SECRET> to force a send.
 *
 * Env: AIRTABLE_PAT, NC_BASE_ID, RESEND_API_KEY (required to send).
 * Optional: RESEND_FROM, NC_ADMIN_EMAIL, CRON_SECRET, EMPLOYEES_BASE, EMPLOYEES_TABLE.
 */
'use strict';

const PAT   = process.env.AIRTABLE_PAT;
const BASE  = process.env.NC_BASE_ID;
const TABLE = process.env.NC_TABLE || 'Non Conformances';
const AT    = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`;
const HDR   = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

const RESEND_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'quality@mrdc-htra.com';
const EMP_BASE    = process.env.EMPLOYEES_BASE  || 'appraSoUXoTbhroG6';
const EMP_TABLE   = process.env.EMPLOYEES_TABLE || 'Employees';
const ADMIN_EMAIL = process.env.NC_ADMIN_EMAIL || 'tjohnston@mrdc.ca';
const CRON_SECRET = process.env.CRON_SECRET;
// Preview is a READ of live NC data, so it must be authenticated — a signed-in
// NC user, or the cron token. See the guard below.
const { getCaller } = require('./_auth');
// Calendar dates come from New Brunswick's clock, not UTC — see api/_when.js.
const { todayAtlantic } = require('./_when');

const REMIND_EVERY_DAYS = 7;   // don't re-nag the same NC more often than this

/* The ONLY statuses this cron may chase (Troy, 2026-09-17).
 *
 * ⚠️ THIS IS AN ALLOW-LIST ON PURPOSE. It was a deny-list twice, and the same
 * bug arrived twice: a status nobody thought about defaulted to "chase", and
 * real people got real email about work they had already done.
 *   2026-09-03 — 15 NCNs chased at Letter Sent / Ready for Review / Verification,
 *                some weekly for years. Fixed by adding three names to the list.
 *   2026-09-17 — 65 NCNs chased at Corrective Action (55) and Root Cause (6),
 *                raised as far back as 2012, to five managers and Troy.
 * The second one was not a regression: 'Corrective Action' and 'Root Cause' had
 * never been excluded, and the 2026-09-03 verification read `overdue_to_start:0`
 * three days after a firing, while every candidate was still inside the 7-day
 * REMIND_EVERY_DAYS window. The counter was right; reading it mid-cycle was not.
 *
 * With an allow-list, a status nobody has thought about sends nothing.
 *
 * Why these two and no others: the email asserts "no action plan has been
 * started ... within 5 working days". That is only a fair thing to say to
 * someone whose NC has not yet been analysed at all.
 *   New          — nothing has happened yet. Chase.
 *   Containment  — immediate action recorded, planning still owed. Chase.
 *   Root Cause / Corrective Action — the responder is past planning; most of
 *                  these are legacy imports from the NBHC tracker where
 *                  'Action Plan Started' was simply never populated.
 *   Ready for Review / Letter Sent / Verification — finished and handed on.
 *   Closed / Cancelled — terminal.
 * An empty or unrecognised status is not chased either, which is the point.
 *
 * Keep in step with TERMINAL / STATUSES in api/ncs.js — that file owns the
 * status vocabulary. The manual "send follow-up" button there is deliberately
 * wider (a person choosing to chase, refusing only on a terminal status); it
 * reports whichever status is true rather than asserting this one.
 * _tests/test-nc-followup.js pins both. */
const CHASE_STATUSES = ['New', 'Containment'];

/* The full status vocabulary, in workflow order. Only used to report the
 * complement of CHASE_STATUSES in ?preview=1, so that list cannot drift out of
 * step with this one by hand. Mirrors STATUSES in api/ncs.js. */
const ALL_STATUSES = ['New', 'Containment', 'Root Cause', 'Corrective Action',
                      'Ready for Review', 'Letter Sent', 'Verification', 'Closed', 'Cancelled'];

const today = () => todayAtlantic();

// Add N working days (Mon–Fri) to an ISO date string. Holidays are not accounted for.
function addBusinessDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  let added = 0;
  while (added < n) { d.setUTCDate(d.getUTCDate() + 1); const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) added++; }
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000); }

async function at(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: HDR, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// Open NCs with no action plan started yet, past their 5-working-day start deadline,
// and not reminded within the last REMIND_EVERY_DAYS.
async function candidates() {
  const rows = [];
  let offset;
  const only = CHASE_STATUSES.map(st => `{Status}='${st}'`).join(',');
  const filter = `AND(OR(${only}),{Action Plan Started}='',{Date Raised}!='')`;
  do {
    const p = new URLSearchParams();
    p.set('pageSize', '100');
    p.set('filterByFormula', filter);
    // 'Status' MUST be requested: Airtable returns only the fields named here, so
    // without it the belt-and-braces check below would read undefined and pass.
    ['NC #', 'Status', 'Responsible Person', 'Date Raised', 'Action Plan Started', 'Action Plan Reminder Sent']
      .forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const json = await at(`${AT}?${p.toString()}`);
    for (const r of json.records) rows.push({ id: r.id, ...r.fields });
    offset = json.offset;
  } while (offset);
  const t = today();
  // Counted, not just dropped: a candidate suppressed by the 7-day window is
  // still being chased, just not today. Reporting only the first number is what
  // made a live problem look solved on 2026-09-14 (see CHASE_STATUSES above).
  let chasedRecently = 0;
  const due = rows.filter(r => {
    // Second line of defence. The formula above already excludes these, but a
    // formula is a string sent to someone else's service: a typo, a renamed
    // choice or a filter that silently fails to apply would put a real email in
    // front of a real person. Checked here against the value we actually read.
    if (!CHASE_STATUSES.includes(String(r['Status'] || '').trim())) return false;
    const deadline = addBusinessDays(r['Date Raised'], 5);
    if (t <= deadline) return false;                                     // still inside the 5-working-day window
    const last = r['Action Plan Reminder Sent'];
    if (last && daysBetween(last, t) < REMIND_EVERY_DAYS) { chasedRecently++; return false; }
    return true;
  });
  due.chasedRecently = chasedRecently;
  return due;
}

async function emailsForNames(names) {
  const wanted = [...new Set(names.map(n => String(n).trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return {};
  const out = {};
  let offset;
  do {
    const p = new URLSearchParams(); p.set('pageSize', '100');
    ['Name', 'Email'].forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const res = await fetch(`https://api.airtable.com/v0/${EMP_BASE}/${encodeURIComponent(EMP_TABLE)}?${p.toString()}`, { headers: HDR });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) break;
    for (const r of (json.records || [])) {
      const nm = String(r.fields['Name'] || '').trim().toLowerCase();
      const em = String(r.fields['Email'] || '').trim();
      if (nm && em && wanted.includes(nm)) out[nm] = em;
    }
    offset = json.offset;
  } while (offset);
  return out;
}

async function sendMail(to, subject, htmlBody) {
  if (!RESEND_KEY || !to.length) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html: htmlBody }),
  });
  return r.ok;
}

// The NC front-end now lives at www.mrdc-htra.com/nc/ while this API stays on
// nc.mrdc-htra.com, so links in outbound email must NOT be derived from the
// request host — that would send people back to the old address.
const APP_URL = process.env.NC_APP_URL || 'https://www.mrdc-htra.com/nc';

function emailHtml(nc, appUrl) {
  const due = addBusinessDays(nc['Date Raised'], 5);
  const link = appUrl ? `${appUrl}/?nc=${encodeURIComponent(nc['NC #'])}` : '';
  const btn = link ? `<p><a href="${link}" style="background:#1E2B5E;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open ${nc['NC #']}</a></p>` : '';
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#16181D;max-width:640px">
    <p>Non-conformance <b>${nc['NC #']}</b> was issued on ${nc['Date Raised']} and <b style="color:#A32D2D">no action plan has been started</b>.</p>
    <p>An action plan must be started within <b>5 working days</b> of issue — the deadline was <b>${due}</b>. Please open the NC and add your action-plan steps, each with an expected completion date.</p>
    ${btn}
    <p style="color:#999;font-size:11px;margin-top:20px">Automatic reminder from the MRDC NC tool.</p></div>`;
}

module.exports = async (req, res) => {
  if (!PAT || !BASE) { res.status(500).json({ ok: false, error: 'AIRTABLE_PAT and NC_BASE_ID must be set' }); return; }

  // Guard: allow Vercel Cron (sends x-vercel-cron), or a matching token for manual runs.
  /* ⚠️ `x-vercel-cron` IS NOT TRUSTED — renamed from `isCron` on purpose, because
     that name asserted something a request header cannot establish.
     MEASURED 2026-09-24 with api/cron-header-probe.js: a client-supplied
     `x-vercel-cron: 1` ARRIVES AT THE FUNCTION. Vercel does not strip it. So the
     old `!isCron && ...` guard could be bypassed by anyone with the URL — on an
     endpoint that emails staff and writes records.

     The token is now the only way in. Vercel Cron sends
     `Authorization: Bearer $CRON_SECRET` when that variable is set on the
     project, and it IS set here (verified via nc-mail-intake's own 401 hint).

     The header is kept for ONE purpose: if a request that looks like a cron run
     is refused, that is a BROKEN CRON, and it must be loud rather than silent —
     it is logged and named in the response. */
  const looksLikeCron = !!req.headers['x-vercel-cron'];
  const q = req.query || {};
  const token = q.token || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const preview = q.preview === '1' || q.preview === 'true';
  // Fail CLOSED. The old form was `CRON_SECRET && token !== CRON_SECRET`, which
  // skipped the check entirely whenever the variable was unset or renamed — so
  // deleting an env var silently opened a real-email endpoint to anyone with the
  // URL. A manual run now needs a secret to exist AND to match; Vercel Cron still
  // gets in on its own header, and ?preview=1 still sends and writes nothing.
  const tokenOk = !!CRON_SECRET && token === CRON_SECRET;
  /* ⚠️ `?preview=1` NO LONGER SKIPS THIS (2026-09-24). It used to sit in the
     condition as `&& !preview`, which let anyone with the URL read live NC data
     — NC numbers, statuses, dates and RESPONSIBLE PERSON names — with no secret
     at all. Verified against production before the change: an anonymous
     GET /api/nc-followup?preview=1 returned 200. nc-mail-intake.js never had
     the hole; these two had drifted from it.

     Preview still sends and writes nothing, so it does not need the CRON
     secret specifically — it needs SOMEBODY authenticated. A signed-in NC user
     is enough, and is better than the token because it keeps the secret out of
     URLs and server logs. The token still works for a headless check.

     RESOLVED 2026-09-24: the header trust is GONE from all four endpoints. A
     client-supplied `x-vercel-cron` was measured arriving at the function, so
     the token is now the only way in (Vercel Cron sends it as
     `Authorization: Bearer $CRON_SECRET`, and that variable is set here). */
  if (!tokenOk) {
    const caller = preview ? await getCaller(req) : null;
    if (!caller || !caller.allowed) {
      if (looksLikeCron) {
        console.error('[nc-followup] REFUSED a request carrying x-vercel-cron with no valid token — ' +
          'if this is a real cron run, CRON_SECRET is not reaching it and the schedule is broken.');
      }
      res.status(401).json({ ok: false, error: 'unauthorized',
        ...(looksLikeCron ? { hint: 'carried x-vercel-cron but no valid token — CRON_SECRET may not be reaching Vercel Cron' } : {}) });
      return;
    }
  }

  try {
    const list = await candidates();
    const appUrl = APP_URL;

    if (preview) {
      res.status(200).json({
        ok: true, overdue_to_start: list.length,
        chase_statuses: CHASE_STATUSES,
        // Kept, and derived rather than hand-maintained, because the deploy
        // checklist in claude/working-agreement.md reads this field.
        skipped_statuses: ALL_STATUSES.filter(st => !CHASE_STATUSES.includes(st)),
        // ⚠️ overdue_to_start is "how many go out NOW", not "how many this cron
        // is chasing" — anything reminded inside the window below is excluded
        // from it and counted here instead. Read both, or a live problem looks
        // solved when you happen to check between firings.
        chased_recently: list.chasedRecently || 0,
        remind_every_days: REMIND_EVERY_DAYS,
        ncs: list.map(n => ({ nc: n['NC #'], status: n['Status'] || null, raised: n['Date Raised'], deadline: addBusinessDays(n['Date Raised'], 5), responsible: n['Responsible Person'] || null })),
      });
      return;
    }

    let sent = 0;
    const t = today();
    for (const nc of list) {
      const resp = String(nc['Responsible Person'] || '').trim();
      const emails = await emailsForNames(resp ? [resp] : []);
      const to = [...new Set([emails[resp.toLowerCase()], ADMIN_EMAIL].filter(Boolean))];
      const ok = await sendMail(to, `NC ${nc['NC #']} — action plan not started`, emailHtml(nc, appUrl));
      if (ok) { sent++; await at(`${AT}/${nc.id}`, 'PATCH', { fields: { 'Action Plan Reminder Sent': t } }); }
    }
    res.status(200).json({ ok: true, overdue_to_start: list.length, sent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
