/*
 * NC — /api/nc-audit-files
 * ------------------------
 * Monday-morning reminder: audit reports (and provincial notices) that are filed in
 * the register but have no file attached to them.
 *
 * Troy, 2026-08-27: "please add an email reminder for me every monday morning for any
 * audits that are missing their audit file."
 *
 * WHY THIS IS NOT "EVERYTHING THAT IS MISSING A FILE"
 * Counted live before this was written: 47 audit reports have no file — but 43 of them
 * carry no date at all and 42 are historical internal audits. On the NC side, 270
 * NCN/DEF rows have no file and only 10 are still open. A weekly email listing 317 rows
 * is read twice and ignored forever after.
 * So the email leads with what is ACTIONABLE and reports the rest as a single backlog
 * line. Same reasoning as the "to do" tinting: a reminder that cries wolf stops being a
 * reminder.
 *
 * WHY THERE IS NO NEW CRON
 * vercel.json already carries three (nc-digest, nc-followup, nc-mail-intake) and the
 * go-live runbook records that the Hobby plan allows two. Rather than risk a deploy
 * that fails on cron count — with a lot else waiting to ship — this exports its work
 * and `nc-digest` calls it at the end of the run it already makes every Monday at
 * 11:00 UTC. Same pattern as nc-intake exporting its importers for nc-mail-intake.
 *
 * Still a real endpoint, so it can be checked any time:
 *   /api/nc-audit-files?preview=1              renders the email, sends nothing
 *   /api/nc-audit-files?token=<CRON_SECRET>    forces a send
 *   &days=180                                  widen the "recent" window
 *
 * Env: AIRTABLE_PAT, NC_BASE_ID, RESEND_API_KEY (to send).
 * Optional: RESEND_FROM, NC_ADMIN_EMAIL, NC_APP_URL, CRON_SECRET.
 */
'use strict';

const PAT        = process.env.AIRTABLE_PAT;
const BASE       = process.env.NC_BASE_ID;
const NC_TABLE   = process.env.NC_TABLE || 'Non Conformances';
const AUD_TABLE  = process.env.NC_AUDIT_TABLE || 'Audit Reports';
const AT_NC      = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(NC_TABLE)}`;
const AT_AUD     = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(AUD_TABLE)}`;
const HDR        = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

const RESEND_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'quality@mrdc-htra.com';
const ADMIN_EMAIL = process.env.NC_ADMIN_EMAIL || 'tjohnston@mrdc.ca';
const APP_URL     = process.env.NC_APP_URL || 'https://www.mrdc-htra.com/nc';
const CRON_SECRET = process.env.CRON_SECRET;

const RECENT_DAYS = 90;
const TERMINAL = ['Closed', 'Cancelled'];

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);
function daysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

