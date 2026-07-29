/*
 * NC — /api/nc-intake
 * -------------------
 * Machine intake for provincial notices AND audit reports, called by a Power
 * Automate flow that watches the mailbox for NBHC / @gnb.ca
 * "FMHP: Issue of Audit Reports OWFFM… and Notice OMNCN…" emails.
 * Secret-gated (not the user SSO) so an unattended flow can post to it.
 *
 * POST /api/nc-intake
 *   headers: x-intake-key: <INTAKE_SECRET>
 *   body: {
 *     "notices": [ {                         // -> Non Conformances table
 *        "nc": "OMNCN1124",                  // required
 *        "source": "Provincial Audit",       // optional (default Provincial Audit)
 *        "noticeType": "NCN",                // optional (default NCN)
 *        "standard": "Sch. 1, Part 5",       // optional
 *        "dateRaised": "2026-07-15",         // optional ISO (default today)
 *        "dueDate": "",                      // optional; blank => raised + 10 working days
 *        "description": "",                  // optional
 *        "noticeUrl": "https://…"            // optional
 *     } ],
 *     "audits": [ {                          // -> Audit Reports table
 *        "report": "OWFFM0064",              // required
 *        "source": "Provincial Audit",       // optional (default Provincial Audit)
 *        "date": "2026-07-21",               // optional ISO
 *        "result": "Compliant",              // optional (default Compliant)
 *        "standard": "",                     // optional
 *        "division": "",                     // optional
 *        "notes": "",                        // optional
 *        "reportUrl": "https://…"            // optional — link to filed PDF / source email
 *     } ]
 *   }
 *
 * Idempotent: a notice / report whose key already exists is skipped (never
 * duplicated), so the flow can safely re-run.
 * Returns { ok, notices:{created,skipped,errors}, audits:{created,skipped,errors} }.
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

async function existsBy(atUrl, field, value) {
  const j = await at(`${atUrl}?maxRecords=1&filterByFormula=${encodeURIComponent(`{${field}}='${esc(value)}'`)}`);
  return (j.records || []).length > 0;
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
      const j = await at(AT_AUDIT, 'POST', { records: [{ fields }], typecast: true });
      created.push({ report, id: j.records[0].id });
    } catch (e) { errors.push({ key: report, error: e.message }); }
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
    const notices = Array.isArray(body.notices) ? body.notices : (body.nc ? [body] : []);
    const audits  = Array.isArray(body.audits) ? body.audits : (body.report ? [body] : []);
    if (!notices.length && !audits.length) { res.status(400).json({ ok: false, error: 'no notices or audits in body' }); return; }

    const nRes = notices.length ? await importNotices(notices) : { created: [], skipped: [], errors: [] };
    const aRes = audits.length  ? await importAudits(audits)   : { created: [], skipped: [], errors: [] };
    const ok = nRes.errors.length === 0 && aRes.errors.length === 0;
    res.status(200).json({ ok, notices: nRes, audits: aRes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
