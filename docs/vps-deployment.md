# Deploying EJE to the Hostinger VPS

The target, and the reason the SSH database tunnel goes away:

```
Browser ──HTTPS──▶ Cloudflare ──HTTPS──▶ Caddy ──127.0.0.1:3000──▶ EJE ──127.0.0.1:5432──▶ PostgreSQL
                                         │                                                 │
                                         └───────────────── one VPS ────────────────────────┘
```

The application and the database are on the same machine, so a query costs
tenths of a millisecond instead of the ~390 ms an `ssh -L` from Windows costs.
PostgreSQL keeps listening on loopback only and is never published. Port 3000 is
never published either — see step 5, which checks the binding rather than
assuming it.

Host: `eje.syncza.co.za`.

> **Nothing here has been executed.** This session has no access to the VPS.
> Every command below is for you to run and read first. The only placeholder
> left is `REPLACE_ME`, which is a password you generate and paste.

---

## What the repository provides

| File | Goes to | What it is |
|---|---|---|
| `deploy/eje.service` | `/etc/systemd/system/eje.service` | The service, restart policy and reboot recovery |
| `deploy/Caddyfile` | `/etc/caddy/Caddyfile` | HTTPS, certificate, reverse proxy to loopback |
| `deploy/cloudflare-ips.caddy` | `/etc/caddy/cloudflare-ips.caddy` | Which peers may say who the client is. Generated |
| `deploy/eje.env.example` | `/etc/eje/eje.env` (filled in) | The template. **The real file is never committed** |
| `src/app/api/health/route.ts` | — | `GET /api/health` |

---

## 0. Node.js 22 LTS

**Ubuntu 24.04's own `nodejs` package is Node 18 and will not run this
application.** `next@16.3.5` requires Node ≥ 20.9, and Node 20 reached end of
life in April 2026 — so 22 LTS, which is what the repository is developed and
tested on and what `package.json` `engines` requires.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node --version      # want v22.x
which node          # want /usr/bin/node
```

`which node` **must** print `/usr/bin/node`, because that is the absolute path
in `ExecStart`. systemd does not search `PATH`. If it prints something else,
change that one line in `/etc/systemd/system/eje.service` to match.

---

## 1. Accounts, directories, PostgreSQL role

Run as a sudo user on the VPS.

```bash
sudo adduser --system --group --home /srv/eje eje
sudo install -d -o eje -g eje /srv/eje /var/lib/eje/storage
sudo install -d -m 0750 -o root -g eje /etc/eje
```

A dedicated PostgreSQL role that owns the production database and nothing else:

```bash
sudo -u postgres psql
```

```sql
create role eje_app with login nosuperuser nocreatedb nocreaterole noinherit;
\password eje_app
create database eje_production with owner eje_app encoding 'UTF8';
revoke connect on database eje_production from public;
grant connect on database eje_production to eje_app;
\c eje_production
revoke all on schema public from public;
grant all on schema public to eje_app;
```

`eje_dev` is a different database on the same server and nothing here touches
it. Count its tables before and after if you want that in writing:

```bash
sudo -u postgres psql -d eje_dev -c \
  "select count(*) from information_schema.tables where table_schema='public';"
```

Confirm the database is not listening publicly — it should already be loopback-only:

```bash
sudo -u postgres psql -c "show listen_addresses;"
sudo ss -lntp | grep 5432
```

Want `localhost` and `127.0.0.1:5432` only. **Do not open 5432 in the firewall.**

---

## 2. Secrets

```bash
openssl rand -hex 24                # the eje_app password; hex, so URL-safe
sudo install -m 0640 -o root -g eje /dev/null /etc/eje/eje.env
sudo nano /etc/eje/eje.env
```

Paste the contents of `deploy/eje.env.example` and replace `REPLACE_ME` with
that password. Root owns it, the `eje` group reads it, nothing else on the
machine can. Read the bottom of that file: it lists what must **not** go in it.

---

## 3. The application

```bash
sudo -u eje git clone https://github.com/VOID-za/EJE-Managment.git /srv/eje/app
cd /srv/eje/app
sudo -u eje git checkout claude/eje-job-card-demo-k2klb4
sudo -u eje npm ci
sudo -u eje npm run build
```

**`npm ci` — not `npm ci --omit=dev`.** The build and the migration are dev
dependencies: `next` itself is a dependency but the build needs `typescript`,
`tailwindcss` and `@tailwindcss/postcss`, and `db:migrate` needs `tsx` and
`drizzle-kit`. Omitting them produces a machine that cannot build or migrate.

`next build` needs no environment file: it compiles, it does not connect.
`NODE_ENV` is `production` for `next build` by definition, which is what
switches the development user switcher off entirely.

---

## 4. Schema

**Loading the environment file. Not this:**

```bash
env $(sudo cat /etc/eje/eje.env | grep -v '^#' | xargs)     # NO
```

`xargs` word-splits, so a password containing a space, a quote or a `#` is
mangled into two variables or silently truncated, and you find out as an
authentication failure that looks like a wrong password. Use the shell's own
loader:

