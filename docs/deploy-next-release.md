# Deploying this change to eje.syncza.co.za, and rolling it back

Written for the layout the live server actually has, which is **not** the one
`docs/vps-deployment.md` describes:

| | Live server | `vps-deployment.md` says |
|---|---|---|
| Application | `/opt/eje/app` | `/srv/eje/app` |
| Releases | `/opt/eje/releases/<commit>` | (no release directories) |
| Documents | `/var/lib/eje/storage` | same |
| Database | `eje_production` (holding DEMONSTRATION data) | same name |
| Backups | `/var/backups/eje` | same |

Follow this file for paths and that one for the reasoning. The discrepancy is
recorded rather than silently resolved: whoever built the live server chose
`/opt`, and rewriting the older document to match a server nobody here can see
would be guessing.

**Nothing in this repository deploys anything.** Every command below is run by
somebody with root on the VPS.

## Versions (VERSION-1, from 3 November 2026)

Every release is given its semantic version by `deploy-release.sh` while it
builds — never by hand: the highest `version=` in `/var/lib/eje-release/`
(every release ever attempted, so a failed or rolled-back one's number is not
reused), stepped by the commits since the live release (`type!:` / BREAKING
CHANGE → MAJOR, `feat` → MINOR, anything else → PATCH). It is stamped into the
build (`EJE_APP_VERSION`), recorded beside the commit, required by the health
gate, and printed by the release tool: `RELEASED abc1234 (v1.2.0)`. When a
release is bigger than its commits say, `stage-release.ps1 -Bump minor` (or
`major`) raises the step. The commit remains what identifies a deployment;
`/api/health` reports both.

## RELEASED — `38b75cd` = v1.7.0, the form lifecycle (FORM-LIFECYCLE-1, MMF-SUBMIT-1, FORM-HISTORY-RO-1, ATT-TOGGLE-1, TS-ROW-1, 6 November 2026)

Released 19:20:54 UTC (switched; healthy 19:20:56) from branch `claude/payroll-autosave-followups` through `stage-release.ps1 -ExpectPending 0054_payroll_form_completions`, after the read-only check passed. Before it: `42e6bd4` v1.6.0, healthy, 54 migrations, kept as the rollback target. Asked for by the owner on 6 November 2026. What the system does: `docs/payroll-forms.md`, "The form lifecycle". **Deployed, not approved.**

- **What changed:**
  - **Each form completed on its own page.** *Completed* opens *Complete this form?* (what it does, the dates, the form name to keep or change, Cancel / OK). OK is checked on the server, freezes the content and its PDF (`payroll_form_completions`, write-once), locks the dates on every write path, and moves the form to My Monthly Forms.
  - **My Monthly Forms.** No pay-period filter. Timesheet, then Attendance, each with Preview / Print / Download / Save PDF of the completed PDF. **Submit to Office** stays disabled, with the reason in words, until both are completed for the same dates. It then makes one atomic submission of both. History at the bottom, read only.
  - **Present and Absent toggle.** Pressed again, the day is Not recorded.
  - **Timesheet lines as rows.** Customer | OT | D/T | Callout | Int Km | Cust Km.
  - **Submitted forms are read only for ever.** They are never resubmitted, which retires TS-PAPER-7's replacement and RESUBMIT-1's editable submitted days.
