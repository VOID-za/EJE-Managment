# Real-world reviewer feedback — requirements matrix (28 October 2026)

Branch `claude/office-workflow-parts`. First implementation `b4c7bad`,
`694f526`, `e5e7ca4`; the owner's follow-up decisions in `7499768`; on
29 October 2026 the correction of a sent timesheet (TS-16), migration 0039,
the rollback-compatibility proof against the live release and the tablet
preview/print/download checks — and, on the owner's instruction of that day,
the release (see "Release" at the end). Statuses use the project's terms:
nothing is DONE or approved without the owner; *TESTED — awaiting approval*
means automated tests ran and passed, not that staff have tried it on the
device.

The term is **PDF Layout** throughout (not "PDF Log-out"), and **Parts** (not
"Ports").

## Corrections to the first report

- **There is no Hm column.** The first report listed "Date / Customer / OT / DT /
  Callout / Km / Hm" and printed an empty Hm column. That was a mistake in the
  summary, not a requested field. The correct columns are exactly **Date,
  Customer, OT, D/T, Callout, Int Km, Cust Km**.
- **The timesheet period is From/To, not a calendar month.** The first
  implementation tied the comment, Preview, Print and Send to office to a month.
  The owner's requirement is a period chosen by its From and To dates.
- **The tablet preview finding is unconfirmed.** It was reproduced in a browser
  with no PDF viewer (the button downloaded silently); whether that is what the
  reviewer saw has not been confirmed by staff or the reviewer.

## Audit — what existed before the reviewer's feedback (at `50c1809`)

| ID | Requested | Existing implementation (files) | Status found |
|---|---|---|---|
| ATT-01 | Absence reason: Leave, Sick Leave, Family Responsibility, IOD (Injury on Duty) | `attendance` had `status` and a free-text `note` (`src/application/attendance-operations.ts`, `/api/attendance`, `MyAttendance.tsx`, `attendance/page.tsx`) | **Missing** |
| ATT-02 | Technicians record/view only their own attendance | `assertMayRecordFor`; register needs `attendance.manage`; `/api/attendance/mine` reads the session's own | **Compliant** |
| TS-01 | Own timesheet only, server too | `assertMayRead` / `assertOwner` (`src/application/timesheets.ts`) | **Compliant** |
| TS-02, TS-03, TS-14 | Send to office: recorded, locked, office reads read-only, no bypass, no duplicates, audited | — | **Missing** |
| TS-04 | From/To filters, From first, invalid range refused, ascending, reset on revisit without losing data | From/To existed; list newest first; From > To reached the server | **Partial / defective** |
| TS-05 | Day of week beside dates | — | **Missing** |
| TS-06 | Workshop as a choice | customer list or typed name only | **Missing** |
| TS-07 | NT removed from new entry; OT and D/T kept | NT, OT, DBL T all entered | **Missing** |
| TS-08 | Callout as a rand amount; shared call-outs | a whole-number COUNT | **Defective** |
| TS-09 | Int Km and Cust Km | none | **Missing** |
| TS-10 | One comment per timesheet | one per DAY (`timesheet_comments`) | **Defective** |
| TS-11/12/13 | Preview, Save, Print | lines saved one by one; CSV export only | **Missing / partial** |
| PDF-01…04 | Timesheet PDF Layout: Time Sheet, Technician Name, period, Date / Customer / OT / D/T / Callout / Int Km / Cust Km, Comments box | — | **Missing** |
| TR-01 | No part changes after completion | parts editable in `completion` and `customer_signature` | **Defective** |
| TR-02 | Test & Repair preview works | see "TR-02 — what was found" | investigated |
| TR-03 | Part number and description on the PDF Layout | printed in the charges table | **Compliant** |
| TR-04 | Completed job card generated and printed; courier copies | a courier collection made the job card itself price-less | **Partial** |
| PARTS-01 | Order number optional on Parts | required | **Defective** |
| PARTS-02 | Optional Quote Number on Parts | `quote_number` (0028), Test & Repair only | **Missing** for Parts |
| PARTS-03/04/05 | Courier: priced job card AND separate delivery note | one price-less document instead of the job card | **Defective** |

## Audit of the first implementation (`b4c7bad` … `e5e7ca4`) against the owner's decisions

