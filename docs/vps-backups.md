# Backups: taking them, proving them, scheduling them, getting them off the box

**Status on 20 October 2026, before any of this is installed:** the live server
at `eje.syncza.co.za` had **no scheduled backup of any kind**. Every backup on
it was taken by hand, so the gap between them was however long it had been
since somebody remembered. There were two older PostgreSQL dumps in `/opt/eje`
and one encrypted backup in `/var/backups/eje`, whose restore test failed — for
a reason that turned out to be a defect in the restore test rather than a
missing document. See *What was actually wrong* at the end.

Everything below runs as the `eje` service user on the VPS. Nothing in it
touches the live database except to read it.

---

## 0. Run it detached. Always.

A backup of a loaded database, a restore test and a `pg_restore` all outlive an
SSH session that drops — and Termius drops. Nothing here should ever be typed
into an interactive shell and waited on:

```bash
# a one-off, now, that survives the laptop closing
sudo systemd-run --unit=eje-backup-manual --uid=eje --gid=eje \
  --working-directory=/opt/eje/app \
  --property=EnvironmentFile=/etc/eje/eje.env \
  /usr/bin/npm run backup

journalctl -fu eje-backup-manual        # watch it, or do not; it keeps running
systemctl status eje-backup-manual      # what it finished as
```

The same applies to the restore test, to `db:migrate`, and to a production
build. If you only have `nohup`, that is fine too:

```bash
cd /opt/eje/app && nohup npm run backup > /tmp/eje-backup.log 2>&1 &
```

---

## 1. What a backup contains, and why both halves

```
/var/backups/eje/eje-<database>-<stamp>/
  database.dump.enc        pg_dump -Fc, AES-256-GCM
  storage.tar.gz.enc       every file under EJE_STORAGE_DIR, AES-256-GCM
  manifest.json            what this is, what it hashes to, what was dangling
  unresolved-references.json   written by a restore test that found any
```

The documents are the half that cannot be rebuilt. The database can be
recreated from migrations and re-seeded; a customer-signed job card exists in
exactly one place, which is a file under `/var/lib/eje/storage`, and
`final_documents` holds only a key pointing at it. A database-only backup is a
backup of the index.

If either half cannot be produced, the run removes the whole directory and
fails. A directory holding only `database.dump` would be found by somebody in a
hurry and trusted.

## 2. Configure it

In `/etc/eje/eje.env` (root-owned, readable by `eje`) — the template is
`deploy/eje.env.example`:

| Variable | What it is |
|---|---|
| `EJE_BACKUP_DIR` | Where backups are written. `/var/backups/eje`. Not inside `EJE_STORAGE_DIR`. |
| `EJE_BACKUP_KEY` | 64 hex characters: `openssl rand -hex 32`. **Keep a copy that is not on this server.** |
| `EJE_BACKUP_KEEP` | How many to keep. Unset keeps everything. |
| `EJE_BACKUP_OFFSITE_DIR` | A mounted volume to copy each backup to. |
| `EJE_BACKUP_OFFSITE_RCLONE` | An rclone remote, `remote:path`. |

**The key is the one thing that cannot be recovered.** A backup whose key is
lost is a directory of noise, and a key kept beside the backups protects
nobody.

### 2.1 Key escrow, and the drill that proves it — BACKUP-2

"The key is in the password manager" is a **belief** until somebody has tried
that copy against a real backup. The morning it matters is the worst possible
time to discover it was last year's key, or the right key with a space on the
end.

**Escrow it in two places that are not this server:**

1. **EJE's password manager**, as a secret named for the period it covers —
   `EJE backup key (from 2026-10)` — with the **fingerprint** in the note
   field. The fingerprint is not secret; it is in every manifest.
2. **A sealed printed copy** in whatever EJE use for a safe. A password manager
   is an account, and an account can be lost with the person who held it.

**Then run the drill, now and after every key change — WHERE THE ESCROWED COPY
IS, not on the server.** Carrying the off-site copy to the VPS to test it puts
it, for a while, on the one machine it exists to survive. So check it on the
computer that already holds it, against the fingerprint every backup prints
(`key 23dba6772da10057` on the live server, October 2026):

```powershell
# in a checkout of this repository, on the owner's own computer
npm run backup:escrow-check -- --expect 23dba6772da10057
#   paste the escrowed key at the hidden prompt, then Enter
npm run backup:escrow-check -- --expect 23dba6772da10057 --key-file E:\eje-backup-key
```

