# EJE Master Scope — living requirements register

**Authority.** The business scope of record is
`EJE_Master_Scope_and_Audit_Baseline_v2.docx` (v2.0, 24 September 2026) plus the
confirmed change register below. **This file is the repository's half of that
contract**: it carries a status and an implementing commit for every
requirement, and it is updated in the same commit as the code it describes.

Nothing is ever deleted from this file. A completed requirement stays, marked
**DONE**. A changed requirement keeps its original wording under *Superseded*
so the history of the decision survives.

Statuses: **DONE** · **PARTIAL** · **NOT IMPLEMENTED** · **UNVERIFIED** ·
**BLOCKED** · **FAIL** (implemented, but contradicts the scope).

---

## Change register

Business-rule changes confirmed after v2.0. Each one records what it replaced.

### CR-01 — A customer-signed job card is legally final
*Confirmed 24 September 2026. Implemented `c29dc1b`.*

Once the customer has signed, nothing on the job card may be edited — not by a
Master, not by a Coordinator, not by the technician who did the work. No reopen
path may exist. If a correction is ever required it must be a separate,
separately auditable mechanism that preserves the original record rather than
modifying it (**IMMUT-9**, not yet specified — see *Open business decisions*).

**A refusal is not a finalization.** A refused job card is unsigned and remains
the office's to correct and resubmit under exactly two outcomes: Customer
Signature, or Without Customer Signature.

> **Superseded — v2.0 §7:** *"Master edit of a closed job reopens it and
> requires resubmission."*
> **Superseded — v2.0 §14:** *"Master may review/edit without silently
> replacing signature."* The Master's review right is narrowed to **review and
> issue**; the edit right applies only to an unsigned (refused) job card.

**Implementation note.** No new status was invented. A signature and a refusal
both land at `review`; they differ by `job.signature`, and that field is the
rule. `isFinalized()` in `src/domain/job/workflow.ts` is the single predicate.

### CR-02 — Offline-first is an acceptance requirement
*Confirmed 24 September 2026. NOT IMPLEMENTED.*

v2.0 §18 is promoted from an aspiration to acceptance-critical. The complete
field workflow must survive connectivity loss, device closure and battery loss.
v2.0 §26's exclusion of a **native** Android/iOS application is retained
unchanged.

### CR-03 — Installable PWA on rugged Android tablets
*Confirmed 24 September 2026. NOT IMPLEMENTED.*

Extends v2.0 §20, which already names IndexedDB and a PWA service worker.
Installable to the home screen, standalone operation, camera access, touch UI,
recovery after interruption. A native application remains out of scope for V1.

---

## Requirement register

### Finalized-job immutability (CR-01)

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| IMMUT-1 | The signed record is final | **DONE** | `c29dc1b` | `isFinalized()`; `signed-job-immutability.test.ts` |
| IMMUT-2 | No Master may edit | **DONE** | `c29dc1b` | refusal test, all mutations |
| IMMUT-3 | No Coordinator may edit | **DONE** | `c29dc1b` | refusal test |
| IMMUT-4 | No Technician may edit | **DONE** | `c29dc1b` | refusal test |
| IMMUT-5 | No reopen path exists | **DONE** | `c29dc1b` | no reopen operation; `canEditJobRecord` false for signed/issued/closed |
| IMMUT-6 | Original PDF unchanged | **DONE** | `0002` | `final_documents_immutable` trigger |
| IMMUT-7 | Signature, labour, travel, parts, charges, checklist, notes, media unchanged | **DONE** | `0002` + `0007` | six new triggers + column guard on `jobs`; proven at SQLSTATE `23001` |
| IMMUT-8 | Audit history immutable | **DONE** | `0002` | `audit_events_append_only` |
| IMMUT-9 | Addendum mechanism for later corrections | **NOT IMPLEMENTED** | — | **Business decision required** |

### Customer-refused-to-sign workflow

| ID | Requirement | Status | Commit |
|---|---|---|---|
| REF-1 | Technician records the refusal | **DONE** | pre-existing |
| REF-2 | Refusal reason required | **DONE** | pre-existing |
| REF-3 | Job moves to office review | **DONE** | pre-existing |
| REF-4 | **Both** Master and Coordinator notified | **DONE** | `d979aa9` |
| REF-5 | Office may review the job card | **DONE** | pre-existing |
| REF-6 | Office may correct the **unsigned** card | **DONE** | `c29dc1b` — held open deliberately by CR-01 |
| REF-7 | Resubmit → Customer Signature | **DONE** | `returnToCustomerSignature` |
| REF-8 | Resubmit → Without Customer Signature | **DONE** | `resolveSignatureRefusal` |
| REF-9 | Final submission/closure/delivery stays Master-controlled | **DONE** | `d979aa9` — `jobs.issueFinal` |
| REF-10 | The refusal workflow never modifies a signed record | **DONE** | `c29dc1b` |

### Roles, calendar, notifications (completed earlier — retained)

