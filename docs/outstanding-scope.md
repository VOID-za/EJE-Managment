# What is actually left, 20 October 2026

> **Updated later the same day** by the October implementation mandate. Two
> items moved off this list — demonstration labelling (§1) and customer
> attachments (§4) — and the library gained the five categories EJE asked for.
> See `docs/demonstration-data.md` for the classification record and the batch
> section in `docs/SCOPE.md` for the evidence. The two are tracked as
> [#58](https://github.com/VOID-za/EJE-Managment/issues/58) (DEMO-1) and
> [#59](https://github.com/VOID-za/EJE-Managment/issues/59) (CUST-DOC-1).
> Everything still listed below stands.

A classification of the outstanding scope, made by reading the implementation
against `docs/SCOPE.md` and the 57 open issues, and by running every gate the
repository has against this tree. It exists because "what is left" had become
three different answers depending on which document you read.

**Nothing here is approved.** Everything marked *tested* awaits the owner's
sign-off, as PROC-4 requires, and *pushed is not deployed*.

Four categories, and the difference between them is who has to act:

| Category | Who acts |
|---|---|
| **DEFECT** | Us. Something does not work as the scope says it does. |
| **NOT BUILT** | Us, once the rules are settled. A requirement with no implementation. |
| **DECISION** | EJE. A business question no implementation may answer. |
| **AWAITING APPROVAL** | EJE. Built and tested; needs sign-off, not work. |

---

## Defects found and fixed in this pass

All three were in document durability and backup validation, and all three had
been invisible because the checks that should have caught them were themselves
wrong.

| What | Where | Fixed in |
|---|---|---|
| `final_documents.size_bytes` and `.checksum_sha256` were never written — every live row read 0 with no checksum — while the schema said the checksum was "verified on every read" | `job-repository.ts`, `job.ts` | `49e79b4` |
| Stored documents were written with `writeFile` (no fsync, not atomic) and nothing verified the bytes on the way out | `file-storage.ts` | `5de49a6` |
| The restore test compared a storage key against unpacked FILE NAMES, so every reference read as a missing document — the "25 missing" an operator saw — and the only way to pass was a flag that accepted every missing document silently | `restore-test.ts` | `36623b1` |
| The backup tests' fixture wrote files at the key itself, a shape the store never produces: it matched the broken comparison exactly, so the tests passed while the real check could not resolve a single document | `backup.db.test.ts` | `8197f78` |

No further implementation defect was confirmed in this pass. That is a
statement about what was examined — the document, storage and backup paths were
read line by line; the rest rests on 2 309 unit and route tests, 267
PostgreSQL-backed tests, and the browser suites, all green on this tree.

## Built since this document was written

| What | Where | Status |
|---|---|---|
| **Demonstration records say so** — recorded provenance on library documents, revisions, machine photographs and issued job cards; the badge in lists, the notice on detail views, and a stamp on every page of a demonstration PDF | `f38d46b`, `6d8d33b`, `30c4f03` | TESTED — awaiting approval |
| **Invented file facts removed** — four places asserted sizes and page counts for files that do not exist; a size is now measured or zero, and a record with nothing stored offers no download | same | TESTED — awaiting approval |
| **Customer documents** — the register carried no files at all; `customer_documents`, the office-only routes, the panel, and real bytes proved in a browser | `27a1b53`, `30c4f03` | TESTED — awaiting approval |
| **The library's missing categories** — checklist, training document, internal company procedure, form and certificate | `f38d46b` | TESTED — awaiting approval |
| **A customer document is withdrawn, never deleted** — the row and the bytes stay; nothing in this application removes a document's bytes | `0140034` | TESTED — awaiting approval |
| **The OCR investigation** — the local option costed against the hosted one, with a recommendation to count before choosing | `0140034`, `docs/library-ocr.md` | INVESTIGATED, not implemented (#26) |

## Not built

| ID | What | Why it is not merely "to do" |
|---|---|---|
| **DRAFT-1** (#21) | Draft jobs, Master-only. Creation always produces `open`. | Needs two rules from EJE before it can be built honestly: what a draft may leave blank (today every required field is required at creation), and whether releasing one re-validates against the rates of the release day or the drafting day. |
| **COST-5** (#24) | Additional charges and discounts. | Needs the rules: who may discount, against what authority, and whether a discount is a line or a total adjustment — each prints differently on the customer's document. |
| **MEDIA-5** (#18) | Video capture. Type only; no capture path. | The simulated *Add video* button was removed rather than left pretending. Storage, size limits and what a video does to a job card's attachment limit are unanswered. |
| **LIB-5** (#26) | Full-text PDF search / OCR in the library. | Partial: a scanned document says it is not searchable, and why, with a retry. OCR is now **costed** — `docs/library-ocr.md` — and the decision is EJE's: Tesseract on the VPS at 5–15 seconds per page behind a background job, or a hosted service at about US$1–1.50 per 1 000 pages that takes EJE's own documents off the premises. The recommendation is to count the unsearchable documents first, because on a real library the number may be nil. |
| **MACH-HIST** (#28) | Machine location history. | Deliberately not invented. See DECISION below. |
| **IMMUT-9** (#20) | Addendum mechanism for post-signature corrections. | Blocked on BD-02. |

## Decisions only EJE can make

These block real work. Each one has an issue; none may be answered by
implementation.

| ID | Question | What it blocks |
|---|---|---|
| **BD-02** (#34) | What is the post-signature correction/addendum mechanism? | IMMUT-9, and **AUD-3** (#29): a signed job card with a genuine error has no remedy at any layer. Marked an acceptance blocker. |
| **BD-06** (#33) | Does closing *Without Customer Signature* email the customer their copy, and under whose authority? | DELIV-7 (#19), and **AUD-4** (#30): closing without a signature sends the customer nothing. Acceptance blocker. |
| **BD-17** (#56) | May the issued prices be exported, and by whom? | The closed-job CSV carries no money columns — current behaviour, not an answer. |
| **BD-18** (#57) | Is a spreadsheet export recorded on the audit trail? | The mechanism exists and writes nothing (`EXPORT_AUDIT.recording = false`). |
| **MACH-HIST** (#28) | Do EJE record a machine's moves, and what should a job screen then show? | Machine history, and whether a change request may apply itself. |
| **CUST-CR** (#27) | Who raises a CUSTOMER's change request to a JOB, what may it change, what does it do to a job in progress? | The job-change half of CUST-CR. The register half is built. |
| **BD-04** (#35) | Is the order number mandatory, or is the DECISION 2 waiver correct? | JOB-5. |
| **BD-05** (#36) | Accept the PostgreSQL outbox in place of v2.0's Redis queues? | ARCH-2. Nothing is waiting on it in practice. |
| **BD-11** (#37) | An explicit "cannot submit" state for an unreachable technician? | TAKEOVER-1's condition. |
| **BD-03** (#38), **BD-08** (#39), **BD-10** (#40) | Naming and visibility questions. | Cosmetic. |

## By the areas asked about

**Customer and machine administration** — built and tested. The register is
internally consistent (a machine cannot stand at another customer's site),
concurrent amendments cannot overwrite each other on PostgreSQL, and archiving
is a withdrawal rather than a delete. Outstanding: MACH-HIST (decision).

**User administration** — built and tested, including who may create whom (a
Coordinator may add a Technician and nothing else; only a Master may add a
Master). Exercised again on PostgreSQL in this pass.

**Draft-job release** — NOT BUILT. See above.

**Customer change requests and post-signature corrections** — the register half
of CUST-CR is built (a technician reports a wrong record, the office records
what it did, nothing applies itself). The job-change half and the whole of
post-signature correction are decisions.

**Document library search and file handling** — file handling is built: stored
files open, a pending revision cannot be fetched by a technician, a scanned
document says it is not searchable. OCR is NOT BUILT.

**Machine photographs and checklist evidence** — built, stored, served back and
proved byte-for-byte in a browser (#46, #45, #53). Awaiting approval.

**CSV/Excel exports and audit requirements** — the export is built (#25);
whether it may carry prices and whether it is audited are decisions (#56, #57).

**Outbox delivery and notification behaviour** — the outbox is durable, every
attempt is recorded with what the provider said, and a failure says whether a
retry can work. **MANDATE-3 stays PARTIAL because no message has reached a real
mailbox from this codebase** — there is no Microsoft 365 tenant and no Meta
token. `npm run integrations:check` is what proves them the day they arrive.

## Awaiting approval, not work

41 of the 57 open issues are `status:TESTING` — built, tested, waiting for EJE.
Closing them is the owner's act, not ours (`docs/project-tracking.md`). The
acceptance blockers among them are **ARCH-6** (#22, CI, now green on every
push) and the two that are really decisions, AUD-3 and AUD-4.

## Things that cannot be settled in this repository at all

- **A live Microsoft 365 tenant and a Meta token with approved templates.**
  Until then `/api/health` reports `"email":"refuse"` on the live deployment,
  which is the honest answer and not a defect.
- **Tablet acceptance on the real rugged device** (OFF-13, UX-1 #17). Every
  screen is measured at tablet and phone width by `npm run responsive-check`,
  which is not the same thing as a gloved hand on a Samsung Tab Active.
- **An off-site backup destination.** The repository-side support exists; the
  bucket, the credentials or the disk do not. See `docs/vps-backups.md`.
