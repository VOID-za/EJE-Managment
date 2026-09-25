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

*Added 25 September 2026 by CR-10:* **DEFINED** — agreed and specified here,
deliberately not yet built. A batch may be scoped before it is built (CR-09 is),
and "NOT IMPLEMENTED" alone could not tell an agreed, specified batch apart from
a gap nobody has decided about yet.

### How this document is maintained

| ID | Rule | Added |
|---|---|---|
| PROC-1 | **An implementation batch is not complete until this file is updated in the same batch.** The code and the register move together; a commit that changes behaviour without changing the requirement it implements is an incomplete batch, not a finished one | 25 Sep 2026, CR-10 |
| PROC-2 | **Nothing is ever deleted.** A completed requirement stays, marked DONE with its evidence. A changed requirement keeps its original wording and gains a dated amendment or a **SUPERSEDED** marker beneath it. A question that implementation has overtaken stays until the business answers it | 25 Sep 2026, CR-10 (restating the rule this file has always followed) |
| PROC-3 | **Everything gets an ID.** A new requirement, a correction, a decision, an exception, an architectural constraint or a business rule is not recorded until it carries an identifier this document can be searched by | 25 Sep 2026, CR-10 |
| PROC-4 | **A decision is never made by implementation.** Anything the business has not answered is carried in *Open business decisions* with its options and the status **OPEN**, whatever the code currently happens to do | 25 Sep 2026, CR-10 |
| PROC-5 | **This file describes the system as it is intended to be**, not only the work that has been done. Anything built is recorded here even if it was built before anybody wrote a requirement for it | 25 Sep 2026, CR-10 |

---

## Product mandate

Non-negotiable properties of the delivered system. These are not features to be
traded away in a batch; a release that does not have them is not the system EJE
asked for.

| ID | Mandate | Status | Detail |
|---|---|---|---|
| MANDATE-1 | **THE SYSTEM MUST BE USABLE OFFLINE.** The complete field workflow — reading the job, doing the work, capturing labour, travel, parts and photographs, writing the completion report, running the checklist and taking the customer's signature or recording their refusal — must work with no connectivity at all, and must survive the tablet being closed, locked, dropped or running out of battery. Work captured offline is not lost and is not silently overwritten when the tablet reconnects | **NOT IMPLEMENTED** | CR-02, OFF-1…OFF-13, ACC-OFF-1…ACC-OFF-12 |
| MANDATE-2 | **THE SYSTEM MUST BE INSTALLABLE AS A TABLET APPLICATION.** It is installed to the home screen of a rugged Android tablet from the browser, launches standalone without browser furniture, reaches the camera, updates itself, and recovers after an interruption. A native Android/iOS application remains out of scope (v2.0 §26) — the installable PWA is how this is delivered | **NOT IMPLEMENTED** | CR-03, PWA-1…PWA-8, ACC-PWA-1…ACC-PWA-6 |
| MANDATE-3 | **THE CUSTOMER MUST ACTUALLY RECEIVE THEIR DOCUMENT.** The final submission's purpose is to put the job card in the customer's hands. Until a production email adapter exists, no deployment does that — the send is simulated in every environment | **NOT IMPLEMENTED** | EMAIL-2, CR-09 Phase 1 |

*Recorded 25 September 2026 by CR-10. MANDATE-1 and MANDATE-2 restate CR-02 and
CR-03 as acceptance conditions on the product rather than as entries in a list
of outstanding work, because the audit at `ca1cda7` found them at zero and the
rest of the system complete enough that they are now the whole of what stands
between this and acceptance.*

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
| **A** | **Customer Signature** | The card returns to the customer-signature step and then follows the normal route — signature, then the **technician's** submission, delivery, closure. *(Read "final Master submission" here until CR-07 replaced it on 25 September 2026.)* |
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
get the final submission and she does not accept field work
(`jobs.acceptField`, which she has never held). The Parts exception is
unchanged: a parts collection happens at the EJE counter and the office does
process it, under `jobs.processParts`.

> **Amended by CR-07, 25 September 2026.** This paragraph read "she does not
> get the final submission (`jobs.issueFinal` stays with the Master,
> §3.1/§15)". The boundary it draws around the Coordinator is unchanged and
> still holds; what changed is the other side of it. `jobs.issueFinal` did not
> stay with the Master — it went to the TECHNICIAN, and the Master does not
> have it either.

**(c) The screen and the server must give the same answer.** Every rule above
is enforced in the application layer and *then* reflected in what is drawn. A
button that exists only to be refused is a defect, and so is a rule enforced
only by hiding a button.

> **Superseded — the implementation as at `3f2ef5b`:** the action bar applied
> the refusal read-only rule to the STATUS rather than to the refusal, so it
> withheld every action from a technician at `review` on a signed job card too;
> `canAcceptJob` was never told the viewer's role, so the screen offered a
> Coordinator work the server would refuse; and the Review action read *Review
> & submit job card* for every office role, not only the Master. (CR-07 then
> removed that action from the office entirely.)
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

### CR-07 — The normal signed job card is submitted by its technician
*Confirmed 25 September 2026. Implemented `84d1802` (see SUBMIT-1…SUBMIT-16).*
*This REVERSES a rule confirmed on 24 September 2026 and implemented in
`d979aa9`. It is a business decision, recorded here in full so the reversal is
legible rather than mysterious.*

**The authoritative normal journey.** No office step exists in it at any point:

| | Step | Who |
|---|---|---|
| 1 | Accept the job | Technician |
| 2 | Do the work; capture labour, travel, parts, call-out | Technician |
| 3 | Completion write-up | Technician |
| 4 | Customer signs | Technician takes the signature |
| 5 | Check the signed document | Technician |
| 6 | **Submit the signed job card** | **Technician** |
| 7 | The customer's copy is generated and emailed | the submission does it |
| 8 | Delivery pending | the provider |
| 9 | Delivery confirmed → **CLOSED** | the provider's report |

**The office review is for a REFUSAL, and for nothing else.** CR-04 and CR-05
are unchanged and remain in force: a customer who will not sign puts the job
card with the Master and the Coordinator, the technician becomes read-only, and
the office chooses Customer Signature or Without Customer Signature. After
outcome A the card rejoins the journey above at step 4 and is submitted by the
technician like any other.

> **Superseded — v2.0 §3.1, §7, §15, and CR-05's ROLE-6, implemented
> `d979aa9`:** *"final authority over official job submission/closure and
> customer delivery"* with the Master; *"the final Master submission locks the
> job, creates/stores final PDF, queues customer email and closes it"*; and
> *"only that submission emails the customer."* In practice that made the
> office a mandatory participant in every completed job it had not attended,
> left signed job cards sitting in a queue, and produced on screen: *"Review
> job card… With the office for submission… EJE-2028 is signed and with the
> office. A Master makes the final submission."* All of it is removed, not
> hidden.
>
> **What §15 still governs** is that the customer is emailed ONCE, by the
> submission and by nothing else. That is unchanged; only the person who makes
> it has changed.

**The rule is "whoever attended the machine", not "whoever holds a role".**
`jobs.issueFinal` is the technician's, and that covers every ordinary case. It
is not the whole rule, because **a Master may accept field work** — that has
always been true, and only the Coordinator is kept out of it. A Master who
drove out, did the work and took the customer's signature is the person who
completed that job, and submits it. The rule therefore also admits anybody who
holds `jobs.acceptField` **and is on the job**, which is the same question
acceptance itself asks, so it can never reach a job they did not attend. The
Coordinator cannot reach it at all, because she cannot be on a field job.

*Discovered at implementation: without this a Master could be offered Accept on
a breakdown and then refused the last step of the job he had just done.*

**Two further exceptions, both about somebody not in a normal signed journey.**

- **A parts collection** is handed over at the EJE counter, not on a customer's
  site, so whoever processed it issues it — `jobs.processParts`. Identical in
  shape to the exception `canAcceptJob` and `acceptJobRefusal` already carry.
- **The retired Master Review stage.** Nothing can enter `submitted`; the jobs
  in it entered before it was retired, and a Master is the only person who can
  move them on. There is no technician journey to return them to, and
  stranding a real customer's job card for ever is not an option.

**Signed-job immutability is untouched.** CR-01 stands in full: once the
customer has signed, nothing on the job card may be edited by anyone, and no
reopen path exists. CR-07 changes WHO SUBMITS, not what may be changed.

### CR-08 — One exception: the office may submit for a technician who cannot
*Confirmed 25 September 2026, resolving **BD-09**. Implemented `63ca3c0`
(see TAKEOVER-1…TAKEOVER-14).*

CR-07 gave the final submission to the technician who attended the machine, and
raised BD-09 in the same breath: a job the customer had **already signed**,
whose technician then left EJE or went on leave, had nobody who could send the
customer their copy. It sat finished and unsent. This is the rescue for that,
and nothing else.

