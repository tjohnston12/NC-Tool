/*
 * NC — /api/ncs
 * -------------
 * The read/write surface for the Non-Conformance app. NCs come from Quality
 * Audits, Provincial Audits, ISO audits, internal audits and other sources,
 * and move through a full CAPA workflow:
 *
 *   New → Containment → Root Cause → Corrective Action → Verification → Closed
 *   (Cancelled is the only other terminal state.)
 *
 *   GET  /api/ncs                       -> { ok, count, records: [...] }
 *        ?status=open|Closed|New|…       (open = anything not Closed/Cancelled)
 *        ?classification=Major&source=ISO Audit&division=Western
 *        ?q=free text                    (NC #, clause, description, ref …)
 *        ?nc=NC-2026-001                 single NC
 *        ?limit=500                      (default 500, max 5000)
 *        ?stats=1                        aggregate counts, uncapped
 *
 *   POST /api/ncs   body { fields: {...} }         create (Admin/Manager)
 *   PATCH /api/ncs  body { id, fields: {...} }     edit   (Admin/Manager; some
 *                                                  fields Admin-only, see below)
 *   POST  /api/ncs  body { action:'comment', id, text }   append to Activity Log
 *
 * Roles (x-user-role = org role, x-app-role = "NC Role" on the employee record):
 *   Admin  (org Admin/Owner or NC Role Admin) — everything, incl. Verification,
 *          Closed/Cancelled status, Verified By/Date, Date Closed.
 *   Manager (NC Role Manager or org Manager)  — create NCs, edit the working
 *          fields (containment, root cause, corrective/preventive action,
 *          responsible person, due date, non-terminal statuses), comment.
 *   Everyone else — read-only.
 *
 * Env: AIRTABLE_PAT (must include the MRDC-HTRA-NC base), NC_BASE_ID
 */
'use strict';

