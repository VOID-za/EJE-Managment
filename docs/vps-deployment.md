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

### Migration is not seeding, and production has neither seed nor reset

`npm run db:seed` writes fictional customers, fictional jobs and accounts whose
password is printed in this repository's documentation. `npm run db:reset`
empties a database first. **Neither runs here and neither can be made to:**

| | against `eje_production` | under `NODE_ENV=production` |
|---|---|---|
| `db:migrate` | needs `EJE_PRODUCTION_MIGRATION=eje_production` | required |
| `db:seed` | refused, no override | refused, no override |
| `db:reset` | refused, no override | refused, no override |

Those refusals are `src/db/seed/guards.ts` and are asserted in
`src/db/deployment.test.ts`. Nothing in a deployment, a restart or a reboot
calls either command.

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

### Backups before anything risky

```bash
sudo -u postgres pg_dump -Fc eje_production > /var/backups/eje-$(date +%F-%H%M).dump
```

---

## What is NOT in this phase

TLS ciphers, CSP, rate limiting beyond what is already in the application,
passkeys, container isolation, a separate PostgreSQL network — the security
phase comes after this one. What is here is the baseline it needs: secrets
outside git, a database on loopback, a Node port on loopback, a non-privileged
service account, a real build, client IPs that are facts rather than claims,
and production separated from development by a check that cannot be satisfied
by accident.
