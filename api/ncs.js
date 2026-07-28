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

const TERMINAL = ['Closed', 'Cancelled'];
const STATUSES = ['New', 'Containment', 'Root Cause', 'Corrective Action', 'Verification', 'Closed', 'Cancelled'];

// Fields a Manager may write. Admins may additionally write ADMIN_FIELDS.
const MANAGER_FIELDS = new Set([
  'Source', 'Source Reference', 'Classification', 'Date Raised', 'Raised By',
  'Standard / Clause', 'Requirement', 'Description', 'Division',
  'Responsible Person', 'Due Date', 'Containment Action', 'Root Cause',
  'Corrective Action', 'Preventive Action', 'Date Action Completed',
  'Attachment URLs', 'Status',
]);
const ADMIN_FIELDS = new Set([
  'Verified By', 'Date Verified', 'Verification Notes', 'Date Closed',
]);

const esc = s => String(s).replace(/'/g, "\\'");
const today = () => new Date().toISOString().slice(0, 10);

async function at(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: HDR, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function buildFilter(qs) {
  const parts = [];
  if (qs.nc) parts.push(`{NC #}='${esc(qs.nc)}'`);
  if (qs.status === 'open') parts.push(`AND({Status}!='Closed',{Status}!='Cancelled')`);
  else if (qs.status === 'overdue') parts.push(`AND({Status}!='Closed',{Status}!='Cancelled',{Due Date}<'${today()}')`);
  else if (qs.status) parts.push(`{Status}='${esc(qs.status)}'`);
  if (qs.classification) parts.push(`{Classification}='${esc(qs.classification)}'`);
  if (qs.source) parts.push(`{Source}='${esc(qs.source)}'`);
  if (qs.division) parts.push(`{Division}='${esc(qs.division)}'`);
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

async function stats() {
  const acc = { total: 0, open: 0, overdue: 0, majorOpen: 0, closed: 0,
    provincial: { total: 0, open: 0 }, internal: { total: 0, open: 0 },
    bySource: {}, byClassification: {}, byDivision: {}, byStatus: {} };
  const t = today();
  let offset;
  do {
    const p = new URLSearchParams();
    p.set('pageSize', '100');
    ['Status', 'Classification', 'Source', 'Division', 'Due Date'].forEach(f => p.append('fields[]', f));
    if (offset) p.set('offset', offset);
    const json = await at(`${AT}?${p.toString()}`);
    for (const r of json.records) {
      const f = r.fields;
      const st = f['Status'] || 'New';
      acc.total++;
      acc.byStatus[st] = (acc.byStatus[st] || 0) + 1;
      // Provincial vs Internal split — strictly by audit Source (other sources in neither)
      const src = f['Source'];
      if (src === 'Provincial Audit') { acc.provincial.total++; if (!TERMINAL.includes(st)) acc.provincial.open++; }
      else if (src === 'Internal Audit') { acc.internal.total++; if (!TERMINAL.includes(st)) acc.internal.open++; }
      if (!TERMINAL.includes(st)) {
        acc.open++;
        if (f['Due Date'] && f['Due Date'] < t) acc.overdue++;
        if (f['Classification'] === 'Major') acc.majorOpen++;
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

module.exports = async (req, res) => {
  if (!PAT || !BASE) { res.status(500).json({ ok: false, error: 'AIRTABLE_PAT and NC_BASE_ID must be set' }); return; }

  const userRole = String(req.headers['x-user-role'] || '');
  const appRole  = String(req.headers['x-app-role']  || '');
  const userName = String(req.headers['x-user-name'] || '');
  const isAdmin  = userRole === 'Admin' || userRole === 'Owner' || appRole === 'Admin';
  const canWork  = isAdmin || appRole === 'Manager' || userRole === 'Manager';

  try {
    if (req.method === 'GET') {
      const qs = req.query || {};
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
      if (!fields['Raised By']) fields['Raised By'] = userName;
      fields['Submitted At'] = new Date().toISOString();
      const stamp = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${userName || 'unknown'}]`;
      fields['Activity Log'] = `${stamp} NC raised`;
      const j = await at(AT, 'POST', { records: [{ fields }], typecast: true });
      res.status(200).json({ ok: true, record: { id: j.records[0].id, ...j.records[0].fields } });
      return;
    }

    if (req.method === 'PATCH') {
      const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
      if (!body.id) { res.status(400).json({ ok: false, error: 'id is required' }); return; }
      if (!canWork) { res.status(403).json({ ok: false, error: 'Managers and admins only' }); return; }

      const incoming = body.fields || {};
      const fields = {};
      const rejected = [];
      for (const [k, v] of Object.entries(incoming)) {
        if (MANAGER_FIELDS.has(k)) fields[k] = v;
        else if (ADMIN_FIELDS.has(k)) { if (isAdmin) fields[k] = v; else rejected.push(k); }
        else rejected.push(k);
      }

      // Status rails: only Admin may set a terminal status; stamps applied.
      if ('Status' in fields) {
        if (!STATUSES.includes(fields['Status'])) { res.status(400).json({ ok: false, error: 'invalid status' }); return; }
        if (TERMINAL.includes(fields['Status'])) {
          if (!isAdmin) { res.status(403).json({ ok: false, error: 'Only an NC admin can close or cancel an NC' }); return; }
          if (fields['Status'] === 'Closed' && !fields['Date Closed']) fields['Date Closed'] = today();
        }
        if (fields['Status'] === 'Verification' && !fields['Verified By'] && isAdmin && userName) {
          // convenience only — verification details still entered explicitly
        }
      }
      if (!Object.keys(fields).length) { res.status(400).json({ ok: false, error: 'no editable fields in request', rejected }); return; }

      // Stamp the change into the Activity Log.
      const cur = await at(`${AT}/${body.id}`);
      const stamp = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${userName || 'unknown'}]`;
      const changed = Object.keys(fields).join(', ');
      const log = [(cur.fields['Activity Log'] || '').trim(), `${stamp} updated: ${changed}`].filter(Boolean).join('\n');
      fields['Activity Log'] = log;

      const j = await at(`${AT}/${body.id}`, 'PATCH', { fields, typecast: true });
      res.status(200).json({ ok: true, record: { id: j.id, ...j.fields }, rejected: rejected.length ? rejected : undefined });
      return;
    }

    res.status(405).json({ ok: false, error: 'method not allowed' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
