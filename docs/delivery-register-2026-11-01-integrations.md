# Delivery register — WhatsApp, Google Maps and email integration (1 November 2026)

Asked for by the owner on 1 November 2026 ("FULL WHATSAPP, GOOGLE MAPS & EMAIL
INTEGRATION"). Requirements: `docs/SCOPE.md` (INT-EMAIL-1..5, INT-WA-1..3,
INT-MAP-1..3, INT-ADMIN-1). Owner's setup guide: `docs/integrations-setup.md`.
Engineering reference: `docs/integrations.md`. Real-account checks:
`docs/staff-testing.md` section N. Status of every item: **TESTED with mocked
or simulated providers — awaiting approval.**

## What existed, and what was built

| Area | Before | Now |
|---|---|---|
| Email transport | Graph adapter, create-then-send (Mail.ReadWrite + Mail.Send + Mail.ReadBasic.All), client secret only | `sendMail` (Mail.Send only, Sent Items), certificate or secret, request id recorded |
| Signed job card email | Sent synchronously inside the submission, hard-coded subject and body; no address = submission refused | Durable outbox (`email_messages`), templates by job type, sent after commit, retried, idempotent, history, attention + office notification for no address/template |
| Templates | none | Administration → Email Templates, versioned, audited, one default per job type |
| WhatsApp | Assignment and site location queued via outbox; transfer reused the assignment template; no webhook | Own transfer template, six lock-screen-safe variables with a job link, permanent failures, verified webhook, delivery/read/failed per message, office retry |
| Site location | Coordinates only if typed by hand | Automatic geocoding (Google), cache, daily cap, suggestions, verification, stale marking, trust-aware navigation |
| Administration | none for integrations | Integrations status (never a secret), safe tests to configured test recipients only, configuration changes audited |

## Migration 0042 (additive)

New tables `email_templates`, `email_template_versions`, `email_messages`,
`whatsapp_webhook_events`, `geocode_cache`, `integration_usage`,
`integration_state`; defaulted columns on `outbox_messages` and `sites`. The
only backfill marks pins the office had already entered as verified, manual.
Triggers: a template version is never changed; an email's content is never
changed and a sent email never changes or is deleted. Rollback: the live
release (`c68b3c3`) against a database at 0042 is the CI rollback step.

## Decisions taken without the owner, and why

