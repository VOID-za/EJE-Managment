# EJE Job Card Management System — Demonstration

A working demonstration of the job card management system for **EJE Industrial
Electronics**, built to be shown to management for approval.

This is Phase 1. It is a real web application, not a mockup: the workflow, the
business rules and the job costing run exactly as the production system will.
What is deliberately *not* real is listed under [Demonstration mode](#demonstration-mode),
and the application says so on screen.

All data in this demonstration is fictional. No real customer information is used.

---

## Setting up a new machine

You need exactly two things: **Node.js 20.9 or newer** (22 LTS recommended) and
**Git**. Everything else is installed by `npm ci`. There is no database, no
Docker and no service to configure — the demonstration runs entirely in the
browser.

### Windows

Open PowerShell and use the built-in package manager:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Close and reopen PowerShell so the new `PATH` takes effect, then check both:

```powershell
node -v    # v22.x.x  (must be >= v20.9)
git --version
```

**Two things a fresh Windows install will trip on.** Run both once, then reopen
PowerShell:

```powershell
# npm.ps1 is blocked by the default execution policy
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

# git clone can abort with "schannel: server closed abruptly"
git config --global http.version HTTP/1.1
git config --global http.postBuffer 524288000
```

If a clone still aborts, `git config --global http.sslBackend openssl` usually
settles it — that error normally comes from antivirus or a corporate proxy
interfering with the TLS session, not from the repository.

If `winget` is unavailable, download the installers directly:
<https://nodejs.org/en/download> and <https://git-scm.com/download/win>. Accept
the defaults in both.

### macOS

With [Homebrew](https://brew.sh):

```bash
brew install node git
node -v
```

### Linux (Debian / Ubuntu)

The version in the default apt repositories is usually too old, so use NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v
```

## Running it

```bash
git clone https://github.com/VOID-za/EJE-Managment
cd EJE-Managment
git checkout claude/eje-job-card-demo-k2klb4
npm ci
npm run dev
```

Then open <http://localhost:3000>.

`npm ci` installs the exact versions in `package-lock.json` — prefer it to
`npm install` on a fresh machine. It takes about 25 seconds and roughly 700 MB
of disk.

**For the actual management demonstration, use the production build instead.**
It starts in under a second and is noticeably more responsive than the dev
server, which matters when somebody is watching:

```bash
npm run build     # about 15 seconds
npm start
```

Sign in as **Elmarie Coetzee** (Master) or **Sipho Mahlangu** (Technician).
There is no password — see [Demonstration mode](#demonstration-mode).

### If something goes wrong

- **`node` or `npm` not recognised** — the terminal was open before Node was
  installed. Close it and open a new one.
- **`npm.ps1 cannot be loaded because running scripts is disabled`** — the
  Windows execution policy. Run the `Set-ExecutionPolicy` line above, then reopen
  PowerShell. (`npm.cmd ci` also works as a one-off.)
- **`schannel: server closed abruptly (missing close_notify)`** on clone — see
  the `http.version` fix above.
- **Port 3000 already in use** — run on another port: `npm run dev -- -p 3001`.
- **The demo shows stale data** — it persists to browser storage between
  sessions. Reset it under Administration → System → Reset demonstration data.
- **`npm ci` fails on a lockfile mismatch** — you are on the wrong branch. Run
  `git checkout claude/eje-job-card-demo-k2klb4` and try again.

Running the browser smoke test (`npm run smoke`) additionally needs a Chromium
build, which is *not* downloaded by `npm ci`. Install it once with
`npx playwright install chromium`. Nothing else in the project needs it.

## If a route 404s

The routes are asserted two ways, because a route file existing does not prove
the server answering the port is serving it:

```
npm run check-routes     # asks the RUNNING app for every route in the matrix
```

It prints the build commit the server is serving, which is also shown on
**Administration → System → This build**. If that commit is not the one you have
checked out, the server is stale — which looks exactly like missing code in a
browser. Fix it with:

```
npm run clean            # removes .next, warns if the port is still held
npm run redeploy         # clean + build + start
```

`npm run clean` does not kill anything: it names the port and how to free it, so
nothing you started is terminated without you asking.

## Verifying it

```bash
npm run verify       # lint, typecheck, unit tests, production build
```

There is also an end-to-end smoke test that drives a real browser through the
entire job-card journey — accept, capture labour, write up, sign, review,
submit — and checks the simulated outbox, the checklist gate, search, the
library and the tablet layout:

```bash
npm run build && npm start -- -p 3210
npm run smoke
```

And a workflow walk-through that uses the address bar and the notification the
way a person does, asserting that no step lands on a 404 — signature capture,
hand-over, the Master's notification, Master Review, issue, close, and the final
document on the closed job:

```bash
npm run build && npm start        # port 3000
npm run e2e
```

`npm run dev-check` drives the same screens against `next dev` and fails on any
React warning, which a production build strips.

To look at the issued PDF rather than trust a description of it, `npm run
pdf-check` downloads the real final document from the running application,
checks it is a PDF that carries a signature, and renders every page to an image
under `.pdf-check/`:

```bash
npm run pdf-check                    # EJE-1044, the regression fixture
npm run pdf-check -- EJE-1062        # the parts collection note
```

## What to look at

| Area | Route |
|---|---|
| Master dashboard — workload, exceptions, technician load | `/dashboard` as a Master |
| Technician dashboard — today's work, touch-first | `/dashboard` as a Technician |
| Job list and filters | `/jobs` |
| Acceptance starting a job, then the full capture journey | `/jobs/EJE-1048` (open, awaiting acceptance) |
| Checklist gate blocking signature | `/jobs/EJE-1053` → Checklist tab |
| Awaiting spares, with the reason recorded | `/jobs/EJE-1051` |
| Signature and job card preview | `/jobs/EJE-1054/review` |
| Customers → sites → machines → job history | `/customers/cust-abc` |
| Machine record and service history | `/machines/machine-abc-lv40` |
| Technical Library | `/library` |
| Global search | `/search?q=LW-V40-70214` |
| Notifications — system alerts, each linking to its own destination | `/notifications` |
| Messages — two-way Master ↔ technician chat | `/messages` |
| Closed Jobs archive, with the final signed document on each | `/jobs/closed` as a Master |
| A closed job's historical record | `/jobs/EJE-1044` |
| The Simulated Outbox | `/notifications?tab=outbox` |
| Audit trail | `/activity` |
| Administration | `/admin` |

A suggested demonstration order is in [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md).

`Administration → System → Reset demonstration data` restores the seeded state
between demonstrations.

## Demonstration mode

The **Demo Mode** badge in the sidebar opens a full disclosure of what is
simulated. In short:

| Capability | In the demonstration | In production |
|---|---|---|
| Customer email | Recorded in the Simulated Outbox, never sent | Microsoft 365 via Graph |
| WhatsApp | The exact message is recorded, never sent | WhatsApp Business Platform |
| Job card PDF | Rendered live from the job record | Server-side PDF from the same model |
| Photos and videos | Attachment recorded, no file uploaded | VPS storage, then object storage |
| Sign-in | User picker, no password | Session auth against the users table |
| Offline | Browser storage so a demo survives a refresh | IndexedDB, service worker, sync engine |

Every one of these sits behind a service interface (`src/services/ports.ts`), so
connecting the real service replaces an adapter and nothing else.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the layering, the rules
that keep it honest, and exactly what changes in Phase 2.

```
src/domain/       business model and rules — no React, no I/O
src/application/  operations that coordinate domain, repositories and services
src/data/         repository interfaces + the demo adapter
src/services/     integration ports + simulated adapters
src/components/   design system and feature components
src/app/          routing and page composition only
```

## Historical accuracy

Two things about a signed job card must never change afterwards, and both are
enforced rather than documented:

- **Pricing.** When the customer signs, a full copy of the rates in force — the
  three labour rates, the call-out fee, the kilometre rate and VAT — is frozen
  onto the job. Every figure on that job is calculated from the copy for the rest
  of its life, so a Master changing a rate re-prices open work only. Part prices
  are captured per line and were already historical.
- **Checklist wording.** A completed checklist records the template id and
  version it was answered against, and the job card is rendered from that stored
  version. Revising a checklist does not rewrite a job card the customer already
  signed. `EJE-1044` is seeded completed against service checklist `1.0-DEMO`
  while new service jobs get `2.0-DEMO`, so the difference is visible in the
  demonstration.
- **The final document.** When a Master issues a job card, the document's
  descriptor is written onto the job and never produced again. Opening a closed
  job — from Closed Jobs, from the customer's history or from the machine's —
  reads that stored record, so *View Final PDF* and *Download Final PDF* always
  hand back the same official job card under the same file name
  (`EJE-1044-Final-Job-Card.pdf`). A parts collection keeps a collection note,
  not a job card.

`src/application/closed-jobs.test.ts` proves all three: it raises the rates and
publishes a new checklist version, then re-reads a closed job and asserts that
its totals, its checklist wording and its final document have not moved.

## Two-step submission

A technician never emails the customer. The job card goes to the office first:

    technician completes -> customer signs -> technician SUBMITS FOR MASTER REVIEW
      -> (no email, no final document)
      -> Master reviews and corrects
      -> Master SUBMITS JOB CARD -> final document generated -> customer emailed -> closed

`Master Review` is the `submitted` status: submitted by the technician, awaiting
the office. A Master can edit a job in that state — that is the entire point of
the stage — while a technician cannot. Only `closed` is final, for everyone.

Rates stay frozen at signature, so a Master correcting a job card prices it at
exactly what the customer saw. The line TOTAL can still move if a Master adds or
removes work, which is a real commercial event and is written to the audit trail
rather than happening quietly. The customer signature itself cannot be replaced.

## Notifications, messages and the closed-job archive

Three separate things, kept separate on purpose.

**Notifications** (`/notifications`) are the system reporting an event. Each one
carries an explicit destination rather than a derived one, so a submitted job
card opens the job in Master Review and a new message opens its conversation —
nothing is funnelled at the job screen. Handing a job card to the office notifies
**every active Master exactly once**; a disabled Master is not notified, because
a notification nobody can sign in to read is not a notification.

**Messages** (`/messages`) are people. A technician writes to "the office" and it
reaches every Master on duty; a Master writes to a technician. Both reply in the
same thread, unread counts show on the sidebar and clear when the thread is
opened, and a conversation can optionally be linked to a job. A message changes
nothing by itself: when a technician mentions being unavailable, a Master presses
**Mark unavailable** on that message, and the resulting availability record is
linked back to it.

**Closed Jobs** (`/jobs/closed`, Masters) is the archive. Search across job
number, customer, site, machine, serial number, order number and reference;
filter by customer, site, job type, technician and the date the job was closed.
Opening a record shows the complete historical job, read-only, with the final
signed document on file. It is the same record the customer, site and machine
histories link to — there is no second archived copy.

## Site location on acceptance

Accepting a job **never** sends a WhatsApp message on its own. Acceptance
completes and commits first; only then is the technician asked:

> **Send Site Location?**
> Would you like to send the site location to the technician via WhatsApp?
> *[Send Location] [No, Thanks]*

Choosing **Send Location** queues one short message — job number, customer,
machine, site and a Google Maps navigation link, and nothing else, because every
message costs money and interrupts someone who is usually already driving.
Choosing **No, Thanks** sends nothing. Either choice is recorded on the job's
activity trail.

The job is accepted and in progress regardless. `sendSiteLocation` never throws:
a WhatsApp outage is reported back and written to the trail, and the job is
untouched. There is a test that runs the whole flow against a deliberately broken
WhatsApp adapter to prove it.

The Google Maps link is a **deep link, not an integration** — no API key, no SDK,
no account — so unlike email and WhatsApp there is nothing here to swap out
later. Sites carry an optional pinned coordinate and fall back to the postal
address, because industrial estates routinely geocode to the wrong gate.

## Light and dark mode

The theme control sits in the top bar (one tap) and in the sidebar (Light / Dark
/ System). **Light is the default**, including on a machine set to dark; System
is offered but never assumed. The choice persists across refresh and is applied
by a small inline script before first paint, so the theme never flashes.

Dark mode is a second hand-tuned palette, not an inversion: see
`src/app/globals.css`, where each theme declares its values once and Tailwind's
tokens map onto them. No component carries a `dark:` variant. A job card preview
is pinned to the light palette in both themes, because it represents the paper
document the customer receives.

## Known gaps at the end of Phase 1

These are recorded deliberately rather than left to be discovered. None of them
blocks the Phase 2 architecture; each is a contained change.

- **No draft release path.** `EJE-1060` is seeded as a draft and the state
  machine allows `draft → open`, but no UI action performs it.
- **Two roles only.** `UserRole` is `master | technician`, so "assign a
  non-Master role" currently means technician. A third role is a change to
  `src/domain/access.ts` and nowhere else.
- **No password store.** Sign-in is a demo user picker. "Reset password" queues
  the email production would send and records it on the audit trail, but no
  credential exists to reset.
- **Files are records, not files.** Adding a document or a machine photo creates
  the record with the storage key the production uploader will produce; no file
  is transferred and previews are marked simulated.
- **Jobs are scheduled by date, not time.** An availability window therefore
  blocks the whole day it falls on — the safe direction, since nothing in the
  job record says a 10:00 call would have finished before an 11:00 return. The
  refusal carries the exact window so a Master can judge. When job start times
  arrive, `findAvailabilityConflicts` is the one function that changes.
- **Accepting a job keeps an existing assignee.** A technician who accepts a
  job the office assigned to somebody else does not become its primary
  technician, so they cannot then transfer it. Deliberate in the
  assign-then-accept flow, wrong when a technician picks up a colleague's
  unstarted job; `acceptJob` is the single place to change it.
- **Cancellation is for jobs not yet started.** A job with work captured
  against it cannot be cancelled from the UI, because doing so would strand
  that work. §37 of the review anticipates this and asks for stronger
  confirmation if it is ever added.
- **Repository reads are unpaginated** and `JobRepository.save` writes the whole
  job aggregate. Both are fine at EJE's scale but will want refining against a
  real API — see `docs/ARCHITECTURE.md` §6. The Closed Jobs archive therefore
  filters in the application layer and caps its result at 50 rows, telling you
  how many matched in total rather than implying the rest does not exist;
  `loadClosedJobs` becomes one API call in Phase 2 without the screen changing.
- **The PDF and the screen render one document, but not pixel for pixel.**
  Both consume `buildJobCardModel`, so their content, section order and labels
  cannot differ, and the PDF mirrors the screen's type scale and spacing. What
  it cannot mirror exactly is the typeface: PDF's standard fonts are Helvetica
  and Times, not the Inter and JetBrains Mono the application loads, and
  embedding a font would mean shipping a subsetter. So the document reads as the
  same job card, set in a different face.
- **The final PDF is rendered in the browser, not on a server.** A closed job's
  job card is a real PDF: rendered once, when the Master issues it, by the
  first-party writer in `src/lib/pdf`, and written to storage under the key on
  `job.finalDocument`. *Download Final PDF* reads those exact bytes back, so
  every download of a given job is byte-identical and a later rate, price or
  checklist change cannot reach it. What is *not* production-shaped is the
  delivery: the demo persists its data in the browser, so there is no server
  that holds the file and therefore no HTTP `Content-Disposition: attachment`
  response — the download is made from the stored bytes in the page. In
  production `StorageService.getDocument` becomes a disk or object-store read
  behind a download route, and no calling code changes.
- **Seeded closed jobs have their file written on first access.** A seed cannot
  ship binary content, so the five jobs closed before the demonstration began
  have no bytes until someone first opens their document. That render is a
  one-time backfill from the job's own frozen record — snapshot pricing, the
  checklist version recorded on the job, the captured signature — and is written
  to storage, so every download after it returns the same file.
- **Conversations are one-to-one or office-wide, with no attachments.** A
  technician writes to "the office" (every active Master) or a Master writes to
  one technician; there is no arbitrary group thread, no photo or file on a
  message, and no typing or delivery indicator. `Conversation.participantIds` is
  already a list, so a group thread is a UI change rather than a data one.
- **Message notifications are in-app only.** A `chat_message` notification is
  raised for every other participant and links straight to the conversation, but
  the demo does not also queue a WhatsApp or email nudge for it — deliberately,
  since every WhatsApp message costs money and the rule from the site-location
  work applies here too.

## Known configuration points

- **Checklist wording.** The installation and service checklists in
  `src/data/seed/checklists.ts` are representative demonstration content. The
  production system preserves the exact wording of the approved EJE / WD Hearn
  documents; replacing them is a data change, described in that file.
- **Currency and date format.** Money is printed on a signed customer document,
  so formatting is pinned explicitly in `src/lib/format.ts` rather than left to
  the runtime's locale data (Node and Chromium disagree on `en-ZA`). The
  separators at the top of that file are the one place to change if EJE prefers
  `R 3,800.00` to `R 3 800,00`.
- **Rates, VAT and the kilometre rate** are seeded in
  `src/data/seed/reference.ts` and are editable at `/admin` → Rates & VAT.
