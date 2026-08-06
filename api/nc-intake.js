/*
 * NC — /api/nc-intake
 * -------------------
 * Machine intake for provincial notices, audit reports AND closures, called by
 * Power Automate flows that watch the mailbox for NBHC / @gnb.ca emails.
 * Secret-gated (not the user SSO) so an unattended flow can post to it.
 *
 * POST /api/nc-intake
 *   headers: x-intake-key: <INTAKE_SECRET>
 *   body: {
 *     "notices":  [ { "nc":"OMNCN1124", "standard":"", "dateRaised":"", "dueDate":"", "description":"", "noticeUrl":"", "noticePdf":"" } ],  // -> Non Conformances
 *     "audits":   [ { "report":"OWFFM0064", "date":"", "result":"", "standard":"", "division":"", "notes":"", "reportUrl":"", "reportPdf":"" } ], // -> Audit Reports
 *     "closures": [ { "nc":"OMNCN1073", "effectiveDate":"2026-05-19", "closureUrl":"", "closurePdf":"" } ]   // -> close matching Non Conformance
 *   }
 *
 * PDF vs link: pass a *Pdf field (noticePdf / reportPdf / closurePdf) with a
 * fetchable URL to the email/notice rendered as PDF (SharePoint or Cloudinary) and
 * it is stored as a real copy on the record's Files attachment field — Airtable
 * downloads and keeps it. The *Url fields still write the plain link (Attachment
 * URLs / Notes) as a fallback. Prefer the PDF for issuance (NCN/DEF) and closures.
 *
 * Idempotent: notices/audits whose key exists are skipped; a closure whose NCN
 * is already Closed is skipped. Safe to re-run.
 * Returns { ok, notices:{...}, audits:{...}, closures:{closed,skipped,notFound,errors} }.
 *
 * Env: AIRTABLE_PAT (write scope), NC_BASE_ID, INTAKE_SECRET (required).
 * Optional: NC_TABLE (default 'Non Conformances'), AUDIT_TABLE (default 'Audit Reports').
 */
'use strict';

const PAT    = process.env.AIRTABLE_PAT;
const BASE   = process.env.NC_BASE_ID;
const NC_TABLE    = process.env.NC_TABLE || 'Non Conformances';
const AUDIT_TABLE = process.env.AUDIT_TABLE || 'Audit Reports';
const AT_NC    = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(NC_TABLE)}`;
const AT_AUDIT = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(AUDIT_TABLE)}`;
const HDR    = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };
const SECRET = process.env.INTAKE_SECRET;

const today = () => new Date().toISOString().slice(0, 10);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const esc = s => String(s).replace(/'/g, "\\'");

// Add N working days (Mon–Fri) to an ISO date string. Holidays not accounted for.
function addBusinessDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  let added = 0;
  while (added < n) { d.setUTCDate(d.getUTCDate() + 1); const dow = d.getUTCDay(); if (dow !== 0 && dow !== 6) added++; }
  return d.toISOString().slice(0, 10);
}

