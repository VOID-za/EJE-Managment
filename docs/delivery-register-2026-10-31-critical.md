# Delivery register — the tester's critical fixes (31 October 2026)

Asked for by the owner on 31 October 2026 ("EJE — CRITICAL FINAL FIXES").
Requirements: `docs/SCOPE.md` (CLOSED-CSV-1, TST-TS-2, ATT-AUTO-1, TST-MMF-1,
PDF-VIEW-1, JOB-VAL-2, TR-PARTS-1). Status of every item: **TESTED — awaiting
approval.** Physical-device checks: `docs/staff-testing.md` section M.

## Root causes found (each reproduced on the live code, `316544f`, before fixing)

| Area | What was wrong |
|---|---|
| Timesheets — typing | The open line was state of the whole page: every key re-rendered every day of the period. ~100 ms a key on a desktop, 450–580 ms on a slow tablet (6× CPU throttle) with a month entered — the "freeze". |
| Timesheets — stranded line | Changing From/To with a line open removed the form and every Add line / Edit button (they wait for no line to be open). Nothing on the page could continue it. |
| Timesheets — silent refusal | A server refusal was printed in the period card at the top of the page; a few days down, Save line seemed to do nothing. |
| Timesheets — reload | A half-typed line was lost on a reload (Android drops background tabs). |
| Office timesheets | The picker offered Master/Coordinator technicians only, so their own timesheet — which My Monthly Forms asks them to submit — could not be filled in. |
| Attendance | Not autosave: each tap was one request; while one was in flight every Present/Absent button was disabled, so quick taps were lost; nothing said whether a day was saved; a note typed in the office register was lost unless a status was pressed after it. |
| PDF previews | Three components asked the BROWSER to show the PDF: an iframe where `pdfViewerEnabled`, an HTML replica elsewhere. Android phones and tablets never saw the PDF (replica in a fixed box, no zoom or paging, cut off on a phone); library manuals showed nothing at all on Android; desktop showed one squeezed page inside a scrolling dialog. "View Final PDF" re-drew the job card instead of showing the stored file; corrections and Finance package files had no preview. |
| Job validation | Installation and Service required a Priority. |
| Test & Repair | One booked-in item per job; the delivery note listed one. |

A defect found DURING testing and fixed: the new viewer measured page positions
from the dialog (`offsetTop`), so on a phone Next overshot and Previous stayed
disabled on page 2 (forms regression at 390×844).

## What was built

