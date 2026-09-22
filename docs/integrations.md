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
| File storage | `FilesystemStorageService` on PostgreSQL, `DemoStorageService` in the demonstration | **Bytes are on disk in production** |

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

A refusal never fails the work in hand. The assignment stands, the outbox row
stays `pending` with the reason on it, and the next mutation tries again.

### Nothing is sent inside a database transaction

The business transaction records the obligation and commits; the send happens
afterwards. See `src/server/api/outbox-dispatch.ts` and the `outbox_messages`
table.

```
validate → persist the assignment → record the outbox row → COMMIT → send
```

A PostgreSQL transaction is never held open across a call to Meta, and a commit
cannot lose the fact that somebody still has to be told something. A message
that could not be sent is a row that is still `pending`; the next mutation
anybody makes drains it, up to four attempts, after which it is `failed` and
somebody should pick up a telephone.

Three words, three different facts, none borrowed for another:

| | means |
|---|---|
| `pending` | recorded, not yet handed to the provider |
| `sent` | the provider ACCEPTED it. No handset has confirmed anything |
| `failed` | given up on, after the attempt limit. Carries the reason |

Draining is retryable and never duplicates a business change: a retry is another
attempt at the same row, and `for update skip locked` stops two concurrent
requests handing Meta the same message.

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

## File storage — real on PostgreSQL

`FilesystemStorageService` writes bytes to a directory and reads them back. A
customer's order attached to a job in March is still there in September, across
every restart and deployment in between.

### Configuration

| Variable | Required | Default |
|---|---|---|
| `EJE_STORAGE_DIR` | no, but set it | `<cwd>/.eje-storage` |

The default exists so a deployment cannot fail to store a document because
nobody set a variable. **A real deployment should set an explicit path on a
volume that is actually backed up** — that is the part a default cannot do for
anybody.

**Development and production must not share a directory.** They are separate
databases; the rows in each locate objects by key, and one storage directory
behind two databases means a development reset leaves production rows pointing
at files that are still there but no longer indexed — or, worse, at somebody
else's. Give each environment its own path, e.g. `/var/lib/eje/dev-storage` and
`/var/lib/eje/storage`.

### What is stored, and where

| | |
|---|---|
| The bytes | `<root>/<key>.bin` on disk |
| Name and type | `<root>/<key>.json`, beside them |
| The index | PostgreSQL `job_media`, which is authoritative |

The database is the INDEX, not the store: the row says where the object is and
does not contain it.

### Keys and paths

Storage keys are `uploads/<uuid>` — generated, never derived from a file name.
A name is user-controlled and a path built from one is a traversal waiting to
happen. Keys are additionally validated on the way to a path, and the resolved
path is checked to be inside the root.

### Nothing is public

`resolveUrl` returns an inert reference in every adapter. There is no public
path to a stored file. Retrieval goes through
`GET /api/jobs/:jobId/attachments/:attachmentId`, which authorises the request
against the JOB — the same visibility rule every job read uses — before it reads
a byte. A storage key is not a credential and no route accepts one.

### Validation

Server-side, and the browser's declared type is ignored for deciding what a file
is:

| | |
|---|---|
| Size | 25 MB, checked on `Content-Length` and again on the bytes |
| Type | **Sniffed** from the magic number: PDF, PNG, JPEG, TIFF, WebP |
| Name | Path separators and control characters stripped; metadata only |
| Empty | Refused |

### Consistency

Bytes first, row second. A failed write raises, so the database never claims an
attachment exists when nothing was stored. The opposite failure — bytes written,
transaction rolled back — leaves an object nothing points at, which costs disk
and tells nobody anything false. Removal is a soft mark (`job_media.removed_at`)
and never destroys bytes, so there is no delete-then-orphan case.

### Demonstration storage is different, and says so

`DemoStorageService` keeps bytes in the demonstration snapshot. They survive a
page reload, which is what makes `npm run dev` usable end to end with nothing
installed; they do **not** survive a restart, and that adapter is never what a
PostgreSQL deployment gets.

### Still required for production

S3-compatible object storage, if EJE ever run more than one application server —
a directory is durable but local. It is the same swap in `buildServices`:
implement `StorageService` against the bucket and no caller changes.

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