```bash
set -a
. /etc/eje/eje.env
set +a
```

Then migrate. The live schema needs its name typed out:

```bash
cd /srv/eje/app
sudo -u eje --preserve-env=DATABASE_URL,NODE_ENV,EJE_STORAGE_DIR,EJE_PERSISTENCE \
  EJE_PRODUCTION_MIGRATION=eje_production npm run db:migrate
```

`EJE_PRODUCTION_MIGRATION` must equal the database in `DATABASE_URL` or the
command refuses and prints the exact line to run
(`src/db/connection-guard.ts`). It is deliberately **not** in
`/etc/eje/eje.env`: a value that arrives by sourcing a file is a value nobody
decided, and the whole point is that changing the live schema is a thing
somebody typed.

`db:migrate` says which database it is going to before it goes, asks the server
who it is, and prints the real error if one fails — see `docs/database.md`.
Confirm:

```bash
sudo -u postgres psql -d eje_production -c \
  "select count(*) from information_schema.tables where table_schema='public';"
sudo -u postgres psql -d eje_production -c "select count(*) from drizzle.__drizzle_migrations;"
```

### Migration is not seeding

`npm run db:seed` writes fictional customers, fictional jobs and accounts whose
password is published in this repository. `npm run db:reset` empties a database
first. **Neither runs here and neither can be made to:**

| | against `eje_production` | under `NODE_ENV=production` |
|---|---|---|
| `db:migrate` | needs `EJE_PRODUCTION_MIGRATION=eje_production` | required |
| `db:seed` | refused, no override | refused, no override |
| `db:reset` | refused, no override | refused, no override |
| `db:seed:demo` | needs `EJE_PRODUCTION_DEMO_SEED=eje_production` | the same |

Those refusals are `src/db/seed/guards.ts` and are asserted in
`src/db/deployment.test.ts`. Nothing in a deployment, a restart or a reboot
calls any of them: every one is a command somebody types.

---

## 4a. Demonstration data — TEST DEPLOYMENTS ONLY

**Skip this entirely for the live EJE deployment.** Everything below puts
fictional companies and accounts whose password is in this repository into the
database it is pointed at.

`eje.syncza.co.za` is staging, and a staging site nobody can sign into is
useless. `npm run db:seed:demo` fills it with the same dataset a developer's own
machine runs on — five people, five customers, nine sites, eleven machines,
twenty-four jobs across every job type and status:

```bash
cd /srv/eje/app
set -a
. /etc/eje/eje.env
set +a
sudo -u eje --preserve-env=DATABASE_URL,NODE_ENV,EJE_STORAGE_DIR,EJE_PERSISTENCE \
  EJE_PRODUCTION_DEMO_SEED=eje_production npm run db:seed:demo
```

The acknowledgement must EQUAL the database name, for the same reason
`EJE_PRODUCTION_MIGRATION` must: a word meaning yes survives being pasted into
an environment file and is then permanently on. Do not put
`EJE_PRODUCTION_DEMO_SEED` in `/etc/eje/eje.env`.

It never deletes and it is safe to re-run — a second run writes nothing, and a
password changed on the site stays changed. See `docs/database.md` for the
accounts and the rule that they are never created on a live deployment.

### The one-click user switcher

Demonstration data is only half of a usable test site; the other half is being
able to BE each of those people without a password. Add to `/etc/eje/eje.env`:

```
EJE_DEMO_SWITCHER=eje_production
```

then `sudo systemctl restart eje`. The value must equal the database in
`DATABASE_URL`. A **DEMO ONLY · Switch user** control then appears on the
sign-in screen and in the top bar, offering the five seeded accounts; clicking
one performs the real server-side sign-in — the published password is verified
against the stored Argon2id hash and an ordinary session is issued — so every
permission and visibility rule behaves exactly as it does after a manual login.

Confirm which deployment has it on, from outside, in one request:

```bash
curl -s https://eje.syncza.co.za/api/health
```

Want `"demoSwitcher": true` here and **`false` on the live deployment**.

