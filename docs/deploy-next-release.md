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

## NEXT RELEASE — from `claude/office-workflow-parts` (checklist prepared 26 October 2026, NOT RUN)

**Nothing below has been run.** It needs the owner's approval of the work and a
separate approval to deploy. It is written so that whoever runs it can tell, at
each step, whether to continue.

### Which migrations are pending — VERIFY, do not assume

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
