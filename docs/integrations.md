# Outbound integrations: what is real, and what is not

Every outbound integration is declared as an interface in `src/services/ports.ts`
and constructed in one place, `buildServices` in `src/server/runtime.ts`. Nothing
in the domain, the application layer or a screen knows which adapter it has.

This page says, per integration, **what actually happens today**. It exists so
that nobody has to read an adapter to find out whether a message was sent.

| Integration | Adapter in use | Does anything leave the building? |
|---|---|---|
| WhatsApp | `CloudApiWhatsAppService` **when configured**, otherwise `SimulatedWhatsAppService` (demonstration) or `UnconfiguredWhatsAppService` (real deployment) | **Yes, when configured** |
| Email (Microsoft 365) | `GraphEmailService` **when configured**, otherwise `SmtpEmailService` (development only), `SimulatedEmailService` (demonstration) or `UnconfiguredEmailService` (real deployment) | **Yes, when configured** |
| PDF rendering | `SimulatedPdfService` | n/a — rendered in the browser |
| File storage | `FilesystemStorageService` on PostgreSQL, `DemoStorageService` in the demonstration | **Bytes are on disk in production** |

---

## Email — Microsoft 365 in production, SMTP in development

**Graph is the production architecture. SMTP is a development and testing
transport and is never used in production.** That distinction is enforced in
code, not by convention: see *Which adapter a deployment gets* below.

EJE's mail provider is Microsoft 365, so `src/services/production/email.ts` is a
real adapter for the Graph API. `src/services/development/email.ts` is a small
SMTP client that exists only because SMTP is the mail capability available while
the Graph app registration does not yet exist — it lets a developer watch a real
message arrive instead of trusting a simulation.

### Production configuration — Microsoft 365 (Graph)

| Variable | Required | Default |
|---|---|---|
| `EMAIL_GRAPH_TENANT_ID` | yes | — |
| `EMAIL_GRAPH_CLIENT_ID` | yes | — |
| `EMAIL_GRAPH_CLIENT_SECRET` | yes | — |
| `EMAIL_SENDER` | yes | — |
| `EMAIL_REPLY_TO` | no | none — replies go to `EMAIL_SENDER` |
| `EMAIL_GRAPH_BASE_URL` | no | `https://graph.microsoft.com/v1.0` |
| `EMAIL_GRAPH_LOGIN_URL` | no | `https://login.microsoftonline.com` |

**What each absence does.** Any one of the four required variables missing means
*no Graph configuration*, and a real-database deployment then **refuses to send
and says so on the job** — it does not fall back to SMTP or to the simulator. The
in-memory demonstration keeps its visible outbox. Two out
of four is treated as none: guessing which half was meant is how a system ends up
sending nothing quietly.

**In Entra ID** the app registration needs the **application** permission
`Mail.Send` with admin consent granted, and `EMAIL_SENDER` must be a real mailbox
in the tenant. Scope it down with an [application access
policy](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access) so the
registration can send as that one mailbox and no other.

**Why create-then-send.** Graph's `sendMail` returns 202 with no body and no
message id. This adapter instead creates a draft (`POST
/users/{sender}/messages`), which returns Graph's own id, then sends it. That id
becomes the outbox entry's id, and it is the only thing that makes the entry
reconcilable against a delivery report later.

### Development configuration — SMTP

| Variable | Required | Default |
|---|---|---|
| `EMAIL_SMTP_HOST` | yes | — |
| `EMAIL_SENDER` | yes | — |
| `EMAIL_SMTP_PORT` | no | `587` |
| `EMAIL_SMTP_USER` | no | none — no `AUTH` is attempted |
| `EMAIL_SMTP_PASSWORD` | no | none |
| `EMAIL_SMTP_IMPLICIT_TLS` | no | `yes` is implied by port 465 |

STARTTLS is used whenever the server advertises it. Credentials come from the
environment and nowhere else: there is no default host, no default account and
no fallback, and nothing is ever written to the repository.

**SMTP has no delivery reports.** Once the receiving server answers `250`, the
adapter knows the message was *accepted* and can never learn anything more, so it
never moves a job to `delivered` on its own — that is one of the reasons it is not
the production answer.

### Which adapter a deployment gets

The rule is one function, `chooseEmailTransport`, and it is unit-tested:

1. **Graph configured** → `GraphEmailService`. Mail goes to Microsoft 365.
2. **Otherwise, SMTP configured and `NODE_ENV` is not `production`** →
   `SmtpEmailService`. Development and testing only; **no combination of
   variables can select SMTP in production**.
3. **Otherwise, the demonstration** (the in-memory backend, no database) →
   `SimulatedEmailService`, recorded in the visible outbox and transmitted
   nowhere. Decided by the **backend**, not by `NODE_ENV`: the demonstration is
   served by `next start`, so testing `NODE_ENV` first would break the visible
   outbox the demonstration depends on.
4. **Otherwise** — a real database with no email configuration →
   `UnconfiguredEmailService`, which **refuses** and says what to set. If SMTP was
   configured in production, the refusal says that too.

Two signals, each doing one job: the **backend** says whether this is the
demonstration; `NODE_ENV` says only whether the development transport may be used
at all.

A refusal is not a lost job. The submission records the failure and its reason on
the job's delivery record, the job waits in `awaiting_delivery`, and the office
can re-send the **stored** document once the deployment is configured.

### What is accepted, and what is delivered

No email adapter in this system ever reports `delivered` by itself. Graph
accepting a send means Exchange has the message, which is `pending_delivery`.
Only a delivery report may move a job to `delivered` and close it, and **this
deployment does not yet receive one** — today that confirmation comes from the
outbox screen, which stands in for the report. A job therefore does not close on
a send; it closes on a confirmation.

### Verifying a live send without emailing a customer

Never use a real customer's job card as a test. Instead:

1. Configure Graph in a non-production environment, or in production with
   `EMAIL_SENDER` pointed at an EJE mailbox you control.
2. Seed or raise a job whose recipient address is **your own** mailbox — in the
   demonstration data, edit the site contact's email before submitting.
3. Submit that job card. Watch the message arrive with its PDF attached.
4. Check the outbox screen: the entry is marked **not simulated**, its id is
   Graph's own message id, and its state is `pending_delivery` — *not* delivered.
5. Confirm delivery from the outbox screen and watch the job close.
6. `journalctl -u eje -n 50` should contain no credential and no token. It never
   should: both are redacted from every message this adapter raises.

To prove the refusal path, unset one Graph variable in a production-mode
deployment and submit: the job must show a failed delivery naming the missing
configuration, and remain re-sendable.

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