`MATCH` exits 0, `NO MATCH` exits 1, something that is not a 64-hex key exits
2. Nothing about the key is printed and nothing is sent anywhere — the
fingerprint is a truncated SHA-256 computed locally.

The server-side drill below remains for a copy that is already on the server
(a USB disk attached to it, say):

```bash
# Put the escrowed copy in a file, read it back, and delete the file.
#   (Never paste a key on a command line: it lands in shell history.)
umask 077 && cat > /tmp/eje-key-test     # paste, then Ctrl-D
npm run backup:key-check /var/backups/eje/eje-eje_production-<stamp>         --key-file /tmp/eje-key-test
shred -u /tmp/eje-key-test
```

It prints two fingerprints and `MATCH` or `NO MATCH`, exits non-zero on a
mismatch, and **decrypts nothing, restores nothing and writes nothing**. It
never prints the key, any part of it, or its length — the output of this
command ends up in a terminal somebody is sharing.

A `NO MATCH` means the key is wrong, **not** that the backup is damaged, and
the message says so along with the fingerprint to go looking for.

**Verified in this repository** on a real encrypted backup of a real
PostgreSQL 16 database with real stored files: the environment's key matched,
the same key read from a file matched, and a freshly generated key reported
`NO MATCH` and exit code 1.

**AND THE ONE ARRANGEMENT THAT MUST NEVER BE THE ONLY ONE IS NOW NAMED OUT
LOUD.** A key kept in `/var/backups/eje/` is not a recovery method: the disk
that loses the backups loses it, the stolen volume carries it, and every drill
passes right up to the morning it matters. An encrypted backup whose key
travels beside it is an unencrypted backup.

Neither command can prevent it — a file an operator put on a server is not the
application's to delete — so both **say so, every time**:

- `npm run backup` names any file in the backup root whose entire contents are
  a backup key. The file's NAME is printed; what it contained never is.
- `npm run backup:key-check … --key-file <path>` warns before it answers when
  that path is inside the backup directory or anywhere under the backup root.
  It still answers `MATCH` or `NO MATCH`: the question is about the key, and an
  operator working out which key they hold must not be stopped.

Checking an escrowed key that lives on a USB stick, in a password manager's
export or in an operator's home directory warns about nothing, which is the
point — a warning that cries wolf is one somebody learns to skip.

## 3. Take one, and prove it

```bash
npm run backup                              # dump + documents + encrypt + record
npm run backup:verify  <directory>          # recompute the checksums, decrypt, authenticate
npm run backup:key-check <directory>        # is the key you hold the key this needs? (§2.1)
npm run backup:restore-test <directory>     # the only honest proof: restore it
```

`backup:verify` catches damage — bit rot, a truncated copy, an interrupted
transfer — and alteration, because decrypting authenticates the GCM tag and a
tag cannot be forged without the key. It does **not** prove the backup
restores.

