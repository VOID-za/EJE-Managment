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

## What it will not do

The seed writes fictional customers, fictional jobs and accounts whose password
is published in this file. None of that belongs anywhere near production, so:

| Situation | What happens |
|---|---|
| `NODE_ENV=production` | **Refuses. No override exists.** |
| A database or host named `prod`, `production` or `live` | Refuses, unless `EJE_SEED_ALLOW=i-understand` |
| A remote host that is neither local nor named as development | Refuses, unless `EJE_SEED_ALLOW=i-understand` — it will not guess |
| No `DATABASE_URL` | Refuses and says so |
| A database with no EJE schema | Refuses and tells you to run `npm run db:migrate` |

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

## Production

A production deployment is never seeded. It starts empty and EJE's own data is
captured through the application, or imported deliberately. The one thing it
does need before a job can be raised is a settings row — rates, VAT and the
company details — which is business data, so nothing invents it: the settings
repository says plainly that it is missing rather than fabricating one.