| Decision | What `e5e7ca4` did | Gap |
|---|---|---|
| Columns exactly Date, Customer, OT, D/T, Callout, Int Km, Cust Km | Date, Customer, OT, DT, Callout, one "Km (int / cust)" column, and an empty Hm column | Hm must go; Km split into Int Km and Cust Km; DT shown as D/T |
| Period chosen by From/To | Month-based (`timesheet_months`, routes `…/months/[month]`, a month selector) | Period model, routes, page, PDF heading |
| Office notified on Send to office | Not notified (it was an open question) | Use the existing notifications |
| Shared call-out split by hand | Amount per line, Shared flag, nothing divided | Compliant — regression tests added |
| Courier: Delivery Note shown and signed once; same signature on the priced job card; both documents persisted | Priced job card + an on-demand Delivery Note; the courier signed on the tablet without being shown the Delivery Note; the note was never stored | Signing flow, signature association, issued Delivery Note record, offline identity |
| Parts locked after completion on all job types | Test & Repair only | Extend |
| Tablet finding unconfirmed | Reported as the cause | Keep as an unconfirmed staff check |

## TR-02 — what was found (UNCONFIRMED by staff or the reviewer)

Reproduced on the demo backend in a production build before any change: on a
desktop the close-out's *Job card PDF* button opened the PDF in a new tab; on a
browser **with no built-in PDF viewer** — which is what the EJE tablets are
(Chrome on Android) — the same button **silently downloaded the file**: nothing
appeared on screen. The button now opens the preview inside the application
(`DocumentPreviewDialog`): the PDF where it can, the same document drawn as HTML
where it cannot, with Print and Download beside it. Verified in emulation (a
tablet viewport with `pdfViewerEnabled` false) and by the smoke suite. **Whether
this is the symptom the reviewer saw is not confirmed** — section H of
`docs/staff-testing.md` has the device check (H10).

## Requirement matrix — current implementation

Every row below is implemented and its automated tests pass; none is approved
or staff-verified. Migrations `0037` and `0038` are development migrations,
**not applied to production**.

