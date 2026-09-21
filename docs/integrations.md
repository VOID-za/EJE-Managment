# Outbound integrations: what is real, and what is not

Every outbound integration is declared as an interface in `src/services/ports.ts`
and constructed in one place, `buildServices` in `src/server/runtime.ts`. Nothing
in the domain, the application layer or a screen knows which adapter it has.

This page says, per integration, **what actually happens today**. It exists so
that nobody has to read an adapter to find out whether a message was sent.

| Integration | Adapter in use | Does anything leave the building? |
|---|---|---|
| WhatsApp | `CloudApiWhatsAppService` **when configured**, otherwise `SimulatedWhatsAppService` (demonstration) or `UnconfiguredWhatsAppService` (real deployment) | **Yes, when configured** |
| Email (Microsoft 365) | `SimulatedEmailService` | No |
| PDF rendering | `SimulatedPdfService` | n/a — rendered in the browser |
| File storage | `SimulatedStorageService` | No bytes are retained for uploads |

---

## WhatsApp — real, where it is configured

`src/services/production/whatsapp.ts` is a real adapter for the WhatsApp
Business Platform Cloud API.

### Configuration

| Variable | Required | Default |
|---|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | yes | — |
| `WHATSAPP_ACCESS_TOKEN` | yes | — |
| `WHATSAPP_API_VERSION` | no | `v21.0` |
| `WHATSAPP_API_BASE_URL` | no | `https://graph.facebook.com` |

The token must be a **permanent System User token**, not a temporary one from
the dashboard.

### Which adapter a deployment gets

1. **Both credentials set** → `CloudApiWhatsAppService`. Messages go to Meta.
2. **No credentials, no database** (the demonstration) → `SimulatedWhatsAppService`.
   Messages are recorded in the visible outbox and transmitted nowhere. A
   demonstration telling the truth about itself.
3. **No credentials, PostgreSQL** (a real deployment, unconfigured) →
   `UnconfiguredWhatsAppService`, which **refuses**. It does not fall back to the
   simulated adapter: a business running on real data would otherwise be shown an
   outbox full of messages nobody ever received.

A refusal never fails the work in hand. An assignment stands and the audit trail
records `assignment_notification_failed` with the reason.

### Accepted is not delivered

The Cloud API answers a send with a message id and a status of `accepted`. That
means **Meta has the message**, not that a handset has it. The adapter records
`pending_delivery` and nothing in this system may set `delivered` without a
provider confirmation.

**Still required for production:** a delivery-status webhook. Until one exists,
no WhatsApp message can ever move past `pending_delivery`, and the screens say
so rather than implying receipt.

### Message templates

Outside a 24-hour customer service window — which is every message EJE send
first — WhatsApp accepts only templates Meta has approved. These must exist on
EJE's WhatsApp Business account, by exactly these names:

| Template | Placeholders, in order | Sent when |
|---|---|---|
| `eje_job_assigned` | job number, customer, site, machine or subject | A technician is assigned a job |
| `eje_site_location` | job number, customer, machine, site, navigation link | A technician asks for the site location after accepting |

An unapproved or renamed template is refused by the Cloud API and surfaces as a
recorded failure, not a silent one.

---

## File storage — the genuine gap

`SimulatedStorageService.put` **keeps no bytes.** It allocates a storage key and
returns it; the file's contents are discarded.

This is what a job attachment uses. So when the office attaches a customer order
to a new job:

- the file's **name, type and size are recorded** against the job, persisted in
  `job_media`, and shown on the job card;
- the **document itself is not kept**, and no screen offers a download, because
  a download button that always failed would be worse than the sentence that is
  shown instead.

**Still required for production:** S3-compatible object storage (or VPS disk)
behind `StorageService`. `putDocument`/`getDocument` already keep bytes — the
demonstration in its own snapshot, PostgreSQL in process memory — which is
enough for an issued job card within one process lifetime and **not** enough for
a business. Both are the same swap in `buildServices`.

---

## Email — not yet real

`SimulatedEmailService` records what would have been sent into the outbox.
Microsoft Graph is its own phase. The delivery model is already honest about
itself: `send` returns what the provider said, `pending_delivery` is the normal
answer, and a job is not closed until something confirms delivery.

---

## Where to make the swap

`buildServices` in `src/server/runtime.ts`, and nowhere else. The WhatsApp
adapter proved it: making that integration real was a change to one function
plus a new file under `src/services/production/`.