**The normal journey is unchanged.** Accept → work → write-up → customer
signature → signed → **technician submits** → customer emailed → delivery
confirmed → closed. On an ordinary signed job the office is offered nothing and
is refused if it asks. CR-07 stands in full.

**What "technician unavailable" means — exactly, from data the office already
maintains.** Nobody on the job who could submit it is available, where a person
is unavailable when either:

| | Condition | Source |
|---|---|---|
| **(a)** | Their **account is disabled** (`User.active === false`) | the user record — they have left EJE, or access was revoked |
| **(b)** | A **whole-day absence covering today** stands on the availability register | `AvailabilityRecord`: `status === 'active'`, `allDay`, `startDate ≤ today ≤ endDate` |

Three things make this safe to hang a permission on:

- **Only a Master writes an availability record.** The type's own docblock says
  so: *"A technician telling the office they have an appointment is a MESSAGE,
  not an availability record — the office decides what goes on the calendar."*
  It is an authoritative, audited act, not a self-service flag.
- **ALL-DAY ONLY.** A part-day absence — the two-hour appointment the data
  models separately with `startTime`/`endTime` — means the technician is at
  work today and will pick the job up. It is not grounds for the office to take
  their submission away from them.
- **EVERYONE on the job is asked, not only the primary.** If a second
  technician who attended is at work, the job is not stuck and the exception
  stays shut.

**What it deliberately does NOT model.** A technician who is at work but cannot
reach the system — a lost or broken tablet. There is no record of that anywhere
in the data, and inventing a flag for it would be exactly the vague client-side
condition the rule exists to avoid. The office's remedy is to put the absence on
the calendar, which is a deliberate, audited act by a Master. *Raised as
**BD-11**.*

**What a takeover is not.**

- **Not a submission right.** It unlocks only on the condition above, decided
  server-side. The screen is told the answer; the operation asks the same
  question again from the same data before it acts.
- **Not the refusal review.** A refused job card is refused outright — it has
  its own workflow, its own two outcomes and its own review, and merging them
  would put the office review back into the signed journey by another name.
  CR-04 and CR-05 are untouched.
- **Not an edit.** The job is signed, so CR-01 has already made it immutable and
  every mutation is already refused. A takeover sends the document that exists
  and changes nothing else.
- **Not a different document.** It runs the same issue path, so the customer
  receives byte-for-byte the document the technician would have sent.