| ID | Requirement | Status | Commit |
|---|---|---|---|
| CAL-1 | Technicians can view the Calendar | **DONE** | `d979aa9` |
| CAL-2 | Calendar scoped by role | **DONE** | `d979aa9` |
| CAL-3 | Day/Week/Month/Year views | **DONE** | pre-existing |
| AVAIL-1 | Coordinator manages availability | **DONE** | `d979aa9` |
| AVAIL-2 | Technicians cannot write the leave register | **DONE** | `d979aa9` |
| NOTIF-1 | Coordinator receives operational notifications | **DONE** | `d979aa9` |
| MSG-1 | "The office" is Master + Coordinator | **DONE** | `d979aa9` |
| SEC-1 | Technicians cannot access customer correspondence | **DONE** | `d979aa9` |
| EMAIL-1 | Only the final Master submission emails the customer | **DONE** | `d979aa9` |
| CHK-1 | Installation/Service checklists mandatory | **DONE** | pre-existing |
| CHK-HIST | Exact historical checklist version retrieved | **DONE** | pre-existing |
| COST-8 | Pricing snapshots frozen | **DONE** | pre-existing |
| TRANS-1..4 | Transfers | **DONE** | pre-existing |
| DEMO-1..4 | Demo users, switcher, idempotent seed | **DONE** | `202e1fe`, `95e9848` |
| DEMO-5 | Seed demonstrates the office review queue | **DONE** | `c29dc1b` — EJE-2025 signed, EJE-2026 refused |

### Offline and tablet (CR-02, CR-03) — none implemented

| ID | Requirement | Status |
|---|---|---|
| OFF-1 | Durable local storage for active work | **NOT IMPLEMENTED** |
| OFF-2 | Offline job work: notes, labour, travel, parts | **NOT IMPLEMENTED** |
| OFF-3 | Offline photos and video | **NOT IMPLEMENTED** |
| OFF-4 | Offline checklists | **NOT IMPLEMENTED** |
| OFF-5 | Offline signature **and refusal** capture | **NOT IMPLEMENTED** |
| OFF-6 | Queued mutations survive browser/device closure | **NOT IMPLEMENTED** |
| OFF-7 | Upload retry and resume | **NOT IMPLEMENTED** |
| OFF-8 | Sync states: synced / saved locally / syncing / waiting / action required | **NOT IMPLEMENTED** |
| OFF-9 | Conflict detection; never a silent overwrite | **NOT IMPLEMENTED** |
| PWA-1 | Installable to the tablet home screen | **NOT IMPLEMENTED** |
| PWA-2 | Standalone app-like operation | **NOT IMPLEMENTED** |
| PWA-3 | Camera / gallery access | **NOT IMPLEMENTED** |
| PWA-4 | Recovery after interruption | **NOT IMPLEMENTED** |
| UX-1 | Rugged-tablet touch usability | **UNVERIFIED** — no responsive or touch tests exist |

### Remaining workflow and data gaps

| ID | Requirement | Status |
|---|---|---|
| MEDIA-1 | Customer-facing vs Internal classification | **NOT IMPLEMENTED** — no column on `job_media` |
| MEDIA-2 | Only customer-facing media in the customer PDF | **BLOCKED** by MEDIA-1 |
| MEDIA-5 | Video capture | **PARTIAL** — type only, no capture path |
| EMAIL-2 | Microsoft 365 / Graph adapter | **NOT IMPLEMENTED** — simulated only |
| DRAFT-1 | Draft jobs, Master-only | **NOT IMPLEMENTED** — creation always `open` |
| SPARE-2 | Spares: description, notes, photo, request date | **PARTIAL** — only `awaiting_spares_reason` |
| CUST-CR | Customer change requests | **NOT IMPLEMENTED** |
| MACH-HIST | Machine location history | **NOT IMPLEMENTED** |
| COST-5 | Additional charges and discounts | **NOT IMPLEMENTED** |
| AUDIT-2 | Structured before/after values | **PARTIAL** — narrative detail only |
| SEARCH-4 | CSV / Excel export | **NOT IMPLEMENTED** |
| LIB-5 | Full-text PDF search / OCR | **NOT IMPLEMENTED** |
| BACKUP-1 | Database **and files** backed up | **PARTIAL** — `pg_dump` documented; storage not covered |
| BACKUP-2 | Encrypted, integrity-verified, restore-tested | **NOT IMPLEMENTED** |
| IDEM-2 | Duplicate acceptance / submission tested | **PARTIAL** — mechanism present, untested |
| ARCH-6 | CI pipeline | **NOT IMPLEMENTED** |

---

## Open business decisions

| ID | Question | Blocks |
|---|---|---|
| **BD-02** | What is the post-signature correction/addendum mechanism (IMMUT-9)? Until it exists, a genuine error on a signed job card has **no remedy at all**. | IMMUT-9 |
| **BD-03** | `jobs.editSubmittedJob` now applies only to refused cards. Re-scope its name, or retire it? | cosmetic |
| **BD-04** | v2.0 §6 says the Order Number is mandatory; the code implements the three-valued DECISION 2 waiver. Which stands? | JOB-5 |
| **BD-05** | v2.0 §20 specifies Redis queues; the implementation uses a durable PostgreSQL outbox. Accept the substitution, or build Redis? | ARCH-2 |

---

## Retired behaviour, kept readable

`master_amended_after_signature` remains in `ActivityEventType` and nothing can
produce it. Jobs amended under the pre-CR-01 rule carry it, and v2.0 §17 asks
that historical records stay traceable — so the type is retired, not deleted.
`line-editing.test.ts` holds it unreachable.
