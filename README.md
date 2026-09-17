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
| Job card, work capture, checklist, activity | `/jobs/EJE-1048` |
| Checklist gate blocking signature | `/jobs/EJE-1053` → Checklist tab |
| Awaiting spares | `/jobs/EJE-1051` |
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
