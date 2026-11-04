# Off-server backups and recovering from the loss of the VPS (BACKUP-1, BACKUP-2)

State on 4 November 2026, and what the owner still has to decide.

## What runs today

| | Where | What | Schedule | Kept | Proven by |
|---|---|---|---|---|---|
| **Local backup** | the VPS, `/var/backups/eje` | `pg_dump` + every stored document, **encrypted AES-256-GCM** (key fingerprint `23dba6772da10057`), with a manifest of sizes and SHA-256s | nightly, `eje-backup.timer` (~02:14 UTC), and at every release | the newest 30 | `backup:verify` every release; **weekly restore test** (`eje-backup-restore-test.timer`, Sundays) into a scratch database, then dropped |
| **Off-server copy (interim)** | the owner's computer, `C:\Users\jcmos\EJE-offsite-backups` | the **same ciphertext**, manifest and checksums — never plaintext; the key is **not** copied | daily, Windows Task Scheduler task **"EJE off-server backup pull"** (07:30 local), running `deploy\backup\pull-offsite.ps1` | the newest 14 | every artefact's size and SHA-256 re-checked on this computer against its own manifest before it is kept; a copy that fails is deleted and the run is marked failed |

**Monitoring.** On the VPS a failed backup or restore test sets `last-run.json`
to `failed` and starts `eje-backup-alert.service`, which writes it to the system
log (`journalctl -t eje-backup`). On this computer every pull writes
`last-pull.json` (`"outcome": "ok"` or `"failed"`, with the reason) and
`pull-offsite.log`; the scheduled task's result in Task Scheduler is non-zero on
failure. Neither can email anyone yet — email is not configured.

**Proven on 4 November 2026.** The v1.2.0 release's backup
`eje-eje_production-2026-11-04T10-36-46Z` was copied to this computer, verified
here (both artefacts' SHA-256 matched the manifest; the dump is ciphertext), then
carried back to an isolated directory on the VPS (`/var/lib/eje-offsite-check`,
not `/var/backups`) and **restore-tested from that copy**: verify "intact and
authentic", restored into a scratch database (jobs 104, users 7, customers 9,
machines 14, final documents 54, job media 27, signatures 68, audit events
1 952), 184 documents unpacked, scratch database dropped, the working copy
removed. The first scheduled-style pull then copied and verified the 14 newest
backups.

## Why this is not finished — the owner's decisions

1. **The backup key exists only on the VPS** (`EJE_BACKUP_KEY` in
   `/etc/eje/eje.env`). If the VPS is lost, **every backup — on the VPS or off
   it — is unreadable** without a second copy of that key. **BACKUP-2:** name a
   holder and store the key in a password manager or sealed safe, then prove it:
   1. The owner, on the VPS: `sudo grep '^EJE_BACKUP_KEY=' /etc/eje/eje.env`
      and copy the value straight into the password manager (not into email,
      chat or a file on this computer).
   2. On the owner's computer, in this repository:
      `npm run backup:escrow-check -- --expect 23dba6772da10057` and paste the
      key at the hidden prompt. It must say **MATCH**. It decrypts nothing and
      prints no part of the key.
2. **A permanent off-site destination (BACKUP-1).** This computer is a real
   second place, but it is one machine, on only when someone uses it, and in
   the same office as the people. The secure default is an **S3-compatible
   bucket** (Backblaze B2, Cloudflare R2, AWS S3, Wasabi) reached by rclone,
   which the backup run already supports (`EJE_BACKUP_OFFSITE_RCLONE`: it runs
   `rclone copy` then `rclone check`, and a failure fails the run). Needed from
   the owner: the provider and account (the owner's choice and cost, typically
   cents a month for under 1 GB), a bucket named e.g. `eje-backups`, and an
   **application key restricted to that bucket** (no delete permission if the
   provider offers it). Then, on the VPS: `apt install rclone`;
   `sudo -u eje rclone config` (the operator types the key; it stays in the
   `eje` user's rclone config, never in `/etc/eje/eje.env`);
   `EJE_BACKUP_OFFSITE_RCLONE=<remote>:eje-backups` in `/etc/eje/eje.env`; run
   `npm run backup` once and confirm `copy … ok` and `check … ok`; then a
   restore test from the bucket copy as above.

## Recovering when the VPS is gone

Needs: the escrowed key (above), an off-server backup copy, and a new Ubuntu
24.04 server.

1. **New server:** install PostgreSQL 16 (client tools must match the dump —
   the manifest says `pg_dump 16`), Node.js 22, create the `eje` user, the
   database user and an empty database `eje_production`
   (`docs/vps-deployment.md`).
2. **Copy the newest verified backup** from the off-server place to
   `/var/backups/eje/` on the new server (scp from this computer, or
   `rclone copy` from the bucket). Check it against its manifest first
   (`Get-FileHash` here, or `npm run backup:verify` there).
3. **Put the key in place:** `EJE_BACKUP_KEY=<escrowed key>` in
   `/etc/eje/eje.env` (mode 600), then `npm run backup:key-check <backup>` —
   must say MATCH.
4. **Restore-test first:** `npm run backup:restore-test <backup>` — it restores
   into a scratch database and reports the counts; nothing is overwritten.
5. **Restore for real** (`docs/vps-backups.md` §6): decrypt into a 0700 working
   directory, `pg_restore` into `eje_production`, unpack the documents into
   `/var/lib/eje/storage`, `npm run documents:reconcile`.
6. **Deploy the application** at the version the manifest names (`appCommit`)
   with `deploy/release/stage-release.ps1` against the new host
   (`-Target`, `-ExpectHost`), point DNS (Cloudflare) at the new address, and
   check `/api/health`, a signed job card and the Timesheets list.
7. **Re-establish** the nightly backup and restore-test timers, the firewall
   (`deploy/firewall/ufw-apply.sh`) and the off-server copy.

## Turning the interim copy off

`Unregister-ScheduledTask -TaskName 'EJE off-server backup pull'` removes the
daily pull; the copies in `C:\Users\jcmos\EJE-offsite-backups` are ciphertext
and can be deleted by hand.
