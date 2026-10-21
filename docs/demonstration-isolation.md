# Keeping demonstration data away from EJE's real records

The October mandate, Workstream A: *"Design and implement a supported way to
keep demonstration testing isolated from genuine production data. Prefer a
separate demonstration database and explicit environment configuration over
relying only on labels."*

This is that design, what is implemented, and what still has to happen on the
VPS. **The demonstration user switcher stays**, as instructed; what changes is
that it can no longer exist on a deployment holding real customers.

---

## 1. The problem, stated precisely

`eje.syncza.co.za` is a **production build** (`NODE_ENV=production`, started by
systemd, served by `next start`) whose database is **called `eje_production`**
and whose contents are **entirely demonstration data**. Every guard in this
repository therefore had to answer *"is this production?"* from circumstantial
evidence, and every answer was wrong in one direction or the other:

| What was asked | What it answered on the demonstration site | Consequence |
|---|---|---|
| `NODE_ENV === 'production'` | yes | the switcher vanished from the one deployment whose purpose is trying accounts out |
| the database NAME | production | `npm run db:seed` refuses it; `db:seed:demo` exists only to work around that |
| `EJE_DEMO_SWITCHER` names its own database | yes | a *feature flag* standing in for a statement about the deployment |

And the preflight **failed the deployment it was written for**: an armed
switcher was an unconditional `FAIL`. A check that has to be overridden to
deploy is not a check.

## 2. What is implemented

### 2.1 The deployment declares itself

One line in `/etc/eje/eje.env`:

```
EJE_DEPLOYMENT=production        # or: demonstration
```

`src/ops/deployment-mode.ts`. Anything else — absent, misspelt, `prod`, `true`
— reads as **undeclared**, which keeps every pre-existing guard in force. A
typo must not become a declaration in either direction.

### 2.2 What the declaration enforces

| Rule | Where | Kind |
|---|---|---|
| A `production` deployment can **never** arm the demonstration switcher, whatever else its environment says — including a development build on the production machine | `isDemoSwitcherEnabled` | **runtime refusal** |
| `npm run db:seed:demo` refuses a `production` deployment, **with no override** — not even the named-database door that exists for the staging site | `resolveDemoSeedTarget` | **refusal** |
| A `demonstration` deployment pointed at a database whose name says production → preflight `FAIL` | `deploymentMismatch` | preflight |
| A `production` deployment pointed at a database whose name says demo/dev/test/staging → preflight `FAIL` | `deploymentMismatch` | preflight |
| An armed switcher on a `demonstration` deployment → preflight `ok`, with the sentence *"must not be carried to a deployment holding real customers"* | `checkDemoSwitcher` | preflight |
| An armed switcher on an **undeclared** deployment → still `FAIL`, as before | `checkDemoSwitcher` | preflight |

The mismatch check uses its **own** list of demonstration-sounding names rather
than the connection guard's `DEVELOPMENT_NAMES`, and the direction is the
reason: `DEVELOPMENT_NAMES` is an allow-list, so adding a word to it would make
`assertDevelopmentDatabase` more permissive. The mismatch list is only ever
used to refuse, so a broader list there is strictly stricter.

### 2.3 What was already there and still carries the weight

A declaration is a line in a file, and files get copied. It is the **third**
line of defence:

1. **Separate credentials.** A development machine does not hold the live
   database's password. This is deployment configuration and no code can
   enforce it.
2. **The published-password check.** The switcher performs a real server-side
   sign-in and verifies the password published in `docs/development-seed.md`
   against the stored Argon2id hash. A database holding real people offers it
   five addresses that do not exist — so it **fails closed on the only thing an
   attacker cannot change from outside**. This is the protection; the rest is
   configuration.
3. **The declaration**, above.

Nothing here lets the switcher reach a different database or a different
environment: it signs into *this* deployment's database, as an ordinary
session, and every authorisation rule then applies unchanged. There is one
kind of session in this application.

## 3. What must happen on the VPS, and has not

**None of this is deployed.** The live service runs `4dede18`.

1. **Add `EJE_DEPLOYMENT=demonstration` to the current site's environment
   file.** It is a demonstration deployment today, and saying so makes its
   preflight pass honestly instead of being waved through.
2. **Create a separate `eje_demo` database before any real customer exists.**
   The current database is *named* `eje_production` and *contains* fixtures.
   Order of work:
   - `createdb eje_demo` and migrate it;
   - `EJE_PRODUCTION_DEMO_SEED=eje_demo npm run db:seed:demo`;
   - point the demonstration deployment's `DATABASE_URL` at `eje_demo` and set
     `EJE_DEPLOYMENT=demonstration`;
   - leave `eje_production` for real records, with
     `EJE_DEPLOYMENT=production` and **no** `EJE_DEMO_SWITCHER` line.
3. **Do not delete the existing demonstration users, customers or jobs.** The
   owner has not authorised that. Moving them to `eje_demo` is a copy, not a
   deletion, and `eje_production`'s fixtures should be removed only on
   instruction.

Until step 2 is done, the demonstration data and the database named
`eje_production` are the same thing, and **a label is the only thing between
them** — which is exactly what the mandate says not to rely on. The
repository-side work is complete; the VPS-side work needs somebody with root.

## 4. Can a demonstration user reach a genuine customer record?

With the separation above: **there is no genuine customer record in the
database the switcher can sign into**, which is the only answer that does not
depend on a permission check being right.

Without it — today, on one shared database — the answer is that a demonstration
user is an ordinary user with an ordinary role, and every read is authorised
the same way. That is tested (`read-authorization.test.ts`,
`technician-visibility.test.ts`, `role-enforcement.test.ts`, and the API tests
that assert a technician's *response* carries no customer documents at all
rather than a screen hiding them). It is a sound answer and it is not the same
as separation, which is why step 2 exists.

## 5. Provenance, and what it is not

Every document-bearing record says where it came from: `genuine`, `simulated`,
or — since migration 0018 — **`unknown`**, for rows written before the column
existed whose origin was never recorded. See `docs/demonstration-data.md`.

**A label is not isolation.** It answers "is this record real?" on a screen, in
a PDF and in `npm run documents:reconcile`. It does not stop a fixture being
written into the live register, and nothing in this document asks it to.
