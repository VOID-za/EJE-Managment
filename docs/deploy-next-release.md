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

### Added since: migrations 0015–0020 — read this before step 5

| Migration | What it does | Risk |
|---|---|---|
| `0015_provenance_and_categories` | Adds `provenance` to four tables (default `genuine`) and five values to the library's type enum | Additive. **Backfills every existing row to `genuine`** — see the warning below |
| `0016_customer_documents` | New table | Additive |
| `0017_machine_documents` | New table | Additive |
| `0018_provenance_unknown` | Widens the provenance CHECKs to admit `unknown`, changes the DEFAULT to `unknown`, creates `provenance_recording`, and **UPDATEs rows written before provenance existed** in five tables | **The only data-modifying migration in this release.** See below |
| `0019_job_corrections` | New table, CHECKs and an append-only trigger | Additive |
| `0020_unsigned_delivery_authorisations` | New table and an append-only trigger | Additive |

**No `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`, no `DELETE`** anywhere in
the six. Every `NOT NULL` is on a column of a new table.

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

`EJE_DEPLOYMENT` must be set before step 4, to `production` or
`demonstration`. The current live site is a **demonstration** deployment, and
saying so is what makes its preflight pass honestly rather than being waved
through — and what makes the demonstration switcher refuse to arm anywhere
that says `production`. See `docs/demonstration-isolation.md`.

Two things this release deliberately does **not** do: it does not write document
bytes anywhere, and — apart from 0018's provenance relabelling, described above
— it does not modify, repair or delete any existing row.

## 1. Back up first, and prove the backup

The one step that must not be skipped, and the first time it can be proved.

```bash
sudo systemd-run --unit=eje-backup-predeploy --uid=eje --gid=eje \
  --working-directory=/opt/eje/app \
  --property=EnvironmentFile=/etc/eje/eje.env \
  /usr/bin/npm run backup

journalctl -u eje-backup-predeploy          # the directory it wrote
cd /opt/eje/app
sudo -u eje --preserve-env npm run backup:verify       /var/backups/eje/eje-eje_production-<stamp>
sudo -u eje --preserve-env npm run backup:restore-test /var/backups/eje/eje-eje_production-<stamp>
```

`EJE_BACKUP_KEY` must be set in `/etc/eje/eje.env` and **a copy of it must
already be somewhere that is not this server**. A backup whose key is lost is a
directory of noise.

The restore test will report some references as "already missing when this
backup was taken". On this deployment that is expected: the six seeded
demonstration job cards are rendered on first download. It must **not** report
anything as lost.

## 2. Look at the documents before changing the code

```bash
cd /opt/eje/app
sudo -u eje --preserve-env npm run documents:reconcile -- --report /tmp/documents-before.json
```

This is read-only and it answers the question that decides whether step 4 is
safe: **is any stored document already damaged?** If anything reports
`contradicted` or `damaged`, stop and restore that document from a backup
first — after this release those documents will refuse to open, which is
correct and is better found now than by the office.

Expected on the live server today: six `absent_demonstration`, several
`unrecorded` (every row written before this release), nothing else.

## 3. Build the new release beside the old one

Never build in `/opt/eje/app`: a build replaces `.next` in place, so a failure
leaves the live application unable to serve its own pages.

```bash
COMMIT=$(git -C /opt/eje/app rev-parse --short origin/claude/eje-job-card-demo-k2klb4)
sudo install -d -o eje -g eje /opt/eje/releases
sudo -u eje git clone --no-hardlinks /opt/eje/app /opt/eje/releases/$COMMIT
cd /opt/eje/releases/$COMMIT
sudo -u eje git fetch origin claude/eje-job-card-demo-k2klb4
sudo -u eje git checkout $COMMIT
sudo -u eje npm ci
sudo -u eje npm run build          # detached, per docs/vps-backups.md §0, if the SSH session is fragile
```

## 4. Preflight the new release against the live configuration

```bash
cd /opt/eje/releases/$COMMIT
sudo -u eje env $(sudo cat /etc/eje/eje.env | xargs) NODE_ENV=production \
  npm run preflight -- --expect-db eje_production
```

It must pass. It reads the database, the storage directory and the environment
and writes nothing but one probe file it deletes again.

## 5. The migration

```bash
cd /opt/eje/releases/$COMMIT
set -a; . /etc/eje/eje.env; set +a
sudo -u eje --preserve-env=DATABASE_URL,NODE_ENV,EJE_STORAGE_DIR,EJE_PERSISTENCE \
  EJE_PRODUCTION_MIGRATION=eje_production npm run db:migrate
```

`0014_document_verifications` creates one table and one trigger. It is additive,
so **the old code runs against the new schema** — which is what makes step 8's
rollback safe.

## 6. Switch, and prove what is serving

```bash
sudo systemctl stop eje
sudo mv /opt/eje/app /opt/eje/releases/previous-$(date -u +%Y%m%dT%H%M%SZ)
sudo ln -sfn /opt/eje/releases/$COMMIT /opt/eje/app   # or mv the directory into place
sudo systemctl start eje

curl -s localhost:3000/api/health        # commit must be $COMMIT; backend postgres; database reachable
EJE_CHECK_URL=https://eje.syncza.co.za npm run check-routes
```

`/api/health` carries the commit it was BUILT from, so it is the one thing that
proves what is serving. `demoSwitcher` must still read `true` — EJE want demo
switching kept on this deployment — and `email` will read `refuse` until a
Microsoft 365 tenant exists.

## 7. Record what the documents are, and schedule the backups

```bash
cd /opt/eje/app
sudo -u eje --preserve-env npm run documents:reconcile -- --record
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
sudo systemctl daemon-reload
sudo systemctl enable --now eje-backup.timer eje-backup-restore-test.timer
systemctl list-timers 'eje-backup*'
```

The units reference `/opt/eje/app` and `/var/backups/eje`; check those two
paths before enabling. Set `EJE_BACKUP_KEEP` and an off-site destination in
`/etc/eje/eje.env` — see `docs/vps-backups.md`.

## 8. Rollback

```bash
sudo systemctl stop eje
sudo ln -sfn /opt/eje/releases/previous-<stamp> /opt/eje/app
sudo systemctl start eje
curl -s localhost:3000/api/health         # the commit must be the OLD one
```

What rollback does and does not need:

- **The migration is not rolled back, and must not be.** `0014` only adds a
  table; the old code neither reads nor writes it. Dropping it would delete the
  observations recorded in step 7 — the only independent record of what each
  document's bytes were. **The same holds for 0015–0020**, and more strongly:
  `job_corrections` and `unsigned_delivery_authorisations` hold decisions
  somebody took about a customer's document, `customer_documents` and
  `machine_documents` hold files that exist on disk, and
  `provenance_recording` is the one row that stops a backfilled label being
  read as a chosen one. Dropping any of them destroys a record the old code
  simply ignores.
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
