/*
 * NC — /api/nc-mail-intake
 * ------------------------
 * Reads the province's (@gnb.ca / NBHC) notice emails straight out of Microsoft 365
 * via the Graph API and files them into the NC tool. This REPLACES the Power Automate
 * flow that was specced in July: Troy's licence has Premium connectors disabled, so the
 * HTTP action that flow depended on is unavailable to him (checked 2026-08-19).
 *
 * Doing it here instead of in Power Automate also fixes the long-standing gap that the
 * notice PDFs never got attached: Graph hands back the real attachment BYTES, which we
 * push to Cloudinary and then hand to Airtable as a fetchable URL.
 *
 * What it handles
 *   • Issuance emails  — "FMHP: Issue of Audit Reports … and Defect Notice OMDEF… and
 *     Notices OMNCN…" / "<date> Fax to FMHP re: Issue of …". Notice numbers, issue dates
 *     and standards are parsed from the ATTACHMENT FILENAMES, which are reliably in
 *     convention; numbers found only in the subject/body are still filed, without a PDF.
 *   • Closure emails   — "<date> FMHP re Closure of Notices OMNCN…". Numbers come from the
 *     subject + body list (ranges like OMNCN1111-OMNCN1115 are expanded); effective date
 *     is the "received on <date>" in the body, falling back to the email's received date.
 *   • Backfill         — when a notice/report already exists but has no file attached and
 *     this email carries its PDF, the PDF is added to the existing record.
 *
 * Idempotent. It re-reads a rolling window (INTAKE_LOOKBACK_DAYS, default 14) every run and
 * relies on nc-intake's existing duplicate checks, so there is no watermark to corrupt and
 * re-running is always safe. Widen the window for a catch-up: ?days=120
 *
 * Triggered by Vercel Cron (see vercel.json).
 * Manual:  /api/nc-mail-intake?preview=1&token=<CRON_SECRET>   — parse and report, write NOTHING
 *          /api/nc-mail-intake?token=<CRON_SECRET>    — force a real run
 *          &days=90                                   — widen the lookback
 *          &debug=1                                   — include per-message parse detail
 *
 * Env (required for the Graph read):
 *   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET   — the Azure app registration
 *   GRAPH_MAILBOX          — mailbox to read (default 'TJohnston@mrdc.ca'). The province
 *                            mails Troy personally; point this at a shared mailbox if one
 *                            is ever added to the distribution.
 * Env (already set on this project): AIRTABLE_PAT, NC_BASE_ID, CRON_SECRET.
 * Optional: INTAKE_SENDER_DOMAIN (default 'gnb.ca'), INTAKE_LOOKBACK_DAYS (default 14),
 *   CLOUDINARY_CLOUD (default 'djrqifos6'), CLOUDINARY_PRESET (default 'uzh72cqd'),
 *   RESEND_API_KEY + RESEND_FROM + NC_ADMIN_EMAIL (summary email when something is filed),
 *   NC_TABLE, AUDIT_TABLE.
 *
 * The Azure app registration needs APPLICATION permission Mail.Read with admin consent.
 * Scope it to just this mailbox with an ApplicationAccessPolicy — see the deploy notes in
 * claude/nc-provincial-email-intake.md. Without the policy the app can read every mailbox
 * in the tenant, which is far more access than this needs.
 */
'use strict';

const { importNotices, importAudits, importClosures } = require('./nc-intake.js');

