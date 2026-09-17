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
| Notifications and the Simulated Outbox | `/notifications` |
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
- **No job transfer, and no customer/machine/user editing.** The repositories
  support writes; the operations and screens do not exist yet.
- **Repository reads are unpaginated** and `JobRepository.save` writes the whole
  job aggregate. Both are fine at EJE's scale but will want refining against a
  real API — see `docs/ARCHITECTURE.md` §6.

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
