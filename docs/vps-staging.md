# Standing up a STAGING deployment beside the live one

This is the procedure for putting a second EJE service on the same VPS — its own
user, directory, port, database and document storage — without touching the live
one. It assumes `docs/vps-deployment.md` has already been followed once for the
live service, and it repeats none of the reasoning in that document.

**Nothing in here has been run.** The session that wrote it has no SSH access to
the VPS: no `ssh` client, no key, no agent, no host. See *What is still needed*
at the end — that is the list, and it is short.

---

## Why a second service rather than a branch deployment

The live service is the one EJE depend on. A staging deployment exists to answer
"does this build work on the real stack" — real PostgreSQL, real Caddy, real
disk — and it answers nothing if a mistake in it can reach production data. So
every resource is separate, and each separation closes one specific way the two
could collide:

| | live | staging | what the separation prevents |
|---|---|---|---|
| systemd unit | `eje.service` | `eje-staging.service` | a restart of one stopping the other |
| service user | `eje` | `eje-staging` | staging writing live files |
| application | `/srv/eje/app` | `/srv/eje-staging/app` | a deployment overwriting the wrong tree |
| port (loopback) | 3000 | 3001 | one binding the other's port and failing to start |
| environment file | `/etc/eje/eje.env` | `/etc/eje-staging/eje.env` | staging inheriting live credentials |
| database | `eje_production` | `eje_staging` | **staging writing to live records** |
| documents | `/var/lib/eje/storage` | `/var/lib/eje-staging/storage` | staging serving or deleting live job cards |
| hostname | `eje.syncza.co.za` | *(to be decided — see below)* | the public site answering from staging |

The two deliberately DO share the PostgreSQL server, because running a second
instance on one small VPS costs more than it protects — the protection is the
database name, and `npm run preflight -- --expect-db eje_staging` refuses to
start a service whose environment points anywhere else.

---

## Before anything is installed

1. **Confirm what is actually running now.** The live service is identified, not
   assumed:

   ```bash
   systemctl is-active eje; systemctl is-enabled eje
   systemctl show -p MainPID,ExecStart,EnvironmentFiles eje
   curl -s https://eje.syncza.co.za/api/health     # commit, backend, email transport
   sudo -u postgres psql -At -c "select datname from pg_database order by 1"
   ls -ld /srv/eje/app /var/lib/eje/storage
   ```

   Record the commit `/api/health` reports. That is the rollback target, and a
   deployment without one is not a deployment.

2. **Prove a backup can be restored before changing anything.** Not "a backup
   exists" — restored:

   ```bash
   sudo -u eje EJE_BACKUP_KEY=… EJE_BACKUP_DIR=/var/backups/eje npm run backup
   sudo -u eje npm run backup:verify       /var/backups/eje/<dir>
   sudo -u eje npm run backup:restore-test /var/backups/eje/<dir>
   ```

   The restore test builds its own scratch database and drops it again; it never
   writes to the database being backed up. If it does not pass, stop here —
   nothing else in this document is safe to do.

3. **Decide the hostname.** Either a DNS record for a staging name, or no public
   name at all and reach it over an SSH tunnel (`ssh -L 3001:127.0.0.1:3001`),
   which is the safer answer while there is nothing to show anybody.

---

## Standing it up

