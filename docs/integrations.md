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
| Google geocoding (site pins) | `GoogleGeocodingService` **when configured**, otherwise `SimulatedGeocodingService` (demonstration) or `UnconfiguredGeocodingService` (real deployment) | **Yes, when configured** |
| PDF rendering | `SimulatedPdfService` | n/a — rendered in the browser |

**Setting the three up** (Meta, Microsoft 365, Google Cloud), step by step for
the owner, is `docs/integrations-setup.md`. This page is the engineering
reference: what each adapter does and how the application uses it.
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
| `EMAIL_GRAPH_CERTIFICATE_PATH` + `EMAIL_GRAPH_CERTIFICATE_THUMBPRINT` | one credential is required — the certificate is preferred | — |
| `EMAIL_GRAPH_CLIENT_SECRET` | …or this | — |
| `EMAIL_SENDER` | yes | — |
| `EMAIL_REPLY_TO` | no | none — replies go to `EMAIL_SENDER` |
| `EMAIL_GRAPH_BASE_URL` | no | `https://graph.microsoft.com/v1.0` |
| `EMAIL_GRAPH_LOGIN_URL` | no | `https://login.microsoftonline.com` |
| `EMAIL_GRAPH_TIMEOUT_MS` | no | `20000` — how long one Graph request may take |
| `EMAIL_TEST_RECIPIENTS` | no | none — the only addresses Administration's "Send test email" may use |

**What each absence does.** Any one of the four required variables missing means
*no Graph configuration*, and a real-database deployment then **refuses to send
and says so on the job** — it does not fall back to SMTP or to the simulator. The
in-memory demonstration keeps its visible outbox. Two out
of four is treated as none: guessing which half was meant is how a system ends up
sending nothing quietly.

**One permission: `Mail.Send`, scoped to one mailbox (INT-EMAIL-5, 1 November
2026).** The adapter sends with ONE call, `POST /users/{sender}/sendMail` with
`saveToSentItems: true`, which needs the **application** permission
`Mail.Send` and nothing else. Grant it through **Exchange Online RBAC for
Applications**, scoped to `sales@ejeie.co.za` — not tenant-wide in Entra,
because permissions granted in Entra and in Exchange ADD UP, and a tenant-wide
Entra grant would make the Exchange scope meaningless. The exact commands are
in `docs/integrations-setup.md` §3.

The message is saved to the mailbox's Sent Items, so the office sees every
system email beside its own; the mailbox stays the office's, used as before.

**An earlier version of this adapter created a draft and then sent it**, which
needed `Mail.ReadWrite` and `Mail.ReadBasic.All` as well, so that Graph's
message id could be recorded. `sendMail` answers 202 with no body: the adapter
records Microsoft's `request-id` as the reference (`graph-request:…`), and sends
EJE's own outbox id as an `X-EJE-Reference` header. With `Mail.Send` alone
nothing can be read back, so `deliveryState` answers "unknown" for these and
nothing is ever assumed — `sent` means accepted by Microsoft 365.

**A certificate is preferred over a secret.** With
`EMAIL_GRAPH_CERTIFICATE_PATH` (a PEM holding the private key, readable only
by the service) and `EMAIL_GRAPH_CERTIFICATE_THUMBPRINT` (the SHA-1 thumbprint
Entra shows), the adapter signs a client assertion (RS256, `x5t`) for every
token request; no secret exists to leak or expire. An unreadable key file is
reported as a refused credential, not as an outage.

**Every request carries a deadline.** There was none: `fetch` with no signal
waits as long as the socket stays open, and these calls sit inside the request
that submits a signed job card — so an endpoint that accepted the connection and
then went quiet held a technician's submission open indefinitely. Twenty seconds
by default, `EMAIL_GRAPH_TIMEOUT_MS` to change it, and a deadline that expires is
reported as a TIMEOUT rather than as a refusal, because the two mean different
things to whoever is deciding what to do next.

**Attachments are checked before anything is sent.** Graph takes at most 3 MB of
attachments on the message resource; beyond that it needs an upload session,
which this adapter does not implement. A job card whose attachments exceed the
limit is refused here, by size, before a token is even requested — a retry would
send the same bytes.

#### Checking the configuration

A deployment with three of the four required variables set is indistinguishable
from one with none, as far as *"customer email is not configured"* goes. So:

- **At startup**, the chosen transport is logged, and a missing or suspect
  configuration is logged with the VARIABLE NAMES — never a value, not even a
  length. `[email] no customer email on this deployment. Not configured:
  EMAIL_GRAPH_CLIENT_SECRET is not set.`
- **`GET /api/health`** reports `"email"` as the transport in use (`graph`,
  `smtp`, `simulated` or `refuse`) and nothing more. That is the one bit an
  outside check needs in order to notice that a deployment cannot send; the
  reasons stay in the log, next to the operator.
- A deployment that is complete but wrong is caught too: `EMAIL_SENDER` that is
  not an address, a tenant id that looks like a mailbox, a nonsense timeout.
  Each of those selects a working transport that cannot send.

#### The customer email outbox — the signed job card, automatically (INT-EMAIL-3)

Issuing a job card stores the signed PDF and, in the SAME transaction, writes
one `email_messages` row: the recipient (the contact on the job), the active
default template for the job type with every placeholder filled, the sender,
and the stored PDF's key and SHA-256. The transaction commits; then the API's
drain hands it to Graph, and the worker started by `src/instrumentation.ts`
retries whatever is due every minute (which also resumes after a restart).

| State | Means |
|---|---|
| `queued` | written; waiting its turn, or a back-off after a temporary failure (1, 5, 15, 60, 180 minutes; six attempts) |
| `sending` | with Microsoft now |
| `sent` | Microsoft 365 ACCEPTED it — never "delivered" |
| `failed` | a permanent refusal, the last attempt used, or UNCERTAIN (see below) |
| `attention` | not sent: no valid address on the contact, or no active template for the job type. The office is notified |

- **No duplicates.** The idempotency key is the job and the stored document;
  the database also allows one queued, sending or sent email per job, event
  and document. A replayed signature finds the row that exists.
- **Uncertain is never re-sent automatically.** A timeout while the message
  request was out, or an email left in `sending` for ten minutes (a crash),
  may have reached Microsoft. It is marked failed with that explanation; the
  office checks Sent Items and confirms before a retry is allowed.
- **The attachment is the exact signed PDF.** Before sending, the stored bytes
  are checked against the checksum the email was written with.
- **History is immutable.** A sent row cannot be changed or deleted (trigger),
  and no row's content can change after it is written: a retry — after the
  address is corrected — is a NEW row that names the one it retries.
- Templates: Administration → Email Templates (`email_templates`,
  `email_template_versions`; one active default per event and job type).

#### `npm run integrations:check` — is this deployment ready, without messaging anybody

```bash
npm run integrations:check              # configuration only, no network
npm run integrations:check -- --probe   # ask the providers. SENDS NOTHING
```

`/api/health` says which transport was SELECTED. This says whether that
transport works, which is a different question and the one that decides whether
a customer receives their job card.

`--probe` acquires a client-credentials token from Microsoft (with the
certificate or the secret) and reads NOTHING — with `Mail.Send` alone the app
cannot read any mailbox, so the token proves the credential and only a test
email from Administration → Integrations proves the permission; for Meta it reads the
configured phone number's own metadata, and — when
`WHATSAPP_BUSINESS_ACCOUNT_ID` is set — whether the templates this build sends
are approved. No message is sent, and no customer record is read: the only
address involved is EJE's own.

The four verdicts are kept apart on purpose:

| Verdict | Meaning |
|---|---|
| `ABSENT` | Not configured. The missing variable NAMES are printed; no values, ever. |
| `PENDING` | Configured, and either nothing was asked of the provider or the provider could not be reached. **Not readiness.** |
| `READY` | The provider accepted the credential, and for WhatsApp the templates are known to be approved. |
| `REFUSED` | The provider rejected the credential, or Meta has no approved template under the name this build sends. Exits non-zero. |

An unreachable provider is reported as `PENDING`, never as `REFUSED`: that is
this moment's network, and reporting it as a refusal sends somebody to rotate a
secret that works.

A WhatsApp token that Meta accepts is still only `PENDING` until template
approval is confirmed. That is the most expensive false green available here —
the office would press send, Meta would drop the message, and the customer
would get nothing.

**The template names come from the application, not from configuration.** This
build sends `eje_job_assigned`, `eje_job_transferred` and `eje_site_location`,
and EJE must have templates approved in Meta Business Manager under exactly
those names, in WHATSAPP_TEMPLATE_LANGUAGE (default `en`).

