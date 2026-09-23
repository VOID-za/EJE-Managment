# Development seed

`npm run db:seed` fills a **development** PostgreSQL database with a complete,
fictional EJE dataset, so the application can be signed into and reviewed end to
end — real login, real roles, real jobs at every stage of the workflow.

Everything it writes is invented. Every customer name carries `(DEMO)`, every
email address is on a `.local` domain that cannot receive mail, and the account
passwords are printed below.

---

## Running it

```
# once, against an empty development database
npm run db:migrate

# then, as often as you like
npm run db:seed
```

`DATABASE_URL` must point at your development database. Copy `.env.example` to
`.env.local` and set it there, or pass it on the command line.

| Flag | What it does |
|---|---|
| *(none)* | Creates whatever is missing. Records it has already written are left exactly as they are. |
| `--reset-passwords` | Re-asserts the documented password on the demonstration accounts. For when somebody has changed one and locked themselves out. |

**Running it twice does not duplicate anything.** Every seeded record's id is
derived from a name (`customer:acme`, `job:EJE-2015`) rather than generated, so
the second run recognises the first run's work and reports it as already
present.

---

## Sign-in accounts

**DEVELOPMENT ONLY. Never create these on a production deployment.**

| Email | Role | Password |
|---|---|---|
| `master@eje-demo.local` | Master | `EjeDemo#2026` |
| `coordinator@eje-demo.local` | Coordinator | `EjeDemo#2026` |
| `technician1@eje-demo.local` | Technician (Mike) | `EjeDemo#2026` |
| `technician2@eje-demo.local` | Technician (David) | `EjeDemo#2026` |
| `technician3@eje-demo.local` | Technician (Peter) | `EjeDemo#2026` |

They sign in through the real login screen, against a real Argon2id hash written
by the seed with the production hasher (`src/server/auth/hashing.ts`). **There is
no demonstration authentication path and no role picker** — the role comes back
from the server with the session, exactly as it will for EJE's own accounts.

Override the password with `EJE_DEMO_PASSWORD` before seeding if you want a
different one.

---

## Switching between them — **DEMO ONLY · Switch user**

Typing an email address and a password every time you change role is the wrong
instrument for something you do forty times an hour, so a development build
carries a **DEMO ONLY · Switch user** control: on the sign-in screen, and in the
top bar once you are signed in. Open it, click a name, and you are that person.

It is not a role picker. Clicking a name performs the **real** sign-in on the
server: the account is looked up, the published development password is verified
against its stored Argon2id hash, the session you were holding is revoked, and
an ordinary session cookie is issued. There is only one kind of session in this
application, so every permission, every visibility rule and every refusal
behaves exactly as it does when you log in by hand.

**Three things keep it out of the live deployment, and all three must hold:**

1. The deployment must not be a production build — **or** must have named its
   own database in `EJE_DEMO_SWITCHER`. `npm run dev` satisfies the first;
   nothing else does, because `next build` and `next start` set
   `NODE_ENV=production`. Where neither holds, the endpoint answers **404** —
   not "refused", because there it does not exist.
2. The address must be one of the five accounts above. The list is read from the
   seed, not restated.
3. The account's password must be the published development one. An account
   with a real password cannot be switched into, so even a misconfigured
   deployment holding real people would hand it nothing.

**(3) is the one that actually protects EJE's live system**, and it is worth
being plain about why. (1) and (2) are configuration, and configuration can be
copied to the wrong machine. (3) cannot: a live database's accounts belong to
real people whose passwords are not in this repository, so a switcher turned on
there by mistake would find five addresses that do not exist and, if they
somehow did, hashes that do not match.

### On the test deployment

`eje.syncza.co.za` is a real server running a production build, so `NODE_ENV`
is `production` there and always will be — that is what makes Next serve a
production build at all. Condition (1) is therefore satisfied the other way,
by naming the database:

```
EJE_DEMO_SWITCHER=eje_production
```

in `/etc/eje/eje.env`, then `sudo systemctl restart eje`. It must EQUAL the
database in `DATABASE_URL`; a `true` does nothing, and the same line copied to a
machine serving a differently-named database is simply wrong, which is exactly
when being wrong is useful. `GET /api/health` reports `"demoSwitcher": true`, so
whether a deployment has it on is one request away rather than a file on a
server. **Never add that line to the live EJE deployment.**

### On an unseeded database

The control still appears and the list still shows five names, deliberately: a
control that hides itself gives you no way to tell a missing feature from an
unseeded database. Clicking a name you have not seeded says so, and tells you to
run the seed.

The ordinary login form is untouched and still works — including refusing a
wrong password.

---

## What it will not do

The seed writes fictional customers, fictional jobs and accounts whose password
is published in this file. None of that belongs anywhere near production, so:

| Situation | What happens |
|---|---|
| `NODE_ENV=production` | **Refuses. No override exists.** |
| A database or host named `prod`, `production` or `live` | **Refuses. No override exists.** |
| A remote host that is neither local nor named as development | Refuses, unless `EJE_SEED_ALLOW=i-understand` — it will not guess |
| No `DATABASE_URL` | Refuses and says so |
| A database with no EJE schema | Refuses and tells you to run `npm run db:migrate` |

The second row used to take `EJE_SEED_ALLOW=i-understand`, for a developer
whose own copy happened to carry the word. It no longer does. EJE has a real
`eje_production` on a real server now, and one remembered incantation would
write the accounts below into it. A test deployment that genuinely needs this
data has its own command — see below — and a development copy that carries a
production word should simply be renamed.

**Nothing in `src/db/seed` drops, truncates or deletes.** There is no such
statement in the directory. The worst a misdirected run can do is ADD
demonstration records — which is what the checks above are for.