const PAT   = process.env.AIRTABLE_PAT;
const BASE  = process.env.NC_BASE_ID;
const NC_TABLE    = process.env.NC_TABLE    || 'Non Conformances';
const AUDIT_TABLE = process.env.AUDIT_TABLE || 'Audit Reports';
const AT_NC    = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(NC_TABLE)}`;
const AT_AUDIT = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(AUDIT_TABLE)}`;
const HDR   = { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' };

const TENANT = process.env.GRAPH_TENANT_ID;
const CLIENT = process.env.GRAPH_CLIENT_ID;
const CSECRET = process.env.GRAPH_CLIENT_SECRET;
const MAILBOX = process.env.GRAPH_MAILBOX || 'TJohnston@mrdc.ca';
const SENDER_DOMAIN = (process.env.INTAKE_SENDER_DOMAIN || 'gnb.ca').toLowerCase();
const LOOKBACK_DAYS = parseInt(process.env.INTAKE_LOOKBACK_DAYS || '14', 10);

const CLOUD  = process.env.CLOUDINARY_CLOUD  || 'djrqifos6';
const PRESET = process.env.CLOUDINARY_PRESET || 'uzh72cqd';

const RESEND_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'quality@mrdc-htra.com';
const ADMIN_EMAIL = process.env.NC_ADMIN_EMAIL || 'tjohnston@mrdc.ca';
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_PAGES = 6;          // hard stop on Graph paging
const MAX_RANGE = 50;         // hard stop on OMNCN1111-OMNCN1115 style expansion
const today = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s).replace(/'/g, "\\'");

/* ---------------------------------------------------------------- parsing */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// "30 July 2026" / "04 August  26" / "19 May 17" / "2026-08-04" -> ISO, or ''.
// The province's filenames are not consistent about year width or spacing.
function looseDate(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{2,4})$/);
  if (!m) return '';
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mon) return '';
  let year = parseInt(m[3], 10);
  if (year < 100) year += 2000;
  const day = parseInt(m[1], 10);
  if (!(day >= 1 && day <= 31) || year < 2000 || year > 2100) return '';
  return `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&rsquo;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// A notice number (OMNCN1124 / OMDEF0380) or an audit report number (OWFFM0066, VJWFM0155).
const RE_NOTICE = /\bOM(?:NCN|DEF)\d{3,5}\b/gi;
const RE_REPORT = /\b[A-Z]{2,4}FM\d{3,5}\b/gi;

function noticeType(id) { return /^OMDEF/i.test(id) ? 'Defect Notice' : 'NCN'; }

// "OMNCN1124 - 30 July 2026 (Std 706 - Guiderail Deficiencies).pdf" ->
//   { id:'OMNCN1124', date:'2026-07-30', standard:'Std 706 - Guiderail Deficiencies' }
function parseAttachmentName(name) {
  const base = String(name || '').replace(/\.pdf$/i, '').trim();
  const m = base.match(/^([A-Za-z]{2,5}\d{3,6})\s*[-–]\s*(.*)$/);
  if (!m) {
    // Some come through as just the number.
    const bare = base.match(/^([A-Za-z]{2,5}\d{3,6})$/);
    return bare ? { id: bare[1].toUpperCase(), date: '', standard: '' } : null;
  }
  const id = m[1].toUpperCase();
  const rest = m[2];
  const paren = rest.match(/\(([^)]*)\)/);
  let standard = paren ? paren[1].replace(/\s+/g, ' ').trim() : '';
  // "706 - Steel Beam Guide Rail" -> "Std 706 - Steel Beam Guide Rail"
  if (standard && /^\d/.test(standard)) standard = `Std ${standard}`;
  const date = looseDate(rest.replace(/\([^)]*\)/g, ''));
  return { id, date, standard };
}

// Expand "OMNCN1111-OMNCN1115" and "OMNCN1111 - 1115" into the individual numbers.
function expandRanges(text) {
  const out = [];
  const re = /\b(OM(?:NCN|DEF))(\d{3,5})\s*[-–]\s*(?:OM(?:NCN|DEF))?(\d{3,5})\b/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const prefix = m[1].toUpperCase();
    const from = parseInt(m[2], 10), to = parseInt(m[3], 10);
    const width = m[2].length;
    if (to <= from || to - from > MAX_RANGE) continue;
    for (let i = from; i <= to; i++) out.push(prefix + String(i).padStart(width, '0'));
  }
  return out;
}

function uniq(list) {
  const seen = new Set(), out = [];
  for (const v of list) { const k = String(v).toUpperCase(); if (!seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}

function classify(subject) {
  const s = String(subject || '').toLowerCase();
  if (/closure of notice/.test(s)) return 'closure';
  if (/issue of|defect notice|non-conformance notice|audit report/.test(s)) return 'issuance';
  return 'other';
}

/* ------------------------------------------------------------------ graph */

async function graphToken() {
  const body = new URLSearchParams({
    client_id: CLIENT,
    client_secret: CSECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error(`Graph token failed (HTTP ${r.status}): ${j.error_description || j.error || 'no token returned'}`);
  }
  return j.access_token;
}

async function graph(token, url) {
  const r = await fetch(url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && (j.error.message || j.error.code)) || `HTTP ${r.status}`;
    throw new Error(`Graph ${r.status}: ${msg}`);
  }
  return j;
}

// Messages received in the window, newest first, filtered to the province's domain.
// Graph can't filter on a sender's domain, so the window is done server-side and the
// domain match in JS.
async function fetchMessages(token, sinceIso) {
  const select = 'id,subject,receivedDateTime,from,hasAttachments,webLink,body';
  let url = `/users/${encodeURIComponent(MAILBOX)}/messages` +
    `?$filter=${encodeURIComponent(`receivedDateTime ge ${sinceIso}`)}` +
    `&$select=${select}&$top=100&$orderby=receivedDateTime desc`;
  const all = [];
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const j = await graph(token, url);
    for (const m of (j.value || [])) {
      const addr = ((m.from || {}).emailAddress || {}).address || '';
      if (addr.toLowerCase().endsWith(`@${SENDER_DOMAIN}`)) all.push(m);
    }
    url = j['@odata.nextLink'] || '';
  }
  return all;
}

async function listAttachments(token, msgId) {
  const j = await graph(token,
    `/users/${encodeURIComponent(MAILBOX)}/messages/${msgId}/attachments?$select=id,name,contentType,size`);
  return (j.value || []).filter(a => /\.pdf$/i.test(a.name || ''));
}

async function attachmentBytes(token, msgId, attId) {
  const j = await graph(token,
    `/users/${encodeURIComponent(MAILBOX)}/messages/${msgId}/attachments/${attId}`);
  return j.contentBytes || '';
}

/* ------------------------------------------------------------- cloudinary */

// Airtable can only ingest an anonymously fetchable URL — an Outlook attachment has none,
// so the bytes are parked on Cloudinary first and Airtable pulls its own copy from there.
// Cloudinary must have PDF/ZIP delivery ENABLED (Settings -> Security) or the URL 401s and
// Airtable silently stores nothing.
async function toCloudinary(base64, filename, contentType) {
  const form = new FormData();
  form.append('file', `data:${contentType || 'application/pdf'};base64,${base64}`);
  form.append('upload_preset', PRESET);
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD}/auto/upload`, { method: 'POST', body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.secure_url) {
    throw new Error(`Cloudinary upload failed for ${filename} (HTTP ${r.status}): ${(j.error && j.error.message) || 'no URL returned'}`);
  }
  return j.secure_url;
}