- **Independent review** of the diff found the following:
  - **High:** Submit to Office would have refused every form on PostgreSQL. jsonb reorders object keys, so the "still exactly as completed" check compared text that never matched. Fixed by comparing by value, with a regression test; proven on PostgreSQL in CI.
  - **Low:** the two forms could be completed at once for different dates. Fixed: both locks are taken in a fixed order.
  - **Low:** the working comment raced a completion. Fixed: it takes the lock.
  - **Not fixed, recorded as limitations in `docs/payroll-forms.md`:** a completed form cannot be withdrawn (the owner's rule; a decision is asked for); a To date in the future locks the coming days; a role change leaves a completed timesheet behind; the submitted PDFs are re-rendered from the frozen content.
- **CI:**
  - **Run 42271544400 on `38b75cd`: 86/86 steps, 3/3 jobs.**
  - **Unit:** 3 995 passed.
  - **PostgreSQL:** 514 passed, including the write-once guard, three racing completions making one, a save racing a completion, every direct edit of a completed form refused, three racing Submit to Office requests making one, and dates already submitted refused.
  - **Rollback compatibility:** the live `42e6bd4` against a database at 0054. Prepare 14/14, probe 18/18.
  - **Browser, at desktop, tablet and phone:**

    | Suite | Result |
    |---|---|
    | `payroll-lifecycle-check` (new) | 19/19 |
    | `timesheet-days-check` | 18/18 |
    | `timesheet-two-devices-check` | 8/8 |
    | `payroll-forms-check` | 14/14 |
    | `payroll-views-check` | 14/14 |
    | forms-regression | 44/44 |
    | tester fixes, batch | 12/12 each |
    | acceptance | 13/13 |
    | standby | 10/10 |
    | tablet audit | 567 page views |

    Smoke, the tablet PDF and interaction checks and the update notice also passed.
  - The run on `a55cee9` had the same browser results. One PostgreSQL test still expected the replacement, which this release retires; it was corrected in `38b75cd`.
- **Fresh backup, proven before the migration:** `/var/backups/eje/eje-eje_production-2026-11-06T19-20-37Z`.
  - Encryption: aes-256-gcm, key `23dba6772da10057`, MATCH. Both artefacts intact and authentic.
  - **RESTORE-TESTED** into a scratch database, then dropped. Contents: jobs 112, users 7, customers 10, machines 18, final documents 58, job media 29, signatures 72, audit events 2 275, 204 documents unpacked.
  - The same 17 storage keys that were already missing are recorded in its manifest.
- **Migration 0054 applied** (55 now). It is additive: one new table, empty.
- **Data before and after: identical in every fingerprinted table:**
  - signatures 72, final documents 58, checklists;
  - timesheet periods 15 and entries 39, monthly submissions 7, payroll submissions 0, PDF names 1, drafts 0, line removals 4;
  - attendance 100, corrections 0, comments 2, Finance packages 0;
  - the office-stage jobs, EJE-2011 and EJE-2106, users 7.

  Only the migration count moved (54 → 55), and the audit gained exactly 8 rows: the checks' own demonstration sign-ins (`user_signed_in`).
- **Live, read only:**
  - **Payroll check: 12/12 at desktop and phone.**
    - Timesheets: day blocks, Completed present (never pressed), the notice not pinned, no submitted history.
    - Attendance: Completed present, every unrecorded day "Not recorded".
    - My Monthly Forms: no period filter; Timesheet then Attendance; Submit to Office disabled with "Both forms must be completed"; history; the 11 historical timesheet submissions readable.
    - The Completed dialog's read-only check and the APIs answer; nothing written; no page error.
  - **Application sweep:** 18 pages, as Senior Tech, Office and a demonstration technician (never Mike), at desktop and phone. 108 loads, no server error, no page error, no write.
  - **Server state:** health ok, v1.7.0, database reachable, email `refuse`, demonstration mode on, 0 errors in the service log, backup timers active, rollback target `/opt/eje/releases/42e6bd4` present.
- **Not done on production, deliberately:** completing, submitting, toggling or saving anything. Each is proved in CI and locally. No email or WhatsApp message was sent.

**Rolling back** (`stage-release.ps1 -Rollback`) returns the code to `42e6bd4` (v1.6.0). Migration 0054 stays; v1.6.0 never reads its table. The limitations of v1.6.0 against it are recorded in `docs/payroll-forms.md` → Recovery: no lock on a completed form's dates, and submission by From–To.

## RELEASED — `42e6bd4` = v1.6.0, Timesheets by day; everything submitted on My Monthly Forms (TS-DAY-1, TS-EDIT-1, FORMS-HISTORY-1, TS-NOTICE-1, 6 November 2026)

Released 15:53:50 UTC (switched; healthy 15:53:52) from branch `claude/payroll-autosave-followups` through `stage-release.ps1 -ExpectPending none` (code only — the database was not touched) after the read-only check passed. Before it: `835eaaa` v1.5.2, healthy, 54 migrations, kept as the rollback target. Asked for by the owner on 6 November 2026; what the system does: `docs/payroll-forms.md`. **Deployed, not approved.**

- **What changed:**
  - **Day blocks (TS-DAY-1):** each date on Timesheets is one block — collapsed to its date, lines, customers or sites, OT, D/T, call-outs, km and save state; Edit opens it; Add line is inside the day; each line is edited or removed (confirmed) on its own; Change date moves the whole day.
  - **The data model, checked first:** OT, D/T, call-out and km are on each customer row of EJE's paper Time Sheet (TS-PAPER-1) and NT is no longer entered (TS-07), so they stay on the line. The day's figures are the sum of its lines, never stored — nothing can be counted twice. No migration; no stored, submitted or historical record changes shape.
  - **The editing defect (TS-EDIT-1):** a saved line's own Date field carried it to another day on the first keystroke, so the field lost its place mid-edit. The date is now the day's.
  - **Submitted history (FORMS-HISTORY-1):** moved — not hidden — from Timesheets to My Monthly Forms: your submitted timesheets (open as submitted, original and corrected, PDF, Corrections) and, for the office, every technician's (Export CSV, corrections decided). Timesheets and Attendance hold only working data. Notifications link to My Monthly Forms. Server permissions unchanged.
  - **The save notice (TS-NOTICE-1):** no longer pinned; it scrolls with the page on Timesheets and Attendance.
- **Independent review** of the diff found one regression and two gaps, fixed in `42e6bd4` with tests: a line changed on another device is shown as the server has it; a refused change to a line submitted elsewhere is listed with Discard; a dateless draft saves its date when the field is left.
- **CI** run 42239809742 on `42e6bd4`: **83/83 steps, 3/3 jobs** — unit, lint, types and build; PostgreSQL integration; rollback compatibility (the live `835eaaa` against this release's database); every browser suite at desktop, tablet and phone, including the new `timesheet-days-check` (18), `timesheet-two-devices-check` (8, now with two devices on two lines of one day), `payroll-forms-check`, `payroll-views-check`, `forms-regression`, acceptance and smoke.
- **Local, on the final code:** unit 3 961 passed; desktop — `timesheet-days-check` 18/18, two-devices 8/8, payroll-forms 14/14, payroll-views 14/14, forms-regression 44/44, acceptance 17/17, tester fixes 12/12, tablet interaction 7/7; phone — `timesheet-days-check` 18/18. The full local smoke run was cut short when the computer suspended its network; its timesheet and payroll steps had passed, and it passed in full in CI.
- **Fresh backup, proven before the switch:** `/var/backups/eje/eje-eje_production-2026-11-06T15-53-33Z` — aes-256-gcm, key `23dba6772da10057`, MATCH; both artefacts intact and authentic; **RESTORE-TESTED** into a scratch database, then dropped (jobs 112, users 7, customers 10, machines 18, final documents 58, job media 29, signatures 72, audit events 2 261; 204 documents unpacked). The same 17 storage keys that were already missing are recorded in its manifest.
- **Migrations:** none. Still 54.
- **Data before and after: identical in every fingerprinted table** (signatures 72, final documents 58, checklists, timesheet periods 15 and entries 37, monthly submissions 7, payroll submissions 0, PDF names 1, drafts 1, line removals 4, attendance 100, corrections 0, comments 2, Finance packages 0, the office-stage jobs, EJE-2011 and EJE-2106, users 7). The checks afterwards added exactly 8 audit rows, all their own demonstration sign-ins (`user_signed_in`).
- **Live, read only:**
  - **Payroll check:** 12/12 at desktop and phone — Timesheets: closed day blocks, Add line only inside an opened day, the notice not pinned, no submitted history, no Submit; Attendance: no submitted history, the notice not pinned; My Monthly Forms: your submitted timesheets and every technician's (11 historical submissions, matching the server), history, Finance month; the APIs; nothing written, no page error.
  - **Application sweep:** 18 pages (EJE-2011 and EJE-2106 included) as the Senior Tech, the Office and a demonstration technician (David — never Mike), at desktop and phone: 108 loads, no server error, no page error, no write.
  - **Server state:** health ok, v1.6.0, database reachable, email `refuse`, demonstration mode on, 0 errors in the service log, backup timers active.
- **Not done on production, deliberately:** any line typed, saved or removed, any submission, rename, correction or Finance package. Each is proved in CI and locally. No email or WhatsApp message was sent.

**Rolling back** (`stage-release.ps1 -Rollback`) returns the code to `835eaaa` (v1.5.2). Nothing in the database changes, because v1.6.0 has no migration.

## RELEASED — `835eaaa` = v1.5.2, the payroll completion (PAYROLL-ONE-1 and every payroll requirement, 5 November 2026)

Released 21:44:27 UTC (switched; healthy 21:44:29) from branch `claude/payroll-autosave-followups` through `stage-release.ps1 -ExpectPending none` (a code-only release — the database was not touched) after the read-only check passed. Before it: `e9fe38a` v1.5.1, healthy, 54 migrations, kept as the rollback target. **The owner accepted the payroll implementation as released in v1.5.1 on 5 November 2026**; this release carries the whole-repository payroll completion audit's fixes. What the system does: `docs/payroll-forms.md`.

- **The audit:**
  - **Open items checked:** every open issue (no open PRs), every branch (none holds work not in this release), the payroll code, routes, permissions, documents and tests, the physical test sheet, and production. Each payroll requirement was checked against the scope and the code.
  - **Scope rows:** 48 now read DONE (owner's acceptance) and 23 SUPERSEDED, each with the reason. The device checks were rewritten to what only a person can judge.
- **Fixed, each with a regression test:**
  - **Finance:** a package is sent only while it is what is current. Each attachment records its `basis` (the person's current submissions and accepted corrections), and Send refuses a stale package with `package_out_of_date`; nothing is sent.
    - **Before:** a period submitted between Prepare and Send never reached Finance while the month read "Sent"; a replacement made in between sent the replaced forms.
    - **"Sent" now:** a month reads Sent only for what the package carried.
  - **Monthly attendance submitted before PAYROLL-ONE-1:** it goes to Finance **as submitted**. Before, it was drawn from the register as it stood and labelled an office correction.
  - **The office never writes a technician's timesheet:** its write of a day comment is refused.
  - **Reserved device names:** refused with any extension (`CON.a.pdf`).
  - **A submitted timesheet's PDF:** it keeps its submitted name wherever it is opened.
  - **Attendance changed after submission:** told to the office.
  - **A lost Submit answer:** pressing Submit again replays the same request.
  - **The Attendance page:** it says when a linked period was shortened to its 92 days.
  - **Wording:** stale text fixed.
  - **Dead code:** a dead component removed.
- **Independent review** of the final diff: nothing blocking. Three low findings were fixed: the shortened-period notice, a gateway-hidden answer keeping its key, and the office card's wording.
  - The fourth needs no fix. A month sent by v1.5.1 and resent by v1.5.2 would carry the attendance as submitted. Production has never sent a Finance package (`finance_packages` 0), so no such month exists.
- **CI** run 42108507281 on `835eaaa`: **80/80 steps, 3/3 jobs**.
  - **Unit:** 3 967 passed, 5 skipped.
  - **PostgreSQL integration:** 510 passed. 15 skipped: the 13 rollback-prepare tests run as their own step (13/13), and 2 need the OCR engine. The new Finance test runs through the routes.
  - **Rollback compatibility:** the live `e9fe38a` against this release's database, 17/17, including reading a v1.5.2 Finance manifest.
  - **Every browser suite at desktop, tablet and phone:** among them payroll-forms, two-devices and the new `payroll-views-check`.
  - The smoke suite and the update notice.
- **Local, on the final code:**
  - Unit: 3 953 passed.
  - **At desktop, all passing:**
    - payroll-forms 14/14;
    - payroll-views 14/14;
    - two-devices 7/7;
    - forms-regression 44/44;
    - acceptance;
    - tester fixes 12/12;
    - batch 12/12;
    - office filters.
  - **At tablet:** payroll-forms 14/14, payroll-views 14/14, two-devices 7/7.
  - **At phone:** payroll-views 14/14.
  - **Stopped early:** the local run was halted by Claude Code when the machine ran low on memory, during tablet forms-regression. The rest ran in CI on the exact commit (above).
- **Fresh backup, proven before the switch:** `/var/backups/eje/eje-eje_production-2026-11-05T21-44-13Z`.
  - **Encryption:** aes-256-gcm, key `23dba6772da10057`. Both artefacts intact and authentic. Key check MATCH.
  - **Restore test:** into a scratch database, then dropped — RESTORE-TESTED. Contents: jobs 112, users 7, customers 10, machines 18, final documents 57, job media 29, signatures 71, audit events 2 214, 202 documents unpacked.
  - **Missing storage keys:** the same 17 that were already missing are recorded in its manifest.
- **Migrations:** none. Still 54.
- **Data before and after:** **identical in every fingerprinted table.** These were:
  - signatures and final documents;
  - checklists;
  - timesheet periods 15 and lines 40;
  - monthly submissions 7;
  - payroll submissions 0, PDF names 1, drafts 0, line removals 0;
  - attendance 98, corrections 0, comments 2;
  - Finance packages 0;
  - every office-stage job, EJE-2011 and EJE-2106;
  - users 7;
  - the audit count.
  
  The read-only checks afterwards added exactly 11 audit rows, all their own demonstration sign-ins (`user_signed_in`), and nothing else.
- **Live, read only:**
  - **Payroll check:** 12/12 on its first run (desktop and phone; Cloudflare's injected `/cdn-cgi/rum` beacons were excluded from its write detector from the start).
  - **Application sweep:** every top-level page as the Senior Tech, the Office and a technician (demonstration users; never Mike), at desktop and phone — all 200, no page error, no application write. The EJE-2011 (signed) and EJE-2106 (invoiced, read-only) job cards and Closed Jobs open intact.
  - **Server state:** health ok, v1.5.2, database reachable, email `refuse`, demonstration mode on, 0 errors in the service log, backup timers active.
- **Not done on production, deliberately:** any save, removal, submission, rename, correction or Finance package. Each is proved in CI, locally and in the browser suites. No email or WhatsApp message was sent.

**Rolling back** (`stage-release.ps1 -Rollback`) returns the code to `e9fe38a` (v1.5.1). Nothing in the database changes, because v1.5.2 has no migration. The `basis` it adds to a Finance manifest is ignored by v1.5.1 (CI rollback probe). Against v1.5.1, a package prepared by v1.5.2 would be sent without the currency check, as before.

## RELEASED — `e9fe38a` = v1.5.1, the timesheet autosave follow-ups and two devices on one line (PAYROLL-ONE-1, 5 November 2026)

Released 19:58:44 UTC (switched; healthy 19:58:47) from branch `claude/payroll-autosave-followups` through `stage-release.ps1 -ExpectPending 0053_timesheet_line_removals` after the read-only check passed. Before it: `cf6fe86` v1.5.0, healthy, 53 migrations — kept as the rollback target. What changed: `docs/payroll-forms.md` ("Two devices, one line").

- **Fixed — the four v1.5.0 follow-ups:** (a) a refusal is held only against the change that was sent, so a removal queued behind a refused first save is sent; (b) a removed line stays removed — a save arriving after the removal, in any order or from a page left mid-flight, is refused explicitly (`timesheet_line_removed`), naming what was typed; (c) every possibly-saved send is remembered, so two lost answers in a row no longer drop the newest typing; (d) removals take the same per-line lock as saves (PostgreSQL advisory transaction lock; a real per-line queue in memory).
- **Found and fixed by the new race tests:** two saves in the same millisecond shared one revision, so a stale save could be accepted — every save now gets a revision strictly later than the one it replaces.
- **Independent review of the whole autosave path** (ordering, stale answers, locks, optimistic UI, retry, leaving/unmount, offline, server concurrency): no critical finding; four fixed before release — leaving mid-save could report the device's own typing as another device's; a new line waiting in the device queue was not shown after a reload; a removal tapped during a save that lost to a newer version was dropped; a draft completed with the stored values did not move the revision on (and a line written back after a rollback round trip could not be edited).
- **Concurrency tests, none of them unit-only:** in-memory application races (save/save ×10, save/remove both orders, removal before the first save, another person's id, retry); the same races through the API routes; through the routes on **PostgreSQL** with real transactions (`payroll-forms.db.test.ts`); and the new **`timesheet-two-devices-check`** — two browser sessions as one technician: save/save, save/remove, offline then online, leaving at once, a queued new line surviving a reload, refresh consistency on both devices and no duplicates — at desktop, tablet and phone, in CI.
- **CI** run 42091952233 on `e9fe38a`: **77/77** — incl. PostgreSQL integration, rollback compatibility (the live `cf6fe86` against a database at 0053), every browser suite at three sizes, the two-devices check ×3, the update notice.
- **Local, on `e9fe38a`:** unit 3 936 passed (19 need PostgreSQL — run in CI); two-devices 7/7 ×3; the payroll scenario (the 30 steps) 14/14 ×3; forms-regression 44/44 ×3; acceptance 17/17 ×3; tester fixes 12/12 ×3; batch 12/12 ×3; tablet interaction 7/7; smoke 269 steps, ALL CHECKS PASSED; update notice ALL PASSED.
- **Fresh backup, proven before the migration:** `/var/backups/eje/eje-eje_production-2026-11-05T19-58-27Z` — aes-256-gcm, key `23dba6772da10057`; both artefacts intact and authentic; key check MATCH; **restore test** into a scratch database (jobs 112, users 7, customers 10, machines 18, final documents 57, job media 29, signatures 71, audit events 2 210, 202 documents unpacked), then dropped — RESTORE-TESTED. The same 17 storage keys already missing before this backup are recorded in its manifest.
- **Migration 0053** applied (54 recorded): one new table, empty; no existing row updated or deleted.
- **Data before and after:** identical in every fingerprinted table — signatures, final documents, checklists, timesheet periods 15 and lines 40, monthly submissions 7, payroll submissions 0, PDF names 1, drafts 0, attendance 98, corrections 0, comments 2, Finance packages 0, every office-stage job, EJE-2011 and EJE-2106, users 7; only the migration count moved (53 → 54). The read-only live checks afterwards added exactly four audit rows — their own four demonstration sign-ins — and nothing else.
- **Live, read only** (desktop and phone, as the Master): the first run reported **10/12** — its two failures were its own write detector flagging Cloudflare's injected analytics beacons (`POST /cdn-cgi/rum`), not an EJE request and not an application failure; rerun with only those beacons excluded: 12/12 — Timesheets, Attendance, My Monthly Forms, the forms/PDF/lines/history APIs, the office's views, the 11 historical submissions; no application write. Health ok, v1.5.1, database reachable, email `refuse`, demonstration on, 0 errors in the service log, backup timers healthy.
- **Not done on production, deliberately:** any save, removal, submission or rename — proved in CI, locally and in the browser suites.

**Rolling back** (`stage-release.ps1 -Rollback`) returns the code to `cf6fe86`; the database stays at 0053 and is never reversed. v1.5.0 never reads `timesheet_line_removals` (CI rollback probe: it reads and writes lines and periods normally at 0053). While rolled back it does not know a line was removed, so a late save could write that id back; after rolling forward again such a line is simply a line, editable and removable.

## RELEASED — `cf6fe86` = v1.5.0, payroll forms submitted together for the pay period (PAYROLL-ONE-1, 5 November 2026)

Released 18:27:43 UTC (switched; healthy 18:27:45) from branch `claude/payroll-completion` through `stage-release.ps1 -ExpectPending 0052_payroll_submissions` after the read-only check passed. Before it: `ad0f3c8` v1.4.0, healthy, 52 migrations — kept as the rollback target. What the system now does: `docs/payroll-forms.md`.

- **CI** run 42073588387 on `cf6fe86`: **74/74** — lint, types, unit and application tests, build, PostgreSQL integration (incl. `payroll-forms.db.test.ts`), rollback compatibility (the live `ad0f3c8` against a database at 0052), every browser suite at desktop, tablet and phone (incl. the new `payroll-forms-check`), the update notice.
- **Local, on `cf6fe86`:** unit 3 919 passed (19 need PostgreSQL — run in CI); forms-regression 44/44 at all three sizes; the payroll scenario (the owner's 30 steps) 14/14 at all three sizes; acceptance 17/17 ×3; tester fixes 12/12 ×3; batch 12/12 ×3; office filters 5/5 ×3; tablet interaction 7/7; full smoke suite 269 steps, ALL CHECKS PASSED.
- **Independent review**, two passes: six findings fixed before release and verified again on the final commit; four low-severity autosave edge cases recorded below as follow-ups.
- **Fresh backup, proven before the migration:** `/var/backups/eje/eje-eje_production-2026-11-05T18-27-22Z` — aes-256-gcm, key `23dba6772da10057`; both artefacts intact and authentic; key check MATCH; **restore test** into a scratch database (jobs 112, users 7, customers 10, machines 18, final documents 57, job media 28, signatures 71, audit events 2 130, 200 documents unpacked), then dropped — RESTORE-TESTED. 17 storage keys were already missing before this backup and are recorded in its manifest, as in earlier releases.
- **Migration 0052** applied (53 recorded); no row updated or deleted.
- **Data before and after:** identical — signatures 71, final documents 57, checklist instances 10 and answers 96, checklist versions and questions, timesheet periods 15, monthly submissions 7 (over their original columns; the three new columns are empty), attendance 98, corrections 0, Finance packages 0, every office-stage job, EJE-2011 and EJE-2106, users 7. Every one of the 35 timesheet lines that existed before is untouched. After the switch a technician (Mike) used the new Timesheets page himself — 2 new lines, drafts kept and then completed, his comment — exactly as designed.
- **Live, read only** (desktop and phone, as the Master): Timesheets (period, days, autosave status, no Submit, the office's 14 submissions), Attendance (no Submit), My Monthly Forms (both forms, Finance month, Rename, one Submit, history), the forms, PDF, lines and history APIs, the office's read-only view of a technician's forms, the October Finance month, all 11 historical timesheet submissions readable. Health ok, database reachable, email `refuse`, demonstration on, 0 errors in the service log, backup timers healthy.
- **Not done on production, deliberately:** a submission or a rename (they write payroll records) — proved in CI, locally and in the browser suites.

**Rolling back** (`stage-release.ps1 -Rollback`) returns the code to `ad0f3c8`; the database stays at 0052 and is never reversed. Against it the old code reads everything it knows (CI rollback probe). Its limits, none of which loses a row: its Timesheets "Submit timesheet" fails without writing (its ON CONFLICT names the replaced full key); its calendar-month re-submit is refused by the database; payroll submissions, drafts and PDF names made by v1.5.0 stay in the database unseen by it, and are not in its Finance packages until rolled forward.

**Follow-ups (low severity, from the second review; not release-blocking) — all four fixed in v1.5.1 (`e9fe38a`, above), with two-device tests:** a removal can show "failed" until Retry if the line's first save was refused; a remove-then-leave race heals on the next visit unless device storage is unavailable; two lost connections in a row with typing between can drop the newest typing (the person is told and the line reloads); a removal is not serialised against a save from another device. No automated test yet runs two simultaneous saves of one line (the lock is in place).

## RELEASED — `ad0f3c8` = v1.4.0, office repairs: PO, Closed Jobs, Jobs filters (PO-FLOW-1, ARCHIVE-1, JOBS-FILTER-1, 4 November 2026)

Released 21:52:29 UTC from branch `claude/office-repairs` through `stage-release.ps1 -ExpectPending none` after CI run 41913416752 (**74/74**: unit, lint, types, build, PostgreSQL, rollback compatibility, every browser suite incl. `office-filters-check` at three sizes) and an independent review whose findings were fixed. **No migration** (52 applied). Version assigned: **v1.4.0**. Before it: `75c3b6b` v1.3.0, healthy. The checklist release (0051, CHK-SRC) is unchanged.

- **Fresh backup, proven before the switch:** `/var/backups/eje/eje-eje_production-2026-11-04T21-52-14Z` — aes-256-gcm, key `23dba6772da10057`; both artefacts intact and authentic; key check MATCH; **restore test** into a scratch database (jobs 112, users 7, customers 10, machines 18, final documents 57, job media 28, signatures 71, audit events 2 116), then dropped — RESTORE-TESTED.
- **Data identical before and after** (fingerprints): signatures 71, final documents 57, checklist instances 10 and answers 96, checklist versions and questions, timesheet periods 15 and entries 35, monthly submissions 7, Finance packages 0, every job in the office stages with its status and PO, EJE-2011 and EJE-2106 (status and `updated_at`), audit events 2 116.
- **Live, read only** (desktop and phone, 6/6): Jobs — search and the status tabs visible, Advanced filters folded and holding Status, Job type, Priority, assigned-to-me; Closed Jobs — filters folded, newest finished first (EJE-2112, EJE-2106, EJE-2032, …), pages answer; EJE-2113 (Office Handling, no PO) — the panel says it will go to Awaiting PO, nothing pressed. Health ok, email `refuse`, demonstration on; 0 errors in the service log; backup timers healthy.
- **Not done on production, deliberately:** handling a job (it writes) — proved in CI, locally, and in the browser suites.

**What changes on the live system:** a job handled from now on with a PO on it goes to Awaiting Invoice No instead of Awaiting PO (its PO recorded and audited). Jobs already in Awaiting PO stay there until the office records the PO (the form is pre-filled with their order number). No stored row is rewritten.

**Rolling back** (`stage-release.ps1 -Rollback`) returns the code to `75c3b6b`; with no migration the database is unchanged. Jobs the new code handled straight to Awaiting Invoice No are ordinary Awaiting Invoice No jobs to the old code (PO recorded, handling stamped).

## RELEASED — `75c3b6b` = v1.3.0, the business's own checklists and the Service choice (CHK-SRC-1…4, 4 November 2026)

Released 17:46:36 UTC from branch `claude/source-checklists` through `stage-release.ps1 -ExpectPending 0051_source_checklists` after CI run 41871774913 (68/68: unit, lint, types, build, PostgreSQL, rollback compatibility f693747→0051, every browser suite). Version assigned: **v1.3.0**. Before it: host `srv2000625`, serving `f693747` v1.2.0, healthy.

- **Fresh backup, proven before the migration:** `/var/backups/eje/eje-eje_production-2026-11-04T17-46-17Z` — 186 documents, aes-256-gcm (key 23dba6772da10057); verify: both artefacts intact and authentic; key check MATCH; restore test into a scratch database (jobs 105, users 7, customers 9, machines 14, final documents 54, job media 28, signatures 68, audit events 2 034; 186 documents unpacked), then dropped — RESTORE-TESTED. 17 storage keys already missing when taken (the demonstration records, `docs/missing-documents-2026-11-04.md`).
- **Migration 0051 applied** (52 recorded). **Every checklist row that existed before is identical** (instances 10, answers 96, evidence photos 4, the 21 demonstration questions and 6 sections — fingerprints taken before and after); the two demonstration versions now `archived`; Installation 36, Service — Milling 39, Service — Lathe 41 questions current; signatures 68 and final documents 54 identical. The jobs count went 104 → 105 during the window: EJE-2106, a Test & Repair job John Master created on the live site at 17:42 — not part of the release.
- **Live, read only** (desktop and phone): Administration → Checklists shows the three in full, the demonstration wording archived; EJE-2008 (Service) asks "Which Service checklist…", Open is disabled with nothing chosen, and a start with no choice is refused (`checklist_selection_required`) — nothing started; EJE-2002 (Installation) offers the Installation checklist with no choice; EJE-2073 (completed on the demonstration wording) still shows it, and the issued PDFs of EJE-2073 and EJE-2074 are byte-identical to their stored SHA-256. Health ok, email `refuse`, demonstration on; 0 errors in the service log since the switch.
- **Not verified live, deliberately:** completing a source checklist and rendering its PDF on production — that writes a job; it is proved in CI and locally (`source-checklist-document.test.ts`, the browser checks).

**Rolling back:** `stage-release.ps1 -Rollback` returns to `f693747`.

**What 0051 does to the live database** (reviewed line by line; `source-checklists.db.test.ts` runs it on PostgreSQL 16):
- adds columns, every one defaulted (`checklists.kind`, `selection_label`; `checklist_versions.layout`; `checklist_questions.number`, `group_label`, `fields`, `source_note`; `checklist_answers.field_values`; `checklist_instances.checklist_kind`) — no existing row is rewritten;
- extends the immutability guards (a used version's layout, section headings and kind are frozen), and adds a trigger keeping a checklist's recorded kind equal to its version's (a writer that sends none has it filled in — so the release before this one still works against it);
- moves the rule "a Fail needs a note" from each answer row (`checklist_answers_fail_needs_note`, dropped) to the moment of completion (`checklist_instances_fail_needs_note` trigger): the old CHECK refused the technician's tap on **Fail** before the note could be typed — a server error on PostgreSQL, live today; a checklist still cannot be completed over an unexplained Fail;
- provides the `installation` and `service` job types if absent (`ON CONFLICT DO NOTHING` — production's rows untouched; needed on an empty database);
- **archives** the two demonstration versions still current for Installation and Service (`status` only; the guard permits exactly that) — the 10 jobs that answered them (7 completed, 3 in progress: EJE-2007, EJE-2011, EJE-2077) keep their version, answers and documents unchanged;
- inserts the three source checklists, version 1.0, current.

**Before:** fresh backup, verify, key check and restore test (the release does all four); record the checklist fingerprint — `select v.id, v.status, count(q.*) from checklist_versions v left join checklist_sections s on s.version_id = v.id left join checklist_questions q on q.section_id = s.id group by 1,2` and an md5 over `checklist_instances`/`checklist_answers`/`checklist_answer_photos` rows.
**After:** the same fingerprint for every row that existed before is identical; three new versions current with 36, 39 and 41 questions; the two demonstration versions archived; health, version, Administration → Checklists, the Service choice, both Service checklists, Installation and a checklist PDF checked live **read-only or on a disposable job, then cancelled**; service log free of errors.

**Rolling back** (`stage-release.ps1 -Rollback`) returns the CODE to `f693747`; the database stays at 0051, which that code runs against: it ignores the new columns, and the kind trigger fills in what it does not send. What changes while rolled back: a Service job started then is given whichever of the two Service checklists the database returns first (`findForJobType` takes one, unordered) **without being asked** — so a rollback should be short and rolled forward; readings typed into the printed blanks (R/S/T, KPA…) on a checklist still in progress are **cleared** the next time the old code saves that checklist (it rewrites answers without that column); and the new screens are gone. Signed and completed checklists are untouched either way.

**Left as they are, for the owner:** the three checklists already started on the demonstration wording stay on it — EJE-2007 and EJE-2077 (Installation) and **EJE-2011 (Service, in Completion, all 10 items answered)** — because a started checklist is never moved to other wording. If EJE-2011 should be done on the Milling or Lathe checklist instead, that is a decision for the office (all three are demonstration jobs). Putting the demonstration wording back in issue is a data change, not part of a rollback, and is not recommended.

## RELEASED — `f693747` = v1.2.0, the Timesheets follow-up (4 November 2026)

Authorised by the owner on 4 November 2026. Released 10:36:58 UTC (healthy 10:37:01) from branch `claude/timesheets-paper-fixes` through `stage-release.ps1 -ExpectPending none`. Version assigned by the release: **v1.2.0** (after 1.1.0). Before it: host `srv2000625`, serving `46096ac` v1.1.0, firewall script unchanged (`ee451ac`), ufw active.

- **Fresh backup, proven before the switch:** `/var/backups/eje/eje-eje_production-2026-11-04T10-36-46Z` — database 1 559 659 bytes and 184 documents, aes-256-gcm (key 23dba6772da10057); verify: both artefacts intact and authentic; key check: MATCH; **restore test: restored into a scratch database (jobs 104, users 7, customers 9, machines 14, final documents 54, job media 27, signatures 68, audit events 1 952; 184 documents unpacked), then dropped — RESTORE-TESTED**. 17 storage keys were already missing when it was taken (recorded in the manifest). No off-server backup destination is configured (unchanged).
- **Migration:** none; 51 applied. **Health:** ok, PostgreSQL reachable, email `refuse`, demonstration on; 0 error lines in the service log since the switch; the page and worker carry `f693747`.
- **Data identical:** every timesheet table row for row (35 entries, 1 day comment, 13 periods with their snapshots, 0 corrections, 0 working comments, 7 monthly submissions, 0 finance packages); the 1 952 audit events that existed before the release have the same fingerprint (the 23 added during the checks are the read-only scripts' own sign-ins); job-card fingerprints, counts, the frozen prices of all 68 signed jobs, attendance, 9 customers and 13 sites identical.
- **Live, read only:** the working sheet (owner 200, another technician 403); the office's 9 submissions (8 current, 1 replaced) — every original readable, the replaced one labelled replaced, all 9 PDFs downloaded; Finance month views: every current submission in exactly one month (September 5, October 2, November 1), the replaced one in none.
- **Still outstanding:** device checks V1–V13 on real phones and tablets, and printing a multi-page timesheet on a real printer (V13).

**Rolling back:** `stage-release.ps1 -Rollback` returns to `46096ac` (`docs/rollback-4606315.md` §11).

## RELEASED — `46096ac` = v1.1.0, timesheets as a piece of paper (4 November 2026)

Released 4 November 2026 08:14:34 UTC from branch `claude/timesheets-paper` through `stage-release.ps1 -ExpectPending 0050_timesheets_paper`. The release assigned **v1.1.0** itself (`version: v1.1.0 (after 1.0.0; commit 46096ac)` — a `feat` since v1.0.0).

- **Migration:** exactly one pending, `0050_timesheets_paper`, applied; the database is at 51 migrations. `timesheet_periods_range_ordered` present, `timesheet_periods_range_valid` gone, `timesheet_working_comments` created (empty).
- **Backup proven first:** `/var/backups/eje/eje-eje_production-2026-11-04T08-14-18Z` (verified, key-checked, restore-tested). Firewall script unchanged (`ee451ac`), ufw active.
- **CI:** run 41793177998, 68 of 68 steps green (incl. PostgreSQL 479 tests, the rollback probe — `89668e8` against 0050 — and the three Timesheets-as-paper browser steps).
- **Timesheet data identical row for row** (md5 of every row): 35 entries, 1 day comment, 13 periods (snapshots included), 0 corrections, 7 monthly submissions, 0 finance packages. Job-card fingerprints, counts, the frozen prices of all 67 signed jobs, attendance, timesheets, 9 customers and 13 sites identical. 0 error lines in the service log.
- **Live, read only:** a technician's working sheet opens (5 open lines; proposed 1–4 Nov, the day after their last submission); the office lists all 9 existing submissions (8 current, 1 replaced) and opens one with its PDF; another technician is refused both. No submission was made on the live site (a submission is permanent).
- **Mode:** demonstration on, email `refuse`, WhatsApp and email not configured. Nothing was sent.

**Rolling back:** `stage-release.ps1 -Rollback` returns to `89668e8` (`docs/rollback-4606315.md` §10). 0050 stays applied, which `89668e8` reads.

## RELEASED — `89668e8` = v1.0.0, semantic versions for every release (3 November 2026)

Released 3 November 2026 21:16:54 UTC (healthy 21:16:56) from branch `claude/semantic-versioning` through `stage-release.ps1 -ExpectPending none`. **The first release with a semantic version: v1.0.0** (no version was recorded before it; earlier releases are known by commit only).

- **Version:** assigned by the release itself (`version: v1.0.0 (after none; commit 89668e8)`), recorded as `version=1.0.0` in `release-89668e8.state`, held by the health gate, and confirmed from outside: `RELEASED 89668e8 (v1.0.0)`. `/api/health` reports `"commit":"89668e8"` and `"version":"1.0.0"`; the page carries both meta tags; Administration → System shows Version v1.0.0 and Commit 89668e8.
- **Migration:** none; all 50 shipped migrations were already applied.
- **Backup proven first:** `/var/backups/eje/eje-eje_production-2026-11-03T21-16-43Z` (verified, key-checked, restore-tested). Firewall script unchanged (`ee451ac` on both sides; ufw active).
- **CI:** run 41714901909, 65 of 65 steps green (incl. the two-release update check, v1.0.0 → v1.0.1).
- **Tests:** unit 3,761 passed, 0 failed; release-script harness 92/92; stage-release harness 40/40; two-release browser check locally ALL PASSED.
- **Data:** fingerprints, counts, the frozen prices of all 64 signed jobs, attendance, timesheets, 9 customers and 13 sites identical before and after. 0 error lines in the service log.
- **Mode:** demonstration on, email `refuse`, WhatsApp and email not configured. Nothing was sent.

**Rolling back:** `stage-release.ps1 -Rollback` returns to `7acb77e` (no migration in between). The next release is still numbered from 1.0.0 upward — a rollback never frees a version.

## RELEASED — `9fa858f`, the Test & Repair delivery-note photo and the simpler Delivery Note (3 November 2026)

Released 3 November 2026 18:08:52 UTC (healthy 18:08:54) from branch `claude/tr-photo-delivery-note-simplify` through `stage-release.ps1 -ExpectPending 0049_tr_photo_delivery_note_site`.

- **Migration:** exactly one pending migration, `0049`, was applied. The database is at 50 migrations, with the checks `jobs_site_required_unless_delivery_note`, `job_media_purpose_known` and `job_media_reference_photo_internal` in place. All 100 existing jobs still have a site.
- **Backup proven first:** `/var/backups/eje/eje-eje_production-2026-11-03T18-08-36Z`. Firewall scripts unchanged.
- **CI:** run 41685116786, 65 of 65 steps green, none skipped (rollback check: `6ec5655` against 0049, prepare 10/10, probe 13/13).
- **Tests:** unit 3,751 passed, 0 failed; database tests 479 passed.
- **Live verification:** 25/25. One temporary, unassigned Test & Repair job (EJE-2101) was raised through the screen with a delivery-note photo, checked, and deleted through the audited office delete. Its job number is used and the deletion is on the audit trail. Everything else was reads, refused writes and read-only screens at three sizes.
- **Data:** fingerprints, counts, the frozen prices of all 64 signed jobs, attendance, timesheets, 9 customers and 13 sites were identical before and after. There were 0 error lines in the service log.
- **Mode:** demonstration on, email `refuse`, WhatsApp and email not configured.

**Rolling back:** `stage-release.ps1 -Rollback` returns to `6ec5655` (see `docs/rollback-4606315.md` §9). Once a site-less Delivery Note exists, fix forward instead.

## RELEASED — `6ec5655`, physical acceptance follow-up and the Delivery Note (3 November 2026)

Released 3 November 2026 12:15:07 UTC (healthy 12:15:09) from branch `claude/acceptance-delivery-notes` through `deploy/release/stage-release.ps1 -ExpectPending 0048_acceptance_delivery_notes`.

- **Migration:** preflight found exactly one pending migration; only `0048_acceptance_delivery_notes` was applied (additive). The database is now at 49 migrations, and `job_types` includes `delivery_note`.
- **Before the release:** firewall scripts unchanged, and the server's `ufw-apply.sh` matches the reviewed copy. Backup proven first: `/var/backups/eje/eje-eje_production-2026-11-03T12-14-49Z` (verified, key-checked, restore-tested).
- **CI:** run 41629100556 on `6ec5655`, 65 of 65 steps green, none skipped. This includes the new acceptance check at three sizes and the rollback check, which ran `9569c85` against 0048 (prepare 9/9, probe 12/12).
- **Tests:** unit 3,733 passed, 0 failed; database tests 477 passed.
- **Live verification:** 38/38 checks passed (reads, refused writes and read-only screens at three sizes; no record created). There were 0 error lines in the service log. Job-card fingerprints, counts, the frozen prices of all 61 signed jobs, attendance, timesheets, 9 customers and 13 sites were identical before and after. Email and WhatsApp are still not configured, demonstration mode is on, and email is `refuse`.

**Rolling back:** `stage-release.ps1 -Rollback` returns to `9569c85`; see `docs/rollback-4606315.md` §8. Once any Delivery Note exists, fix forward instead.

## RELEASED — `9569c85`, the unsigned job card's documents (3 November 2026)

Released 3 November 2026 07:59:28 UTC (healthy 07:59:30) through `deploy/release/stage-release.ps1 -ExpectPending none`, with **no migration** (preflight: all 48 already applied; migrate: none). Firewall scripts unchanged (the server's `ufw-apply.sh` matches the reviewed copy). Backup proven first: `/var/backups/eje/eje-eje_production-2026-11-03T07-59-16Z` (verified, key-checked, restore-tested). CI run 41593939392 on `9569c85`: all 62 steps green, none skipped. That includes the rollback probe, which now writes every kind of 0047 row (prepare 8/8, probe 11/11). Unit tests 3,714 passed, 0 failed, 19 skipped (the PostgreSQL tests, run in CI). Live: 4/4 checks passed (health; a signed job card refused on the unsigned path; an authorisation without a reason refused; outbox 0 → 0), and 0 error lines in the service log. Job-card fingerprints, counts, the frozen prices of all 60 signed jobs, attendance, timesheets, 8 customers and 12 sites were identical before and after.

**Rolling back:** `stage-release.ps1 -Rollback` returns to `4606315` (same schema; only the unsigned copy's documents are lost). Going further back, to `b3a9014`, is covered in `docs/rollback-4606315.md`.

## RELEASED — `4606315`, the next critical batch (2 November 2026, night)

Released 2 November 2026 20:47 UTC (healthy 20:47:26) through `deploy/release/stage-release.ps1` with migration `0047_batch_2_november` (additive). Backup proven first: `/var/backups/eje/eje-eje_production-2026-11-02T20-47-09Z`. Rollback target `b3a9014` — CI run 41517187236 proved `b3a9014` reads and writes a database at 0047. Live verification 48/48 (nothing written); all existing data identical before and after; still a demonstration deployment; nothing sent.

**Rolling back:** switch to `b3a9014` the way the release tool does. 0047 stays applied. `b3a9014` does not know the `apprentice` role, customers' Custom Rates or day swaps — roll back only before any apprentice account, Custom Rates customer or approved day swap exists, or accept that `b3a9014` will ignore them (it prices every customer at the defaults and shows weekly places only).

## RELEASED — `b3a9014`, the tester's critical fixes (2 November 2026, evening)

Released 2 November 2026 14:18 UTC (healthy 14:18:28) through `deploy/release/stage-release.ps1` with migration `0046_tester_fixes_2_november` (additive). Backup proven first: `/var/backups/eje/eje-eje_production-2026-11-02T14-18-09Z`. Rollback target `6fdb142` — CI run 41455418841 proved `6fdb142` against a database at 0046. Unit tests 3,651 passed, 0 failed (PostgreSQL tests in CI: green); live verification 28/28 (reads and refused writes; nothing written); existing jobs, the frozen prices of all 58 signed jobs, attendance, timesheets, monthly submissions and site pins identical before and after. The live checks created no records (reads, PDFs and refused writes only); the write flows are proven in CI. Retention ran 6 seconds after start: 23 notifications (15 days or older) and 458 activity events (older than 7 days) deleted, as decided.

**After this release, retention runs on its own:** within a minute of start the worker deletes notifications 15 days old or older and activity older than 7 days, and records each run (`npm run retention` on the server shows the last runs). Earlier activity is kept only in the backups.

**Rolling back:** switch to `6fdb142` the way the release tool does. 0046 stays applied; `6fdb142` reads a database at 0046 (proved in CI), although it does not know the Awaiting Invoice No status — roll back only before any job reaches it, or move such jobs on first.

## RELEASED — `6fdb142`, the standby calendar (2 November 2026)

Released 2 November 2026 10:48 UTC (healthy 10:48:54) through `deploy/release/stage-release.ps1` with migration `0045_standby_calendar` (additive). Backup proven first: `/var/backups/eje/eje-eje_production-2026-11-02T10-48-37Z` (verified, key-checked, restore-tested). Rollback target `5d726d3` — CI run 41427305039 proved `5d726d3` reads and writes a database at 0045. Unit tests 3,630 passed, 0 failed, 19 skipped (the PostgreSQL tests, run in CI); live verification 57/57 (and the attendance/timesheet regression 46/46): the calendar and both swap workflows on the live site, every refusal, in-app notifications only (the outbox unchanged), then the test places and eligibility removed again through the audited routes. Every job-card fingerprint, job count, signed price, attendance and timesheet record and site pin identical before and after.

**Rolling back:** switch to `5d726d3` the way the release tool does (it keeps the previous release directory). 0045 stays applied — `5d726d3` never reads the standby tables, and the rollback-compatibility check proves it works against them.

## NEXT RELEASE — from `claude/office-workflow-parts` (checklist prepared 26 October 2026, NOT RUN)

**Nothing below has been run.** It needs the owner's approval of the work and a
separate approval to deploy. It is written so that whoever runs it can tell, at
each step, whether to continue.

*Amended 27 October 2026:* the approved decisions batch (BD-23 offline
signature, BD-27 correction acknowledgement, BD-26/BD-30 hardening) adds **no
migration**. The pending list below is unchanged. Two things to check after
the release, both read-only: the office's **Field Captures** screen opens (held
signatures that cannot be verified land there), and a correction to labour,
parts or the work performed cannot be raised as needing no acknowledgement.

### DEPLOYED — 27 October 2026: `51fb112` was live (superseded by `ef0f695` on 28 October, below)

Run by the owner with the guarded release tool. From the release output:
running commit `51fb112`; migrations `0032_office_lifecycle` and
`0033_attendance_timesheets` applied (the live release was `e85f239`, so two
were pending, not four); backup, verification, key check and restore test
completed; health reports PostgreSQL reachable; previous release `e85f239`
retained for rollback (`stage-release.ps1 -Rollback`). **The rollback limit
applies from now on:** once the office moves a job into Office Handling,
Awaiting PO or Invoiced, the previous release cannot show it.

Verified afterwards from outside the server (`docs/staff-testing.md`, end):
health, roles, the full job lifecycle through Invoiced, refusal, corrections,
held signatures (accepted and referred), parts restrictions, media, PDFs,
attendance, timesheets, exports, and offline capture and signature in a real
browser. `deployment: "demonstration"` and `demoSwitcher: true` are this
site's intended settings (`docs/demonstration-isolation.md`): its database
holds fictional data only, and nothing real may be entered while the switcher
is on.

### DEPLOYED — 1 November 2026 (23:13 UTC): `5d726d3` — optional machine on installations and services; test bench quantity; parts received in Labour, travel and parts (migration 0044)

**`5d726d3` is live** (full SHA `5d726d3972710dcd4bf9c66341cccd6b13298be0`; CI run
41358500488 completed, success, every job and step green, including the PostgreSQL
tests and rollback compatibility of `7c0ca94` against 0044; the run before it,
41355889260, failed one forms-regression step — the test reused a form the new
behaviour leaves — fixed in `5d726d3`). Read-only check passed (`srv2000625`, script
SHA-256 `5ab56162…b3c6`, 177 872 MB free). Released with
`-ExpectPending 0044_test_bench_quantity`: backup proven
`/var/backups/eje/eje-eje_production-2026-11-01T23-13-05Z`; 0044 applied; switched
23:13:18Z, healthy 23:13:20Z. Rollback target: `/opt/eje/releases/7c0ca94`.

Verified afterwards (14/14 and 46/46): health `5d726d3`, ok, PostgreSQL reachable;
the new-job form offers *Machine (optional)* for an installation and a service at
1440, 768 and 390 wide (nothing submitted); every job reads test bench quantity 1;
email and WhatsApp Not configured, Maps configured (key loaded by the restart), no
key in any response, page or the new browser bundle; the attendance and timesheet
regression unchanged. Data identical before and after: every user's attendance,
timesheet lines and submissions, all 11 site pins, the frozen prices of all 55
signed jobs, job counts (65/16/40/26) and four job cards byte-identical. No error in
the service log since the switch.

Also on 2 November 2026, outside the release: the retired tracker removed from the
VPS after a verified archive (issue #41), and local OCR switched on for this
testing environment (`docs/library-ocr.md` §6, issue #63).

### DEPLOYED — 1 November 2026: `7c0ca94` — own attendance only; no Coordinator timesheet; no technician CSV export; PDFs list recorded days (migration 0043)

**`7c0ca94` is live** (full SHA `7c0ca948ddd8a996517e68a9d9f83ad8c24c7ea9`; CI run
41342400983 completed, success, every job and step green, including the
PostgreSQL tests and rollback compatibility of `b946fd3` against 0043). Read-only
check passed (`srv2000625`, script SHA-256 `5ab56162…b3c6`, 178 902 MB free).
Released with `-ExpectPending 0043_coordinator_attendance_only`: backup proven
`/var/backups/eje/eje-eje_production-2026-11-01T20-06-56Z`; 0043 applied; switched
20:07:10Z, healthy 20:07:13Z. Rollback target: `/opt/eje/releases/b946fd3` (it reads
a database at 0043 — proved by the rollback probe).

Verified afterwards from outside (46/46): health `7c0ca94`, ok, PostgreSQL
reachable; a Master, a Coordinator and a Technician each refused (403) recording
another user's day; the register read gone; a Coordinator refused a timesheet
line and their own sheet (403 `timesheet_not_required`) yet still reads a
technician's; a technician refused the CSV export; the Coordinator's October
attendance only, her September (submitted with a timesheet) unchanged; September
forms list recorded days only and both PDFs render; screens at 1440, 768 and 390
for all three roles — own days, no Team register, no technician Export CSV, no
Coordinator timesheet, the export on EJE Monthly Forms — no page errors. Every
user's attendance and timesheet lines and the September/October submissions
identical before and after (and after the refused requests); job counts unchanged
(64/16/39/26); EJE-2050/2046/2041/2001 job cards byte-identical.

### DEPLOYED — 1 November 2026: `b946fd3` — dedicated EJE WhatsApp number; Google-compliant pin retention (no migration)

**`b946fd3` is live** (full SHA `b946fd3b531d7049be592ec9c9390e8065abfa0f`; CI run
41312989337 completed, success, every job and step green, including rollback
compatibility of `42e71fc` against 0042). Read-only check passed
(`srv2000625`, script SHA-256 `5ab56162…b3c6`, 179 983 MB free). Released with
`-ExpectPending none`: backup proven
`/var/backups/eje/eje-eje_production-2026-11-01T14-17-09Z`; preflight found all
43 shipped migrations applied; database not touched; switched 14:17:21Z,
healthy 14:17:23Z. Rollback target: `/opt/eje/releases/42e71fc` (same schema).

Verified afterwards from outside, read-only (21/21): health `b946fd3`, ok,
PostgreSQL reachable, email `refuse`; all three integrations Not configured;
WhatsApp shown as "WhatsApp — dedicated EJE number", naming
`WHATSAPP_DEDICATED_NUMBER` as missing, the office number "Not connected and
never used", the real API test not passed; a test message refused (no test
recipient), nothing sent; no credential-shaped value in the response; every
site pin identical before and after (11 sites, 9 office-verified, 0 from
Google); the office pin says "Entered by the office: kept" at 1440, 768 and
390 wide; no page errors. Job counts unchanged (open 64, closed 16, signed 39,
issued 26); EJE-2050/2046/2041/2001 job cards byte-identical.

### DEPLOYED — 1 November 2026: `42e71fc` — WhatsApp, Google Maps and email integration, with migration 0042

**DEPLOYED — 1 November 2026: `42e71fc` is live** (full SHA
`42e71fc08f2175d51d5e037455004dfa88edfa49`; CI run 41290579780 completed, success, every
job and step green, including rollback compatibility of `c68b3c3` against 0042).
Read-only check passed (`srv2000625`, script SHA-256 `5ab56162…b3c6`, 181 072 MB free).
Guarded release tool with `-ExpectPending 0042_integrations`. Backup proven
`/var/backups/eje/eje-eje_production-2026-11-01T09-21-08Z`; 0042 applied (additive);
switched 09:21:21Z, healthy 09:21:23Z. Rollback target `c68b3c3` (`stage-release.ps1 -Rollback`).
Email, WhatsApp and Google Maps are NOT configured on the server: each says so in
Administration → Integrations, and nothing is sent. Configuring them is
`docs/integrations-setup.md`; it needs a restart of `eje`, not a release.
Register: `docs/delivery-register-2026-11-01-integrations.md`.

### DEPLOYED — 31 October 2026: `c68b3c3` — the tester's critical fixes, with migration 0041

**DEPLOYED — 31 October 2026: `c68b3c3` is live** (full SHA
`c68b3c3e4023dff4ad2bb836e9231aa3bbf1dc5f`; CI run 41242461859 completed, success, every
job and step green, including rollback compatibility of `316544f` against 0041).
Guarded release tool with `-ExpectPending 0041_repair_items`. Backup proven
`/var/backups/eje/eje-eje_production-2026-10-31T21-41-26Z`; 0041 applied (additive:
`jobs.more_repair_items`); switched 21:41:38Z, healthy 21:41:41Z. Rollback target
`316544f` (`stage-release.ps1 -Rollback`), which reads a database at 0041 and keeps
the extra parts intact. Register: `docs/delivery-register-2026-10-31-critical.md`.

### DEPLOYED — 31 October 2026: `316544f` — the system-wide desktop and tablet audit

**DEPLOYED — 31 October 2026: `316544f` is live** (full SHA
`316544fd28e0bf60809b98f87d65891ed0b2876e`; CI run 41172590800 completed, success, every
job and step green). Guarded release tool, `-ExpectPending none`; no migration or schema
change since `42cd3d3`. Backup proven `/var/backups/eje/eje-eje_production-2026-10-31T05-52-24Z`;
all 41 migrations already applied; migrate: none; switch at 05:52:32Z, health at 05:52:34Z;
from outside `316544f`, ok, PostgreSQL reachable. **Rollback target: `42cd3d3`.** Verified
afterwards, read-only: the tablet audit on production 9/9; tester's changes 22/22; API, PDFs
and records 36/36; Attendance 17/17; update mechanism 8/8; records and four issued job cards
unchanged. Detail: `docs/delivery-register-2026-10-31.md` (Release).

### DEPLOYED — 30 October 2026: `42cd3d3` — the tester's changes and the timesheet freeze (superseded by `316544f` on 31 October, above)

**DEPLOYED — 30 October 2026: `42cd3d3` is live** (full SHA
`42cd3d3b9bd71f93d71f6f2ec87c3adbb72a296a`; CI run 41128358488 completed, success, every
job and step green). Guarded release tool, `-ExpectPending none`.

- **Read-only check**: `srv2000625`; `e54f7d3` serving, healthy; `/opt/eje/releases/42cd3d3`
  new; 184 286 MB free; script SHA-256 `5ab56162…b3c6` matched. CHECK PASSED. No migration
  or schema file changed since `e54f7d3`.
- **Release**: 1/6 build; 2/6 **backup proven** —
  `/var/backups/eje/eje-eje_production-2026-10-30T21-22-32Z`, verified, key-checked,
  restore-tested; 3/6 all 41 migrations already applied; 4/6 **migrate: none**; 5/6 switch
  `e54f7d3` → `42cd3d3` at 21:22:40Z; 6/6 health at 21:22:42Z. From outside: health
  `42cd3d3`, page and worker present `42cd3d3`. **Rollback target: `e54f7d3`.**
- **Verified afterwards, read-only** (nothing saved, sent, submitted or recorded):
  the tester's changes **22 of 22** (sidebars for all three roles; Jobs controls; My Jobs =
  the server's 8; In progress 10 = 10 rows, Awaiting completion 27 = 27 rows; the timesheet
  freeze trigger keeps the form, every field takes typing, then cancelled; Send visible at
  tablet size; Users and `/api/staff` availability-only; the Coordinator's Attendance; EJE
  Monthly Forms with every role, "2 submitted, 3 not submitted of 5"); API, PDFs and records
  **36 of 36** (62/15/37/25 jobs unchanged; four issued job cards byte-identical; both
  monthly PDFs one page); Attendance controls **17 of 17**; update mechanism **8 of 8**.

As planned:

**The owner instructed this release on 30 October 2026.** What it carries and its tests:
`docs/delivery-register-2026-10-30.md` (second part). Live is `e54f7d3`. **No migration,
no schema change** — a code-only release: `-ExpectPending none`, the server's preflight
must show all 41 shipped migrations already applied. Rollback target: `e54f7d3`.

### DEPLOYED — 30 October 2026: `e54f7d3` — the Attendance page's monthly form and the update notice on every release (superseded by `42cd3d3` the same evening, above)

**DEPLOYED — 30 October 2026: `e54f7d3` is live** (full SHA
`e54f7d31ad424ed64209cc12cd546629e8c74ca3`; CI run 41114092953 green on every
job and step, as was run 41112183321 on `1254e13`). Run by Claude on the
owner's instruction with the guarded release tool, `-ExpectPending none` — the
first CODE-ONLY release.

- **Read-only check**: host `srv2000625`; `a46e767` serving, healthy, database
  reachable; `/opt/eje/releases/e54f7d3` new; 185 323 MB free; script SHA-256
  `5ab56162…b3c6` matched. CHECK PASSED. No migration or schema file changed
  since `a46e767` (journal: 41 entries, last `0040_monthly_payroll`).
- **Release**, from the server: 1/6 build beside the live release; 2/6 **backup
  proven** — `/var/backups/eje/eje-eje_production-2026-10-30T19-56-09Z`,
  verified, key-checked, restore-tested; 3/6 preflight: all 41 shipped
  migrations already applied; 4/6 **migrate: none — the database is not
  touched** (`migrated=none` on record); 5/6 switch `a46e767` → `e54f7d3` at
  19:56:18Z; 6/6 health at 19:56:20Z. From outside: health `e54f7d3`, and
  "update notice: page carries build e54f7d3; worker for e54f7d3 served".
  "RELEASED e54f7d3 - confirmed from outside; installed apps will be offered the
  update." **Rollback target: `a46e767`** (same database).
- **Verified afterwards from outside** (read-only — nothing submitted, prepared
  or recorded): API/screens **36 of 36**; live Attendance in an emulated rugged
  tablet **17 of 17**; the live update mechanism **8 of 8** — see
  `docs/staff-testing.md`, "Automated post-deployment verification — 30
  October 2026".

The release as planned (kept as the record of what was checked):

**The owner instructed this release on 30 October 2026.** What it carries and
its tests: `docs/delivery-register-2026-10-30.md`. Live is `a46e767` (journal
at 0040, all applied). **No migration** — so it is the first CODE-ONLY release
through the guarded tool, which now supports one:

```powershell
# from the worktree, under the PowerShell tool (Windows OpenSSH sees the agent)
.\deploy\release\stage-release.ps1 -Sha <full-sha> -CheckOnly -ExpectPending none -SshExe "$env:WINDIR\System32\OpenSSH\ssh.exe" -LogDir <scratch>
.\deploy\release\stage-release.ps1 -Sha <full-sha> -ExpectPending none -SshExe "$env:WINDIR\System32\OpenSSH\ssh.exe" -LogDir <scratch>
```

The server still builds beside the live release, backs up, verifies,
key-checks and restore-tests; its preflight must show all 41 shipped
migrations already applied (anything pending → STOP, nothing changed); nothing
is migrated; then the switch and the health gate with automatic rollback. The
tool then checks from outside that a freshly served page carries the new build
and the worker answers for it — the condition for installed apps to be offered
the update. **Rollback target: `a46e767`** (identical database; nothing in this
release writes a new shape).

**FROM THIS RELEASE ON, EVERY RELEASE SHOWS THE UPDATE NOTICE** with no extra
step: it is detected from the build commit the release script already stamps.
**The first time is different:** a tablet left open on `a46e767` runs the old
detection, which only reacts when the worker file's bytes change. This release
changes them (a recorded comment in `public/eje-sw.js`), so such a tablet shows
the old bar ("A new version of EJE is ready") when its browser next checks the
worker — on its next page load, or within about 24 hours — and any tablet that
opens EJE afresh simply gets this release. From this release on, an open page
notices within five minutes or on coming back to the screen.

### DEPLOYED — 29 October 2026: `a46e767` — monthly payroll forms, the Finance package and the app mark (superseded by `e54f7d3` on 30 October, above)

**DEPLOYED — 29 October 2026: `a46e767` is live** (full SHA
`a46e767271ea668b531b8f923302b44ff2c58679`; CI run 40941799194 green on every
step, including the PostgreSQL suite and rollback compatibility of `1a34d1c`
against a database at 0040). Run by Claude on the owner's instruction with the
guarded release tool (`-SshExe` Windows OpenSSH, the key in the owner's
ssh-agent; logs kept outside the working tree).

- **Read-only check**: host `srv2000625`; `1a34d1c` serving, healthy, database
  reachable; `/opt/eje/releases/a46e767` new; 186 383 MB free; script SHA-256
  `76e3ef4d…94e4` matched. CHECK PASSED.
- **Release** (`-ExpectPending 0040_monthly_payroll`), from the server: 1/6 build
  beside the live release; 2/6 **backup proven** —
  `/var/backups/eje/eje-eje_production-2026-10-29T19-50-01Z`, verified,
  key-checked, restore-tested before anything changed; 3/6 preflight showed
  exactly 0040 pending; 4/6 migrated, every shipped migration applied after;
  5/6 switch `1a34d1c` → `a46e767` at 19:50:14Z; 6/6 health at 19:50:16Z.
  "RELEASED a46e767 — confirmed from outside." **Rollback target: `1a34d1c`.**
- **Verified afterwards from outside** (read-only — no submission, package,
  attendance, timesheet or setting created): **36 API/screen checks and 8 live
  tablet-browser checks passed** — see `docs/staff-testing.md`, "Automated
  post-deployment verification — 29 October 2026, against `a46e767`".
- **Email unchanged**: `refuse`; the Finance recipient is not set on
  production. Monthly forms and package preparation work there; Send is
  refused with a message until EJE's Microsoft 365 credentials and an approved
  Finance address exist.

The release as planned (kept as the record of what was checked). What it
carries and its tests: `docs/delivery-register-2026-10-29.md`. Live was
`1a34d1c`, so **one migration was pending**, forward-only and additive:

- `0040_monthly_payroll` — `users.document_name` (nullable, bounded);
  `system_settings.finance_email` (defaulted to empty = not configured);
  `monthly_submissions` (write-once, must reference the same technician's
  sent period for exactly that month); `finance_packages` (guard trigger:
  manifest and recipient fixed once prepared, only the allowed status moves,
  never deleted, one open package per month).

```powershell
.\deploy\release\stage-release.ps1 -Sha <SHA> -CheckOnly -ExpectPending 0040_monthly_payroll -SshExe "$env:WINDIR\System32\OpenSSH\ssh.exe" -LogDir <a folder outside the repository>
.\deploy\release\stage-release.ps1 -Sha <SHA> -ExpectPending 0040_monthly_payroll -SshExe "$env:WINDIR\System32\OpenSSH\ssh.exe" -LogDir <a folder outside the repository>
```

`-SshExe` names Windows' own ssh, which uses the Windows ssh-agent holding the
key (launched from Git Bash, Git's ssh is found first and cannot see that agent
— the 29 October first attempt failed that way, harmlessly). `-LogDir` keeps
the tool's logs out of the working tree.

**Compatibility, both ways — proved in CI.** `scripts/release/rollback-compat.sh`
now pins the live `1a34d1c`: this release migrates a disposable database to
0040 and writes a name on documents, a Finance recipient, a submitted month and
a sent package; `1a34d1c`'s own code then reads and saves users and settings
(leaving the new columns untouched), reads attendance, timesheets and
corrections, the library and jobs. The backup and restore test run before the
migration (step 2).

**Rollback.** `1a34d1c` ignores the new columns and tables. It cannot show
monthly forms, the Finance package, names on documents or the recipient; its
attendance has no monthly lock; the submitted months and packages stay in the
database and storage untouched. No down migration exists or is claimed.

**Email.** Production email is `refuse` (no Microsoft 365 credentials).
Monthly forms and package preparation work; Send to Finance is refused with a
message, and nothing is recorded as sent. Real delivery needs the credentials
and a Finance address set by a Master — not invented here.

**Tablets.** The service-worker cache moves to v2 (the icons changed): an
installed tablet picks up the new build and icons on its next update; refresh
every tablet before testing (staff testing H0).

### DEPLOYED — 29 October 2026: `1a34d1c` — the real-world reviewer's changes, the owner's decisions and timesheet corrections (superseded by `a46e767` the same day, above)

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

The release as planned (kept as the record of what was checked). The changes
and their tests are in `docs/reviewer-feedback-2026-10-28.md`. Live was
`ef0f695`, so **three migrations were pending**, in order, all forward-only and
additive (new nullable or defaulted columns, new tables with write-once
triggers, new enum values; nothing dropped, no row rewritten):

- `0037_reviewer_timesheets_attendance` — `attendance.absence_reason`; on
  `timesheet_entries` `workshop`, `callout_amount_cents`, `callout_shared`,
  `internal_km`, `customer_km`; `timesheet_months` (superseded by 0038, kept).
- `0038_timesheet_periods_delivery_notes` — `timesheet_periods` (the From/To
  period: its comment and its Send to office) with `timesheet_periods_guard`
  (write-once once sent; sent periods never overlap); copies any
  `timesheet_months` row across; `notification_type` gains
  `timesheet_submitted`; `delivery_note_documents` (the courier's issued
  Delivery Note, one per job, write-once).
- `0039_timesheet_corrections` — `timesheet_corrections` (TS-16: a correction of a
  sent period, decided once by the office) with `timesheet_corrections_guard`;
  `notification_type` gains `timesheet_correction_requested` and
  `timesheet_correction_decided`.

```powershell
.\deploy\release\stage-release.ps1 -Sha <SHA> -CheckOnly -ExpectPending 0037_reviewer_timesheets_attendance,0038_timesheet_periods_delivery_notes,0039_timesheet_corrections
.\deploy\release\stage-release.ps1 -Sha <SHA> -ExpectPending 0037_reviewer_timesheets_attendance,0038_timesheet_periods_delivery_notes,0039_timesheet_corrections
```

**Order and compatibility.** All three together, in order (0038 builds on 0037,
0039 on 0038). The release script applies them while `ef0f695` keeps serving,
then switches; an unhealthy new release is rolled back to `ef0f695` on the
migrated database. That combination is proved in CI by
`scripts/release/rollback-compat.sh` (now pinned to `ef0f695`): ef0f695's own
preflight, attendance/timesheet repository, library and jobs code run against a
database at 0039 holding every new kind of row. The backup and its restore test
run BEFORE the migration (step 2 of the script); a failed migration stops with
`ef0f695` still serving. The
backup's reference scan now also counts `delivery_note_documents.storage_key`
(its job-card column is named `job_card_document_key` so it is not counted
twice). Real email and WhatsApp delivery still need EJE's credentials; a
submitted timesheet notifies the office in-app only.

**Rollback.** `ef0f695` ignores the new columns and tables, so a rollback stays
possible. What it cannot show: absence reasons, Workshop lines, call-out amounts,
kilometres, period comments, sent timesheets, `timesheet_submitted`
notifications and issued Delivery Notes recorded after the release (they stay
in the database and storage). A timesheet sent under the new release would be
editable again under the old one — the old release knows no lock — though the
sent snapshot and every correction stay untouched. The migrations are NOT
reversed by a rollback and need not be; there is no down migration, and none is
claimed. Recovery from a damaged database is the verified backup the release
takes before migrating (`docs/vps-backups.md`), restored by a person.

**Refresh every tablet after the release, before any courier collection.** A
courier collection is now signed on its Delivery Note, whose identity (`dln1:`)
an older build does not compute: an older build would show the courier the
priced job card, and a signature it holds offline would be referred to Field
Captures rather than applied (the courier signs again — nothing is attached to
the wrong document).

**After the release** (read-only checks, then `docs/staff-testing.md` section H):
`/api/health` names the new commit; Attendance asks for a reason on Absent; a
technician's Timesheets show no NT box, oldest day first, the From/To period
with Preview / Save / Print / Send to office; a courier collection's signature
step shows the Delivery Note.

### DEPLOYED — 28 October 2026: `ef0f695` was live (superseded by `1a34d1c` on 29 October, above)

Run by the owner with the guarded release tool (fixed first in `3194e69`, so
`-ExpectPending` takes several tags). From the release output: running commit
`ef0f695`; migrations `0034_manual_timesheets`, `0035_test_bench_fee` and
`0036_chat_deleted_for` applied; backup and restore verification passed;
health reports PostgreSQL reachable; previous release `51fb112` retained for
rollback (`stage-release.ps1 -Rollback`).

**Verified afterwards from outside the server** (28 October 2026; results at
the end of `docs/staff-testing.md`): `/api/health` independently reports
`ef0f695`, PostgreSQL reachable, `email refuse`, `deployment demonstration`;
all three migrations proven by use — manual timesheet lines saved, edited,
removed, read back and exported (0034); the test bench fee set, ticked on a
job, frozen in the signed pricing snapshot and on the PDF (0035); a chat
deleted for one participant stays deleted when re-read (0036). 92 API checks
and 38 browser checks passed; no application defect blocks staff testing. The
schema ledger itself was not read (that needs the server); the release
output above is the record of it.

The release carried **three migrations**, all forward-only and additive (new
table, new columns with defaults, a replaced trigger function; no row is
rewritten):

- `0034_manual_timesheets` — the `timesheet_entries` table (manual timesheets).
- `0035_test_bench_fee` — `system_settings.test_bench_fee_cents` (default 0),
  `jobs.test_bench_applied` (default false), `pricing_snapshots.test_bench_fee_cents`
  (default 0), and `refuse_signed_jobcard_rewrite` extended to protect the new
  job column after signature.
- `0036_chat_deleted_for` — `chat_participants.deleted_at` (nullable).

```powershell
.\deploy\release\stage-release.ps1 -Sha <SHA> -CheckOnly -ExpectPending 0034_manual_timesheets,0035_test_bench_fee,0036_chat_deleted_for
.\deploy\release\stage-release.ps1 -Sha <SHA> -ExpectPending 0034_manual_timesheets,0035_test_bench_fee,0036_chat_deleted_for
```

**Tool fix (28 October 2026).** The first attempt was refused locally, nothing
contacted: typed at a PowerShell prompt, `a,b,c` is an array, and the old
`[string]$ExpectPending` joined it with spaces into one invalid tag. The
parameter is now `[string[]]`; each element may also be comma-separated (the
`-File` form), and every tag is still checked (format, strictly ascending, no
repeats, no empty or spaced tag) before anything is contacted, then again on
the server. Run it from a checkout at or after the fix commit;
`deploy-release.sh` is unchanged (sha256
`76e3ef4d3affab370f7f05a120b6286a08b71da5938119e27c28f120f06e94e4`).

**Rollback.** `51fb112` ignores the new table and columns, so
`stage-release.ps1 -Rollback` stays possible; what it cannot show are the
manual timesheet lines, the test bench fee and chat deletions recorded after
the release (they stay in the database and return when this release does).
Signed totals that include a test bench fee are frozen in their pricing
snapshots, but `51fb112` does not print that line.

**After the release** (read-only checks, then `docs/staff-testing.md` section G):
`/api/health` names the new commit and PostgreSQL reachable; Administration →
Settings shows *Test bench fee*; a technician sees *Timesheets*, *Attendance*
and *Field Captures*; Messages offers *Delete chat*.

### Running it — the commands, in order (27 October 2026)

The owner authorised deploying this branch to the existing VPS for staff
testing on 27 October 2026. The tooling connects with the passphrase-protected
key `%USERPROFILE%\.ssh\eje_vps`, so **a person types the passphrase**: run
these in your own PowerShell window, in the worktree, with `<SHA>` the full
commit hash given in the release report (CI green on it).

```powershell
# 0. Read-only. Prints the host, the live commit and health, the migration ledger.
.\deploy\release\stage-release.ps1 -Sha <SHA> -CheckOnly

# 1. The release, with the pending list step 0 printed — one of:
.\deploy\release\stage-release.ps1 -Sha <SHA> -ExpectPending 0030_library_page_coverage_unknown,0031_test_repair_date_received,0032_office_lifecycle,0033_attendance_timesheets
.\deploy\release\stage-release.ps1 -Sha <SHA> -ExpectPending 0032_office_lifecycle,0033_attendance_timesheets
```

The release script builds beside the live release, takes a backup and proves
it restores, refuses anything but the exact pending list, migrates, switches,
and health-checks — rolling back automatically if the new release is
unhealthy. Then run `docs/vps-smoke-test.md` and hand staff
`docs/staff-testing.md`.

### Which migrations are pending — VERIFY, do not assume

*Superseded 29 October 2026: this section describes the state before `e85f239`. The current pending list is in the newest NEXT section at the top of this file; the release tool always verifies it against the server (preflight) and refuses anything else.*

The last release this repository records as LIVE is `4634d5d` (migrations up to
`0029`). The `e85f239` release below (0030, 0031) is recorded as prepared and
**not run**. So:

| What is live | Pending for this release | `-ExpectPending` |
|---|---|---|
| `4634d5d` (the last recorded state) | 0030, 0031, 0032, 0033 | `0030_library_page_coverage_unknown,0031_test_repair_date_received,0032_office_lifecycle,0033_attendance_timesheets` |
| `e85f239` (if it was released after this was written) | 0032, 0033 | `0032_office_lifecycle,0033_attendance_timesheets` |

**Step 0 decides which.** The read-only check prints the live commit and the
migration ledger; the release tool then refuses anything but the exact ordered
list it is given, so passing the wrong row stops the release before anything
changes. All four migrations are forward-only (0030 replaces one check
constraint on the library index; 0031 adds one nullable column; three statuses, five columns, four checks and a
trigger in 0032; two new tables in 0033). None rewrites a row.

### The checklist

| # | Step | Command / where | Pass looks like | Evidence to keep |
|---|---|---|---|---|
| 0 | Read-only check | `stage-release.ps1 -Sha <full SHA> -CheckOnly` | Host `srv2000625`, the live commit and its health, the ledger count, free disk | The printed output |
| 1 | Environment declared | `/etc/eje/eje.env`: `EJE_DEPLOYMENT=production` or `demonstration` | Preflight's *Deployment* line agrees with the database | Preflight output |
| 2 | Fresh backup, PROVEN | `npm run backup`, then `backup:verify`, `backup:key-check`, `backup:restore-test` (§1, §1a) | All four pass; restore test reads `RESTORE-TESTED` | The backup's directory name and the four outputs |
| 3 | Preflight | `npm run preflight -- --expect-db eje_production` | Only the expected *Migrations* FAIL naming exactly the pending list above, plus the one accepted FAIL for this server; **Customer sites** reported (a WARN with a count is not a stop — see step 9) | Preflight output |
| 4 | Migrate | `npm run db:migrate` | Preflight: `all 34 applied` | Preflight output |
| 5 | Switch, restart | §6 | — | — |
| 6 | Health | `curl -s localhost:3000/api/health` and from outside | `commit` = the release, `status: ok`, `database: reachable`, `email` and `deployment` as expected | The JSON |
| 7 | Integrations, configuration only | `npm run integrations:check` | Says exactly which of Microsoft 365 / WhatsApp are configured; **sends nothing** | Output |
| 8 | Integrations, live probe — only once EJE's credentials are installed | `npm run integrations:check -- --probe` | Graph token acquired and the sender mailbox readable; WhatsApp token and phone number accepted and both templates APPROVED. **Still sends nothing to a customer** | Output |
| 9 | Legacy multi-site customers | Preflight *Customer sites* | A count. **Do not consolidate from the server.** The office consolidates each one in the application (Customers → legacy filter → *Keep as the customer's site*); the one-site database constraint is a later release, once this reads zero | The count |
| 10 | VPS smoke test | `docs/vps-smoke-test.md` | Every step passes | The run |
| 11 | Backups scheduled | `systemctl list-timers 'eje-backup*'` (`docs/vps-backups.md` §4) and an off-site destination set (§5) | Both timers listed with a next run; preflight's *Off-site backup* is OK | Output |

### Rollback, and its one hard limit

Switching back to the previous release directory is §6 in reverse and is safe
**until the office uses the new workflow**:

- **0032 (office lifecycle).** Once any job has entered *Office Handling*,
  *Awaiting PO* or *Invoiced*, an earlier release cannot label or act on it — the
  statuses do not exist in its code. **Roll back only before the office has
  handled a job, or decide what to do with those jobs first.** The migration
  itself is not undone; the columns are nullable and the earlier code never
  names them.
- **0033 (attendance, timesheet comments).** Two tables the earlier release
  never reads. Harmless to roll back over; anything recorded stays.
- **0030, 0031.** Proven rollback-compatible by `scripts/release/rollback-compat.sh`
  in CI.
- **Never** restore a backup over the live database to "roll back": §6 of
  `docs/vps-backups.md` restores into a NEW database and swaps.

## RELEASE e85f239 — two migrations, 0030 then 0031 (prepared 25 October 2026, NOT YET RUN)

**From `4634d5d` (live) to `e85f239`** — everything in `de0d9b6` (JOB-EDIT-1
#72, LIB-TEXT-1 #70), the job-forms work, and the release tool as fixed after
the two live attempts. **Nothing below has been run against the server. A live
release needs the owner's separate approval.**

```
RELEASE=e85f23935bb4c62357371a343fe9389acfeee6b2   # full hash, always
LIVE=4634d5d061c02f3aa9af034be4363403a87f18cf
```

**Before it: confirm the database is still at 30 migrations.** The second live
attempt of `de0d9b6` stopped at the migration step; the cause found in the code
(the production-migration intent was not passed) means the database was not
touched, but that is to be confirmed read-only — ledger count 30, and
`library_document_text_pages_indexed_matches_state` still `pages_indexed > 0`.
If it reads 31, stop and report: the expected list below would then be wrong,
and the gate would stop the release anyway. The `de0d9b6` build directory left
on the server is not used and not touched: this release builds in
`/opt/eje/releases/e85f239`.

### What this release adds to the de0d9b6 inventory below

| Area | What changes at runtime | Action needed |
|---|---|---|
| **Database** | **Two migrations, in this order:** `0030_library_page_coverage_unknown` (relaxes one CHECK) and `0031_test_repair_date_received` (one nullable column, `jobs.date_received`; no backfill). Ledger **30 → 32** | Applied by step 4, in journal order, in one run. **Proven in CI**: the upgrade path through the real migrator, and both migrations against PostgreSQL |
| **Rollback compatibility** | The live release reads, searches and writes a database at **0031**: the library states, and JOBS — one written WITH a date received, and one of its own | None. **Proven in CI** with the live release's own code (`scripts/release/rollback-compat.sh`) |
| **Permissions** | New `settings.rates` and `settings.checklists` (Master and Coordinator); `settings.manage` and discounts stay a Master's | None — capabilities are code |
| **Job forms** | Test & Repair "What is the Job?" (Date received new); Parts attachments photos only (server-enforced); review-page PDF button | None |
| **Environment, dependencies, units, binaries** | **No change** beyond the de0d9b6 inventory — `package-lock.json` unchanged | None |

### The steps — as for de0d9b6, with these differences

The tool's default expected list is `0030_library_page_coverage_unknown,
0031_test_repair_date_received`. It is checked against the release's own
journal (they must be its newest two, in order), then against the preflight.

**0. Read-only check**

```powershell
powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Sha e85f23935bb4c62357371a343fe9389acfeee6b2 -CheckOnly
```

**1–2.** Build in `/opt/eje/releases/e85f239`; fresh backup, verify, key
check, restore test — unchanged.

**3. Preflight — exactly these two pending, in this order.** It must show

    [FAIL] Migrations         2 not applied: 0030_library_page_coverage_unknown, 0031_test_repair_date_received. Run the migration …

and no FAIL but `Deployment target`. One pending, three, none, or the two in
the other order stops the release with nothing changed.

**4. Apply both** — `npm run db:migrate` with the production-migration intent
(§5); drizzle applies them in journal order in one transaction. Preflight
again must read **`all 32 applied`** — the journal's own count, not any
number. Fewer is a stop, with the live release still serving.

**5–6.** Switch, restart, health on commit `e85f239` — unchanged, with the same
automatic rollback.

```powershell
powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Sha e85f23935bb4c62357371a343fe9389acfeee6b2
```

**If `de0d9b6` is released first**, only `0031` is pending for this one, and the
operator says so — the gate never assumes:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Sha e85f23935bb4c62357371a343fe9389acfeee6b2 -ExpectPending 0031_test_repair_date_received
```

### Rollback to 4634d5d — with BOTH migrations applied

The same commands as the de0d9b6 rollback below. **Neither migration is rolled
back, and neither needs to be:** 0030 only relaxes a CHECK, 0031 only adds a
nullable column the live release never names, and the live release's own code
has been run against a database at 0031 in CI — reading every library state,
searching, writing an index, reading a job written with a date received and
writing one of its own. Its preflight reads a ledger of 32 against its 30 as
"all 30 applied". A date received recorded while `e85f239` ran stays in the
column, unread, until the release is applied again.

---

## Reference: RELEASE de0d9b6 — one migration (prepared 25 October 2026; two live attempts stopped safely, superseded by e85f239)

**From `4634d5d` (live since 24 October) to `de0d9b6`** — JOB-EDIT-1 (#72) and
LIB-TEXT-1 (#70), merged with the owner's approval. **Nothing below has been run
against the server. A live release needs the owner's separate approval.**

```
RELEASE=de0d9b62532c3399ea6b49f687d56e07abe44160   # full hash, always
LIVE=4634d5d061c02f3aa9af034be4363403a87f18cf
```

### Runtime release inventory, 4634d5d → de0d9b6

Verified against the diff (14 commits, 65 files), the code and the deploy files.

| Area | What changes at runtime | Action needed |
|---|---|---|
| **Database** | **One migration: `0030_library_page_coverage_unknown`** — replaces one CHECK so a partial index may record "page coverage unknown" (0 of M). Relaxes only; every existing row passes. Ledger 30 → 31 | Apply it (step 4). **Proven in CI**: upgrade path 0029 → 0030 with rows in every state, through the real migrator (`src/db/migrations/upgrade-0030.db.test.ts`) |
| **Rollback compatibility** | The live release reads, searches and writes a database at 0030, "coverage unknown" row included; its preflight does not refuse a ledger one ahead | None. **Proven in CI** with the live release's own code (`scripts/release/rollback-compat.sh`) |
| **Environment variables** | **None added, none removed, none renamed.** The LIB-TEXT-1 limits are constants (`PDF_TEXT_LIMITS`), not settings | None |
| **npm dependencies** | **None** — `package-lock.json` is byte-identical between the two commits | None (`npm ci` as usual) |
| **npm scripts** | `backup:escrow-check` added — a manual tool for the owner's PC, run by nothing | None |
| **System binaries** | LIB-TEXT-1 now also runs **`pdfinfo`** (poppler-utils, the same package as `pdftotext`) and reads PDFs 200 pages at a time with `pdftotext -f/-l` | `--check` reports both binaries. Without poppler the library falls back to the built-in reader (still truthful), so it is a warning, not a stop |
| **systemd units** | Repository copies gained `SuccessExitStatus=143` (already on the server as the drop-in `eje.service.d/exit-status.conf`) and `-/mnt/offsite` (optional path) in `eje-backup.service` | **None for this release.** A release does not replace installed units, and the installed ones are working: the nightly backup and the weekly restore test both finished on 25 October (read-only investigation, `investigate.log`). Bringing the installed copies level with the repository is a separate, optional change |
| **Backup tooling** | `pg_dump`/`psql`/`pg_restore` no longer take a password on the command line (`a14fba8`) | None: the backup units already run this code from `/opt/eje/tools/b190faa` (drop-in `tools.conf`); the release changes nothing there |
| **Library behaviour** | Every page is indexed (limits: 40 MB, 5 000 pages, 100 000 characters a page, 25 000 000 a document, 120 s); search runs over the page vectors; truthful N of M; OCR only after a complete reading. Upload response gains `pagesIndexed` and `source` | See "after the release" below — existing documents keep their stored index until re-indexed |
| **Jobs** | `jobs.editDetails` (Master, Coordinator); `edit_details` command; `job_details_edited` activity type (stored as text — no migration) | None |
| **API surface** | New command `POST /api/jobs/:id/edit_details`; upload response fields added (additive) | None |
| **Ops scripts** | `deploy/ssh`, `deploy/firewall` (SSH hardening, UFW) | **Not part of a release** and not run by it |

### The steps

The scripted path does every step below in this order and stops at the first
gate that does not pass (`deploy/release/deploy-release.sh`, driven from a PC by
`deploy/release/stage-release.ps1`). The manual commands are given beside each
step, so the release can be followed — or done — by hand.

**0. Read-only check** — host, the live release and its health, the release
directory, free disk, poppler, the environment files, the service.

```powershell
powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Sha de0d9b62532c3399ea6b49f687d56e07abe44160 -CheckOnly
```

It uploads the reviewed script, has the SERVER recompute its SHA-256, checks the
host is `srv2000625`, and runs `deploy-release.sh --check`. It changes nothing.

**1. Build** `de0d9b6` under **`/opt/eje/releases/de0d9b6`**, beside the live
release — §3's command with `SHA=$RELEASE`. The live release keeps serving. A
directory that already exists is reused only if it is a verified build of the
same commit; anything else stops the release untouched.

**2. Fresh backup, proven** — from the NEW release directory, as eje (§1):
`npm run backup`, then `backup:verify`, `backup:key-check` and
`backup:restore-test` on that backup, the restore test with the restore role's
environment (`/etc/eje/restore-test.env`, §1a). **Any failure stops here,
before the migration.**

**3. Preflight — exactly one pending migration.** As eje, from the new release:
`npm run preflight -- --expect-db eje_production`. It must show

    [FAIL] Migrations         1 not applied: 0030_library_page_coverage_unknown.

and no FAIL other than the one accepted for this server (`Deployment target` —
the `eje_production` name on a demonstration deployment). Two pending, none
pending, or any other FAIL stops the release.

**4. Apply migration 0030** — as eje, from the new release: `npm run db:migrate`
(§5). Preflight again: `Migrations` must read `all 31 applied`. **This is the
one step a switch back does not undo — and it does not need undoing**; see
rollback below. The live release is still serving throughout.

**5. Switch and restart** — atomically (§6):

```bash
sudo ln -sfn /opt/eje/releases/de0d9b6 /opt/eje/app.new
sudo mv -T /opt/eje/app.new /opt/eje/app
sudo systemctl restart eje
```

**6. Health** — `curl -s localhost:3000/api/health` must report
`"commit":"de0d9b6"`, `"status":"ok"` and `"database":"reachable"` (the script
waits up to a minute for all three). `stage-release.ps1` then confirms the same
from outside, through `https://eje.syncza.co.za/api/health`. **If the new
release is not healthy, the script switches back to `4634d5d` automatically and
health-checks that too**; if even that cannot be proven it stops, exit 2, and a
person decides — nothing is retried.

```powershell
powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Sha de0d9b62532c3399ea6b49f687d56e07abe44160
```

The server side runs as a detached unit (`eje-release-de0d9b6`), so a dropped
SSH connection cannot stop it half-way; `deploy-release.sh --status` reads what
it recorded (`/var/lib/eje-release/release-de0d9b6.state`, with the backup used
and the rollback target).

### Rollback to 4634d5d — with migration 0030 already applied

```powershell
powershell -ExecutionPolicy Bypass -File deploy\release\stage-release.ps1 -Rollback          # to the recorded previous release
```

or by hand:

```bash
sudo ln -sfn /opt/eje/releases/4634d5d /opt/eje/app.new
sudo mv -T /opt/eje/app.new /opt/eje/app
sudo systemctl restart eje
curl -s localhost:3000/api/health      # "commit":"4634d5d", status ok, database reachable
```

**Migration 0030 is NOT rolled back, and must not be.** It cannot be undone by
switching the code, and it does not need to be:

- it only RELAXES one CHECK; no row was rewritten, and the old rule's rows all
  satisfy the new one;
- **the live release's own code has been run against a database at 0030** —
  reading every indexing state, searching (the "coverage unknown" document
  included), writing a new partial index and re-indexing — in CI, from a
  checkout of `4634d5d` (`scripts/release/rollback-compat.sh`);
- the live release's preflight reads a ledger of 31 against its 30 shipped
  migrations as "all 30 applied" — nothing pending, nothing refused. (That
  sentence understates by one; it is harmless and expected after a rollback.)
- re-applying the old CHECK would REFUSE any "coverage unknown" row written
  while `de0d9b6` ran — which is the reason not to try.

The one visible difference after a rollback: a document the new release
recorded as "coverage unknown" (only possible on a server WITHOUT poppler — this
one has it) would read "Searchable — 0 of N pages" in the old wording. Cosmetic,
and searchable all the same.

**Only if the application will not start at all**: the backup from step 2,
restored per `docs/vps-backups.md` §6 into a NEW database — never over the live
one.

### After the release

- **Existing library documents keep the index they have** until they are
  re-indexed. One cut by the old 400 000-character budget is still recorded as
  `indexed` with only its first ~96 pages in page rows (the defect LIB-TEXT-1
  fixed in the WRITER). To find them, read-only:
  `select document_id, pages from library_document_text where truncated;` —
  then re-index each from the library screen (Re-index), which runs the new
  reader. **This is the owner's decision** (the live deployment holds
  demonstration data); the release does not do it.
- Post the evidence on #72 and #70; both issues stay open for the owner's
  acceptance.

---

### Reference: the 24 October 2026 release (4dede18 → 4634d5d), in the order that worked

The numbered sections below say what each step is for. **This is the order to
run them in**, because three of them cannot run where the sections used to put
them:

| # | Step | Why here |
|---|---|---|
| 1 | **Build** the release beside the old one (§3) | The backup and the restore test must run with the NEW code — see §1. |
| 2 | **Back up, verify, key-check, restore-test** from the release directory (§1, §1a) | Only a backup written by the new code records which references were already dangling; the new restore test fails an old-code backup. |
| 3 | **Preflight** (§4) | Expect `Migrations` to FAIL here — it cannot pass until step 4. Every OTHER line is what this step is for. |
| 4 | **Migrate** (§5) — 16 migrations, ledger 14 → 30 | The old release keeps serving throughout; it tolerates the new schema. |
| 5 | **Preflight again**, then `documents:reconcile --report` (§2) | The reconcile reads `provenance_recording`, which 0018 creates, so it CANNOT run before the migration. |
| 6 | **Switch** (§6), health, `check-routes` | |
| 7 | `documents:reconcile --record`, timers (§7) | |

Run every `npm` command as `eje` with the service's own environment file, the
way the service sees it — not `--preserve-env` (which passes whatever the root
shell happens to hold) and not `env $(cat … | xargs)` (which splits values on
whitespace):

```bash
sudo systemd-run --quiet --collect --pipe --wait --uid=eje --gid=eje \
  --working-directory=/opt/eje/releases/$COMMIT -p PrivateTmp=yes \
  --property=EnvironmentFile=/etc/eje/eje.env --setenv=HOME=/opt/eje \
  /usr/bin/npm run <script> -- <arguments>
```

That is the form every block below means by "**as eje**".

---

## 0. What is in this release, and what it changes at runtime

| Change | Runtime effect |
|---|---|
| Stored documents are written atomically and `fsync`ed | Writes are marginally slower and survive a power loss. No format change: a file written by the old code is read by the new one. |
| The sidecar beside each document records its length and SHA-256; `getDocument` verifies both | **A document whose bytes are damaged now REFUSES to open** (`document_damaged`) instead of handing out wrong bytes. Documents written before this release carry no checksum and are served exactly as now. |
| `final_documents` records size, checksum and renderer at issue | New rows only. Existing rows are untouched — the table is write-once and the database refuses UPDATE on it. |
| Migration `0014_document_verifications` | Creates one empty table and an append-only trigger. Additive; nothing is altered or dropped. |
| The restore test resolves storage keys correctly, and the backup records which references were already dangling | `npm run backup:restore-test` can pass for the first time. |
| New commands: `documents:reconcile`, `dump:inspect`, `integrations:check` | Run by hand. Nothing runs them automatically. |
| `deploy/eje-backup*.{service,timer}` | **Not installed by this deployment.** Step 7. |

### Added since: migrations 0015–0022 — read this before step 5

*(and 0023–0025 below them)*

| Migration | What it does | Risk |
|---|---|---|
| `0015_provenance_and_categories` | Adds `provenance` to four tables (default `genuine`) and five values to the library's type enum | Additive. **Backfills every existing row to `genuine`** — see the warning below |
| `0016_customer_documents` | New table | Additive |
| `0017_machine_documents` | New table | Additive |
| `0018_provenance_unknown` | Widens the provenance CHECKs to admit `unknown`, changes the DEFAULT to `unknown`, creates `provenance_recording`, and **UPDATEs rows written before provenance existed** in five tables | **The only data-modifying migration in this release.** See below |
| `0019_job_corrections` | New table, CHECKs and an append-only trigger | Additive |
| `0020_unsigned_delivery_authorisations` | New table and an append-only trigger | Additive |
| `0021_media_checksums` | Adds a nullable `checksum_sha256` to `machine_photos` and `checklist_answer_photos` | Additive. Two `ADD COLUMN` on nullable text: no rewrite, no backfill, no lock beyond the catalogue update |
| `0022_library_ocr` | Adds `source` to `library_document_text` with a CHECK, and creates `library_ocr_queue` | Additive. One `ADD COLUMN`, one `UPDATE` setting `source = 'text_layer'` on rows already `indexed` — which is true of all of them, since there was no other way to get text — one new table, one index |

### And since: migrations 0023–0025

| Migration | What it does | Risk |
|---|---|---|
| `0023_job_charges_and_discounts` | COST-5. One new table (`job_additional_charges`), four nullable columns on `jobs` for the discount, two nullable columns on `pricing_snapshots` for the gross and the discount, and the snapshot-line amount CHECK made **stricter** per line kind | Additive. The tightened CHECK refuses two row shapes nothing has ever written (a discount line recorded as a positive amount, and one of zero), so no existing row can violate it — `ALTER TABLE ... ADD CONSTRAINT` validates the existing rows and would refuse the migration if any did |
| `0024_machine_movements` | MACH-HIST. One new table. **Nothing is backfilled** — see below | Additive. No existing row is read or written |
| `0025_customer_job_change_requests` | CUST-CR's job half. Two nullable columns on `customer_change_requests`, two foreign keys, one index, two CHECKs | Additive. Both CHECKs are satisfied by every existing row, which is a register report with no job and no customer contact |

### And since: migrations 0026–0029

| Migration | What it does | Risk |
|---|---|---|
| `0026_customer_note_edits` | CUST-NOTE-1. Two nullable columns on `customer_notes` (`edited_by`, `edited_at`), one foreign key, one CHECK that the pair is whole or absent | Additive. Every existing note has neither column set, which the CHECK permits |
| `0027_optional_priority` | JOB-OPT-1. `ALTER TABLE "jobs" ALTER COLUMN "priority" DROP NOT NULL` | **Relaxes a constraint and rewrites nothing.** No existing row changes; a dropped NOT NULL cannot fail against existing data |
| `0028_test_and_repair_fields` | TR-1. Four nullable columns on `jobs` and one CHECK that a recorded quantity is a whole number above zero | Additive. The CHECK is satisfied by every existing row, all of which have NULL |
| `0029_library_page_text` | LIB-TEXT-1. One new table (`library_document_pages`), one column on `library_document_text` (`pages_indexed`), **three replaced CHECKs** and one new one | Additive, with a **backfill of the new column** (`pages_indexed = pages` for rows already `indexed`), which runs BEFORE the CHECK that depends on it. The three replaced CHECKs use a quiet DROP and an unconditional ADD — see the note below |

**`0029` REPLACES THREE CHECK CONSTRAINTS, and the form matters.** A
`DO ... EXCEPTION WHEN duplicate_object THEN NULL` block is right for a NEW
constraint and WRONG for a replaced one: on a database that already carries the
old definition it swallows the error and **keeps the old rule**, so the
migration reports success while the constraint still refuses what the new code
writes. `0029` therefore drops each one quietly
(`EXCEPTION WHEN undefined_object`) and adds the new definition
unconditionally. `src/db/migrations/redefinitions.test.ts` is the lint that
holds this rule for every future migration.

**No `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`, no `DELETE`** anywhere in
the sixteen (`0014`–`0029`; the live ledger read 14 before this release, i.e.
`0000`–`0013`). Every `NOT NULL` is on a column of a new table, or has a default
and a backfill (`0029`'s `pages_indexed`).

**MACH-HIST STARTS EMPTY, AND THAT IS DELIBERATE.** There is no record anywhere
of where a machine stood before this release, and building an "installation"
movement from `installation_date` and the machine's CURRENT site would assert
that every machine has stood in its present bay since the day it was installed
— which is exactly the false history the table exists to replace. The history
fills from the next move. A screen shows the section only when there is
something in it, and `machineLocationAsAt` returns NULL for a date it cannot
answer for rather than guessing.

**NOTHING IN THESE THREE CHANGES WHAT AN EXISTING JOB CARD SAYS.** A job with no
charges and no discount prices exactly as it did; the document prints one
subtotal as it did; and a closed job's issued figures are read from the
write-once columns that were already there.

**0015 AND 0018 MUST BE APPLIED IN THE SAME RUN, and they will be.** 0015
backfills `genuine` onto rows whose origin nobody recorded — including the six
demonstration job cards. 0018 is what corrects that: it relabels the five
tables that permit an UPDATE, and for `final_documents` (write-once, and the
database refuses UPDATE on it) it records *when this database began recording*
so `documents:reconcile` can tell a backfilled label from a chosen one.

**If the run is interrupted between them**, `npm run documents:reconcile` will
report the six demonstration job cards as **LOST CUSTOMER DOCUMENTS** and exit
non-zero. That is alarming and wrong, and the remedy is to finish the
migration: `npm run db:migrate` again, then re-run the reconcile.

**What 0018 changes, and how to see it before and after:**

```bash
# BEFORE the migration — the current labels, per table:
psql "$DATABASE_URL" -At -c "
  select 'library',  provenance, count(*) from library_documents group by 2
  union all select 'photos', provenance, count(*) from machine_photos group by 2
  union all select 'final', provenance, count(*) from final_documents group by 2"

# AFTER — the same query, plus the moment recording began:
psql "$DATABASE_URL" -At -c "select recorded_from from provenance_recording where id='cutoff'"
```

Rows that read `genuine` before and `unknown` after are rows whose origin was
never recorded. **Nothing else about them changes** — not a file, not a
checksum, not a date — and no row is deleted.

**Locks.** The CHECK constraints are dropped and re-added, which takes an
`ACCESS EXCLUSIVE` lock on each table and validates the new constraint against
every row. On this database (tens of rows) it is instantaneous; it would not be
on a table of millions, and nothing here is.

### Since the 24 October deployment: migration 0030 (LIB-TEXT-1, #70) — NOT YET DEPLOYED

The live ledger read **30** after 24 October (`0000`–`0029`). The next release
that carries LIB-TEXT-1's per-page indexing adds one:

| Migration | What it does | Risk |
|---|---|---|
| `0030_library_page_coverage_unknown` | LIB-TEXT-1. **Replaces one CHECK** (`library_document_text_pages_indexed_matches_state`) so a `partially_indexed` row may carry `pages_indexed = 0` — "some of this document is searchable; which pages is not known", which is what the built-in reader can truthfully say when it is cut | **Relaxes a constraint and rewrites nothing.** The new rule accepts every row the old one did, so no existing row can fail it. Written as a quiet drop and an unconditional add, per `redefinitions.test.ts` |

**The code needs `0030` before it writes a "coverage unknown" row**, and only
the built-in reader writes one — i.e. only a server WITHOUT poppler-utils. A
server with poppler (the VPS has it) never writes `pages_indexed = 0` for a
partial index, so the order of migrate-then-restart that the procedure already
follows is sufficient; there is no window in which the new code is refused.

**`pdfinfo` is now used**, from the same poppler-utils package as `pdftotext`
— nothing new to install. It tells the reader how many pages a document has
before any are read; without it the reader finds the end by reading to it,
and says so when a limit stopped it first.

### And migration 0033 (attendance and timesheet comments) — NOT YET DEPLOYED

On `claude/office-workflow-parts`, after 0032. Two NEW tables, `attendance` and
`timesheet_comments`, each unique per person per day; no existing table, column
or row is touched and nothing is backfilled. With `e85f239` live there are then
TWO pending migrations: run the check and the release with
`-ExpectPending 0032_office_lifecycle,0033_attendance_timesheets` — **only if `e85f239`
was released first**; from `4634d5d` all four are pending (see *NEXT RELEASE* above).
A rollback of the code leaves two tables the earlier release never reads.

### And migration 0032 (the office lifecycle, issue #73) — NOT YET DEPLOYED, NOT IN e85f239

On `claude/office-workflow-parts`. Three `job_status` values appended
(`office_handling`, `awaiting_po`, `invoiced`), five nullable columns on `jobs`
(who handled it and when; the invoice number, who recorded it and when), four
checks written on `status::text` (an enum value cannot be USED in the
transaction that adds it, and drizzle runs every pending migration in one), and
a trigger that refuses rewriting a recorded invoice number.

- **No row is rewritten.** Closed jobs stay `closed` — they were never invoiced
  through this system. `awaiting_delivery` jobs (submitted under the old rule)
  are left as they are; the application treats them as waiting on the office.
- **Behaviour changes at release:** a technician's submission enters Office
  Handling instead of waiting on delivery, and a confirmed delivery no longer
  closes a job. The office finishes each job from Notifications (Mark handled,
  then the Invoice No.).
- **The release tool must be told what is pending.** With `e85f239` live, the
  only pending migration is `0032_office_lifecycle`, so run the check and the
  release with `-ExpectPending 0032_office_lifecycle`; the tool's default
  (0030, 0031) would — correctly — stop at the journal check.
- **Rolling back after jobs have entered the new statuses** is not covered by
  the rollback-compatibility check: the earlier release does not know
  `office_handling`, `awaiting_po` or `invoiced`, and such jobs would read with
  no label and no action. Roll back only before the office has used the new
  steps, or decide the data first.

### And migration 0031 (Test & Repair "Date received") — NOT YET DEPLOYED, NOT IN de0d9b6

On `claude/job-forms-attachments`, after `de0d9b6`. One additive, nullable
column: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS date_received date`. Every
existing job keeps NULL ("not recorded"); nothing is backfilled or guessed.

- **Rollback-compatible**, proven in CI: `scripts/release/rollback-compat.sh`
  now also has the live release's code read a job written WITH a date received
  and write one of its own on a database at 0031.
- **A release that includes it has TWO pending migrations** if `de0d9b6` has
  not been released first. The release tool takes an ordered list and expects
  `0030,0031` by default — see "RELEASE e85f239" at the top of this file. If
  `de0d9b6` ships first, the next release passes
  `-ExpectPending 0031_test_repair_date_received`.

### And a new preflight line

`EJE_DEPLOYMENT` should be set before step 4, to `production` or
`demonstration`. The current live site is a **demonstration** deployment, and
saying so is what makes the demonstration switcher refuse to arm anywhere that
says `production`. See `docs/demonstration-isolation.md`.

**ON THIS SERVER THE PREFLIGHT STILL CANNOT PASS, whichever value is set** —
an earlier version of this paragraph said it would, and it does not:

| `EJE_DEPLOYMENT` | Remaining FAIL lines (after the migration) |
|---|---|
| unset | `Customer email` (refuse) and `EJE_DEMO_SWITCHER` (armed) |
| `demonstration` | `Deployment target` — a demonstration deployment pointed at a database whose NAME says production (`deploymentMismatch`) |
| `production` | `Customer email`, `EJE_DEMO_SWITCHER` (and the runtime disarms the switcher, which EJE do not want here) |

The only configuration that passes cleanly is the one
`docs/demonstration-isolation.md` §3 recommends: the demonstration on its own
database (`eje_demo`). Until that is done, deploying means the owner accepting
one named FAIL. **On 24 October 2026 the owner chose `demonstration`** and
accepted `Deployment target` as a known FAIL; nothing the running application
does depends on the declaration except `/api/health`'s `deployment` field and
the switcher's production refusal.

Two things this release deliberately does **not** do: it does not write document
bytes anywhere, and — apart from 0018's provenance relabelling and 0022 marking already-indexed
library text as having come from a text layer, both described above — it does
not modify, repair or delete any existing row.

**One name is wrong in an already-applied migration, and is deliberately left
alone.** PostgreSQL cuts an identifier at 63 characters, with a NOTICE in the
middle of `drizzle-kit`'s output. `0014`'s foreign key
`final_document_verifications_final_document_id_final_documents_id_fk` is 68, so
the constraint in EJE's database is really called
`final_document_verifications_final_document_id_final_documents_`. Nothing is
broken by that — the constraint works — but a future migration that drops or
renames it must use the truncated name. It is not corrected here because editing
an applied migration changes the hash drizzle recorded against it. Two foreign
keys in `0019` and `0020` had the same fault and **were** corrected, because
neither has been applied anywhere yet; `src/db/migrations/identifiers.test.ts`
now fails the build on any new one.

### New configuration this release understands, all of it optional

None of these has to be set, and the deployment behaves honestly with all of
them absent — `npm run preflight` reports each one either way, which is how an
operator sees what is actually on.

| Variable | If unset | Why you might set it |
|---|---|---|
| ~~`EJE_EXPORT_AUDIT`~~ | **OBSOLETE — must be ABSENT from the live environment file** | **BD-18 was answered on 23 October 2026: every export is recorded, always.** There is nothing to configure, and the variable no longer does anything. Delete the line from `/etc/eje/eje.env` as part of this release; `npm run preflight` flags it if it is still there, because a setting that looks like a switch and is not is worse than no setting |
| `EJE_PDF_TEXT` / `EJE_PDF_TEXT_BINARY` | **poppler, when it is installed** — nothing to set | **LIB-TEXT-1, and this is the one dependency that is not really optional.** `pdftotext` is what reads a manufacturer's manual; the built-in fallback cannot resolve a subset font's `/ToUnicode` map, so it reports most real manuals as scans needing recognition. **`sudo apt-get install -y poppler-utils`** before the release, and `npm run preflight` reports which engine is in use (WARN when it is the fallback) |
| `EJE_OCR` and its seven companions | A scanned library document is recorded as **not searchable**, and says so | **LIB-5, and it is EJE's decision** (`docs/library-ocr.md` §3). `local` needs `tesseract-ocr`, `tesseract-ocr-eng` and `poppler-utils` installed first; preflight WARNS so somebody checks with `npm run library:ocr -- --report` rather than assuming |

**`jobs.exportPrices` is a capability NO ROLE HOLDS**, so no file EJE can
produce today carries what any job was charged. That is BD-17 unanswered rather
than a setting — granting it is a code change, deliberately, because it is a
disclosure decision and not a deployment one.

### And the reverse proxy has to be changed, or video uploads fail with no reason

This release accepts a **60 MB** video (`MAX_VIDEO_BYTES`). The Caddy site block
on the VPS caps a request body at **30 MB**, so until it is raised a
technician's video is refused *by Caddy* — a bare `413` with none of the
application's own wording and nothing in the application's log to say it
happened. `deploy/Caddyfile` in this release says `70MB`; the file on the server
is the one that matters:

```bash
sudo diff -u /etc/caddy/Caddyfile /opt/eje/releases/<commit>/deploy/Caddyfile
# raise request_body max_size to 70MB, then:
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Do it **before** the switch in step 6: the limit only has to be raised, so a
reload with the new value is safe against the release that is still running.
`src/ops/deploy-limits.test.ts` fails the build if the two numbers ever disagree
again.

## 1. Back up first, and prove the backup

The one step that must not be skipped, and the first time it can be proved.
**Run it from the NEW release directory, after §3** — every command here "as
eje" (see the top of this file), with `--working-directory=/opt/eje/releases/$COMMIT`:

```bash
npm run backup                     # prints the directory it wrote
npm run backup:verify       -- /var/backups/eje/eje-eje_production-<stamp>
npm run backup:key-check    -- /var/backups/eje/eje-eje_production-<stamp>
# restore test: with the restore role's environment file as well — §1a
npm run backup:restore-test -- /var/backups/eje/eje-eje_production-<stamp>
```

**WHY THE NEW CODE, AND NOT THE INSTALLED RELEASE.** Only a backup written by
this release records `danglingReferences` — the references that already had no
file when it ran. The restore test in this release treats a missing file that
the manifest does NOT list as LOST, so a backup taken by `4dede18` fails it on
the seeded demonstration documents, and the only way past that is
`EJE_RESTORE_ALLOW_ORPHANS`, which must not be used here. An earlier version of
this section ran the backup from `/opt/eje/app`; it also failed three times on
23 October with `EJE_BACKUP_DIR is not set`, which `/etc/eje/eje.env` now sets.

### 1a. The restore test needs a role that may create databases — not the application's

The restore test builds a scratch database (`eje_restore_test_<stamp>_<hex>`)
and drops it. `eje_production` has no `CREATEDB`, and must not be given it: on
23 October the test failed with `permission denied to create database`. The
test reads only `DATABASE_URL` and connects only to `postgres` and its own
scratch database — never to the database the URL names, whose name it uses
only to refuse to drop it — so a separate role is enough:

```sql
-- as postgres; the password is set from a SCRAM verifier computed off the
-- server, so the plaintext never reaches a log, an argv or a history file
CREATE ROLE eje_restore_test WITH LOGIN CREATEDB NOSUPERUSER NOCREATEROLE
  NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 PASSWORD 'SCRAM-SHA-256$4096:…';
```

and `pg_hba.conf` (back it up first; insert ABOVE the first existing rule,
check `select * from pg_hba_file_rules where error is not null` is empty,
then `select pg_reload_conf()`):

```
host    postgres                        eje_restore_test  127.0.0.1/32  scram-sha-256
host    postgres                        eje_restore_test  ::1/128       scram-sha-256
host    /^eje_restore_test_[0-9a-z_]+$  eje_restore_test  127.0.0.1/32  scram-sha-256
host    /^eje_restore_test_[0-9a-z_]+$  eje_restore_test  ::1/128       scram-sha-256
host    all                             eje_restore_test  all           reject
local   all                             eje_restore_test                reject
```

Its connection string goes in `/etc/eje/restore-test.env` (`0600 root:root`,
one line, `DATABASE_URL=postgresql://eje_restore_test:<pw>@127.0.0.1:5432/eje_production`
— the database name there is the SOURCE the test refuses to drop, and pg_hba
refuses the role a connection to it). systemd reads that file as root and a
later `EnvironmentFile=` overrides an earlier one, so the restore test runs as
`eje`, keeps `EJE_BACKUP_KEY` and `EJE_BACKUP_DIR` from `eje.env`, and gets the
restore role's `DATABASE_URL`:

```bash
sudo systemd-run --quiet --collect --pipe --wait --uid=eje --gid=eje \
  --working-directory=/opt/eje/releases/$COMMIT -p PrivateTmp=yes \
  --property=EnvironmentFile=/etc/eje/eje.env \
  --property=EnvironmentFile=/etc/eje/restore-test.env --setenv=HOME=/opt/eje \
  /usr/bin/npm run backup:restore-test -- /var/backups/eje/eje-eje_production-<stamp>
```

The weekly unit gets the same file through a drop-in — see
`deploy/eje-backup-restore-test.service`. Rehearsed on the live server on
24 October 2026: the role reached `postgres` and was refused `eje_production`,
`template1` and `eje_tracker`; the restore test passed (`RESTORE-TESTED`, 9 of
26 storage keys resolved, 17 already missing when taken, none lost) and left no
scratch database behind.

`EJE_BACKUP_KEY` must be set in `/etc/eje/eje.env` and **a copy of it must
already be somewhere that is not this server**. A backup whose key is lost is a
directory of noise.

The restore test will report some references as "already missing when this
backup was taken". It must **not** report anything as lost. On the live server
on 24 October 2026 it was **17 of 26**, not the six this paragraph used to
promise:

| References | What they are |
|---|---|
| 6 `final_documents` (EJE-2015, 2016, 2017, 2019; parts notes 2020, 2021) | Seeded demonstration job cards, rendered on first download — `ABSENT_DEMONSTRATION` in the reconcile |
| 7 `library_document_versions` (`library/*-demo-*.pdf`) | Seeded demonstration library entries; the seed ships no PDF bytes |
| 2 `machine_photos` (`machines/mazak-qt250-front.jpg`, `machines/fanuc-robodrill-cabinet.jpg`) | Seeded by `src/db/seed/register.ts`, no bytes |
| 2 `job_media` (`uploads/<uuid>`: EJE-2013 on 25 Sep, EJE-2031 on 20 Oct 08:14) | **No photograph was ever stored — nothing was lost.** Both were "uploaded" before `a690dda` reached the server with `4dede18` (20 Oct 17:37). Until then the add-photo control sent a file name and a MADE-UP size (`2_140_000`, the figure both rows carry) and `addMedia` allocated a key with `storage.put(…, null)`, so the row and its `photo_uploaded` audit event were written with no bytes behind them. Searched for on 24 Oct: no file with either id exists anywhere on the server, in any release directory or in the store. The rows are left as they are — they are the honest record of what that release did — and there is nothing to recover |

### THE RESTORE TEST ON THE INSTALLED RELEASE IS BROKEN, AND THAT IS THE "26"

**Read this before trying to recover any document.** If the restore test on the
live server has reported something like *"26 document references pointing at
files missing from the backup"*, naming `EJE-2015.pdf`, `EJE-2016.pdf` and
`EJE-2017.pdf` — **nothing has been lost, and there is nothing to recover.**
The check itself is the fault, and the fix is in the release this document
deploys.

**What the installed release does.** `4dede18`'s restore test resolves a
reference with `if (!present.has(key))` — a storage KEY compared against a FILE
NAME. The store writes `<key>.bin` and `<key>.json`, so `present` holds
`jobcards/final/EJE-2015.pdf.bin` while `key` is `jobcards/final/EJE-2015.pdf`.
**Nothing ever matches, so every reference in the database is reported as a
missing document.** The number you see is the total count of storage-key
references, not a count of losses. `36623b1` fixes the resolution and adds the
manifest's `danglingReferences` list so a pre-existing absence can be told from
a loss; both are in this release and neither is in the running one.

**Why those three job numbers are the harmless ones.** `EJE-2015`, `EJE-2016`
and `EJE-2017` are seeded demonstration jobs with fictional customers
(`acme-demo.local`, `jia-demo.local`). `src/db/seed/jobs.ts` says it outright:

> NOTHING HAS MEASURED THESE BYTES, because they do not exist yet: a seed cannot
> ship binary content, so a seeded job card is rendered on first download.
> Recording a length here would be describing a file nobody has written.

So their `final_documents` rows carry `size_bytes: null` and
`checksum_sha256: null` and point at keys with no bytes **by design**. Rendering
a replacement now would be a new document wearing an old one's date, which
`src/ops/document-rules.ts` refuses for exactly that reason.

**Rehearsed on 23 October 2026** against an isolated database that reproduces
this condition — all 29 migrations, the production seed, nine real stored files
written through the real storage service, a real encrypted backup, and the
restore test into a scratch database that was dropped afterwards:

```
backup   15 storage key(s) referenced, 6 with no file — recorded in the manifest
         so a restore test can tell them from documents this backup loses
restore  9 of 15 storage key(s) resolved to a stored file
restore  6 were ALREADY missing when this backup was taken (recorded in its
         manifest), so the backup did not lose them
restore  RESTORE-TESTED — recorded in manifest.json          [exit 0]
```

`unresolved-references.json` from that run named the six, and
`lostByThisBackup` was **empty**:

```
jobcards/final/EJE-2015.pdf    bytes_missing
jobcards/final/EJE-2016.pdf    bytes_missing
jobcards/final/EJE-2017.pdf    bytes_missing
jobcards/final/EJE-2019.pdf    bytes_missing
partsnotes/final/EJE-2020.pdf  bytes_missing
partsnotes/final/EJE-2021.pdf  bytes_missing
```

**It passed without `EJE_RESTORE_ALLOW_ORPHANS`**, which is the point: the flag
is not needed and must not be used here.

**So the backup AND the restore test run from the new release directory.** A
pre-deploy restore test run with the INSTALLED release fails however healthy
the data is, because the check cannot resolve a key. And restore-testing an
old-code backup with the NEW check is not the answer either — an earlier
version of this paragraph said it was — because that backup's manifest has no
`danglingReferences`, so every by-design absence counts as lost. Take the
backup with the new code (§1) and restore-test it with the new code (§1a).

That run is the one whose result decides whether to proceed. If **it** reports
anything under `lostByThisBackup`, stop: that is a real loss, and no flag may be
used to get past it.

## 2. Look at the documents before switching the code

**After the migration (§5), before the switch (§6)** — as eje, from the new
release directory:

```bash
sudo install -d -o eje -g eje -m 750 /opt/eje/reports
npm run documents:reconcile -- --report /opt/eje/reports/documents-before-switch.json
```

**IT CANNOT RUN BEFORE THE MIGRATION.** It reads `provenance_recording`, which
`0018` creates; on the live server on 24 October it failed with `relation
"provenance_recording" does not exist`. The installed release does not have the
script at all (`Missing script: "documents:reconcile"`, 23 October). Write the
report somewhere `eje` can write and that survives — not `/tmp`, which a
`PrivateTmp` unit discards.

This is read-only and it answers the question that decides whether the switch
is safe: **is any stored document already damaged?** If anything reports
`contradicted` or `damaged`, stop and restore that document from a backup
first — after this release those documents will refuse to open, which is
correct and is better found now than by the office.

Expected on the live server today: six `absent_demonstration`, several
`unrecorded` (every row written before this release), nothing else.

## 3. Build the new release beside the old one

Never build in `/opt/eje/app`: a build replaces `.next` in place, so a failure
leaves the live application unable to serve its own pages.

Name the commit exactly — the full hash you reviewed, not a branch name — and
clone from GitHub, not from `/opt/eje/app` (a clone of the live directory has
the live directory as its `origin`, so "the latest commit on the branch" is
whatever that copy last fetched):

```bash
SHA=<full 40-character commit hash>; COMMIT=${SHA:0:7}
sudo install -d -o eje -g eje /opt/eje/releases/$COMMIT      # refuses nothing: check it does not exist first
sudo systemd-run --quiet --collect --pipe --wait --uid=eje --gid=eje \
  --working-directory=/opt/eje/releases/$COMMIT \
  -p MemoryMax=4G -p Nice=10 -p CPUWeight=20 -p PrivateTmp=yes \
  --setenv=HOME=/opt/eje --setenv=EJE_BUILD_COMMIT=$COMMIT \
  /bin/bash -c "set -eo pipefail
    git clone --quiet --no-checkout https://github.com/VOID-za/EJE-Managment.git .
    git checkout --quiet --detach $SHA
    test \"\$(git rev-parse HEAD)\" = $SHA
    npm ci --no-audit --no-fund
    npm run build"
```

The memory cap and low CPU weight are so a build that runs out of memory kills
itself rather than the live `next-server` or PostgreSQL beside it; `systemd-run`
keeps the build alive if the SSH session drops. `npm ci` installs the dev
dependencies too, deliberately: `tsx`, which every `npm run` script in §1–§7
uses, is one of them. (Rehearsed 24 October 2026: 429 packages, build exit 0,
963 MB.)

**THE COMMIT IS STAMPED AT BUILD TIME, AND STEP 6 DEPENDS ON IT.**
`next.config.ts` puts it in the bundle; the service environment cannot supply it
afterwards, because by then the pages are already built. Left unset it falls
back to `git rev-parse --short HEAD`, which IS right for the clone above — so
passing `EJE_BUILD_COMMIT=$COMMIT` is belt and braces here, and the only thing
standing between `/api/health` and the truth where there is no git directory (a
tarball, a Docker layer) or where the checkout is not the commit being
deployed. Setting it costs nothing and removes the case where it matters.

Note what the preflight at step 4 does and does not tell you:

    [ ok ] Build   Built output present. EJE_BUILD_COMMIT is not set, so
                   /api/health cannot say which commit it serves.

That line reads the ENVIRONMENT, not the built output, so it appears whenever
the variable is absent from the service environment — including after a build
that stamped the commit from git perfectly well. It is a prompt to check step
6's answer, not proof that the stamp is missing. **Step 6 is the check that
settles it**: `/api/health` must come back with `$COMMIT`.

## 4. Preflight the new release against the live configuration

As eje, from the new release directory:

```bash
npm run preflight -- --expect-db eje_production
```

It reads the database, the storage directory and the environment and writes
nothing but one probe file it deletes again. Run it **twice**:

- **Before the migration**, `Migrations` FAILS — "16 not applied" — and must:
  that is the migration not having run yet. Read every OTHER line.
- **After the migration**, `Migrations` must be `ok`. What remains must be
  exactly the FAIL the owner has accepted for this server (§0, "And a new
  preflight line"); anything else stops the deployment.

## 5. The migration

As eje, from the new release directory, with the production-migration intent
typed on the command line (never put it in the environment file):

```bash
sudo systemd-run --quiet --collect --pipe --wait --uid=eje --gid=eje \
  --working-directory=/opt/eje/releases/$COMMIT -p PrivateTmp=yes \
  --property=EnvironmentFile=/etc/eje/eje.env --setenv=HOME=/opt/eje \
  --setenv=EJE_PRODUCTION_MIGRATION=eje_production \
  /usr/bin/npm run db:migrate
sudo -u postgres psql -d eje_production -Atc "select count(*) from drizzle.__drizzle_migrations"   # 30
```

**Migrations 0014–0029 — sixteen — all apply here, in one run**; the ledger goes
from 14 to 30. Read §0 first: 0018 is the only data-modifying migration in the
release, and an interrupted run between 0015 and 0018 makes
`documents:reconcile` report the demonstration job cards as LOST CUSTOMER
DOCUMENTS until the run is finished.

Every one of the sixteen is additive — no DROP TABLE, no DROP COLUMN, no
TRUNCATE, no DELETE, and every NOT NULL either on a column of a new table or
with a default and a backfill (`0029`'s `pages_indexed`) — so **the old code
runs against the new schema**, which is what makes step 8's rollback safe. That
is tested rather than asserted: an old-code-shaped INSERT that omits
`provenance` succeeds and lands on `unknown`.

**`0027` and `0029` are the two to read twice.** `0027` DROPS a NOT NULL on
`jobs.priority`, which the old code cannot be harmed by — it always wrote a
value — but which means a job created by the NEW code with no priority would be
a row the old code renders as a blank badge rather than crashing. `0029`
REPLACES three CHECK constraints on `library_document_text`: after it, a row
with `state = 'partially_indexed'` is legal, and the old code would render that
state's label as an unknown string. Neither is a reason not to roll back; both
are reasons to roll the CODE back and leave the schema alone, which is what
step 8 says.

## 6. Switch, and prove what is serving

`/opt/eje/app` is already a symbolic link to a release directory (since
`4dede18`), so the previous release stays where it is and IS the rollback
target. Replace the link in one step rather than moving the directory:

```bash
readlink -f /opt/eje/app                 # note it: this is the rollback target
sudo ln -sfn /opt/eje/releases/$COMMIT /opt/eje/app.new
sudo mv -T /opt/eje/app.new /opt/eje/app # atomic: there is never a moment with no link
sudo systemctl restart eje

curl -s localhost:3000/api/health        # commit must be $COMMIT; backend postgres; database reachable
# as eje, from the release directory:
EJE_CHECK_URL=http://localhost:3000      npm run check-routes
EJE_CHECK_URL=https://eje.syncza.co.za   npm run check-routes
```

`eje.service` uses `WorkingDirectory=/opt/eje/app` and
`ReadWritePaths=/opt/eje/app/.next`; systemd resolves both through the link at
start, which is why a restart is needed and is enough.

`/api/health` carries the commit it was BUILT from, so it is the one thing that
proves what is serving. `demoSwitcher` must still read `true` — EJE want demo
switching kept on this deployment — and `email` will read `refuse` until a
Microsoft 365 tenant exists.

## 7. Record what the documents are, and schedule the backups

As eje, from `/opt/eje/app`:

```bash
npm run documents:reconcile -- --record
```

This appends one observation per document to `final_document_verifications` —
the length and checksum of every file that exists, and the fact that the six
demonstration job cards have none. It writes nothing else, and it is what gives
the next reconcile something to compare against.

Then the timers, which are the fix for "there is no scheduled backup":

```bash
sudo cp /opt/eje/app/deploy/eje-backup.service /opt/eje/app/deploy/eje-backup.timer \
        /opt/eje/app/deploy/eje-backup-alert.service \
        /opt/eje/app/deploy/eje-backup-restore-test.service \
        /opt/eje/app/deploy/eje-backup-restore-test.timer /etc/systemd/system/
# the weekly restore test runs as the restore role (§1a), never as eje_production:
sudo install -d /etc/systemd/system/eje-backup-restore-test.service.d
printf '[Service]\nEnvironmentFile=/etc/eje/restore-test.env\n' \
  | sudo tee /etc/systemd/system/eje-backup-restore-test.service.d/restore-role.conf
sudo systemctl daemon-reload
sudo systemctl enable --now eje-backup.timer eje-backup-restore-test.timer
systemctl list-timers 'eje-backup*'
# prove both units work now rather than at 02:12 on a night nobody is watching:
sudo systemctl start eje-backup.service && sudo systemctl start eje-backup-restore-test.service
```

The units reference `/opt/eje/app` and `/var/backups/eje`; check those two
paths before enabling. `eje-backup.service` from a release before this fix
listed `/mnt/offsite` as a required writable path; on a server with no such
directory systemd refuses to start the unit (226/NAMESPACE) and the nightly
backup never runs. It is now `-/mnt/offsite` (optional). Set `EJE_BACKUP_KEEP` and an off-site destination in
`/etc/eje/eje.env` — see `docs/vps-backups.md`.

## 8. Rollback

```bash
sudo ln -sfn /opt/eje/releases/<previous commit> /opt/eje/app.new   # 4dede18 for this release
sudo mv -T /opt/eje/app.new /opt/eje/app
sudo systemctl restart eje
curl -s localhost:3000/api/health         # the commit must be the OLD one
```

The `EJE_DEPLOYMENT` line and the Caddy limit need not be reverted: the old
release ignores the first and is only helped by the second. Each edited file
has a `.bak-<stamp>` copy beside it if they are wanted back.

What rollback does and does not need:

- **The migration is not rolled back, and must not be.** `0014` only adds a
  table; the old code neither reads nor writes it. Dropping it would delete the
  observations recorded in step 7 — the only independent record of what each
  document's bytes were. **The same holds for 0015–0029**, and more strongly:
  `job_corrections` and `unsigned_delivery_authorisations` hold decisions
  somebody took about a customer's document, `customer_documents` and
  `machine_documents` hold files that exist on disk, and
  `provenance_recording` is the one row that stops a backfilled label being
  read as a chosen one, and `library_document_pages` holds the per-page text
  index that took CPU to produce and would have to be produced again. Dropping
  any of them destroys a record the old code simply ignores.
- **The old release runs unchanged against the new schema.** It does not read
  the new tables, and the columns it does not know about have defaults. The one
  behavioural difference is that a `final_documents` row inserted by the OLD
  code now lands on `provenance = 'unknown'` rather than `'genuine'` — which is
  correct (that code does not record provenance) and is exactly what the
  reconcile is built to report rather than to hide.
- **Documents written by the new release stay readable.** Their sidecars carry
  a length and checksum; the old code ignores both.
- **The new `final_documents` rows stay correct.** They carry a size and a
  checksum the old code does not write and does not mind.
- **Nothing needs restoring** unless a document was found damaged in step 2 and
  dealt with; the deployment itself changes no data.

If the application will not start at all, the fallback is the backup from
step 1 — restored per `docs/vps-backups.md` §6, into a new database and a new
storage directory, never over the live ones in a single step.

## What this deployment does NOT do

- It does not install an off-site backup destination. There isn't one; the
  repository-side support exists and EJE must supply a bucket, a NAS or a disk.
- It does not configure Microsoft 365 or WhatsApp. `npm run integrations:check`
  reports both as absent, which is the truth until EJE supply credentials.
- It does not seed, reset or truncate anything.
- It does not repair the 14 existing `final_documents` rows whose `size_bytes`
  is 0. They cannot be repaired — the row is write-once — and step 7 records
  what their bytes are instead.