**It is its own capability**, `jobs.takeOverSubmission`, held by Master and
Coordinator — deliberately not `jobs.resolveSignatureRefusal` (that is the
refusal) and deliberately not a loosening of `jobs.issueFinal` (that is the
technician's).

**It is its own audit event**, `submission_taken_over`, recording who took over,
whose job it was, and the grounds. The ordinary `job_submitted` is written too,
because the job card *was* submitted; the two are told apart by type rather than
by reading the wording.

### CR-09 — Customer delivery and production readiness
*Defined 25 September 2026, from the implementation audit at `ca1cda7`.*
***DEFINED — NOT IMPLEMENTED. No code has been written for any phase of this.***

The audit found the office and field workflow complete and enforced, and found
two things standing between it and acceptance that are not defects in what
exists: **the customer is never actually emailed**, and **the offline/tablet
mandate is at zero**. CR-09 is the batch that closes the first and lays the
foundation for the second, in four phases whose order is a dependency order, not
a preference.

**Phase 1 — the customer receives the document.**

| | What | Why it is first |
|---|---|---|
| (a) | A **production email adapter** | Nothing else in the workflow can be accepted while the last step is simulated |
| (b) | The **simulated adapter is kept**, for the demonstration and the tests | The demo must keep working with no mail account, exactly as WhatsApp does |
| (c) | **Success and failure are handled honestly** — an accepted send is not a delivery, a failure is reported and retryable | The existing delivery handshake already works this way and must not be weakened |
| (d) | **Delivery and outbox integration** — provider reports drive `awaiting_delivery → closed` | Today that transition is driven by a simulator |
| (e) | **The production configuration is documented** | A deployment that silently falls back to simulation would be worse than one that refuses to start |
| (f) | **BD-06 is decided and recorded BEFORE any unsigned-copy delivery is built** | It is a business decision about what EJE sends a customer who refused to sign, and it is not the implementer's to make |

**Phase 2 — protect what exists.**

| | What |
|---|---|
| (a) | **PostgreSQL-layer tests for submission, delivery and takeover.** The newest and most business-critical paths are proven only against the in-memory repositories today |
| (b) | **Investigate the three status writes that bypass `transition()`** — in `captureSignature`, `recordSignatureRefusal` and `closeOnDelivery`. All three are legal edges today; the finding is that the state machine is not what enforces them. **Investigate before changing anything** |
| (c) | **CI for the existing verification gates** — lint, typecheck, test, db:test, build |

**Phase 3 — the PWA foundation.** Manifest, installability, service worker,
application shell, an IndexedDB **read** cache, and tablet installation. This is
the smallest honest step into MANDATE-2 that can be demonstrated and tested. It
deliberately does **not** include a mutation queue.

**Phase 4 — the full offline system.** Offline viewing, offline job and work
updates, offline completion write-up, offline labour and travel, offline
signature capture, the mutation queue, sync, conflict handling, sync-state
indicators, recovery and retry, reconnect behaviour, offline document and media
handling, and tablet/PWA acceptance testing.

> **Phase 4 MUST be separately scoped in this document before any of it is
> implemented.** It is the largest and riskiest work in the project, "conflict"
> has no agreed meaning for a job card yet, and CR-02's rule that captured work
> is never silently overwritten cannot be honoured by an implementation that
> decides what a conflict is as it goes along.

**Nothing in CR-09 changes a business rule.** CR-01 through CR-08 stand
unaltered: the technician still submits, the office still reviews only a
refusal, a signed job card is still immutable, and a takeover is still the
exception it was defined as.

### CR-10 — The scope records the whole system
*Confirmed 25 September 2026. Implemented by the scope-reconciliation commit
itself — see PROC-1…PROC-5, MANDATE-1…3, MOD-1…MOD-11, AUD-1…AUD-8, ACC-OFF-\*,
ACC-PWA-\*, BD-12, and the dated amendments to UX-1, IDEM-2 and EMAIL-2.*

A full scope-versus-implementation audit was run against `ca1cda7`. It verified
CR-01 through CR-08 in the code rather than taking this register's word for
them, and found three kinds of drift, none of them behavioural:

1. **Whole modules are implemented and carry no requirement ID at all** — the
   Closed Jobs archive, chat, the technical library, attachments, cancel and
   delete, global search, the notifications inbox, the outbox screen, the
   dashboard, theming, and the office's administrative capture. This register
   described the change register thoroughly and the rest of the system not at
   all, so it could not be used to answer "what is this system supposed to do".
   They are recorded as MOD-1…MOD-11, DONE, against the evidence that already
   exists.
2. **Two statuses had gone stale** — UX-1 and IDEM-2 — because work done for
   another requirement had quietly satisfied part of them. Both keep their
   original wording and gain a dated amendment; neither is rewritten.
3. **The audit's own findings had nowhere to live.** They are recorded as
   AUD-1…AUD-8 so that an acceptance blocker is a tracked item with an ID rather
   than a paragraph in a report nobody reads again.

**No requirement was deleted, no status was downgraded to make the
implementation look better, and no open question was closed by this work.** The
one new question the audit raised — whether a technician may issue a parts
collection — is recorded as **BD-12** and left **OPEN**.

### CR-11 — Three defects found in tablet acceptance testing
*Confirmed 25 September 2026. Implemented `5f0ebbc` (see ACCEPT-1…2,
CANCEL-1…6, DELETE-1…5, PDF-3…6, BROWSER-1).*

Three separate faults, reported together from a tablet in the field. None of
them changes the workflow, the state machine, the permissions outside their own
subject, the generated document, the signature, or submission, delivery,
refusal and takeover behaviour — all of which are unchanged and re-proved.

**(a) Accepting a job left the technician on the list.** Accepted from Open
Jobs, the acceptance succeeded and the list refreshed — and the technician was
left standing on the list, with the job they had just taken no longer on it,
having to find it again before they could do any of the work they had just
committed to. The flow simply never navigated anywhere.

**(b) Cancel and Delete were the Master's alone, and asked the wrong question
about the job.** Two faults in one rule. `canCancelJob` and `canDeleteJob` both
tested `role === 'master'` inline, so a Coordinator — who raises jobs — was
never offered either action and was refused if she asked. And neither asked
whether the job had been GIVEN to anybody: cancellation ignored assignment
entirely, and deletion asked `acceptedAt`, which is a later event than
assignment, so a job assigned this morning and not yet accepted read as
nobody's and could be removed behind the technician's back.

**(c) The signed PDF preview failed on the tablet.** The Signed step showed the
document in an `<iframe>` holding a `blob:` PDF, which requires the browser to
have a PDF viewer of its own. See **BROWSER-1**: the tablets do not have one.

> **Superseded — the cancel/delete rule as at `2166ac6`:** *cancel — a Master,
> on a job at `open` or `draft`; delete — a Master, on a job at `open` or
> `draft` whose `acceptedAt` is null.* Replaced by CANCEL-1 and DELETE-1: THE
> OFFICE (Master **and** Coordinator), on a job that is **OPEN and
> UNASSIGNED**. Two things narrow with it, deliberately: a `draft` job is no
> longer cancellable or deletable (nothing can create one — see DRAFT-1 — so
> this removes no working path), and an **Open job with a technician's name on
> it** is no longer removable by anybody. The honest action there is a
> transfer, which keeps the job and says who it moved to.

### BROWSER-1 — Chrome on Android has no inline PDF viewer
*Platform limitation, established 25 September 2026 while investigating CR-11(c).
An architectural constraint on this system, not a defect in it.*

**What was found.** The Signed step never asked the server for the document at
all: it renders the PDF in the browser from the view already on screen and puts
the bytes in a `blob:` URL. So the failure could not be an HTTP status, a
content type, a `Content-Disposition`, a cookie, a CSP rule or a cross-origin
problem — there is no request. What fails is the display.

**Why it fails.** Rendering a PDF inside a page needs the browser to have a PDF
viewer built in. Desktop Chrome, Firefox and Safari do. **Chrome on Android has
never shipped one**, and nor do the Android WebView or the in-app browsers built
on it. Such a browser does not fail quietly: it paints its own *"couldn't
display this PDF"* block with an **Open** button — which is the block the tablet
showed — and that button cannot act on a `blob:` URL, because a blob exists only
inside the page that created it and cannot be handed to another application.
Hence a dead button, and hence one that no amount of application code could fix:
it was never ours.

**How it is detected.** `navigator.pdfViewerEnabled`, which is the browser's own
answer about its own capability — *"the user agent supports inline display of
PDF files"* — asked before the frame is drawn. Never inferred from the user
agent, which cannot be trusted and would have to be maintained for ever.

**The consequence for this system.** Any screen that shows a PDF inline must
have a representation that does not depend on a viewer being present. This one
already did: `JobCardDocument` is how the review screen has always shown the
document, and it is built from `buildJobCardModel` — the same definition the PDF
renderer consumes — so the two cannot drift. **No PDF library was added**, which
also matters for CR-02: an offline tablet must not depend on a renderer fetched
from a CDN.

### CR-12 — A parts collection is counter work, raised and processed in one go
*Confirmed 25 September 2026, resolving **BD-12**. Implemented `9c0e303`
(see PARTS-1…PARTS-16).*

A parts collection was being driven through the field-service workflow because
that is how every job worked: raise it, find it in the Jobs list, accept it,
process it, close it. Every one of those steps was somebody standing at the
counter waiting while the office clicked through a sequence built for a
technician driving to a site — and the form asked, before any of it, for a
priority, a date, a technician and a courier answer that nobody could know yet.

**The collection journey, and it is one sitting.**

| | Step | Who |
|---|---|---|
| 1 | Raise the collection — customer, contact, order number, reference, delivery note, attachments | Master **or** Coordinator |
| 2 | **Parts** — the goods, quantities and prices | the same person |
| 3 | **Review** — everything captured, checked before anybody signs | the same person |
| 4 | **Collection** — customer or courier, and the waybill if it is a courier | the same person |
| 5 | **Collector signature** — the person collecting signs for the goods | the collector |
| 6 | **Signed** — the collection note as it now stands | the same person |
| 7 | **Submit collection note** — the customer's copy is generated and emailed | the same person |
| 8 | Delivery pending → **confirmed delivery → CLOSED** | the provider's report |

**What a collection does not have, refused on the SERVER and not merely hidden:**
a technician, an assignment, an acceptance step, a scheduled date, a priority,
labour, travel and a call-out fee.

**No new status and no new transition.** A collection is created at
`completion` — the existing stage whose next legal move is the customer
signature, which is exactly what a collection does next. Everything after that
is the machinery every other job already uses: the same signature, the same
document renderer, the same submission, the same delivery handshake, and the
same rule that only a confirmed delivery closes a job.

**It is the OFFICE's, start to finish.** This answers BD-12, which had been
open since the CR-11 audit: `jobs.processParts` was held by the technician as
well, so a collection was something either the counter or the field could pick
up, while the prose had always described it as counter work. EJE chose option
(b): a Master or a Coordinator raises, processes, signs off and submits a
collection, and a technician is not part of it at any point.

> **Superseded — the parts workflow as at `2e4f774`:**
>
> - *A parts job is created at `open`, like every other job, and must be
>   ACCEPTED before it can be processed.* Accepting one was the counter
>   exception in `canAcceptJob` and `acceptJobRefusal`. There is nothing left
>   to accept: a collection is created at `completion`, and acceptance is
>   refused to everybody, the office included.
> - *`jobs.processParts` is held by the Master, the Coordinator AND the
>   technician* (SUBMIT-10's "whoever processed it at the counter"). The
>   capability and SUBMIT-10 both stand; the technician no longer holds it.
> - *The creation form asks for a priority, a scheduled date, a technician and
>   the Courier Collection answer on a parts job.* All four are gone from it.
>   The first three do not exist on a collection at all; the fourth is asked at
>   the Collection step, where the person collecting is standing in front of
>   whoever is asking.
> - *The close-out's first step is "Completion", with the completion write-up
>   on it.* It is called **Parts**, and the write-up is not asked for: nothing
>   was worked on, and the goods are the record. The FIELD is untouched — a
>   collection raised before this keeps whatever was written on it and the
>   document still prints it.
> - *`EJE-1064` (demonstration) and `EJE-2005` (PostgreSQL) are seeded `open`
>   and assigned to a technician.* Both are seeded at `completion` and
>   unassigned, because a seed must demonstrate a state the application can
>   actually produce — the same rule REF-18 applied to the refusal review.
>
> **CR-01 and CR-07 are untouched.** A signed collection note is as final as a
> signed job card, and no field-service journey changed in any respect.

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
| REF-9 | ~~Final submission/closure/delivery stays Master-controlled~~ | **SUPERSEDED by SUBMIT-1** | `d979aa9`, reversed `84d1802` — see CR-07 |
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
| ROLE-6 | ~~The final submission stays the Master's~~ | **SUPERSEDED by SUBMIT-1** | `d979aa9` + `901e579`, reversed `84d1802` | Kept for the history. The requirement it replaced — that the screen and the server give the same answer for every role — survives unchanged as ROLE-7 and SUBMIT-8. |
| ROLE-7 | Every rule above is enforced in the application layer first; the UI only reflects it | **DONE** | `901e579` | every negative case in `workflow-role-matrix.test.ts` is an operation refusing, not a button missing |

### CR-07 — the technician's submission

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| SUBMIT-1 | The technician submits the signed job card; `jobs.issueFinal` is theirs | **DONE** | `84d1802` | `access.ts`; `access.test.ts`; `technician-submission.test.ts` |
| SUBMIT-2 | The Coordinator CANNOT submit an ordinary signed job card, and nothing happens when she tries | **DONE** | `84d1802` | `technician-submission.test.ts`; `role-enforcement.test.ts`; `scope-authorization.test.ts` (403) |
| SUBMIT-3 | The Master CANNOT either, on a job he did not attend, however senior — the capability table is no longer a seniority ladder | **DONE** | `84d1802` | same, plus `access.test.ts` |
| SUBMIT-3a | **Whoever ATTENDED the machine submits it**, which includes a Master who accepted and worked the job himself. Anyone with `jobs.acceptField` who is ON the job may submit it; nobody may submit a job they did not attend | **DONE** | `84d1802` | `canSubmitJobCard`; `technician-submission.test.ts` — both the positive case and "does NOT let a Master submit a job somebody ELSE attended" |
| SUBMIT-4 | The submission generates the customer's copy, emails it once, and moves the job to delivery-pending | **DONE** | pre-existing + `84d1802` | `issueJobCard`; `technician-submission.test.ts` |
| SUBMIT-5 | The job closes only on a CONFIRMED delivery, never on an accepted send | **DONE** | pre-existing | `delivery-handshake.test.ts` |
| SUBMIT-6 | A signature asks the office for NOTHING: no notification, no queue, no link to a review screen | **DONE** | `84d1802` | `captureSignature`; `office-notifications.test.ts`; `technician-submission.test.ts` |
| SUBMIT-7 | The office IS told, once, when the submission has happened and the customer has been emailed — information, not work, linked to the job | **DONE** | `84d1802` | `issueJobCard`; `office-notifications.test.ts` |
| SUBMIT-8 | The normal journey does not route through `/jobs/:n/review`; the submission is taken in the close-out and on the job | **DONE** | `84d1802` | `SubmitJobCardDialog.tsx`; `CompleteJobWizard.tsx`; `JobActionBar.tsx`; `workflow-e2e.mjs` |
| SUBMIT-9 | The superseded wording is gone from every screen, not hidden: no *Review & submit job card*, *With the office for submission* or *A Master makes the final submission* on an ordinary signed job | **DONE** | `84d1802` | `workflow-e2e.mjs`, `smoke.mjs` assert the exact strings are absent |
| SUBMIT-10 | A parts collection is still issued by whoever processed it at the counter | **DONE** | `84d1802` | `canSubmitJobCard`; `technician-submission.test.ts`; `smoke.mjs` |
| SUBMIT-11 | A job stranded in the retired Master Review stage can still be issued by a Master | **DONE** | `84d1802` | `canSubmitJobCard`; `technician-submission.test.ts`; `master-review.test.ts` |
| SUBMIT-12 | Re-sending a customer's copy is open to the technician who submitted it AND to the office, because the office sees the failure | **DONE** | `84d1802` | `canResendCustomerCopy`; `delivery-handshake.test.ts`; `technician-submission.test.ts` |
| SUBMIT-13 | Reporting a delivery outcome is gated as the outbox screen is — the office — rather than on `jobs.issueFinal` | **DONE** | `84d1802` | `/api/outbox/[messageId]/delivery` |
| SUBMIT-14 | `jobs.submit` is retired: it guarded nothing and named a hand-over to an office review that no longer exists | **DONE** | `84d1802` | removed from `access.ts` and `access.test.ts` |
| SUBMIT-15 | After refusal outcome A, the card rejoins the normal journey and is submitted by the technician | **DONE** | `84d1802` | `technician-submission.test.ts`; `refusal-correction.test.ts`; `workflow-e2e.mjs`, `smoke.mjs` |
| SUBMIT-16 | Signed-job immutability is unaffected: no role may edit a signed job, and no reopen path was added | **DONE** | `947ef4f` + `84d1802` | `technician-submission.test.ts`; `signed-job-immutability.test.ts` |

### CR-08 — the exceptional takeover

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| TAKEOVER-1 | "Technician unavailable" = a disabled account, or a whole-day active absence covering today, for **everyone** on the job who could submit it | **DONE** | `63ca3c0` | `submissionCover`, `isAwayAllDayOn`; `submission-takeover.test.ts` |
| TAKEOVER-2 | The condition is decided on the SERVER from the availability register and user records — never from a client flag | **DONE** | `63ca3c0` | `loadSubmissionCover`; `views.ts` computes it for the screen |
| TAKEOVER-3 | A part-day absence does NOT unlock it | **DONE** | `63ca3c0` | `submission-takeover.test.ts` |
| TAKEOVER-4 | An absence on another day, a cancelled absence, or somebody else's absence does NOT unlock it | **DONE** | `63ca3c0` | `submission-takeover.test.ts` |
| TAKEOVER-5 | A second technician on the job who IS available keeps it shut | **DONE** | `63ca3c0` | `submission-takeover.test.ts` |
| TAKEOVER-6 | Master and Coordinator may take over when the condition holds; both are refused when it does not | **DONE** | `63ca3c0` | `submission-takeover.test.ts`; `scope-authorization.test.ts` |
| TAKEOVER-7 | A technician may never take over — it is the office's exception | **DONE** | `63ca3c0` | 403 in `scope-authorization.test.ts` |
| TAKEOVER-8 | A REFUSED job card can never be taken over; the refusal workflow is untouched and separate | **DONE** | `63ca3c0` | `submission-takeover.test.ts`; capability is not `jobs.resolveSignatureRefusal` |
| TAKEOVER-9 | A takeover changes NOTHING on the signed job card — signature, write-up, labour, travel, parts, pricing all unchanged, and every edit operation still refuses | **DONE** | `947ef4f` + `63ca3c0` | `submission-takeover.test.ts` |
| TAKEOVER-10 | A takeover produces the IDENTICAL customer document — asserted byte for byte against a technician submission | **DONE** | `63ca3c0` | `submission-takeover.test.ts` |
| TAKEOVER-11 | A takeover creates the customer delivery, and the job still closes only on a confirmed delivery | **DONE** | `63ca3c0` | `submission-takeover.test.ts` |
| TAKEOVER-12 | The audit records who took over, for whom and on what grounds, under its own event type | **DONE** | `63ca3c0` | `submission_taken_over`; `submission-takeover.test.ts` |
| TAKEOVER-13 | The UI offers *Take over submission* — never *Review & submit* — only when the condition holds, and its dialog states that the signed card cannot be edited | **DONE** | `63ca3c0` | `TakeOverSubmissionDialog.tsx`; `JobActionBar.tsx` |
| TAKEOVER-14 | Refusing the office because the technician IS available is a 422 (a condition, not yet met), while refusing a technician is a 403 (permanent) | **DONE** | `63ca3c0` | `takeover_not_available` vs `not_permitted`; `scope-authorization.test.ts` |

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
| EMAIL-1 | Only the final submission emails the customer — once, and by nothing else | **DONE** | `d979aa9`, actor corrected `84d1802` |
| CHK-1 | Installation/Service checklists mandatory | **DONE** | pre-existing |
| CHK-HIST | Exact historical checklist version retrieved | **DONE** | pre-existing |
| COST-8 | Pricing snapshots frozen | **DONE** | pre-existing |
| TRANS-1..4 | Transfers | **DONE** | pre-existing |
| DEMO-1..4 | Demo users, switcher, idempotent seed | **DONE** | `202e1fe`, `95e9848` |
| DEMO-5 | Seed demonstrates the office review queue | **DONE** | `947ef4f` — EJE-2025 signed, EJE-2026 refused; EJE-2018 corrected to `review` in `b4e6140` (REF-18) |

> **EMAIL-1's note, relocated 25 September 2026 (CR-10), wording unchanged:**
> *"The rule is unchanged by CR-07; only WHO makes that submission changed (the
> technician)."* It was written as a fifth cell in a four-column table, so it was
> in the file but did not render. Nothing about the requirement has changed.
>
> **EMAIL-1 is DONE as a rule and blocked as an outcome.** Exactly one email is
> sent, by the submission and by nothing else — but the adapter that would send
> it does not exist. See EMAIL-2, AUD-1, MANDATE-3.

### CR-11 — acceptance, ending a job, and the signed preview on a tablet

*Added 25 September 2026. Three defects from tablet acceptance testing, fixed
together and tested separately. Nothing outside these rows changed.*

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| ACCEPT-1 | Accepting a job takes the technician to that job's own screen — `/jobs/<number>` — so the work they have just committed to is in front of them | **DONE** | `5f0ebbc` | `AcceptJobFlow.tsx` (`finish`); `smoke.mjs` ACCEPT-1 |
| ACCEPT-2 | Navigation follows a SUCCESSFUL acceptance and nothing else: a refused acceptance leaves the technician on the page they were on, with the refusal the flow already shows | **DONE** | `5f0ebbc` | `AcceptJobFlow.tsx`; `smoke.mjs` ACCEPT-2 drives a real 422 from the server |
| ACCEPT-3 | The site-location offer still comes first, because it is part of accepting; answering it is what finishes the flow, and the job opens then. Accepting from the job screen navigates nowhere — it is already there | **DONE** | `5f0ebbc` | `smoke.mjs`, `workflow-e2e.mjs` — the offer, the decline and the queued message all unchanged |
| CANCEL-1 | **Cancel is available only when the job is OPEN *and* has no technician assigned — neither primary nor additional.** Both halves are the rule | **DONE** | `5f0ebbc` | `isEndableJob`, `isUnassigned` in `workflow.ts`; `end-unstarted-job.test.ts` |
| CANCEL-2 | A **Master** may cancel such a job | **DONE** | `5f0ebbc` | `end-unstarted-job.test.ts`; `end-unstarted-job-api.test.ts` |
| CANCEL-3 | A **Coordinator** may cancel such a job. This is new: she raises jobs, so she undoes one raised in error | **DONE** | `5f0ebbc` | `jobs.endUnstartedJob` in `access.ts`; both test files |
| CANCEL-4 | A **technician** may never cancel a job, in any state | **DONE** | `5f0ebbc` | `end-unstarted-job.test.ts`; API refusal |
| CANCEL-5 | **Open BUT ASSIGNED is refused** — including a job assigned moments ago and not yet accepted, which is what `acceptedAt` could not see. The office is pointed at a transfer | **DONE** | `5f0ebbc` | `end-unstarted-job.test.ts` (both the assigned-seed case and the assign-then-try case) |
| CANCEL-6 | In progress, awaiting spares, completion, customer signature, review/signed, awaiting delivery, the retired submitted stage and closed are **all refused, to every role**, and refused by the SERVER rather than by a hidden button | **DONE** | `5f0ebbc` | `end-unstarted-job-api.test.ts` drives each one over HTTP |
| DELETE-1 | Delete carries exactly the same rule as CANCEL-1: the office, OPEN and UNASSIGNED | **DONE** | `5f0ebbc` | one predicate pair, one helper — `isEndableJob` |
| DELETE-2 | A Master may delete such a job | **DONE** | `5f0ebbc` | `end-unstarted-job.test.ts` |
| DELETE-3 | A Coordinator may delete such a job | **DONE** | `5f0ebbc` | `end-unstarted-job.test.ts`; `end-unstarted-job-api.test.ts` |
| DELETE-4 | A job being worked on is refused AND pointed at cancellation, which keeps the work and the history. A signed, issued or closed job gets the plain refusal instead, because cancellation is equally refused there and would be a dead end | **DONE** | `5f0ebbc` | `deleteJobRefusal`; `end-unstarted-job.test.ts` |
| DELETE-5 | Deletion still destroys the job and still leaves the audit event behind it — unchanged | **DONE** | pre-existing | `job-cancel-delete.test.ts`, `jobs-api.test.ts` |
| PDF-3 | The Signed step shows the signed document on a browser with **no built-in PDF viewer**, at A4 proportions, without leaving the page | **DONE** | `5f0ebbc` | `canDisplayPdfInline`; `JobCardPdfPreview.tsx`; `tablet-pdf-check.mjs` |
| PDF-4 | **The desktop preview is unchanged**: the same PDF, in the same frame, at the same measured A4 proportions | **DONE** | `5f0ebbc` | `tablet-pdf-check.mjs` measures 565.66 × 800.0 px, ratio 1.4143 — the figure PDF-1 fixed |
| PDF-5 | The fallback is the SAME document, not a lookalike: `JobCardDocument`/`PartsCollectionNote` and the PDF renderer are both built from `buildJobCardModel`, so content, order, labels and the signature cannot drift | **DONE** | `5f0ebbc` | `model.ts` is the single definition; `tablet-pdf-check.mjs` asserts the job number, the company and the customer's name |
| PDF-6 | **No dead action.** No `iframe`, `embed` or `object` is handed to a browser that cannot render one, so the browser's own "couldn't display / Open" block cannot appear; the actions offered are ones that work, and Download really downloads | **DONE** | `5f0ebbc` | `tablet-pdf-check.mjs` — the download event is awaited, not assumed |
| PDF-7 | The stored document still answers over HTTP as a real PDF: 200, `application/pdf`, `%PDF-`…`%%EOF`, the same bytes every time, and nothing without a session | **DONE** | `5f0ebbc` | `signed-document-api.test.ts` |
| BROWSER-1 | The platform limitation behind PDF-3 is **documented, detected from the browser's own capability signal, and never inferred from the user agent** | **DONE** | `5f0ebbc` | `src/lib/pdf-support.ts`; `pdf-support.test.ts` (4 cases) |

> **What CR-11 deliberately did NOT touch**, and what the suites re-proved
> afterwards: the state machine and its transitions; who may accept a job and
> on what terms; the completion write-up and its autosave; labour, travel,
> parts and the call-out; the generated PDF and its content; the signature; the
> technician's submission; the delivery handshake; the refusal workflow and its
> two outcomes; the CR-08 takeover; and signed-job immutability.

### CR-12 — the parts collection workflow

*Added 25 September 2026. Scoped to `jobType === 'parts'` throughout: the flag
the rules ask is `officeProcessed`, which is true for that job type and false
for every other one.*

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| PARTS-1 | A parts collection is created **at `completion`**, not `open` — no new status and no new transition; `completion` is the existing stage whose next legal move is the signature | **DONE** | `9c0e303` | `job-creation.ts`; `parts-workflow.test.ts`; `parts-workflow-api.test.ts` |
| PARTS-2 | Creating one **continues straight into its close-out**, rather than returning to the Jobs list | **DONE** | `9c0e303` | `?continue=1`; `workflow-e2e.mjs` Part 23 |
| PARTS-3 | **No technician**: a request naming one is refused, and assignment afterwards is refused too | **DONE** | `9c0e303` | `assertAssignable`; `createJob`; both test files |
| PARTS-4 | **No acceptance step** — refused to the office and to a technician alike, because there is nothing to accept | **DONE** | `9c0e303` | `canAcceptJob`, `acceptJobRefusal`; 403 over HTTP |
| PARTS-5 | **No scheduled date and no priority**: both are forced by the server whatever the request carries, and neither is asked for on the form | **DONE** | `9c0e303` | `createJob`; `parts-workflow-api.test.ts` |
| PARTS-6 | **No labour, travel or call-out fee — refused on the server**, not merely hidden on the screen | **DONE** | `9c0e303` | `assertCapturesLabourAndTravel`; 422 over HTTP for all three |
| PARTS-7 | The creation form keeps **customer, site, contact, customer order number (required), reference number, delivery note, collection details and attachments** | **DONE** | `9c0e303` | `jobs/new/page.tsx`; `workflow-e2e.mjs` asserts each |
| PARTS-8 | The close-out's first step is **Parts** — the goods, their quantities and their prices — with no completion write-up | **DONE** | `9c0e303` | `CompleteJobWizard.tsx`; `workflow-e2e.mjs`, `smoke.mjs` |
| PARTS-9 | The steps are **Parts → Review → Collection → Collector signature → Signed**, and Review is unchanged | **DONE** | `9c0e303` | `workflow-e2e.mjs` asserts the rail in order |
| PARTS-10 | **Courier or customer is asked at the Collection step, and nowhere else** | **DONE** | `9c0e303` | `setCollectionMethod`; creation forces `courierCollection: false` |
| PARTS-11 | The collector signs, on the collection declaration — unchanged | **DONE** | pre-existing | `parts-collection.test.ts` |
| PARTS-12 | **Submit collection note** issues the stored document and emails the customer once, through the existing outbox | **DONE** | pre-existing + `9c0e303` | `issueJobCard`; `parts-workflow.test.ts` |
| PARTS-13 | **Submission does NOT close the job.** It moves to `awaiting_delivery`, and only a CONFIRMED delivery closes it — the same rule as SUBMIT-5, and no second closed state | **DONE** | `9c0e303` | `parts-workflow.test.ts`; `workflow-e2e.mjs` |
| PARTS-14 | Both a **Master and a Coordinator** can do all of it, alone | **DONE** | `9c0e303` | `parts-workflow.test.ts`; `role-enforcement.test.ts` |
| PARTS-15 | A **technician** can do none of it: no acceptance, no processing, no submission | **DONE** | `9c0e303` | `access.test.ts`; `technician-submission.test.ts`; API refusals |
| PARTS-16 | **Field service is unchanged.** Breakdown, Installation, Service and Test & Repair keep their schedule, priority, assignment, acceptance, labour, travel, call-out, signature, submission, delivery, refusal and takeover behaviour | **DONE** | `9c0e303` | `parts-workflow.test.ts` drives a breakdown end to end; the whole existing suite is unchanged and green |

> **The document is unchanged.** A collection note still carries the customer,
> contact, order number, reference, delivery note, the goods with quantities,
> descriptions and prices, the total, the collection method, the collector's
> signature and the dates — rendered by `buildJobCardModel` through the same
> pipeline as every other document. Nothing was added to it and no second
> document system exists. DOC-1 governs the write-up it no longer collects: an
> empty section is not printed.

### CR-10 — verification record at `ca1cda7`

*Added 25 September 2026. What the audit checked in the CODE, so that a later
reader can tell a verified DONE from an asserted one. Every statement below was
established by reading the implementation and its tests, not by reading this
register.*

| ID | Verified behaviour | Where it is enforced |
|---|---|---|
| VER-1 | **The normal journey is** accept → work → completion write-up → customer signature → signed → **technician submits** → customer emailed → delivery confirmed → **closed**. No office step exists anywhere in it | `TRANSITIONS`; `canSubmitJobCard`; `performIssue`; `JobActionBar` |
| VER-2 | **The office review exists only for a refusal.** A signed job card offers the office nothing but *View job card* | `JobActionBar` branches on `refusalAwaitingResolution`, not on status |
| VER-3 | **The technician records a refusal and is read-only from that moment** — refused server-side, not hidden | `canEditJob` at `review` asks `jobs.editSubmittedJob`; `refusal-review-roles.test.ts` |
| VER-4 | **Both the Master and the Coordinator are notified** of a refusal; the reason lives on the job, not in the audit detail, so one access rule governs it | `notifyOffice`; `recordSignatureRefusal` |
| VER-5 | **Outcome A** is `review → customer_signature` and rejoins the normal journey; **Outcome B** is `review → closed` in one act, producing the stored unsigned document | `returnToCustomerSignature`; `resolveSignatureRefusal` |
| VER-6 | **A signed job card cannot be edited by anyone**, at four layers: `isFinalized`, `assertEditable` on all sixteen mutations, the screen predicates, and seven PostgreSQL triggers raising SQLSTATE `23001`. **No reopen path exists** — `closed: []` | `0002`, `0007`; `job-repository.db.test.ts` |
| VER-7 | **Takeover unlocks only when nobody who could submit is available** — a disabled account, or an `active`, `allDay` absence covering today — decided on the server and re-asked by the operation before it acts; it edits nothing, produces byte-identical output, and writes its own audit event | `submissionCover`; `canTakeOverSubmission`; `takeOverSubmission`; `submission-takeover.test.ts` |
| VER-8 | **The capture screen and the document** behave as CR-06 requires: write-up autosaves (1 200 ms debounce, 5 000 ms ceiling, one write in flight, the edit survives a failure), empty sections are omitted, Work performed is mandatory, labour has no description field, the call-out sits under Parts, the wizard's Review step carries no PDF and the Signed step carries one at A4 | `src/lib/autosave.ts`; `model.ts`; `checkReadyForSignature`; `JobCardPdfPreview` |
| VER-9 | **The Coordinator cannot accept field work but may process Parts**, and the screen and the server give the same answer | `canAcceptJob`; `acceptJobRefusal` |
| VER-10 | **Gates at `ca1cda7`:** `npm test` **1566 passed** (95 files) · `npm run db:test` **145 passed** (11 files) · `check-routes` **28/28** · lint clean · typecheck clean · `npm run build` exit 0 · `workflow-e2e` 47 steps · `smoke` 202 checks | re-run during the audit |

> **No migration is outstanding.** Migration head is `0007`, added in `947ef4f`,
> which is an ancestor of the deployed VPS commit `83b6754`. CR-04 through CR-08
> are application-layer only; CR-08 needed no migration because
> `audit_events.type` is `text`.

### CR-10 — modules implemented before they had a requirement ID

*Added 25 September 2026. Every row below was **already built and working** at
`ca1cda7`; what was missing was the requirement. Each is recorded against the
implementation that exists, not against a new intention. Status was established
by reading the code and its tests during the audit, not by assumption.*

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| MOD-1 | **Closed Jobs archive.** Closed jobs are their own screen, searchable by job number, serial number, machine number and customer order number, filterable by customer, job type, technician and closing date, and each one opens the complete historical record with its stored final document | **DONE** | pre-existing | `src/application/closed-jobs.ts`; `closed-jobs.test.ts`; `src/app/(app)/jobs/closed/page.tsx`; `smoke.mjs` (archive section) |
| MOD-2 | **Chat.** A technician can message the office and continue the same conversation; the office is notified and can reply. A message is NOT an availability record — see AVAIL-1 | **DONE** | pre-existing | `src/application/chat-operations.ts`; `chat.test.ts`; `/messages`; `smoke.mjs` |
| MOD-3 | **Technical library.** Documents are uploaded, versioned, approved and read; a technician reads and does not manage | **DONE** | pre-existing | `src/application/library-operations.ts`; `library-admin.test.ts`; `/library`; `library.view` / `library.manage` |
| MOD-4 | **Job attachments.** Documents are attached to a job and downloaded through authorised endpoints, never from a public path | **DONE** | pre-existing | `attachDocument`, `readJobAttachment`; `/api/jobs/[jobId]/attachments`; filesystem storage adapter |
| MOD-5 | **Cancel and delete.** An open job may be cancelled with a reason and stays searchable; a duplicate open job may be deleted, and the audit trail outlives it. An accepted job can no longer be deleted, only cancelled | **DONE** | pre-existing | `cancelJob`, `deleteJob`, `canDeleteJob`, `canCancelJob`; `job-cancel-delete.test.ts`; `smoke.mjs` |
| MOD-6 | **Global search** across jobs, customers, machines and serial numbers | **DONE** | pre-existing | `src/application/search.ts`; `/search`; `smoke.mjs` |
| MOD-7 | **Notifications inbox.** Each person sees their own notifications; a notification opens the thing it is about; a handled notification stops being outstanding | **DONE** | pre-existing + `b4e6140` | `/notifications`; `notification-repository.ts`; `fileRefusalNotifications`; `office-notifications.test.ts` |
| MOD-8 | **Outbox screen.** The office can see what was sent and what became of it. A technician cannot reach it at all — SEC-1 | **DONE** | pre-existing + `84d1802` | `/notifications?tab=outbox`; `/api/outbox` gated on `jobs.viewAll`; `smoke.mjs` |
| MOD-9 | **Dashboard**, scoped by role: the technician sees their work, the office sees the operation | **DONE** | pre-existing | `/dashboard`; `/api/dashboard`; `smoke.mjs` |
| MOD-10 | **Theming.** Light is the default; dark is a single control in the top bar, applied before hydration, surviving a reload, across every screen. **The job-card preview stays light, because it represents paper** | **DONE** | pre-existing | `src/lib/theme.ts`; `theme.test.ts`; `smoke.mjs` (theme section) |
| MOD-5a | **`jobs.endUnstartedJob`** — the capability behind MOD-5, added by CR-11 so that cancelling and deleting ask a capability like everything else rather than testing for a role inline. Held by the Master and the Coordinator; never by a technician | **DONE** | `5f0ebbc` | `access.ts`; `end-unstarted-job.test.ts` |
| MOD-11 | **Administrative capture.** The office may capture completion information, and a signature, on a job it did not attend — recorded as an administrative capture, with the technician who did the work staying the technician on the job. This is NOT `jobs.acceptField` and does not make the office a field worker | **DONE** | pre-existing | `jobs.captureAdministratively` in `access.ts`; `assertCanCapture` (`job-operations.ts:147`) |

> **MOD-11 is recorded, not endorsed.** The audit found it implemented and
> undocumented. It is a real capability the office holds today; if EJE does not
> want it, that is a change request, not a correction, and this row is what it
> would supersede.

### CR-10 — audit findings at `ca1cda7`

*Added 25 September 2026. Findings from the full implementation audit, recorded
so that a blocker is a tracked item rather than a paragraph in a report. Fixing
these is CR-09's work; the IDs exist so the fix can point at something.*

| ID | Finding | Severity | Status | Where |
|---|---|---|---|---|
| AUD-1 | **No production email adapter.** `src/server/runtime.ts` constructs `SimulatedEmailService` unconditionally — there is no branch, no configuration reader and no adapter. The customer is not emailed in any environment | **ACCEPTANCE BLOCKER** | OPEN | EMAIL-2, MANDATE-3, CR-09 Phase 1 |
| AUD-2 | **Offline and PWA are at zero**: no `public/` directory, no manifest, no service worker, no IndexedDB, no mutation queue, no sync or conflict handling. `request-failure.ts` classifies a network failure as `offline` and says so, which is an error message, not offline capability | **ACCEPTANCE BLOCKER** | OPEN | CR-02, CR-03, MANDATE-1, MANDATE-2, CR-09 Phases 3–4 |
| AUD-3 | **A signed job card with a genuine error has no remedy at any layer** | **ACCEPTANCE BLOCKER** | OPEN — **business decision BD-02** | IMMUT-9 |
| AUD-4 | **Closing Without Customer Signature sends the customer nothing.** The document is rendered, stored and downloadable; no delivery is attempted | **ACCEPTANCE BLOCKER** | OPEN — **business decision BD-06** | REF-16, CR-09 Phase 1(f) |
| AUD-5 | **No CI.** Every verification gate is run by hand, so a regression can reach the VPS unnoticed | **ACCEPTANCE BLOCKER** | OPEN | ARCH-6, CR-09 Phase 2(c) |
| AUD-6 | **No PostgreSQL-layer test for submission, delivery or takeover.** The database suite stops at creation, acceptance and immutability; CR-07 and CR-08 are proven only against the in-memory repositories | **HIGH** | OPEN | CR-09 Phase 2(a) |
| AUD-7 | **Three status writes bypass the state machine.** `captureSignature`, `recordSignatureRefusal` and `closeOnDelivery` write the status onto the saved record directly rather than through `transition()`. All three are legal edges and each is guarded by its own preconditions, so no illegal state is reachable today — but `TRANSITIONS` is not what enforces them. **Investigate before changing** | **MEDIUM — no known defect** | OPEN | CR-09 Phase 2(b) |
| AUD-9 | **A refused cancellation and a refused deletion come back with different HTTP status codes** — 422 and 403 — because `delete_not_permitted` is listed in `PERMISSION_CODES` and `cancel_not_permitted` is not. Both are refusals and both leave the job untouched, so nothing is unsafe; it is an inconsistency in what a client is told. Found while writing CR-11's API tests, which assert the code each route actually returns rather than flattening the difference | **LOW — no unsafe behaviour** | OPEN | `errors.ts`; `end-unstarted-job-api.test.ts` |
| AUD-8 | **Demonstration data cannot demonstrate a takeover.** In both seeds the technician on the signed job at `review` has either no absence or a **part-day** absence today — correctly keeping the exception shut — so there is no seeded job the office may actually take over. A demonstrator must first record an all-day absence, which is what `workflow-e2e.mjs` Part 22 does. Related: `src/db/seed/jobs.ts:1145,1149` still describes EJE-2025 as *"Waiting on a Master's final submission"*, which CR-07 removed, and `finalDocument.simulated` is still `true` on a document whose bytes are real — only the email is simulated | **LOW — documentation and demo data** | OPEN | DEMO-5, CR-08 |

### CR-09 — customer delivery and production readiness (DEFINED, not implemented)

*Added 25 September 2026. **No code has been written for any of these.** They
are the agreed shape of the next batch, recorded before implementation so that
the implementation can be checked against something.*

**Phase 1 — the customer receives the document**

| ID | Requirement | Status |
|---|---|---|
| DELIV-1 | A **production email adapter** exists behind the existing `EmailService` port, selected from configuration exactly as `buildWhatsApp` selects the WhatsApp adapter | **DEFINED** |
| DELIV-2 | The **simulated adapter is retained** and is what the demonstration and the test suites use. A deployment never silently falls back to it: an unconfigured production deployment refuses and says why, as `UnconfiguredWhatsAppService` does | **DEFINED** |
| DELIV-3 | **An accepted send is not a delivery.** The adapter may report `pending_delivery` and nothing else until the provider says otherwise; only a confirmed delivery closes a job (SUBMIT-5 is unchanged) | **DEFINED** |
| DELIV-4 | A **failed send is reported and retryable**, re-sending the STORED document rather than rendering a new one (SUBMIT-12 unchanged) | **DEFINED** |
| DELIV-5 | **Provider reports drive the delivery handshake** through the existing outbox and `/api/outbox/[messageId]/delivery`, gated as it is today | **DEFINED** |
| DELIV-6 | **The production configuration is documented** — every variable, what happens when each is absent, and how to verify a live send without sending a customer a test job card | **DEFINED** |
| DELIV-7 | **BD-06 is answered and recorded in this document BEFORE any unsigned-copy delivery is implemented** | **DEFINED — blocked on BD-06** |

**Phase 2 — protect what exists**

| ID | Requirement | Status |
|---|---|---|
| QA-1 | PostgreSQL-layer tests for **submission**, **delivery** and **takeover**, including the audit rows each writes | **DEFINED** |
| QA-2 | A **duplicate submission** is tested, not merely refused by a status guard (closes the untested half of IDEM-2) | **DEFINED** |
| QA-3 | The three status writes in AUD-7 are **investigated and reported on before any change is made**. If they are left as they are, the reason is recorded here | **DEFINED** |
| QA-4 | **CI** runs lint, typecheck, `npm test`, `npm run db:test` and `npm run build` on every push (ARCH-6) | **DEFINED** |

**Phase 3 — the PWA foundation**

| ID | Requirement | Status |
|---|---|---|
| PWA-5 | An **application shell** that renders without a network round trip | **DEFINED** |
| PWA-6 | An **IndexedDB read cache** for the signed-in technician's assigned jobs and the reference data they need to read them | **DEFINED** |
| PWA-7 | An **update mechanism**: a new version is picked up and applied without the tablet being reinstalled, and never mid-capture | **DEFINED** |
| PWA-8 | **Tablet installation is documented and demonstrated** on the target rugged Android device | **DEFINED** |

*PWA-1…PWA-4 already exist below and are unchanged; Phase 3 delivers PWA-1,
PWA-2 and these four. Phase 3 deliberately contains **no** mutation queue —
writing offline is Phase 4.*

**Phase 4 — the full offline system (MUST be separately scoped first)**

| ID | Requirement | Status |
|---|---|---|
| OFF-10 | **Offline authentication and session.** A technician who is already signed in can keep working through a shift with no connectivity, without their session silently expiring mid-job | **DEFINED** |
| OFF-11 | **Reconnect behaviour** is defined and visible: what syncs first, what the technician sees while it happens, and what they may do during it | **DEFINED** |
| OFF-12 | **Offline document and media handling** — what a technician may view and produce offline, and what necessarily waits for a connection | **DEFINED** |
| OFF-13 | **Tablet/PWA acceptance testing** on the target device, covering a full job captured start to finish with the network off | **DEFINED** |

> Phase 4 also delivers OFF-1…OFF-9 below. **None of it may be implemented
> until the phase is scoped in this document**, because CR-02's promise that
> captured work is never silently overwritten depends on an agreed definition of
> a conflict, and there is none yet.

### Offline and tablet acceptance criteria (CR-02, CR-03, CR-09, MANDATE-1, MANDATE-2)

*Added 25 September 2026 by CR-10. The audit found the offline requirement
stated as an aspiration and as a list of unimplemented rows, with nothing that
says what "done" would look like. These are the conditions a release must meet
to satisfy MANDATE-1 and MANDATE-2. They are acceptance criteria, not a design.*

| ID | Acceptance criterion | Satisfies |
|---|---|---|
| ACC-OFF-1 | With the network disabled, a signed-in technician can open the application and see their assigned jobs, including everything already captured on them | OFF-1, PWA-6 |
| ACC-OFF-2 | With the network disabled, a technician can capture labour, travel, parts, the call-out flag, notes and photographs on a job, and see them on the job immediately | OFF-2, OFF-3 |
| ACC-OFF-3 | With the network disabled, a technician can complete a checklist, including a failed item and its mandatory note | OFF-4 |
| ACC-OFF-4 | With the network disabled, a technician can write the completion report, and **not one keystroke is lost** if the tablet is locked, closed or runs out of battery before it reconnects | OFF-1, MANDATE-1 |
| ACC-OFF-5 | With the network disabled, a technician can take the customer's signature **or** record their refusal with its reason, under the same readiness rules as online (Work performed mandatory, checklist complete, waybill for a courier) | OFF-5 |
| ACC-OFF-6 | Everything captured offline survives the browser being closed, the tablet being restarted and the battery running flat | OFF-6 |
| ACC-OFF-7 | On reconnection, queued work is sent in the order it was captured, and a partial failure leaves the rest queued rather than lost | OFF-6, OFF-7, OFF-11 |
| ACC-OFF-8 | The technician can always see, per job, whether their work is **synced / saved locally / syncing / waiting / action required** | OFF-8 |
| ACC-OFF-9 | **Nothing is ever silently overwritten.** Where the server and the tablet disagree, the conflict is detected, the technician is told, and a person decides | OFF-9 |
| ACC-OFF-10 | An upload interrupted mid-photograph resumes or retries; it never leaves a half-written attachment on a job | OFF-7 |
| ACC-OFF-11 | **No offline path may weaken a business rule.** A signed job card is still immutable offline, a refused card is still read-only to the technician offline, and a submission still happens exactly once | CR-01, CR-04, CR-07 |
| ACC-OFF-12 | A full job — accept, work, write-up, signature — is captured start to finish on the target tablet with the network off, and reaches `closed` correctly once it reconnects and the customer's copy is delivered | MANDATE-1 |
| ACC-PWA-1 | The application installs to the home screen of the target rugged Android tablet from the browser, with EJE's name and icon | PWA-1 |
| ACC-PWA-2 | Launched from the home screen it runs standalone — no address bar, no browser chrome | PWA-2 |
| ACC-PWA-3 | The camera and gallery are reachable from the installed application for job photographs | PWA-3 |
| ACC-PWA-4 | Closing the application mid-job and reopening it returns the technician to where they were, with nothing lost | PWA-4 |
| ACC-PWA-5 | A new version is delivered to an installed tablet without reinstallation, and never applies itself in the middle of capture | PWA-7 |
| ACC-PWA-6 | The interface is usable in the field: one-handed, gloved, in daylight, at the tablet's real resolution — every control a reliable tap target | UX-1, PWA-2 |

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

> **Amended 25 September 2026 (CR-10). UX-1 is now PARTIAL, not UNVERIFIED.**
> The original wording above is kept because it was true when it was written.
> The audit at `ca1cda7` found that work done for other requirements has since
> produced real evidence: `scripts/smoke.mjs` loads a job at an 820×1180 tablet
> viewport and asserts **no horizontal overflow**, asserts every calendar bar
> stays **at least 20px tall as a tap target**, asserts the month grid stays
> compact and that a busy day collapses behind *+N more* rather than stretching.
>
> What is still absent, and why this is PARTIAL rather than DONE: **no touch
> gesture testing, and no testing on a real rugged device.** ACC-PWA-6 is the
> criterion that would close it.
>
> OFF-1…OFF-9 and PWA-1…PWA-4 above are **unchanged and remain NOT
> IMPLEMENTED** — verified by search at `ca1cda7`, not assumed: there is no
> `public/` directory, no manifest, no service worker and no IndexedDB
> reference anywhere in `src/`. See AUD-2. New rows OFF-10…OFF-13 and
> PWA-5…PWA-8 are defined under CR-09 above.

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

> **Amendments of 25 September 2026 (CR-10), from the audit at `ca1cda7`. The
> rows above keep their original wording; these are corrections to what is
> known about them, not rewrites of what was asked for.**
>
> - **IDEM-2** — "PARTIAL: mechanism present, untested" **understates what is
>   tested**. Replay under one idempotency key IS tested, at the API layer
>   (`job-workflow-api.test.ts:269`) and against real PostgreSQL
>   (`http-api.db.test.ts:272,295`, including that the idempotency record
>   commits in the same transaction as the change). What is **not** tested is a
>   duplicate **submission** — `performIssue`'s status guard refuses it, and
>   nothing asserts that. IDEM-2 stays **PARTIAL** for that reason alone.
>   QA-2 closes it.
> - **EMAIL-2** — "NOT IMPLEMENTED — simulated only" is **confirmed and is now
>   an acceptance blocker**, not a gap. `runtime.ts` constructs
>   `SimulatedEmailService` unconditionally: there is no Microsoft Graph
>   adapter, no configuration reader and no branch. See AUD-1, MANDATE-3, and
>   CR-09 Phase 1, which is the batch that implements it.
> - **MEDIA-1** — confirmed by reading the schema: `job_media` (migration
>   `0000`, line 246) has no customer-facing/internal column. MEDIA-2 is
>   correctly BLOCKED behind it.
> - **DRAFT-1** — confirmed NOT IMPLEMENTED: `job-creation.ts:316` always
>   creates at `open`. **Noted inconsistency:** the browser demonstration seed
>   nevertheless contains a `draft` job, which is a state the application cannot
>   produce. Recorded under AUD-8's family of demo-data findings.
> - **AUDIT-2** — confirmed PARTIAL: `audit_events.metadata` is a `jsonb`
>   column that exists and is not used for structured before/after values. The
>   trail is narrative.
> - **ARCH-6** — confirmed NOT IMPLEMENTED; it is AUD-5, an acceptance blocker,
>   and QA-4 in CR-09 Phase 2.

---

## Open business decisions

*Every question here is **OPEN** unless its row says otherwise, and remains open
until EJE answers it — PROC-4. Implementation never closes one of these by
proceeding; where the code already behaves one way, that is the current
behaviour, not the decision. Answered questions stay, struck through, with the
answer and its date.*

**Open at 25 September 2026:** BD-02, BD-03, BD-04, BD-05, BD-06, BD-08, BD-10,
BD-11, BD-13. **Answered and retained:** BD-07 (by CR-05), BD-09 (by CR-08),
BD-12 (by CR-12).

| ID | Question | Blocks |
|---|---|---|
| **BD-02** | What is the post-signature correction/addendum mechanism (IMMUT-9)? Until it exists, a genuine error on a signed job card has **no remedy at all**. | IMMUT-9 |
| **BD-03** | `jobs.editSubmittedJob` now applies only to refused cards. Re-scope its name, or retire it? | cosmetic |
| **BD-04** | v2.0 §6 says the Order Number is mandatory; the code implements the three-valued DECISION 2 waiver. Which stands? | JOB-5 |
| **BD-05** | v2.0 §20 specifies Redis queues; the implementation uses a durable PostgreSQL outbox. Accept the substitution, or build Redis? | ARCH-2 |
| **BD-06** | Outcome B closes the job without **emailing** the unsigned copy to the customer. The old route emailed, because it went through `issueJobCard`; §15 puts customer delivery after the final **Master** submission, and outcome B is open to a Coordinator. Should closing without a signature send the customer their copy, and if so, under whose authority? The document is rendered, stored and downloadable either way. | REF-16 |
| **BD-07** | ~~After outcome A returns the card to `customer_signature`, **who** captures the signature?~~ **ANSWERED 25 September 2026 by CR-05(a).** The read-only rule is about a REFUSED job card, not about the technician. Once outcome A returns the card to the signature step there is no outstanding refusal, so the ordinary signature workflow resumes and the technician captures it exactly as they would have the first time. Held as ROLE-1 and proved end to end in `workflow-e2e.mjs`. | closed |
| **BD-08** | Should a technician be able to see that a colleague is *editing* a job card they handed over, or is "with the office" enough? Raised by CR-05(a): the technician now has a way back INTO a signed job card and may find it changed under them. | cosmetic |
| **BD-09** | ~~**There is no office fallback for a signed job whose technician cannot submit it.**~~ **RESOLVED 25 September 2026 by CR-08.** EJE chose the second option: the office may submit on the technician's behalf, audited against both, and ONLY when the technician is provably unavailable — a disabled account, or a whole-day absence on the availability register. It is an explicit exceptional action labelled *Take over submission*, it does not go through the office review workflow, and it cannot edit the signed job card. Held as TAKEOVER-1…14. | resolved |
| **BD-11** | **A technician who is present but cannot reach the system** — a lost, broken or flat tablet — is not modelled anywhere, so CR-08's condition cannot see it. Today the office's remedy is to put an absence on the calendar, which is deliberate and audited but describes the situation loosely. Is that acceptable, or should there be an explicit "cannot submit" state a Master can set on a job with its own reason? | TAKEOVER-1 |
| **BD-12** | ~~**MAY A TECHNICIAN ISSUE A PARTS COLLECTION?**~~ **ANSWERED 25 September 2026 by CR-12.** EJE chose option (b): a parts collection is counter work the OFFICE does, start to finish. `jobs.processParts` is held by the Master and the Coordinator and no longer by the technician, who is not part of the collection workflow at any point — not to accept one, not to process one, not to issue its note. The original question and its three options are kept below. Held as PARTS-14 and PARTS-15. Raised by the audit at `ca1cda7`, and **not decided here.** `jobs.processParts` is held by the Master, the Coordinator **and the technician**, so a technician can today accept a parts job and issue its collection note — while the prose of CR-05, CR-07 and SUBMIT-10 consistently describes a parts collection as counter work the OFFICE processes ("handed over at the EJE counter, not on a customer's site"). One of the two is wrong, and which one is a business question, not an implementation detail. **Current behaviour: a technician may.** Options: **(a)** confirm it — a technician at the counter is exactly who hands the goods over, and the prose is amended to say "whoever is at the counter"; **(b)** remove `jobs.processParts` from `TECHNICIAN_CAPABILITIES`, making parts strictly office work, which also removes a technician's ability to accept a parts job; **(c)** split the capability so a technician may process a collection they prepared but not one they did not | ROLE-5, SUBMIT-10, MOD-11 |
| **BD-13** | **DOES A PARTS COLLECTION KEEP ITS "COLLECTION DETAILS" FIELD?** Raised by CR-12 and **deliberately not decided**. The instruction listed five fields to remove from parts creation: *scheduled date, priority, assignment, Courier Collection, collection details*. Items 4 and 5 read as one subject — the courier answer and the courier information that goes with it, both of which moved to the Collection step — but "Collection details" is also the on-screen label the fault-description field takes on a parts job, and that field is printed on the collection note as **Notes**. The two readings differ in what the customer's document says. **Current behaviour: the field is KEPT and still required**, because removing a field that carries printed customer-facing content on an ambiguous reading is not a change to make silently — and because the document section of the same instruction lists what a collection note must contain without mentioning a description either way. Options: **(a)** keep it as it is; **(b)** remove it from creation and print no Notes section on a collection (the empty-section rule DOC-1 already handles that); **(c)** keep it but make it optional | PARTS-7 |
| **BD-10** | The `review` STATUS keeps its name although it is no longer an office review — it is where a signed job card waits for its own technician to submit it, and where a refused one waits for the office. Renaming it would touch stored history and would misdescribe the refusal case, so it was left; the rail therefore still reads *Review* between Customer Signature and Closed. Rename, or accept? | cosmetic |

---

## Retired behaviour, kept readable

`master_amended_after_signature` remains in `ActivityEventType` and nothing can
produce it. Jobs amended under the pre-CR-01 rule carry it, and v2.0 §17 asks
that historical records stay traceable — so the type is retired, not deleted.
`line-editing.test.ts` holds it unreachable.