| ID | Required behaviour | Implementation (files / handlers) | Tests | Migration | Status |
|---|---|---|---|---|---|
| ATT-01 | Absent needs exactly Leave, Sick Leave, Family Responsibility or IOD (Injury on Duty); attendance only; old absences keep no reason | `domain/types/attendance.ts`, `attendance-operations.ts` (`recordAttendance`), `/api/attendance`, `AbsenceReasonPicker.tsx`, register and My attendance, attendance CSV | `reviewer-feedback.test.ts`, `reviewer-feedback-api.test.ts`, `attendance.test.ts`, db constraint test, smoke | 0037 `absence_reason` (null on old rows) | TESTED — awaiting approval |
| ATT-02 | Own attendance only; office per permission model | unchanged | unit + HTTP | — | TESTED — awaiting approval |
| TS-01 | Own timesheet only, on every route (sheet, period document, PDF, comment, submit) | `timesheets.ts` `assertMayRead` / `assertOwner` | unit + HTTP | — | TESTED — awaiting approval |
| TS-02 / TS-14 | **Send to office for the chosen From/To period**: once; the period's days become read-only for the technician on every path; the office reads the sent version; a sent period may not share a day with another sent one; no reopening — a mistake is put right by a correction (TS-16) | `submitTimesheetPeriod`, `assertNoOverlap`, `assertDayOpen` (`src/application/timesheets.ts`); `POST /api/timesheets/[userId]/period/submit`; repository `submitPeriod` (conditional) | unit (lock, boundaries, duplicate, overlap), HTTP, db (trigger: write-once, overlap), smoke | 0038 `timesheet_periods` + trigger `timesheet_periods_guard` | TESTED — awaiting approval |
| TS-03 | Submission audited (`timesheet_submitted`, actor, time); lines and comment frozen in `snapshot`; the office's copy and PDF are drawn from it | as above | as above | as above | TESTED — awaiting approval |
| TS-16 | **Correcting a sent timesheet**: the technician asks (reason + complete corrected lines); the office (Master/Coordinator, not the asker) accepts or rejects with a note, once; the sent original never changes; the version in force is the correction last accepted, shown and labelled on the sheet, PDF Layout and export; one pending per period; audited and notified | `application/timesheet-corrections.ts`, `timesheets.ts`, `TimesheetCorrections.tsx`, routes `…/period/corrections`, `…/corrections/[id]/decide`, `/api/timesheets/corrections/pending` | `timesheet-corrections.test.ts` (15), HTTP (bypasses, replay), db (every refusal), smoke | 0039 `timesheet_corrections` + trigger | TESTED — awaiting approval |
| Notify | **On a successful send, every active Master and Coordinator is notified** through the existing in-app notifications (`notifyOffice`, type `timesheet_submitted`), only after the submission is saved; a refused send notifies nobody; a retried request is answered from the idempotency store and a second send is refused, so there is never a second notification; technicians are not notified | `submitTimesheetPeriod`, `application/audit.ts` `notifyOffice`, notifications page | unit (recipients, once, refusal), HTTP, db (recipients), smoke (the bell) | 0038 adds `timesheet_submitted` to `notification_type` | TESTED — awaiting approval. In-app only; nothing is emailed or sent by WhatsApp |
| TS-04 | From before To; From after To said on screen and refused on the server; boundaries included; oldest first; reset on every visit without touching saved lines | `lib/timesheet-dates.ts`, `timesheets/page.tsx`, `loadTimesheet` | unit (boundaries, order, empty, invalid, 92-day limit), smoke | — | TESTED — awaiting approval |
| TS-05 | Day of the week beside every date (page, PDF Layout, export, My attendance), UTC calendar arithmetic | `lib/timesheet-dates.ts` | unit (incl. leap day, year end) | — | TESTED — awaiting approval |
| TS-06 | Workshop as a choice, not a fake customer | `saveTimesheetEntry`, page | unit, HTTP, db constraint | 0037 `workshop` | TESTED — awaiting approval |
| TS-07 | NT not entered on a new line; OT and D/T kept; historical NT kept, never moved | `saveTimesheetEntry` (`nt_not_entered`), page, PDF, export | unit, HTTP, smoke | 0037 keeps `normal_hours` | TESTED — awaiting approval |
| TS-08 | Callout is a rand amount per line; **a shared call-out is split by hand** (e.g. R500 each of R1 000) — the Shared marker never changes an amount; no allocation | `saveTimesheetEntry`, page hint | `reviewer-decisions.test.ts` (two technicians, R500 each, untouched; corrections; money rules) | 0037 `callout_amount_cents`, `callout_shared` | TESTED — awaiting approval |
| TS-09 | Int Km and Cust Km, separate, one decimal | `saveTimesheetEntry`, page, PDF | unit, db | 0037 `internal_km`, `customer_km` | TESTED — awaiting approval |
| TS-10 | One comment per period, in the Comments box; old day comments kept as history | `saveTimesheetPeriodComment`, `POST …/period/comment` | unit, HTTP, smoke | 0038 `timesheet_periods.comment` | TESTED — awaiting approval |
| TS-11 | Preview shows the PDF Layout for the chosen period; writes nothing | `loadTimesheetDocument`, `GET …/period`, `GET …/period/pdf`, `DocumentPreviewDialog`, `TimesheetDocumentView` | unit ("writes nothing"), HTTP, smoke | — | TESTED — awaiting approval |
| TS-12 | Save saves the open line and the period comment; values kept on refusal; never a submission | page | smoke, unit | — | TESTED — awaiting approval |
| TS-13 | Print prints the PDF Layout only | `DocumentPreviewDialog`, `globals.css` (`eje-print-isolate`) | build; the print dialog is not automatable | — | IMPLEMENTED — staff device check outstanding |
| PDF-01 | Time Sheet, Technician Name, **Period** (From – To), table **Date, Customer, OT, D/T, Callout, Int Km, Cust Km** (no Hm, no NT), Comments box; every day of the period, oldest first | `services/simulated/timesheet-pdf.ts` (`TIMESHEET_PDF_COLUMNS`, `timesheetPdfCells`, shared by the HTML view) | unit (exact headers, Hm absent, cell alignment), HTTP (headers in the PDF) | — | TESTED — awaiting approval |
| PDF-02 | The period comment in the Comments box | as above | unit | — | TESTED — awaiting approval |
| PDF-03 | Values from the saved lines or the snapshot; totals are the sums the sheet already showed | as above | unit | — | TESTED — awaiting approval |
| PDF-04 | Issued documents never regenerated; a sent period prints from its snapshot | — | `reviewer-decisions.test.ts` (stored bytes returned exactly) | — | Compliant |
| TR-01 (extended) | Once Complete job is pressed (`completion`, `customer_signature`), parts cannot be added, changed or removed — on **every job type with an In Progress stage** (breakdown, installation, service, test & repair), on every server path, for the office too. Cancel completion is the only way back. After the signature the signed-record rule refuses every change (no repricing). **Exception, from the architecture:** a Parts job has no In Progress stage and records its goods at `completion` (cancel completion is not applicable), so it is locked by the signature | `domain/job/workflow.ts` `partsLockedAfterCompletion`; `job-operations.ts` `addPart` / `updatePart` / `removeLineItem`; `WorkCapturePanel.tsx` | `reviewer-decisions.test.ts` — four job types × add/update/remove × completion and signature × technician and office; reopen by cancel; signed refusal; Parts exception | — | TESTED — awaiting approval |
| TR-02 | In-app preview with Print and Download | `JobCardPdfButton.tsx`, `DocumentPreviewDialog.tsx` | smoke (no PDF viewer: must show, not download), emulation | — | TESTED — **cause unconfirmed** (staff check H10) |
| TR-03 | Part number and description on the PDF Layout | `lib/job-card/model.ts`; also on the Delivery Note | unit | — | Compliant |
| TR-04 | Completed job card previewed and printed; courier copies are the Delivery Note | as TR-02, PARTS-03 | — | — | TESTED — awaiting approval |
| PARTS-01 | Order number optional on Parts | `domain/job/job-types.ts` | unit, HTTP, db | reference rows follow the code | TESTED — awaiting approval |
| PARTS-02 | Optional Quote Number on Parts (existing field) | `job-types.ts`, `jobs/new/page.tsx` | unit, HTTP | — | TESTED — awaiting approval |
| PARTS-03 / 04 | **Two documents, one signature.** A: the **Delivery Note** — no prices; goods (repaired unit, parts: number, description, quantity), waybill and references; it is the document **shown to the courier at the signature step** (online and offline) and **signed once** there. B: the **normal job card, priced**, sent to the customer and kept for the office, carrying **that same signature** with "given once, on the Delivery Note" and a shared signature reference. At issue both are rendered, stored and recorded together; the Delivery Note record names the job card's storage key, the signer, the signing time and the SHA-256 of the signature strokes | `lib/job-card/delivery-note.ts`, `services/simulated/delivery-note-pdf.ts`, `components/jobs/DeliveryNoteDocument.tsx`, `JobCardPdfPreview.tsx` (shows the Delivery Note for a courier), `CompleteJobWizard.tsx`, `lib/job-card/model.ts` (acceptance), `application/delivery-note.ts` (`issueDeliveryNote`, `generateDeliveryNote`), `job-operations.ts` (both issue paths), `data/postgres/delivery-note-repository.ts` | `reviewer-decisions.test.ts`: online signing, both documents stored and associated, prices on the card and none on the note, the stored note returned exactly, retry idempotent; HTTP; db (one per job, write-once); smoke | 0038 `delivery_note_documents` (write-once) | TESTED — awaiting approval |
| Offline courier | A signature held offline against the Delivery Note is verified on sync against the server's own Delivery Note identity (`dln1:`) and accepted; a resend does not duplicate it. **A stale tablet build** that identified the job card (`jcm1:`) for a courier collection is **referred to Field Captures**, never attached; the office cannot apply a held signature — the courier signs the current Delivery Note again | `lib/job-card/document-identity.ts` (courier-aware `documentIdentityFor`), `application/offline-signature.ts` | `reviewer-decisions.test.ts`: offline accepted, retry, stale build quarantined, non-courier unchanged (`jcm1`) | — | TESTED — awaiting approval |
| Failure | If the Delivery Note cannot be stored, the issue is refused as a whole (`delivery_note_not_stored`): no job card recorded, no status change, no delivery; the signature stays on the job for the retry | `issueDeliveryNote`, `renderAndStoreFinalDocument` / `submitJobCard` | `reviewer-decisions.test.ts` | — | TESTED — awaiting approval |
| PARTS-05 | Same visibility rule for both documents; issued card never overwritten; production of the note audited (`delivery_note_generated`) | as above | unit, HTTP | — | TESTED — awaiting approval |