- **No address no longer refuses the signature.** The owner's instruction
  ("do not send, record attention, notify the office, allow correction and
  retry") replaces the old refusal; three tests that asserted the refusal were
  inverted, with the reason written in them.
- **An address that is not an address is never handed to Microsoft** (it was).
- **A Parts collection note has a template too**, so no existing email stops.
- **Templates are created by the application** on first use (by system key,
  idempotent), not seeded in SQL, so "Restore system default" and the seed are
  one text.
- **WhatsApp templates end with a fixed line** in the setup guide (Meta often
  rejects a body ending in a variable); the six variables are unchanged.

## Tests (local, one browser at a time)

| Suite | Result |
|---|---|
| Unit and API | 3 539 passed, 0 failed, 19 skipped (PostgreSQL phases, CI) — 142 more than before |
| Integrations regression (new), 5 viewports × 13 | 65 passed, 0 failed — 1440×900; touch 768×1024, 1024×768, 390×844, 360×800 |
| Forms regression, 3 viewports × 42 | 126 passed |
| Workflow end-to-end | 65/65 desktop, 65/65 at 768×1024 |
| Job workflow check | 44/44 desktop, 44/44 at 768×1024 |
| Tablet parity audit, six shapes | 6 × 355/355 |
| Smoke | 268/268 |
| Responsive | 123/123 · Routes 33/33 · Tablet PDF 18/18 · Interaction 7/7 · Update notice: all passed |
| Typecheck, lint, build | clean (the two Turbopack warnings are the existing ones in `file-storage.ts`) |

Three browser scripts assumed the current month had several days and failed on
1 November (1 day so far): the smoke timesheet step, the forms regression's
timesheet and attendance checks, and the tablet interaction timesheet step.
They now name their range in the address. That was a test defect, not an
application one.

PostgreSQL behaviour of 0042 (`integrations.db.test.ts`) and rollback
compatibility: CI only (no local PostgreSQL).

## Not done here, and why

- No real Microsoft 365, Meta or Google account exists yet: nothing has been
  sent to or asked of a real provider. Each integration shows Not configured on
  a real deployment until its settings are on the server.
- The office's existing WhatsApp number: nothing connects it. Coexistence in
  South Africa is unconfirmed (`docs/integrations-setup.md` §1); the owner
  decides.
- Keeping office-verified coordinates beyond Google's 30-day caching term is a
  terms question for the owner (`docs/integrations-setup.md` §4.6).
- Unsigned delivery (BD-06) and the Finance package still send directly, as
  before; only the signed job card moved to the outbox.

## Fixed after the first CI runs (commits `93be012`, `42e71fc`)

The PostgreSQL suite (CI only) found, on `19e4356`:

- **A real defect.** PostgreSQL keeps one delivery-attempt row per attempt, so
  an email that was only queued, or held for the office, read back on the job
  as "not sent yet". An attempt is now counted when it begins (queuing starts
  attempt n+1; the first send's outcome updates it; later automatic attempts
  are new rows), which also keeps the attempts of jobs issued before the outbox.
- Two retries at the same moment: the second is now refused (it returned the
  first one's email as its own).
- Test fixtures: the shared site inserts named the 0042 columns on a database
  deliberately held at 0029 (the upgrade test) — two inserts, fixed in two
  commits; one 0042 test used a site with no address.

## Release record — DEPLOYED 1 November 2026: `42e71fc`

- CI run 41290579780 on `42e71fc`: success, every job and step green,
  including the PostgreSQL tests and rollback compatibility (live `c68b3c3`
  against a database at 0042).
- Read-only check passed (`srv2000625`, 181 072 MB free, script SHA-256
  `5ab56162…b3c6`).
- Release `-ExpectPending 0042_integrations`. Backup proven
  `/var/backups/eje/eje-eje_production-2026-11-01T09-21-08Z`; 0042 applied;
  switched 09:21:21Z; healthy 09:21:23Z. Rollback target `c68b3c3`.
- Public health: `42e71fc`, ok, PostgreSQL reachable, email `refuse`; the
  update notice is served.

## Live verification (read-only)

| Check | Result |
|---|---|
| Integrations (`live-integrations`), API + screens at 1440×900, 768×1024, 390×844 | 32 of 32. All three integrations say Not configured; no credential-shaped value in the status; technician refused (status, templates, history); the Coordinator sees the Master's five templates; preview fills sample values; webhook refuses a wrong token (403) and an unsigned POST (503); pins entered before 0042 read as verified; the new screens render with no sideways scroll and no page errors |
| Critical workflows from 31 October (`live-critical`), three sizes | 46 of 48: every functional check passed. The two other lines: the script's expected-commit variable was not set (the health it printed is `42e71fc`, ok), and the audited reads it lists (see below) |
| Records | open list 64, closed 16, signed 39, issued 26 — identical before and after the release (the live site had moved on since 31 October; this is the new baseline) |
| Issued job cards EJE-2050, EJE-2046, EJE-2041, EJE-2001 | byte-identical before and after, and to 31 October |

What the verification itself left on the live site: the five shipped email
templates were created by the first template listing (system configuration,
as designed; they would have been created by the first signed job card);
viewing EJE-2050's stored job card and previewing EJE-2078's job card added
audited view entries to their activity trails. No job, customer, site,
timesheet, attendance or user record was created or changed; no email or
WhatsApp message was sent (none can be: nothing is configured).

Two live-check selectors were corrected (an exact "Cancel" — EJE-2078 had moved
to completion on the live site, which shows "Cancel completion"; and a named
timesheet range, for the 1st of the month).

Not verified live: the server's journal was not read (no credential exists on
the server to leak); the background worker's start was proven locally, not
observed on the server.
