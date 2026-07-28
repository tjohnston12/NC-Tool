/*
 * NC — /api/nc-digest
 * -------------------
 * Weekly summary of OPEN non-conformances and who they are assigned to.
 * Triggered by Vercel Cron (see vercel.json) on Monday morning, and can be hit
 * manually to preview: /api/nc-digest?preview=1  (renders the email as HTML),
 * or /api/nc-digest?token=<CRON_SECRET> to force a send.
 *
 * Recipients: everyone currently assigned an open NC (Responsible Person -> email
 * from the Employees base), everyone toggled "NC Weekly Digest" in Email
 * Subscriptions (managed in the access & roles app), plus any extra addresses in
 * NC_DIGEST_TO. Deduped by address.
 *
 * Env: AIRTABLE_PAT, NC_BASE_ID, RESEND_API_KEY (required to send).
 * Optional: RESEND_FROM, NC_DIGEST_TO, CRON_SECRET, EMPLOYEES_BASE, EMPLOYEES_TABLE.
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
const CRON_SECRET = process.env.CRON_SECRET;
const DIGEST_TO   = process.env.NC_DIGEST_TO || '';

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const today = () => new Date().toISOString().slice(0, 10);

async function atGet(url) {
  const res = await fetch(url, { headers: HDR });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function openNCs() {
  const rows = [];
  let offset;
  const filter = `AND({Status}!='Closed',{Status}!='Cancelled')`;
  do {
    const p = new URLSearchParams();
    p.set('pageSize', '100');
    p.set('filterByFormula', filter);
    ['NC #', 'Status', 'Priority', 'Responsible Person', 'Reviewers', 'Division',
     'Due Date', 'Standard / Clause', 'Source', 'Date Raised'].forEach(f => p.append('fields[]', f));
    p.append('sort[0][field]', 'Due Date'); p.append('sort[0][direction]', 'asc');
    if (offset) p.set('offset', offset);
    const json = await atGet(`${AT}?${p.toString()}`);
    for (const r of json.records) rows.push(r.fields);
    offset = json.offset;
  } while (offset);
  return rows;
}

const splitNames = s => String(s || '').split(/[;\n,]+/).map(x => x.trim()).filter(Boolean);
const DIGEST_SUB = 'NC Weekly Digest';   // Email Subscriptions option (managed in the access & roles app)

// Recipients = everyone assigned an open NC (Responsible Person -> email),
// everyone subscribed to "NC Weekly Digest" in the Employees base, plus any
// extra addresses in NC_DIGEST_TO. Deduped by address.
async function resolveRecipients(rows) {
  const byLower = new Map();               // lowercased email -> original-case email
  for (const e of (DIGEST_TO ? DIGEST_TO.split(',') : [])) {
    const em = e.trim(); if (em) byLower.set(em.toLowerCase(), em);
  }
  const wantNames = new Set();
  for (const r of rows) for (const nm of splitNames(r['Responsible Person'])) wantNames.add(nm.toLowerCase());
  let offset;
  do {
    const p = new URLSearchParams(); p.set('pageSize', '100');
    ['Name', 'Email', 'Active', 'Email Subscriptions'].forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const json = await atGet(`https://api.airtable.com/v0/${EMP_BASE}/${encodeURIComponent(EMP_TABLE)}?${p.toString()}`);
    for (const rec of (json.records || [])) {
      const f = rec.fields;
      if (String(f['Active'] || '').toLowerCase() === 'inactive') continue;
      const em = String(f['Email'] || '').trim(); if (!em) continue;
      const nm = String(f['Name'] || '').trim().toLowerCase();
      const subs = Array.isArray(f['Email Subscriptions']) ? f['Email Subscriptions'] : [];
      const subscribed = subs.some(s => (typeof s === 'string' ? s : (s && s.name)) === DIGEST_SUB);
      if ((nm && wantNames.has(nm)) || subscribed) {
        if (!byLower.has(em.toLowerCase())) byLower.set(em.toLowerCase(), em);
      }
    }
    offset = json.offset;
  } while (offset);
  return [...byLower.values()];
}

function buildHtml(rows, appUrl) {
  const t = today();
  const overdue = rows.filter(r => r['Due Date'] && r['Due Date'] < t);
  const groups = {};
  for (const r of rows) {
    const who = String(r['Responsible Person'] || '').trim() || 'Unassigned';
    (groups[who] = groups[who] || []).push(r);
  }
  const names = Object.keys(groups).sort((a, b) =>
    (a === 'Unassigned') - (b === 'Unassigned') || a.localeCompare(b));
  const prioRank = { Urgent: 0, Important: 1, Medium: 2, Low: 3 };
  const link = nc => appUrl ? `${appUrl}/?nc=${encodeURIComponent(nc)}` : '#';
  const rowHtml = r => {
    const nc = r['NC #'] || '';
    const od = r['Due Date'] && r['Due Date'] < t;
    return `<tr>
      <td style="padding:4px 10px;border-bottom:1px solid #EEE"><a href="${link(nc)}" style="color:#1E2B5E">${esc(nc)}</a></td>
      <td style="padding:4px 10px;border-bottom:1px solid #EEE">${esc(r['Priority'] || '—')}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #EEE">${esc(r['Status'] || 'New')}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #EEE">${esc(r['Standard / Clause'] || '—')}</td>
      <td style="padding:4px 10px;border-bottom:1px solid #EEE;${od ? 'color:#A32D2D;font-weight:700' : ''}">${esc(r['Due Date'] || '—')}${od ? ' (overdue)' : ''}</td>
    </tr>`;
  };
  let html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#16181D;max-width:720px">
    <h2 style="color:#1E2B5E;margin:0 0 4px">Open Non-Conformances — weekly summary</h2>
    <p style="color:#667;margin:0 0 16px">${rows.length} open &middot; ${overdue.length} overdue &middot; as of ${t}</p>`;
  for (const who of names) {
    const list = groups[who].slice().sort((a, b) =>
      (prioRank[a['Priority']] ?? 9) - (prioRank[b['Priority']] ?? 9));
    html += `<h3 style="margin:18px 0 6px;color:#1E2B5E">${esc(who)} <span style="color:#667;font-weight:400">(${list.length})</span></h3>
      <table style="border-collapse:collapse;width:100%;font-size:13px">
      <tr style="text-align:left;color:#667;font-size:11px;text-transform:uppercase">
        <th style="padding:4px 10px">NC #</th><th style="padding:4px 10px">Priority</th>
        <th style="padding:4px 10px">Status</th><th style="padding:4px 10px">Standard</th>
        <th style="padding:4px 10px">Due</th></tr>
      ${list.map(rowHtml).join('')}
      </table>`;
  }
  html += `<p style="color:#999;font-size:11px;margin-top:24px">Generated by the MRDC NC tool. Reply to this email to reach Quality.</p></div>`;
  return html;
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
    const rows = await openNCs();
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const appUrl = host ? `https://${host}` : '';
    const html = buildHtml(rows, appUrl);

    if (preview) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(html); return; }

    const recipients = await resolveRecipients(rows);
    let sent = false;
    if (RESEND_KEY && recipients.length) {
      const t = today();
      const overdue = rows.filter(r => r['Due Date'] && r['Due Date'] < t).length;
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: RESEND_FROM, to: recipients,
          subject: `Open NCs — ${rows.length} open, ${overdue} overdue`, html,
        }),
      });
      sent = r.ok;
    }
    res.status(200).json({ ok: true, open: rows.length, recipients: recipients.length, sent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