#### What a failure means, and whether to press *Send again*

The adapter classifies what the provider said, and the delivery record carries
that wording, because the office has one button and nine situations:

| What happened | Retry? |
|---|---|
| 401 — the credential was refused | **No.** The certificate, `EMAIL_GRAPH_CLIENT_SECRET` or the registration |
| 403 — authenticated, not allowed | **No.** `Mail.Send` for the sending mailbox, through Exchange RBAC for Applications |
| 429 / 503 — throttled | **Yes**, after the wait Microsoft names in `Retry-After` |
| 5xx — Exchange is unavailable | **Yes** |
| An address Graph will not accept | **No.** Correct the customer's record first |
| Over the attachment limit | **No.** The same bytes fail the same way |
| The stored document could not be read | **No.** That is a storage problem |
| Timed out, or unreachable | **Yes.** Nothing was sent |

A re-send is refused outright while an attempt is still with the provider, so a
second press cannot put a second copy of one signed job card in a customer's
inbox. The refusal expires after ten minutes, because a process that died
mid-send would otherwise strand that customer's copy for good.

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
configuration, and remain re-sendable. `GET /api/health` must then report
`"email":"refuse"`, and the startup log must name the variable that is missing.

**What has NOT been done, and must not be claimed.** No live Microsoft 365
tenant has been configured and no message has been sent to a real mailbox from
this codebase. Everything above is proved against the real adapter driven by
injected HTTP responses — the requests it builds, the answers it believes, the
failures it tells apart and the deadlines it carries — which is the whole of what
can honestly be tested without EJE's tenant. **MANDATE-3 stays PARTIAL until a
configured deployment sends a real job card and the provider's behaviour is
observed.** The six steps above are that verification, and they need a tenant,
an app registration and a mailbox that nobody in this repository can create.

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
| `WHATSAPP_DEDICATED_NUMBER` | to send | none — the new, dedicated EJE number; nothing is sent without it |
| `WHATSAPP_PROTECTED_NUMBERS` | no (recommended) | none — the office's WhatsApp number(s); EJE refuses to send from them |
| `WHATSAPP_API_BASE_URL` | no | `https://graph.facebook.com` |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | no | none — needed to check template approval |
| `WHATSAPP_APP_SECRET` | for webhooks | none — every webhook POST is refused without it |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | for webhooks | none — Meta's verification is refused without it |
| `WHATSAPP_TEMPLATE_LANGUAGE` | no | `en` — the language the templates were approved in |
| `WHATSAPP_TEST_RECIPIENTS` | no | none — the only numbers Administration's "Send test message" may use |
| `EJE_PUBLIC_URL` | no | `https://eje.syncza.co.za` — the job link in a message |

**A dedicated EJE number; the office number is never touched.** The owner
decided (1 November 2026) that notifications go from a new number of EJE's own
(`docs/integrations-setup.md` §1). The adapter makes two calls only: `GET
/{phone-number-id}?fields=display_phone_number`, to confirm the sender IS the
dedicated number (and none of `WHATSAPP_PROTECTED_NUMBERS`) before sending —
refused permanently, nothing sent, if not — and `POST
/{phone-number-id}/messages` with a template. There is no register,
deregister, migrate or settings call anywhere (a test pins this).

**Not in use until a real test passes.** `ActivationGatedWhatsAppService`
reports itself unconfigured, so no job notification is queued, until a test
from Administration → Integrations to a `WHATSAPP_TEST_RECIPIENTS` number has
been accepted by Meta with the current sending configuration (a hash of the
phone number id, token, dedicated number and template language, kept in
`integration_state` as `whatsapp_activation` — no value stored). Until then
Administration says **Not configured**.

The token must be a **permanent System User token**, not a temporary one from
the dashboard.

### Which adapter a deployment gets

1. **Both credentials and the dedicated number set** → `CloudApiWhatsAppService`,
   behind `ActivationGatedWhatsAppService`. Messages go to Meta once a real
   test has passed (above).
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