**When EJE goes live, the live database gets `db:migrate` and nothing else** —
no demo seed, and no `EJE_DEMO_SWITCHER` line. Real accounts are created through
the administration screen by a Master.

---

## 5. Start it

```bash
sudo cp /srv/eje/app/deploy/eje.service /etc/systemd/system/eje.service
sudo systemd-analyze verify /etc/systemd/system/eje.service    # silence is a pass
sudo systemctl daemon-reload
sudo systemctl enable --now eje
sudo systemctl status eje --no-pager
curl -s localhost:3000/api/health
```

Want `{"status":"ok","backend":"postgres","database":"reachable",...}`.

**Then check the binding, every time:**

```bash
sudo ss -lntp | grep 3000
```

Want `127.0.0.1:3000`. `0.0.0.0:3000` means the Node port is on the public
internet with Caddy sitting pointlessly in front of it — stop and fix
`ExecStart` before going further. `next start` takes the hostname as a **flag**
and ignores a `HOSTNAME` environment variable (`-p/--port` is declared with
`.env('PORT')`, `-H/--hostname` is not), which is why the unit passes
`--hostname 127.0.0.1` and why this check exists.

---

## 6. HTTPS

Caddy is **not** in Ubuntu's default repositories in a version this
configuration can rely on. Use Caddy's own:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
caddy version
```

Both files, because `import` in the Caddyfile resolves next to the Caddyfile:

```bash
sudo cp /srv/eje/app/deploy/Caddyfile            /etc/caddy/Caddyfile
sudo cp /srv/eje/app/deploy/cloudflare-ips.caddy /etc/caddy/cloudflare-ips.caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
sudo journalctl -u caddy -n 50 --no-pager
```

The hostname `eje.syncza.co.za` is already in the file. There is nothing to
edit.

Open 80 and 443 only:

```bash
sudo ufw allow 80,443/tcp
sudo ufw status
```

### Cloudflare, in the order that works

1. **A record first, unproxied.** `eje` → `187.77.182.214`, proxy status **DNS
   only** (grey cloud). Caddy answers the ACME HTTP-01 challenge directly and
   obtains a real Let's Encrypt certificate.
2. Confirm direct HTTPS: `curl -s https://eje.syncza.co.za/api/health`.
3. **SSL/TLS mode → Full (strict).** Honest only because step 2 proved the
   origin holds a publicly-trusted certificate. **Never Flexible**: Cloudflare
   would speak plain HTTP to the origin, Caddy would redirect it to HTTPS, and
   the result is a redirect loop over an unencrypted hop.
4. **Switch the A record to Proxied** (orange cloud).
5. Confirm again — the response now carries a `cf-ray` header. A `525` or `526`
   means Cloudflare cannot complete TLS to the origin; go back to step 2.

### Keeping client IPs honest

`/etc/caddy/cloudflare-ips.caddy` is what lets Caddy tell Cloudflare from a
stranger. Without it `X-Forwarded-For` is a header anybody can send, and the
login rate limiter is limiting a string the attacker chose.

It is a **static list, generated from Cloudflare's published ranges on the date
in its first line** — not a live lookup. Cloudflare changes those ranges rarely
and announces them. Caddy can track them at runtime, but only through a
third-party module that needs a custom binary built with `xcaddy`, which is a
build pipeline to avoid running one command occasionally. So:

```bash
npm run cloudflare-ips -- --check     # exits 1 if the committed file has drifted
npm run cloudflare-ips                # rewrite it, then commit and redeploy
```

Run the `--check` when you deploy. If it fails, regenerate, commit, copy the
file to `/etc/caddy/` and `systemctl reload caddy`.

---

## Day to day

```bash
cd /srv/eje/app
sudo -u eje git pull origin claude/eje-job-card-demo-k2klb4
sudo -u eje npm ci
sudo -u eje npm run build

set -a; . /etc/eje/eje.env; set +a
sudo -u eje --preserve-env=DATABASE_URL,NODE_ENV,EJE_STORAGE_DIR,EJE_PERSISTENCE \
  EJE_PRODUCTION_MIGRATION=eje_production npm run db:migrate

sudo systemctl restart eje
curl -s localhost:3000/api/health
sudo ss -lntp | grep 3000
```

