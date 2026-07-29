# NC Data Migration — project state

## Migration status — complete

The NBHC → NC migration is finished and spot-checked clean.

- **927 of 1,149** non-conformances now carry files.
- **647 of 692** audit reports now carry files.
- **Zero** records anywhere still have an unfulfilled "Attachments to re-import"
  line — the script rewrote every one into a restored-on stamp with the source
  column preserved. Records without files never had attachments in the old base.
- Spot checks: `OMNCN0532` got its six files; `2026-NC-12` got all thirteen
  photos plus the spreadsheet; `2026-DEF-01` got two files from two different
  columns.
- The copied attachments have their own new attachment IDs, so deleting the
  synced tables will not touch them.

## Open items — pick up here

### Done — 2026-07-28

1. ~~**Internal-vs-provincial summary split**~~ — Built into the NC Tool web page
   (`NC Tool/public/index.html`). **Provincial NCs** and **Internal NCs** tiles
   (total + open each), split strictly by Source = `Provincial Audit` vs
   `Internal Audit`; other sources counted in neither. Tiles click through to a
   filtered table view. Backed by `provincial` / `internal` counts in the
   `?stats=1` aggregator (`NC Tool/api/ncs.js`). **Deployed.** Airtable Division
   choice `Corporate` → `Head Office` rename **done** (choice ID preserved, all
   45 records carried over, no duplicate).
2. ~~**Delete the three synced tables.**~~ — Removed. Base now holds only
   `Non Conformances` and `Audit Reports`.
3. ~~**Delete the three staging tables.**~~ — Removed.
4. ~~**Clear out the dead migration scripts.**~~ — Removed from
   `NC Tool/migration` (only the how-to docs and import CSVs remain).
5. ~~**OMM Standard filter + counts**~~ (new) — Added to the NC Tool page: an
   "Any OMM standard" dropdown (37 OMM standards each with live count, plus an
   "Other / non-OMM" bucket) and a "By OMM standard" counts card. Backed by a
   `byStandard` aggregate + `standard` filter param in `api/ncs.js`; multi-standard
   rows handled via top-level comma split. **Deploy pending.**
6. ~~**Respond feature (checklist + uploads)**~~ — New Respond section on the NC
   detail: response checklist (Non-Conformance Corrected · Risk Analysis Performed
   · Reviewed to prevent re-occurrence · Reviewed by General Manager · Response
   Sheet Completed) plus Cloudinary upload of response sheets / repair photos
   (cloud `djrqifos6`, preset `uzh72cqd`, same as the safety forms). Gated so the
   assigned Responsible Person (matched by login name) can edit their own NC's
   response even without Manager rights; others read-only. Four new Airtable
   fields added on `Non Conformances`: **Priority** (single-select), **Reviewers**,
   **Response Checklist** (JSON), **Response Files** (Cloudinary URLs). Troy
   populates Priority / Responsible Person / Reviewers on the open notices
   manually; the response content fills through the tool. New **Ready for Review**
   status: managers and the assigned responder can move an NC there (responders
   via a "Mark ready for review" button in the Respond section); **only an Admin
   (NC Role = Admin) can set Closed / Cancelled** — so keep Admin limited to Troy.
   The status choice auto-creates in Airtable on first use (typecast). **Deploy
   pending.**
7. ~~**Assignment email notifier**~~ — `api/ncs.js` emails via Resend when a
   Responsible Person is set/changed ("respond") or a Reviewer is added
   ("review") — newly-added names only, so edits don't re-spam. Fires on in-app
   assignment (create/PATCH); direct Airtable edits (the bulk populate) send
   nothing. Name→email from the Employees base; email links back to the NC.
   In-app **Priority + Reviewers editors** added to the detail so both can be
   assigned in the tool. **Deploy pending.**
8. ~~**Weekly open-NC digest**~~ — `api/nc-digest.js` + `vercel.json` cron.
   Open NCs grouped by Responsible Person, sorted by priority, overdue flagged,
   Unassigned last. Cron `0 11 * * 1` = Mon 08:00 Halifax (ADT); UTC-only, so in
   winter (AST) change to `0 12 * * 1` to keep 08:00. Recipients = everyone
   assigned an open NC (Responsible Person -> email) **plus** anyone toggled
   **NC Weekly Digest** in the Employees `Email Subscriptions` field (managed in
   the access & roles app; option added, Troy subscribed) **plus** any extra
   addresses in `NC_DIGEST_TO`, deduped. Preview without sending at
   `/api/nc-digest?preview=1`. **Deploy pending.**

### Deploy / config to-do (NC Tool Vercel project)

- **Push** `api/ncs.js`, `api/nc-digest.js`, `public/index.html`, `vercel.json`.
- **Env vars:** `RESEND_API_KEY` (required for any email), `RESEND_FROM`
  (optional, default `quality@mrdc-htra.com` — must be a verified Resend sender),
  `NC_DIGEST_TO` (optional extra CC addresses — key people are normally chosen
  via the **NC Weekly Digest** subscription in the access & roles app, and
  assigned users are added automatically), `CRON_SECRET` (optional, guards the
  digest endpoint). `EMPLOYEES_BASE` defaults to `appraSoUXoTbhroG6`.
- Airtable fields (Priority / Reviewers / Response Checklist / Response Files)
  are **already live** in the base.

### Still open

9. **Email/fax auto-intake** — Audit reports arrive by email/fax; automate intake
   into the `Audit Reports` table (parse sender/report #, attach the file, set
   source/date/result).
