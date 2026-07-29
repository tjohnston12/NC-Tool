# NBHC → MRDC-HTRA-NC migration — how to run

**Ignore / delete the five old scripts** (`1-non-conformances-part1/2/3.js`,
`2-audit-reports-provincial.js`, `3-audit-reports-internal.js`). Airtable's
script editor caps how long a script can be, and those had the data baked into
the code. This replaces them: the data comes in as *data*, the script stays tiny.

Everything happens in the NEW base, **MRDC-HTRA-NC** (`app9l8ZM0GO46ito2`).

## Step 1 — import the three CSVs as staging tables

In MRDC-HTRA-NC, for each file: **Add a table → Import data → CSV file**.

| file | rows | becomes table |
|---|---|---|
| `nc-import.csv` | 1131 | `nc-import` |
| `audit-reports-provincial-import.csv` | 496 | `audit-reports-provincial-import` |
| `audit-reports-internal-import.csv` | 214 | `audit-reports-internal-import` |

Accept whatever table name Airtable suggests — the script matches on the file
name and a couple of variants. Let every column import as plain text; the
script converts dates and select options itself. Don't rename the columns.

## Step 2 — run the loader

**Extensions → Scripting → paste `load-from-staging.js` → Run.**

It will:

1. add the select options that are missing today — `Internal Audit` on Source,
   `Safety / Projects` and `Fleet` on Division;
2. read the NC # / Report # already live and skip those (156 non-conformances
   are already in from the partial run on 27 Jul);
3. create the rest in batches of 50, printing progress.

Safe to re-run. It never edits or deletes an existing record — a run that dies
partway just resumes where it stopped.

Expected when it finishes: **1131** non-conformances, **710** audit reports
(496 provincial + 214 internal).

## Step 3 — delete the staging tables

Once the counts look right, delete `nc-import`,
`audit-reports-provincial-import` and `audit-reports-internal-import`.

## Note on attachments

The ~8,400 attached files are **not** in this import. Airtable's file URLs
expire, and the ones captured from the old base went dead at 20:00 UTC on
27 Jul, a few hours before the export finished. Nothing is lost — the files are
still in the old base. Each record's Activity Log / Notes lists the file names
that belong to it, e.g. `Attachments to re-import (4): Notice.pdf, …`.

Recovering them is a separate pass: create a **synced table** in MRDC-HTRA-NC
pointing at the old NBHC tables (sync carries attachments natively and can't
time out mid-run), then a short script copies the attachment cells across by
NC # / Report #. Say the word and I'll build that.