It also never touches a record it did not create: a rate you changed on screen,
a job you worked through the application, a customer you added yourself all
survive a re-run untouched.

---

## What it writes

| | |
|---|---|
| **People** | 5 — one Master, one Coordinator, three Technicians |
| **Customers** | 5 fictional industrial customers, all suffixed `(DEMO)` |
| **Sites** | 9 — head offices, factories, production plants and workshops |
| **Contacts** | 9, including one deliberately incomplete (no email, no position) so the screens can be tested against a real register's untidiness |
| **Machines** | 11 across Mazak, Haas, Okuma, Fanuc, Siemens and Okamoto, numbered `STM1`–`STM4`, `CNC01`, `CNC02`, `LATHE01`, `PRESS01`. One is awaiting a Master's confirmation |
| **Checklist templates** | 2 — installation and service, each with measurement questions and a range |
| **Jobs** | 24, `EJE-2001` to `EJE-2024` |
| **Library** | 7 documents — five current, one pending approval, one archived revision |
| **Availability** | 5 — appointment, annual, sick, training and personal leave, one overlapping a scheduled job |
| **Chat** | 3 conversations (Master↔Technician, Coordinator↔Technician, Master↔Coordinator), one linked to a job, with unread messages in two of them |
| **Notifications** | 10, read and unread, across assignment, transfer, refusal, approval and chat |
| **Rates** | Current settings, deliberately **higher** than the snapshot frozen on every closed job |

### The jobs, and what each one is for

| Job | Type | State | Why it is there |
|---|---|---|---|
| EJE-2001 | Breakdown | Open, unassigned | The pool. No order number — the customer phoned it in |
| EJE-2002 | Installation | Open, unassigned | Order number present |
| EJE-2003 | Service | Open, unassigned | Scheduled, order number present |
| EJE-2004 | Test & Repair | Open, unassigned | No order number |
| EJE-2005 | Parts | Open, unassigned | Order number present |
| EJE-2006 | Breakdown | Assigned, not yet accepted | Mike's dashboard shows it waiting for him |
| EJE-2007 | Installation | In progress | Checklist **started and unfinished** — the gate |
| EJE-2008 | Service | In progress | Single-day schedule; checklist not yet started |
| EJE-2009 | Test & Repair | Awaiting spares | On back order |
| EJE-2010 | Breakdown | In progress | Two technicians, call-out fee applied |
| EJE-2011 | Service | Awaiting spares | |
| EJE-2012 | Service | In progress | **Multi-day**, anchored to a Monday for the month view |
| EJE-2013 | Installation | Completion | Checklist **completed** |
| EJE-2014 | Service | Customer signature | Checklist completed, waiting on the customer |
| EJE-2015 | Breakdown | Closed | Signed, priced from a frozen snapshot, final document issued |
| EJE-2016 | Service | Closed | Signed, with a completed checklist |
| EJE-2017 | Installation | Closed | Older history, for the machine record |
| EJE-2018 | Breakdown | Customer signature | **Refusal outstanding** — the office has to deal with it |
| EJE-2019 | Breakdown | Closed | **Refused, corrected, re-signed.** The refusal stays on the record |
| EJE-2020 | Parts | Closed | **Customer collection**: priced, collector signed |
| EJE-2021 | Parts | Closed | **Courier collection**: waybill, collector signed |
| EJE-2022 | Test & Repair | In progress | **Courier collection** with a waybill |
| EJE-2023 | Breakdown | In progress | **Transferred.** Mike captured two hours, David holds it now |
| EJE-2024 | Service | In progress | Peter's job, and nobody else's — the negative visibility case |

### What EJE-2023 and EJE-2024 prove

Together they demonstrate the historical visibility rule:

- **Mike** captured work on EJE-2023 before it was handed over. He keeps access
  to it, because it is his own work.
- **David** holds it now, so he has current access.
- **Peter** was never on it and cannot open it — and neither Mike nor David can
  open EJE-2024, which is Peter's.

The seed writes the closed participation row a live hand-over would have opened,
because the job arrives already transferred and that row is what the rule is
read from.

---

## Job numbering

The seed uses `EJE-2001`–`EJE-2024`, clear of the browser demonstration's own
range (`EJE-1039`–`EJE-1067`), and then calls `advance_job_number_sequence(2025)`
— the function the migration provides, which only ever moves the sequence
**forward**. A job raised in the application after seeding gets `EJE-2025`, and a
database that already holds higher numbers is left alone.

---

## A test deployment — `npm run db:seed:demo`

EJE's staging site (`eje.syncza.co.za`) runs against a database called
`eje_production`, so `npm run db:seed` refuses it and will go on refusing it.
`npm run db:seed:demo` writes **exactly this dataset** — the same
`src/db/seed/apply.ts`, the same records, the same accounts — to a database
somebody has named out loud:

```
EJE_PRODUCTION_DEMO_SEED=eje_production npm run db:seed:demo
```

Everywhere that is not production it behaves identically to `npm run db:seed`,
because it delegates to the same guard. The only thing it adds is a way to say
yes to ONE database, and the acknowledgement has to be that database's own
name — not a flag, not a word meaning yes. `docs/database.md` has the full
runbook and the reasoning.

**Never run it against the live EJE deployment.**

---

## Production

A live deployment is never seeded — not by `db:seed`, not by `db:seed:demo`. It
starts empty and EJE's own data is captured through the application, or
imported deliberately. The accounts above are never created there and that
password is never reused. The one thing a live database does need before a job
can be raised is a settings row — rates, VAT and the company details — which is
business data, so nothing invents it: the settings repository says plainly that
it is missing rather than fabricating one.