**The delivery-status webhook (INT-WA-2).** `/api/integrations/whatsapp/webhook`:
the GET verification echoes Meta's challenge only for WHATSAPP_WEBHOOK_VERIFY_TOKEN;
every POST is refused unless its `X-Hub-Signature-256` HMAC of the raw body
verifies with WHATSAPP_APP_SECRET. Statuses (sent, delivered, read, failed,
with Meta's error code) are recorded once each (`whatsapp_webhook_events`) and
only ever move a message forward; a failure goes on the job's trail. Template
review results (approved, rejected, paused) go on the trail and a rejection
notifies the office. Inbound messages are counted and NOT stored. A permanent
refusal (a bad token, a missing template, a number not on WhatsApp) is failed
at once instead of spending the remaining attempts; the office can retry a
failed message from the job (a new message; the failed one is kept).

### Message templates

Outside a 24-hour customer service window — which is every message EJE send
first — WhatsApp accepts only templates Meta has approved. These must exist on
EJE's WhatsApp Business account, by exactly these names:

| Template | Placeholders, in order | Sent when |
|---|---|---|
| `eje_job_assigned` | job number, job type, customer, site, machine, job link | A technician is assigned (or added to) a job |
| `eje_job_transferred` | job number, job type, customer, site, machine, job link | A job is transferred to a technician |
| `eje_site_location` | job number, customer, machine, site, address, navigation link | A technician asks for the site location after accepting |

Nothing is sent for Open Jobs, a submission or Awaiting Spares. The variables
carry nothing a locked screen should not show: no fault description, no
contact name or number. The navigation link is the site's pin when it is
trusted (verified, or one confident automatic match) and otherwise an address
search, which the technician's screen labels as unverified.

---

## Google geocoding — the automatic site pin (INT-MAP-1..3)

`src/services/production/geocoding.ts` calls the server-side Geocoding API
(GOOGLE_MAPS_GEOCODING_API_KEY; region GOOGLE_GEOCODING_REGION, default `za`,
with `components=country:ZA`). The key never reaches a browser or a message.

- **When:** a site is geocoded when its address is written or changed — never
  when a job is opened. The same address is answered from `geocode_cache`
  while its answer is under 27 days old; the application stops at
  GOOGLE_GEOCODING_DAILY_LIMIT requests a day (default 500).
- **What is kept, and for how long** (rule 5; Service Specific Terms §6.3.1):
  Google's coordinates — a pin or a suggestion, verified or not — for at most
  30 days, then deleted by `maintainSiteProviderContent` (every minute in the
  worker, configured or not; the cache too). From day 27 a verified Google pin
  is re-asked by its place ID and stays verified if the place moved no more
  than 30 m; an unverified one is looked up again by address. The place ID is
  kept (exempt). The formatted address and precision are not stored. Office-
  entered coordinates are kept. Google's coordinates never go into the audit
  trail or a navigation link (links name the place ID).
- **What it does with the answer** (`domain/site/location.ts`): one precise
  match sets the pin (`resolved`, unverified); several matches, a partial
  match or an approximate place are only a SUGGESTION (`ambiguous`); no match
  is `not_found`; an outage or quota backs off and retries (five attempts); a
  refused key fails at once. The office's address is never replaced.
- **The office decides:** "The pin is correct", "Use the suggested pin", or
  coordinates typed in the site dialog — each makes the pin `verified`, and a
  verified pin is NEVER replaced automatically. When its address changes it
  becomes `stale`: kept, not trusted for navigation, with a new suggestion.
- **Before 0042:** pins the office had entered are marked verified, manual.
  Sites without one are not geocoded in bulk on deploy; Administration →
  Integrations → "Find pins for unpinned sites" asks for up to 25 at a time.
- **No key:** nothing is asked or paid for; sites say "Automatic pins are not
  set up", and technicians get the address search.

| Variable | Required | Default |
|---|---|---|
| `GOOGLE_MAPS_GEOCODING_API_KEY` | to geocode | none |
| `GOOGLE_GEOCODING_REGION` | no | `za` |
| `GOOGLE_GEOCODING_DAILY_LIMIT` | no | `500` |

**Terms:** read on 1 November 2026, with the quotes and links, in
`docs/integrations-setup.md` §4.6. Office verification does not make Google's
coordinates EJE's own; only the office's own coordinates are kept indefinitely.

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

## Where to make the swap

`buildServices` in `src/server/runtime.ts`, and nowhere else. The WhatsApp
adapter proved it: making that integration real was a change to one function
plus a new file under `src/services/production/`.
