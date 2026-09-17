# EJE Job Card Management System — Demonstration

A working demonstration of the job card management system for **EJE Industrial
Electronics**, built to be shown to management for approval.

This is Phase 1. It is a real web application, not a mockup: the workflow, the
business rules and the job costing run exactly as the production system will.
What is deliberately *not* real is listed under [Demonstration mode](#demonstration-mode),
and the application says so on screen.

All data in this demonstration is fictional. No real customer information is used.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Production build:

```bash
npm run build
npm start
```

Sign-in has no password: pick a Master or a Technician to see the system as that
role sees it. Start as **Elmarie Coetzee** (Master) or **Sipho Mahlangu**
(Technician).

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
| WhatsApp | The exact message is shown, never sent | WhatsApp Business Platform |
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

- **WhatsApp is declared but never invoked.** The port and simulated adapter
  exist and notification channels are shown in the UI, but no operation calls
  `services.whatsapp.send()`, so the outbox only ever contains email.
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
