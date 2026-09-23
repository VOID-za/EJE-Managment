# Deploying EJE to the Hostinger VPS

The target, and the reason the SSH database tunnel goes away:

```
Browser  ──HTTPS──▶  Caddy  ──127.0.0.1:3000──▶  EJE (Node)  ──localhost:5432──▶  PostgreSQL
                     │                                                             │
                     └──────────────────── one VPS ─────────────────────────────────┘
```

The application and the database are on the same machine, so a query costs
tenths of a millisecond instead of the ~390 ms an `ssh -L` from Windows costs.
PostgreSQL keeps listening on loopback only and is never published.

> **Nothing here has been executed.** This session has no access to the VPS.
> Every command below is for you to run and read first. Replace every
> `REPLACE_ME` and every `eje.example.com`.

---

## What the repository now provides

| File | Goes to | What it is |
|---|---|---|
| `deploy/eje.service` | `/etc/systemd/system/eje.service` | The service, restart policy and reboot recovery |
| `deploy/Caddyfile` | `/etc/caddy/Caddyfile` | HTTPS, certificate, reverse proxy to loopback |
| `deploy/eje.env.example` | `/etc/eje/eje.env` (filled in) | The template. **The real file is never committed** |
| `src/app/api/health/route.ts` | — | `GET /api/health` |

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
\c eje_production
revoke all on schema public from public;
grant all on schema public to eje_app;
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
sudo install -m 0640 -o root -g eje /dev/null /etc/eje/eje.env
sudo nano /etc/eje/eje.env
```

Paste the contents of `deploy/eje.env.example`, and set the real password.
Root owns it, the `eje` group reads it, nothing else on the machine can.

---

## 3. The application

```bash
sudo -u eje git clone https://github.com/VOID-za/EJE-Managment.git /srv/eje/app
cd /srv/eje/app
sudo -u eje git checkout claude/eje-job-card-demo-k2klb4
sudo -u eje npm ci
sudo -u eje --preserve-env=DATABASE_URL env $(sudo cat /etc/eje/eje.env | grep -v '^#' | xargs) npm run build
```

`npm ci` installs exactly the lockfile. `npm run build` produces the production
bundle; `NODE_ENV` is `production` for `next build`, which is what switches the
development user switcher off entirely.

---

## 4. Schema

```bash
cd /srv/eje/app
sudo -u eje env $(sudo cat /etc/eje/eje.env | grep -v '^#' | xargs) npm run db:migrate
```

`db:migrate` says which database it is going to before it goes, asks the server
who it is, and prints the real error if one fails — see `docs/database.md`.

**Do not run `npm run db:seed` here.** The seed is development fixtures. It
refuses a database whose name does not say development, and `eje_production`
does not.

---

## 5. Start it

```bash
sudo cp /srv/eje/app/deploy/eje.service /etc/systemd/system/eje.service
sudo systemctl daemon-reload
sudo systemctl enable --now eje
sudo systemctl status eje --no-pager
curl -s localhost:3000/api/health
```

Want `{"status":"ok","backend":"postgres","database":"reachable",...}`.

---

## 6. HTTPS

```bash
sudo apt install -y caddy
sudo cp /srv/eje/app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # set the real hostname
sudo systemctl reload caddy
```

Point the DNS A record at the VPS first, or Caddy cannot obtain a certificate.
Open 80 and 443 only:

```bash
sudo ufw allow 80,443/tcp
sudo ufw status
```

---

## Day to day

```bash
cd /srv/eje/app
sudo -u eje git pull origin claude/eje-job-card-demo-k2klb4
sudo -u eje npm ci
sudo -u eje env $(sudo cat /etc/eje/eje.env | grep -v '^#' | xargs) npm run build
sudo -u eje env $(sudo cat /etc/eje/eje.env | grep -v '^#' | xargs) npm run db:migrate
sudo systemctl restart eje
curl -s localhost:3000/api/health
```

| | |
|---|---|
| Logs | `journalctl -u eje -f` |
| Restart | `sudo systemctl restart eje` |
| After a reboot | nothing — `enable` handles it, and the unit waits for PostgreSQL |
| Rollback | `git checkout <previous commit>` then rebuild and restart. **A migration is not rolled back by checking out old code** — the schema is additive, so old code runs against the newer schema; that is the safe direction and the reason there are no destructive migrations |

### Backups before anything risky

```bash
sudo -u postgres pg_dump -Fc eje_production > /var/backups/eje-$(date +%F-%H%M).dump
```

---

## What is NOT in this phase

TLS ciphers, CSP, rate limiting, passkeys, container isolation, a separate
PostgreSQL network — the security phase comes after this one. What is here is
the baseline it needs: secrets outside git, a database on loopback, a
non-privileged service account, a real build, and production separated from
development.