async function atGet(url) {
  const res = await fetch(url, { headers: HDR });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function page(base, fields) {
  const rows = [];
  let offset;
  do {
    const p = new URLSearchParams();
    p.set('pageSize', '100');
    fields.forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const json = await atGet(`${base}?${p.toString()}`);
    for (const r of json.records) rows.push({ id: r.id, ...r.fields });
    offset = json.offset;
  } while (offset);
  return rows;
}

// ⚠️ An attachment field is ABSENT from the payload when empty, not an empty array —
// so `!r.Files` and `r.Files.length === 0` both have to count as missing.
const noFile = r => !Array.isArray(r.Files) || r.Files.length === 0;

/**
 * What is missing a file, split into what to act on now and what is backlog.
 * Exported so nc-digest can call it without a second cron.
 */
async function missingAuditFiles(opts = {}) {
  const recentDays = Number(opts.days) > 0 ? Number(opts.days) : RECENT_DAYS;
  const cutoff = daysAgo(recentDays);

  // ⚠️ `Files` MUST be in these lists. Airtable returns ONLY the fields you name, so
  // omitting it made every single row read as "no file" — the first live run listed 512
  // audit reports and 72 notices, i.e. the whole table. The bug is invisible in a stub
  // that hands back a fixture regardless of fields[], which is exactly why the test
  // below now honours the parameter the way the real API does.
  const audits = (await page(AT_AUD, ['Report #', 'Date', 'Source', 'Division', 'Standard', 'Result', 'Files']))
    .filter(noFile);
  const ncs = (await page(AT_NC, ['NC #', 'Notice Type', 'Date Raised', 'Source', 'Status', 'Files']))
    .filter(noFile)
    .filter(r => ['NCN', 'Defect Notice'].includes(String(r['Notice Type'] || '').trim()));

  // An audit needs chasing if it is recent, OR provincial at any age - a provincial
  // report with no file is a contract record we cannot produce, whenever it was issued.
  const auditNow = audits.filter(r =>
    (r.Date && r.Date >= cutoff) || String(r.Source || '') === 'Provincial Audit');
  const auditBacklog = audits.filter(r => !auditNow.includes(r));

  // A notice needs chasing while it is still open, or if it is recent.
  const ncNow = ncs.filter(r =>
    !TERMINAL.includes(String(r.Status || '')) || (r['Date Raised'] && r['Date Raised'] >= cutoff));
  const ncBacklog = ncs.filter(r => !ncNow.includes(r));

  const bySource = {};
  for (const r of auditBacklog) { const k = r.Source || '(no source)'; bySource[k] = (bySource[k] || 0) + 1; }

  return {
    recentDays, cutoff,
    auditNow: auditNow.sort((a, b) => String(b.Date || '').localeCompare(String(a.Date || ''))),
    ncNow: ncNow.sort((a, b) => String(b['Date Raised'] || '').localeCompare(String(a['Date Raised'] || ''))),
    auditBacklog: auditBacklog.length, ncBacklog: ncBacklog.length,
    auditBacklogBySource: bySource,
    auditUndated: auditBacklog.filter(r => !r.Date).length,
    totalAuditsMissing: audits.length, totalNcsMissing: ncs.length,
  };
}

function buildHtml(d) {
  const wrap = s => `<div style="font-family:Segoe UI,Arial,sans-serif;color:#15181f;max-width:720px">${s}
    <p style="color:#999;font-size:11px;margin-top:24px">Generated by the MRDC NC tool, Monday mornings.
    It only arrives when something needs a file — a quiet week means nothing is outstanding.</p></div>`;

  const th = t => `<th style="padding:4px 10px;text-align:left">${t}</th>`;
  const td = t => `<td style="padding:6px 10px;border-top:1px solid #eceff5">${t}</td>`;

  let h = `<h2 style="color:#1E2B5E;margin:0 0 4px">Missing audit files</h2>
    <div style="color:#667;font-size:13px;margin-bottom:18px">Filed in the register, but with no report or notice attached.</div>`;

  if (d.auditNow.length) {
    h += `<h3 style="color:#8A2D5B;font-size:13px;text-transform:uppercase;letter-spacing:.5px;margin:18px 0 6px">
      Audit reports — ${d.auditNow.length}</h3>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
      <tr style="color:#667;font-size:11px;text-transform:uppercase">
      ${th('Report #')}${th('Date')}${th('Source')}${th('Division')}${th('Standard')}</tr>
      ${d.auditNow.map(r => `<tr>${td(`<b>${esc(r['Report #'] || '—')}</b>`)}${td(esc(r.Date || '—'))}
        ${td(esc(r.Source || '—'))}${td(esc(r.Division || '—'))}${td(esc(r.Standard || '—'))}</tr>`).join('')}
      </table>`;
  }

  if (d.ncNow.length) {
    h += `<h3 style="color:#8A2D5B;font-size:13px;text-transform:uppercase;letter-spacing:.5px;margin:22px 0 6px">
      Notices still open with no file — ${d.ncNow.length}</h3>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
      <tr style="color:#667;font-size:11px;text-transform:uppercase">
      ${th('Notice')}${th('Type')}${th('Raised')}${th('Status')}</tr>
      ${d.ncNow.map(r => `<tr>${td(`<b>${esc(r['NC #'] || '—')}</b>`)}${td(esc(r['Notice Type'] || '—'))}
        ${td(esc(r['Date Raised'] || '—'))}${td(esc(r.Status || '—'))}</tr>`).join('')}
      </table>`;
  }

  h += `<p style="margin:22px 0 6px;font-size:13px">
    <a href="${APP_URL}" style="color:#1B4F8A;font-weight:600">Open the NC app</a> —
    each record now has an <b>Attach source file</b> button, so the PDF can go straight on without Airtable.</p>`;

  // The backlog is stated, never listed. It is real, it is old, and 300 rows in an
  // email is how a weekly reminder becomes something nobody opens.
  if (d.auditBacklog || d.ncBacklog) {
    const bits = Object.entries(d.auditBacklogBySource).map(([k, v]) => `${esc(k)} ${v}`).join(' · ');
    h += `<div style="margin-top:18px;padding:10px 12px;background:#f7f8fc;border-radius:8px;font-size:12.5px;color:#667">
      <b>Older backlog, not listed:</b> ${d.auditBacklog} audit report(s)${bits ? ` (${bits})` : ''}${
        d.auditUndated ? `, of which ${d.auditUndated} carry no date` : ''} and ${d.ncBacklog} closed notice(s).
      Historical, and separate from the week's work.</div>`;
  }
  return wrap(h);
}

async function sendReminder(opts = {}) {
  const d = await missingAuditFiles(opts);
  const count = d.auditNow.length + d.ncNow.length;
  // Nothing outstanding -> no email. A reminder that arrives every week whether or not
  // there is anything to do trains you to delete it unread.
  if (!count) return { ok: true, sent: false, reason: 'nothing outstanding', ...summary(d) };
  if (!RESEND_KEY) return { ok: true, sent: false, reason: 'RESEND_API_KEY not set', ...summary(d) };
  const subject = `Missing audit files — ${d.auditNow.length} audit report(s), ${d.ncNow.length} open notice(s)`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [ADMIN_EMAIL], subject, html: buildHtml(d) }),
  });
  const body = await r.json().catch(() => ({}));
  return { ok: true, sent: r.ok, to: ADMIN_EMAIL, error: r.ok ? undefined : body, ...summary(d) };
}

const summary = d => ({
  auditsToChase: d.auditNow.length, noticesToChase: d.ncNow.length,
  auditBacklog: d.auditBacklog, ncBacklog: d.ncBacklog,
  totalAuditsMissing: d.totalAuditsMissing, totalNcsMissing: d.totalNcsMissing,
});

module.exports = async (req, res) => {
  if (!PAT || !BASE) { res.status(500).json({ ok: false, error: 'AIRTABLE_PAT and NC_BASE_ID must be set' }); return; }
  const isCron = !!req.headers['x-vercel-cron'];
  const q = req.query || {};
  const token = q.token || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const preview = q.preview === '1' || q.preview === 'true';
  if (!isCron && !preview && CRON_SECRET && token !== CRON_SECRET) {
    res.status(401).json({ ok: false, error: 'unauthorized' }); return;
  }
  try {
    if (preview) {
      const d = await missingAuditFiles({ days: q.days });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(buildHtml(d));
      return;
    }
    res.status(200).json(await sendReminder({ days: q.days }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

// Exported so nc-digest can run this inside the Monday job it already has.
module.exports.missingAuditFiles = missingAuditFiles;
module.exports.sendReminder = sendReminder;
module.exports.buildHtml = buildHtml;