```bash
# 1. The user, the directories, and nothing shared with the live service.
sudo useradd --system --home /srv/eje-staging --shell /usr/sbin/nologin eje-staging
sudo install -d -m 0755 -o eje-staging -g eje-staging /srv/eje-staging
sudo install -d -m 0700 -o eje-staging -g eje-staging /var/lib/eje-staging/storage
sudo install -d -m 0750 -o root -g eje-staging /etc/eje-staging

# 2. The code, at the exact commit under test. A clone, not a copy of /srv/eje.
sudo -u eje-staging git clone https://github.com/VOID-za/EJE-Managment /srv/eje-staging/app
cd /srv/eje-staging/app
sudo -u eje-staging git checkout <commit>

# 3. Its own database, owned by its own role. CREATE only — nothing here
#    touches eje_production.
sudo -u postgres createuser eje_staging_app --pwprompt
sudo -u postgres createdb  eje_staging --owner eje_staging_app

# 4. Its own environment file. Copy deploy/eje.env.example, then set:
#      DATABASE_URL=postgresql://eje_staging_app:…@localhost:5432/eje_staging
#      EJE_PERSISTENCE=postgres
#      EJE_STORAGE_DIR=/var/lib/eje-staging/storage
#      EJE_BACKUP_KEY=…            (a DIFFERENT key from the live one)
#    and leave EJE_DEMO_SWITCHER unset unless this is a demonstration.
sudo install -m 0640 -o root -g eje-staging /dev/null /etc/eje-staging/eje.env
sudo nano /etc/eje-staging/eje.env

# 5. Build the exact commit, with the stamp /api/health will report.
sudo -u eje-staging npm ci
sudo -u eje-staging env EJE_BUILD_COMMIT=$(git rev-parse --short HEAD) \
  EJE_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ) npm run build

# 6. Migrate ITS database, naming it out loud — the only way past the guard.
sudo -u eje-staging env $(sudo cat /etc/eje-staging/eje.env | xargs) \
  EJE_PRODUCTION_MIGRATION=eje_staging npm run db:migrate

# 7. PREFLIGHT. Before the service is ever started.
sudo -u eje-staging env $(sudo cat /etc/eje-staging/eje.env | xargs) \
  NODE_ENV=production npm run preflight -- --expect-db eje_staging

# 8. The unit, and only then the start.
sudo cp deploy/eje-staging.service /etc/systemd/system/eje-staging.service
sudo systemctl daemon-reload
sudo systemctl enable --now eje-staging
curl -s 127.0.0.1:3001/api/health
```

`npm run preflight` is step 7 for a reason: it reads this machine's own
configuration and refuses a deployment that would serve the demonstration store,
write to the wrong database, lose its documents, or fail to send a customer
anything. It prints a verdict per check and **no configured values** — see
`src/ops/preflight-rules.ts`.

### The first accounts

A new `eje_staging` database has no users, which the preflight reports as a
warning: nobody can sign in. Create the office account the way production did
(`docs/vps-deployment.md`), and **do not seed the demonstration data on a
staging deployment that anybody outside EJE can reach** — those accounts'
password is published in `docs/development-seed.md`.

### Proving it

```bash
EJE_SMOKE_BASE_URL=http://127.0.0.1:3001  npm run smoke          # browser workflow
EJE_CHECK_URL=http://127.0.0.1:3001       npm run check-routes    # every route and refusal
EJE_E2E_URL=http://127.0.0.1:3001         npm run e2e             # the full job journey
```

The smoke suite signs in as seeded accounts, so it belongs on a staging database
that has been seeded deliberately — not on one holding real records. Against a
staging database with real-looking data, run `check-routes` only.

### Rollback

```bash
cd /srv/eje-staging/app
sudo -u eje-staging git checkout <previous commit>
sudo -u eje-staging env EJE_BUILD_COMMIT=$(git rev-parse --short HEAD) npm run build
sudo systemctl restart eje-staging
```

A migration is not rolled back by checking out older code. The schema is
additive, so old code runs against the newer schema — that is the safe
direction, and it is the reason there are no destructive migrations.

---

## What is still needed from EJE

The procedure above is complete and has **not been executed**. Nothing in this
repository can reach the VPS: the session has no `ssh` client, no key, no agent
and no host, and its outbound network is an HTTPS proxy. To get a staging
deployment actually running, one of these is required:

1. **A deployment path for this session** — SSH access (host, user, key) made
   available to the environment running these sessions, with a confirmation that
   the live service and `eje_production` are out of scope; or
2. **Somebody with VPS access running the steps above** and pasting back the
   output of step 7 (the preflight) and `curl /api/health`; or
3. **A deploy mechanism we add to the repository** — a GitHub Actions workflow
   with a deploy key held as a repository secret, which puts the credential in
   GitHub rather than in a session, and which EJE can revoke.

And three decisions that are EJE's rather than ours:

- **The staging hostname**, or a decision to reach it only through an SSH tunnel.
- **Whether a staging database may be created** on the same PostgreSQL server
  (it is one `createdb`, and it is still a change to the live machine).
- **Whether staging may be seeded with the demonstration data.** It makes the
  smoke suite usable and publishes five accounts whose password is in the
  documentation, so it is a decision about who can reach the hostname.