| | |
|---|---|
| Logs | `journalctl -u eje -f` |
| Restart | `sudo systemctl restart eje` — graceful, because node is the MainPID |
| After a reboot | nothing — `enable` handles it, and the unit is ordered after PostgreSQL |
| PostgreSQL maintenance | EJE stays up. `Wants=` not `Requires=`, so restarting PostgreSQL does not stop the application; `/api/health` reports `"database":"unreachable"` while it is down |
| Rollback | `git checkout <previous commit>` then rebuild and restart. **A migration is not rolled back by checking out old code** — the schema is additive, so old code runs against the newer schema; that is the safe direction and the reason there are no destructive migrations |

### Before you start the service: `npm run preflight`

```bash
sudo -u eje env $(sudo cat /etc/eje/eje.env | xargs) \
  NODE_ENV=production npm run preflight -- --expect-db eje_production
```

It reads this machine's own configuration, opens the database, writes and
deletes one probe file in the storage directory, and prints a verdict per check.
It exits non-zero if anything failed, so a deployment script stops instead of
starting a server that looks healthy and is quietly wrong. It changes nothing —
one `select 1`, one read of the migration ledger — and is deliberately safe to
run against production, because the moment before a deployment is when somebody
needs to know.

**It prints no values.** Not a password, not a token, not a host, not the length
of a secret: a verdict names the VARIABLE and says what is wrong with it,
because this output ends up pasted into messages.

The six silent failures it exists for, each of which otherwise shows up as
something else entirely:

| What it catches | What would happen without it |
|---|---|
| `DATABASE_URL` missing or misspelt | The in-memory DEMONSTRATION store serves fictional customers and discards every write on restart |
| The wrong database named | A staging service writes to `eje_production`. `--expect-db` is the guard |
| A migration not applied | The server starts and the first request touching the new schema fails |
| `EJE_STORAGE_DIR` unwritable | Every issued job card fails at the moment a customer should have received one |
| That directory INSIDE the application directory | The next deployment deletes every stored job card, and a database backup cannot rebuild one |
| No email configuration | A real-database deployment refuses to send (MANDATE-3), so no customer gets a job card |

It also refuses a deployment where `EJE_DEMO_SWITCHER` is armed for the
configured database, and warns about a `EJE_BACKUP_KEY` that is absent or the
wrong shape.

For a SECOND service beside this one — its own user, port, database and storage
— see `docs/vps-staging.md`.

### Backups

```bash
# Once, on a machine that is NOT this server. Keep it somewhere the server
# cannot reach — a password manager, a sealed envelope, both.
openssl rand -hex 32

# Then, on the server:
EJE_BACKUP_KEY=<that key> EJE_BACKUP_DIR=/var/backups/eje npm run backup
npm run backup:verify       /var/backups/eje/eje-eje_production-<stamp>
npm run backup:restore-test /var/backups/eje/eje-eje_production-<stamp>
```

**The database alone is not a backup of this system.** `job_media` and
`final_documents` hold a `storage_key` and nothing else — the bytes live under
`EJE_STORAGE_DIR`. A `pg_dump` restored on its own gives a database full of rows
pointing at signed job cards that are gone, and a customer-signed job card
cannot be rebuilt from anything (CR-01, IMMUT-6). This is what the line here used
to be, and why it changed.

`npm run backup` writes one timestamped directory holding `database.dump.enc`,
`storage.tar.gz.enc` and a `manifest.json` of sizes, SHA-256 checksums, the key's
fingerprint and the build that produced them. It reads `DATABASE_URL` and
`EJE_STORAGE_DIR` — the same variables the application reads, so it cannot back
up a different directory from the one being written to.

It refuses rather than producing half a backup:

| | |
|---|---|
| `EJE_BACKUP_DIR` unset | refused — name a volume that is **not** the one being backed up |
| `EJE_BACKUP_KEY` unset, or not 64 hex characters | refused. **There is no unencrypted path** — see below |
| The document directory is missing | refused; almost always a misconfigured `EJE_STORAGE_DIR` |
| The document directory is empty | refused, unless `EJE_BACKUP_ALLOW_EMPTY=yes` says the deployment really is new |
| `pg_dump` fails, or `pg_restore` cannot read what it wrote | refused, and the part-written directory is **removed** |
| The archive holds fewer files than the directory does | refused — `tar` exits 0 having skipped a file it could not read |

The directory and all three files are `0700`/`0600`: they are a complete copy of
the database and of every customer's signed job card.

Run it before anything risky, and on a schedule. **Copy it off the machine** —
a backup on the disk it is a backup of is not one.

#### Encryption, verification and the restore test — BACKUP-2

**A backup is always encrypted, and there is no flag to write one in the clear.**
AES-256-GCM, key from `EJE_BACKUP_KEY` and nowhere else — never in a file in the
repository, never in the backup directory, never printed. The permissions above
protect the copy on the machine it was made on and nothing else; a backup exists
in order to be copied off, and every copy leaves those permissions behind.

