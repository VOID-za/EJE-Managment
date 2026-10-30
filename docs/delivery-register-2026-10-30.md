# Delivery register — 30 October 2026

The owner's "FINAL COMPLETION AND RELEASE TASK" of 30 October 2026, on top of
the release of 29 October (`a46e767`, `docs/delivery-register-2026-10-29.md`).
Two immediate requirements, then everything else still actionable. **Nothing
here is approved:** every row stays TESTED until the owner says otherwise.

## 1. What was found

| Finding | Cause |
|---|---|
| **The Attendance page had no Preview, Print, Download PDF, Export PDF or Send to office.** | They were built on the **Monthly forms** page only (`/payroll`); the Attendance page showed the daily register and "My attendance" and never mounted the monthly form. Nothing was broken — it was never placed where people look. |
| **"Download PDF" and "Export PDF" were one button.** | The monthly forms offered a single "Export PDF" that downloaded the file. |
| **The "new version — Update now" bar would NOT have appeared on an ordinary release.** | It appeared only when the bytes of `/eje-sw.js` changed. They changed on 29 October only because the cache version was bumped by hand for the new icons. A release that did not touch the worker file installed no new worker, so a tablet left open kept running the old build with no notice. |
| **The guarded release tool could not release code without a migration.** | `deploy-release.sh` demanded at least one pending migration; an empty list fell back to an old default and stopped. This release carries no migration. |
| **Two backup checks were wrong on Windows.** | `offsite.ts` compared paths with a literal `/` and `archive.ts` split a `path.normalize`d name on `/`; on Windows both miss (`\`). The server is Linux, so production was never affected, but the code was wrong. |
| **21 unit tests failed on Windows, 11 more timed out under load.** | Investigated one by one — §3. |

## 2. Built

### ATT-UI-1 — the monthly attendance form on the Attendance page

`src/components/attendance/MonthlyAttendanceForms.tsx`, mounted by
`src/app/(app)/attendance/page.tsx`; the same `MonthlyFormsCard`, endpoints and
server rules as Monthly forms (`focus="attendance"`), so the two pages cannot
disagree about a month.

- **Technician** (`/attendance`, top): a Month field (opens on last month), the
  attendance form card with **Preview**, **Print**, **Download PDF**, **Export
  PDF**, the month's status (Not submitted / Submitted, by whom, when; unrecorded
  weekdays; "corrected by the office after submission"), and **Send {month} to
  the office**. The button states that the month's timesheet goes with it: the
  office receives a month as ONE submission (PAY-02) and no day may be sent
  twice, so attendance is not sent separately. After sending, the button is
  gone; a second request is refused by the server (one submission per month,
  write-once in the database since 0040).
- **Office** (Master, Coordinator; `/attendance`, under the register): the month,
  every technician's status (the same statuses as the Finance package), the
  attendance file name, and **Open form** — the same card to read, print,
  download or export. No Send for another person's month (the server refuses it
  too: 403). A day is corrected in the register above; the form then says it was
  corrected by the office after submission. The Finance package (both PDFs per
  technician, one email) stays on Monthly forms, linked from here.
- **Download PDF** saves the one-page PDF under its rule name
  (`NALEDI ATTEN SEPTEMBER.pdf`). **Export PDF** hands the same file to the
  device's share sheet (`src/lib/share-file.ts`) — on Android: email, WhatsApp,
  Drive, a printer app. A browser that cannot share files downloads it instead
  and says so. Both are also on Monthly forms now.

### REL-UPD-1 — the update notice on every release

`src/lib/pwa/app-version.ts` (rules, unit-tested), `ServiceWorkerManager.tsx`
(wiring), `src/lib/pwa/unsaved-work.ts` + `src/hooks/useUnsavedWork.ts`.

1. **Every build knows its commit** (`EJE_BUILD_COMMIT`, already set by the
   release script on the build). The page carries it; `/api/health` reports the
   server's.
2. **The worker is registered as `/eje-sw.js?build=<commit>`.** A different
   script URL is a new worker to the browser, so every release installs one —
   whether or not the worker file changed.
3. **A running page asks `/api/health` which build is live**: on start, on
   returning to the screen, when the connection returns, and every five minutes
   on screen. A different commit shows the bar: **"A new version of EJE is
   available."** — both versions named — with **Update now** and Not now (an
   hour, for that release only).
4. **Update now**: if the screen holds typed work that is not saved (the
   timesheet line/comment, the completion write-up), it first names it and asks.
   Then it installs the new release's worker, tells it to take over, and reloads
   once it has; without a worker (or after 15 s) it reloads anyway — HTML is
   never cached, so a reload always gets the live release.
5. **After the reload** the page checks it IS the release asked for and says
   "EJE has been updated. You are now on version …" once; if not, the bar says
   the update did not take effect and counts the tries. **Nothing ever reloads
   by itself**, so there is no reload loop. A waiting worker for the release
   already on screen is switched on quietly (no reload needed). While a capture
   holds the lock (signature pad), the bar stays hidden, as before.
6. **The release pipeline cannot skip it**:
   - `src/ops/release/update-notification.test.ts` pins every link (build stamp,
     page meta, health, registration URL, the check triggers, the worker's
     take-over message, the CI step, the release-tool check) — `npm test` fails
     if any is removed;
   - CI step **"Update notice across two releases"** (`scripts/update-check.mjs`)
     builds a SECOND real release and proves the notice and Update now in a
     tablet-sized browser;
   - `deploy/release/stage-release.ps1` now finishes a release only when a
     freshly served page carries the new build AND the worker answers for it.

### REL-NOMIG-1 — code-only releases through the guarded tool

`EXPECT_PENDING=none` (`-ExpectPending none`): every gate still runs — build,
backup, verify, key check, restore test, preflight — and the preflight must show
**every shipped migration already applied**; nothing is migrated. Declared
code-only while a migration is pending → STOP, nothing changed. Four new cases in
`deploy/release/deploy-release.test.sh`.

## 3. The previous test failures, one by one

| Tests | Cause | Done |
|---|---|---|
| `plan.test.ts` ×4, `file-storage.test.ts` ×3, `offsite.test.ts` "takes a mounted directory" | Expected POSIX strings (`/var/backups/…`); `path.resolve` spells them `C:\var\…` on Windows | Expectations go through `resolve()` — identical on Linux, correct on Windows |
| `offsite.test.ts` "REFUSES a destination inside the backup directory" | **Code bug**: `startsWith(\`${backups}/\`)` | `offsite.ts` uses `path.sep` |
| `archive.test.ts` "REFUSES a path that climbs out" | **Code bug**: `normalize()` turns `/` into `\` on Windows, then splits on `/` | `archive.ts` reads tar member names with `posix.normalize` (they are POSIX on every platform) |
| `archive.test.ts` "unpacking a real archive" ×8 | GNU tar reads `C:\…` as a remote host | Skipped on Windows only, reason in the test; run on Linux (CI, the server) |
| `crypto.test.ts` "0600" | Windows has no Unix permission bits (reads back 0666) | Skipped on Windows only, reason in the test |
| `ocr.test.ts` ×2 | They stand `/bin/echo` in for the engine; Windows has no `/bin/echo` | Skipped on Windows only, reason in the test |
| 11 timeouts in five API files | Vitest's 5 s ceiling with every core busy; 96/96 alone | Not reproduced in an idle full run (0 failures); `testTimeout` raised to 15 s so load cannot fail healthy tests |

## 4. Verification

**This PC (Windows), every browser suite run ALONE** — a first back-to-back
batch was stopped by the machine running out of memory, and its failures were
investigated, not discarded:

| Check | Result |
|---|---|
| Unit and application suite | **3340 passed, 0 failed**, 19 skipped (the 11 Windows-only of §3, and 8 that were already skipped) |
| Typecheck, lint, production build | clean |
| Release script sandbox (`deploy-release.test.sh`) | **85 passed, 0 failed** (four new code-only cases) |
| Route and permission check | passed |
| Workflow end-to-end | **65 passed, 0 failed** (the batch's one failure, "a rate change does not alter the downloaded document", passed alone) |
| Signed document on both PDF paths | passed |
| Tablet and phone layout | **108 passed, 0 failed**. The batch's four failures were "Reload" and "Back" buttons on /admin and /attendance; neither label exists in EJE's code, a probe of both pages found neither button in the page or any frame, and every page passes alone — the browser's own error page while the starved server did not answer |
| Smoke | **261 passed, 0 failed**, no console or page errors (twice). The run before that found a defect IN THE NEW TEST: on a browser WITH a PDF viewer, Print prints from the PDF frame, which the stub did not catch, so the preview stayed open and a real print in headless Chrome crashed the tab (91 cascading failures). The step now prints on the tablet path (no viewer — what the tablets and CI's browser have) and ends the print with `afterprint` like a real one; the desktop viewer path stays covered by `tablet-pdf-check` |
| Update notice across two real builds (`update-check`) | **6 of 6 passed**, release B rebuilt from this code |

The Attendance smoke step covers every role: the technician previews, prints,
downloads (one page, rule name), exports (one page, same name) and sends once
(a second request refused); the Master and the Coordinator see the status,
open the form, and are not offered Send; another technician sees only their
own form and gets 403 on Naledi's forms, her PDF and the office month.

See "Release" below for CI and the live part.

## 5. What only a person, a device, a credential or a decision can finish

| Item | What is missing | Who |
|---|---|---|
| Real Finance and customer email | The adapter is built and tested (Microsoft Graph). Missing: an app registration in EJE's Microsoft 365 tenant — `EMAIL_GRAPH_TENANT_ID`, `EMAIL_GRAPH_CLIENT_ID`, `EMAIL_GRAPH_CLIENT_SECRET`, `EMAIL_SENDER` (the sending mailbox) — with `Mail.Send`, `Mail.ReadWrite` and `Mail.ReadBasic.All` application permissions, admin consent, and an application access policy limiting it to the sender (`docs/integrations.md`); the values go in the server's `/etc/eje/eje.env` only. Then a Master sets the approved Finance address (Administration → System → Finance recipient). Production email stays `refuse` until then. | EJE's Microsoft 365 administrator, then a Master |
| The real EJE logo | None exists in the repository, the project folder, or the EJE documents in Downloads (no images in them). The generated "EJE" mark stays until one is supplied. | Owner |
| Physical rugged tablet | Install from the browser, camera, the print dialog with a real printer, opening a downloaded PDF, the share sheet for Export PDF, and Update now on the device | Staff (staff-testing H, I, J) |
| Off-site backup copy | An object-storage account (rclone remote) or a mounted second disk — `EJE_BACKUP_OFFSITE_RCLONE` / `EJE_BACKUP_OFFSITE_DIR` | Owner |
| GitHub issues | This session has no GitHub write access; the stale issues are listed in `docs/delivery-register-2026-10-29.md` §1 | Owner |
| Approval | Every TESTED row | Owner |

## Release

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