`backup:restore-test` does. It creates its own scratch database (a name it
generates, checked against a pattern *and* against the source's name), restores
into it, checks that the tables a business cannot lose are present and
populated, unpacks the documents, and then resolves **every storage key in the
restored database against the files it unpacked**. It drops the scratch
database and deletes the plaintext afterwards, including on Ctrl-C and SIGTERM.
A restore test that passes writes a dated record into the manifest; until it
says so, nobody has read those bytes back.

### Reading what a restore test says about missing documents

```
restore  23 of 25 storage key(s) resolved to a stored file
restore  2 were ALREADY missing when this backup was taken (recorded in its manifest), so the backup did not lose them
```

That is fine, and it is not hidden: both numbers go into the manifest. Keys
with no file behind them are normal here — a photo capture path allocates a key
without sending bytes, and a seeded demonstration job card's PDF is rendered on
first download.

```
restore  12 HAD a file when the backup was taken and do not now — this backup is missing documents
restore  FAILED: ...
```

That is an incident, it exits non-zero, and no environment variable makes it
pass. Every unresolved key is listed in `unresolved-references.json` beside the
backup — in full, because deciding whether a document is genuinely gone needs
the names, and three examples cannot tell you.

`EJE_RESTORE_ALLOW_ORPHANS=yes` now does one narrow thing: a backup taken
*before* the manifest recorded dangling references knows nothing about what was
already missing, so everything reads as lost. If you know that database was
seeded rather than worked in, that flag says so and the count goes into the
manifest rather than being hidden. It cannot excuse a document the backup's own
manifest says was there.

## 4. Schedule it

```bash
sudo cp deploy/eje-backup.service deploy/eje-backup.timer \
        deploy/eje-backup-alert.service \
        deploy/eje-backup-restore-test.service deploy/eje-backup-restore-test.timer \
        /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eje-backup.timer eje-backup-restore-test.timer
systemctl list-timers 'eje-backup*'
```

| Unit | When | What |
|---|---|---|
| `eje-backup.timer` | 02:12 nightly, catches up a missed run | the backup |
| `eje-backup-restore-test.timer` | Sunday 03:40 | restores the newest backup into a scratch database |
| `eje-backup-alert.service` | on failure of either | writes the failure to the journal, loudly |

**How a failure reaches a person.** Every run writes
`$EJE_BACKUP_DIR/last-run.json` — outcome, start, finish, and the reason if it
failed — on both outcomes. A failed timer additionally starts the alert unit,
which logs at `daemon.err` with the tag `eje-backup`, which is what a log
search or a monitoring agent matches on.

It does **not** email or WhatsApp anybody, and that is deliberate rather than
unfinished: this deployment has no verified mail transport (`/api/health`
reports `"email":"refuse"` because no Microsoft 365 tenant is configured). An
alert that silently fails to send is worse than none, because somebody stops
checking. When the tenant is configured, add one `ExecStart=` line to
`eje-backup-alert.service` and nothing else changes.

The daily check an operator can do in five seconds:

```bash
systemctl list-timers 'eje-backup*'          # did it run, when is the next
cat /var/backups/eje/last-run.json           # what happened
ls -1 /var/backups/eje | tail -3             # is the shelf growing
```

## 4a. The client tools must match the server

```bash
pg_dump --version                  # must be the same MAJOR as:
psql "$DATABASE_URL" -At -c 'show server_version'
```

A `pg_dump` **newer** than its server writes a dump that cannot be restored
onto that server. PostgreSQL 17's `pg_dump` emits `SET transaction_timeout`,
which PostgreSQL 16 does not recognise, and the restore dies partway through
with a message that reads like a server misconfiguration:

```
pg_restore: error: could not execute query: ERROR:
  unrecognized configuration parameter "transaction_timeout"
```

Until this was checked, that failure appeared only at **restore** time. The
backup kept reporting success, kept being encrypted and checksummed and copied
off-site, and none of it could be restored — the exact shape of failure this
requirement exists to prevent. `npm run backup` now refuses before it writes
anything, naming the package to install:

```
backup   REFUSED: pg_dump is version 18 and the server is 16. The dump it would
         write CANNOT BE RESTORED onto this server … Install the client tools
         that match the server (`postgresql-client-16`) …
```

`EJE_BACKUP_ALLOW_VERSION_SKEW=yes` overrides it, for the one legitimate case:
the restore target is deliberately a newer server. **Write down which server
that is**, because such a dump will not go back where it came from.

This is why the VPS should pin its client tools rather than take whatever
`apt upgrade` offers, and why CI installs `postgresql-client-16` explicitly
beside its PostgreSQL 16 service container.

## 5. Get it off the machine

A backup in `/var/backups/eje` is on the same disk as
`/var/lib/eje/storage`. It survives a mistaken `DELETE` and nothing else — not
the disk, not the provider, not ransomware, not an unpaid invoice. Every run
with no off-site destination says so in its own output.

Two shapes are implemented, both configured outside this repository:

```bash
# a mounted volume — NFS, an object-store mount, a disk somebody takes away
EJE_BACKUP_OFFSITE_DIR=/mnt/offsite/eje
```

The run warns if that path turns out to be on the same filesystem as the
backups: then it is a second copy on one disk and must not be counted as
off-site in any statement to EJE.

```bash
# an rclone remote: S3, Backblaze B2, Google Drive, anything rclone speaks
sudo -u eje rclone config          # the operator does this, once
EJE_BACKUP_OFFSITE_RCLONE=eje-offsite:eje-backups
```

The run does `rclone copy` and then **`rclone check`**, which compares
checksums at both ends — a copy nobody compared is a hope. rclone keeps its own
credentials in its own config file; they never go in `/etc/eje/eje.env`, where
a cloud key would be one `cat` away from every backup EJE has.

If the off-site copy fails, the local backup is **kept** and the command still
fails: a backup on one machine is worth more than no backup, and the timer must
not record success for a copy that never left.

### What is still needed from EJE for a real off-site destination

Nothing in this repository can create one. One of these has to be supplied:

1. **An object-store bucket and credentials** (S3, Backblaze B2, Wasabi,
   Cloudflare R2). Give them to the operator, who runs `rclone config` on the
   VPS as the `eje` user; then set `EJE_BACKUP_OFFSITE_RCLONE`. Nothing is
   stored in the repository and the credential can be revoked at the provider.
2. **A second machine or NAS** reachable from the VPS, mounted at a path, and
   `EJE_BACKUP_OFFSITE_DIR` pointed at it.
3. **A removable disk** that somebody physically takes off site on a stated
   rotation, mounted at that same path.

Also decide: **how long backups are kept** (`EJE_BACKUP_KEEP`), and **who holds
the encryption key** and where (§2.1). Until one of the three exists, EJE has no
off-site backup, and no part of this repository should be read as saying
otherwise.

### 5.1 The recommendation, and what it costs — October mandate, Workstream B

**Option 1, an S3-compatible bucket reached by rclone, is the secure default**,
and these are the trade-offs rather than a sales pitch:

| | rclone to object storage | A second machine or NAS | A removable disk |
|---|---|---|---|
| Survives the VPS being lost | **yes** | yes, if it is elsewhere | yes, once it is off site |
| Survives ransomware on the VPS | **yes, with versioning or object-lock on the bucket** | only if the VPS cannot delete on it | yes, once unplugged |
| Credential on the VPS | an rclone remote, **revocable at the provider**, never in `/etc/eje/eje.env` | an SSH key or NFS mount | none |
| Needs somebody to do something weekly | no | no | **yes, and that is the risk** |
| Verified copy | `rclone check` compares checksums at both ends, and `npm run backup` runs it | `cmp`, by hand | by hand |
| Ongoing cost | a few rand a month at this volume | hardware EJE may already own | a disk and a rotation |
| Fails quietly if nobody looks | no — a failed copy fails the run | no | **yes: a disk nobody rotated** |

**Why not a credential in `/etc/eje/eje.env`.** rclone keeps its own config
with its own credentials, which this repository never reads. A cloud key in the
environment file would be one `cat` away from every backup EJE has — by exactly
the process whose compromise the off-site copy exists to survive.

**Write-once, if the provider offers it.** Backblaze B2 and S3 both support
object lock. Turn it on. A backup an attacker on the VPS can delete is a
backup that will be deleted.

**What the repository already does, and needs no further work:**

- plans the destination from the environment and **refuses** a path inside
  `EJE_BACKUP_DIR` (that is not a second copy, and retention would delete both);
- refuses an `EJE_BACKUP_OFFSITE_RCLONE` that is not `remote:path`;
- warns, on every run, when a directory destination turns out to be **on the
  same filesystem** as the backups — it still writes the copy, and says it must
  not be counted as off-site. *Verified locally: the copy is written and the
  warning is printed.*
- runs `rclone copy` **and then `rclone check`**, because copy means "it
  transferred what it decided to" and check is what catches a truncated upload
  or a quota that ran out mid-way;
- says **"NO OFF-SERVER DESTINATION IS CONFIGURED"** on every run until one is.

**What EJE must supply, and it is the whole of what is outstanding:**

1. a bucket at a provider (or a second machine, or a disk and a rotation);
2. `rclone config` run **on the VPS as the `eje` user**, creating the remote;
3. `EJE_BACKUP_OFFSITE_RCLONE=<remote>:<path>` in `/etc/eje/eje.env`;
4. object lock or versioning on the bucket, if the provider has it;
5. the key escrowed per §2.1, and the drill run once against a real backup.

Nothing in this repository can do any of those, and none of it is claimed as
done.

## 6. Restoring, for real

This is the procedure nobody should be reading for the first time during an
incident.

```bash
# 1. Stop the application. A restore under a running server is a corruption.
sudo systemctl stop eje

# 2. Verify the backup you are about to trust, and restore-test it FIRST if
#    there is any doubt. It does not touch the live database.
npm run backup:verify /var/backups/eje/eje-eje_production-<stamp>

# 3. Decrypt into a working directory (0700, and delete it afterwards).
#    `backup:verify` leaves nothing behind, so this is an explicit step:
sudo -u eje mkdir -p /var/tmp/eje-restore && sudo chmod 700 /var/tmp/eje-restore
# ... decrypt with the same key the manifest's fingerprint names ...

# 4. The database, into a NEW database, never over the live one in one step.
createdb eje_production_restored
pg_restore --dbname "postgres://…/eje_production_restored" --no-owner --no-privileges \
           --exit-on-error database.dump

# 5. The documents, beside the live ones, never over them.
tar -xzf storage.tar.gz -C /var/lib/eje/storage-restored

# 6. Look at it before you swap anything: counts, the newest job, the newest
#    final document, and `npm run documents:reconcile` against the restored
#    pair, which says whether every document record has its file.

# 7. Only then swap, and keep what you replaced:
#    rename the databases, move the storage directory aside rather than deleting
#    it, start the application, check /api/health and open a signed job card.
```

**Never** restore over `eje_production` or over `/var/lib/eje/storage` in a
single irreversible step. The restored copy is the thing being proved; the
existing one is the only fallback if the backup turns out to be worse.

## 7. The document register, beside the backups

```bash
npm run documents:reconcile                      # report only
npm run documents:reconcile -- --record          # keep the findings as rows
npm run documents:reconcile -- --report /tmp/documents.json
```

It reads every `final_documents` row, looks for the file behind it, and
classifies it:

| Verdict | Meaning |
|---|---|
| `intact` | The file is there and the row describes it correctly. |
| `unrecorded` | The file is there and the row records no length or checksum. Expected on every row written before 20 October 2026. |
| `contradicted` | The row and the file disagree. Compare against a backup; the tool will not choose. |
| `damaged` | The bytes are there and are not the bytes that were written. Restore them. |
| `absent_demonstration` | No file, and the job is part of the shipped demonstration dataset. Housekeeping. |
| `absent_genuine` | No file, and the job is not. **A lost customer record.** |

It exits non-zero on the last three. It never writes document bytes, never
removes a row, and never offers to re-render a missing document: a fresh render
is a new document carrying an old date, and the customer holds the real one.

`--record` appends to `final_document_verifications`. It does **not** update
`final_documents`, which is write-once and whose UPDATE the database refuses —
that refusal is one of the protections CR-01 rests on, and the first version of
this tool was correctly stopped by it.

## 8. Looking inside an old dump, safely

```bash
npm run dump:inspect -- /opt/eje/eje-backup-20260925-092747.dump
```

It restores the dump into a scratch database of its own — a generated name,
checked against a pattern *and* against the name in `DATABASE_URL` — reports
what the register said, and drops that database on success, on failure and on
Ctrl-C. It never writes to the database in `DATABASE_URL`; that URL is used
only to reach the server.

Use it when a document is missing and you want to know what an older copy of
the register said about it: the storage key, the date it was issued, whether
the row recorded a size at all.

**A dump contains no documents.** `final_documents` holds a key; the bytes live
under `EJE_STORAGE_DIR`, and only a storage archive — `storage.tar.gz.enc`
inside a backup taken by `npm run backup` — can give them back. The two
hand-made dumps in `/opt/eje` are registers, not documents, and no amount of
reading them will recover a PDF.

`pg_restore --list` is not a substitute: a table of contents says which tables
exist and nothing about the rows, which is why the first attempt at this on the
server came back empty.

---

## What was actually wrong, 20 October 2026

Recorded here because the numbers an operator saw on the live server were all
real and all explainable, and three of the four causes were defects in this
repository rather than lost data.

| What was seen | What it was |
|---|---|
| 14 `final_documents` rows, every one with `size_bytes = 0` and no checksum | The repository's insert never wrote either column, and hard-coded `renderer_version` to 0 — while the schema's comment said the checksum was verified on every read. Fixed; new rows record what the store measured, and old rows get an observation in `final_document_verifications` because the row itself may not be changed. |
| The restore test reporting 25 references with no stored file | The test compared a storage key (`jobcards/final/X.pdf`) against unpacked file names (`jobcards/final/X.pdf.bin`). It matched nothing, so **every** reference read as a missing document — and the only way to make it pass was a flag that accepted every missing document silently. Fixed. |
| Six job cards absent from storage — EJE-2015, 2016, 2017, 2019, 2020, 2021 | All six are jobs in the shipped **demonstration** dataset, whose PDFs are rendered on first download rather than at issue. `npm run documents:reconcile` names them as demonstration data, read from the seed itself. Nothing was lost. |
| No scheduled backup | True, and the units in `deploy/` are the fix. They are **not installed** by anything in this repository; somebody with root on the VPS has to copy and enable them. |
