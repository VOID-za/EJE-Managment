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
*Confirmed 24 September 2026. Implemented `947ef4f`.*

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

### CR-04 — The refusal review belongs to the office, and has exactly two ends
*Confirmed 24 September 2026. Implemented `b4e6140` (see REF-11…REF-18).*

Three defects found in VPS acceptance testing all came from the same unstated
rule. Confirming it settles all three.

**(a) The technician is read-only from the moment the refusal is submitted.**
Recording the refusal is the technician's last act on that job card. From then
on the technician may **view** the card and the refusal information and nothing
else: no edit, no return-for-signature, no second signature attempt, no
resolution, no resubmission, and no choice of either outcome. The card is the
office's.

**(b) The office review has exactly two outcomes, and no third.**

| | Outcome | Result |
|---|---|---|
| **A** | **Customer Signature** | The card returns to the customer-signature step and then follows the normal route — signature, review, final Master submission, closure. |
| **B** | **Without Customer Signature** | The refusal is resolved and the job is **CLOSED immediately**. No customer-signature step follows, no review step follows, no Capture Signature button is offered, no return-for-signature action remains. The final state is `closed`. |

**(c) Both outcomes are real state transitions.** Outcome A is
`review → customer_signature`, not `customer_signature → customer_signature`.
Outcome B is `review → closed`, not "resolve the refusal and leave the job
where it was". A job whose refusal is resolved without a signature is finished,
and the state machine must say so.

> **Superseded — the implementation as at `83b6754`:** outcome B resolved the
> refusal, left the job at `review`, and expected a separate `issueJobCard` and
> a delivery confirmation to close it — so the card still advertised "5 Review /
> 6 Closed" and a Capture Signature button after the office had decided it would
> never be signed. Outcome A was reachable from `customer_signature`, a state a
> refusal never produces.

**Unchanged by this.** CR-01 stands in full: once the customer has signed,
nothing may be edited and there is no reopen path. CR-04 governs the **unsigned**
card only.

### CR-05 — The roles are three different journeys, not one with switches
*Confirmed 25 September 2026. Implemented `901e579` (see ROLE-1…ROLE-6,
REV-1, PDF-1, WRITEUP-1, DOC-1, LAB-1, COST-CALLOUT).*

A second round of VPS acceptance testing found the refusal rules leaking into
the ordinary signed workflow and back. Each defect below was one journey's rule
applied to another's, so they are settled together.

**(a) The technician keeps the whole NORMAL workflow.** Accept, capture, write
up, review, take the customer's signature, hand over. CR-04(a)'s read-only rule
applies to a **refused** job card and to nothing else. It was applied to the
status instead, so a technician who had just taken a signature was left with no
action at all on their own job — *"now i went back page… now i cant do anything
as a tech"*.

**(b) The Coordinator's extra authority is the REFUSAL and only the refusal.**
She was being offered *Review & submit job card* on ordinary signed jobs and
*Accept job* on field work, both of which the server then refused. She does not
get the final submission (`jobs.issueFinal` stays with the Master, §3.1/§15) and
she does not accept field work (`jobs.acceptField`, which she has never held).
The Parts exception is unchanged: a parts collection happens at the EJE counter
and the office does process it, under `jobs.processParts`.

**(c) The screen and the server must give the same answer.** Every rule above
is enforced in the application layer and *then* reflected in what is drawn. A
button that exists only to be refused is a defect, and so is a rule enforced
only by hiding a button.

> **Superseded — the implementation as at `3f2ef5b`:** the action bar applied
> the refusal read-only rule to the STATUS rather than to the refusal, so it
> withheld every action from a technician at `review` on a signed job card too;
> `canAcceptJob` was never told the viewer's role, so the screen offered a
> Coordinator work the server would refuse; and the Review action read *Review
> & submit job card* for every office role, not only the Master.
>
> `canEditJob` itself is unchanged and stays capability-gated at `review`: a
> signed job card is final for everyone under CR-01, and a refused one is the
> office's under CR-04, so neither is a technician's to edit. What changed is
> that having no EDIT right is no longer treated as having no way in.

### CR-06 — Capture-screen and document corrections
*Confirmed 25 September 2026. Implemented `901e579`.*

Six changes to what is asked for and what is printed. None of them changes a
price, a permission or a state.

| | Change | Why |
|---|---|---|
| **(a)** | The completion write-up **autosaves** | A tablet that locks, runs out of battery or is handed to a customer must not cost the technician a paragraph. Explicit *Save now* and *Discard* both remain, because both still mean something. |
| **(b)** | Empty write-up sections are **not printed** | A heading with nothing under it reads as something forgotten. Work performed is mandatory, so it is always there. |
| **(c)** | Labour drops *Description of work* | It asked the technician to describe the job twice, in two places, on one document. The write-up is the formal technical record. |
| **(d)** | Call-out fee moves **under Parts** | It is the last commercial decision on a job and belongs beside the other charge the office adds. Per-job, never inferred from the job type — unchanged. |
| **(e)** | The wizard's **Review step drops the PDF preview** | Review is a verification summary; on a tablet the document buried the thing being verified. |
| **(f)** | The **Signed step keeps** its preview, at A4 proportions | It is the one place the document is wanted. The frame was a 60vh letterbox holding a portrait page, so the viewer squeezed it. |