- `TimesheetLineForm` (own state, field checks with the server's rules, kept on the device), memoised day rows, the comment in its own component; the office's own timesheet first.
- `AttendanceAutosaver` (debounced queue, one request at a time, offline retry with back-off, `keepalive` on leaving, device storage, `expectedRecordedAt` conflict refusal) and `AutosaveStatus`.
- My Monthly Forms: Edit my timesheet / attendance links; API tests with forged ids.
- `PdfViewer` (pdf.js 4.10.38, vendored unchanged, precached) used by every preview; `printPdf`; full-screen document dialog; previews for the stored final job card, corrections and Finance package files.
- Installation/Service `requiresPriority: false`.
- Test & Repair parts list (`repair-items.ts`, `RepairItemsEditor`, `set_repair_items`), migration 0041 (`jobs.more_repair_items`, additive), delivery note headings repeated on every page.
- Closed Jobs: Download CSV removed.

## Tests (local, one browser at a time)

| Suite | Result |
|---|---|
| Unit and API | 3 397 passed, 0 failed, 19 skipped (the PostgreSQL phases, run in CI) |
| Forms regression (new), 11 viewports × 42 checks | 462 passed, 0 failed — 1440×900, 1280×800; touch 1280×800, 1180×820, 1024×768, 1024×1366, 800×1280, 768×1024, 390×844, 375×812, 360×800 |
| Tablet PDF check (rewritten) | 18/18 |
| Workflow end-to-end | 65/65 desktop, 65/65 at 768×1024 |
| Job workflow check | 44/44 desktop, 44/44 at 768×1024 |
| Tablet interaction | 7/7 |
| Tablet parity audit, six shapes | 6 × 347/347 |
| Responsive | 123/123 |
| Smoke | 268/268 |
| Routes | 33/33 |
| Update notice | 6/6 |
| Typecheck, lint, build | clean |

PostgreSQL round trip of the parts list, the 0041 constraint, and the live
release (`316544f`) against a database at 0041: CI only (no local PostgreSQL).

## Not verified here

Real Android tablet and phone, a real printer, the on-screen keyboard, workshop
Wi-Fi loss — staff-testing M1–M5. Printing was proved up to the browser's print
call (stubbed in tests).

## Fixed after the first CI run (commit `c68b3c3`)

CI on `6004be0` failed two steps, both real:

- PostgreSQL suite: a booked-in part with only a quantity — always allowed —
  was refused by the new list rule (422). It is kept again; the form hints.
- Forms regression on a phone (CI's headless Chromium): a zoom resized the
  visible canvas before the new drawing finished, so the page went blank for
  the length of the render. Pages are now drawn off screen and swapped in.

Reproduced locally on Playwright's headless shell, fixed, and re-proved there
(390×844, 360×800, 1440×900: 42/42 each; tablet PDF check 18/18).

## Release record — DEPLOYED 31 October 2026: `c68b3c3`

- CI run 41242461859 on `c68b3c3`: success — every job and step green,
  including the PostgreSQL tests and rollback compatibility (live `316544f`
  against a database at 0041).
- Read-only check passed (`srv2000625`, release script SHA-256
  `5ab56162…b3c6`, 182 165 MB free).
- Release: `-ExpectPending 0041_repair_items` (NOT `none`). Backup proven
  `/var/backups/eje/eje-eje_production-2026-10-31T21-41-26Z`; preflight
  expected exactly 0041; migrated; switched 21:41:38Z; healthy 21:41:41Z.
  Rollback target `316544f` (it reads a database at 0041 — proven in CI).
- Public health: `c68b3c3`, ok, PostgreSQL reachable, email `refuse`; the
  update notice is served.

## Live verification (read-only)

| Check | Result |
|---|---|
| Critical workflows, desktop / tablet 768×1024 / phone 390×844 (`live-critical`) | 45 of 45 functional checks passed. Closed Jobs without CSV; the Master's own timesheet editable, a line kept across a From change and cancelled; another person's timesheet read-only and the server's 403 to forged writes; Installation/Service labels; PDFs — the stored final job card, a job card preview, the monthly timesheet, monthly attendance and time sheet — drawn, paged, zoomed, downloaded, printed (stubbed), closed and reopened; My Monthly Forms as each role's own; Attendance's autosave status |
| Test & Repair on EJE-2078, three sizes | Parts booked in shown; Edit parts opens and closes unsaved; `moreRepairItems` present (0041) |
| Tablet parity, every role, 1024×768 and 768×1024 | 6 of 6, no page errors |
| Issued job cards EJE-2050, EJE-2046, EJE-2041, EJE-2001 | byte-identical to before the release |
| Records | closed 15, signed 37, issued 25 — unchanged. Open list 63 (was 62): EJE-2078, a Test & Repair job created on the live site at 13:45Z on 31 October, before the release, not by this work. Timesheet people 5 (was 3): the office now sees its own timesheet and every user's — the intended change |

What the verification itself recorded on the live site: viewing a stored final
job card and a review page are AUDITED reads in this application, so the
checks added "document opened" entries on EJE-2050 and three "PDF generated"
entries on EJE-2078's activity trail. No job, timesheet, attendance or other
record was created or changed; the forged writes were refused (403).

Not verified: a live multi-part delivery note (no courier Test & Repair job
exists live, and making one would be writing test data — proven locally and in
CI), and everything in staff-testing M1–M5 (real devices, a real printer).
