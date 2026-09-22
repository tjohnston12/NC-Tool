/*
 * test-cors-cache.js — the CORS + caching contract of /api/ncs
 * ---------------------------------------------------------------------------
 * Run:  node _tests/test-cors-cache.js          (from NC Tool)
 * No network, no Airtable, no dependencies. applyCors() and cacheFor() are
 * lifted out of the shipped source and run against a stub res.
 *
 * ⚠️ WHY THIS EXISTS. Access-Control-Allow-Origin here is REFLECTED — it names
 * ONE caller, so the same URL has a different correct answer for each of them.
 * Vary: Origin is what keeps those apart, and a browser honours it. A shared
 * cache in front of the function need not, and Vercel's edge does not.
 *
 * Found in production 2026-09-22 on the assets API: the patrol form could not
 * load the asset register at all — "Failed to fetch", and every deficiency row
 * reading "the asset register has not loaded", which looks like no signal. The
 * DMT had warmed the edge cache from its own origin moments before.
 * claude/asset-id-picker.md has the reproduction.
 *
 * ⚠️ THIS API IS MORE EXPOSED THAN MOST. The NC front-end sits at
 * www.mrdc-htra.com/nc/ while the API stays on nc.mrdc-htra.com, so EVERY
 * browser call here is cross-origin and the reflected header is what gets
 * cached. It works today only because www is the one origin that asks;
 * ?managers=1 was s-maxage=3600, so a second origin would have been wrong for
 * an hour at a time. */
'use strict';
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', "api/ncs.js"), 'utf8');

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, x) => { if (c) pass++; else { fail++; failures.push(n + (x ? ' — ' + x : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w),
                           `got ${JSON.stringify(g)} want ${JSON.stringify(w)}`);

const cors = (SRC.match(/const ORIGIN_OK = [^\n]*\n+function applyCors\(req, res\) \{[\s\S]*?\n\}/) || [''])[0];
ok('applyCors() and its origin pattern can be lifted', !!cors);
const cf = (SRC.match(/function cacheFor\(res, age, swr\) \{[\s\S]*?\n\}/) || [''])[0];
ok('cacheFor() can be lifted too', !!cf);

function stub(origin, tail) {
  const h = {};
  const res = { setHeader: (k, v) => { h[k] = v; }, getHeader: k => h[k] };
  const req = { headers: origin === undefined ? {} : { origin } };
  new Function('req', 'res', cors + '\n' + cf + '\napplyCors(req, res);' + (tail || ''))(req, res);
  return h;
}
{
  const www = stub('https://www.mrdc-htra.com');
  const dmt = stub('https://dmt.mrdc-htra.com');
  eq('the platform\'s web origin is allowed',
     www['Access-Control-Allow-Origin'], 'https://www.mrdc-htra.com');
  eq('and any other of its subdomains',
     dmt['Access-Control-Allow-Origin'], 'https://dmt.mrdc-htra.com');
  /* ⚠️ THE PROBLEM IN ONE ASSERTION: one URL, two different correct answers. */
  ok('the two answers differ, which is what makes a shared copy unsafe',
     www['Access-Control-Allow-Origin'] !== dmt['Access-Control-Allow-Origin']);
  eq('every response says it varies by origin', www['Vary'], 'Origin');
  eq('including one with no origin at all', stub()['Vary'], 'Origin');
  ok('a caller with no Origin gets no Allow-Origin',
     !('Access-Control-Allow-Origin' in stub()), JSON.stringify(stub()));
  ok('a look-alike domain is not allowed',
     !('Access-Control-Allow-Origin' in stub('https://mrdc-htra.com.evil.example')));
  ok('and neither is plain http',
     !('Access-Control-Allow-Origin' in stub('http://www.mrdc-htra.com')));
  eq('a Vercel preview is',
     stub('https://x-abc123.vercel.app')['Access-Control-Allow-Origin'],
     'https://x-abc123.vercel.app');
}
{
  /* Nothing reflected — a server-to-server caller — gets the same response as
     everybody else, so the shared cache is kept. This is the fast path. */
  const anon = stub(undefined, '\ncacheFor(res, 3600, 86400);');
  ok('a caller with no Origin reflects nothing',
     !('Access-Control-Allow-Origin' in anon), JSON.stringify(anon));
  eq('so its response may still be shared, at the interval it asked for',
     anon['Cache-Control'], 's-maxage=3600, stale-while-revalidate=86400');

  /* ⚠️ A named caller. Its response is wrong for anybody else. */
  const named = stub('https://www.mrdc-htra.com', '\ncacheFor(res, 3600, 86400);');
  eq('a named caller is named in the response',
     named['Access-Control-Allow-Origin'], 'https://www.mrdc-htra.com');
  /* ⚠️ Kept by NOBODY, not merely "private". "private" stops the edge sharing
     it, and then the browser's own cache does the same thing — one entry per
     URL, handed to the next origin that asks. Measured on the assets API on
     2026-09-22, after the "private" deploy. */
  eq('and its response is stored by nobody', named['Cache-Control'], 'no-store');
  ok('no cache directive of any kind survives on it',
     !/s-maxage|public|private|max-age=[1-9]/.test(named['Cache-Control']), named['Cache-Control']);

  const stats = stub('https://www.mrdc-htra.com', '\ncacheFor(res, 300, 600);');
  eq('the stats branch is treated no differently', stats['Cache-Control'], 'no-store');
}
{
  /* The rule reads the header that was actually SET, so it cannot drift out of
     step with applyCors's own allow-list. */
  ok('cacheFor reads the header rather than re-deciding the origin',
     /res\.getHeader\('Access-Control-Allow-Origin'\)/.test(SRC));
  ok('the managers list goes through it', /qs\.managers === '1'[\s\S]{0,200}cacheFor\(res, 3600, 86400\);/.test(SRC));
  ok('and so do the stats', /qs\.stats === '1'[\s\S]{0,200}cacheFor\(res, 300, 600\);/.test(SRC));
  ok('no Cache-Control anywhere still hard-codes a shared cache',
     !/setHeader\('Cache-Control', *'(public|s-maxage)/.test(SRC),
     (SRC.match(/setHeader\('Cache-Control', *'(public|s-maxage)[^)]*\)/) || [])[0]);
  /* The audit list and the NC list stay live — a cached list is a closed NC
     that still looks open. */
  ok('the audit list is still never cached',
     /qs\.audits === '1'[\s\S]{0,120}'no-store'/.test(SRC));
}
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { failures.forEach(f => console.log('   FAIL  ' + f)); process.exitCode = 1; }