/* --------------------------------------------------------------- airtable */

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

// Existing record, no file on it, and we now have the PDF -> attach it.
// This is how the notices filed by hand (and the OWFFM0055-0065 stubs) finally get their
// paperwork, without touching anything else on the record.
async function backfillFile(atUrl, field, key, url, filename) {
  const rec = await findOne(atUrl, field, key);
  if (!rec) return 'not-found';
  const files = rec.fields && rec.fields['Files'];
  if (Array.isArray(files) && files.length) return 'already-has-file';
  const stamp = `[${today()} · Mail intake] Attached ${filename} from the provincial email.`;
  const fields = { 'Files': [{ url, filename }] };
  if (atUrl === AT_NC) {
    const log = rec.fields['Activity Log'] ? `${rec.fields['Activity Log']}\n${stamp}` : stamp;
    fields['Activity Log'] = log;
  }
  await at(`${atUrl}/${rec.id}`, 'PATCH', { fields, typecast: true });
  return 'attached';
}

/* ------------------------------------------------------------ the pipeline */

// Turn one message into { notices, audits, closures } ready for nc-intake.
// PDFs are uploaded only when we are actually going to write (preview skips them).
async function parseMessage(token, msg, { upload }) {
  const kind = classify(msg.subject);
  const text = `${msg.subject || ''}\n${stripHtml((msg.body || {}).content)}`;
  const out = { kind, subject: msg.subject, received: msg.receivedDateTime, notices: [], audits: [], closures: [], files: [], warnings: [] };
  if (kind === 'other') return out;

  const received = String(msg.receivedDateTime || '').slice(0, 10);

  if (kind === 'closure') {
    const eff = looseDate((text.match(/received on\s+(\d{1,2}\s+[A-Za-z]+\.?,?\s+\d{2,4})/i) || [])[1]) || received;
    const numbers = uniq([...(text.match(RE_NOTICE) || []), ...expandRanges(text)]);
    for (const nc of numbers) out.closures.push({ nc, effectiveDate: eff, closureUrl: msg.webLink || '' });
    if (!numbers.length) out.warnings.push('closure email but no notice numbers found');
    return out;
  }

  // Issuance. Attachment filenames are the authoritative source.
  const attachments = msg.hasAttachments ? await listAttachments(token, msg.id) : [];
  const seen = new Set();
  for (const a of attachments) {
    const p = parseAttachmentName(a.name);
    if (!p) { out.warnings.push(`unrecognised attachment name: ${a.name}`); continue; }
    seen.add(p.id);
    let url = '';
    if (upload) {
      try {
        const b64 = await attachmentBytes(token, msg.id, a.id);
        if (b64) url = await toCloudinary(b64, a.name, a.contentType);
      } catch (e) { out.warnings.push(e.message); }
    }
    out.files.push({ id: p.id, name: a.name, url });
    if (/^OM(NCN|DEF)/.test(p.id)) {
      out.notices.push({
        nc: p.id,
        noticeType: noticeType(p.id),
        standard: p.standard,
        dateRaised: p.date || received,
        noticeUrl: msg.webLink || '',
        noticePdf: url || undefined,
      });
    } else {
      out.audits.push({
        report: p.id,
        date: p.date || received,
        standard: p.standard,
        result: 'Compliant',
        notes: `Filed from the provincial email "${msg.subject}" (received ${received}).`,
        reportUrl: msg.webLink || '',
        reportPdf: url || undefined,
      });
    }
  }

  // Numbers named in the subject/body but with no PDF attached — file them anyway so the
  // register is complete; the PDF can be backfilled when it turns up.
  for (const nc of uniq(text.match(RE_NOTICE) || [])) {
    if (seen.has(nc)) continue;
    out.notices.push({
      nc, noticeType: noticeType(nc), dateRaised: received, noticeUrl: msg.webLink || '',
    });
    out.warnings.push(`${nc} named in the email but no matching PDF attached`);
  }
  return out;
}

