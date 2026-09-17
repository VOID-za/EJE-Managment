# Architecture

This document explains how the demonstration system is put together, why it is
put together that way, and precisely what changes when it becomes the production
system.

The guiding constraint: **the demo must be able to grow into the production
system without a rewrite.** Everything below follows from that.

---

## 1. Layering

```
┌──────────────────────────────────────────────────────────────┐
│  src/app          Next.js App Router — routing and page       │
│                   composition only. No business rules.        │
├──────────────────────────────────────────────────────────────┤
│  src/components   EJE design system (ui/) and feature         │
│                   components. Presentation only.              │
├──────────────────────────────────────────────────────────────┤
│  src/application  Operations: acceptJob, addLabour,           │
│                   captureSignature, submitJob…                │
│                   Coordinates domain + repositories +         │
│                   services. No React.                         │
├──────────────────────────────────────────────────────────────┤
│  src/domain       Types, the job state machine, pricing,      │
│                   checklist rules, access capabilities.       │
│                   Pure TypeScript. No React, no I/O.          │
├──────────────────────────────────────────────────────────────┤
│  src/data         Repository INTERFACES (async, domain types) │
│                   + the demo adapter                          │
│  src/services     Integration PORTS + simulated adapters      │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point downwards only. `src/domain` imports nothing from the layers
above it, which is what makes it directly reusable server-side in Phase 2.

## 2. The rules that keep it honest

**Business rules never live in components.** A component asks the domain a
question and renders the answer:

- `canTransition(from, to)` — is this workflow step legal?
- `checkReadyForSignature(job)` — and if not, *why not*, as a list of
  violations the UI can display.
- `calculateJobTotals(job, settings)` — what is this job worth? It resolves rates
  through `resolveJobPricing`, so a job carrying a pricing snapshot is priced at
  that snapshot everywhere, by construction rather than by each caller
  remembering to check.
- `can(role, 'jobs.assign')` — capability, not a role string comparison.

This is why the job card can tell a technician exactly what is outstanding
instead of showing a disabled button with no explanation, and why the figure on
screen is guaranteed to match the figure on the invoice.

**Job types carry behaviour, not just a label.** `getJobTypeDefinition(code)`
returns whether a checklist is mandatory, whether photos are required, and the
default priority. The workflow enforces those. Adding a job type in Phase 2 is a
row in a table, not new code.

**Every write goes through an operation.** Operations in
`src/application/job-operations.ts` ask the domain for permission, produce the
next immutable `Job` value, persist it through a repository, and record an audit
event. A component cannot skip any of those steps because it has no other way to
write.

**Nothing is discarded silently.** Line removal and every workflow transition go
through a confirmation dialog; the completion write-up saves explicitly and warns
before unsaved text is lost.

## 2a. Historical accuracy

Two kinds of record must not change after the fact, and both are handled the
same way: the job stores what it was judged against, and the read path uses it.

- A `PricingSnapshot` is frozen onto the job when the customer signs — the moment
  the figure becomes a commitment, rather than at submission. It stores values,
  not a settings id, because the settings record is mutable.
- A `ChecklistInstance` stores `templateId` and `templateVersion`, and
  `loadJobView` resolves the template with `findByVersion`. When a version is no
  longer held the UI says so rather than falling back to current wording — a
  silent fallback would be worse than an honest gap.

## 3. Data access

`src/data/repositories/index.ts` declares the interfaces. Every method is
`async` and speaks only in domain types:

```ts
export interface JobRepository {
  list(filter?: JobFilter): Promise<readonly Job[]>;
  findById(id: JobId): Promise<Job | null>;
  findByJobNumber(jobNumber: string): Promise<Job | null>;
  save(job: Job): Promise<Job>;
}
```

The demo binds these to a browser-persisted snapshot (`src/data/demo/`). Phase 2
binds them to HTTP clients calling the Node/Drizzle REST API. Nothing above the
data layer knows or cares which.

The demo dataset is held in a plain class outside React and read through
`useSyncExternalStore`. That is the correct primitive for a store whose value
differs between the server render and the hydrated client, and it keeps
hydration honest without render-phase mutation.

`useQuery` is a small stale-while-revalidate hook over the repositories. It
distinguishes *loading* (nothing to show yet) from *refreshing* (a write
invalidated the data but the previous result is still valid) — without that
distinction, every capture on a job card would tear the screen down to a
skeleton and lose the state of any open panel. The Phase 2 query cache slots in
at the same call sites.

## 4. Integrations

`src/services/ports.ts` declares `EmailService`, `WhatsAppService`,
`PdfService`, `StorageService`, `Clock` and `IdGenerator`.

The demo adapters record what production *would* transmit into a visible
Simulated Outbox and never contact anything. This is a deliberate rule: the demo
must never pretend to have sent a message.

Nothing is ever sent as a side effect of a workflow step. The one outbound
message a technician can trigger — the site location after acceptance — is an
explicit choice, taken after acceptance has already committed, through an
operation that cannot throw. A messaging outage is recorded on the audit trail
and the job is unaffected. Outbound messaging is a convenience attached to the
workflow, never a dependency of it.

The Google Maps navigation link is deliberately NOT a port. Building the URL
needs no key, SDK or account, so there is nothing to mock now or replace later;
it lives in `src/domain/site/navigation.ts` as a pure function. Embedded maps or
server-side geocoding would be a real integration and would get a port like the
others.

The job card preview is rendered from the live `Job` record by
`JobCardDocument`, which is the same model the production PDF renderer will
consume. It is not a picture of a job card that has to be thrown away.

## 5. Composition root

`src/providers/AppProvider.tsx` is the only module that knows which concrete
adapters are in use. Swapping the demo adapters for production clients is a
change there and nowhere else.

## 6. What changes in Phase 2

| Concern | Demo | Production |
|---|---|---|
| Persistence | localStorage snapshot | PostgreSQL 18 via Drizzle |
| Data access | `DemoJobRepository` | `HttpJobRepository` → REST API |
| Query cache | `useQuery` | React Query / SWR |
| Auth | User picker | Session auth, hashed credentials |
| Email | `SimulatedEmailService` | Microsoft 365 Graph |
| WhatsApp | `SimulatedWhatsAppService` | WhatsApp Business Platform |
| PDF | Descriptor + live preview | Server-side renderer, same model |
| Storage | Placeholder keys | VPS disk, then S3-compatible |
| Offline | Browser storage | IndexedDB + service worker + sync engine |
| Job types, checklists, rates | Seeded constants | Master-editable tables |
| Theme | `data-theme` + localStorage | Unchanged; optionally stored per user |
| Deployment | `next start` | Hostinger VPS, Docker Compose, Caddy, Cloudflare, Redis |

**Unchanged by all of the above:** `src/domain`, `src/application`, and every
component. That is the point of the layering.

## 7. Deliberate non-goals for Phase 1

Per the brief, the demonstration does not implement the offline synchronisation
engine, real WhatsApp or Microsoft 365 integration, a production database
deployment, or Redis. Each is represented behind the interface it will
eventually sit behind, so introducing it does not disturb the business logic.

## 8. Dependencies

The runtime dependency list is deliberately three packages: `next`, `react`,
`react-dom`. The design system, icon set, class-name helper, formatting and data
layer are all first-party, because each would otherwise be a dependency to
maintain for very little gain.

TypeScript is pinned to 5.9 rather than the newly released 7.0 for ecosystem
stability; `strict` and `noUncheckedIndexedAccess` are on, and `any` is a lint
error.
