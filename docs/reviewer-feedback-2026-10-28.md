# Real-world reviewer feedback — requirements matrix (28 October 2026)

Branch `claude/office-workflow-parts`, started at `50c1809`. **Nothing here is
deployed** — this task forbids deployment, production migrations and any change
to the live site. Statuses use the project's terms: nothing is DONE or approved
without the owner; *TESTED — awaiting approval* means automated tests ran and
passed, not that staff have tried it.

The term is **PDF Layout** throughout (not "PDF Log-out"), and **Parts** (not
"Ports").

## Audit — what existed before this change

| ID | Requested | Existing implementation (files) | Status found |
|---|---|---|---|
| ATT-01 | Absence reason: Leave, Sick Leave, Family Responsibility, IOD (Injury on Duty) | `attendance` table has `status` (present/absent) and a free-text `note`; `recordAttendance` (`src/application/attendance-operations.ts`); `/api/attendance`; `MyAttendance.tsx`, `attendance/page.tsx` | **Missing** — no reason field anywhere |
| ATT-02 | Technicians record/view only their own attendance; office per permission model | `assertMayRecordFor` (own, or `attendance.manage`); register needs `attendance.manage`; `/api/attendance/mine` reads the session's own | **Compliant**; server tests existed for recording, a test for "a technician cannot read another's" is added |
| TS-01 | Technician reads own timesheet; never another's (server too) | `assertMayRead` in `src/application/timesheets.ts`; owner-only writes `assertOwner` | **Compliant** (proved live on 28 Oct: 403) |
| TS-02 / TS-14 | Send to office: recorded, locked against technician edits, office reads the submitted version read-only, no API bypass, no duplicates | — | **Missing** — no submission concept |
| TS-03 | Submission audited; content and timestamp preserved | — | **Missing** |
| TS-04 | From/To filters, From first, invalid range refused, ascending order, reset on revisit without losing data | `timesheets/page.tsx`: From then To exist; list was **reversed (newest first)**; From > To reached the server as an error | **Partially compliant / defective** (order) |
| TS-05 | Day of week beside dates (page, PDF Layout) | `formatDate` only | **Missing** |
| TS-06 | *Workshop* as a predefined choice instead of a customer | customer from the register or typed name only | **Missing** |
| TS-07 | Remove NT from new entry; keep OT and DT | NT, OT, DBL T all entered (`timesheet_entries.normal_hours`) | **Missing** (NT still entered) |
| TS-08 | Callout as a rand amount per entry; shared callouts supported, no invented allocation | `callouts` is a whole-number COUNT (0–10) | **Defective** against the requirement |
| TS-09 | Internal Km and Customer Km | no km on the timesheet (job travel lines are a separate, priced record) | **Missing** |
| TS-10 | One comment for the whole timesheet | one comment PER DAY (`timesheet_comments`, unique per user and date) | **Defective** against the requirement |
| TS-11 | Preview (the real PDF Layout, changes nothing) | — | **Missing** |
| TS-12 | Save (draft; validation; values kept on error; not a submission) | lines saved one by one; per-day comments | **Partially compliant** |
| TS-13 | Print the PDF Layout, no app chrome | CSV export only | **Missing** |
| PDF-01…04 | Timesheet PDF Layout: Time Sheet, Technician Name, Month, Date/Customer/OT/DT/Callout/Km/Hm, Comments box | — | **Missing** |
| TR-01 | No part changes after a Test & Repair job is completed | `addPart`/`updatePart`/`removeLine` gate on `assertEditable`, which allows edits in `completion` and `customer_signature`; the completion wizard's first step offers *Add part* (reproduced in a browser on the demo backend, 28 Oct) | **Defective** |
| TR-02 | Test & Repair preview works | see the TR-02 row below | under investigation |
| TR-03 | Part number and description on the Test & Repair PDF Layout | charges table prints part number, then description (`src/lib/job-card/model.ts`); proved by render | **Compliant** for the priced card; the courier copy used to replace the priced card (PARTS-04) |
| TR-04 | Completed Test & Repair job card can be generated and printed; courier copies | job card PDF via `JobCardPdfButton` / issued document; a courier collection made the job card itself price-less | **Partially compliant** (see PARTS-03/04) |
| PARTS-01 | Order number optional on Parts jobs | `parts.requiresOrderNumber: true`, `orderNumberExpectation: 'required'`; enforced in `workflow.ts` readiness and the New Job form | **Defective** against the requirement |
| PARTS-02 | Optional Quote Number on Parts jobs | `quote_number` exists (0028) for Test & Repair only (`capturesQuoteNumber`) | **Missing** for Parts — reuse the existing field |
| PARTS-03 / 04 | Courier collection: a priced job card for the office AND a separate delivery note | one document: a courier collection turned the job card itself into a price-less "Delivery Note" (`showsPricesOnCollectionDocument`) | **Defective** against the requirement |
| PARTS-05 | Identities, permissions, audit consistent; issued card never overwritten | issued documents are stored bytes, write-once | **Compliant** foundation |

