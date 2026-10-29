# Delivery register — 29 October 2026

The owner's instruction of 29 October 2026: complete everything outstanding
that can be completed safely, add the monthly payroll forms and the Finance
package, polish the visuals, test, release and verify. This register records,
for every item, what exists, what was done, the evidence, and what only a
person, a device, a credential or a business decision can finish. Nothing in
it is approved: approval is the owner's act (PROC-4).

Baseline: branch `claude/office-workflow-parts` at `6a649e8`; live
`https://eje.syncza.co.za` on `1a34d1c` (migrations to 0039). Release results
are at the end ("Release").

## 1. The audit — what was found

A read-only sweep of `docs/SCOPE.md`, the 73 open GitHub issues and the
documentation, checked against the code:

- **No requirement row is a pure code gap that can be closed safely here.**
  Every remaining non-DONE row is either implemented and tested and waiting for
  the owner's approval (about 150 rows), or needs the physical rugged tablet,
  external credentials or a business decision (section 4).
- **Decided and deliberately not built:** offline documents and video
  (OFF-3/OFF-12, BD-30), byte-range upload resume (BD-29).
- **Stale records** (reconciled in this change, history kept):
  - SCOPE AUD-3 and AUD-4 still read "OPEN — BD-02 / BD-06", but both decisions
    were answered and built (IMMUT-9; DELIV-7, `jobs.authoriseUnsignedDelivery`);
  - the CR-09 heading still said "not implemented";
  - the 0033 heading;
  - `docs/staff-testing.md`'s header named `ef0f695` as live;
  - `docs/deploy-next-release.md` "Which migrations are pending" described
    `4634d5d` as live;
  - `docs/outstanding-scope.md` was dated 26 October.
- **Stale GitHub issues** — no write access to GitHub from this environment, so
  listed here for the owner:
  - #72 JOB-EDIT-1 is built (SCOPE TESTED);
  - #33–#40 and #56, #57, #61–#63 (BD-02…BD-21) are answered in SCOPE;
  - #29 AUD-3, #30 AUD-4 and #19 DELIV-7 are resolved by the decisions above;
  - #31 AUD-8 says TESTING while SCOPE says OPEN (still a demo-data gap);
  - #1 refers to the retired tracker;
  - #42 and #55 duplicate QA-5;
  - none exists for anything added since 24 October (the BD-23 work,
    TIMESHEET-2, TS-*, PAY-*).
- **Logo:** there is **no EJE company logo** anywhere in the repository or the
  project folder. The favicon (a blue tile in a system font), the home-screen
  icons (a navy tile with one "E") and the in-app logo (a blue "EJE" tile) were
  three different marks.
- **Payroll:** nothing in SCOPE covered monthly forms, attendance PDFs, file
  names or a Finance email — new IDs PAY-01…08.

## 2. Built in this change