async function notify(summary, host) {
  if (!RESEND_KEY) return false;
  const link = host ? `<p><a href="https://${host}/">Open the NC tool</a></p>` : '';
  const li = a => a.length ? `<ul>${a.map(x => `<li>${x}</li>`).join('')}</ul>` : '<p style="color:#888">none</p>';
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px">
    <h2 style="color:#8A2D5B">Provincial email intake</h2>
    <p>${summary.messages} email(s) from @${SENDER_DOMAIN} scanned.</p>
    <h4>Notices created</h4>${li(summary.noticesCreated)}
    <h4>Audit reports created</h4>${li(summary.auditsCreated)}
    <h4>Notices closed</h4>${li(summary.closed)}
    <h4>PDFs attached to existing records</h4>${li(summary.backfilled)}
    ${summary.warnings.length ? `<h4 style="color:#b45309">Needs a look</h4>${li(summary.warnings)}` : ''}
    ${link}
    <p style="color:#999;font-size:11px">Automatic intake from the MRDC NC tool.</p></div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [ADMIN_EMAIL], subject: 'Provincial notices filed automatically', html }),
    });
    return r.ok;
  } catch { return false; }
}

module.exports = async (req, res) => {
  if (!PAT || !BASE) { res.status(500).json({ ok: false, error: 'AIRTABLE_PAT and NC_BASE_ID must be set' }); return; }

  const q = req.query || {};
  const isCron = !!req.headers['x-vercel-cron'];
  const token = q.token || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const preview = q.preview === '1' || q.preview === 'true';
  // Compare trimmed: a Vercel env value pasted with a trailing newline is invisible in the
  // dashboard (and unreadable once marked Sensitive) but breaks an exact ===. This project has
  // already lost an afternoon to stray whitespace in env values once.
  // Fails CLOSED: if CRON_SECRET is missing entirely, deny rather than run. This endpoint writes,
  // so an unset variable must not leave it open. Vercel Cron still gets in via x-vercel-cron.
  const expected = String(CRON_SECRET || '').trim();
  if (!isCron && (!expected || String(token).trim() !== expected)) {
    res.status(401).json({
      ok: false,
      error: 'unauthorized',
      hint: CRON_SECRET
        ? 'token did not match CRON_SECRET (compared with surrounding whitespace ignored)'
        : 'CRON_SECRET is not set on this deployment, so manual runs are refused',
    });
    return;
  }
  if (!TENANT || !CLIENT || !CSECRET) {
    res.status(500).json({
      ok: false,
      error: 'GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET must be set — see the Azure app registration steps in the NC intake notes.',
    });
    return;
  }

  const days = Math.min(Math.max(parseInt(q.days || LOOKBACK_DAYS, 10) || LOOKBACK_DAYS, 1), 400);
  const since = new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');

  try {
    const gt = await graphToken();
    const messages = await fetchMessages(gt, since);

    const parsed = [];
    for (const m of messages) parsed.push(await parseMessage(gt, m, { upload: !preview }));

    const notices  = parsed.flatMap(p => p.notices);
    const audits   = parsed.flatMap(p => p.audits);
    const closures = parsed.flatMap(p => p.closures);
    const warnings = parsed.flatMap(p => p.warnings);

    if (preview) {
      res.status(200).json({
        ok: true, preview: true, mailbox: MAILBOX, since, days,
        messages: messages.length,
        would: { notices, audits, closures },
        warnings,
        detail: q.debug ? parsed : undefined,
      });
      return;
    }

    const nRes = notices.length  ? await importNotices(notices)   : { created: [], skipped: [], errors: [] };
    const aRes = audits.length   ? await importAudits(audits)     : { created: [], skipped: [], errors: [] };
    const cRes = closures.length ? await importClosures(closures) : { closed: [], skipped: [], notFound: [], errors: [] };

    // Anything skipped as a duplicate may still be missing its PDF — attach it now.
    const backfilled = [];
    for (const p of parsed) {
      for (const f of p.files) {
        if (!f.url) continue;
        const isNotice = /^OM(NCN|DEF)/.test(f.id);
        const wasCreated = isNotice
          ? nRes.created.some(c => c.nc === f.id)
          : aRes.created.some(c => c.report === f.id);
        if (wasCreated) continue;
        try {
          const r = await backfillFile(isNotice ? AT_NC : AT_AUDIT, isNotice ? 'NC #' : 'Report #', f.id, f.url, f.name);
          if (r === 'attached') backfilled.push(`${f.id} — ${f.name}`);
        } catch (e) { warnings.push(`backfill ${f.id}: ${e.message}`); }
      }
    }

    const summary = {
      messages: messages.length,
      noticesCreated: nRes.created.map(c => c.nc),
      auditsCreated: aRes.created.map(c => c.report),
      closed: cRes.closed,
      backfilled,
      warnings: warnings.concat(
        nRes.errors.map(e => `notice ${e.key}: ${e.error}`),
        aRes.errors.map(e => `audit ${e.key}: ${e.error}`),
        cRes.errors.map(e => `closure ${e.key}: ${e.error}`),
        cRes.notFound.map(n => `closure for ${n} — no matching NC in the register`),
      ),
    };

    const didSomething = summary.noticesCreated.length || summary.auditsCreated.length ||
      summary.closed.length || summary.backfilled.length;
    let emailed = false;
    if (didSomething) emailed = await notify(summary, req.headers['x-forwarded-host'] || req.headers.host);

    const ok = !nRes.errors.length && !aRes.errors.length && !cRes.errors.length;
    res.status(200).json({
      ok, mailbox: MAILBOX, since, days, messages: messages.length,
      notices: nRes, audits: aRes, closures: cRes, backfilled, warnings: summary.warnings, emailed,
      detail: q.debug ? parsed : undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