**Keep the key somewhere the server cannot reach, and keep it when you rotate
it.** A backup whose key is lost cannot be restored — it is not a backup any
more. The manifest records a 16-character fingerprint of the key so that an
operator holding several can tell which one a directory needs; the fingerprint
is a truncated SHA-256 and reveals nothing.

| Command | What it proves |
|---|---|
| `npm run backup:verify <dir>` | The recorded SHA-256 of each artefact still matches **and** each one decrypts and authenticates. The checksum catches damage; the GCM tag catches ALTERATION, which a checksum cannot — whoever edited the file can recompute a checksum, and cannot forge a tag without the key. It decrypts into a temporary directory and removes it, so running the check never leaves a plaintext copy beside the ciphertext |
| `npm run backup:restore-test <dir>` | The dump is actually restored, into a scratch database this command creates and then drops, and never into the one being backed up: the name is generated, checked against a pattern and against the source's name, and a name that already exists is refused rather than replaced. It then unpacks the archive and walks **every `storage_key` in the restored database**, demanding the file — because a restored row pointing at a signed job card that is not there is this system's worst failure, and the only way to find it is to look. Needs `DATABASE_URL` for the server, and writes nothing to the database named in it. The archive is **judged before it is unpacked**: an absolute path, a `..` component, a symlink or hardlink, a device or FIFO, the same document twice, or more members or bytes than the ceilings allow are each refused with nothing extracted — a backup is handled by people who are not EJE by the time anybody restore-tests one, and the GCM tag proves only that the bytes are unaltered, not that the archive was made honestly. Interrupting it (Ctrl-C, SIGTERM) drops the scratch database and removes the decrypted plaintext, which `finally` alone did not do |

Both append a dated record to `manifest.json`, so a backup nobody has checked and
a backup somebody checked last Tuesday can be told apart. Until the restore
record is there, the manifest says in the file itself that nobody has read those
bytes back.

On a **development or staging** database seeded rather than worked in, some
`final_documents` rows name PDFs that were never generated; they were dangling
before `pg_dump` ran. `EJE_RESTORE_ALLOW_ORPHANS=yes` accepts that, and the
unresolved count still goes into the manifest — a restore record that cannot be
told apart from a clean one is worth nothing. **Do not set it on production:**
there, an unresolved key means a document is genuinely missing.

#### The key: keeping it, rotating it, and what is NOT automated

**The key is a prerequisite for restoring, not a precaution.** There is no
recovery path that does not involve it: no escrow, no recovery code, no second
key, and nothing in this repository can read an artefact without
`EJE_BACKUP_KEY`. A lost key turns every backup encrypted with it into noise.

Keep it in **two** places the server cannot reach — EJE's password manager and
one offline copy — and record, beside each copy, the 16-character fingerprint the
manifest shows, so a directory can be matched to a key without trying them.

**Rotating it is an operator procedure, and old backups do not re-encrypt
themselves:**

1. Generate the new key on a machine that is not the server
   (`openssl rand -hex 32`) and store it as above.
2. Set `EJE_BACKUP_KEY` to the new value. Every backup taken from then on
   records the new fingerprint.
3. **Keep the old key** until every backup encrypted with it has been deleted.
   Its fingerprint is in those manifests; a backup whose fingerprint matches no
   key you hold is already unrecoverable, and `backup:verify` says so by name
   rather than reporting damage.
4. Only once no retained directory carries the old fingerprint may the old key
   be destroyed.

**This lifecycle is NOT complete in software, and should not be described as
though it is.** There is no key store, no scheduled rotation, no
re-encryption command and no enforcement that step 3 was honoured: what exists
is encryption that cannot be bypassed, a fingerprint that identifies the key a
directory needs, and refusals that name the wrong key rather than blaming the
bytes. The rest is a procedure a person follows, and a decision about where EJE
keep secrets that has not been made.

**What BACKUP-2 still does not do:** it does not schedule anything and it does
not copy a backup off this machine. Both are deployment, and both are still
yours to arrange.

---

## What is NOT in this phase

TLS ciphers, CSP, rate limiting beyond what is already in the application,
passkeys, container isolation, a separate PostgreSQL network — the security
phase comes after this one. What is here is the baseline it needs: secrets
outside git, a database on loopback, a Node port on loopback, a non-privileged
service account, a real build, client IPs that are facts rather than claims,
and production separated from development by a check that cannot be satisfied
by accident.