### Customer and office delivery

The priced job card goes to the customer through the existing issue workflow:
`issueJobCard` / `submitJobCard` emails it to the job's contact (DECISION 4),
records the delivery attempt, and moves the job to Office Handling; the office
downloads it from the review screen. The Delivery Note is stored at the same
moment and retrieved — exactly as issued — with *Delivery note* on the job and
review screens. **Real email delivery needs EJE's Microsoft 365 credentials;**
without them a PostgreSQL deployment records the job card as *pending*/refused
rather than sent, and nothing claims it was delivered. WhatsApp likewise.

## Correcting a sent timesheet (TS-16, 29 October 2026)

The owner asked for the correction workflow to be built, not left as a
limitation. The smallest complete design on the existing architecture:

- **The sent timesheet is never changed.** `timesheet_periods` and its
  snapshot stay exactly as sent (0038's trigger already refuses any change).
- **A correction is its own record** (`timesheet_corrections`, migration 0039),
  linked to the one sent period. It holds the reason, who asked and when, the
  COMPLETE version it corrects (`before` — the original, or the correction last
  accepted) and the COMPLETE corrected version (`after`), and the decision: who,
  when, accepted or rejected, and the note.
- **Who.** Only the technician whose timesheet it is asks (the session's user;
  another technician or the office is refused, also by direct request). The
  office decides: a new capability, `timesheets.reviewCorrections`, held by
  Master and Coordinator only — the same two roles the office notifications go
  to — and never by the person who asked (refused by the application and by a
  database CHECK).
- **Lines.** Every corrected line passes exactly the timesheet's own rules (the
  line validation was extracted into `normaliseTimesheetLine`, shared by both
  paths): quarter hours, call-out in cents, km to one decimal, Workshop or a
  customer, NT and the old call-out count only as history; no day over 24 hours;
  every line inside the period's own days. A correction identical to the version
  in force is refused.
