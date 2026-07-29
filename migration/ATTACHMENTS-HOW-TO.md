# Attachment recovery — how to run

The migration brought every record across but not the ~8,400 attached files.
Airtable's file URLs expire a couple of hours after they're issued, and the
ones captured from the old base went dead before the export finished. Nothing
is lost: the files are still in the old base, and every affected record here
carries a line like `Attachments to re-import (4): Notice.pdf, …` in its
Activity Log (non-conformances) or Notes (audit reports).

The fix is a **synced table**, not another export. A sync copies the files
themselves into this base, so there is no URL to expire mid-run.

## Step 1 — sync the three legacy tables into MRDC-HTRA-NC

In **MRDC-HTRA-NC** (`app9l8ZM0GO46ito2`), three times over:

**Add a table → Sync data → Airtable → base `NBHC…` (`appAKFzMSPbYl3FJ9`)**, then
pick the table:

| legacy table | feeds |
|---|---|
| `NBHC NCN & DEF Reports` | Non Conformances |
| `NBHC Audit Reports` | Audit Reports (provincial) |
| `Internal Audit Results` | Audit Reports (internal) + the 18 re-filed notices |

When it asks which fields to sync, take **all of them** — the script needs the
record number (the first column) and every attachment column. Set the sync to
manual/one-time; there's no need to keep it live.

Whatever names Airtable gives the synced tables is fine. The script finds them
by shape: a table qualifies if it has at least one attachment column and at
least half its record numbers match a live record.

## Step 2 — run the script

**Extensions → Scripting → paste `copy-attachments-from-sync.js` → Run.**

It reads every attachment column on each synced record — for non-conformances
that's `Notice`, `Joint Field Audit`, `Internal Response Sheets`,
`MRDC > NBHC`, `NBHC > MRDC` and `Work Sheets / Photos` — matches the record to
a live Non Conformance or Audit Report by its number, and drops all of its
files into that record's **Files** field.

It also rewrites the `Attachments to re-import (n): …` line to
`Attachments restored n file(s) on <date> — from Notice (2), NBHC > MRDC (1)`,
so the provenance of each file survives even though they all land in one field.

Expect it to run for a while — roughly 1,800 records and 8,400 files, written
ten records at a time with progress printed as it goes.

**Safe to re-run.** A record that already has files is skipped, so a run that
times out just resumes where it stopped. Nothing is deleted and existing files
are kept.

## Step 3 — check and clean up

Spot-check a handful of records against the file names listed in the Activity
Log. Then delete the three synced tables, and the three `Imported table`
staging tables left over from the data migration.

## Two knobs at the top of the script

`PREFIX_FILENAMES` (default `false`) — set `true` to rename each file to
`[Notice] original.pdf` so the source column is visible in the file name
itself. Useful if telling `MRDC > NBHC` correspondence from `NBHC > MRDC`
matters more than clean file names.

`CLEAN_NOTES` (default `true`) — set `false` to leave the original
`Attachments to re-import` line untouched.

## If it reports unmatched rows

The script prints any synced row that carries files but has no live record to
attach them to, with the record number. That should be zero or close to it —
if it's a large number, the record numbers didn't survive the migration the way
we expect and it's worth stopping to look before going further.
