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

### The order that works, as rehearsed on the live server on 24 October 2026

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
| 2 `job_media` (`uploads/<uuid>`) | **NOT seeded.** Uploaded through the application before this release, and the bytes are not in the store. Every `job_media` row on the server is one of these two. Unexplained — an open finding, not something this deployment caused or can repair |

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
