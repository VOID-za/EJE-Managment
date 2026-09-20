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
│                   + the PostgreSQL and demonstration adapters │
│  src/services     Integration PORTS + simulated adapters      │
└──────────────────────────────────────────────────────────────┘
```

Dependencies point downwards only. `src/domain` imports nothing from the layers
above it, which is what made it directly reusable server-side.

**The application now runs on the server.** `src/components` no longer holds
repositories: it calls `src/api`, which is HTTP and JSON and nothing else, and
`src/app/api/**` resolves the actor from the session cookie and calls the SAME
operations. The two new layers sit between the components and the application:

```
src/api      The browser's client. Fetch, JSON, one error type. No rules.
src/server   Authentication, the actor, validation, idempotency, the read
             models, and the composition root. Never reachable from a client.
```

See [`security.md`](./security.md).

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

**Notifications and messages are separate things, and stay separate.** An
`AppNotification` is the system reporting that something happened; a
`ChatMessage` in a `Conversation` is one person asking another something. They
have different types, different repositories and different screens
(`/notifications` and `/messages`), because merging them buries the item that
needs a reply among the ones that do not. They meet at exactly one point: a new
message raises a `chat_message` notification carrying an explicit
`link` to its conversation. That `link` is set per notification rather than
derived, so every notification navigates to its own destination instead of
everything being funnelled at the job screen.

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
- A `FinalDocument` is written onto the job at the one moment a Master issues it
  (`submitJobCard`), recording the file name, page count, who issued it, when,
  and the address it went to — and the PDF **bytes are rendered once, there, and
  written to storage** under that record's key. Every read path — the closed-job
  screen, the review screen, and `Download Final PDF` — reads that record or
  those bytes. Nothing regenerates a closed job's document: regenerating would
  imply it could change, and would append a `pdf_generated` audit entry every
  time somebody merely looked at old paperwork. The final copy is produced with
  `PdfVariant: 'final'`, which gives it its own storage key and a file name that
  says it is final, so a working preview can never overwrite what the customer
  received.

  **One document, two renderers.** `buildJobCardModel` in
  `src/lib/job-card/model.ts` is the single definition of the job card: its
  sections, their order, every label and every already-formatted value. The
  on-screen `JobCardDocument` and the PDF writer both consume it and decide only
  how to draw it, because HTML and PDF genuinely differ on typography and page
  breaks and should differ on nothing else. They were allowed to diverge once —
  the PDF grew its own section order and left the signature box empty — and
  `final-document-layout.test.ts` now asserts that every label and value in the
  model reaches the PDF, in the same order.

  The signature is part of that model as its stored data, and
  `signatureFacsimile` in `src/lib/signature.ts` decides how to draw it, once,
  for both renderers: a signature captured in the application is a normalised
  path and is stroked into the PDF as that geometry in `#000000`; a seeded
  demonstration job stores a descriptive label instead, and both renderers draw
  the name in a cursive face. Splitting that decision between the two renderers
  is exactly what produced an empty box on paper.

  `loadFinalDocumentFile` is the one way to obtain the file. It takes a **job
  number**, never a storage key, so a caller can only ever be handed the
  document recorded on that job; it applies the same access rule as seeing the
  job itself; and it writes no audit event, because reading is not an event. The
  PDF is produced by the first-party writer in `src/lib/pdf`, from the same
  domain functions the on-screen job card uses, so the figures on the file a
  customer keeps cannot disagree with the figures they were shown.

Together these three mean a closed job card is fixed: a later rate change, part
price or checklist revision cannot reach it. `src/application/closed-jobs.test.ts`
asserts exactly that, driving the real operations and repositories.

## 2b. Routing

There is one canonical route per screen. Job workflow stages are routes under
the job, not modals or query flags, so a Master can be sent a link to the exact
stage and a browser back button behaves.

| Route | Role | Job status | Purpose |
|---|---|---|---|
| `/dashboard` | Master / Technician | any | Role-specific dashboard |
| `/jobs` | Master / Technician | any | Job list. **Open Jobs is `/jobs?status=open`** — a filter, not a route |
| `/jobs/new` | Master | — | Raise a job |
| `/jobs/closed` | Master | `closed` | Closed-job archive |
| `/jobs/[jobNumber]` | assigned user / Master | any | Job detail and capture |
| `/jobs/[jobNumber]/sign` | Technician | `customer_signature` | Customer signature |
| `/jobs/[jobNumber]/review` | Technician / Master | `review`, `submitted`, `closed` | Job card preview, hand-over, Master Review, final document |
| `/messages` | Master / Technician | any | Two-way chat |
| `/notifications` | Master / Technician | any | Notification centre, `?tab=outbox` for the Simulated Outbox |
| `/customers`, `/customers/[customerId]` | Master | any | Customers and job history |
| `/machines`, `/machines/[machineId]` | Master | any | Machine register and history |
| `/technicians/[userId]` | Master / self | any | Technician record |
| `/calendar`, `/activity`, `/library`, `/search`, `/admin` | see `navigation.ts` | any | Supporting screens |
| `/schedule` | any | any | Superseded — redirects to `/calendar` |

`/jobs/[jobNumber]/review` deliberately serves three stages rather than three
routes, because it renders one thing — the job card as the customer will receive
it — and only the action beneath it changes with status. Splitting it would mean
three screens that must agree on the document.

Two rules keep this honest, because every link is built from a template string
that TypeScript cannot check:

- `src/app/routes.test.ts` derives the real route tree from the filesystem and
  asserts that **every** internal link written anywhere in `src/` resolves to
  one of those routes. A renamed route fails there, naming the file and link.
- `npm run check-routes` asks the **running server** for every route in the
  matrix and fails if any serves a 404 — because a route file existing does not
  prove the process answering the port is serving it. It also reports the build
  commit stamped into the served HTML, which is how a stale server is told apart
  from missing code.

### Proving a PDF is readable

Extracting a PDF's text shows it contains the right words and nothing about
whether they can be read. `src/lib/pdf/inspect.ts` parses the rendered document
back and measures every text run with the same metrics the renderer used, so a
test can assert what a reader would see: nothing past a margin, nothing printed
over anything else, text on every page, and a signature physically present.
`final-document-layout.test.ts` runs it over every closed job in `npm run
verify`, and `npm run pdf-check` downloads the real file from a running
application and renders each page to an image for a person to look at.

The base-14 fonts are named rather than embedded, which keeps the file small but
means the viewer substitutes a metrically similar font — usually a wider one.
Laying out to exact Helvetica widths therefore still overflowed, so both the
renderer and the inspector reserve `SUBSTITUTION_ALLOWANCE` of headroom.

A path that does not match any route reaches `src/app/not-found.tsx`, which
names the path and says that a stale build is the usual cause. Next's default
404 says only "This page could not be found", which is indistinguishable from a
broken deployment.

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

These are bound on the SERVER — to PostgreSQL (`src/data/postgres/`), or to the
demonstration snapshot (`src/data/demo/`) where that was chosen. Nothing above
the data layer knows or cares which, and the browser never holds either.

The demo dataset is held in a plain class outside React and read through
`useSyncExternalStore`. That is the correct primitive for a store whose value
differs between the server render and the hydrated client, and it keeps
hydration honest without render-phase mutation.

`useQuery` is a small stale-while-revalidate hook over the API client. It
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

`src/server/runtime.ts` is the only module that knows which concrete adapters
are in use. It is a SERVER module: it chooses from the server's environment,
once, and the browser has no vote.

`src/providers/AppProvider.tsx` used to be that module. It now holds a session
and nothing else — no repository, no service, no operation context, and no user
id it chose for itself. Swapping a simulated integration for a production client
is a change in `runtime.ts` and nowhere else.

## 6. What changes in Phase 2

| Concern | Demo | Production |
|---|---|---|
| Persistence | localStorage snapshot | PostgreSQL 18 via Drizzle |
| Data access | `DemoJobRepository` | `HttpJobRepository` → REST API |
| Query cache | `useQuery` | React Query / SWR |
| Auth | User picker | Session auth, hashed credentials |
| Email | `SimulatedEmailService` | Microsoft 365 Graph |
| WhatsApp | `SimulatedWhatsAppService` | WhatsApp Business Platform |
| PDF | First-party renderer in the browser | Same renderer, same model, server-side |
| Storage | Bytes in the persisted snapshot | VPS disk, then S3-compatible |
| Document download | Stored bytes → `Blob` + `download` | `GET` with `Content-Disposition: attachment` |
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