const PAT = process.env.AIRTABLE_PAT;
const BASE = process.env.NC_BASE_ID;
const TABLE = process.env.NC_TABLE || 'Non Conformances';
const AT = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(TABLE)}`;
const HDR = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

// Email notifications (Resend) + employee email lookup (shared Employees base).
const RESEND_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'quality@mrdc-htra.com';
const EMP_BASE    = process.env.EMPLOYEES_BASE  || 'appraSoUXoTbhroG6';
const EMP_TABLE   = process.env.EMPLOYEES_TABLE || 'Employees';
const ADMIN_EMAIL = process.env.NC_ADMIN_EMAIL || 'tjohnston@mrdc.ca';

const TERMINAL = ['Closed', 'Cancelled'];
const STATUSES = ['New', 'Containment', 'Root Cause', 'Corrective Action', 'Ready for Review', 'Letter Sent', 'Verification', 'Closed', 'Cancelled'];

// Fields a Manager may write. Admins may additionally write ADMIN_FIELDS.
const MANAGER_FIELDS = new Set([
  'Source', 'Source Reference', 'Classification', 'Date Raised', 'Raised By',
  'Standard / Clause', 'Requirement', 'Description', 'Division',
  'Responsible Person', 'Due Date', 'Containment Action', 'Root Cause',
  'Corrective Action', 'Preventive Action', 'Date Action Completed',
  'Attachment URLs', 'Status',
  'Priority', 'Reviewers', 'Response Checklist', 'Response Files',
  'Action Plan', 'Action Plan Started', 'Asset ID',
]);
const ADMIN_FIELDS = new Set([
  'Verified By', 'Date Verified', 'Verification Notes', 'Date Closed',
  // Province response-letter stage (admin / Troy only)
  'Response Letter Draft', 'Letter Date Sent', 'Provincial Response Letter',
  // NBHC closure notice uploaded on the verification & closure section (admin only)
  'Closure Notice',
]);
// Fields the assigned responder (matched by name) may write on their own NC,
// even without Manager/Admin rights.
const RESPONSE_FIELDS = new Set(['Response Checklist', 'Response Files', 'Action Plan', 'Action Plan Started']);
// Statuses a responder (non-manager) may set on their own NC — "done, please review".
// Only an Admin may set a terminal status (Closed / Cancelled); see the rails below.
const RESPONDER_STATUSES = ['Ready for Review'];

const esc = s => String(s).replace(/'/g, "\\'");
const today = () => new Date().toISOString().slice(0, 10);
const nowStamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

// ── Audit log helpers ──────────────────────────────────────────────────────
// Fields short enough to record the actual value change (old → new) in the log.
const AUDIT_VALUE_FIELDS = new Set([
  'Status', 'Priority', 'Responsible Person', 'Division', 'Classification', 'Reviewers',
  'Due Date', 'Date Raised', 'Raised By', 'Date Action Completed', 'Date Verified',
  'Date Closed', 'Verified By', 'Letter Date Sent', 'Action Plan Started',
  'Source', 'Source Reference', 'Standard / Clause', 'Asset ID',
]);
// Attachment fields — record uploads/removals by filename (Response Files is a
// newline URL list and is handled alongside these).
const AUDIT_FILE_FIELDS = new Set(['Files', 'Provincial Response Letter', 'Closure Notice']);

const basename = u => { try { return decodeURIComponent(String(u).split('/').pop().split('?')[0]); } catch { return String(u).split('/').pop(); } };

// Work out what changed on a file/attachment field for the audit line.
function auditFileChange(k, oldV, newV) {
  if (k === 'Response Files') {                       // newline-delimited URL text
    const before = new Set(String(oldV || '').split(/\n+/).map(s => s.trim()).filter(Boolean).map(basename));
    const afterNames = String(newV || '').split(/\n+/).map(s => s.trim()).filter(Boolean).map(basename);
    const added = afterNames.filter(n => !before.has(n));
    const removed = [...before].filter(n => !afterNames.includes(n)).length;
    return { label: 'Response files', added, removed };
  }
  // multipleAttachments: new uploads arrive as {url} (no id); kept ones as {id}.
  const arr = Array.isArray(newV) ? newV : [];
  const added = arr.filter(a => a && a.url && !a.id).map(a => basename(a.url));
  const keptIds = new Set(arr.filter(a => a && a.id).map(a => a.id));
  const removed = (Array.isArray(oldV) ? oldV : []).filter(a => a && a.id && !keptIds.has(a.id)).length;
  return { label: k, added, removed };
}

// Human-readable, tamper-evident diff for the Activity Log. Short fields show the
// value change; long text/JSON is noted as "edited"; files list what was uploaded.
function auditDiff(curFields, fields) {
  const parts = [];
  for (const k of Object.keys(fields)) {
    if (k === 'Activity Log') continue;
    const oldV = curFields[k], newV = fields[k];
    if (k === 'Response Files' || AUDIT_FILE_FIELDS.has(k)) {
      const { label, added, removed } = auditFileChange(k, oldV, newV);
      if (added.length) parts.push(`${label}: uploaded ${added.join(', ')}`);
      if (removed) parts.push(`${label}: removed ${removed} file${removed > 1 ? 's' : ''}`);
      if (!added.length && !removed) parts.push(`${label} updated`);
      continue;
    }
    if (AUDIT_VALUE_FIELDS.has(k)) {
      const o = (oldV == null || oldV === '') ? '—' : String(oldV);
      const n = (newV == null || newV === '') ? '—' : String(newV);
      if (o !== n) parts.push(`${k}: ${o} → ${n}`);
      continue;
    }
    parts.push(`${k} edited`);                        // long text / JSON — no content dump
  }
  return parts;
}

// Append one stamped line to a record's Activity Log (used for email dispatch trails).
async function appendLog(id, curLog, line, who) {
  const log = [String(curLog || '').trim(), `[${nowStamp()} · ${who || 'system'}] ${line}`].filter(Boolean).join('\n');
  await at(`${AT}/${id}`, 'PATCH', { fields: { 'Activity Log': log } });
  return log;
}
// Turn a notifyAssignment result into an audit line, e.g. "notified responder Jane Doe <j@x>".
function emailLogLine(sent) {
  const bits = [];
  (sent.responders || []).forEach(r => bits.push(`responder ${r.name} <${r.email}>`));
  (sent.reviewers  || []).forEach(r => bits.push(`reviewer ${r.name} <${r.email}>`));
  return bits.length ? `notified ${bits.join(', ')}` : '';
}

async function at(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: HDR, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function buildFilter(qs) {
  const parts = [];
  if (qs.nc) parts.push(`{NC #}='${esc(qs.nc)}'`);
  if (qs.asset) parts.push(`{Asset ID}='${esc(qs.asset)}'`);   // Asset 360 — all NCs for one asset
  // Notice-type scope: 'ncn' = everything except Defect Notices; 'def' = only Defect Notices.
  if (qs.notice === 'ncn') parts.push(`{Notice Type}!='Defect Notice'`);
  else if (qs.notice === 'def') parts.push(`{Notice Type}='Defect Notice'`);
  if (qs.status === 'open') parts.push(`AND({Status}!='Closed',{Status}!='Cancelled')`);
  else if (qs.status === 'overdue') parts.push(`AND({Status}!='Closed',{Status}!='Cancelled',{Due Date}<'${today()}')`);
  else if (qs.status) parts.push(`{Status}='${esc(qs.status)}'`);
  if (qs.classification) parts.push(`{Classification}='${esc(qs.classification)}'`);
  if (qs.source) parts.push(`{Source}='${esc(qs.source)}'`);
  if (qs.division) parts.push(`{Division}='${esc(qs.division)}'`);
  if (qs.standard) {
    if (qs.standard === '__OTHER__') parts.push(`AND({Standard / Clause}!='',NOT(REGEX_MATCH({Standard / Clause},'OMM\\s*\\d')))`);
    else parts.push(`FIND('${esc(qs.standard)}',{Standard / Clause})`);
  }
  if (qs.q) {
    const Q_FIELDS = ['NC #', 'Source Reference', 'Standard / Clause', 'Requirement',
                      'Description', 'Raised By', 'Responsible Person', 'Root Cause', 'Corrective Action'];
    const terms = String(qs.q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    for (const t of terms) {
      const x = esc(t);
      parts.push('OR(' + Q_FIELDS.map(f => `FIND('${x}',LOWER({${f}}&''))`).join(',') + ')');
    }
  }
  return parts.length ? (parts.length === 1 ? parts[0] : `AND(${parts.join(',')})`) : '';
}

async function list(qs) {
  const limit = Math.min(parseInt(qs.limit || '500', 10) || 500, 5000);
  const filter = buildFilter(qs);
  const rows = [];
  let offset;
  do {
    const p = new URLSearchParams();
    p.set('pageSize', '100');
    p.append('sort[0][field]', 'Date Raised');
    p.append('sort[0][direction]', 'desc');
    if (filter) p.set('filterByFormula', filter);
    if (offset) p.set('offset', offset);
    const json = await at(`${AT}?${p.toString()}`);
    for (const r of json.records) rows.push({ id: r.id, ...r.fields });
    offset = json.offset;
  } while (offset && rows.length < limit);
  return { rows: rows.slice(0, limit), truncated: rows.length >= limit };
}

function splitStandards(s) {
  return String(s).split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(p => p.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

async function stats() {
  const acc = { total: 0, open: 0, overdue: 0, majorOpen: 0, closed: 0,
    provincial: { total: 0, open: 0 }, internal: { total: 0, open: 0 },
    provNCN: { total: 0, open: 0 }, provDEF: { total: 0, open: 0 },
    bySource: {}, byClassification: {}, byDivision: {}, byStatus: {}, byStandard: {} };
  const t = today();
  let offset;
  do {
    const p = new URLSearchParams();
    p.set('pageSize', '100');
    ['Status', 'Classification', 'Source', 'Division', 'Due Date', 'Standard / Clause', 'Notice Type'].forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const json = await at(`${AT}?${p.toString()}`);
    for (const r of json.records) {
      const f = r.fields;
      const st = f['Status'] || 'New';
      acc.total++;
      acc.byStatus[st] = (acc.byStatus[st] || 0) + 1;
      // Provincial vs Internal split — strictly by audit Source (other sources in neither)
      const src = f['Source'];
      if (src === 'Provincial Audit') {
        acc.provincial.total++; if (!TERMINAL.includes(st)) acc.provincial.open++;
        // Split provincial by instrument: Defect Notice (DEF) vs Non-Conformance Notice (NCN, the default).
        const bucket = (f['Notice Type'] === 'Defect Notice') ? acc.provDEF : acc.provNCN;
        bucket.total++; if (!TERMINAL.includes(st)) bucket.open++;
      }
      else if (src === 'Internal Audit') { acc.internal.total++; if (!TERMINAL.includes(st)) acc.internal.open++; }
      if (!TERMINAL.includes(st)) {
        acc.open++;
        if (f['Due Date'] && f['Due Date'] < t) acc.overdue++;
        if (f['Classification'] === 'Major') acc.majorOpen++;
        // OMM standard breakdown — OPEN NCNs only (exclude Defect Notices; multi-standard split on top-level commas)
        const sc = f['Standard / Clause'];
        if (sc && f['Notice Type'] !== 'Defect Notice') for (const part of splitStandards(sc)) {
          const m = part.match(/^OMM\s*(\d{3})\b/);
          const code = m ? `OMM ${m[1]}` : '__OTHER__';
          const b = acc.byStandard[code] || (acc.byStandard[code] = { code, label: m ? part : 'Other / non-OMM', count: 0 });
          b.count++;
        }
        acc.bySource[f['Source'] || 'Other'] = (acc.bySource[f['Source'] || 'Other'] || 0) + 1;
        acc.byClassification[f['Classification'] || 'Unset'] = (acc.byClassification[f['Classification'] || 'Unset'] || 0) + 1;
        acc.byDivision[f['Division'] || 'Unassigned'] = (acc.byDivision[f['Division'] || 'Unassigned'] || 0) + 1;
      } else if (st === 'Closed') acc.closed++;
    }
    offset = json.offset;
  } while (offset);
  return acc;
}

// NC-YYYY-NNN — next sequence for the current year.
async function nextNcNumber() {
  const year = today().slice(0, 4);
  const p = new URLSearchParams();
  p.set('filterByFormula', `FIND('NC-${year}-',{NC #})=1`);
  p.append('fields[]', 'NC #');
  p.set('pageSize', '100');
  let max = 0, offset;
  do {
    if (offset) p.set('offset', offset);
    const json = await at(`${AT}?${p.toString()}`);
    for (const r of json.records) {
      const m = String(r.fields['NC #'] || '').match(/NC-\d{4}-(\d+)/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    offset = json.offset;
  } while (offset);
  return `NC-${year}-${String(max + 1).padStart(3, '0')}`;
}

// Resolve a set of employee names to their email addresses (from the Employees base).
async function emailsForNames(names) {
  const wanted = [...new Set(names.map(n => String(n).trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return {};
  const out = {};
  let offset;
  do {
    const p = new URLSearchParams();
    p.set('pageSize', '100');
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

// Active managers (for the Responsible Person picker) — read from the Employees base.
async function managers() {
  const out = [];
  let offset;
  const formula = "AND({Active}='Active',OR({Role}='Manager',FIND('Manager',ARRAYJOIN({Job Title}))))";
  do {
    const p = new URLSearchParams();
    p.set('pageSize', '100');
    p.set('filterByFormula', formula);
    ['Name', 'Email', 'Job Title'].forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const res = await fetch(`https://api.airtable.com/v0/${EMP_BASE}/${encodeURIComponent(EMP_TABLE)}?${p.toString()}`, { headers: HDR });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) break;
    for (const r of (json.records || [])) {
      const name = String(r.fields['Name'] || '').trim();
      if (name) out.push({ name, title: [].concat(r.fields['Job Title'] || []).join(', '), email: r.fields['Email'] || '' });
    }
    offset = json.offset;
  } while (offset);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function sendMail(to, subject, html) {
  if (!RESEND_KEY || !to) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
    });
    return res.ok;
  } catch { return false; }
}

const splitNames = s => String(s || '').split(/[;\n,]+/).map(x => x.trim()).filter(Boolean);

// Email newly-assigned responders (respond) and reviewers (review). Fires on
// assignment only — a name that is newly added compared with the record's prior value.
async function notifyAssignment({ ncNo, appUrl, oldFields, newFields, actor }) {
  const oldResp = String(oldFields['Responsible Person'] || '').trim();
  const newResp = ('Responsible Person' in newFields) ? String(newFields['Responsible Person'] || '').trim() : oldResp;
  const respAdded = (newResp && newResp.toLowerCase() !== oldResp.toLowerCase()) ? [newResp] : [];
  const oldRev = new Set(splitNames(oldFields['Reviewers']).map(x => x.toLowerCase()));
  const revAdded = ('Reviewers' in newFields) ? splitNames(newFields['Reviewers']).filter(n => !oldRev.has(n.toLowerCase())) : [];
  const sent = { responders: [], reviewers: [] };
  if (!respAdded.length && !revAdded.length) return sent;
  const emails = await emailsForNames([...respAdded, ...revAdded]);
  const link = appUrl ? `${appUrl}/?nc=${encodeURIComponent(ncNo)}` : '';
  const btn = link ? `<p><a href="${link}" style="background:#1E2B5E;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open ${ncNo}</a></p>` : '';
  const by = actor ? ` by ${actor}` : '';
  for (const name of respAdded) {
    const to = emails[name.toLowerCase()]; if (!to) continue;
    if (await sendMail(to, `NC ${ncNo} — assigned to you to respond`,
      `<p>Hi ${name.split(' ')[0]},</p><p>You have been assigned to respond to non-conformance <b>${ncNo}</b>${by}. Please review it, work through the response checklist, and upload your completed response sheet and any photos of the repair.</p>${btn}`))
      sent.responders.push({ name, email: to });
  }
  for (const name of revAdded) {
    const to = emails[name.toLowerCase()]; if (!to) continue;
    if (await sendMail(to, `NC ${ncNo} — for your review`,
      `<p>Hi ${name.split(' ')[0]},</p><p>You have been added as a reviewer on non-conformance <b>${ncNo}</b>${by}. You can open it to read and review the response.</p>${btn}`))
      sent.reviewers.push({ name, email: to });
  }
  return sent;
}

// Provincial NC only: when the response is marked "Ready for Review", email the NC
// admin (Troy) that the manager's response is in and a Province response letter is needed.
async function notifyResponseReady({ ncNo, appUrl, actor }) {
  const to = ADMIN_EMAIL;
  if (!to) return null;
  const link = appUrl ? `${appUrl}/?nc=${encodeURIComponent(ncNo)}` : '';
  const btn = link ? `<p><a href="${link}" style="background:#1E2B5E;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open ${ncNo}</a></p>` : '';
  const by = actor ? ` (submitted by ${actor})` : '';
  const ok = await sendMail(to, `NC ${ncNo} — response ready, Province letter needed`,
    `<p>The response for provincial non-conformance <b>${ncNo}</b> is ready for your review${by}.</p><p>Please review the manager's response and documents, then draft, sign and mail the Province response letter, and upload the signed scan.</p>${btn}`);
  return ok ? to : null;
}

// Add N working days (Mon–Fri) to an ISO date string. Holidays are not accounted for.
function addBusinessDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  let added = 0;
  while (added < n) { d.setUTCDate(d.getUTCDate() + 1); const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) added++; }
  return d.toISOString().slice(0, 10);
}
function planSteps(fields) {
  try { const a = JSON.parse(fields['Action Plan'] || '[]'); return Array.isArray(a) ? a.filter(s => s && s.step) : []; } catch { return []; }
}
// Follow-up email about an NC and its action plan — to the responsible person + the NC admin.
async function sendFollowup({ ncNo, fields, appUrl, actor }) {
  const resp = String(fields['Responsible Person'] || '').trim();
  const emails = await emailsForNames(resp ? [resp] : []);
  const uniq = [...new Set([emails[resp.toLowerCase()], ADMIN_EMAIL].filter(Boolean))];
  if (!uniq.length) return false;
  const raised = fields['Date Raised'];
  const due = raised ? addBusinessDays(raised, 5) : '';
  const started = fields['Action Plan Started'];
  const steps = planSteps(fields);
  const statusLine = started
    ? `The action plan was started on ${started}.`
    : `<b style="color:#A32D2D">No action plan has been started yet.</b> It must be started within 5 working days of issue${due ? ` — by ${due}` : ''}.`;
  const stepsHtml = steps.length
    ? '<ul>' + steps.map(s => `<li>${String(s.step)}${s.due ? ` — expected ${s.due}` : ''}${s.done ? ' ✓' : ''}</li>`).join('') + '</ul>'
    : '<p>No steps recorded yet.</p>';
  const link = appUrl ? `${appUrl}/?nc=${encodeURIComponent(ncNo)}` : '';
  const btn = link ? `<p><a href="${link}" style="background:#1E2B5E;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open ${ncNo}</a></p>` : '';
  const by = actor ? ` (sent by ${actor})` : '';
  const html = `<p>Follow-up on non-conformance <b>${ncNo}</b>${by}.</p><p>${statusLine}</p><p><b>Action plan:</b></p>${stepsHtml}${btn}`;
  const recipients = [];
  for (const addr of uniq) { if (await sendMail(addr, `NC ${ncNo} — action plan follow-up`, html)) recipients.push(addr); }
  return { ok: recipients.length > 0, recipients };
}

// CORS: let other MRDC apps (e.g. the Asset 360 page) read this API from the browser.
const ORIGIN_OK = /^https:\/\/([a-z0-9-]+\.)*mrdc-htra\.com$|^https:\/\/[a-z0-9-]+\.vercel\.app$/i;
function applyCors(req, res) {
  const origin = req.headers && req.headers.origin;
  if (origin && ORIGIN_OK.test(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-role, x-app-role, x-user-id, x-user-name');
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!PAT || !BASE) { res.status(500).json({ ok: false, error: 'AIRTABLE_PAT and NC_BASE_ID must be set' }); return; }

  const userRole = String(req.headers['x-user-role'] || '');
  const appRole  = String(req.headers['x-app-role']  || '');
  const userName = String(req.headers['x-user-name'] || '');
  const isAdmin  = userRole === 'Admin' || userRole === 'Owner' || appRole === 'Admin';
  const canWork  = isAdmin || appRole === 'Manager' || userRole === 'Manager';

  try {
    if (req.method === 'GET') {
      const qs = req.query || {};
      if (qs.managers === '1') {
        res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
        res.status(200).json({ ok: true, managers: await managers() });
        return;
      }
      if (qs.stats === '1') {
        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
        res.status(200).json({ ok: true, stats: await stats() });
        return;
      }
      const { rows, truncated } = await list(qs);
      res.status(200).json({ ok: true, count: rows.length, truncated, records: rows });
      return;
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');

      // ── Append-only comment (any Manager/Admin) ────────────────────────────
      if (body.action === 'comment') {
        if (!canWork) { res.status(403).json({ ok: false, error: 'Managers and admins only' }); return; }
        const text = String(body.text || '').trim();
        if (!body.id || !text) { res.status(400).json({ ok: false, error: 'id and text are required' }); return; }
        const cur = await at(`${AT}/${body.id}`);
        const stamp = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${userName || 'unknown'}]`;
        const log = [(cur.fields['Activity Log'] || '').trim(), `${stamp} ${text}`].filter(Boolean).join('\n');
        const j = await at(`${AT}/${body.id}`, 'PATCH', { fields: { 'Activity Log': log } });
        res.status(200).json({ ok: true, record: { id: j.id, ...j.fields } });
        return;
      }

      // ── Send an action-plan follow-up email (Manager/Admin) ────────────────
      if (body.action === 'followup') {
        if (!canWork) { res.status(403).json({ ok: false, error: 'Managers and admins only' }); return; }
        if (!body.id) { res.status(400).json({ ok: false, error: 'id is required' }); return; }
        const cur = await at(`${AT}/${body.id}`);
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const result = await sendFollowup({ ncNo: cur.fields['NC #'] || body.id, fields: cur.fields, appUrl: host ? `https://${host}` : '', actor: userName });
        if (result.ok) {
          await appendLog(body.id, cur.fields['Activity Log'], `action-plan follow-up email sent to ${result.recipients.join(', ')}`, userName);
        }
        res.status(result.ok ? 200 : 500).json({ ok: result.ok, error: result.ok ? undefined : 'Email not sent — check RESEND_API_KEY / recipient emails' });
        return;
      }

      // ── Create ─────────────────────────────────────────────────────────────
      if (!canWork) { res.status(403).json({ ok: false, error: 'Only NC admins and managers can raise an NC' }); return; }
      const incoming = body.fields || {};
      const fields = {};
      for (const [k, v] of Object.entries(incoming)) {
        if (MANAGER_FIELDS.has(k) || (isAdmin && ADMIN_FIELDS.has(k))) fields[k] = v;
      }
      // NC number convention: an EXTERNALLY issued NC keeps its own NCN number
      // (provincial / ISO / client auditors issue these — that number is how
      // everyone references it, same principle as the DMT's Submission ID).
      // Internal NCs get the next NC-YYYY-NNN automatically.
      const providedNcn = String(incoming['NC #'] || '').trim();
      if (providedNcn) {
        const dup = await at(`${AT}?maxRecords=1&filterByFormula=${encodeURIComponent(`{NC #}='${esc(providedNcn)}'`)}`);
        if ((dup.records || []).length) {
          res.status(409).json({ ok: false, error: `An NC with number "${providedNcn}" already exists` });
          return;
        }
        fields['NC #'] = providedNcn;
      } else {
        fields['NC #'] = await nextNcNumber();
      }
      fields['Status'] = fields['Status'] && STATUSES.includes(fields['Status']) ? fields['Status'] : 'New';
      if (!fields['Date Raised']) fields['Date Raised'] = today();
      // Default due date = 10 working days from the raised date (unless one was entered).
      if (!fields['Due Date']) fields['Due Date'] = addBusinessDays(fields['Date Raised'], 10);
      if (!fields['Raised By']) fields['Raised By'] = userName;
      fields['Submitted At'] = new Date().toISOString();
      const stamp = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${userName || 'unknown'}]`;
      fields['Activity Log'] = `${stamp} NC raised`;
      const j = await at(AT, 'POST', { records: [{ fields }], typecast: true });
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      try {
        const sent = await notifyAssignment({ ncNo: fields['NC #'], appUrl: host ? `https://${host}` : '', oldFields: {}, newFields: fields, actor: userName });
        const line = emailLogLine(sent || {});
        if (line) await appendLog(j.records[0].id, j.records[0].fields['Activity Log'], line, userName);
      } catch (_) {}
      res.status(200).json({ ok: true, record: { id: j.records[0].id, ...j.records[0].fields } });
      return;
    }

    if (req.method === 'PATCH') {
      const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
      if (!body.id) { res.status(400).json({ ok: false, error: 'id is required' }); return; }
      // Fetch the record up front so we can check responder identity.
      const curRec = await at(`${AT}/${body.id}`);
      const curFields = curRec.fields || {};
      const respName = String(curFields['Responsible Person'] || '').toLowerCase();
      const isResponder = !!userName && respName.length > 0 && respName.includes(userName.toLowerCase());
      if (!canWork && !isResponder) {
        res.status(403).json({ ok: false, error: 'Only managers, admins, or the assigned responder can edit this NC' });
        return;
      }

      const incoming = body.fields || {};
      const fields = {};
      const rejected = [];
      for (const [k, v] of Object.entries(incoming)) {
        if (canWork && MANAGER_FIELDS.has(k)) fields[k] = v;
        else if (canWork && ADMIN_FIELDS.has(k)) { if (isAdmin) fields[k] = v; else rejected.push(k); }
        else if (RESPONSE_FIELDS.has(k)) fields[k] = v;   // responder (or manager) may write response fields
        else if (k === 'Status' && RESPONDER_STATUSES.includes(v)) fields[k] = v;   // responder may mark "Ready for Review"
        else rejected.push(k);
      }

      // Stamp when the action plan is first started (for the 5-working-day rule).
      if ('Action Plan' in fields && String(fields['Action Plan'] || '').trim() && !String(curFields['Action Plan Started'] || '').trim() && !fields['Action Plan Started']) {
        fields['Action Plan Started'] = today();
      }

      // Status rails: only Admin may set a terminal status; stamps applied.
      if ('Status' in fields) {
        if (!STATUSES.includes(fields['Status'])) { res.status(400).json({ ok: false, error: 'invalid status' }); return; }
        if (TERMINAL.includes(fields['Status'])) {
          if (!isAdmin) { res.status(403).json({ ok: false, error: 'Only an NC admin can close or cancel an NC' }); return; }
          if (fields['Status'] === 'Closed' && !fields['Date Closed']) fields['Date Closed'] = today();
        }
        if (fields['Status'] === 'Letter Sent' && !fields['Letter Date Sent']) fields['Letter Date Sent'] = today();
        if (fields['Status'] === 'Verification' && !fields['Verified By'] && isAdmin && userName) {
          // convenience only — verification details still entered explicitly
        }
      }
      if (!Object.keys(fields).length) { res.status(400).json({ ok: false, error: 'no editable fields in request', rejected }); return; }

      // Stamp the change into the Activity Log — value-level, tamper-evident diff.
      const diffs = auditDiff(curFields, fields);
      const summary = diffs.length ? diffs.join('; ') : 'saved (no field changes)';
      const log = [(curFields['Activity Log'] || '').trim(), `[${nowStamp()} · ${userName || 'unknown'}] ${summary}`].filter(Boolean).join('\n');
      fields['Activity Log'] = log;

      const j = await at(`${AT}/${body.id}`, 'PATCH', { fields, typecast: true });
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const ncNo = j.fields['NC #'] || curFields['NC #'] || body.id;
      let curLog = j.fields['Activity Log'];
      // Stamp who was emailed on assignment (responder / reviewer).
      try {
        const sent = await notifyAssignment({ ncNo, appUrl: host ? `https://${host}` : '', oldFields: curFields, newFields: fields, actor: userName });
        const line = emailLogLine(sent || {});
        if (line) curLog = await appendLog(body.id, curLog, line, userName);
      } catch (_) {}
      // Provincial-only: alert Troy when the response is newly marked Ready for Review.
      try {
        if ('Status' in fields && fields['Status'] === 'Ready for Review' && curFields['Status'] !== 'Ready for Review' && curFields['Source'] === 'Provincial Audit') {
          const to = await notifyResponseReady({ ncNo, appUrl: host ? `https://${host}` : '', actor: userName });
          if (to) curLog = await appendLog(body.id, curLog, `notified NC admin <${to}> — response ready, Province letter needed`, userName);
        }
      } catch (_) {}
      res.status(200).json({ ok: true, record: { id: j.id, ...j.fields, 'Activity Log': curLog }, rejected: rejected.length ? rejected : undefined });
      return;
    }

    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