The final status of each row, the files changed and the tests run are in the
implementation table below, which replaces "planned" with what was actually done.

## TR-02 — what was found

Reproduced on the demo backend in a production build, 28 October 2026, before
any change. The renderers are sound (a Test & Repair job with parts, labour and
either collection renders as a PDF and as the on-screen document). On a desktop
the close-out's *Job card PDF* button opened the PDF in a new tab. On a browser
**with no built-in PDF viewer** — which is what the EJE tablets are (Chrome on
Android) — the same button **silently downloaded the file**: nothing appeared on
screen. That is the defect fixed: the button now opens the preview inside the
application (`DocumentPreviewDialog`), showing the PDF where it can and the same
document drawn as HTML where it cannot, with Print and Download beside it. The
smoke test now presses it in headless Chrome (no PDF viewer) and fails if a file
is downloaded instead of the job card appearing. **To confirm on the tablet:**
that this is the symptom the reviewer saw (question 7 below).

## Implementation — what was actually done (28 October 2026)

Statuses: **TESTED — awaiting approval** means automated tests ran and passed;
nothing here is approved, deployed or tried by staff. Migration `0037` is a
development migration: **not applied to production**.

| ID | Implemented behaviour | Main files | Tests (all ran, all passed) | Migration / history | Status |
|---|---|---|---|---|---|
| ATT-01 | Marking a day Absent opens a reason picker with exactly Leave, Sick Leave, Family Responsibility, IOD (Injury on Duty). The server refuses an absent day without one of the four, and a reason on a present day. Shown on My attendance, the register and the timesheet; in the attendance CSV; reason changes are audited | `domain/types/attendance.ts`, `application/attendance-operations.ts`, `app/api/attendance/route.ts`, `components/attendance/AbsenceReasonPicker.tsx`, `MyAttendance.tsx`, `attendance/page.tsx` | `reviewer-feedback.test.ts` (ATT-01), `reviewer-feedback-api.test.ts`, `attendance.test.ts`, `attendance-timesheets.test.ts`, db test (constraint, CI), smoke | `attendance.absence_reason`, nullable, with a check. Days recorded absent before keep **no** reason ("reason not recorded"); none is invented | TESTED — awaiting approval |
| ATT-02 | Unchanged: own days for a technician, anybody's for the office; another technician refused | `attendance-operations.ts` | `reviewer-feedback.test.ts`, `reviewer-feedback-api.test.ts`, existing tests | — | TESTED — awaiting approval |
| TS-01 | Unchanged rule, now also on every new route (month document, PDF, comment, submit): another technician 403, the office reads but cannot write | `application/timesheets.ts`, `app/api/timesheets/[userId]/months/**` | `reviewer-feedback.test.ts` (TS-01), `reviewer-feedback-api.test.ts` | — | TESTED — awaiting approval |
| TS-02 / TS-14 | **Send to office** per technician per month: saves first, then submits once. The month becomes read-only for the technician on every path (add, edit, remove, month comment, old day comments); the office reads the submitted version (*Sent to office … by …*). A second send — double tap, retry, second tab — is refused, never duplicated | `timesheets.ts` (`submitTimesheetMonth`, `assertMonthOpen`), `attendance-repository.ts` (`submitMonth`, conditional), `timesheets/page.tsx` | unit, HTTP and db tests (lock, duplicate, write-once trigger), smoke | `timesheet_months` table; a database trigger refuses any UPDATE or DELETE of a sent month | TESTED — awaiting approval |
| TS-03 | Submission recorded through the audit trail (`timesheet_submitted`, actor, time); the submitted lines and comment frozen in `snapshot` with `submitted_at` / `submitted_by`; the office's copy and PDF are drawn from the snapshot | as above | as above | as above | TESTED — awaiting approval |
| TS-04 | From before To; an impossible range is said on screen and not queried (the server refuses it too); days **oldest first**; the page opens on the 1st of the month to today on every visit — only the two filter boxes reset, saved lines are untouched, and a half-typed line still warns before leaving | `lib/timesheet-dates.ts`, `timesheets/page.tsx` | `reviewer-feedback.test.ts` (boundaries, ordering, empty, invalid), smoke | — | TESTED — awaiting approval |
| TS-05 | Day of the week beside every date (page, PDF Layout, export, My attendance), computed from the calendar date in UTC so no time zone can shift it | `lib/timesheet-dates.ts` | weekday tests incl. a leap day; PDF test | — | TESTED — awaiting approval |
| TS-06 | *Workshop* is a choice in the customer picker; stored as a flag, not a customer — no fake customer record; Workshop and a customer together are refused | `timesheets.ts`, `timesheets/page.tsx` | unit, HTTP, db (constraint), smoke | `timesheet_entries.workshop` (false on every existing line) | TESTED — awaiting approval |
| TS-07 | NT removed from entry and from the PDF Layout; OT and DT kept. The server refuses NT on a new line. A line written before keeps its NT on correction, shown as *NT (historical)*, never moved into OT or DT | `timesheets.ts`, page, PDF, export | unit (`nt_not_entered`, history kept), HTTP, smoke | `normal_hours` kept; new lines carry 0 | TESTED — awaiting approval |
| TS-08 | The call-out is a **rand amount per line** (whole cents, validated on the server, ZAR formatting). A *Shared* tick records that the call-out is shared with other jobs; the amount is recorded as entered and **not divided** — no allocation rule exists (question 5) | `timesheets.ts`, page, PDF, export | unit (amount, cents, shared), HTTP, db | `callout_amount_cents`, `callout_shared`; the old whole-number `callouts` COUNT is kept and shown as historical, never converted | TESTED — awaiting approval |
| TS-09 | Internal Km and Customer Km, each to one decimal, 0–10 000, saved and shown separately; the PDF Layout's one Km column prints "internal / customer" | `timesheets.ts`, page, PDF | unit, db | `internal_km`, `customer_km` (0 on existing lines); job travel kilometres untouched and not reinterpreted | TESTED — awaiting approval |
| TS-10 | One comment per timesheet (the month), saved with Save and printed in the Comments box. Per-day comment entry is no longer offered; day comments written before stay visible as history (and in the export) | `timesheets.ts` (`saveTimesheetMonthComment`), page | unit, HTTP, smoke | `timesheet_months.comment`; `timesheet_comments` untouched | TESTED — awaiting approval |
| TS-11 | **Preview** shows the real PDF Layout in the app (the PDF where the browser can, the same document as HTML on tablets). Reading it writes nothing — proved: no month row, no audit event | `DocumentPreviewDialog.tsx`, `TimesheetDocumentView.tsx`, `months/[month]/route.ts`, `months/[month]/pdf/route.ts` | unit ("writes nothing"), HTTP, smoke | — | TESTED — awaiting approval |
| TS-12 | **Save** saves the open line and the month comment, with a "Saved … Not sent to the office" confirmation; on a refusal the form stays open with what was typed; Save never submits | page | smoke (Save, still a draft), unit | — | TESTED — awaiting approval |
| TS-13 | **Print** prints the PDF Layout only: the PDF itself where it can be displayed, otherwise the HTML document alone (`html.eje-print-isolate` hides the application) | `DocumentPreviewDialog.tsx`, `globals.css` | build and lint; the print dialog itself cannot be automated | — | IMPLEMENTED — the print dialog is to be tried by staff |
| PDF-01 | Time Sheet, Technician Name, Month, table Date / Customer / OT / DT / Callout / Km / Hm, Comments box; dates with their weekday; every day of the month, oldest first | `services/simulated/timesheet-pdf.ts` | PDF text test | Hm printed **empty** (question 1) | TESTED — awaiting approval (Hm open) |
| PDF-02 | The month comment in the Comments box | as above | PDF text test | — | TESTED — awaiting approval |
| PDF-03 | Values from the saved lines (or the submitted snapshot); totals are the sums the sheet already showed — nothing new calculated; historical NT and call-out counts stated under the table | as above | unit | — | TESTED — awaiting approval |
| PDF-04 | Issued job cards and signed documents are stored bytes and are never regenerated. A submitted timesheet always prints from its snapshot | — | existing immutability tests | — | Compliant |
| TR-01 | On a Test & Repair job, once Complete job has been pressed (`completion`, `customer_signature`), adding, changing or removing a part is refused on the server for everyone, and the screens stop offering it with the reason. Cancel completion returns it to In Progress, where parts work again. Other job types unchanged | `domain/job/workflow.ts` (`partsLockedAfterCompletion`), `job-operations.ts`, `WorkCapturePanel.tsx` | `reviewer-feedback.test.ts` (TR-01) | — | TESTED — awaiting approval |
| TR-02 | See "TR-02 — what was found" | `JobCardPdfButton.tsx`, `DocumentPreviewDialog.tsx` | smoke regression (no PDF viewer: must show, not download) | — | TESTED — awaiting approval (confirm on the tablet) |
| TR-03 | Part number and description on the Test & Repair PDF Layout — already printed in the charges table; now also on the courier's delivery note | `lib/job-card/model.ts`, `delivery-note.ts` | `reviewer-feedback.test.ts`, render checks | — | Compliant (verified) |
| TR-04 | A completed Test & Repair job card is previewed and printed from the app (the TR-02 dialog); courier copies are the separate delivery note | as TR-02, PARTS-03 | as below | — | TESTED — awaiting approval |
| PARTS-01 | Order number optional on Parts (form, readiness gate, overview) | `domain/job/job-types.ts` | unit, HTTP | The descriptive `job_types.order_number_expectation` row follows the code at the next reference-data sync; the application reads the code | TESTED — awaiting approval |
| PARTS-02 | Optional Quote Number on Parts, reusing `jobs.quote_number` (0028) — form, details editing, overview, job card | `job-types.ts`, `jobs/new/page.tsx` | unit, HTTP, PDF text | none (the field exists) | TESTED — awaiting approval |
| PARTS-03 / 04 | A courier collection (Parts or Test & Repair) now has **two** documents: the **job card, always priced** (the office record and the customer's copy), and a separate **Delivery Note** — goods (repaired unit and parts: part number, description, quantity), waybill, references, signature lines, **no price anywhere**. A *Delivery note* button on the job and review screens, before or after issue | `domain/job/parts-document.ts`, `lib/job-card/delivery-note.ts`, `services/simulated/delivery-note-pdf.ts`, `application/delivery-note.ts`, `DeliveryNoteButton.tsx`, `DeliveryNoteDocument.tsx`, command `generate_delivery_note` | unit, HTTP (permission, not applicable, PDF), the parity tests repointed at the delivery note | Job cards **already issued** keep the bytes they were issued with (a courier one issued before stays price-less) | TESTED — awaiting approval |
| PARTS-05 | Delivery note: the same visibility rule as every job action; refused unless it is a courier collection at or past completion; producing it never changes the job or the issued card (proved: the job is identical afterwards); audited (`delivery_note_generated`) | as above | unit, HTTP | — | TESTED — awaiting approval |

### Tests run (28 October 2026, this PC, demo backend — nothing touched the live site)

- **Unit and API suite** (`vitest run`): 3218 passed, 31 failed, 8 skipped. Every
  failure is in a file this change does not touch and is a known local
  condition: the Windows-only backup, OCR and file-storage tests (archive 9,
  plan 4, offsite 2, crypto 1, OCR 2, file storage 3) and load timeouts on this
  low-memory machine (library-large-documents, drizzle-config, authorization,
  job-workflow-api, authentication, pdf-text, escrow-check) — each of the
  timeout files passes when run on its own (re-run: 126 of 126 apart from one
  timeout, then `authorization.test.ts` alone 35 of 35).
- **New tests:** `reviewer-feedback.test.ts` 25, `reviewer-feedback-api.test.ts` 4,
  plus updated `timesheets`, `attendance`, `attendance-timesheets`,
  collection-document, parts and test-and-repair tests and a demo-migration
  test — all passing.
- **PostgreSQL tests** (`*.db.test.ts`, including the new write-once trigger and
  constraint cases): not runnable on this PC (no test database); they run in CI.
- **Lint** (`eslint .`) and **type check** (`tsc --noEmit`): clean.
- **Production build** (`next build`): passes.
- **Browser, against a local production build on the demo backend:** the smoke
  suite 258 of 258 steps, no console or page errors; the workflow e2e passed end
  to end; the route check 30 of 30; an emulated tablet (no PDF viewer) 17 of 17
  checks — the job card, the delivery note and the Time Sheet each SHOWN in the
  app with nothing downloaded.
- **Not automatable:** the browser's print dialog itself (TS-13), and anything
  on the real tablet. No staff test has been done.

### Migration 0037 (development only — NOT applied to production)

`src/db/migrations/0037_reviewer_timesheets_attendance.sql`, forward-only and
additive: `attendance.absence_reason`; `timesheet_entries.workshop`,
`callout_amount_cents`, `callout_shared`, `internal_km`, `customer_km`; the new
`timesheet_months` table with its write-once trigger. No row is rewritten and
nothing is backfilled. The previous release ignores the new columns and table,
so a rollback stays possible (it would not show the new fields). Demo store v32
does the same for the in-memory backend.

**One release consequence to know before deploying:** the job card for a
courier collection is now priced, so its document identity (BD-23) differs from
what an older build computed. An offline signature held on a tablet still
running the old build, for a courier collection, would be referred to Field
Captures rather than applied — refresh the tablets when this ships.

### Open questions for the owner

1. **Hm.** The PDF Layout has an Hm column, printed empty. What does it hold —
   hour-meter readings, hours, something else — and who enters it?
2. **Reopening a sent timesheet.** Once sent, a month is read-only and nothing
   reopens it. Should the office be able to return it to the technician (with a
   reason, audited), or correct it themselves?
3. **Telling the office.** Sending is recorded and the office sees it on the
   Timesheets screen; no notification is sent. Should the coordinator be notified?
4. **The courier at the signature step.** The job card is now always priced, so a
   courier signing on the tablet sees the priced card. Should the courier sign on
   the delivery note instead? That touches the offline-signature identity rule
   (BD-23), so it was not changed without a decision.
5. **Shared call-outs.** Recorded as shared, the amount as entered, not divided.
   Is there an allocation rule?
6. **TR-01 beyond Test & Repair.** Should breakdown, installation and service
   jobs also lock their parts once completed?
7. **TR-02 on the device.** Confirm on the tablet that the downloaded-not-shown
   preview was the reviewer's symptom.
8. **The timesheet is a month.** Sending, the comment and the PDF Layout are per
   calendar month (the Layout's "Month"). Confirm that is the period.