| ID | Requirement | Implementation | Tests |
|---|---|---|---|
| PAY-01 | Attendance form with the timesheet's preview / print / Download / Export PDF quality | `application/attendance-document.ts`, `services/simulated/attendance-pdf.ts`, `components/payroll/AttendanceDocumentView.tsx`, routes `/api/payroll/:user/:month/attendance(/pdf)` | `payroll.test.ts`, `one-page-form.test.ts`, `payroll-api.test.ts`, smoke |
| PAY-02 | Monthly submission of BOTH documents, once; completeness; attendance frozen for the technician; office notified; audited | `application/monthly-submissions.ts`, `/api/payroll/:user/:month/submit`, lock in `recordAttendance`; migration 0040 `monthly_submissions` (write-once trigger; must reference the same technician's sent period for exactly that month) | `payroll.test.ts` (8), HTTP, PostgreSQL, smoke |
| PAY-03 | File names `JC TIMESHEET OCT.pdf` / `JC ATTEN OCTOBER.pdf` from the name on documents | `lib/payroll-files.ts`; `users.document_name` (0040), set in Administration → Users; used by every download, the package and its files | `payroll.test.ts` (3), HTTP (Content-Disposition), smoke |
| PAY-04 | Every timesheet and attendance PDF EXACTLY one page | `services/simulated/one-page-form.ts` — one renderer for both: content-aware column widths, wrapping (nothing cut), type down to 5.4 pt, two panels, and an explicit refusal (`form_too_long_for_one_page`) instead of a second page | `one-page-form.test.ts` (12): pages read back from the PDF bytes; realistic and worst cases (31 days × 3 lines with 80-character customers and a 500-character comment; the 2 000-character comment; 155 rows; a 92-day period; 31 × 350-character attendance notes); every row present, no "…", nothing below the footer; impossible combinations refused |
| PAY-05 | Office month view | `application/finance-packages.ts` `loadPayrollMonth`, `/api/payroll/months/:month`, `FinancePackagePanel.tsx`, page `/payroll` ("Monthly forms") | `payroll.test.ts`, HTTP, smoke |
| PAY-06 | Prepare: manifest, write-once files, one-page check, size limit, one open package per month | `prepareFinancePackage`; 0040 `finance_packages` (guard trigger: manifest and recipient fixed, only prepared/failed → sending → sent/failed or → discarded, never deleted, one open per month) | `payroll.test.ts`, PostgreSQL |
| PAY-07 | ONE email, once; readiness checked first; failure recorded and retryable | `sendFinancePackage` (conditional claim), the existing `EmailService` port (`readiness()` added: the unconfigured adapter says why it cannot send) | `payroll.test.ts`: two clicks → one email; provider failure → failed → retry → sent; unconfigured → refused before claiming; ten technicians → 20 PDFs in one email (fake transport — no real mailbox) |
| PAY-08 | Audit and archive; corrections after sending | audit `finance_package_*`, `monthly_forms_submitted`; `/api/payroll/packages/:id/files`; a correction accepted after sending → "corrected after sending", re-sent only in a new package marked CORRECTED, the sent package byte-identical | `payroll.test.ts` |
| VIS-1 | One mark; theme-correct banner | `scripts/generate-pwa-icons.mjs` now draws the in-app "EJE" tile (brand blue `#0078e4`, the Logo's rule) for the 192/512/maskable/Apple PNGs AND writes `src/app/icon.svg` from the same geometry; service-worker cache v1 → v2 so installed tablets fetch the new icons; the demonstration banner gets the app's dark-amber treatment in dark mode | `manifest.test.ts`, `shell.test.ts`, tablet/layout checks |
| — | Settings: the Finance recipient | `system_settings.finance_email` (0040), Master-only change (`settings.manage`), validated, audited from-and-to; `FinanceRecipientCard` in Administration → System | `payroll.test.ts`, PostgreSQL |
| — | Release safety | `scripts/release/rollback-compat.sh` moved to the live `1a34d1c` and migration 0040: this release writes every new kind of row (document name, Finance recipient, a submitted month, a sent package); 1a34d1c's own code then reads and saves users, settings, attendance, timesheets, corrections, library and jobs | CI step |

### Decisions taken here, for the owner to confirm

1. **Month vs period.** The monthly submission is the timesheet period for
   exactly the calendar month, alongside the From/To periods the owner chose
   on 28 October. If part of a month was already sent as another period, the
   month cannot be submitted (no day is sent twice); the office is asked.
2. **Unrecorded weekdays** do not block a submission (public holidays have no
   absence reason), but the technician must confirm them, and the confirmation
   is audited.
3. **Attendance after submission.** The technician can no longer change the
   month. The office still corrects its register (ATTEND-1); the form in force
   is the register, labelled "Corrected by the office after submission (n
   days)", and the submitted version stays readable.
4. **Who may set the Finance recipient**: a Master only. **Who prepares and
   sends**: Master and Coordinator (`payroll.finance`).
5. **One page.** At the legible floor (5.4 pt), a form with every axis at its
   maximum at once is refused with a plain message rather than printed small or
   on two pages. The examples:
   - three 80-character lines every day, plus the 2 000-character comment, plus
     absent every day;
   - 500-character attendance notes on every day of the month.
   Realistic heavy months fit (section 2, PAY-04).

## 3. Verification

- **CI run 40941799194** on `a46e767` — every job and step green:
  - lint, types, the whole unit and application suite and the build;
  - the PostgreSQL suite, including every 0040 database refusal and the
    payroll flow on the production repositories;
  - **rollback compatibility: `1a34d1c`'s own code against a database at
    0040**;
  - routes, the end-to-end workflow, the signed-document and tablet PDF checks,
    the tablet and phone layout, and smoke.
  - Earlier runs on this work found three real defects, each fixed before the
    release:
    - package storage keys the production file store refuses (6864914);
    - a test seed naming the new users column on an older schema (6864914);
    - the rollback probe writing the previous release's data shapes (d1de8a3).
- **This PC (Windows):**
  - **Unit suite:** 3300 passed, 32 failed. 21 are Windows-only, in files this
    work does not touch: GNU tar reading `C:` as a host, POSIX paths, Unix file
    modes, symlink permission, no OCR engine. They pass on Linux in CI. 11 are
    5-second timeouts under parallel load; those five files then passed on their
    own, 96 of 96.
  - **New suites:** `payroll.test.ts` 27/27; `one-page-form.test.ts` 12/12;
    `payroll-api.test.ts` 2/2; demo migrations.
  - **Lint, types and build:** clean.
  - **Browser:**
    - smoke **260/260** with no console or page errors (one earlier run failed
      the site-location step once — intermittent; it passed in the full re-run
      and in CI);
    - workflow e2e passed;
    - routes passed;
    - tablet and phone layout passed;
    - tablet PDF check **18/18** (the monthly attendance form included).
- **Live (`a46e767`):** 36 API/screen checks and 8 tablet-browser checks
  passed (`docs/staff-testing.md`, last section). Among them:
  - the timesheet and attendance PDFs downloaded from the live site are
    **exactly one page each** (counted in the files) and named
    **`PETER TIMESHEET SEP.pdf` / `PETER ATTEN SEPTEMBER.pdf`**;
  - every bypass was refused;
  - the same 58 open-list, 10 closed, 33 signed and 20 issued jobs as before
    the release, and four issued job cards **byte-identical**;
  - the live icon and favicon are the new mark.

## 4. What only a person, a device, a credential or a decision can finish

| Item | Needs |
|---|---|
| Real Finance email (PAY-07) and customer email (MANDATE-3) | EJE's Microsoft 365 app registration on the server (`EMAIL_GRAPH_*`, `EMAIL_SENDER`) and the approved Finance address set by a Master. Production email is `refuse` today; nothing has been or can be sent from it. |
| WhatsApp | Meta access token and approved templates |
| The real EJE logo (VIS-1) | The owner supplies the logo file; the icon generator then draws it instead |
| Rugged-tablet acceptance (PWA-8, OFF-13, UX-1, ACC-PWA-*, ACC-OFF-*, TS-13, TR-02) | The physical tablet: install, standalone launch, camera/gallery, print dialog and printer, downloaded files, interrupted sessions — staff checks H0–H21 and I1–I13 |
| Off-site backup copy | An object-storage account and the rclone configuration |
| Approval of every TESTED row | The owner (PROC-4) |
| GitHub issue reconciliation | Write access to the repository's issues (listed in section 1) |
| AUD-8 | Demo data that can show a takeover — low priority, open |

## Release

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