The labour **field** is not removed from the record: lines captured before this
keep what was written on them, and the document still prints it.

---

## Requirement register

### Finalized-job immutability (CR-01)

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| IMMUT-1 | The signed record is final | **DONE** | `947ef4f` | `isFinalized()`; `signed-job-immutability.test.ts` |
| IMMUT-2 | No Master may edit | **DONE** | `947ef4f` | refusal test, all mutations |
| IMMUT-3 | No Coordinator may edit | **DONE** | `947ef4f` | refusal test |
| IMMUT-4 | No Technician may edit | **DONE** | `947ef4f` | refusal test |
| IMMUT-5 | No reopen path exists | **DONE** | `947ef4f` | no reopen operation; `canEditJobRecord` false for signed/issued/closed |
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
| REF-6 | Office may correct the **unsigned** card | **DONE** | `947ef4f` — held open deliberately by CR-01 |
| REF-7 | Resubmit → Customer Signature | **DONE** | `returnToCustomerSignature` — corrected by REF-13 |
| REF-8 | Resubmit → Without Customer Signature | **DONE** | `resolveSignatureRefusal` — corrected by REF-14 |
| REF-9 | Final submission/closure/delivery stays Master-controlled | **DONE** | `d979aa9` — `jobs.issueFinal` |
| REF-10 | The refusal workflow never modifies a signed record | **DONE** | `947ef4f` |

#### CR-04 — office ownership and the two outcomes

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| REF-11 | The technician may submit the refusal, and may still **read** the job card and refusal afterwards | **DONE** | `b4e6140` | `refusal-review-roles.test.ts` |
| REF-12 | The technician is **read-only** from that moment: no edit, no return for signature, no signature capture, no resolution, no resubmission — refused server-side, not merely hidden | **DONE** | `b4e6140` | `canEditJob` at `review` now asks `jobs.editSubmittedJob`; `refusal-review-roles.test.ts`, `signed-job-immutability.test.ts` |
| REF-13 | Outcome A is the transition `review → customer_signature`, and is rejected from any other state | **DONE** | `b4e6140` | `returnToCustomerSignature` status guard; `refusal-review-roles.test.ts` |
| REF-14 | Outcome B is the transition `review → closed`, applied in one act | **DONE** | `b4e6140` | `resolveSignatureRefusal` now calls `transition(job, 'closed')`; `signature-refusal.test.ts` |
| REF-15 | After outcome B the job offers **no** signature step, review step, Capture Signature button, return-for-signature action or further resolution — to any role | **DONE** | `b4e6140` | `refusal-review-roles.test.ts`; `JobActionBar.tsx` |
| REF-16 | Outcome B still produces the unsigned customer document, stored and immutable | **DONE** | `b4e6140` | `renderAndStoreFinalDocument`; `refusal-document.test.ts` (12 cases) |
| REF-17 | `customer_signature → customer_signature`, `closed → customer_signature`, `closed → review` and `closed → any editable state` are all illegal | **DONE** | `b4e6140` | `progress.test.ts` |
| REF-18 | The seed demonstrates the refusal review from a state the application can actually produce | **DONE** | `b4e6140` | EJE-2018 seeded at `review`, not `customer_signature` |
| REF-19 | The two outcomes are named on screen exactly as the business names them — **Customer Signature** and **Without Customer Signature** | **DONE** | `901e579` | `SignatureRefusalPanel.tsx`; `workflow-e2e.mjs` |
| REF-20 | A job closed without a signature says so: the document card reads *Issued without a customer signature*, never *Final signed job card* | **DONE** | `901e579` | `FinalDocumentCard.tsx`; `workflow-e2e.mjs` |
| REF-21 | The refusal record shows reason, recorded by, recorded at, outcome, resolved by, resolved at | **DONE** | pre-existing + `901e579` | `SignatureRefusalPanel.tsx`; `workflow-role-matrix.test.ts` |

