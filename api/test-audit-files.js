// test-audit-files.js — what the Monday reminder chases, and what it leaves alone.
// Stubs fetch so the real module logic runs against known rows.  node test-audit-files.js
const path = require('path');
process.env.AIRTABLE_PAT='x'; process.env.NC_BASE_ID='appTEST';

const D = n => { const d=new Date(); d.setUTCDate(d.getUTCDate()-n); return d.toISOString().slice(0,10); };
const AUDITS = [
  { id:'a1','Report #':'OWFFM0065', Date:D(30), Source:'Provincial Audit', Division:'Western' },      // recent
  { id:'a2','Report #':'OWFFM0064', Date:D(37), Source:'Provincial Audit', Division:'Western' },      // recent
  { id:'a3','Report #':'OWFFM0012', Date:'2019-04-02', Source:'Provincial Audit', Division:'Eastern'},// old BUT provincial
  { id:'a4','Report #':'IA-2021-04', Date:'2021-06-01', Source:'Internal Audit' },                    // old internal
  { id:'a5','Report #':'IA-undated', Source:'Internal Audit' },                                       // no date at all
  { id:'a6','Report #':'HAS-FILE',  Date:D(5), Source:'Provincial Audit', Files:[{url:'u'}] },        // has a file
  { id:'a7','Report #':'EMPTY-ARR', Date:D(5), Source:'Internal Audit', Files:[] },                   // empty array
];
const NCS = [
  { id:'n1','NC #':'OMNCN1128','Notice Type':'NCN', 'Date Raised':D(28), Status:'Corrective Action' },// open+recent
  { id:'n2','NC #':'OMDEF0358','Notice Type':'Defect Notice','Date Raised':'2021-11-15', Status:'Corrective Action' }, // open, old
  { id:'n3','NC #':'OMDEF0359','Notice Type':'Defect Notice','Date Raised':'2021-11-15', Status:'Closed' },            // closed, old
  { id:'n4','NC #':'OMNCN1131','Notice Type':'NCN', 'Date Raised':D(10), Status:'Closed' },           // closed but recent
  { id:'n5','NC #':'NC-2025-17','Notice Type':'Internal NC','Date Raised':D(3), Status:'New' },       // internal - excluded
  { id:'n6','NC #':'OMNCN0500','Notice Type':'NCN', 'Date Raised':'2016-11-28', Status:'Closed', Files:[{url:'u'}] },  // has file
];
// ⚠️ The stub HONOURS fields[] exactly as Airtable does: a field you did not ask for
// is not in the response. The first version of this stub returned every fixture field
// regardless, which let a real bug through — nc-audit-files.js was not requesting
// `Files`, so live every row read as "no file" and the first email listed 512 audit
// reports. A stub more generous than the API it stands in for tests nothing.
global.fetch = async (url) => {
  const want = [...new URL('https://x/?' + String(url).split('?')[1]).searchParams.getAll('fields[]')];
  const src = /Audit%20Reports|Audit Reports/.test(url) ? AUDITS : NCS;
  return { ok:true, json: async () => ({ records: src.map(r => {
    const { id, ...f } = r;
    const kept = {};
    for (const k of Object.keys(f)) if (!want.length || want.includes(k)) kept[k] = f[k];
    return { id, fields: kept };
  }) }) };
};

const m = require(path.join(__dirname,'nc-audit-files.js'));
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log('  FAIL '+n+(x?'  → '+x:'')); } };

(async () => {
  const d = await m.missingAuditFiles();
  const ids = l => l.map(r => r['Report #'] || r['NC #']).sort().join(',');

  console.log('\nAudit reports to chase:', ids(d.auditNow));
  ok('recent provincial audits are chased', ids(d.auditNow).includes('OWFFM0064') && ids(d.auditNow).includes('OWFFM0065'));
  ok('an OLD provincial audit is still chased — it is a contract record',
     ids(d.auditNow).includes('OWFFM0012'));
  ok('an old INTERNAL audit is backlog, not a weekly nag', !ids(d.auditNow).includes('IA-2021-04'));
  ok('an undated internal audit is backlog', !ids(d.auditNow).includes('IA-undated'));
  ok('an audit WITH a file is never listed', !ids(d.auditNow).includes('HAS-FILE'));
  // The bug this catches: an attachment field is ABSENT when empty, but Airtable can
  // also return []. Treating only one as "missing" silently halves the list.
  ok('Files:[] counts as missing, same as an absent field', ids(d.auditNow).includes('EMPTY-ARR') || d.auditBacklog >= 1,
     'EMPTY-ARR went nowhere');
  ok('EMPTY-ARR is chased (recent)', ids(d.auditNow).includes('EMPTY-ARR'), ids(d.auditNow));

  console.log('Notices to chase:', ids(d.ncNow));
  ok('an OPEN notice with no file is chased', ids(d.ncNow).includes('OMNCN1128') && ids(d.ncNow).includes('OMDEF0358'));
  ok('a CLOSED old notice is backlog', !ids(d.ncNow).includes('OMDEF0359'));
  ok('a closed but RECENT notice is still chased', ids(d.ncNow).includes('OMNCN1131'));
  ok('Internal NCs are excluded — the ask was audits and provincial notices',
     !ids(d.ncNow).includes('NC-2025-17'));
  ok('a notice WITH a file is never listed', !ids(d.ncNow).includes('OMNCN0500'));

  console.log('backlog: audits', d.auditBacklog, '· notices', d.ncBacklog, '· undated', d.auditUndated);
  ok('backlog counted, not listed', d.auditBacklog === 2 && d.ncBacklog === 1, `${d.auditBacklog}/${d.ncBacklog}`);
  ok('undated audits counted', d.auditUndated === 1);

  // The regression: if `Files` is not REQUESTED, every row looks empty. With the stub
  // honouring fields[], asking for the wrong columns makes these counts explode.
  ok('not everything is reported missing — Files is actually requested',
     d.auditNow.length + d.auditBacklog < AUDITS.length, `${d.auditNow.length}+${d.auditBacklog} of ${AUDITS.length}`);
  ok('the row that HAS a file is excluded from every bucket',
     d.totalAuditsMissing === AUDITS.length - 1, `${d.totalAuditsMissing} of ${AUDITS.length}`);
  ok('same on the notices side', d.totalNcsMissing === 4, String(d.totalNcsMissing));

  const html = m.buildHtml(d);
  ok('the email names the chased rows', html.includes('OWFFM0065') && html.includes('OMNCN1128'));
  ok('the email does NOT list the backlog', !html.includes('IA-2021-04'));
  ok('the email states the backlog as a count', /Older backlog, not listed/.test(html));
  require('fs').writeFileSync('audit-file-email.html', html);

  // nothing outstanding -> no email at all
  global.fetch = async () => ({ ok:true, json: async () => ({ records: [] }) });
  delete require.cache[require.resolve(path.join(__dirname,'nc-audit-files.js'))];
  const m2 = require(path.join(__dirname,'nc-audit-files.js'));
  const quiet = await m2.sendReminder();
  ok('a quiet week sends nothing', quiet.sent === false && quiet.reason === 'nothing outstanding', JSON.stringify(quiet));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