async function at(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: HDR, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function findOne(atUrl, field, value) {
  const j = await at(`${atUrl}?maxRecords=1&filterByFormula=${encodeURIComponent(`{${field}}='${esc(value)}'`)}`);
  return (j.records || [])[0] || null;
}

async function existsBy(atUrl, field, value) {
  return !!(await findOne(atUrl, field, value));
}

async function importNotices(list) {
  const created = [], skipped = [], errors = [];
  for (const n of list) {
    const nc = String(n.nc || '').trim();
    if (!nc) { errors.push({ key: null, error: 'missing nc' }); continue; }
    try {
      if (await existsBy(AT_NC, 'NC #', nc)) { skipped.push(nc); continue; }
      const raised = isDate(n.dateRaised) ? n.dateRaised : today();
      const due = isDate(n.dueDate) ? n.dueDate : addBusinessDays(raised, 10);
      const stamp = `[${today()} · Email intake] Created from provincial notice email via Power Automate.`;
      const fields = {
        'NC #': nc,
        'Source': n.source || 'Provincial Audit',
        'Notice Type': n.noticeType || 'NCN',
        'Status': 'New',
        'Date Raised': raised,
        'Due Date': due,
        'Raised By': 'Provincial (NBHC)',
        'Submitted At': new Date().toISOString(),
        'Activity Log': n.noticeUrl ? `${stamp} Source: ${n.noticeUrl}` : stamp,
      };
      if (n.standard) fields['Standard / Clause'] = n.standard;
      if (n.description) fields['Description'] = n.description;
      if (n.sourceReference) fields['Source Reference'] = n.sourceReference;
      if (n.noticeUrl) fields['Attachment URLs'] = n.noticeUrl;
      // Store a real PDF copy of the notice on the Files field when supplied.
      if (n.noticePdf) fields['Files'] = [{ url: n.noticePdf, filename: `${nc} - notice.pdf` }];
      const j = await at(AT_NC, 'POST', { records: [{ fields }], typecast: true });
      created.push({ nc, id: j.records[0].id });
    } catch (e) { errors.push({ key: nc, error: e.message }); }
  }
  return { created, skipped, errors };
}

async function importAudits(list) {
  const created = [], skipped = [], errors = [];
  for (const a of list) {
    const report = String(a.report || a.nc || '').trim();
    if (!report) { errors.push({ key: null, error: 'missing report' }); continue; }
    try {
      if (await existsBy(AT_AUDIT, 'Report #', report)) { skipped.push(report); continue; }
      const stamp = `[${today()} · Email intake] Filed from provincial audit email via Power Automate.`;
      const fields = {
        'Report #': report,
        'Source': a.source || 'Provincial Audit',
        'Result': a.result || 'Compliant',
        'Submitted At': new Date().toISOString(),
        'Notes': a.reportUrl ? `${(a.notes ? a.notes + ' ' : '')}${stamp} Source: ${a.reportUrl}` : `${(a.notes ? a.notes + ' ' : '')}${stamp}`,
      };
      if (isDate(a.date)) fields['Date'] = a.date;
      if (a.standard) fields['Standard'] = a.standard;
      if (a.division) fields['Division'] = a.division;
      if (a.reportPdf) fields['Files'] = [{ url: a.reportPdf, filename: `${report}.pdf` }];
      const j = await at(AT_AUDIT, 'POST', { records: [{ fields }], typecast: true });
      created.push({ report, id: j.records[0].id });
    } catch (e) { errors.push({ key: report, error: e.message }); }
  }
  return { created, skipped, errors };
}

// Close matching NCNs from provincial closure emails. Auto-close (province is authoritative),
// stamp Date Closed with the effective date, append the closure note + source-email link.
async function importClosures(list) {
  const closed = [], skipped = [], notFound = [], errors = [];
  for (const c of list) {
    const nc = String(c.nc || '').trim();
    if (!nc) { errors.push({ key: null, error: 'missing nc' }); continue; }
    try {
      const rec = await findOne(AT_NC, 'NC #', nc);
      if (!rec) { notFound.push(nc); continue; }
      const f = rec.fields || {};
      if ((f['Status'] || '') === 'Closed') { skipped.push(nc); continue; }
      const eff = isDate(c.effectiveDate) ? c.effectiveDate : today();
      const stamp = `[${today()} · Email intake] Province closed ${nc} effective ${eff}.` + (c.closureUrl ? ` Source: ${c.closureUrl}` : '');
      const log = f['Activity Log'] ? `${f['Activity Log']}\n${stamp}` : stamp;
      const fields = { 'Status': 'Closed', 'Date Closed': eff, 'Activity Log': log };
      if (c.closureUrl) {
        const cur = f['Attachment URLs'] || '';
        fields['Attachment URLs'] = cur.includes(c.closureUrl) ? cur : (cur ? `${cur}\n${c.closureUrl}` : c.closureUrl);
      }
      // Store a real PDF copy of the closure email, preserving any existing Files.
      if (c.closurePdf) {
        const existing = Array.isArray(f['Files']) ? f['Files'].map(a => ({ id: a.id })) : [];
        fields['Files'] = [...existing, { url: c.closurePdf, filename: `${nc} - closure ${eff}.pdf` }];
      }
      await at(`${AT_NC}/${rec.id}`, 'PATCH', { fields, typecast: true });
      closed.push(nc);
    } catch (e) { errors.push({ key: nc, error: e.message }); }
  }
  return { closed, skipped, notFound, errors };
}

// Internal NCs raised by another MRDC system (e.g. a Quality OMM audit item graded
// NC, routed through the DMT). No externally-issued number, so we auto-assign the
// next NC-YYYY-NNN. Idempotent by Source Reference — the same work order / audit
// item never raises a second NC.
async function importInternal(list) {
  const created = [], skipped = [], errors = [];
  const year = new Date().getFullYear();
  // Current highest sequence for the year, incremented locally across the batch.
  let seq = 0;
  try {
    const j = await at(`${AT_NC}?filterByFormula=${encodeURIComponent(`FIND('NC-${year}-',{NC #})=1`)}` +
      `&sort%5B0%5D%5Bfield%5D=${encodeURIComponent('NC #')}&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=1`);
    const m = (j.records || [])[0] && String(j.records[0].fields['NC #'] || '').match(/NC-\d{4}-(\d+)/);
    if (m) seq = parseInt(m[1], 10);
  } catch { seq = 0; }
  for (const it of list) {
    const sourceRef = String(it.sourceRef || it.sourceReference || '').trim();
    try {
      if (sourceRef) {
        const dup = await findOne(AT_NC, 'Source Reference', sourceRef);
        if (dup) { skipped.push({ sourceRef, nc: dup.fields['NC #'] }); continue; }
      }
      const raised = isDate(it.dateRaised) ? it.dateRaised : today();
      const due = isDate(it.dueDate) ? it.dueDate : addBusinessDays(raised, 10);
      const nc = `NC-${year}-${String(++seq).padStart(3, '0')}`;
      const stamp = `[${today()} · Auto-intake] NC raised${sourceRef ? ` from ${sourceRef}` : ''}.`;
      const fields = {
        'NC #': nc,
        'Source': it.source || 'Quality Audit',
        'Notice Type': 'Internal NC',
        'Status': 'New',
        'Date Raised': raised,
        'Due Date': due,
        'Raised By': it.raisedBy || 'Quality audit',
        'Submitted At': new Date().toISOString(),
        'Activity Log': stamp,
      };
      if (it.standard)    fields['Standard / Clause'] = it.standard;
      if (it.description) fields['Description'] = it.description;
      if (sourceRef)      fields['Source Reference'] = sourceRef;
      if (it.assetId)     fields['Asset ID'] = it.assetId;
      if (it.division)    fields['Division'] = it.division;
      if (it.priority)    fields['Priority'] = it.priority;
      const j = await at(AT_NC, 'POST', { records: [{ fields }], typecast: true });
      created.push({ nc, id: j.records[0].id, sourceRef });
    } catch (e) { errors.push({ key: sourceRef || null, error: e.message }); }
  }
  return { created, skipped, errors };
}

module.exports = async (req, res) => {
  if (!PAT || !BASE) { res.status(500).json({ ok: false, error: 'AIRTABLE_PAT and NC_BASE_ID must be set' }); return; }
  if (!SECRET) { res.status(500).json({ ok: false, error: 'INTAKE_SECRET is not configured' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'POST only' }); return; }
  if ((req.headers['x-intake-key'] || '') !== SECRET) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
    const notices  = Array.isArray(body.notices)  ? body.notices  : (body.nc && !body.effectiveDate ? [body] : []);
    const audits   = Array.isArray(body.audits)   ? body.audits   : (body.report ? [body] : []);
    const closures = Array.isArray(body.closures) ? body.closures : (body.nc && body.effectiveDate ? [body] : []);
    const internal = Array.isArray(body.internal) ? body.internal : [];
    if (!notices.length && !audits.length && !closures.length && !internal.length) { res.status(400).json({ ok: false, error: 'no notices, audits, closures or internal NCs in body' }); return; }

    const nRes = notices.length  ? await importNotices(notices)   : { created: [], skipped: [], errors: [] };
    const aRes = audits.length   ? await importAudits(audits)     : { created: [], skipped: [], errors: [] };
    const cRes = closures.length ? await importClosures(closures) : { closed: [], skipped: [], notFound: [], errors: [] };
    const iRes = internal.length ? await importInternal(internal) : { created: [], skipped: [], errors: [] };
    const ok = nRes.errors.length === 0 && aRes.errors.length === 0 && cRes.errors.length === 0 && iRes.errors.length === 0;
    res.status(200).json({ ok, notices: nRes, audits: aRes, closures: cRes, internal: iRes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
