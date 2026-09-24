/*
 * api/_when.js — what day is it, in the only time zone this contract cares about.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * These functions run on Vercel, which runs on UTC. Until this file existed, a
 * calendar date was taken straight off the clock:
 *
 *     new Date().toISOString().slice(0, 10)      // ← the UTC date
 *
 * New Brunswick is UTC−3 in summer and UTC−4 in winter, so between 9 p.m. and
 * midnight Atlantic (8 p.m. in winter) that expression returns TOMORROW. A work
 * order closed at half past nine on the 21st was stamped the 22nd, and the date
 * on the paper the crew signed no longer matched the date in the record.
 *
 * Nothing in the field notices this, because nothing is broken at 2 p.m. It
 * shows up weeks later, in a reconciliation, as a record that disagrees with a
 * signature — and by then nobody can say which one is right.
 *
 * ⚠️ FOR CALENDAR DATES ONLY. An instant — 'Submitted At', 'Set At', anything
 * that records WHEN something happened rather than WHICH DAY it belongs to —
 * must stay a full ISO timestamp in UTC. Those are unambiguous and already
 * correct; converting them would be the same mistake in the other direction.
 *
 * ⚠️ Zone, not offset. 'America/Moncton' is New Brunswick's own zone and carries
 * the AST/ADT switch with it. A hard-coded −3 or −4 is right for half the year.
 *
 * ⚠️ This file is COPIED into each API repo rather than shared. These are
 * zero-dependency Vercel projects with no package between them, so a change
 * here has to be made in every repo that carries it. Its own suite in each
 * repo is what catches a copy that drifted.
 */

// Overridable so a test can pin a zone, and so this is one edit if the
// contract ever covers another province. It is never read from a request.
const TZ = process.env.APP_TIME_ZONE || 'America/Moncton';

/* formatToParts, not format(). A locale's short date is a convention, not a
 * guarantee — 'en-CA' gives YYYY-MM-DD on every runtime we use, but reading the
 * parts by name cannot be wrong, and this decides what date goes on a record. */
function partsIn(d, opts) {
  const out = {};
  for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, ...opts }).formatToParts(d)) {
    out[p.type] = p.value;
  }
  return out;
}

/* YYYY-MM-DD for the given instant, as the date reads in New Brunswick. */
function todayAtlantic(d = new Date()) {
  const p = partsIn(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/* 'YYYY-MM-DD HH:MM' for the Activity Log — the format the log has always used,
 * now showing the time people were actually standing there. */
function stampAtlantic(d = new Date()) {
  const p = partsIn(d, { year: 'numeric', month: '2-digit', day: '2-digit',
                         hour: '2-digit', minute: '2-digit',
                         hour12: false, hourCycle: 'h23' });
  return `${p.year}-${p.month}-${p.day} ${normalizeHour(p.hour)}:${p.minute}`;
}

/* Midnight is '00'. Depending on the ICU build, an hour-cycle of h24 renders it
 * as '24' — which would put '2026-09-25 24:00' in the Activity Log, an hour
 * that does not exist, on the wrong day. h23 is requested above; this is the
 * belt to that pair of braces, and it is exported so it can be tested on a
 * runtime where the formatter never produces the value it guards against. */
function normalizeHour(hour) { return hour === '24' ? '00' : hour; }

/* The year as it reads in New Brunswick — for anything numbered by year, which
 * must not roll over three hours early on 31 December. */
function yearAtlantic(d = new Date()) {
  return Number(partsIn(d, { year: 'numeric' }).year);
}

/* N days before today, as a calendar date.
 *
 * ⚠️ Counts back from the ATLANTIC day, then does the arithmetic on the date
 * string at UTC midnight — which is safe, because by that point there is no
 * time of day left to lose. The old version subtracted days from the UTC
 * instant, so in the evening it was counting back from tomorrow: "audit files
 * received in the last 7 days" quietly meant eight.
 */
function daysAgoAtlantic(n, d = new Date()) {
  const base = new Date(`${todayAtlantic(d)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() - n);
  return base.toISOString().slice(0, 10);
}

module.exports = { TZ, todayAtlantic, stampAtlantic, yearAtlantic, normalizeHour, daysAgoAtlantic };