- **Periods.** A correction has no dates of its own, so it cannot create a
  period, overlap one, or send a day twice. The From/To rules (inclusive, 92 days
  at most, no future To, one send per period) are untouched and still enforced.
- **One at a time, decided once.** One pending correction per period (a partial
  unique index — a retry, a double tap or two tabs cannot open two); a decision
  only while pending (a conditional update — the second decision is refused);
  then the row is write-once and can never be deleted (trigger
  `timesheet_corrections_guard`). A replayed request with the same
  idempotency key is answered from the idempotency store.
- **The version in force** is the correction last accepted, else the original.
  The sheet, the totals, the PDF Layout (a *Version* line in its heading) and
  the CSV export (a *Sent version* column) show it; Preview offers the original
  and every correction, each labelled (in force / superseded / pending /
  rejected).
- **Told and recorded.** The office is notified (in-app) when a correction is
  asked for; the technician when it is decided. Audit events
  `timesheet_correction_requested`, `…_accepted`, `…_rejected`, the request's
  event listing every change line by line.
- **Screens.** On a sent period: the corrections with their state (Pending the
  office's review / Accepted / Rejected), what each changes, Preview of any
  version; for the technician *Ask for a correction* (the complete lines,
  editable, plus the reason); for the office *Accept correction* / *Reject* (a
  note required to reject), and a list of corrections waiting at the top of
  Timesheets.

Files: `src/application/timesheet-corrections.ts`, `timesheets.ts`
(`versionInForce`, `describeCorrectionChanges`, the document and export),
`src/components/timesheets/TimesheetCorrections.tsx`, the routes under
`src/app/api/timesheets/[userId]/period/corrections`,
`…/corrections/[correctionId]/decide` and `src/app/api/timesheets/corrections/pending`.
Tests: `timesheet-corrections.test.ts` (15), `reviewer-feedback-api.test.ts`
(HTTP, bypasses, replay), `attendance-timesheets.db.test.ts` (every database
refusal), the smoke journey.

## Migrations — three, in order (applied to production on 29 October 2026)

- `0037_reviewer_timesheets_attendance` — absence reason; timesheet Workshop,
  call-out amount and shared flag, Int Km and Cust Km; `timesheet_months` with a
  write-once trigger. Never released.
- `0038_timesheet_periods_delivery_notes` — `timesheet_periods` (From/To) with
  the write-once-and-no-overlap trigger; copies any `timesheet_months` row
  across as the period it covered (0037 has never been released, so in practice
  there are none) and leaves `timesheet_months` in place, unwritten; adds
  `timesheet_submitted` to `notification_type`; `delivery_note_documents`
  (write-once, one per job). Additive; nothing is dropped or reinterpreted.

- `0039_timesheet_corrections` — `timesheet_corrections` with its guard trigger,
  partial unique index and CHECKs; `notification_type` gains
  `timesheet_correction_requested` and `timesheet_correction_decided`.
  Additive.

0037 and 0038 were not edited after they were committed: a development database
may have applied them, so each later change is a further migration. Demo store:
v32 → v33 → v34 does the same in memory.

**Compatibility, both ways.** The live release keeps serving while the
migrations run, and an automatic rollback would run it against the migrated
database, so the old code must work on it: every new column is nullable or
defaulted, the absence-reason CHECK accepts NULL, and the new tables are never
read by the old code. This is now PROVED, not argued: the CI step
`scripts/release/rollback-compat.sh`, moved from the long-gone 4634d5d/0030 to
the live `ef0f695`, migrates a disposable database to 0039 with this release,
writes an absence reason, a Workshop line, a sent period, an accepted correction
and a Delivery Note, then runs **ef0f695's own code** against it — its preflight
(not refused by a database three migrations ahead), its attendance and timesheet
repository (reads them, writes an old-shape absent day and an old-shape line
with NT and a call-out count), its library and its jobs. What a rollback cannot
give back: the old screens do not show absence reasons, Workshop, amounts,
kilometres, periods, corrections or Delivery Notes, and the old release knows no
Send-to-office lock, so a technician could edit lines on a sent day there — the
sent snapshot and every correction stay untouched in the database.

## Tests (filled in from the runs on 28 October 2026)

See the final section of this file, "Test results".

## Remaining questions and staff checks

1. **TR-02 on the device** (unconfirmed): is the silent download what the
   reviewer saw? Staff check H10.
2. **Print** on the real tablet and browser (H6, H10, H12).
3. **Corrections to a sent timesheet**: built (TS-16, above). There is still no
   office reopen — by design.
4. **Tablets must be refreshed** to this build before courier-collection testing
   or release: an older build would show the courier the job card, and its held
   signature would be referred to Field Captures (safe, but the courier would
   have to sign again).

## Test results

Run on 28 October 2026 on this PC against the demo backend and a local
production build. Nothing touched the live site or its database.

- **Unit and API suite** (`vitest run`): **3240 passed, 28 failed, 8 skipped**.
  Every failure is in a file this change does not touch: the Windows-only
  backup, OCR and file-storage tests (archive 9, plan 4, offsite 2, crypto 1,
  OCR 2, file storage 3 — 21) and load timeouts on this low-memory machine
  (library-large-documents, drizzle-config, authorization, authentication,
  pdf-text — 7). Those five timeout files were re-run on their own: 96 of 96
  passed.
- **New and updated suites:** `reviewer-decisions.test.ts` 15 of 15 (shared
  call-outs; parts locks on four job types and the Parts exception; courier
  online, retry, offline, stale build, non-courier, storage failure, issued
  bytes); `reviewer-feedback.test.ts` 26 of 26 (periods, overlap, notification,
  PDF columns); `reviewer-feedback-api.test.ts` 4 of 4; demo migration v33;
  updated timesheet and attendance suites — all passing.
- **PostgreSQL suite** (`*.db.test.ts`: the period guard trigger, overlap and
  write-once, the 0038 month-to-period copy, the delivery-note table, the
  notification recipients): not runnable on this PC (no test database); it runs
  in CI — see the commit's CI result.
- **Lint** (`eslint .`) and **type check** (`tsc --noEmit`): clean.
- **Production build** (`next build`): passes.
- **Browser, local production build:** smoke **258 of 258** steps, no console or
  page errors (the first two runs failed one step — the courier's signature was
  drawn off-screen once the Delivery Note card sat above the pad; the test now
  scrolls the pad into view; the server accepted the signature throughout);
  workflow e2e passed end to end; route check 30 of 30; tablet emulation (no PDF
  viewer) **20 of 20** — the job card, the delivery note and the Time Sheet each
  SHOWN in the app with nothing downloaded, the seven columns present and Hm
  absent.
- **Not automatable / not done:** the browser's print dialog, the real tablet,
  and any staff test. Real email and WhatsApp delivery (no credentials).

## Release — 29 October 2026

**DEPLOYED — 29 October 2026: `1a34d1c` is live** (full SHA
`1a34d1c2348f544524952c1f0a5298d8ca48cd52`, CI run 40913736786 green on all
three jobs, rollback compatibility included). Run by Claude on the owner's
instruction, from the owner's PC, with the guarded release tool, the key
unlocked by the owner in the Windows ssh-agent.

- **Read-only check** (`-CheckOnly`): host `srv2000625`; `ef0f695` serving,
  healthy, database reachable; `/opt/eje/releases/1a34d1c` new; 187 389 MB
  free; pdftotext/pdfinfo present; env files readable; uploaded script SHA-256
  `76e3ef4d…94e4` matched the reviewed copy. CHECK PASSED.
- **The release** (`-ExpectPending 0037_reviewer_timesheets_attendance,0038_timesheet_periods_delivery_notes,0039_timesheet_corrections`),
  from the server's own output: 1/6 build beside the live release; 2/6
  **backup proven** — `/var/backups/eje/eje-eje_production-2026-10-29T17-02-41Z`,
  verified, key-checked and restore-tested BEFORE anything changed; 3/6
  preflight showed exactly the three expected migrations pending, in order;
  4/6 migrated, and preflight afterwards showed every shipped migration
  applied; 5/6 atomic switch `ef0f695` → `1a34d1c` at 17:02:52Z; 6/6 health
  gate passed at 17:02:55Z. "RELEASED 1a34d1c — confirmed from outside."
  Recorded state: `previous=/opt/eje/releases/ef0f695 … backup=… migrated=yes
  switched=… healthy=…`. **Rollback target: `ef0f695`**
  (`stage-release.ps1 -Rollback`), proven compatible with a database at 0039.
- A first attempt minutes earlier never reached the server: launched from Git
  Bash it used Git's `ssh`, which cannot see the Windows agent — "Permission
  denied (publickey)", nothing uploaded or run. Re-run from PowerShell with
  `-SshExe C:\Windows\System32\OpenSSH\ssh.exe`.
- **Verified afterwards from outside** (read-only; no job, timesheet, period,
  correction, attendance record or setting created — the only writes sent were
  requests that had to be, and were, refused): see
  `docs/staff-testing.md`, "Automated post-deployment verification — 29
  October 2026". Email stays `refuse`, WhatsApp unconfigured — untouched.
- **Before courier testing, refresh every tablet** (staff testing H0).


**Test results for the release commit `1a34d1c`** (29 October 2026):

- **CI run 40913736786: all three jobs green** — lint, types, the whole unit and
  application suite and the build (Linux); the PostgreSQL suite including every
  `timesheet_corrections` refusal; **rollback compatibility — ef0f695 against a
  database at 0039**; routes, the workflow end to end, the signed-document and
  tablet PDF checks, the tablet and phone layout, and smoke.
- **On this PC:** unit 3256 passed / 32 failed before two fixes. The two were
  real and mine (CSV header expectations not updated for the new *Sent
  version* column) and are fixed. Nine were load timeouts on this low-memory
  machine — those files then passed together (126 of 126). Twenty-one are
  Windows-only, in files this change does not touch, each with its cause seen:
  GNU tar reading `C:` as a remote host, POSIX paths compared with Windows
  paths, Unix file modes (438 vs 384), symlink permission, no OCR engine. They
  pass on Linux in CI. New suites: `timesheet-corrections.test.ts` 15/15,
  HTTP 5/5, demo migrations 28/28. Lint and types clean; build passes.
- **Browser, local production build:** smoke **259/259** with no console or
  page errors (one earlier run failed from the messaging step on, a load flake
  on this PC — the messaging page did not render within 10 s; the full re-run
  passed, and messaging is untouched); workflow e2e passed; routes 30/30;
  tablet check **17/17** (5 new: in-app preview, Print once with only the
  document and nothing written, Download identical each time, the Delivery
  Note without prices, the Time Sheet's seven columns).
- **Live, after the release:** see `docs/staff-testing.md` — 43 API checks and
  6 browser checks passed.

Physical confirmation still outstanding (needs a person and the device): the
rugged tablet's own browser, its print dialog and a real printer, and opening
the downloaded file on the tablet (staff testing H18–H20).
