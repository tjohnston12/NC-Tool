/*
 * NC — /api/nc-followup
 * ---------------------
 * Daily (weekday) check for action plans not started within 5 working days of
 * the NC being issued. For each overdue-to-start open NC it emails the
 * responsible person + the NC admin, and stamps "Action Plan Reminder Sent" so
 * it does not nag more than once every REMIND_EVERY_DAYS.
 *
 * WHICH NCs ARE CHASED: see SKIP_STATUSES below. This email states, as a fact,
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

const REMIND_EVERY_DAYS = 7;   // don't re-nag the same NC more often than this

/* Statuses that STOP the action-plan chaser (Troy, 2026-09-03).
 *
 * 'Closed' and 'Cancelled' are terminal and were always excluded. The other
 * three were not, and that was the live bug: on 2026-09-03 this cron was still
 * chasing 15 NCNs — 4 Letter Sent, 8 Ready for Review, 3 Verification — some
 * every 7 days for years (OMNCN0612 was raised 2017-05-31). In all three the
 * responder has FINISHED and handed the NC on:
 *   Ready for Review — they submitted their response
 *   Letter Sent      — the Province response letter has gone to NBHC
 *   Verification     — it is being signed off
 * The email says "no action plan has been started ... within 5 working days",
 * which is not a true statement to send any of them. Chasing continues for
 * New / Containment / Root Cause / Corrective Action, which is where the
 * 5-working-day rule actually bites.
 *
 * Keep in step with TERMINAL / STATUSES in api/ncs.js — that file owns the
 * status vocabulary, and the manual "send follow-up" button there has its own
 * (narrower, deliberate) guard. _tests/test-nc-followup.js pins both. */
const SKIP_STATUSES = ['Closed', 'Cancelled', 'Letter Sent', 'Ready for Review', 'Verification'];

const today = () => new Date().toISOString().slice(0, 10);

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
  const skip = SKIP_STATUSES.map(st => `{Status}!='${st}'`).join(',');
  const filter = `AND(${skip},{Action Plan Started}='',{Date Raised}!='')`;
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
  return rows.filter(r => {
    // Second line of defence. The formula above already excludes these, but a
    // formula is a string sent to someone else's service: a typo, a renamed
    // choice or a filter that silently fails to apply would put a real email in
    // front of a real person. Checked here against the value we actually read.
    if (SKIP_STATUSES.includes(String(r['Status'] || '').trim())) return false;
    const due = addBusinessDays(r['Date Raised'], 5);
    if (t <= due) return false;                                          // still inside the 5-working-day window
    const last = r['Action Plan Reminder Sent'];
    if (last && daysBetween(last, t) < REMIND_EVERY_DAYS) return false;  // nagged recently
    return true;
  });
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
  const isCron = !!req.headers['x-vercel-cron'];
  const q = req.query || {};
  const token = q.token || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const preview = q.preview === '1' || q.preview === 'true';
  if (!isCron && !preview && CRON_SECRET && token !== CRON_SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' }); return;
  }

  try {
    const list = await candidates();
    const appUrl = APP_URL;

    if (preview) {
      res.status(200).json({
        ok: true, overdue_to_start: list.length,
        skipped_statuses: SKIP_STATUSES,
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