### CR-05 — the role matrix, enforced on the server and drawn on the screen

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| ROLE-1 | The technician keeps the whole normal workflow: accept, capture, write up, review, signature, hand over | **DONE** | `901e579` | `workflow-role-matrix.test.ts` A, E |
| ROLE-2 | A technician at Review on a **signed** job has an action and is not stranded | **DONE** | `901e579` | `JobActionBar.tsx`; `workflow-e2e.mjs` |
| ROLE-3 | A technician is read-only on a **refused** job card, and sees no action on it at all | **DONE** | `b4e6140` + `901e579` | `workflow-role-matrix.test.ts` B; `workflow-e2e.mjs` |
| ROLE-4 | The Coordinator gets **no** generic Review & submit on an ordinary signed job | **DONE** | `901e579` | `JobActionBar.tsx`, review page; `workflow-role-matrix.test.ts` D; `workflow-e2e.mjs` |
| ROLE-5 | The Coordinator is **not** offered Accept on field work, and is refused it if she asks. The Parts exception is preserved | **DONE** | `901e579` | `canAcceptJob`; `job-creation-assignment.test.ts`; `workflow-e2e.mjs` |
| ROLE-6 | The final submission stays the Master's; the screen and the server agree on that for every role | **DONE** | `d979aa9` + `901e579` | `jobs.issueFinal`; `workflow-role-matrix.test.ts` |
| ROLE-7 | Every rule above is enforced in the application layer first; the UI only reflects it | **DONE** | `901e579` | every negative case in `workflow-role-matrix.test.ts` is an operation refusing, not a button missing |

### CR-06 — capture screen and customer document

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| WRITEUP-1 | The completion write-up autosaves: debounced, a ceiling for continuous typing, one write at a time, the text survives a failed save | **DONE** | `901e579` | `src/lib/autosave.ts`; `autosave.test.ts` (11 cases); `workflow-e2e.mjs` |
| WRITEUP-2 | Saving/saved/error is shown, and explicit *Save now* and *Discard* are both kept | **DONE** | `901e579` | `CompletionReportPanel.tsx` |
| WRITEUP-3 | Work performed stays mandatory before the customer signs | **DONE** | pre-existing | `checkReadyForSignature` |
| DOC-1 | Empty write-up fields are omitted from the customer document — no empty headings, no "Not recorded" | **DONE** | `901e579` | `write-up-sections.test.ts` (8 cases, model and PDF bytes) |
| LAB-1 | Labour captures hours and a rate; *Description of work* is removed from the UI | **DONE** | `901e579` | `WorkCapturePanel.tsx`; `labour-and-callout.test.ts`; `workflow-e2e.mjs` |
| LAB-2 | Historical labour descriptions are preserved and still printed | **DONE** | `901e579` | `labour-and-callout.test.ts` |
| COST-CALLOUT | The call-out fee sits under Parts, is per-job, is never inferred from the job type, and prices exactly as before | **DONE** | `901e579` | `labour-and-callout.test.ts`; `workflow-e2e.mjs` |
| REV-1 | The wizard's Review step is a summary with **no** embedded PDF | **DONE** | `901e579` | `CompleteJobWizard.tsx`; `workflow-e2e.mjs` |
| REV-2 | The final submission page keeps its presentation | **DONE** | unchanged | review page; only the card's wording for a non-submitter changed |
| PDF-1 | The Signed step keeps the PDF preview, at A4 proportions and inside the viewport | **DONE** | `901e579` | `JobCardPdfPreview.tsx`; `workflow-e2e.mjs` measures the frame |
| PDF-2 | Document GENERATION is untouched by the viewer change | **DONE** | unchanged | `final-document-pixels.browser.test.ts`, `final-document-layout.test.ts` still pass |

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
| DEMO-5 | Seed demonstrates the office review queue | **DONE** | `947ef4f` — EJE-2025 signed, EJE-2026 refused; EJE-2018 corrected to `review` in `b4e6140` (REF-18) |

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
| **BD-06** | Outcome B closes the job without **emailing** the unsigned copy to the customer. The old route emailed, because it went through `issueJobCard`; §15 puts customer delivery after the final **Master** submission, and outcome B is open to a Coordinator. Should closing without a signature send the customer their copy, and if so, under whose authority? The document is rendered, stored and downloadable either way. | REF-16 |
| **BD-07** | ~~After outcome A returns the card to `customer_signature`, **who** captures the signature?~~ **ANSWERED 25 September 2026 by CR-05(a).** The read-only rule is about a REFUSED job card, not about the technician. Once outcome A returns the card to the signature step there is no outstanding refusal, so the ordinary signature workflow resumes and the technician captures it exactly as they would have the first time. Held as ROLE-1 and proved end to end in `workflow-e2e.mjs`. | closed |
| **BD-08** | Should a technician be able to see that a colleague is *editing* a job card they handed over, or is "with the office" enough? Raised by CR-05(a): the technician now has a way back INTO a signed job card and may find it changed under them. | cosmetic |

---

## Retired behaviour, kept readable

`master_amended_after_signature` remains in `ActivityEventType` and nothing can
produce it. Jobs amended under the pre-CR-01 rule carry it, and v2.0 §17 asks
that historical records stay traceable — so the type is retired, not deleted.
`line-editing.test.ts` holds it unreachable.
