# Setting up the EJE development database on the VPS

A runbook for creating the persistent PostgreSQL **development** database. Every
command is meant to be read before it is run, and run by a person on the VPS.

**Nothing in this repository knows anything about that machine.** There is no
hostname, no key and no deployment tooling here, and none should be added — the
connection string belongs in a git-ignored `.env.local` on the development PC
and nowhere else.

> Replace every `<…>` yourself. Do not paste a real password into a document, a
> commit message or a chat window.

---

## Where each piece actually runs

This is the part that is easiest to get wrong, so it comes first.

| | Runs on | |
|---|---|---|
| The Next.js application | **your Windows PC**, via `npm run dev` | not on the VPS |
| PostgreSQL | **the VPS** | reached over an SSH tunnel |
| `EJE_STORAGE_DIR` | **your Windows PC** | a local folder — see below |

Only the *database* is remote. `npm run dev` writes attachment bytes to a
directory on the machine it is running on, so for development that is a Windows
path such as `C:\eje-dev-storage`, **not** a path on the VPS. A VPS storage
directory matters only when the application itself is deployed there.

---

## 1. Is PostgreSQL already installed?

```bash
psql --version || echo "psql not installed"
systemctl is-active postgresql 2>/dev/null || echo "service not running"
sudo -u postgres psql -c "select version();" 2>/dev/null
```

**Nothing is known about this machine until these are run.** If PostgreSQL is
already there, note the major version — the application is proven against **16**
and uses nothing requiring more than **13**. If it is not installed, stop and
decide deliberately; installing it is a change to the machine, not a step in a
database setup.

Check what is already using it before assuming a free hand:

```bash
sudo -u postgres psql -c "\l"      # existing databases
sudo -u postgres psql -c "\du"     # existing roles
```

If a database or role here already looks like EJE's, **stop and report it**
rather than reusing it. A production database must never be the development one.

---

## 2. Create the role and the database

```bash
sudo -u postgres psql
```

```sql
-- A dedicated login role. NOT a superuser, and it may not create databases
-- or other roles: the application needs none of that.
create role eje_dev with login password '<a-long-random-password>'
  nosuperuser nocreatedb nocreaterole noinherit;

-- Owned by that role, so it can create its own schema and the two extensions
-- the first migration needs. `citext` and `pgcrypto` are trusted extensions in
-- PostgreSQL 13 and later, so a database owner may create them without being
-- a superuser.
create database eje_dev with owner eje_dev encoding 'UTF8';

-- Nobody else on this server gets in by default.
revoke connect on database eje_dev from public;
```

Then, connected to the new database:

```sql
\c eje_dev
revoke all on schema public from public;
grant all on schema public to eje_dev;
```

**The name matters.** `eje_dev` is not decoration: the application refuses a
database whose name does not say it is development (see
[`database.md`](./database.md)). Production must be given a clearly different
name — `eje_production` or similar — and its own role and password.

---

## 3. Reach it without opening a port

**Preferred: an SSH tunnel.** PostgreSQL keeps listening only on localhost, no
firewall rule is added, and nothing is exposed to the internet.

Confirm it is not already listening publicly:

```bash
sudo -u postgres psql -c "show listen_addresses;"   # want: localhost
sudo ss -lntp | grep 5432                            # want: 127.0.0.1:5432 only
```

Then, **from the Windows PC**, in a terminal you leave open while developing:

```
ssh -N -L 5432:localhost:5432 <user>@<vps-host>
```

and in `.env.local` on the PC:

```
DATABASE_URL=postgres://eje_dev:<password>@localhost:5432/eje_dev
```

The tunnel makes the database look local, which is also why the connection
guard is satisfied by it.

<details>
<summary>If a tunnel genuinely will not do</summary>

Exposing 5432 is a larger decision and should be taken deliberately. At minimum
it needs `listen_addresses`, a `pg_hba.conf` entry scoped to **one** source
address with `scram-sha-256`, TLS, and a firewall rule — and it puts a database
port on the public internet for the sake of a convenience an `ssh -L` already
provides. Ask before doing it.

</details>

---

## 4. Build the schema and seed it

From the development PC, with the tunnel open and `.env.local` in place:

```
npm run db:migrate     # applies all seven migrations
npm run db:seed        # fictional development data; never deletes anything
```

Then check it:

```
npm run dev
```

The sidebar badge should **not** say the data resets — that sentence appears
only on the in-memory demonstration. Sign in with an account `db:seed` printed.

To re-baseline later:

```
EJE_RESET_CONFIRM=eje_dev npm run db:reset
```

---

## 5. Storage on the development PC

```
EJE_STORAGE_DIR=C:\eje-dev-storage
```

Create the folder, and keep it **outside the repository**. It must never be the
same directory production uses — see [`integrations.md`](./integrations.md).

---

## 6. Backups, if this is to be relied on

A development database that holds weeks of work deserves a dump. On the VPS:

```bash
sudo -u postgres pg_dump -Fc eje_dev > /var/backups/eje_dev-$(date +%F).dump
```

Put it on a schedule if the answer to "could we lose this?" is no.

---

## 7. Verify before calling it done

| Check | Command | Want |
|---|---|---|
| Role is not a superuser | `sudo -u postgres psql -c "\du eje_dev"` | no `Superuser` attribute |
| Not listening publicly | `sudo ss -lntp \| grep 5432` | `127.0.0.1` only |
| Schema is built | `psql "$DATABASE_URL" -c "select count(*) from pg_tables where schemaname='public'"` | 49 |
| Migrations recorded | `psql "$DATABASE_URL" -c "select count(*) from drizzle.__drizzle_migrations"` | 7 |
| Application selects PostgreSQL | sign in, then `GET /api/auth/me` | `"backend":"postgres"` |
| It really persists | create a job, stop `npm run dev` entirely, start it again, look for the job | still there |

---

## What production gets instead

A **different** database name, a **different** role, a **different** password
and a **different** storage directory — none of them ever present on a
development machine. Production runs with `NODE_ENV=production`, which is what
makes the development-database guard stand aside for it.

`npm run db:reset` and `npm run db:seed` are refused against production and
always must be.
