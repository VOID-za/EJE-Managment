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
| PROC-6 | **Work items live in GitHub Issues; this file stays the specification.** Each active requirement, audit finding and open business decision carries a GitHub issue titled with its ID, and that issue is where progress, evidence and approval are recorded. This file keeps the wording, the amendments and the rules. **The separate `eje-tracker` application and its database are retired** and no part of this project may depend on them, or on any replacement built in their place — see [`project-tracking.md`](project-tracking.md). Where the two disagree, this file is right about what is REQUIRED and the issue is right about where the work STANDS | 1 Oct 2026, PROJECT-TRACKING |

---

## Product mandate

Non-negotiable properties of the delivered system. These are not features to be
traded away in a batch; a release that does not have them is not the system EJE
asked for.

| ID | Mandate | Status | Detail |
|---|---|---|---|
| MANDATE-1 | **THE SYSTEM MUST BE USABLE OFFLINE.** The complete field workflow — reading the job, doing the work, capturing labour, travel, parts and photographs, writing the completion report, running the checklist and taking the customer's signature or recording their refusal — must work with no connectivity at all, and must survive the tablet being closed, locked, dropped or running out of battery. Work captured offline is not lost and is not silently overwritten when the tablet reconnects | **PARTIAL** — *amended 17 October 2026 by CR-09 Phase 4 step one* `0b1bf60`. The row read **NOT IMPLEMENTED**, which was true. What now works with no connectivity: reading the assigned job list, and capturing **labour, travel, parts and notes** on an in-progress job of the technician's own — held on the device, surviving the application closing and the battery going flat, sent in capture order when the signal returns, never duplicated, and never silently overwriting the server. What does NOT: opening a job's detail, photographs, the checklist, the completion report, and the customer's signature or refusal. **The mandate is not met, and it is not nearly met** — the words that matter in it are "the complete field workflow", and a technician cannot finish a job offline. See OFF-QUEUE-1…10 and the Phase 4 step-one scope. *Further amended 18 October 2026 by steps two and three* (`b813cc3`, `e1f9bc0`, `8201d30`, `92bed16`): add to what now works with no connectivity — ANSWERING the checklist (OFF-CHK-1), the completion write-up as a local DRAFT (OFF-WRITEUP-1), PHOTOGRAPHS held and uploaded later (OFF-MEDIA-1), and READING the detail of a job that was open (OFF-DETAIL-1). What still does not: COMPLETING the checklist, and the customer's signature or refusal — which is OFF-5, an unanswered business question rather than unwritten code. **The mandate is still not met**, and the remaining gap is now one decision and one gate rather than most of the workflow | CR-02, OFF-1…OFF-13, OFF-QUEUE-1…10, ACC-OFF-1…ACC-OFF-12 |
| MANDATE-2 | **THE SYSTEM MUST BE INSTALLABLE AS A TABLET APPLICATION.** It is installed to the home screen of a rugged Android tablet from the browser, launches standalone without browser furniture, reaches the camera, updates itself, and recovers after an interruption. A native Android/iOS application remains out of scope (v2.0 §26) — the installable PWA is how this is delivered | **PARTIAL** — *amended 17 October 2026 by CR-09 Phase 3* `a690dda`. The row read **NOT IMPLEMENTED** and that was true: there was no `public/` directory, no manifest and no service worker. There is now a web manifest, icons, a standalone display mode, a service worker with an application shell, an IndexedDB read cache, an update prompt that never applies itself mid-capture, and a camera/gallery capture that uploads real bytes. **It is not met, and will not be until somebody installs it on the rugged tablet:** every criterion that depends on the device itself — the launcher offering the install, the icon, the absence of browser furniture, the real camera, gloved use in daylight — is unproven, because headless Chromium has no home screen and no camera. See ACC-PWA-1…ACC-PWA-6 and PWA-8 | CR-03, PWA-1…PWA-8, ACC-PWA-1…ACC-PWA-6 |
| MANDATE-3 | **THE CUSTOMER MUST ACTUALLY RECEIVE THEIR DOCUMENT.** The final submission's purpose is to put the job card in the customer's hands. Until a production email adapter exists, no deployment does that — the send is simulated in every environment | **PARTIAL** — *amended 26 September 2026 by CR-09 Phase 1:* the adapter now exists and sends through Microsoft 365 `8479a69`. It is **not yet configured on any deployment**, so no customer has received a job card yet; a production deployment refuses rather than simulating. This mandate is met when Graph is configured and a live send has been verified  *Amended 18 October 2026 `b46dbc8`:* **THE DELIVERY RECORD WAS NEVER PERSISTED ON POSTGRESQL.** `delivery_attempts` was read by the job mapper and written by nothing at all, so what the provider said lived only in the object one request happened to be holding; the next read derived `not_started` from an empty table however recently Microsoft 365 had accepted the message. Three consequences, each visible to EJE: the office was told a customer's copy had not been sent when it had; `confirmJobCardDelivery` returns early with no message id, so **a job could never close on a confirmed delivery** — the one transition the handshake exists to make; and after a restart nobody could tell whether a copy had gone out, so a re-send risked a second copy. The repository now writes **one row per attempt, updated in place as that attempt moves** (sending → accepted → confirmed), because each step is another save of the same job — a row per save would make `attempts` count saves, and the unique index on (job, channel, attempt) would refuse it. A job nobody has tried to send still writes nothing, because `not_started` is the ABSENCE of an attempt. Four tests in `job-repository.db.test.ts` fail against the repository as it was; three more prove it through the real route, including that the job the API serves afterwards agrees with the row. **A failure now says which of nine things happened** (401, 403, throttling with its `Retry-After`, 5xx, an address Graph will not accept, the attachment limit, a document whose bytes are gone, a timeout, unreachable) and whether a retry can possibly work — the office had one button for all of them. **Every Graph request now carries a deadline:** there was none, so an endpoint that accepted the connection and went quiet held a technician's submission open indefinitely. **Two re-sends cannot send two copies:** simultaneous requests lose on the repository's version check (proved at the route), and a second press after the first committed its `sending` is refused by name, with the refusal expiring after ten minutes so a process that died mid-send cannot strand a customer's copy. **And the configuration says what is wrong with it:** the missing variables are named at startup and in the refusal the office sees — never a value — and `/api/health` reports the transport in one word so a deployment that cannot send is noticeable from outside. **STILL PARTIAL, and deliberately:** no live tenant was configured and no message was sent to a real mailbox. Everything above is proved against the real adapter driven by injected HTTP responses, which is the whole of what can honestly be tested without EJE's tenant  *Amended 18 October 2026 `1f82bae`:* **the classification reached nobody.** The adapter told the nine failures apart and the application threw the answer away, so the office had one button — *Send to the customer again* — and a sentence written by a mail provider. For four kinds that button works; for the other five it cannot until a credential is corrected, a permission granted, an address fixed, the document made smaller or the deployment configured at all. **The vocabulary moved into the DOMAIN** (`DeliveryFailureKind`, `deliveryRetryAdvice`, `isRetryableDeliveryFailure`), because whether the office can retry is EJE's question and not Microsoft's — and because a kind has to survive being written to a database and read on a screen, which an adapter's exception class cannot do. `deliveryFailureKindOf` on the PORT is how the application reads a kind off a thrown transport error without knowing which transport this deployment has: a transport that says nothing is recorded as UNCLASSIFIED rather than guessed at, and a kind an adapter invents is ignored. Persisted by migration `0012` as `delivery_attempts.failure_kind`, nullable and deliberately `text` rather than an enum (a new provider's failure mode must not need a migration, and an unrecognised string reads as unclassified rather than reaching a screen as something nothing can narrow), with a CHECK that a kind explains a FAILURE so an accepted or confirmed attempt cannot carry one. The screen keeps the provider's own words AND says either *Worth trying again* or *Something has to change first*, with what that something is; the audit trail carries the same advice. **The button is NOT hidden on an unretryable kind** — once the cause is fixed, that is exactly the failure the office should be able to retry — so what the kind changes is what they are told before they press it. **AND A SECOND REPORT THAT SAID SOMETHING NEW WAS BEING DROPPED:** `confirmJobCardDelivery` compared the STATE alone, so a provider that first said "too many requests" and then "the credential was refused" was ignored the second time and the office kept reading the first message on a job that could not be sent. Found by a browser test reporting two failures in a row; the comparison is now of everything a report carries, so an identical report still changes nothing (which keeps a replayed callback safe) and a changed one is applied. Evidence: 7 domain tests, 5 application, 3 on PostgreSQL (including the CHECK firing and an unknown string read as null), 2 through the route, 1 on the adapter, and a smoke step that reports a credential refusal and a throttle through the real route and asserts the screen's kind, its retryable flag, the wording and that the re-send is still offered | EMAIL-2, CR-09 Phase 1, DELIV-1…DELIV-6 |

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
***Phase 1 (a)–(e) IMPLEMENTED `8479a69`, 26 September 2026 — see DELIV-1…DELIV-6.
Phase 1(f) — BD-06 — remains OPEN, and DELIV-7 with it.***

***Phase 2 (a) and (b) are TESTED — awaiting approval: (a) `11f8c0e` (QA-1, and
AUD-10, the defect it found), (b) `5112482` (QA-3, and AUD-7, the defect IT
found). Phase 2(c) — CI, QA-4 — remains DEFINED. Phases 3 and 4 remain DEFINED —
NOT IMPLEMENTED; no code has been written for either.***

***MANDATE-3 is not closed by any of this.*** The adapter exists and the
submission path now reaches it on PostgreSQL, but **no deployment has configured
Graph**, so no customer has yet received a job card. What remains is not code:
the four `EMAIL_GRAPH_*` variables on a real tenant, and one live send verified
by the procedure in `docs/integrations.md`. Until then a production deployment
refuses to send and says so, which is the designed behaviour and not the mandate
being met.

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

### CR-13 — A collection is not raised on a description, and the old workflow is gone from the repository
*Confirmed 25 September 2026, resolving **BD-13**. Implemented `dba332d`
(see PARTS-17…PARTS-22).*

Two things, from one instruction.

**(a) The "Collection details" field is removed from parts creation.** BD-13
recorded the ambiguity and did not guess; EJE answered it. A collection is not
raised on a narrative: the goods listed on the note — part number, description,
quantity, price — are the record, and a free-text box above them said the same
thing again in worse words.

What follows from it, and is implemented rather than left dangling:

- `createJob` collects no description on an office-processed job, and **does
  not keep one a request carries**. A field job still requires one; that rule
  did not move, it only stopped being universal.
- The check moved **out of the API schema and into the operation**, because a
  rule that is true of some job types and not others belongs where the job type
  is known. A field job with a blank description is now a 422 with
  `fault_description_required` rather than a 400 malformed request. Still
  refused — refused for the right reason.
- The customer's document **omits the section entirely** rather than printing a
  heading over "No fault description recorded." — the same rule DOC-1 applies
  to the write-up. `JobCardModel.faultDescription` is `string | null`, and all
  three renderers skip it when it is null.
- **A collection raised before this keeps what it was given, and still prints
  it.** The model asks the RECORD, not the job type, so historical documents are
  unchanged. `EJE-1062`, a closed collection with a description, is the seeded
  proof.

**(b) The superseded implementation is removed, not left beside the new one.**
A repository-wide sweep for the old parts workflow — acceptance, assignment,
technician, scheduled date, priority, courier-at-creation, collection details,
labour, travel, call-out — found and fixed:

| | What was left behind | What was done |
|---|---|---|
| 1 | `canSubmitJobCard` asked `job.jobType === 'parts'` while every other collection rule asked `officeProcessed` — the same question written two ways | Now asks the definition. Identical behaviour today; one place to change tomorrow |
| 2 | `access.ts` and `workflow.ts` still said the submission exception was *"the same exception, in the same shape, as `acceptJobRefusal` and `canAcceptJob` already carry"* | Corrected: those two now REFUSE a collection outright |
| 3 | `AcceptJobFlow` explained its site-location branch in terms of parts being collected from the counter — a case that can no longer reach it | Comment corrected, and the guard kept deliberately with the reason recorded: it states a true rule for a future job type that is collected rather than attended |
| 4 | The active seeded collections still carried a description | `EJE-1064` and `EJE-2005` carry none, matching what creation now produces. The CLOSED ones keep theirs, which is what proves an older record still renders |
| 5 | The BD-12 row in this document had the answer and the original question run together, so it read as a contradiction | Rewritten with the answer first and the question and its three options kept beneath, verbatim |
| 6 | `job-workflow-api.test.ts` asserted the 400 the schema used to give | Rewritten to the new rule with the reason recorded in the test |

**Nothing was removed for tidiness.** The `master_amended_after_signature`
event type, the retired `submitted` status and every historical audit type stay
exactly as they are: history must remain readable, which is v2.0 §17 and the
standing rule of this document.

**NO DATABASE MIGRATION WAS REQUIRED, and it is verified rather than assumed.**
Every column the collection workflow touches already permits what it writes:
`scheduled_date date` and `primary_technician_id uuid` are nullable,
`fault_description` is `text DEFAULT '' NOT NULL` so an empty string is valid,
`priority` is always written (the job type's default), and `completion` is
already a member of the `job_status` enum. No CHECK constraint is affected —
`jobs_schedule_end_needs_start`, `jobs_courier_needs_waybill` and
`jobs_cancelled_has_reason` are all satisfied by a collection. Two tests in
`job-workflow.db.test.ts` now raise a collection **against real PostgreSQL** and
read the row back, so the claim is a fact rather than a reading of the DDL.

---

## Requirement register

### Finalized-job immutability (CR-01)

| ID | Requirement | Status | Commit | Evidence |
|---|---|---|---|---|
| CUST-NOTE-1 | **An account note can be written, and corrected** | **TESTED — awaiting approval** `433ee0c`. *Raised by the owner’s feedback of 23 October 2026 on the Customers screen.* `customer_notes` had existed since `0000` and **nothing could ever write to one** — the table was populated by the demonstration seed, persisted by the repository and rendered on screen, with no operation, no route and no control that added one. The office asked to keep account notes and could not. `customers.manage` writes them (a Master OR a Coordinator), trimmed and bounded in the operation because a schema has nothing to say about a note of three spaces, and audited with the text as a structured change value. **AN EDIT SAYS IT IS AN EDIT:** `edited_by`/`edited_at` (migration `0026`) are the whole schema change, and `author_id`/`created_at` are NOT touched, because they say who wrote the note and when — which an edit does not change. The previous wording survives on the audit trail and nowhere else, which is what a note is; an "edit" that changes no character records nothing. **AND THE TAB STOPPED LYING:** the Documents card beside the notes was hard-coded to "No documents uploaded … storage is simulated in this demonstration" while the REAL panel, holding real stored files with real checksums, sat on the Overview tab. Both real panels are now on the tab whose name promises them. 18 application tests, 9 over the real routes, 5 on PostgreSQL |
| JOB-OPT-1 | **A machine and a priority are not always known** | **TESTED — awaiting approval** `a4fe712`. *Raised by the owner’s feedback of 23 October 2026 on Create New Job.* Neither was optional on a BREAKDOWN or a TEST & REPAIR, for two different reasons: the machine requirement was INFERRED from `capturesLabourAndTravel` ("this type charges hours, so it is work on a machine"), and the priority column was NOT NULL with the form pre-selecting the type’s default — so every breakdown silently carried **"Urgent"**. `requiresMachine` and `requiresPriority` now state it per job type, true for an installation and a service and false for the rest. **NULL RATHER THAN A DEFAULT is the whole change:** a grading nobody chose is indistinguishable afterwards from a real one. What reads the absence, each handled rather than guessed: the badge says "Not graded", the sort puts it LAST (first would let an ungraded breakdown outrank a genuine Urgent one), the filter matches it under "All" and under no grade, the spreadsheet prints "Not graded" rather than a blank cell that reads as data loss, and **the customer’s job card OMITS the row** — "Priority: Not graded" on a signed document tells them about EJE’s internal paperwork. Migration `0027` drops NOT NULL and rewrites nothing. **And a parts collection finally says it has NO priority**, where it had been storing the type default on a job with no urgency to express. 18 application tests, 7 over the real routes, 4 on PostgreSQL |
| TR-1 | **The Test & Repair fields, and an optional fault description** | **TESTED — awaiting approval** `5d2b19f`. *Raised by the owner’s feedback of 23 October 2026.* Seven fields were listed; THREE ALREADY EXISTED (reference number, delivery note — relabelled "Delivery note / waybill number" as the owner wrote it — and the fault description) and FOUR ARE NEW in migration `0028`: the part number, description and quantity of the unit **booked in**, and the customer’s **quote number**. **The unit received is not `job_parts`**, which is what was CONSUMED in the repair and is priced — a customer sends in three identical sensors and EJE fit one new connector to each, two separate facts about one job, and collapsing them makes either the collection note or the invoice wrong. **THE QUOTE NUMBER IS ON TEST & REPAIR AND NOT ON PARTS**, which the owner struck out there; a request that sends one on another type has it CLEARED rather than refused, because a screen switching job type sends what it had. **THE FAULT DESCRIPTION IS OPTIONAL HERE** (`requiresFaultDescription`): a unit is booked in at the counter before anybody has diagnosed it, and what is recorded at that moment is the unit. Still required on a breakdown, an installation and a service, each of which sends a technician somewhere. Nothing new is mandatory; the quantity is nullable because it is the one value that can be genuinely absent, and a zero is refused by the schema and again by `jobs_repair_quantity_positive`. 14 application tests, 8 over the real routes, 5 on PostgreSQL |
| JOB-ATT-1 | **The new-job attachment control takes photographs and videos** | **TESTED — awaiting approval** `2cb378d`. *Raised by the owner’s feedback of 23 October 2026.* **The scope is checkable rather than hoped:** `POST /api/jobs/:jobId/attachments` has exactly ONE caller in the application — the Create New Job control — so narrowing the route narrows that control and nothing else. The Technical Library, the customer-document register and the machine-document register each have their own route, keep `validateUpload` and still accept a PDF; the job’s own media panel is a different route again. `validateJobMediaUpload` is the union of the photograph and video lists, and **the limit follows what the file actually IS** — the type is sniffed BEFORE the rule is chosen, so a video gets the 60 MB budget while a photograph is still held to 25 MB. Enforced on the BYTES: a PDF renamed `fault.jpg` is refused, and so is an executable called `fault.png`. The refusal ORDER is unchanged (empty, then size, then type), so an oversized PDF is reported as the wrong TYPE — converting it would not have helped. Nothing about storage, rollback, checksums or authorisation changed. 13 unit cases on the validator, 23 over the real route |
| COLL-1 | **Who is collecting is recorded at the collection** | **TESTED — awaiting approval** `47b2cfc`. *Raised by the owner’s feedback of 23 October 2026: the Counter Collection tick box must not be available until the job is finished.* **WHY IT IS NOT TIDINESS:** `showsPricesOnCollectionDocument` reads this flag, and who was EXPECTED is not who TURNS UP — a customer who said they would collect sends a driver often enough that an answer recorded at creation is a guess, and the cost of a wrong one is a COURIER HOLDING A DOCUMENT WITH THE CUSTOMER’S PRICES ON IT. The reasoning was already written down for a parts collection, which has never carried the answer from creation; this extends it to the workshop repair. Creation now writes `false` on **every** job type whatever the request sends, and `setCollectionMethod` REFUSES before `completion` (`isJobAtOrPastCompletion`), so a direct API request cannot set it early. The job type is answered FIRST, because a breakdown will never have a collection and "it is not completed yet" would send somebody to wait for nothing. **A GAP FOUND ON THE WAY:** that operation never called `assertEditable`, so the collection answer on a SIGNED job card could be changed — leaving the record and the customer’s document disagreeing. 10 application tests, 4 over the real routes |
| IMMUT-1 | The signed record is final | **DONE** | `947ef4f` | `isFinalized()`; `signed-job-immutability.test.ts` |
| IMMUT-2 | No Master may edit | **DONE** | `947ef4f` | refusal test, all mutations |
| IMMUT-3 | No Coordinator may edit | **DONE** | `947ef4f` | refusal test |
| IMMUT-4 | No Technician may edit | **DONE** | `947ef4f` | refusal test |
| IMMUT-5 | No reopen path exists | **DONE** | `947ef4f` | no reopen operation; `canEditJobRecord` false for signed/issued/closed |
| IMMUT-6 | Original PDF unchanged | **DONE** | `0002` | `final_documents_immutable` trigger |
| IMMUT-7 | Signature, labour, travel, parts, charges, checklist, notes, media unchanged | **DONE** | `0002` + `0007` + `11f8c0e` | six new triggers + column guard on `jobs`; proven at SQLSTATE `23001` |
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
| PARTS-7 | The creation form keeps **customer, site, contact, customer order number (required), reference number, delivery note, collection details and attachments** | **SUPERSEDED by PARTS-17**, 25 September 2026 (CR-13) | `9c0e303` | Kept for the history. Everything in it still holds EXCEPT *collection details*, which is removed |
| PARTS-8 | The close-out's first step is **Parts** — the goods, their quantities and their prices — with no completion write-up | **DONE** | `9c0e303` | `CompleteJobWizard.tsx`; `workflow-e2e.mjs`, `smoke.mjs` |
| PARTS-9 | The steps are **Parts → Review → Collection → Collector signature → Signed**, and Review is unchanged | **DONE** | `9c0e303` | `workflow-e2e.mjs` asserts the rail in order |
| PARTS-10 | **Courier or customer is asked at the Collection step, and nowhere else** | **DONE** | `9c0e303` | `setCollectionMethod`; creation forces `courierCollection: false` |
| PARTS-11 | The collector signs, on the collection declaration — unchanged | **DONE** | pre-existing | `parts-collection.test.ts` |
| PARTS-12 | **Submit collection note** issues the stored document and emails the customer once, through the existing outbox | **DONE** | pre-existing + `9c0e303` | `issueJobCard`; `parts-workflow.test.ts` |
| PARTS-13 | **Submission does NOT close the job.** It moves to `awaiting_delivery`, and only a CONFIRMED delivery closes it — the same rule as SUBMIT-5, and no second closed state | **DONE** | `9c0e303` | `parts-workflow.test.ts`; `workflow-e2e.mjs` |
| PARTS-14 | Both a **Master and a Coordinator** can do all of it, alone | **DONE** | `9c0e303` | `parts-workflow.test.ts`; `role-enforcement.test.ts` |
| PARTS-15 | A **technician** can do none of it: no acceptance, no processing, no submission | **DONE** | `9c0e303` | `access.test.ts`; `technician-submission.test.ts`; API refusals |
| PARTS-16 | **Field service is unchanged.** Breakdown, Installation, Service and Test & Repair keep their schedule, priority, assignment, acceptance, labour, travel, call-out, signature, submission, delivery, refusal and takeover behaviour | **DONE** | `9c0e303` | `parts-workflow.test.ts` drives a breakdown end to end; the whole existing suite is unchanged and green |

| PARTS-17 | The creation form keeps **customer, site, contact, customer order number (required), reference number, delivery note and attachments** — and **no description field of any kind** | **DONE** | `dba332d` | `jobs/new/page.tsx`; `workflow-e2e.mjs` asserts every field's presence and every removed field's absence |
| PARTS-18 | The server **collects no description on a collection and does not keep one a request carries** | **DONE** | `dba332d` | `createJob`; `parts-workflow.test.ts`; `parts-workflow-api.test.ts` |
| PARTS-19 | A **field job still requires one**, now refused as a business rule (422, `fault_description_required`) rather than as a malformed request (400), because the rule is per job type and belongs where the job type is known | **DONE** | `dba332d` | `createJob`; `job-workflow-api.test.ts`; `parts-workflow.test.ts` |
| PARTS-20 | The document **omits the description section entirely** when there is none — no heading, no "No fault description recorded." DOC-1, applied to the same field | **DONE** | `dba332d` | `model.ts` (`string \| null`); `job-card-pdf.ts`; `JobCardDocument.tsx`; `PartsCollectionNote.tsx`; `collection-document-parity.test.ts` |
| PARTS-21 | **A collection raised before CR-13 keeps its description and still prints it** — the model asks the record, not the job type | **DONE** | `dba332d` | `collection-document-parity.test.ts`; seeded `EJE-1062` |
| PARTS-22 | **No migration was required**, and the existing schema is proven to support the collection shape against real PostgreSQL | **DONE** | `dba332d` | `job-workflow.db.test.ts` — raises a collection, reads the row back, and asserts acceptance is refused |

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
| AUD-1 | **No production email adapter.** `src/server/runtime.ts` constructs `SimulatedEmailService` unconditionally — there is no branch, no configuration reader and no adapter. The customer is not emailed in any environment | **ACCEPTANCE BLOCKER** | **RESOLVED 26 September 2026** `8479a69` — `buildEmail` now selects Microsoft 365 through Graph where configured, and refuses in production where it is not. The finding is kept as it was written; what changed is the answer to it | EMAIL-2, MANDATE-3, CR-09 Phase 1 |
| AUD-2 | **Offline and PWA are at zero**: no `public/` directory, no manifest, no service worker, no IndexedDB, no mutation queue, no sync or conflict handling. `request-failure.ts` classifies a network failure as `offline` and says so, which is an error message, not offline capability | **ACCEPTANCE BLOCKER** | **PARTIAL — reduced, not closed, 17 October 2026 by CR-09 Phase 3** `a690dda`. *The finding is kept exactly as written; what follows is what is now true of each clause.* `public/` exists; the manifest is served at `/manifest.webmanifest` with icons that are real PNGs of the sizes they claim; `public/eje-sw.js` is a hand-written service worker that precaches the shell and the offline page and **refuses to cache anything authenticated**; the signed-in technician's job list is cached in IndexedDB, scoped to their user id and cleared on sign-out. **Still at zero, and deliberately: no mutation queue, no sync, no conflict handling** — that is Phase 4 and may not be built until the phase is scoped, because CR-02's promise about silent overwrites needs an agreed definition of a conflict and there is none yet. So a technician can READ offline and cannot CAPTURE offline, and the application says so rather than appearing to accept work it is dropping  *Further amended 17 October 2026 by Phase 4 step one* `0b1bf60`: "no mutation queue" is no longer true of the four append-only captures — labour, travel, parts and notes are held on the device and replayed with their own idempotency keys, with the server refusing a late capture against a job that has moved on. "No sync" and "no conflict handling" remain true of everything else, and a resolution POLICY is still absent (OFF-QUEUE-DEC-1). The finding stays an **ACCEPTANCE BLOCKER** for MANDATE-1: a technician still cannot run a checklist, write the report, photograph a fault or take a signature offline. *Further amended 18 October 2026 by Phase 4 step two* (`b813cc3`, `e1f9bc0`): the checklist can now be ANSWERED offline with a real conflict rule (OFF-CHK-1), the write-up is kept as a local draft (OFF-WRITEUP-1), and a refused capture has a resolution policy and an office screen (CAP-REF-1…5), so "no sync" and "no conflict handling" are no longer true. **It remains an ACCEPTANCE BLOCKER:** a technician still cannot complete a checklist, photograph a fault or take a signature with no signal, and no part of any of this has been run on the rugged tablet. | CR-02, CR-03, MANDATE-1, MANDATE-2, CR-09 Phases 3–4 |
| AUD-3 | **A signed job card with a genuine error has no remedy at any layer** | **ACCEPTANCE BLOCKER** | OPEN — **business decision BD-02** | IMMUT-9 |
| AUD-4 | **Closing Without Customer Signature sends the customer nothing.** The document is rendered, stored and downloadable; no delivery is attempted | **ACCEPTANCE BLOCKER** | OPEN — **business decision BD-06** | REF-16, CR-09 Phase 1(f) |
| AUD-5 | **No CI.** Every verification gate is run by hand, so a regression can reach the VPS unnoticed | **ACCEPTANCE BLOCKER** | **TESTED — awaiting approval, 18 October 2026** `43b4594`. `.github/workflows/ci.yml` runs every gate on every push, in three jobs: lint, typecheck, `npm test` and `npm run build`; `npm run db:test` against a real PostgreSQL 16 service container with a health gate; and the browser gates (`check-routes`, `e2e`, `smoke`) against a built application with Playwright's Chromium. No secrets are declared or needed, the database is disposable and created inside the job, `EJE_PERSISTENCE=demo` is stated so the browser gates cannot pick up a stray `DATABASE_URL`, and nothing is weakened to get a green tick — no `continue-on-error`, no skipped suite, no quarantine list. **What this does NOT do is deploy**, and the finding's own words — "can reach the VPS unnoticed" — are only half answered until the owner decides what gates a deployment. Still an ACCEPTANCE BLOCKER until then | ARCH-6, CR-09 Phase 2(c) |
| AUD-6 | **No PostgreSQL-layer test for submission, delivery or takeover.** The database suite stops at creation, acceptance and immutability; CR-07 and CR-08 are proven only against the in-memory repositories | **HIGH** | **TESTED — awaiting approval** `11f8c0e` — closed by QA-1. It was right, and AUD-10 is what it was right about: the first test ever to save a signed job on PostgreSQL found that none of them could be | CR-09 Phase 2(a), AUD-10, QA-1 |
| AUD-7 | **Three status writes bypass the state machine.** `captureSignature`, `recordSignatureRefusal` and `closeOnDelivery` write the status onto the saved record directly rather than through `transition()`. All three are legal edges today and each is guarded by its own preconditions, so no illegal state is reachable today — but `TRANSITIONS` is not what enforces them. **Investigate before changing** | **MEDIUM — no known defect** | **TESTED — awaiting approval** `5112482`. *Investigated 26 September 2026 under QA-3. The finding is kept exactly as written; what follows is what the investigation found, and it contradicts the last clause.* **AN ILLEGAL EDGE WAS REACHABLE.** `captureSignature` did carry a transition check, but it asked about the wrong edge — whether the job could move to `customer_signature` — and then wrote `review`. From `completion` that question reads as legal, so the check passed and the job landed on `review`, which is not an edge from `completion`: the Customer Signature stage was skipped and the state machine had approved something else. Measured through the real operations: from `in_progress` a signature was refused, from `completion` it **succeeded**. A **fourth** write had the same shape and this finding had not named it — outcome B of a refusal, which closes the job. All four now validate the edge they perform, `TRANSITIONS` is untouched, and `status-transitions.test.ts` fails without the change | CR-09 Phase 2(b), QA-3 |
| AUD-9 | **A refused cancellation and a refused deletion come back with different HTTP status codes** — 422 and 403 — because `delete_not_permitted` is listed in `PERMISSION_CODES` and `cancel_not_permitted` is not. Both are refusals and both leave the job untouched, so nothing is unsafe; it is an inconsistency in what a client is told. Found while writing CR-11's API tests, which assert the code each route actually returns rather than flattening the difference | **LOW — no unsafe behaviour** | **TESTED — awaiting approval** `a4ae3a8`. *The finding is kept as written.* **IT WAS WORSE THAN "AN INCONSISTENCY IN WHAT A CLIENT IS TOLD", AND NOT HARMLESS.** Each route carried ONE code for TWO causes, so each was wrong for half its cases: `delete_not_permitted` covered both and sat in `PERMISSION_CODES`, so deleting a SIGNED job card — impossible for anybody — answered 403; `cancel_not_permitted` covered both and sat outside, so a technician's refusal answered 422. **What the wrong code costs, stated accurately:** a 403 asserts the refusal is permanent for this actor, and `describeFailure` turns one into a fixed *"Your role does not include this screen"*, discarding whatever the server explained — neither is true of *"this job is assigned, so it cannot be deleted"*. The cancel/delete dialog is NOT where this showed: `useOperation` passes the server's message through whatever the status, so that screen read correctly. The defect is the fact in the response, and every consumer that branches on it — `isDenied`, retry decisions, and anything written against the API later. **The fix follows the rule already written in `errors.ts`** rather than choosing a code: the domain now returns `JobEndRefusal` with `kind: 'permission' | 'state'`, and the code follows the CAUSE — `*_not_permitted` → 403 (this actor may never), `*_refused` → 422 (this job, as it stands, carrying the sentence). Both routes behave the same way. A refusal still writes nothing: proved on real PostgreSQL — the row survives, and neither `job_deleted` nor `job_deletion_failed` is recorded | `errors.ts`; `end-unstarted-job-api.test.ts` |
| AUD-10 | **Submitting a signed job card fails outright on PostgreSQL.** `JobRepository.save` rewrites a job's children by deleting them and re-inserting (`replaceChildren`, `job-repository.ts:414`), and migration `0007_signed_job_immutability.sql` forbids DELETE on `job_labour`, `job_travel`, `job_parts` and `job_notes` once a signature exists. Every save of a signed job that carries one of those rows therefore raises `restrict_violation`, so `POST /api/jobs/:id/issue` answers **500** and the customer is never emailed. Both layers are individually correct and nothing is written wrongly — the transaction rolls back — but the submission cannot complete on the production backend at all. Reproduced through the real routes on real PostgreSQL while writing the IDEM-2 tests: a signed job with one labour line answers 500, the same job with no lines gets past it. **This is exactly the defect AUD-6 predicted**: the database suite stops before submission, so nothing has ever exercised a save of a signed job. Found 26 September 2026 | **ACCEPTANCE BLOCKER** | **TESTED — awaiting approval** `11f8c0e`. *Fixed 26 September 2026:* `save` now distinguishes the two ways a job is written — (A) editing an UNSIGNED aggregate, which still replaces the job-card children wholesale, and (B) persisting a WORKFLOW TRANSITION on a signed one, which writes none of them and verifies the caller is not asking it to. The predicate is the trigger's own: a signature ROW in `job_signatures`, not a signature on the object in hand. **Migration 0007 is untouched** — not weakened, not dropped, no row made deletable — and `signed-job-submission.db.test.ts` re-attempts each forbidden statement straight at the tables to prove it still bites. A caller that does alter signed evidence now gets `SignedJobCardAltered`, naming the collection, instead of a 500 from the driver | AUD-6, QA-1, MANDATE-3, IMMUT-7, CR-09 Phase 2(a) |
| AUD-8 | **Demonstration data cannot demonstrate a takeover.** In both seeds the technician on the signed job at `review` has either no absence or a **part-day** absence today — correctly keeping the exception shut — so there is no seeded job the office may actually take over. A demonstrator must first record an all-day absence, which is what `workflow-e2e.mjs` Part 22 does. Related: `src/db/seed/jobs.ts:1145,1149` still describes EJE-2025 as *"Waiting on a Master's final submission"*, which CR-07 removed, and `finalDocument.simulated` is still `true` on a document whose bytes are real — only the email is simulated | **LOW — documentation and demo data** | OPEN | DEMO-5, CR-08 |

### CR-09 — customer delivery and production readiness (DEFINED, not implemented)

*Added 25 September 2026. **No code has been written for any of these.** They
are the agreed shape of the next batch, recorded before implementation so that
the implementation can be checked against something.*

**Phase 1 — the customer receives the document**

| ID | Requirement | Status |
|---|---|---|
| DELIV-1 | A **production email adapter** exists behind the existing `EmailService` port, selected from configuration exactly as `buildWhatsApp` selects the WhatsApp adapter | **DONE** — GraphEmailService, selected by chooseEmailTransport exactly as buildWhatsApp selects WhatsApp, `8479a69` |
| DELIV-2 | The **simulated adapter is retained** and is what the demonstration and the test suites use. A deployment never silently falls back to it: an unconfigured production deployment refuses and says why, as `UnconfiguredWhatsAppService` does | **DONE** — SimulatedEmailService retained for the demonstration and the suites; a production deployment with no Graph configuration gets UnconfiguredEmailService, which refuses and names what to set, `8479a69` |
| DELIV-3 | **An accepted send is not a delivery.** The adapter may report `pending_delivery` and nothing else until the provider says otherwise; only a confirmed delivery closes a job (SUBMIT-5 is unchanged) | **DONE** — every adapter returns pending_delivery on acceptance; no adapter can return delivered; `email.test.ts` asserts it for Graph, SMTP and the refusal, `8479a69` |
| DELIV-4 | A **failed send is reported and retryable**, re-sending the STORED document rather than rendering a new one (SUBMIT-12 unchanged) | **DONE** — a throwing adapter is caught in performIssue and recorded as a failed delivery with its reason; the re-send sends the STORED document, unchanged, `8479a69`. *Amended 18 October 2026 `b46dbc8`:* the failure is now CLASSIFIED — nine kinds, four of which a retry can resolve and five of which it cannot — and the reason the office reads says which. A re-send while an attempt is still with the provider is refused rather than sending a second copy of a signed job card |
| DELIV-5 | **Provider reports drive the delivery handshake** through the existing outbox and `/api/outbox/[messageId]/delivery`, gated as it is today | **DONE** — deliveryState drives awaiting_delivery → closed through the existing outbox route, gated as before, `8479a69` |
| DELIV-6 | **The production configuration is documented** — every variable, what happens when each is absent, and how to verify a live send without sending a customer a test job card | **DONE** — docs/integrations.md — every variable, what each absence does, and how to verify a live send without emailing a customer; .env.example, `8479a69` |
| DELIV-7 | **BD-06 is answered and recorded in this document BEFORE any unsigned-copy delivery is implemented** | **DEFINED — blocked on BD-06** |

**Phase 2 — protect what exists**

| ID | Requirement | Status |
|---|---|---|
| QA-1 | PostgreSQL-layer tests for **submission**, **delivery** and **takeover**, including the audit rows each writes | **TESTED — awaiting approval** `11f8c0e` — `src/server/api/signed-job-submission.db.test.ts`: submission with each kind of signed evidence in turn and all of them together (`pdf_generated`, `job_submitted`, `delivery_state_changed`), delivery (confirmation does NOT close a job nothing has confirmed; a re-send sends the STORED document), and takeover (`submission_taken_over` beside `job_submitted`, on a whole-day absence). Written because AUD-10 proved the gap was not theoretical: the submission path had never once run against PostgreSQL |
| QA-2 | A **duplicate submission** is tested, not merely refused by a status guard (closes the untested half of IDEM-2) | **DONE for the demonstration backend and the application layer** `9f352cd` — and the wording was right: the status guard was reading the caller's copy, so two concurrent requests both passed it. *Amended `5112482`:* it read **Not closed against PostgreSQL, which AUD-10 blocks** — and AUD-10's fix `11f8c0e` unblocked it. A duplicate submission is now proven on real PostgreSQL too, in `signed-job-submission.db.test.ts`: two concurrent submissions leave one `job_submitted` event and one `final_documents` row, and a second submission after the first has committed is refused 422 `not_ready_to_issue` |
| QA-3 | The three status writes in AUD-7 are **investigated and reported on before any change is made**. If they are left as they are, the reason is recorded here | **TESTED — awaiting approval** `5112482`. **Investigated, and they were NOT left as they were, because the investigation found the audit's reassurance to be wrong** — see AUD-7. They now validate the edge each one actually performs. `TRANSITIONS` is unchanged: no edge was added, removed or widened |
| QA-4 | **CI** runs lint, typecheck, `npm test`, `npm run db:test` and `npm run build` on every push (ARCH-6) | **TESTED — awaiting approval** `43b4594`. All five, plus the three browser gates QA-4 left as a decision to record. **The decision is IN CI:** those are the only gates that exercise the service worker, IndexedDB, the offline queue and the tablet flows, and a manual-only gate for the features most likely to break is not a gate |
| QA-5 | **No test may depend on the calendar.** A suite that passes in September and fails in October proves nothing about the code it was written to protect | **TESTED — awaiting approval** `e121558`. *The finding is kept as it was written, 1 October 2026:* `closed-jobs.test.ts` → *excludes a job closed after the to-date* asked for jobs closed up to the literal `2026-04-01` while the seed closes EJE-1044 at `timeOffset(-180)`, which is 31 March on 27 September and 4 April five days later. It passed at `28557da` and failed at `9f7d5f6` with no code change between them. **THE FINDING UNDERSTATED ITSELF: THERE WERE THREE SITES, NOT ONE.** The suite was re-run with the clock pinned to five future dates, which is what found the other two: the sibling test *excludes a job closed before the from-date* (literal `2026-09-01`, failing from early 2027) and **`scripts/smoke.mjs`, which filled the archive's *Closed to* with the same `2026-04-01` against the same relative seed** — already wrong today, and hidden on 1 October only because the smoke run drove a server process whose seed dates had been computed on 27 September. All three now derive the boundary from the fixture's own `closedAt`, using `slice(0, 10)` — the same expression `closedOn` uses in `closed-jobs.ts`, so the test compares what production compares and no timezone can open a gap. The browser step reads it from `GET /api/jobs/closed` rather than guessing. **No assertion was loosened:** breaking the `closedFrom`/`closedTo` filters in `closed-jobs.ts` still fails all three date tests. *Not a defect, and deliberately left alone:* `primitives.test.ts` → *charges an unknown account a real verification* asserts `Date.now() - started > 1` to prove the sign-in path does not early-return for an unknown address. It fails under a frozen clock because it MEASURES time rather than reading a calendar; that is the harness's artefact, not the test's fault. `dev-console-check.mjs` types a literal `Closed from` but asserts nothing about the rows, so it cannot rot | 16 Oct 2026, QA-5 |
| QA-6 | **No test may depend on another test's leftovers.** A suite whose result depends on which file ran first is not a test of the code | **TESTED — awaiting approval** `0b34ea7`. *Found 17 October 2026 by investigating the unexplained `8 failed | 194 passed` run recorded on issue #23 — and it was NOT a flake, NOT PostgreSQL's cold start and NOT a defect in BACKUP-2's application code.* `backup.db.test.ts`'s BACKUP-2 block never opened, seeded or truncated a database: it read whatever `storage_key` rows happened to be in `eje_test` and built its storage directory from them. Every `*.db.test.ts` file drops and rebuilds the schema in its own `beforeAll`, so what is left behind depends on vitest's FILE ORDER — which is not stable, because it uses the previous run's timings and a run with no cache orders them differently. On such a run the block found no storage keys, wrote no files, and `npm run backup` refused — **correctly** — with *"holds no files at all"*, failing 8 tests and appearing to blame the command under test. **Reproduced** by restarting PostgreSQL and clearing `node_modules/.vite`: `8 failed | 194 passed`, exit 1, the same signature as the original. **Fixed** by giving the block its own `openTestDatabase` + `truncateAll` + `seedBaseline` and two seeded `machine_photos` rows, and by making the fixture helper THROW when it finds no keys, so an empty fixture names itself instead of being reported as a refusal. **Discriminating:** with the old file against a database holding zero storage keys, the 8 failures return; with the new file against the same database, 18/18 pass. Afterwards the same cold-start condition gives **202/202, exit 0** | 17 Oct 2026, QA-6. *Sweep completed 17 October 2026, and it found nothing further.* All **14** `*.db.test.ts` files were checked three independent ways: **(1) in isolation** — each file run alone against a database whose schema its own `beforeAll` drops, which is the condition a cross-file dependency cannot survive: 14/14 pass, 204 tests, the same count as the full suite; **(2) structurally** — every file calls `openTestDatabase`, `truncateAll` and `seedBaseline`, and the only ambient `psql` read left in the suite is `backup.db.test.ts`'s, which now reads rows it seeds itself; **(3) order-independently** — the full suite with `--sequence.shuffle.files` at two seeds, 204/204 each, plus a cold start with `node_modules/.vite` removed, 204/204. **Scope of the claim:** this covers cross-file coupling through the shared database and through file order. It does not audit coupling through time (QA-5 owns that) and it is not a claim that no other kind of coupling exists — the one defect of this class was found because it FAILED, not because a reading of the files predicted it |

**Phase 3 — the PWA foundation**

| ID | Requirement | Status |
|---|---|---|
| PWA-5 | An **application shell** that renders without a network round trip | **TESTED — awaiting approval** `a690dda`. `public/eje-sw.js` with its rules in `src/lib/pwa/shell.ts`, which is the part worth reading: the rules are TypeScript the test suite can reach, and `shell.test.ts` reads the worker file and fails if the two have drifted apart. The worker caches the build's content-hashed `/_next/static/…` chunks, the icons, the manifest and `/offline` — **and nothing else.** It stores no HTML, because every page of this application is rendered for one signed-in person; it stores nothing under `/api/`, because the Cache API is readable by any script on this origin and outlives a sign-out, so a cached job card is a customer's document left on a shared tablet. The offline page is precached **with its own JavaScript chunks**, read out of the stored HTML, because a cached document whose scripts are not cached renders as an empty frame and reads as a broken application rather than as a tablet with no signal |
| PWA-6 | An **IndexedDB read cache** for the signed-in technician's assigned jobs and the reference data they need to read them | **TESTED — awaiting approval** `a690dda`. `src/lib/pwa/job-cache.ts`, written through on every successful job-list read and read back only when the server could not be reached. **A failure never empties it:** the last good copy is the valuable thing on a field device. Three things are deliberate. (1) **The projection is a whitelist** (`cached-job.ts`), built field by field rather than from a spread, so the next field somebody adds to a job summary is not silently cached on every tablet in the field; it carries no identifiers, no signature refusals, no document pointer and no contact details. (2) **Every record is keyed by user id** and `clearCachedJobs` empties the store outright on sign-out or a revoked session, so one technician's work cannot reach the next person on a shared tablet. (3) **The screen must say which copy it is showing** — `cache-state.ts` computes that from facts, and weighs the outcome of a real request above `navigator.onLine`, which reports true on a plant WiFi with no route out. An empty cache says *this tablet holds no copy*, never an empty list that reads as "no jobs today". **What is NOT cached:** job detail, captured work, signatures, documents and media. Reading one job offline is Phase 4 |
| PWA-7 | An **update mechanism**: a new version is picked up and applied without the tablet being reinstalled, and never mid-capture | **TESTED — awaiting approval** `a690dda`. The worker installs quietly and **waits** — there is no unconditional `skipWaiting()`, which `shell.test.ts` asserts — and `ServiceWorkerManager` offers a bar reading *A new version of EJE is ready… finish what you are capturing first.* Nothing reloads until a technician taps. Waiting is safe because the running worker keeps serving the build the page already has and Next content-hashes its chunks. `/eje-sw.js` is served `no-store` and registered with `updateViaCache: 'none'`, both needed: a worker a browser serves from its own HTTP cache is a build that cannot be replaced. A browser with no service worker support gets no bar, no error and no degraded screen  *Amended 18 October 2026* `660f2ad`: **not applying the update mid-capture was never enough.** The bar is `sticky top-0`, so APPEARING pushes everything below it down by its own height — on a tablet that is the signature pad sliding out from under a stylus mid-stroke, or *Confirm signature* moving under a thumb already on its way to it, which is a mis-tap on the one screen where a mis-tap is a customer signing the wrong thing. `src/lib/pwa/capture-lock.ts` is a COUNTER (not a boolean: a photograph uploading while the write-up is being typed is two captures, and the first to finish must not unlock the other) held by the three capture surfaces — the signature pad for its whole life, the write-up while an edit is `pending`, `saving` or `failed`, and a photograph from being chosen until it is sent, held or discarded. The bar reads it DURING RENDER, so it cannot appear even for one frame. The waiting worker is untouched either way. `capture-lock.test.ts`, 6 tests |
| PWA-8 | **Tablet installation is documented and demonstrated** on the target rugged Android device | **PARTIAL** `a690dda` — **documented, NOT demonstrated**, and the one Phase 3 row automation cannot close. [`docs/tablet-installation.md`](tablet-installation.md) carries the server conditions that have to hold first (HTTPS, one origin, a production build), the install steps for Android and for iOS, what to do when *Install* is not offered and why, a numbered on-device check list tied to each ACC-PWA criterion, and the three sentences a technician should actually be told. What exists in the application is everything the tablet needs from this side, proved in a real browser by `scripts/smoke.mjs`: the manifest is linked and installable, the 192px icon resolves and has bytes, the worker registers and activates, the shell is cached, nothing authenticated is, the job list survives the network being switched off, and signing out leaves nothing behind. What remains needs the device: the launcher offering *Install*, EJE's icon on the home screen, a standalone launch with no browser furniture, the real rear camera, and gloved one-handed use in daylight |

*PWA-1…PWA-4 are below and are no longer unchanged — see their rows and the
dated amendment under them. Phase 3 delivered PWA-1, PWA-2, PWA-3, PWA-4 and
PWA-5…PWA-7; PWA-8 stays open until the rugged tablet is in somebody's hands.*

**THE PHASE 3 / PHASE 4 BOUNDARY, stated so nobody has to infer it** *(recorded
17 October 2026, `a690dda`)*. Phase 3 is a READ cache and an installable
shell. It contains, deliberately and without exception:

| | Phase 3 built this | Phase 4 owns this |
|---|---|---|
| Jobs | the assigned-job LIST, cached and labelled with when it arrived | one job's full detail offline, and the captured work on it (OFF-1) |
| Capture | photographs uploaded to the real route, which fail honestly with no signal | capturing labour, travel, parts, notes, checklists and photographs offline (OFF-2…OFF-4) |
| Signature | nothing | offline signature and refusal capture (OFF-5) |
| Writes | none. There is no queue, no replay, no Background Sync registration, and `shell.test.ts` fails if one appears | the mutation queue, ordered replay, partial-failure handling (OFF-6, OFF-7) |
| Conflicts | nothing, because "conflict" has no agreed meaning for a job card yet | detection, who decides, and the rule that nothing is silently overwritten (OFF-9) |
| Session | a device-local pointer to the session the server last CONFIRMED, which grants nothing and unlocks only read-only data this device already holds | offline authentication and keeping a session through a shift with no signal (OFF-10) |
| Reconnect | the next successful read replaces the cached copy | what syncs first, what the technician sees, what they may do during it (OFF-11) |

**Nothing in Phase 3 may be read as a down payment on an offline capture
policy.** The one decision Phase 3 does make is to tell the truth: a capture
that could not reach the server is reported as having failed, nothing is
queued, and nothing is written locally.

> **AMENDED 17 October 2026 — PHASE 4 STEP ONE IS NOW SCOPED AND BUILT**
> `0b1bf60`. The paragraph above is kept because it described the system
> accurately at `f0f4302`. Four of those captures now ARE held on the device;
> everything else in the table above stands exactly as written. The scope of
> what changed, and the reasons for every boundary, is the section immediately
> below. **Owner approval is outstanding** — this is TESTED, not APPROVED.

### CR-09 Phase 4, STEP ONE — holding four append-only captures (OFF-QUEUE-1…10)

*Scoped and implemented 17 October 2026, `0b1bf60`. Phase 4's precondition —
that it "MUST be separately scoped in this document before any of it is
implemented" — is met by this section, written in the same batch as the code it
describes (PROC-1). It is a STEP, not the phase: the phase's hard question
(what a conflict is, and who resolves it how) is **not answered here** and is
carried as an open business decision.*

**The one shape of offline write this allows.** Labour, travel, parts and notes
are APPEND-ONLY: each is a new row. Replaying one late cannot erase or
contradict anything the office did in the meantime, so there is no merge to get
wrong and nothing of the server's to overwrite. That is the whole reason these
four, and nothing else, may be captured with no signal.

| ID | Requirement | Status |
|---|---|---|
| OFF-QUEUE-1 | **The four append-only captures may be taken with no connection** — labour, travel, parts, notes — on a job that is `in_progress`, unsigned, and assigned to the technician holding the tablet | **TESTED — awaiting approval** `0b1bf60`. `src/lib/pwa/offline-rules.ts` holds the contract as data and as functions the test suite reads; `offline-rules.test.ts` asserts the allowed set is exactly those four and names every refusal individually |
| OFF-QUEUE-2 | **The server is tried first, always.** A capture is held only when the request could not leave the tablet | **TESTED — awaiting approval** `0b1bf60`. `useOfflineCapture`: when `navigator.onLine` is false the attempt is skipped (a doomed thirty-second timeout helps nobody in a basement); otherwise the request is made and only a transport failure falls back to holding it |
| OFF-QUEUE-3 | **A held capture is never presented as saved.** The screen says it is on this tablet and not on the server, and keeps saying so until the server has it | **TESTED — awaiting approval** `0b1bf60`. The capture panels say *Held on this tablet… not on the server yet*; `PendingWorkPanel` sits above the job's tabs so it is visible from every one of them; the offline page names the count for a tablet that has been restarted |
| OFF-QUEUE-4 | **Each capture carries its own idempotency key, minted once**, so sending it again cannot double it | **TESTED — awaiting approval** `0b1bf60`. The key is minted BEFORE the first attempt and stored with the row — which is what makes the dangerous case safe: a request that committed on the server and lost its answer on the way back is replayed, not repeated. Proved over HTTP in `queued-capture-api.test.ts` and in the browser in `scripts/smoke.mjs`  *Amended 18 October 2026* `8f0b883`: **the replay is now proved against real PostgreSQL**, which is the only place the transaction boundary and the persisted key exist — `offline-replay.db.test.ts`, 5 tests: the same held capture sent twice adds one line and the second answer carries `Idempotent-Replay`; two sends arriving TOGETHER (a flush racing a reconnect) still leave one line and one key row; one technician's key cannot answer another's request or reach a job that is not theirs, and the line stays attributed to its own technician (the shared-tablet case); a capture whose job was REASSIGNED while the tablet was away is refused 422 identically on every retry, with nothing written and no idempotency record left to answer the retry from; and a flush from a session revoked while the work waited is refused 401 and writes nothing. **422 and not 404 on the reassignment, deliberately:** the technician may still READ the job they worked on (DECISION 5), so hiding it would be a lie — what they may no longer do is capture against it, and the tablet reads 422 as "a person must decide" and refers it to the office |
| OFF-QUEUE-5 | **Order is capture order**, one request at a time | **TESTED — awaiting approval** `0b1bf60`. `usePendingWork` sends oldest first (ACC-OFF-7) |
| OFF-QUEUE-6 | **The server remains the authority on replay.** A job signed, closed, transferred or reassigned while the tablet was away REFUSES the work; the refusal is the server's own and is shown in its own words | **TESTED — awaiting approval** `0b1bf60`. Nothing in the queue re-implements a rule: `assertEditable` and `assertCanCapture` run on the replay exactly as they do online. `queued-capture-api.test.ts` covers the signed job, the transfer, the revoked session and invalid details |
| OFF-QUEUE-7 | **Nothing is ever discarded on the technician's behalf.** A refused capture is kept, labelled, and resolved by a person | **TESTED — awaiting approval** `0b1bf60`. A refusal stops that job's queue (the rest would be refused identically) and leaves the row for a decision; discarding is an explicit confirmed action whose dialog says the work will be lost, because it will. CR-02 |
| OFF-QUEUE-8 | **Held work survives the application closing, the tablet restarting and the battery going flat** | **TESTED — awaiting approval** `0b1bf60`. IndexedDB, in its own store, keyed by user. `clearCachedJobs` deliberately does NOT touch it — the cache is a copy of what the server has, this is the only record of work it does not. Proved in the browser: captured offline, reloaded, still held, then sent |
| OFF-QUEUE-9 | **Signing out does not silently strand unsent work.** The count is named, and the work is kept for that technician | **TESTED — awaiting approval** `0b1bf60`. The profile menu asks before signing out and says the captures stay on the tablet for the next sign-in. **See OFF-QUEUE-DEC-2: whether keeping them is the right answer on a shared tablet is a business question** *Answered 18 October 2026 by BD-16, `b813cc3`: keeping them is the answer, bound to the user who captured them — and the dialog now says whose they are and that the next person will not see them. See OFF-SEC-1, and OFF-SEC-2 for the defect this uncovered.* |
| OFF-QUEUE-10 | **Everything else stays online-only, and says which thing it is and why** | **TESTED — awaiting approval** `0b1bf60`. `ONLINE_ONLY` in `offline-rules.ts` carries a reason per action: the completion report and the call-out flag replace values; the checklist replaces an answer and is gated against the template; signatures and refusals are OFF-5; transitions are the state machine; media is bytes (OFF-12). *Amended 18 October 2026, `e1f9bc0`:* a checklist ANSWER left this list for OFF-CHK-1, once the capture could say what it was answering; COMPLETING the checklist and its EVIDENCE did not, and nor did anything else |

**What step one deliberately does NOT contain**, each for a reason that is not
"we ran out of time":

| Not built | Why |
|---|---|
| Offline job DETAIL | The list is cached; one job's full record is not (PWA-6's boundary, unchanged). A technician may capture against the job they are standing at, from the screen they already have open |
| Offline checklist answers | An answer REPLACES the previous one and completion is evaluated against the template. Both need OFF-9 — *answered 18 October 2026: the answer is now holdable (OFF-CHK-1), completing it is not* |
| Offline completion report | Replaces a value. The same overwrite problem — *amended 18 October 2026: kept as a local DRAFT that nothing replays (OFF-WRITEUP-1); `save_report` is still online-only* |
| Offline signature or refusal | OFF-5, and the most consequential record in the system |
| Offline photographs | Bytes, not fields: OFF-12, and megabytes held on a device with no agreed retention rule |
| Background Sync / a service-worker replay | A worker replaying writes with no screen to report to decides OFF-9 by default. `shell.test.ts` still fails if a `sync` handler appears |
| Automatic conflict resolution | There is none, and there must not be one before OFF-QUEUE-DEC-1 is answered |

**The honest summary of what a technician can do with no signal, as of this
batch:** read their assigned job list (Phase 3), and record labour, travel,
parts and notes against a job of theirs that is in progress — with the screen
saying plainly that those records are on the tablet and not on the job. They
cannot answer a checklist, write the report, photograph anything, or take a
signature. ACC-OFF-2 is therefore **partially met**, and ACC-OFF-3 through
ACC-OFF-12 are not met.

> *Amended 18 October 2026 by step two (`b813cc3`, `e1f9bc0`): the checklist can
> now be answered and the write-up typed as a local draft. The paragraph above
> is kept because it described the system accurately at `65703fa`; the current
> summary is at the end of the step-two section below.*

### CR-09 Phase 4, STEP TWO — the office's decision, the shared tablet, and the checklist (CAP-REF-1…5, OFF-SEC-1…2, OFF-CHK-1, OFF-WRITEUP-1)

*Scoped and implemented 18 October 2026, `b813cc3` and `e1f9bc0`, after EJE
answered BD-14, BD-15 and BD-16. Step one deliberately left the phase's hard
question — what happens to a capture the server refuses — as an open business
decision, and said that no automatic resolution of any kind could be added
before it was answered. It has been answered, so this is the step that acts on
the answer.*

**What EJE decided, in their own terms, and what each decision became:**

- **BD-14 — a technician may photograph an official machine, and may not change
  it.** The photograph is reached from the JOB, which is also what authorises
  it: the request names the job, and the server checks that the job is on this
  machine, has the actor on its crew and is still live. Held as MACH-PHOTO-3.
- **BD-15 — a refused capture is retained and referred to the office.** Held as
  CAP-REF-1…5.
- **BD-16 — unsent work is retained under its owner's identity and restored
  only when that user authenticates again.** Held as OFF-SEC-1…2.

| ID | Requirement | Status |
|---|---|---|
| MACH-PHOTO-3 | **A technician photographs the machine they are standing at, from their own live job — and the machine RECORD is untouched** | **TESTED — awaiting approval** `b813cc3`. BD-14. `addMachinePhoto` takes an authorising job: it must exist, be on this machine, carry the actor on its crew and not be closed or cancelled. Nothing about the register was widened — a technician still cannot open `/machines`, cannot edit a field, cannot approve a machine, and is refused (403) on a machine they have no job on. The audit line is `machine_photographed` and names the job; no field, no approval and no history changes. The panel on the job screen says, in words, that a photograph does not change the record — because a technician who believes a photograph corrected the serial number stops reporting that the serial number is wrong. Proved in `machine-photo-api.test.ts` (20 tests, five of them this rule) and in a real browser |
| CAP-REF-1 | **A capture the server refuses is RETAINED and referred to the office**, with its own idempotency key and the server's refusal in the server's own words | **TESTED — awaiting approval** `b813cc3`. BD-15. `capture_referrals` (migration `0010`), with `(technician_id, idempotency_key)` unique in the database, so one capture cannot become two referrals. The job is not touched by a referral: it refused the work and it still has not got it |
| CAP-REF-2 | **The office decides, and both outcomes are recorded.** `applied` puts the work on the job THROUGH THE ORDINARY OPERATION; `no_action` requires a reason | **TESTED — awaiting approval** `b813cc3`. The apply runs the real command from the closed registry under the office's own authority, so `assertEditable`, `assertCanCapture`, the state machine and the audit trail all apply exactly as they would to a line captured by hand. **A job that still refuses leaves the referral OPEN** — a refusal is never laundered into a resolution — and the office is told what the job said. Resolving is a conditional update, so two office users deciding at once produce one decision and one refusal, proved on real PostgreSQL |
| CAP-REF-3 | **Nothing replays after a referral.** The office has it; the tablet neither retries it nor offers a retry | **TESTED — awaiting approval** `b813cc3`. The row's state becomes `referred`, the flush skips it, the panel removes *Try again* and the local row leaves only once the referral is resolved — with a notice saying it was dealt with, rather than a row vanishing silently |
| CAP-REF-4 | **One capture, one referral.** Referring twice is the same problem arriving again | **TESTED — awaiting approval** `b813cc3`. Idempotent on `(technician, idempotency key)` in the operation and in the database |
| CAP-REF-5 | **No new role, no new global access, and no new job status** | **TESTED — awaiting approval** `b813cc3`. One narrow capability, `captures.resolveReferral`, held by the existing Master and Coordinator — not `admin.access`, and refused to a technician (403), who may read their OWN referrals and nothing else. A referral is a record of a capture that could not be applied; it says nothing about where the job has got to, so the job's status is untouched |
| OFF-SEC-1 | **Unsent work is bound to the user who captured it, and is reachable by nobody else** | **TESTED — awaiting approval** `b813cc3`. BD-16. Every write to the pending store names the user it acts for and refuses a row belonging to anybody else, so a second technician on the same tablet cannot send, retry, requeue or discard the first one's work — enforced in the store rather than by hiding a button. The sign-out dialog says the work is kept under its owner's name and that the next person will not see it. **No credential, session cookie or access token is written to the device**, and this claims no encryption: the account boundary is the application's, the device boundary is the tablet's own screen lock and EJE's device policy (`docs/tablet-installation.md`). Proved in a real browser: user A's capture survives A's sign-out, is invisible and unsendable to B, and is sent when A signs in again |
| OFF-SEC-2 | **A sign-out made with no signal does not leave the session usable** | **TESTED — awaiting approval** `b813cc3`. *A defect found while proving OFF-SEC-1, and the most serious thing in this batch.* The sign-out post failed offline, so the session was never revoked — and because the cookie is HttpOnly and cannot be deleted by the page, the next page load asked `/api/auth/me` and signed the previous technician straight back in. A tablet handed over at the gate carried their identity. The device now records the sign-out, the application refuses to adopt the session while that record stands, and the logout is delivered as soon as the server can be reached; the sign-in screen says so. The cookie remains valid server-side until that happens, which the record says plainly rather than claiming a revocation it cannot perform |
| OFF-CHK-1 | **A checklist ANSWER may be held with no signal** — the first offline capture that is not append-only | **TESTED — awaiting approval** `e1f9bc0`. This is OFF-9's conflict rule, built rather than deferred. The capture carries what it was answering: the checklist INSTANCE (`templateId`, `templateVersion`) and the answer it replaces (`expectedAnsweredAt`, the stamp the device last saw). The server refuses it if either has moved, so a stale answer is retained and referred to the office (CAP-REF-1) instead of overwriting somebody else's — and an answer is **never** moved onto a different version of the checklist, by a tablet or by an office resolution, because the wording answered is the wording the customer's document reports. The template's own rules are applied before the device holds anything: an item with no value is not held, and a failure with no note is not held. A held answer is labelled as held and is NOT counted in the progress figure. Online callers send no expectation and are unchanged. Proved in `offline-checklist-api.test.ts` (11 tests) and in a real browser  *Amended 18 October 2026* `8f0b883`: **the conflict is now proved end to end, through two browsers.** The technician holds an answer with no signal; the OFFICE answers the same item from its own browser (a Master may, administratively) while the tablet cannot reach the server; the signal returns. What the smoke suite then asserts is the whole of CR-02 in one place: the held capture is REFUSED rather than replayed, it is retained and referred to the office (BD-15), **the job keeps the office's answer** — asserted through the API, not off the screen — and the tablet says where the work went. It also asserts that the held answer survives the application being closed while still offline **with the same idempotency key and the same template version**, because a restart that minted a new key would be a duplicate waiting to happen. The capture is then cleared from the tablet through *Remove from tablet*, which is the end of that workflow  *Amended 18 October 2026 `0e6e0d1`:* **the conflict rule could be got round by OMISSION.** The three expectation fields were optional — a screen writing one field per tap has nothing to expect — so a capture that simply left them out was applied as though it were a tap made this second, silently replacing whatever the office had answered while the tablet was away. No tampering is needed for that: an older build, or a queue row written before the fields existed, does it by accident. A write through the CAPTURE transport must now carry the WHOLE expectation or be refused by name (`checklist_expectation_required`), and `sendCaptured` — the one transport the queue flushes through — declares itself with `X-EJE-Capture`. **The first attempt keyed the rule on the idempotency key and was wrong:** every command in this application mints one, so it refused every ordinary checklist tap, and the smoke suite caught it three steps running. **Half an expectation from a screen stays allowed, deliberately:** the office's resolution of a referred capture is that shape on purpose (it keeps the version check and replaces the answer, BD-15), and dropping the stamp gains nobody anything because a screen may answer with no expectation at all. **What is not claimed:** a request with no expectation and no capture header is treated as a tap, which is the established last-write-wins rule for online answers — the server cannot tell a hand-made request from a screen. Four new route tests, including the same stale capture refused three times under three different keys |
| OFF-WRITEUP-1 | **The completion write-up is kept on the device as a LOCAL DRAFT, and is never replayed** | **TESTED — awaiting approval** `e1f9bc0`. Offline every autosave fails, and the text lived in a React state variable — so a tablet locking took three paragraphs of fault findings with it. A failed save now writes a draft to the device under its owner's id. Nothing sends it: a write-up REPLACES a value on the job, so `save_report` stays online-only and the technician puts the draft on the job themselves, through the ordinary save with the ordinary validation and audit. The screen calls it a draft and says it is not on the server; discarding it is an explicit confirmed action. Like unsent captures it survives a sign-out and is invisible to the next person on the tablet  *Amended 18 October 2026* `660f2ad`: **the draft now knows what the server held when it was typed**, and that closes a real CR-02 hole. Without it a draft could only be compared with what the server holds NOW, so two cases were indistinguishable: a draft typed over an empty write-up (apply it — nothing is lost) and one typed over text the OFFICE has since corrected, where "load the draft into the form and save" replaces a correction made by somebody who knew something the draft does not. `draftConflictsWith` reports a conflict only when the draft knows its base, the server has moved off it, AND the draft still says something different — a draft the server has caught up with is finished, not contested. The panel then names the conflict, shows **both texts field by field** and applies nothing until the technician chooses; a draft written before this existed has no base, reports no conflict and is offered exactly as it was. Proved by `report-draft.test.ts` (7) and end to end in the smoke suite, where the server is moved under a held draft through the real API and the form is asserted NOT to have changed |

**Two defects this step fixed, both found by writing its tests** (OFF-SEC-2 is
the third and is in the table above):

| ID | Defect | Status |
|---|---|---|
| CHK-GATE-1 | **A mandatory checklist could be completed with every question blank.** `completeChecklist` stamped `completedAt` on request and evaluated nothing; the runner disabled its own button while items were outstanding, and that was the whole of the enforcement. A request made by hand, by an older client or by a replayed queue could therefore complete an installation checklist nobody had filled in — and `checkReadyForCompletion` accepts a job whose mandatory checklist carries a stamp, so **the customer's job card would have reported a commissioning checklist that was never run** | **TESTED — awaiting approval** `e1f9bc0`. The operation now evaluates the template with the same function the screen draws its progress from, and names each outstanding item — unanswered required questions, a failure or an out-of-range reading with no note, and a missing evidence photograph — so the server's refusal and the technician's screen cannot disagree. `checklist-gate.test.ts`, 7 tests |
| DATA-PART-1 | **A technician lost access to their own work when a job was reassigned**, on the demonstration backend. `listParticipatedJobs` answered from the job's CURRENT crew, so a reassignment took the job, the hours captured on it and — once BD-15 existed — the ability to hand the office the very capture the reassignment had caused to be refused | **TESTED — awaiting approval** `b813cc3`. The demonstration store now keeps a participation history and reads it, which is the contract the PostgreSQL repository already satisfied from `job_participants`. Proved on both backends |

**What step two still deliberately does NOT contain:**

| Not built | Why |
|---|---|
| Offline completion of a checklist | Completing is a gate evaluated against the template; it is a decision for the server, not a row to hold. CHK-GATE-1 is what makes that decision real |
| Offline checklist EVIDENCE | Bytes, not requests: OFF-12. The answer can be held; the photograph cannot, and the row says so rather than offering a button that fails in a basement |
| Offline signature or refusal | OFF-5, unchanged and untouched by this step |
| Offline job DETAIL | PWA-6's boundary, unchanged: a capture starts from a job screen already open |
| Background Sync / a service-worker replay | Unchanged. `shell.test.ts` still fails if a `sync` handler appears |
| Re-aiming a refused capture at another job | BD-15 option (b), which EJE did not choose. The office applies it to the job it was captured for, or records no action with a reason |

**The honest summary of what a technician can do with no signal, as of this
step:** read their assigned job list; record labour, travel, parts and notes;
answer the checklist item by item; and type the completion write-up as a local
draft — with every one of those labelled as being on the tablet and not on the
job. They still cannot complete the checklist, attach a photograph, or take a
signature. **Nothing here is approved**: it is TESTED, and the rugged tablet
itself has still not been touched (ACC-PWA-1…6).

### CR-09 Phase 4, STEP THREE — photographs, one job's detail, and the acceptance message (OFF-MEDIA-1, OFF-DETAIL-1, WHATSAPP-1)

*Implemented 18 October 2026, `8201d30`, `92bed16` and `fa9073f`, in the same
batch as the CI pipeline and the AUD-8 fixtures. Scoped here, as PROC-1
requires, with the reasons for every boundary.*

| ID | Requirement | Status |
|---|---|---|
| OFF-MEDIA-1 | **A photograph taken with no signal is kept on the device, bytes and all, and uploaded through the ordinary route** | **TESTED — awaiting approval** `8201d30`. OFF-12 refused this on two grounds and both are answered rather than waved away. *"Bytes are not fields"* — correct, so they are NOT in the capture queue: a separate store with its own flush, because that queue carries JSON bodies and a 2 MB file is not one. *"No agreed retention rule"* — the rule is now written down and conservative: a held photograph leaves only when the server accepts it or the technician discards it in a confirmed action, nothing expires, nothing is evicted, and there is a **ceiling** (25 files, 40 MB per user) refused at the door with a plain message, because silently dropping the oldest photograph of a fault is worse than saying the tablet is full. ONE upload path: the same authenticated multipart routes the online capture uses — job photographs, checklist evidence and BD-14 machine photographs — with the same sniffing, the same authorisation and the capture's own idempotency key, so bytes that landed before the connection died are replayed rather than attached twice. A machine photograph replayed after the job moved on is REFUSED by the server, which is the correct answer and not something the queue may override. BD-16 applies as it does to captures: owner-scoped reads and writes, kept across a sign-out, invisible and unsendable to the next technician |
| OFF-DETAIL-1 | **The job a technician had open is readable with no signal, from this device's own copy** | **TESTED — awaiting approval** `92bed16`. A tablet with no coverage could show the job LIST and nothing else, so a technician whose application reloaded in a basement lost sight of the hours they had captured and of which checklist questions were outstanding. **No authenticated PAGE is cached** — the worker still refuses that and `shell.test.ts` still fails if one appears; what is cached is the job's DETAIL, written when the server answered and read back on the offline page. The projection is a whitelist built field by field, and it refuses more than it keeps: no price of any kind, no signature or stroke data, no refusal, no final-document pointer, no customer contact details, and no identifier a client could hand back as authority. Photograph captions, never photographs. Per-user by key, and — because it is a copy of what the server has rather than held work — **cleared on sign-out and when another user signs in**, which is the opposite of the pending captures, drafts and photographs. The copy says what it is, how old it is, and that nothing on it can be changed; it carries no controls at all |
| WHATSAPP-1 | **The site-location offer is queued on the outbox, sent to the technician's own number, and offered only to the field** | **TESTED — awaiting approval** `fa9073f`. The flow was wired and the operation was real; tracing it end to end found three things that were not. (1) It called Meta **from inside the transaction**, holding a database connection across a network round trip and leaving nothing to retry from — it now enqueues with the transaction and the dispatcher sends after the commit, like the assignment notice. (2) It reported `sent: true` the moment the adapter returned, when the adapter itself only ever gets *accepted* from Meta — the field is now `queued`, the screen says *queued is not sent*, and an unconfigured deployment queues **nothing** and says so rather than retrying a message that can never go. (3) The DESTINATION was an optional field in the request body, which made it a route for sending EJE-branded templates to any number at EJE's cost; it is gone, and the number comes from the actor's own account. And the authorisation it never had: both halves of the prompt now require an actor who does field work AND is on the job's crew, so a Coordinator is refused 403 and so is a Master. Acceptance is untouched and unaffected, which was always the commercial rule |

**What step three still does NOT contain:**

| Not built | Why |
|---|---|
| Offline signature or refusal | **OFF-5, and a genuine blocker rather than a gap.** What the customer was shown, what it means if the job changed between the signature and its arrival, and whether an unsent signature is a signature at all are questions nobody has answered. Inventing an answer would be inventing the most consequential record in the system |
| Byte-range RESUME of an interrupted upload | A failed flush re-sends only the files that did not land, never the whole queue, and a file whose bytes reached the server is replayed under its own key rather than attached twice. True resume needs a chunked protocol on both sides, which is a decision nobody has made. **OFF-7 stays PARTIAL** |
| An authenticated page in the worker's cache | Unchanged and deliberate. Every page is rendered for one signed-in person; the offline page is the one screen a tablet with no signal reaches, and it holds no server data |
| Offline capture from a cached copy | The cached detail carries no controls. A page that offered an action the server never agreed to would be worse than one that offers none |

### End-to-end closure — a verification pass (18 October 2026)

*Required by the same batch as step two, and recorded here because a
verification pass whose result is not written down has to be done again. Each
row is a lifecycle rule that was re-checked against the running system and the
suite; the evidence column names where the rule is held and where it is proved.
One defect was found, and it is CHK-GATE-1 above.*

| Checked | Result |
|---|---|
| Completion paths per job type, and the checklist requirement by type (Installation and Service require one; Breakdown and Test & Repair do not; a Parts collection has its own footing with no labour or travel) | **HOLDS.** `checkReadyForCompletion` in `domain/job/workflow.ts`; `completion-sequence.test.ts` |
| **Mandatory checklist enforcement** | **DEFECT FOUND AND FIXED — CHK-GATE-1.** The requirement was enforced by a disabled button and nothing else |
| A checklist answered against a retired template version still completes against THAT version | **HOLDS.** The command resolves the instance's own `templateId` and `templateVersion` and answers 404 if that version is no longer held, rather than falling back to the current one; `historical-checklist.test.ts`, and OFF-CHK-1 now refuses to move an answer across versions |
| Values are preserved when a save fails or the screen is refreshed | **HOLDS, and improved.** The write-up autosaves, keeps the text on a failure and now keeps it on the DEVICE (OFF-WRITEUP-1); a refused capture keeps its details for a person to decide about |
| No double submissions, and no double job cards or emails from a repeated request | **HOLDS.** `(userId, operation, key)` plus a body hash, with the marker committing inside the request's transaction; `duplicate-operations.test.ts` and `duplicate-operations.db.test.ts` cover identical, concurrent, burst and stale-screen submissions |
| The signature declaration is exactly *"I confirm that the work described above has been completed."* | **HOLDS.** One constant, asserted in `completion-sequence.test.ts`, `refusal-document.test.ts`, `signature-refusal.test.ts` and the PostgreSQL history tests |
| A captured signature is persisted server-side and is VISIBLE in the issued PDF, in black | **HOLDS.** `final-document-pixels.browser.test.ts` renders the stored bytes through a real PDF engine and counts the dark pixels where the signature belongs — the check that fails if it is missing, white, clipped, zero-sized or off the page |
| A signature refusal needs a non-empty trimmed reason, is kept in the history, is not shown to a technician who may not read it, and blocks issuing until a Master resolves it | **HOLDS.** `checkRefusalReason`, `outstandingRefusal`, `redactRefusalsForViewer`; `signature-refusal.test.ts`, `refusal-document.test.ts` |
| Neither a signature nor a refusal can be recorded twice, and a refused card cannot then be signed | **HOLDS.** `checkSignatureOutcome` and `finalizedRefusal`; `signature-refusal.test.ts` |
| The final document is real, stored, and the SAME bytes every time it is asked for | **HOLDS.** `signed-document-api.test.ts` fetches it twice over HTTP and compares; `storage-outbox.db.test.ts` proves the bytes are on disk |
| It carries the pricing snapshot, the checklist version and the signature that were in force when it was issued | **HOLDS.** The snapshot is frozen at signature or refusal with its reason, the priced lines are materialised with it, and the checklist instance carries its own version; `job-history.db.test.ts` |
| An email failure does NOT close the job; a retry re-sends the SAME issued document; closure waits for confirmed delivery | **HOLDS.** `delivery-handshake.test.ts` — twelve tests, including that a failure leaves the job open and keeps the document, that the retry sends the same file, that every attempt is on the audit trail, and that a delivery the system cannot observe is never reported |
| A closed job has a valid final document, and a historical one is readable without being re-rendered | **HOLDS.** Closure runs through confirmed delivery of a document that is already stored; the download serves the stored bytes rather than rendering again |
| Parts, Test & Repair, Customer Collection and Courier rules: no labour or travel on a parts collection, the collector's own declaration, and a courier-facing document that shows no prices, subtotals, VAT or totals | **HOLDS.** `assertCapturesLabourAndTravel` on the server, `collection-documents.test.ts` and `collection-document-parity.test.ts` for what each document prints |

**Phase 4 — the full offline system (MUST be separately scoped first)**

| ID | Requirement | Status |
|---|---|---|
| OFF-10 | **Offline authentication and session.** A technician who is already signed in can keep working through a shift with no connectivity, without their session silently expiring mid-job | **DEFINED** |
| OFF-11 | **Reconnect behaviour** is defined and visible: what syncs first, what the technician sees while it happens, and what they may do during it | **DEFINED** |
| OFF-12 | **Offline document and media handling** — what a technician may view and produce offline, and what necessarily waits for a connection | **PARTIAL** `8201d30`, `92bed16` — *amended 18 October 2026.* Answered for PHOTOGRAPHS (held, with a retention rule and a ceiling — OFF-MEDIA-1) and for READING one job (a narrow cached copy with no prices, signature, document pointer or contact details — OFF-DETAIL-1). Still **DEFINED and not built** for documents a technician may want to view offline: a customer's issued job card is authorised on every request and is not cached, deliberately |
| OFF-13 | **Tablet/PWA acceptance testing** on the target device, covering a full job captured start to finish with the network off | **DEFINED** |

> Phase 4 also delivers OFF-1…OFF-9 below. **None of it may be implemented
> until the phase is scoped in this document**, because CR-02's promise that
> captured work is never silently overwritten depends on an agreed definition of
> a conflict, and there is none yet.

### Reporting, library search and the tablet pass (18 October 2026)

*Delivered in one batch after the end-to-end closure above, in four commits:
`8a0a42b` (the CI browser gates), `636491c` (SEARCH-4), `17132af` (LIB-5) and
`660f2ad` (the tablet pass). Each row names where the rule is held and where it
is proved. **Nothing here is approved:** every row is TESTED and awaits the
owner, as PROC-4 requires.*

| What | Result |
|---|---|
| **The actual remote CI run was established, not assumed.** The previous batch reported its local gates green; the remote workflow result had never been read | **DEFECT FOUND AND FIXED.** Run `39077208858` on `8d0d357` was RED: 15 end-to-end steps failed and the smoke job was skipped. The cause was the SUITE, not the application — `playwright install chromium` also installs `chrome-headless-shell`, which reports no inline PDF viewer exactly as Chrome on Android does, so the Signed step correctly drew the HTML document (PDF-3) while the suite waited for the `<iframe>`. Re-verified on the fix: run `39105109269` on `17132af`, all three jobs and every step `success` |
| A second defect found by the same run: the availability step **sampled** the clash dialog instead of waiting for whichever outcome the save produced, and the smoke suite's own availability step asserted the CLASH dialog's title — which appears only when the seed happens to have work booked on that business date | **FIXED.** Both wait for the outcome and assert the RECORD. The same QA-5 shape as the two before it |
| **SEARCH-4 — a spreadsheet export of the Jobs list and the closed-job archive**, server-generated, from the screen's own authorised read | **TESTED — awaiting approval** `636491c`. See the SEARCH-4 row for what is in the files, what is deliberately not (the archive's issued prices — BD-17) and why there is no XLSX |
| **LIB-5 — the library is searched by the text inside its documents**, which required the upload path to store a real file first | **PARTIAL — awaiting approval** `17132af`. Text-based PDFs are extracted, indexed per revision and searched with snippets; a scan is recorded as `needs_ocr` and SAID so. OCR itself is not implemented and is not implied |
| A real authorisation leak found while implementing LIB-5: the global search ran over **every** library document whatever its status and whoever was asking | **FIXED** with it. `library.view`, and only CURRENT revisions, in the read |
| **UX-1 — every screen measured at tablet and phone width**, with the defects fixed rather than screenshotted | **TESTED — awaiting approval** `660f2ad`, and UX-1 itself stays **UNVERIFIED** until the rugged device. Five classes of defect fixed, including a closed navigation drawer that was focusable and announced while off-canvas |
| **PWA-7 — the update offer cannot land mid-capture**, which is distinct from not applying the update mid-capture | **TESTED — awaiting approval** `660f2ad`. A capture lock the three capture surfaces hold, read during render so the bar cannot appear for even one frame |
| **OFF-WRITEUP-1 — a write-up the server changed under a held draft is a CONFLICT**, with both texts shown and nothing applied until the technician chooses | **TESTED — awaiting approval** `660f2ad`. The draft carries what the server held when it was typed, which is what makes the two cases distinguishable |
| **The library's stored files can be opened**, which is what makes an uploaded manual a manual rather than a record of one | **TESTED — awaiting approval** `660f2ad`. `canOpenDocumentFile` is the library screen's own three-way rule in one place, and a refusal is the 404 a missing document gets. A second leak found with it: the library view was handing every document's storage key to the browser |
| Nothing resembling a credential is in client storage | **HOLDS, and the assertion is stronger.** The smoke suite now also reads `sessionStorage` and compares every store against the session cookie's OWN VALUE, read from the browser context — asserting on field names catches a field called `sessionToken` and misses one called `d` |

**What this batch deliberately did NOT decide**, and why each is still open: the
offline customer signature and refusal (BD-01 is not raised because the
question is scoped, not answered — an unsent signature is either a legal
signature or it is not, and only EJE can say); the post-signature correction
mechanism (BD-02); the mandatory order number (BD-04); Redis versus the
PostgreSQL outbox (BD-05); emailing an unsigned refusal outcome (BD-06);
Master-only draft jobs (DRAFT-1); charges, discounts and VAT (COST-5);
customer change requests (CUST-CR); machine location history (MACH-HIST); video
limits (MEDIA-5); and **who may export the prices a job was issued at
(BD-17, raised by this batch)**.

### The two job-workflow decisions, and demo/production separation (21 October 2026, eighth batch)

*The October release mandate, Workstreams A, B, C and D. **Nothing here is
approved:** every row is TESTED and awaits the owner (PROC-4). **Nothing here
is deployed:** the live service still serves `4dede18`.*

**Two acceptance blockers are closed by the owner answering their decisions.**

| What | Result |
|---|---|
| **BD-02 — a signed job card with a genuine error had NO REMEDY AT ANY LAYER (AUD-3, IMMUT-9)** | **TESTED — awaiting approval.** The owner's rule, implemented: the original is immutable and untouched — contents, signature, issue date, prices and bytes — and a MASTER raises a correction that carries its own addendum, linked to the exact storage key of the document the customer holds. `job_corrections` is append-only with one thing that may be filled in later: the customer's acknowledgement, write-once |
| **The addendum is not a re-rendered job card** | **TESTED — awaiting approval.** A re-render would be a different document wearing the original's date, which is what a frozen job card exists to prevent. `renderCorrection` is given no job at all, so it cannot do otherwise, and it shares `pdf-sheet.ts` with the job card so the two are visibly the same company's paper |
| **Proved by reading the original's bytes before and after, in a browser** | **TESTED — awaiting approval.** A smoke step fetches the issued job card, raises a correction through the screen, fetches it again and compares base64. The technician who did the work SEES the correction and is refused raising one, by the server and not by a hidden button |
| **When the customer's acknowledgement is REQUIRED** | **OPEN, and deliberately not answered.** A legally significant rule EJE have not stated. The Master says whether it is required when raising the correction, the addendum prints which of the two it is, and the system records what then happened. Nothing infers it |
| **BD-06 — closing *Without Customer Signature* sent the customer NOTHING (AUD-4, DELIV-7)** | **TESTED — awaiting approval.** No automatic delivery, still — now on purpose rather than by omission. A MASTER authorises an exceptional send with a reason; the recipient is the job's own contact resolved by the same rule the ordinary path uses, never a caller's choice; the authorisation names the exact document and is append-only, one per job |
| **The message does not tell a customer who refused to sign that they signed** | **TESTED — awaiting approval.** The ordinary path's mail says "signed job card" because every document it sends is one. Reusing it here would have been a false statement to a customer, so the unsigned path has its own wording and a test asserts the absence |
| **A failed send is retryable without a second authorisation, and cannot double-send** | **TESTED — awaiting approval.** The decision stands; a provider failure does not undo it. The same in-flight guard the signed path uses, with the same expiry so a crash cannot leave a job nobody can ever send |
| **Provenance gained a third value, `unknown`** | **TESTED — awaiting approval.** §1.3's "uncertainty must not be treated as proven". Migration 0018 relabels pre-provenance rows in the five tables that permit an UPDATE; the column's default changed from `genuine` to `unknown`, so a forgotten field is a visible gap rather than a false claim; `final_documents` is write-once and is NOT rewritten — 0018 records when recording began instead, and the reconcile spends that row |
| **A would-be production incident, found and prevented** | **FIXED.** Without that record, applying 0015 to the live database would have backfilled `genuine` onto the six demonstration job cards and the first `documents:reconcile` after deployment would have reported all six as LOST CUSTOMER DOCUMENTS. Proved by building a database shaped like the live one and migrating it |
| **An empty-array CHECK that accepted the row it was written to refuse** | **FIXED.** `array_length(areas, 1) >= 1` is NULL on an empty array and a CHECK treats NULL as satisfied. `cardinality` returns 0. Found by the db test, which is why it exists |
| **A deployment declares itself** | **TESTED — awaiting approval.** `EJE_DEPLOYMENT=production` makes the demonstration switcher unreachable in the RUNTIME whatever else is set, makes `db:seed:demo` refuse outright with no override, and makes a deployment pointed at a database that contradicts its declaration fail preflight. The preflight now PASSES the demonstration deployment instead of blocking it — a check that must be overridden to deploy is not a check |
| **`npm run backup:key-check`** | **TESTED — awaiting approval.** The escrow drill: is the key you hold the key this backup needs? Compares fingerprints, decrypts nothing, writes nothing, prints no part of the key, exits non-zero on a mismatch. Proved against a real encrypted backup with the right key, an escrowed copy from a file, and a wrong key |
| **The off-site recommendation, costed** | **IMPLEMENTED, EXTERNAL CONFIGURATION REQUIRED.** `docs/vps-backups.md` §5.1 recommends rclone to object storage with object lock, with the trade-offs against a NAS and a removable disk, and names the five things EJE must supply. The repository refuses a destination inside the backup directory, refuses a malformed rclone target, and warns when a directory destination is on the same filesystem — all verified locally |
| **A key stored beside the backup it unlocks is named out loud** | **TESTED — awaiting approval.** The owner's rule is categorical and no code can enforce it: a file an operator put on a server is not the application's to delete. So both commands say so instead. `npm run backup` names any file in the backup root whose entire contents are a backup key — the NAME, never the contents — and `backup:key-check --key-file` warns BEFORE it answers when that path is inside the backup directory or anywhere under the backup root. It still answers, because an operator working out which key they hold must not be stopped. A key on a USB stick or in a home directory warns about nothing |
| **Two foreign keys PostgreSQL would have silently renamed** | **FIXED.** `NAMEDATALEN` cuts an identifier at 63 characters with a NOTICE in the middle of `drizzle-kit`'s output. Drizzle's generated names for `job_corrections.corrects_document_key` and `unsigned_delivery_authorisations.document_key` were 68 and 76, so both constraints would have existed under names appearing nowhere in this repository — and a later migration dropping one by the name in the file would fail. Both are named explicitly now, in the schema and in the SQL; `0014`'s is already applied to EJE's database and is recorded rather than edited, because changing an applied migration changes the hash drizzle holds against it. `src/db/migrations/identifiers.test.ts` fails the build on the next one |
| **Eight more tablet acceptance checks** | **AWAITING PHYSICAL ACCEPTANCE.** Camera permission refused and then allowed, upload progress and retry on a bad connection, signing with finger and stylus across a rotation, the on-screen keyboard over a long write-up, a long form in portrait, session expiry with unsent work, and a deliberate sign-out with captures held. Each has a failure mode a headless browser cannot see, which is the test for belonging there |

**Evidence:** lint, typecheck, build, **2 471** unit and route tests, **305** on
real PostgreSQL and real file storage, all 21 migrations applied from zero on a
fresh database and again onto a database shaped like the live one, every
browser suite, and a full backup → verify → key-check → restore-test cycle
against a real PostgreSQL 16 with real stored files that left the source
database and its files untouched and dropped its scratch database.

### File handling end to end, and video capture (21 October 2026, ninth batch)

*The continuation mandate of 21 October 2026, sections 2 to 5. **Nothing here is
approved:** every row is TESTED and awaits the owner (PROC-4). **Nothing here is
deployed:** the live service still serves `4dede18`.*

**Three defects in the upload lifecycle, all found by auditing it rather than by
a failure.**

| What | Result |
|---|---|
| **Bytes left behind by a rolled-back upload** | **FIXED.** Every upload writes the bytes first and the row second — the right order, because a row pointing at a file that was never written tells somebody a document exists when it does not. The price was the other direction: a refused insert rolled the row back and left the bytes on disk with nothing pointing at them, in every backup and every restore of one, and the storage port had no `remove` to undo it. Now tracked per unit of work and removed when the transaction fails, at the transaction boundary rather than in each route — so it covers paths nobody has written yet. Four of five tests in `upload-rollback.db.test.ts` fail without it |
| **`storage.put` — the one call that could record a file that was never there** | **REMOVED.** It allocated a key with no bytes behind it, for capture paths where the browser sent a name and a size it had made up. Every one of those now sends the image, so it had no callers; deleting it makes DEMO-1 §1.2 structurally unreachable rather than merely unused, and the test asserts the method is absent from the object |
| **A checksum on every stored file** | **FIXED, with migration `0021`.** A customer's filed document, a machine manual and an issued job card all recorded the SHA-256 of their stored bytes. The photographs a customer SIGNS FOR did not: `job_media` had the column and nothing ever wrote to it, and `machine_photos` and `checklist_answer_photos` had no column at all — so the evidence a `photoRequired` item gates completion on had the weakest integrity record in the system. One shared `storeAndMeasure` now stores, READS BACK and records the store's own measurements for every path that stores a file |
| **The library was the last path that measured nothing** | **FIXED.** `uploadDocument` recorded `input.file.bytes.byteLength` — the length of what was handed to the write — and nothing at all in `library_document_versions.checksum_sha256`, a column that has existed since the table did. A manual a technician works from on site could not be told from a damaged copy of itself. The library is the one path whose storage key belongs to the RECORD rather than the store, so `measureStored` reads back and measures at an explicit key. The test computes the SHA-256 itself, off the bytes it sent, and uploads two different documents so a constant cannot pass either |
| **Three paths still carried their own copy of the helper** | **FIXED.** A customer's document, a machine's document and a post-signature correction each still had their own twenty lines of store-read-back-measure after `storeAndMeasure` was written — which is how the original drift started. They call the helper; the refusal wording and the violation code stay with the caller, because a client may switch on `document_not_stored` |
| **A smoke step that typed into a dialog before it had settled** | **FIXED.** `a duplicate serial number is refused` failed on two CI runs and never locally. `MachineDialog` resets its draft in an effect when `open` turns true, and the dialog is visible before that effect has run — so a `fill` landing in the gap is wiped, an EMPTY serial is submitted, the server refuses it for being empty rather than for being a duplicate, and the step waits out its timeout on wording that was never coming. The fields are now filled only once the form's submit is enabled, which is strictly after the reset, and "the dialog answered something else" is waited for by name instead of timed out on. Not re-run, and the assertion is unchanged |
| **A `putDocument` that CREATED its file is now rolled back** | **FIXED.** The rollback tracker could not touch a `putDocument` at all: the key is the caller's and may already hold bytes a row has referred to for months, so removing it would delete a document the database still points at. That reason only covers a write that REPLACED a file — so the question is now asked BEFORE the write, and the two paths whose key belongs to the record (a library revision, a post-signature addendum) no longer orphan their bytes on a failed insert. A store that cannot say which it was leaves the key alone: keeping bytes is the recoverable mistake |
| **"Today" came from the runner's clock, in both seeds** | **FIXED. QA-5, a third time.** Both seeds built their dates from `new Date().getDate()` — the local date of whatever machine runs them, UTC on the server and on CI — while everything that reads the data back asks in the business zone. For the two hours between 22:00 and midnight UTC the seeded appointment landed on yesterday, "Today's scheduled jobs" was a day out, and a technician recorded as on sick leave today was not — so an assignment the demonstration exists to refuse was allowed. An hour handed to `timeOffset` is now an hour on EJE's clock: 09:00 in Johannesburg is stored as 07:00Z |
| **A test that read position for identity** | **FIXED.** Two assertions counted the activity rows and read that many off the front of the list, which assumes every seeded event sorts below one created a moment ago. Seeded events stamped "today at 07:10" are in the FUTURE to a suite run before seven in the morning. They diff by id now |
| **The restore test was blind to correction addenda** | **FIXED.** Both scanners asked `information_schema` for `column_name = 'storage_key'`, which misses `job_corrections.document_storage_key` — the only reference to an addendum PDF's bytes. Proved on a real backup: 16 references became 17, and 7 resolved became 8 |
| **`documents:reconcile` asks the other direction** | **TESTED — awaiting approval.** Not only "does every row describe a file that is there" but "is there a file here no row describes". Orphans, half-written keys, the litter of an interrupted durable write and anything that is not a stored document are reported separately, and only the first may be removed — with `--remove-orphans` AND `--expect-orphans N`, a count nobody can know without having read a report, refused when it no longer matches |
| **`uploads.ts` has a test of its own** | **TESTED — awaiting approval.** The module that decides what the server accepts had none: three route tests exercised the happy path of each. A `.pdf` name AND content type on a ZIP, a signature one byte late, RIFF that is a WAV rather than a WebP, a filename carrying CRLF into a `Content-Disposition` header, and the size limit at the boundary and one byte past it |
| **`MEDIA-5` — video capture** | **TESTED — awaiting approval.** See the MEDIA-5 row above for what was built. The decision EJE still owe is whether a customer ever receives a video and how; until then the server files it for the office |
| **`LIB-5` — the asynchronous indexing architecture** | **TESTED — awaiting approval.** The queue (`library_ocr_queue`), the worker (`npm run library:ocr`), five truthful states, a bounded retry, and a local engine behind a port. Recognising a 214-page manual is twenty minutes to an hour, so it cannot be an upload: the upload records the need and returns. **No engine is installed** — every job settles as `unavailable` naming `tesseract-ocr` and `poppler-utils` — and the hosted option is deliberately NOT implemented, so nothing can leave the premises. Which engine EJE run is still EJE's decision (`docs/library-ocr.md` §3) |
| **Recognised text is labelled as recognised** | **TESTED — awaiting approval.** `library_document_text.source` is `text_layer` or `ocr`, and the library says *"Searchable (recognised text)"* for the second. Text out of a scanned wiring diagram contains mistakes — a `B` for an `8`, a missing minus sign — and a technician reading an alarm code needs to know whether they have the document or a machine's reading of it |
| **A CHECK that accepted the row it was written to refuse — again** | **FIXED.** `(state = 'indexed' AND source IN (…)) OR (state <> 'indexed' AND source IS NULL)` admits an `indexed` row with a NULL source: `NULL IN (…)` is NULL, so the whole expression is NULL and a CHECK treats NULL as satisfied. The SECOND time this exact trap has been hit here, after `array_length` in `job_corrections`. Found by the db test both times |
| **A retry policy that actually bounds anything** | **FIXED, and found by a test.** A `failed` job was not claimable at all, so the attempt cap could only ever bite on a stale reclaim. A failure may be the document (a blank scan) or the machine (a full disk, an engine killed on one page) and nothing can tell them apart, so it is retried under the cap. `unavailable` is NOT retried — nothing changed, and the next attempt would say the same thing |
| **A screen that called a real e-mail "simulated"** | **FIXED.** The notifications screen read `(simulated)` against every e-mail and WhatsApp channel — hard-coded, written when both of them were. Both are real adapters now wherever they are configured, so a deployment with a Microsoft 365 tenant would have had a message that genuinely reached a customer labelled simulated. That is a screen somebody reads to decide whether to telephone the customer instead, so being wrong in the cautious direction is still being wrong. The transport is now read from the deployment, from the SAME `chooseEmailTransport` that `/api/health` uses, so the badge and the health route cannot disagree — and the test proves the answer CHANGES with the configuration, which a constant would also have passed, and that no tenant id, token or address is in the payload |
| **A storage failure that told the office nothing** | **FIXED.** A failed `storeUpload` — a full disk, `EJE_STORAGE_DIR` pointed at something that is not a directory — fell through to *"Something went wrong. Please try again."* It is a known condition with a known remedy and the person who can act on it is whoever runs the server, so it says that. **The path is deliberately not in the message:** the filesystem's own text names the directory, which belongs in the server log and not in a browser. Asserted both ways |
| **The last four cases from the mandate's §7 list** | **TESTED — awaiting approval.** A file surviving the application moving to a NEW RELEASE DIRECTORY (proved by reading it back through a fresh adapter while the process is chdir'd elsewhere — the symptom in production would be every pre-deployment document quietly 404ing); a failed storage write leaving NO row; two files with the same name, which an iPhone sends for every photograph it has ever taken; and two uploads at the same instant, each measured against its own bytes |
| **The document pickers now say what they accept** | **TESTED — awaiting approval.** The customer and machine document inputs had no `accept` attribute and no size guidance, so a tablet offered every file on the device and the refusal arrived only after a failed upload. Both state the formats and the limit, from the same constants the server enforces |

**Evidence:** lint, typecheck, build, the unit and route suite, the PostgreSQL
suite on real file storage, 23 migrations applied from zero on a fresh database
with `drizzle-kit check` clean, every browser suite, and the orphan scan driven
against a real database with a planted orphan — both removal guards refusing,
the orphan removed on a matching count, and the correction PDF beside it never
offered. The exact counts are in the commit messages, which is where they stay
true.

### The owner's feedback and the five answered decisions (23 October 2026, eleventh batch)

*The consolidated implementation mandate of 23 October 2026: handwritten
feedback on the Coordinator, Customers, Create New Job, Test & Repair, Parts and
job-completion screens, and the five business decisions the owner answered.
**Nothing here is approved:** every row is TESTED and awaits the owner (PROC-4).
**Nothing here is deployed:** the live service still serves `4dede18`, and this
session has no SSH access to the VPS.*

**FIVE DECISIONS ANSWERED, and what each one cost to implement.** Two needed no
code at all, which is the point of having built them up to the decision.

| Decision | The owner's answer | What it took |
|---|---|---|
| **BD-17** | Master AND Coordinator may export issued prices | `9959a91` had built the columns behind `jobs.exportPrices`; answering added the capability to two role lists. A technician still may not, and the archive was already office-only |
| **BD-18** | Audit all exports, retain indefinitely | The SWITCH WAS REMOVED. It had been a boolean, then an environment variable — both ways of not deciding on EJE's behalf. There is now no configuration that turns it off, proved by setting the old `EJE_EXPORT_AUDIT=off` and watching the event be written anyway. Exports got their own activity group: every other event there is a CHANGE and this is a READ |
| **BD-19** | Fixed amount, before VAT, Master only — **no Coordinator ceiling** | NO CODE CHANGED: that is the shape `149bf7e` shipped and recommended. What was added is the assertion that a Coordinator does NOT hold `jobs.applyDiscount`, so granting it later is a deliberate act rather than a convenience |
| **BD-20** | Closed job shows the location at the time; in progress shows the register | `JobView.machineLocationAtWork`, resolved server-side as at the day the work was COMPLETED — not the day it was booked. And `{ known: false }` with a reason where the history cannot answer, which is the common case today and the part the owner was explicit about |
| **BD-21** | Demonstration environment first, measure before production | MEASURED: 23–25 seconds per A4 page at 300 dpi, two samples, byte-identical text. See the row below — the number has a consequence |

**THE OWNER'S HANDWRITTEN FEEDBACK, item by item.**

| What | Result |
|---|---|
| **Coordinator → Customers: create, view, edit notes, add documents** | **TESTED — awaiting approval** `433ee0c`. Three separate things, and only one was a permission. (1) CREATING AND EDITING ALREADY WORKED — a Coordinator has held `customers.manage` since the roles were written; what was wrong was the REFUSAL MESSAGE, "Only a Master can change official customer information", which described a rule the code did not implement and which a Coordinator reading it would believe. (2) ACCOUNT NOTES COULD NOT BE WRITTEN BY ANYBODY, and had not been able to since the register was built: the table existed, the repository persisted it, the seed filled it, the screen rendered it — and there was no operation, no route and no control that added one. (3) THE DOCUMENTS CARD ON THAT TAB WAS A FAKE, hard-coded to "No documents uploaded … storage is simulated in this demonstration", while the REAL panel holding real stored files sat on the Overview tab. Both real panels are now on the tab whose name promises them; `edited_by`/`edited_at` (migration `0026`) let an edit SAY it is an edit while keeping the original author and date, because an edit does not change who said something or when |
| **Breakdown: machine and priority not mandatory** | **TESTED — awaiting approval** `a4fe712`. Both were effectively compulsory: the machine because the requirement was INFERRED from `capturesLabourAndTravel` ("this type charges hours, so it is work on a machine"), and the priority because the column was NOT NULL and the form pre-selected the type's default — so every breakdown silently carried "Urgent". `requiresMachine` and `requiresPriority` now say it directly, per job type. **NULL RATHER THAN A DEFAULT is the whole change:** a grading nobody chose is indistinguishable afterwards from a real one |
| **Test & Repair: the same two, plus seven fields** | **TESTED — awaiting approval** `a4fe712`, `5d2b19f`. THREE OF THE SEVEN ALREADY EXISTED (reference number, delivery note, fault description) and FOUR ARE NEW (migration `0028`): the part number, description and quantity of the unit BOOKED IN, and the customer's quote number. **The unit received is not `job_parts`**, which is what was CONSUMED and is priced — a customer sends in three sensors and EJE fit one connector to each, two facts about one job. The FAULT DESCRIPTION IS NOW OPTIONAL on this type (`requiresFaultDescription`), because a unit is booked in at the counter before anybody has diagnosed it |
| **Parts: no new fields, no quote number, photographs** | **Honoured, and asserted.** `capturesQuoteNumber` is true for Test & Repair ALONE, and a request that sends one on a parts collection has it CLEARED rather than refused — a screen switching job type sends what it had. A parts collection is reconciled by its order number, which that type already requires |
| **The new-job attachment control: photographs and videos only** | **TESTED — awaiting approval** `2cb378d`. The scope is checkable rather than hoped: `POST /api/jobs/:jobId/attachments` has exactly ONE caller in the application, so narrowing the route narrows that control and nothing else. The library, the customer-document register and the machine-document register each keep `validateUpload` and still take a PDF. The limit follows what the file IS — a video gets the video budget, a photograph is still held to 25 MB — and it is enforced on the BYTES, so a PDF renamed `fault.jpg` is refused |
| **Counter Collection not available until the job is finished** | **TESTED — awaiting approval** `47b2cfc`. Creation now writes `false` on every job type whatever the request sends, and `setCollectionMethod` REFUSES before `completion` — so a direct API request cannot set it early. `showsPricesOnCollectionDocument` reads this flag, which is why it matters: a wrong guess made days earlier means a courier holding a document with the customer's prices on it. **A gap found on the way:** that operation never called `assertEditable`, so the collection answer on a SIGNED job card could be changed |
| **"Part number / Part / Cable / DN" under the attachments area** | **INSPECTED, NOT INVENTED.** The mandate said to read the context before changing anything and not to turn these words into mandatory fields without evidence. Part number, description and quantity are implemented as the Test & Repair received-item fields above, where the owner listed them explicitly. Nothing was added for "Cable" or "DN" beyond the delivery-note field that already existed, because there is no evidence of what either would mean as a separate field |
| **A measured consequence for BD-21, reported rather than fixed** | **23–25 SECONDS PER PAGE means a 214-page manual is ~83–89 minutes**, so it cannot be read under the shipped defaults: it meets `EJE_OCR_MAX_PAGES=40` at about page 40, and without that cap would meet the 20-minute deadline at about page 50. A long manual is therefore PARTIALLY INDEXED by default — recorded as "Searchable in part" with the reason, which is honest, but somebody searching for alarm 414 may not find it. Raising either limit is a decision about how much of the VPS one document may occupy, so it is stated in `docs/library-ocr.md` §5 rather than changed on the owner's behalf |
| **An intermittent test, root-caused rather than re-run** | **FIXED** `7276f17`. The real-OCR file failed in two of nine full-suite runs and in SIX OF SIX runs alone. The cause was a 5-second default timeout against a 7-to-22-second operation — and the second failure in that file was CAUSED BY THE FIRST: "leaves no workspace behind" compared the whole of `tmpdir()` against a snapshot, so a sibling case that timed out before reaching its `finally` broke it. One bug reported as two. No assertion was weakened |

**WHAT WAS CHANGED IN EXISTING TESTS, and why none of it is a relaxation.**
Fourteen cases across nine files asserted a previous answer: that no role held
`jobs.exportPrices`, that the trail was untouched by an export, that a breakdown
required a machine, that a parts collection carried "normal", that this route
took a PDF. Each was moved to the new answer with its discriminating structure
intact — the machine requirement is still asserted, on an INSTALLATION which
still has it; the export audit still takes a real export through the real path
and then reads the trail. Three cases were already NAMED "no priority of its
own" while asserting `'normal'`, and now assert null.

**Still not done, and still not claimed:** no message has reached a real mailbox
from this codebase; **no off-site backup exists**; the live deployment has not
been updated past `4dede18`; **nothing was installed on the production VPS and
OCR was not enabled there**; and no physical tablet, real provider delivery or
disaster-recovery acceptance has been carried out.

### The final outstanding work (23 October 2026, twelfth batch)

*The final outstanding work mandate of 23 October 2026: the owner's decision on
technician access to customer documents, ordinary PDF text extraction as the
library's primary search path, and the verification pass over the five answered
decisions and the handwritten page changes. **Nothing here is approved:** every
row is TESTED and awaits the owner (PROC-4). **Nothing here is deployed:** the
live service still serves `4dede18`.*

| ID | Requirement | Status and evidence |
|---|---|---|
| LIB-TEXT-1 | **Ordinary PDF text extraction is the library's primary search path** | **TESTED — awaiting approval**. *The final outstanding work mandate of 23 October 2026 §3: EJE's documents are manufacturer manuals, not scanned paperwork, so extraction is primary and OCR is the fallback.* **THE DEFECT WAS MEASURED, NOT GUESSED.** `src/lib/pdf/extract-text.ts` reads the bytes itself and states honestly that it cannot map a CID font — a PDF whose fonts are subset with `Identity-H` encoding stores GLYPH IDS, and reading them without the font's `/ToUnicode` map yields mojibake. **That is what Acrobat, InDesign and FrameMaker all produce**, i.e. nearly every manual a machine builder ships. On a fixture encoded exactly that way the byte reader returns `needs_ocr` — *"7% readable"* — and `pdftotext` returns the sentence. **The consequence was not a missed index:** the document was then QUEUED FOR RECOGNITION at the 23–25 s/page BD-21 measured, so a 214-page manual of perfectly good text became an 83-minute job that `EJE_OCR_MAX_PAGES` stops at page 40 — the library would have reported EJE's own manuals as "not searchable yet". **WHAT WAS BUILT:** a `PdfTextService` port with `pdftotext` as the default engine wherever poppler is installed (no configuration needed — unlike recognition it costs milliseconds, sends nothing anywhere and has no decision attached) and the byte reader as the fallback; **per-page text** (`library_document_pages`, migration `0029`) so a result says *page 212 of the drive manual* rather than *the drive manual*; a **`partially_indexed`** state and a `mixed` source so a manual with a scanned diagram NAMES the pages that are pictures instead of being called wholly searchable or wholly not; and **recognition aimed at the pages that carry no text**, which turns that same manual from 83 minutes of OCR into about 25 seconds and KEEPS the text-layer pages instead of overwriting them. **A REGRESSION THAT WOULD HAVE COST THE MOST** is guarded by its own test: before pages existed, recognition REPLACED the index, which was correct while only wholly-scanned documents were queued and would now throw away 210 good pages to keep 4. Two CHECKs tie the page tally to the state so a document can neither overstate nor understate what is searchable. `npm run preflight` names the engine and WARNS when it is the fallback. 13 service tests, 7 application tests, 5 on PostgreSQL, 4 preflight tests |
| CUST-DOC-2 | **A technician may read what is filed against a customer** | **TESTED — awaiting approval**. *The owner's decision of 23 October 2026, answering the question recorded as OPEN in the seventh batch above.* Reading a customer's documents was `customers.manage` — the office — and whether a technician should see them was written down as EJE's question rather than guessed at. **The answer is yes, and it is applied in one place:** `listCustomerDocuments` and `readCustomerDocument` now require `customers.view`, the capability that already decides who may open a customer at all. **EVERY CHANGE STAYS THE OFFICE'S** (`customers.manage`): the decision widened who may READ, said nothing about who may file, and inferring the rest would be inventing a rule. **WHY `customers.view` AND NOT A LIST OF RELATED CUSTOMERS:** a technician can already open any customer and read who they are, where their sites are and what machines stand on them, so gating the documents on some narrower relation would be a second, different answer to "which customers may this technician see" — and two answers to one question is how they come to disagree. The documents follow the record they are attached to. **A WITHDRAWN DOCUMENT IS STILL THE OFFICE'S:** it is 404 for every other role, because a download link that outlives the listing is how a withdrawn document keeps circulating. **A GAP FOUND ON THE WAY:** `?includeArchived=true` was never wired to the route, so "withdrawn, never deleted" kept a row and bytes that no screen or API could ever ask for again; the office can now review them and a technician passing the option is answered with the live list rather than refused |

### The remaining features, the OCR engine and deployment preparation (22 October 2026, tenth batch)

*The continuation mandate of 22 October 2026, priorities 1 to 7. **Nothing here
is approved:** every row is TESTED and awaits the owner (PROC-4). **Nothing here
is deployed:** the live service still serves `4dede18`, and this session has no
SSH access to the VPS — no package was installed on it and no configuration on
it was changed.*

**Five features that were waiting on nothing but work, and three decisions moved
to the point where only the decision is left.**

| What | Result |
|---|---|
| **`DRAFT-1` — Master-only draft jobs** | **TESTED — awaiting approval** `aaf5a33`. Its two open rules were ANSWERED from what the system already says rather than guessed: a draft may omit exactly what the technician supplies, and the rates question does not arise because COST-8 freezes rates at signature. The route test found two real authorisation holes on the way — a 200 and a 403 that each confirmed a hidden draft existed — because both reads short-circuited on `jobs.viewAll` before asking about drafts |
| **`COST-5` — additional charges and discounts** | **TESTED — awaiting approval** `149bf7e`. Built to a RECOMMENDED shape with the alternatives recorded as **BD-19** rather than chosen: a fixed amount, before VAT, Master-authorised, reason required, capped at the gross subtotal. The discount is a NEGATIVE snapshot line, so the lines still add up to the subtotal for any reader that does not know discounts exist |
| **`MACH-HIST` — where a machine has stood, and since when** | **TESTED — awaiting approval** `1299e4a`. Insert-only movements with the office's own effective date, written only when the site or customer actually changed, and `machineLocationAsAt` to answer the question the record exists for. **It stops before the job screen**, which is **BD-20**: showing a historical site on a finished job changes what that job appears to say |
| **`CUST-CR` — the job half** | **TESTED — awaiting approval** `6a8b7c8`. Its three questions answered the way the register half answered its own: the customer has no account, so somebody at EJE writes down who telephoned; the request changes nothing by itself; and because it carries no proposed value it cannot touch a signed job card, so CR-01's finality is untouched and the post-signature question stays BD-02's. Authority to resolve follows the SUBJECT — `jobs.viewAll` for a job, `customers.manage` for the register |
| **`LIB-5` — the local OCR engine, finished and PROVED** | **TESTED — awaiting approval** `2ba76e4`. Not asserted: `tesseract` and `pdftoppm` installed in a DEVELOPMENT container, run against an image-only PDF that `pdftotext` finds nothing in, through the real queue and worker, ending in a full-text search that finds an alarm code only recognition could have produced. Every limit is explicit and configurable, a document that hits one is **searchable in part with the reason**, missing language data is NAMED rather than reported as an unreadable document, and the temporary workspace is removed in a `finally` on every path. **Nothing can leave the premises: the code to call an external provider does not exist.** It is OFF everywhere, and whether it goes on is **BD-21** |
| **`BD-17` — may the issued prices be exported** | **MOVED, not answered** `9959a91`. The four price columns exist and are tested behind `jobs.exportPrices`, **a capability no role holds** — so every role's file is byte-for-byte what it was, and the answer is one line in `src/domain/access.ts` instead of a feature to build. An empty cell, never `0.00`, for a job whose totals were never issued |
| **`BD-18` — is an export recorded on the audit trail** | **MOVED, not answered** `9959a91`. The switch left the source for the environment: a boolean in a file is flipped by whoever is reading the file, while `EJE_EXPORT_AUDIT=on` is a deployment decision made where the other decisions of that kind live — and answering BD-18 no longer needs a release. On, it writes who, when, which export, which filters and how many rows, and **never the rows** |
| **A migration that silently kept the OLD constraint** | **FIXED** `6008e35`, and it was mine. Quieting `0023`'s `DROP CONSTRAINT IF EXISTS` NOTICE by moving the `ADD` into `EXCEPTION WHEN duplicate_object` left the 0000 definition enforcing: the database then REFUSED the negative discount line and **ACCEPTED a discount recorded as a positive amount**, which anything summing the lines would have ADDED to a customer's bill. Caught by three COST-5 database tests, but only on a database built from zero — which is the lesson. The silence belongs on the DROP (`undefined_object`), and `redefinitions.test.ts` now fails any migration that redefines a constraint this way. Its own first version matched only `ADD CONSTRAINT` and passed over the defect, because `0000` declares most constraints inside `CREATE TABLE` |
| **"Today" came from the renderer's clock on the calendar screen** | **FIXED. QA-5, a fourth time** `1bb0265`. `toIso(new Date())` is UTC on the server and the tablet's own clock in the browser; between midnight and 02:00 in Johannesburg the calendar opened on yesterday and the "Today" ring sat on the wrong square. The same mistake in `calendar.test.ts` was failing the suite for two hours a day, which reads as a flake rather than as the test's clock being wrong |
| **The Jobs spreadsheet keeps drafts to the Master** | **TESTED — awaiting approval** `f129e22`. It already did, through `loadActiveJobList`; nothing asserted it, and the export is the one place a job's details leave in bulk. Six cases that ask for drafts explicitly, because the default `open-work` filter excludes them for everybody and a test resting on that would prove nothing |
| **Preflight now asks the three questions it was silent about** | **TESTED — awaiting approval** `b55599a`. **Off-site backup:** WARN when neither destination is set, naming both and never printing either, because a backup that exists only on the machine it was taken from does not survive that machine. **Text recognition:** ok when unset — the state every deployment is in — FAIL on a value this build does not know, naming it. **Export auditing:** ok either way, and when on it says plainly that it is monitoring of staff and that retention is unmanaged. Verified against a production-shaped configuration: 15 checks, and it still exits 1 on a FAIL rather than reporting one and starting |
| **The release notes say what to set, and what starts empty** | **TESTED — awaiting approval** `b55599a`. Migrations `0023`–`0025` with what each adds and what it does not change — **nothing in them alters what an existing job card says** — the MACH-HIST note that movement history starts empty **deliberately** rather than from a failed backfill, and a table of the configuration this release understands, all of it optional and all of it off |

**What is STILL REQUIRED FROM EJE, and none of it can come from this
repository:** an off-site backup destination, a Microsoft 365 tenant, a Meta
token with approved templates — and now the five open decisions above
(BD-17, BD-18, BD-19, BD-20, BD-21), two of which are a one-line change once
answered.

**Still not done, and still not claimed:** no message has reached a real mailbox
from this codebase; **no off-site backup exists**; the live deployment has not
been updated past `4dede18`; **no package was installed on the production VPS
and OCR was not enabled there**; and no physical tablet, real provider delivery
or disaster-recovery acceptance has been carried out, because none of those is a
development task.

### Demonstration labelling and customer documents (20 October 2026, seventh batch)

*The October implementation mandate, sections 1, 3 and 4. **Nothing here is
approved:** every row is TESTED and awaits the owner (PROC-4). **Nothing here
is deployed:** the live service still serves `4dede18`.*

| What | Result |
|---|---|
| **A demonstration document says so, and the label is RECORDED rather than inferred** — `provenance` on library documents, their revisions, machine photographs and issued job cards; `genuine` is the default, in that direction deliberately | **TESTED — awaiting approval** `f38d46b`. Not derived from a missing file, because a genuine record whose file is gone is an incident and a fixture with no file is housekeeping: same symptom, opposite remedy |
| **Four places invented facts about files that do not exist** — `18_442_000` bytes and `214` pages for a Leadwell manual nobody uploaded, `1_842_000` for machine photographs, `4_180_000 + pages × 12_000` in the PostgreSQL seed, and a flat `2_400_000` for every metadata-only document added through the office screen | **TESTED — awaiting approval** `f38d46b`. A size is measured off a real file or it is zero, and zero is what makes the screen say *No stored file* |
| **A record with no bytes offers nothing** — no fetch, no spinner, no download button, no generated stand-in | **TESTED — awaiting approval** `f38d46b`, `6d8d33b`. The browser step found the modal's download button still being offered, which is how that was caught |
| **A demonstration job card is stamped on EVERY PAGE of its PDF** | **TESTED — awaiting approval** `f38d46b`. The screen's badge is gone the moment a PDF is downloaded, emailed or printed. A genuine job card is stamped nowhere, and both directions are asserted page by page |
| **The label did not reach PostgreSQL** — the seed marked six job cards and three machine photographs `simulated`; two repository inserts did not carry the field and the column took its `genuine` default | **TESTED — awaiting approval** `30c4f03`, and found by RUNNING `documents:reconcile` against a freshly seeded database, which reported six fixtures as LOST CUSTOMER DOCUMENTS |
| **The reconcile asks the row first** — it classified a missing document by looking its job number up in the shipped dataset, which §1.3 forbids as a primary test | **TESTED — awaiting approval** `30c4f03`. The column decides; the dataset is the fallback for rows written before it existed |
| **The library's five missing categories** — checklist, training document, internal company procedure, form and certificate, all previously filed as `work_procedure` | **TESTED — awaiting approval** `f38d46b`. The label map moved into the domain so a category is named on every screen |
| **CUSTOMER DOCUMENTS (§4)** — the register carried no files at all, so the signed service agreement and the credit application lived in a mailbox | **TESTED — awaiting approval** `27a1b53`. `customer_documents` with a RESTRICT key and a size CHECK, bytes stored and read back before the row is written, office-only at both ends with a technician's response carrying none at all, every indistinguishable refusal a 404, and the download an attachment with `nosniff` and `no-store` |
| **A 20px touch target, caught by CI** — the panel's bare `<input type="file">` failed the responsive gate at all three widths | **TESTED — awaiting approval** `30c4f03`. A real button over a hidden input, the pattern the photo-capture surfaces already use |
| **A customer document is WITHDRAWN, never deleted** — the row stays, the bytes stay, and the office only takes it off the screen | **TESTED — awaiting approval** `0140034`. The register's own rule: a site or a contact a job has named is archived because the record has to stay resolvable, and a document that was on file when a decision was taken is exactly such a record. Nothing in this application removes a document's bytes |
| **The OCR investigation §3 asks for** — the local option costed against the hosted one, with the recommendation to count the unsearchable documents before choosing | **INVESTIGATED, NOT IMPLEMENTED** `0140034`, `docs/library-ocr.md`. Tesseract on the VPS costs no licence and 5–15 seconds per page, so the real work is a durable background job rather than the recognition; a hosted service costs about US$1–1.50 per 1 000 pages and takes EJE's own documents off the premises. No dependency was added and no service was signed up for (#26) |
| **MACHINE DOCUMENTS (§4)** — a machine carried photographs and nothing else, so its commissioning report, its compliance certificate and the calibration results for one serial number had nowhere to live: the library files by MODEL and would answer for every machine of it, and a PDF filed as a photograph renders as a broken image | **TESTED — awaiting approval**. `machine_documents` with a CASCADE key (unlike a customer's, and for a stated reason), a size CHECK and an `audience` CHECK; the office attaches and withdraws, and **who may READ is decided per document** |
| **The audience is MEDIA-1's rule applied to a second kind of paper** — `field` or `office_only`, chosen by the office with the file, defaulting to `office_only` | **TESTED — awaiting approval**. Not a business question answered by implementation: the office decides per document and the row records it. The default is the direction that cannot disclose anything — a manual left office-only is an inconvenience, an invoice in the field is not |
| **A technician's refusal on an office-only document is a 404, not a 403** | **TESTED — awaiting approval**. A 403 would tell a technician which machines carry paperwork the office is keeping from them, which is information and not an answer |
| **The reconcile was counting a system two tables smaller than the one in front of it** — `KEY_TABLES` was a literal list of five, and `customer_documents` and `machine_documents` were not on it | **FIXED**. It now reads `information_schema` like `backup/run.ts` and `backup/restore-test.ts` already did, so a table that gains a `storage_key` is counted without anybody remembering |
| **A demonstration snapshot upgraded to v18 had no `customerDocuments` array at all** — the key was introduced by that step and the step did not create it, so the first customer screen after an upgrade would have thrown on `undefined.filter` | **FIXED**. Both steps now create their collection, and v18 → v19 exists for the machine one |
| ~~Whether a technician may read a specific customer document (a site induction certificate is the obvious candidate)~~ | **ANSWERED, 23 October 2026 — a technician may view and download the documents on a customer's profile.** Implemented as CUST-DOC-2 in the twelfth batch below: reading follows `customers.view`, every change stays `customers.manage`. The conservative answer held for three releases and the question was recorded rather than guessed, which is what let the decision be applied in one place |
| Whether `field` should be the DEFAULT audience for a machine document | **OPEN.** It is not, and the safe direction is what is implemented. EJE may find that most of what they file is field material and that the default is backwards for them |

**Evidence:** 2361 unit and route tests, 283 on real PostgreSQL and real file
storage, every browser suite (smoke, e2e, tablet-pdf-check, responsive-check,
check-routes, workflow-check), and all 18 migrations applied from zero on a
fresh database — `machine_documents` inspected afterwards for its two CHECKs,
its CASCADE and its unique storage key. `docs/demonstration-data.md` is the classification record §1.3
asks for, including what remains uncertain.

**Work items:** demonstration labelling is
[#58](https://github.com/VOID-za/EJE-Managment/issues/58) (DEMO-1) and customer
documents are [#59](https://github.com/VOID-za/EJE-Managment/issues/59)
(CUST-DOC-1), both `status:TESTING`; the OCR investigation is recorded against
[#26](https://github.com/VOID-za/EJE-Managment/issues/26) (LIB-5), which stays
`scope:PARTIAL` because the choice between running it on the VPS and paying for
a service is EJE's. Machine documents are
[#60](https://github.com/VOID-za/EJE-Managment/issues/60) (MACH-DOC-1).

### Document durability and backup validation (20 October 2026, sixth batch)

*Delivered after the batch below, against the live release `4dede18`. **Nothing
here is approved:** every row is TESTED and awaits the owner, as PROC-4
requires. **Nothing here is deployed:** the steps and the rollback are in
`docs/deploy-next-release.md` and need somebody with root on the VPS.*

| What | Result |
|---|---|
| **`final_documents.size_bytes` and `.checksum_sha256` were columns NOTHING EVER WROTE** — every row on the live server read 0 with no checksum, while the schema's own comment said the checksum was "verified on every read" | **TESTED — awaiting approval** `49e79b4`. The issue path records what the store measured on the readback it already performed. The old rows cannot be corrected — `final_documents` is write-once and the database refuses UPDATE, which is one of the protections CR-01 rests on — so the measurement goes into `final_document_verifications`, append-only, which is what that refusal's own message says to do |
| **A stored document was written with `writeFile`** — no `fsync`, not atomic — so a power loss could leave a signed job card empty or half written while the row still said it was there | **TESTED — awaiting approval** `5de49a6`. Temporary file, `fsync`, rename, `fsync` the directory. The sidecar carries the length and SHA-256 and `getDocument` recomputes both; a mismatch raises rather than handing out wrong bytes. Four of the five new tests fail against the previous implementation |
| **A damaged job card is refused, not re-rendered** | **TESTED — awaiting approval** `56352d6`. The dangerous default: treated as absence, the request falls through to the backfill and writes a NEW document over the damaged one, carrying the original's date. A test asserts `putDocument` is called zero times |
| **The restore test compared storage keys against FILE NAMES, so every reference read as a missing document** — the "25 document references without corresponding stored files" an operator saw, on a deployment whose documents were mostly there | **TESTED — awaiting approval** `36623b1`. The store writes `<key>.bin` and `<key>.json`; resolution now lives in one place with the adapter's own naming. The backup records which references were already dangling, in full, so a restore test can tell a document this backup LOST from one that was already gone — the first is fatal whatever the flags say |
| **The backup tests were calibrated to that defect** — the fixture wrote one file AT the key, a shape the store never produces | **TESTED — awaiting approval** `8197f78`. Three orphan cases now, because there are three situations: already missing, lost, and a manifest that knows nothing |
| **There was no scheduled backup at all on the live server** | **TESTED — awaiting approval** `d313756`. Nightly timer, weekly restore test, a failure that logs loudly and a `last-run.json` on every run; retention whose every rule is a refusal; an off-site copy by mounted volume or rclone, with `copy` AND `check`. A run with no off-site destination says so every time |
| **An old dump can be read without restoring it over anything** | **TESTED — awaiting approval** `f40bbd5`. `npm run dump:inspect` restores into a scratch database it drops again, and says every time that a dump contains no documents |
| **The six job cards missing from storage are seeded demonstration data** — EJE-2015, 2016, 2017, 2019, 2020, 2021 | **ESTABLISHED, nothing lost.** `npm run documents:reconcile` names them from the shipped seed itself, and distinguishes them from a genuine issued document, which it refuses to re-render and tells the operator to restore |
| **The integrations can be proved without messaging a customer** | **TESTED — awaiting approval** `96552b9`. `npm run integrations:check -- --probe` takes a token and reads EJE's own mailbox. An accepted WhatsApp token is NOT readiness: Meta delivers only an APPROVED template, and the names come from the application |
| An off-site backup destination, a Microsoft 365 tenant, a Meta token with approved templates | **STILL REQUIRED FROM EJE.** Nothing in the repository can create them, and `docs/vps-backups.md` says exactly what would be needed |

**Still not done, and still not claimed:** no message has reached a real mailbox
from this codebase (MANDATE-3 stays PARTIAL); **no off-site backup exists**;
the live deployment has not been updated past `4dede18`; DRAFT-1 and COST-5
remain unbuilt, and `docs/outstanding-scope.md` says which of those are waiting
on EJE rather than on us. *(MEDIA-5 was built on 21 October, and LIB-5's OCR
ARCHITECTURE with it — the queue, the worker, the truthful states and a local
engine behind a port. No engine is installed and the choice of one is still
EJE's. See the ninth batch below.)*

### Staging preparation and reports against the register (18 October 2026, fifth batch)

*Delivered after the batch below. **Nothing here is approved:** every row is
TESTED and awaits the owner, as PROC-4 requires. **Nothing here is deployed:**
this session has no SSH client, no key material and no route to the VPS, so no
service was installed, started or overwritten — see `docs/vps-staging.md` for
the exact access decision that is needed.*

| What | Result |
|---|---|
| **A deployment that would be quietly wrong is refused before the service starts** — `npm run preflight` names the six silent failures: a demonstration store serving live users, a connection pointed at the wrong database, a migration shipped but not applied, storage that is missing or unwritable, documents written inside the deployment directory where the next release deletes them, and no email configuration at all | **TESTED — awaiting approval** `e716b7b`. The rules are pure and separately tested (30 tests, one of them a property test over a configuration made entirely of secrets, asserting that no verdict ever contains a value). A verdict names a VARIABLE, never its contents |
| **A staging deployment that cannot touch production** — a second systemd unit, its own user, port, environment file, database and storage directory, with the standing-up, proving and rollback commands written out | **PREPARED, NOT DEPLOYED.** `deploy/eje-staging.service`, `docs/vps-staging.md`. The document starts with what to check BEFORE anything is installed, and with restoring a backup before changing a service rather than after |
| **Somebody who may not edit the register can report that it is wrong** (CUST-CR, the register half only — the customer-raised job-change half of #27 stays unbuilt and unanswered) — a technician standing at the machine reports a wrong serial, a bounced accounts address or stale access notes, the office sees it against the record, and records what it did with a note that is required on both outcomes | **TESTED — awaiting approval** `c44515d`. Three steps in the smoke suite prove it in a browser: the report, the office's copy and the technician's own, and the decision |
| **Applied means a person made the change, not that the system made it** | **Deliberate.** Nothing in CUST-CR writes to the customer, site or machine register, and the row has no proposed-value column: whether an approval applies a change automatically, and what MACH-HIST would then have to record, are EJE's to decide (#27, #28) |
| Who raises a CUSTOMER's change request to a JOB, what it may change, what it does to a job in progress, and how it meets CR-01 after signature | **OPEN** (#27, BD-02). Untouched by this batch: the register half neither answers these nor depends on them |
| Whether a report should carry the proposed VALUE, and whether approving one should apply it | **OPEN** (#27). The current behaviour — a message about a record, resolved by hand on the screen that already authorises the edit — is the implementation, not the answer |

**Still not done, and still not claimed:** a live Microsoft 365 tenant
(MANDATE-3 stays PARTIAL — no message has reached a real mailbox from this
codebase); **no staging or production deployment exists that this session has
observed**; the backup key lifecycle, which remains an operator procedure;
byte-range resumable uploads (OFF-7 stays PARTIAL); background sync; the offline
customer signature and refusal; the historical display of a renamed customer;
and **OFF-13, tablet acceptance on the real rugged device**.

### Delivery advice, the capture marker and register consistency (18 October 2026, fourth batch)

*Delivered after the batch below. **Nothing here is approved:** every row is
TESTED and awaits the owner, as PROC-4 requires.*

| What | Result |
|---|---|
| **The office is told whether *Send again* can possibly work** — nine failure kinds, four of which a retry resolves and five of which need a credential, a permission, an address, a smaller document or a configured deployment | **TESTED — awaiting approval** `1f82bae`. The vocabulary lives in the DOMAIN, is persisted by migration `0012`, and the button is deliberately NOT hidden on an unretryable kind |
| **A provider report that changed the REASON but not the state was being dropped** — the office kept reading the first message on a job that could not be sent | **TESTED — awaiting approval** `1f82bae`. Found by a browser test reporting two failures in a row; an identical report still changes nothing |
| **A capture must say what it was answering** — the checklist conflict rule could be got round by leaving the expectation out | **TESTED — awaiting approval** `0e6e0d1`. Keyed on the capture transport, after a first attempt keyed on the idempotency key refused every ordinary tap and was caught by the smoke suite |
| **A machine stands at one of its own customer's sites, checked server-side** on create and on amend, archived records included | **TESTED — awaiting approval** `0e6e0d1`. The database's foreign keys could not see a wrong PAIR |
| **Two concurrent amendments to one machine cannot silently overwrite each other** | **TESTED — awaiting approval** `0e6e0d1`. On real PostgreSQL |
| **A finished job's screen says its machine and site are the register of TODAY**, and names the issued document as the historical record | **TESTED — awaiting approval** `0e6e0d1`. A label, not a movement ledger — asserted present on a closed job and ABSENT on one in progress |
| Whether EJE record a machine's moves, and what a job screen should then show | **OPEN** (#28). No movement record, no effective dates, no relocation workflow |

**Still not done, and still not claimed:** a live Microsoft 365 tenant
(MANDATE-3 stays PARTIAL — no message has reached a real mailbox from this
codebase); the backup key lifecycle, which remains an operator procedure;
byte-range resumable uploads (OFF-7 stays PARTIAL); background sync; the offline
customer signature and refusal; the historical display of a renamed customer;
and **OFF-13, tablet acceptance on the real rugged device**.

### Restore safety, durable delivery and the offline inventory (18 October 2026, third batch)

*Delivered after the batch below. **Nothing here is approved:** every row is
TESTED and awaits the owner, as PROC-4 requires.*

| What | Result |
|---|---|
| **The document archive is judged before it is unpacked** — absolute paths, `..`, symlinks and hardlinks, devices and FIFOs, the same document twice, and ceilings on member count and claimed bytes | **TESTED — awaiting approval** `3600686`. 25 tests; every refusal proved against a REAL tar archive, each asserting nothing was extracted |
| **Interrupting a restore test cleans up** — the scratch copy of the database and the decrypted plaintext both go on SIGINT and SIGTERM | **TESTED — awaiting approval** `3600686`. Proved by polling the server until the scratch database exists, terminating the command, and asserting the handler ran and the copy is gone |
| **A round trip proves the DATA survives**: a known record and a known document through backup → encryption → verification → restore, read back out of PostgreSQL and compared byte for byte | **TESTED — awaiting approval** `3600686` |
| **The delivery record is persisted at all** — `delivery_attempts` was read by the mapper and written by NOTHING, so a job could never close on a confirmed delivery and the office was told an accepted copy had not been sent | **TESTED — awaiting approval** `b46dbc8`. One row per attempt, updated in place as that attempt moves. Four repository tests fail against the code as it was |
| **A provider failure says which of nine things happened**, and whether a retry can resolve it | **TESTED — awaiting approval** `b46dbc8`. `classifyGraphFailure` is pure and exported, so each status is proved rather than asserted in prose |
| **Every Graph request carries a deadline** (there was none, so a quiet endpoint held a submission open indefinitely), and an attachment over Graph's limit is refused before a token is requested | **TESTED — awaiting approval** `b46dbc8` |
| **Two re-sends cannot put two copies of one signed job card in a customer's inbox** | **TESTED — awaiting approval** `b46dbc8`. Simultaneous requests lose on the repository's version check, proved at the route; a second press after the first committed `sending` is refused by name, and the refusal expires after ten minutes |
| **A deployment that cannot send says so by name** — the missing variables at startup and in the office's refusal, never a value; the transport in one word on `/api/health` | **TESTED — awaiting approval** `b46dbc8`. The health payload's key list is pinned by a test on purpose, and the new field's value is pinned to four words so a reason cannot leak into it |
| **The offline inventory agrees with the server**: twenty-one job commands had no offline answer and three entries named commands that no longer exist | **TESTED — awaiting approval** `b0abd71`. Compared against the REAL command registry, so the next command added without a decision fails a test. The allowlist is unchanged |
| **A later register edit cannot reach a finished job's customer-facing record** — the issued PDF byte for byte, and the pricing snapshot the signature froze | **TESTED — awaiting approval** `b0abd71`. Withdrawing a machine or archiving a site also does not hide the job |
| Whether an office screen should show a renamed customer's name **as it was at the time** | **OPEN, and recorded rather than invented.** The screen resolves the register live, which is pinned by a test as current behaviour. It is the question CUST-CR and MACH-HIST circle |

**Still not done, and still not claimed:** a live Microsoft 365 tenant (MANDATE-3
stays PARTIAL — no message has been sent to a real mailbox from this codebase);
the key-management lifecycle, which remains an operator procedure; byte-range
resumable uploads (OFF-7 stays PARTIAL); background sync; the offline customer
signature and refusal (a business decision, untouched); and **OFF-13, tablet
acceptance on the real rugged device**.

### The real preview, ingestion limits and queue replay (18 October 2026, second batch)

*Delivered after the reporting batch above. **Nothing here is approved:** every
row is TESTED and awaits the owner, as PROC-4 requires.*

| What | Result |
|---|---|
| **The Technical Library's preview is the stored PDF**, not a facsimile — on a browser with a viewer, and honestly refused with the download offered on one without | **TESTED — awaiting approval** `8ce8c86`. Proved by reading the frame's own `blob:` back inside the page and comparing the `%PDF-` header and the exact uploaded byte length. See LIB-5 |
| The route **names the revision it served**, and the preview refuses bytes that are not the revision it asked for | **TESTED — awaiting approval** `8ce8c86` |
| **PDF ingestion is bounded**: a decompression bomb, an oversized file, a stream budget, a stream count and a page-count claim are each refused with the number that was exceeded | **TESTED — awaiting approval** `8ce8c86`. A corrupt file is no longer reported as needing OCR, and the `/ObjStm` claim is withdrawn as wrong |
| **A failed or unsearchable index can be retried**, per revision, by the office, without creating a duplicate revision | **TESTED — awaiting approval** `8ce8c86`. Cannot touch another revision's index — proved by failing one and asserting the other is untouched |
| **A held checklist answer the office has since changed is refused, retained and referred** — the job keeps the office's answer | **TESTED — awaiting approval** `8f0b883`. Proved end to end through two browsers, with the job's answer read back through the API |
| A held capture **survives the application being closed with the same idempotency key and template version** | **TESTED — awaiting approval** `8f0b883` |
| **Queue replay against real PostgreSQL**: idempotent on retry and under a race, owner-bound on a shared tablet, refused identically when the job was reassigned, refused when the session was revoked — and in each refusal nothing is written and no idempotency record is left behind | **TESTED — awaiting approval** `8f0b883`. `offline-replay.db.test.ts` |
| **"Sending…" is per row**, in memory rather than stored, so a crash mid-request cannot leave a row claiming to be sending | **TESTED — awaiting approval** `8f0b883` |
| **An export-audit mechanism that writes nothing**, called by both export routes, with the record it WOULD write available to a test | **TESTED — awaiting approval** `8f0b883`, and **BD-18 is OPEN**. The trail is asserted unchanged after a real export, at the application and the route layer |
| **Keyboard focus is measured**: no focus inside an inert region, none off the screen, and none without a visible ring | **TESTED — awaiting approval** `8f0b883`. 96 audit measurements in all |
| AUD-9 (cancellation and deletion status codes) | **VERIFIED, NOT RE-IMPLEMENTED.** Already correct and covered by `http-api.db.test.ts`: a refusal by STATE answers 422 and by ROLE answers 403, for both cancellation and deletion, with the row surviving in each case. No change was needed and none was made |
| Disabled users stay linked in historical job history | **VERIFIED, NOT RE-IMPLEMENTED.** Both repository adapters' `users.list()` deliberately include disabled people, with the reason in the interface, and job rows resolve their technician from that list. No change was needed |

**Still not done, and still not claimed:** OCR (an owner decision about runtime
and cost, BD-17's neighbour rather than a parsing gap); the offline customer
signature and refusal (a business decision, untouched); byte-range resumable
uploads (OFF-7 stays PARTIAL and no resume is claimed); background sync; and
**OFF-13, tablet acceptance on the real rugged device**, which no automated
check can stand in for.

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

*Amended 17 October 2026 by CR-09 Phase 3* `a690dda`. **Where these stand,
split by what can and cannot be proved without the rugged tablet.** The
criteria themselves are unchanged.

| ID | Standing | Evidence or what is missing |
|---|---|---|
| ACC-OFF-1 | **PARTIALLY MET** *(amended 18 Oct 2026, `92bed16`)* | The assigned job LIST is readable with the network off, labelled with when it arrived — proved in a real browser with the network switched off (`scripts/smoke.mjs`). *"including everything already captured on them"* is now PARTLY met: the detail of a job the technician opened is cached and readable offline, with the hours, travel, parts, notes, photograph captions and the checklist's outstanding questions — but without prices, signature or document, and only for jobs they actually opened. See OFF-DETAIL-1 |
| ACC-OFF-2 | **PARTIALLY MET** *(amended 18 Oct 2026, `8201d30`)* | Labour, travel, parts and notes CAN be captured with the network disabled and are visible on the job immediately — as *held on this tablet*, which is what they are. So can a checklist answer (OFF-CHK-1), the write-up as a local draft (OFF-WRITEUP-1) and a PHOTOGRAPH (OFF-MEDIA-1). The call-out flag and completing the checklist cannot, and nor can a signature (OFF-5). See OFF-QUEUE-1…10, CAP-REF-1…5 and OFF-MEDIA-1 |
| ACC-OFF-6 | **PARTIALLY MET** *(amended 18 Oct 2026, `8201d30`)* | True of every held capture, the write-up draft and the held photographs: each proved in a real browser by capturing offline, reloading the application and finding it still held. A signature cannot be captured at all (OFF-5), so there is nothing of it to survive |
| ACC-OFF-7 | **PARTIALLY MET** *(amended 17 Oct 2026, `0b1bf60`)* | Queued work is sent oldest-first, and a refusal stops only that job's queue — the rest stays queued rather than being lost. A partial failure therefore leaves the remainder intact, which is the criterion's second half |
| ACC-OFF-8 | **PARTIALLY MET** *(amended 17 Oct 2026, `0b1bf60`)* | Per capture rather than per job, and in four states rather than five: *not sent*, *sending*, *refused*, and gone-because-the-server-has-it. See OFF-8 |
| ACC-OFF-9 | **PARTIALLY MET** *(amended 18 Oct 2026, `b813cc3`)* | *Nothing is ever silently overwritten* holds, structurally (see OFF-9). *A person decides* now holds end to end: the refused capture is referred to the OFFICE, which applies it through the ordinary operation or records no action with a reason — the cases and who decides what are EJE's answer to OFF-QUEUE-DEC-1, held as CAP-REF-1…5. Still partial because the criterion's wording covers conflicts this step does not reach: signatures and evidence remain online-only |
| ACC-OFF-3, ACC-OFF-4, ACC-OFF-5, ACC-OFF-10, ACC-OFF-11, ACC-OFF-12 | **NOT MET** | Phase 4. No offline checklist, no offline write-up, no offline signature, no upload resume, no full offline job |
| ACC-PWA-1 | **NOT MET — needs the device** | Everything the browser checks before offering an install is in place and tested: a linked manifest, standalone display, a 192px icon that resolves with real bytes. Whether the launcher offers it, with EJE's name and icon, is a visit to the tablet |
| ACC-PWA-2 | **NOT MET — needs the device** | `display: 'standalone'` and matching theme colours are in place. Nothing headless has browser furniture to be absent |
| ACC-PWA-3 | **PARTIALLY MET — the rest needs the device** | The gallery path is driven end to end in a real browser: a file is chosen, previewed, uploaded, stored and served back, and the browser decodes the bytes it fetched. The camera path is the same input with `capture="environment"`; headless Chromium has no camera, so that the rear camera opens is unproven |
| ACC-PWA-4 | **PARTIALLY MET — needs the device** | Reopening the job list offers the job that was open, proved in a browser. Returning *with nothing lost* is Phase 4: nothing uncaptured is kept |
| ACC-PWA-5 | **PARTIALLY MET — needs the device** | The waiting worker and the prompt are tested, including that there is no unconditional `skipWaiting()`. A real update delivered to an installed tablet has not been performed |
| ACC-PWA-6 | **NOT MET** | UX-1 is still PARTIAL: no touch-gesture testing and no rugged device. Unchanged by Phase 3 |

### Offline and tablet (CR-02, CR-03) — none implemented

| ID | Requirement | Status |
|---|---|---|
| OFF-1 | Durable local storage for active work | **PARTIAL** `0b1bf60` — *amended 17 October 2026 by Phase 4 step one.* Durable storage exists (IndexedDB, its own store, keyed by user, surviving a restart and a flat battery) and holds the FOUR append-only captures. It does not hold a job's detail, a draft completion report, a checklist answer or a photograph. See OFF-QUEUE-1…10 |
| OFF-2 | Offline job work: notes, labour, travel, parts | **PARTIAL** `0b1bf60` — all four of these ARE capturable offline on an in-progress, unsigned job assigned to the technician. *Partial and not done* because the capture must start from a job screen already open: the job's own detail is not cached (PWA-6), so a technician cannot open a job offline to capture against it |
| OFF-3 | Offline photos and video | **PARTIAL** `8201d30` — *amended 21 October 2026.* PHOTOGRAPHS are held on the device and uploaded through the ordinary authenticated route, with a written retention rule and a stated ceiling (OFF-MEDIA-1). VIDEO IS DELIBERATELY NOT HELD, which is a decision rather than an omission: the queue's ceiling is 40 MB for all of a technician's unsent captures and one clip may be 60, so holding one would either fail at the cap or crowd out the photographs the job needs. Video capture is refused offline with that reason — the same answer the checklist and the signature give (OFF-QUEUE-10). Holding one would need a device storage budget EJE have not been asked for |
| OFF-4 | Offline checklists | **PARTIAL** `e1f9bc0` — *amended 18 October 2026.* ANSWERING is implemented, with the conflict rule OFF-9 asked for and the template's own validation applied before anything is held (OFF-CHK-1). COMPLETING is not, and deliberately: it is a gate the server evaluates against the template (CHK-GATE-1). Checklist EVIDENCE is not, because it is bytes (OFF-12) |
| OFF-5 | Offline signature **and refusal** capture | **NOT IMPLEMENTED** |
| OFF-6 | Queued mutations survive browser/device closure | **PARTIAL** `0b1bf60` — true of the four captures: proved in a real browser by capturing offline, reloading (which lands on the offline page, since no job page is ever cached), finding the capture still held and named, then sending it on reconnection. Not true of anything outside those four, because nothing else is queued  *Amended 18 October 2026 `b0abd71`:* the INVENTORY of what a tablet may attempt had drifted from the server. `ONLINE_ONLY` — where a technician's "why can I not do this?" comes from — explained three commands that no longer exist under those names and said nothing at all about **twenty-one that do**: every transfer, the cancellation, the deletion, both delivery calls, the refusal resolution, the rescheduling and the technician assignments. Each fell through to "This needs a connection to the EJE server", the one sentence that is true of everything and useful for nothing. Every command now has a reason written for the person who reads it, and `offline-inventory.test.ts` compares the two sides against the REAL command registry, so a command added to the server without an offline decision fails a test by name. **The allowlist itself is unchanged** — nothing new may be held on a tablet |
| OFF-7 | Upload retry and resume | **PARTIAL** `0b1bf60`, *advanced 18 October 2026* `8201d30` — RETRY is safe and proved: every upload path (job photograph, checklist evidence, machine photograph) and every queued capture carries an idempotency key minted once per capture, so a retry after a dropped connection replays rather than duplicating (TAB-UPLOAD-1, OFF-QUEUE-4). A failed upload now also SURVIVES: the bytes are kept on the device and re-sent by the media queue, which re-sends only the files that did not land (OFF-MEDIA-1). RESUME — restarting a part-transferred file — is still **not** implemented: an interrupted upload is re-sent whole, because byte-range resume needs a chunked protocol on both sides that nobody has specified |
| OFF-8 | Sync states: synced / saved locally / syncing / waiting / action required | **PARTIAL** `0b1bf60`, amended 18 October 2026 `8f0b883` — the states a technician can actually reach are distinguished and named: *not sent* (held), *Sending…*, *refused — needs a decision*, *with the office* (BD-15) and *on the server* (the row leaves the queue). **"Sending…" is now PER ROW.** It was one spinner on a *Send* button standing for the whole queue, which on a bad link with a dozen captures reads as nothing happening at all; each row now says it for itself, and the checklist runner says it against the item. **The marker is deliberately in memory and never stored:** a `sending` written into IndexedDB would survive the tablet being killed mid-request, and the next launch would show a row as sending with nothing sending it — a lie only a person could clear. After a crash the honest state is `pending`, and the next flush re-sends under the same key. `pending-sending.test.ts`, 4 tests. The read cache separately says how old the job list is. The full five-state vocabulary belongs with the rest of Phase 4 |
| OFF-9 | Conflict detection; never a silent overwrite | **PARTIAL** `0b1bf60`, **substantially advanced 18 October 2026** `b813cc3` `e1f9bc0` — **nothing is silently overwritten, and that half is structural**: the append-only captures have nothing of the server's to overwrite, and the one capture that REPLACES something (a checklist answer, OFF-CHK-1) carries the instance and the answer it replaces, so the server refuses a stale one instead of applying it. The **resolution policy now exists** and is EJE's: a refused capture is retained and referred to the office, which applies it through the ordinary operation or records no action with a reason (CAP-REF-1…5, answering OFF-QUEUE-DEC-1). *Still partial:* the full five-state sync vocabulary (OFF-8), offline signatures (OFF-5) and offline evidence (OFF-12) remain outside this |
| PWA-1 | Installable to the tablet home screen | **TESTED — awaiting approval** `a690dda`. `src/app/manifest.ts` — Next's own manifest convention, so the framework serves it at `/manifest.webmanifest` with the right content type and links it from every document. Name, short name, `start_url: '/'`, `scope: '/'`, two icon sizes and a **maskable** one, which is what stops an Android launcher cropping the corners off. The icons are generated reproducibly by `scripts/generate-pwa-icons.mjs` using only `node:zlib` — no image dependency was added — and `manifest.test.ts` reads each file and asserts it is a PNG of the size the manifest claims, because an icon that is missing or the wrong size means the browser silently never offers the install. **Deliberately absent:** `screenshots` and `shortcuts`, which would be invented product decisions (PROC-4). **Installation on the device itself is PWA-8 / ACC-PWA-1** |
| PWA-2 | Standalone app-like operation | **TESTED — awaiting approval** `a690dda`. `display: 'standalone'` in the manifest, with `appleWebApp` metadata and an Apple touch icon for an iPad, which does not read the manifest's icons. `theme_color`, `background_color` and the document's `theme-color` all come from ONE constant (`EJE_THEME_COLOR`), so a launch cannot flash a white frame before the application paints. **ACC-PWA-2 — no address bar, no browser chrome — needs the tablet**: nothing headless can see a launcher |
| PWA-3 | Camera / gallery access | **TESTED — awaiting approval** `a690dda`, and this row carried the worst of the old simulations. *What it was:* the photo panel posted a JSON body with a file name it invented and a size it made up (`add_media`), `addMedia` called `storage.put(…, null)` to allocate a key with nothing behind it, and the tile was a grey placeholder with an amber badge. A technician could photograph a burnt contactor, see it on the job card, and **no photograph existed anywhere** — including on the job card the customer signed for the work it was evidence of. *What it is:* `POST /api/jobs/:jobId/media` takes multipart bytes, sniffs them, refuses anything that is not a raster image, stores them through `storeUpload` and records the attachment **only once the bytes have landed** — the same order `attachDocument` uses, so the database cannot claim a photograph that is not there. `sizeBytes` is measured off the bytes. The panel offers *Take photo* (`capture="environment"`, the rear camera) and *Choose photo* (the gallery), shows the frame before it is sent, and a failure keeps the selection so *Try again* re-sends the same file rather than a second one. A new authenticated route serves one photograph back — inline, sandboxed, `no-store`, sniffed-type only — so the tiles are the photographs. **The JSON path is gone, not deprecated:** a JSON path to a photograph is a path to a photograph that is not there. *Still simulated and NOT part of this row:* checklist-evidence photographs and machine photographs, which still allocate a key with no bytes. **ACC-PWA-3 — the real camera opening on the tablet — needs the device** |
| PWA-4 | Recovery after interruption | **TESTED — awaiting approval** `a690dda`, for what Phase 3 can honestly deliver, which is a PLACE and not WORK. A flat battery, a locked tablet and a launcher reclaiming memory all leave the application reopening as a fresh document with no history, which drops a technician who was half-way through a job onto a list of thirty. The job they had open is recorded per user in IndexedDB on arrival at the job — on arrival, because none of those interruptions run any code on the way out — and the job list offers *Resume EJE-1042* while that job is still on their list. It says in the same breath that anything not sent to the server was **not** kept, because nothing is kept locally in Phase 3. **Not this row:** durable local drafts and surviving an interruption mid-capture with the work intact, which are OFF-1 and ACC-OFF-4, in Phase 4. **ACC-PWA-4 needs the device** |
| UX-1 | Rugged-tablet touch usability | **STILL UNVERIFIED on the device — and no longer untested.** *Amended 18 October 2026* `660f2ad`: the row read **UNVERIFIED — no responsive or touch tests exist**, and the second half of that is now false. `npm run responsive-check` measures 90 cases — 21 office screens and 6 technician screens at 1024×768, 820×1180 and 390×844, plus long content typed into the real filters — for sideways scroll, controls whose box ends past the right edge, tap targets below 36px, controls that cannot be focused, and the same measurements again under a 200-character fault description and a long Afrikaans customer name. It is a CI step. **Five classes of real defect were found and fixed:** the closed navigation drawer was focusable and announced while off-canvas (now `inert`), breadcrumb links were 16px tall, the job-number link on the activity trail and the dashboard was 58×16px, the search screen's example chips were 24px tall, and the calendar's "+N more" sat below the bars beside it. **Two rules in the audit are decisions and are written beside the number:** a control inside a container that genuinely scrolls sideways is reached by scrolling it (one clipped by a container that does NOT scroll is still a defect), and a bar in the month grid is held to 20px rather than 36 because a month is five rows of seven days. **The first version of the script passed without measuring anything** — `page.evaluate` given a function-shaped STRING evaluates it as an expression — and that is recorded in the script, because a suite that cannot fail is worse than none. **ACCEPTANCE STILL REQUIRES THE RUGGED DEVICE:** glare, gloves, a real stylus, a dropped connection and a tablet that has been dropped are not things a headless browser measures. UX-1 is **UNVERIFIED** until it is used in the workshop  *Amended 18 October 2026* `8f0b883`: the audit is now **96 measurements**, with two additions. A KEYBOARD WALK presses Tab twenty times on five screens and, after each press, fails if focus reaches something inside an `inert` or hidden region, lands on an element off the screen, or lands anywhere with **no visible focus ring** — the two defects that make keyboard work impossible and never show up in a screenshot. And a LIBRARY INDEXING STATE check uploads a real scan, asserts the card says it is not searchable, that the office is told WHY (the reason names OCR), that there is a retry, and that **re-indexing a scan does not claim it is now searchable**. Nothing in either is device acceptance |

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

> **Amended 17 October 2026 (CR-09 Phase 3)** `a690dda`. The paragraph above
> was true when it was written and is kept. **PWA-1…PWA-4 are no longer NOT
> IMPLEMENTED** — see their rows, which now carry what was built and what each
> still needs the rugged tablet for. **OFF-1…OFF-9 ARE unchanged and remain NOT
> IMPLEMENTED**, deliberately: Phase 3 is a read cache, and every one of those
> rows is about capturing or reconciling work offline. **UX-1 is unchanged** at
> PARTIAL — a tap target is not a gesture test and neither is a rugged device.
>
> What a technician can now do with no signal: open the installed application,
> see their assigned job LIST as the server last gave it, and be told plainly
> which copy it is and when it arrived. What they cannot do: open a job's
> detail, capture anything, or sign. The application says so; it does not
> accept work it is going to drop.

### Remaining workflow and data gaps

| ID | Requirement | Status |
|---|---|---|
| MEDIA-1 | Customer-facing vs Internal classification | **TESTED — awaiting approval** `28557da`. `job_media.visibility` — `customer_facing` | `internal` — set when a photograph is captured and correctable afterwards (`set_media_visibility`, its own action and its own audit event `photo_visibility_changed`). Migration `0009_media_visibility.sql` is additive. **The default is `customer_facing`, and that is a decision worth reviewing:** it is what every existing photograph already WAS in effect, because the customer document printed them all, so recording them otherwise would reclassify records nobody has reviewed — including on signed job cards. New media defaults the same way and the technician marks the exceptions. **Reclassifying is refused once the customer has signed** (IMMUT-7) at three layers: `assertEditable`, the repository's frozen fingerprint, and `0007`'s trigger |
| MEDIA-2 | Only customer-facing media in the customer PDF | **TESTED — awaiting approval** `28557da` — *satisfied by MEDIA-1's minimal supporting change, not by separate work, and flagged as such rather than claimed quietly.* `lib/job-card/model.ts` mapped EVERY photograph onto the customer's document, so a technician's note to the workshop had its caption printed on the job card the customer signed. It now filters on `visibility`. **The one line was not optional:** a classification the document ignores is a control that lies, so MEDIA-1 could not ship truthfully without it. The filter is in the MODEL, which the on-screen preview, the PDF and the stored document all share, so they cannot disagree. **Unchanged:** DOC-1 still omits an empty section rather than printing a bare heading |
| CHK-EVIDENCE-1 | **Checklist evidence is a real, stored photograph** | **TESTED — awaiting approval** `0b1bf60`. *Its own ID because nothing in this register named it, and what was there was worse than a gap.* `add_checklist_photo` took an item id and a file NAME in a JSON body, called `storage.put(…, null)` and recorded an attachment with a hard-coded 1.65 MB size. Those attachments are what `completeChecklist` counts for an item marked `photoRequired` — so an installation checklist could be completed, and the customer's job card could cite photographic evidence, over files that had never existed. Evidence now arrives as multipart bytes at `POST /api/jobs/:jobId/checklist/:itemId/photo`, which sniffs them (raster images only), stores them through `storeUpload` and records the attachment **only once the bytes have landed**; the size is measured off the bytes. It is read back through the authenticated media route, so the runner shows the photographs rather than a green chip bearing a client-invented file name. **Historical integrity:** the attachment hangs off the ANSWER, which hangs off the question and the job's own checklist INSTANCE with its fixed `templateVersion` — so evidence stays bound to the wording the technician answered, and `checklist_versions` is still write-once once used. **No migration:** `checklist_answer_photos` already existed with `content_type` and `size_bytes`. The JSON command is **deleted, not deprecated**. Proved over HTTP (`checklist-evidence-api.test.ts`, 15 tests) and on real PostgreSQL with real file storage (`evidence-persistence.db.test.ts`) |
| MACH-PHOTO-1 | **A machine photograph is a real, stored photograph** | **TESTED — awaiting approval** `0b1bf60`. `createMachine` took `photos: [{ fileName, caption, sizeBytes }]` — metadata the client made up — and called `storage.put(…, null)` on each, so the register displayed photographs that did not exist. A machine is now raised first and photographed afterwards through `POST /api/machines/:machineId/photos`, with the bytes sniffed, stored and measured; `GET /api/machines/:machineId/photos/:attachmentId` serves one back after authorising the MACHINE. **No permission was widened, and that is the careful part:** the office may photograph any machine; a technician may photograph only a machine THEY raised while it is still `pending_approval`, which is an act they could already perform at creation; a technician photographing an approved machine is **refused (403)**. A photograph never changes machine data and never alters approval — asserted on PostgreSQL. **No migration:** `machine_photos` already existed. *Unchanged:* a technician may not edit or approve an official machine record, and the register screen itself remains office-only (`machines.manage`), so the technician branch of the photo panel is reachable only if a technician-side machine-raising screen is ever built. See **MACH-PHOTO-2** |
| MACH-PHOTO-2 | ~~**May a technician attach a photograph to an OFFICIAL machine record?**~~ | **ANSWERED 18 October 2026 by BD-14**, implemented `b813cc3`. EJE chose option (b) with the authorisation narrowed to the work: a technician may photograph an official machine when the photograph belongs to a job of theirs, and may still change nothing about the record. Held as **MACH-PHOTO-3**. *The question as it was asked, kept:* **OPEN — business decision**, carried as **BD-14**. Refused today, deliberately. A photograph of a rating plate on an official machine is obviously useful and is just as obviously content attached to a record the scope says technicians may not change outside the change-request process. Whether it should be allowed, and whether it should wait for Master approval the way a discovered machine does, is EJE's to decide (PROC-4) |
| TAB-STATE-1 | **A dropped connection does not empty the screen** | **TESTED — awaiting approval** `0b1bf60`. `useQuery` used to answer every failure the same way: data `null`, error set. For a refusal that is right and necessary — a 403 or a 404 may mean this actor may no longer see what they are looking at — but for a TRANSPORT failure it meant a technician mid-capture on a tablet that lost signal had the job replaced by an error panel, losing their place and the context of what they had just captured. The last answer is now kept for a transport failure only, the failure is still reported (`error` is still set and the connection banner is global), and the job screen shows the job it has rather than a full-page error whenever it has one. Every other screen is unchanged, because each still checks `error` first. The network message itself was amended too: *"Your change has not been saved"* is false for a capture that was held, so the transport layer now reports the transport and each caller states the consequence |
| TAB-UPLOAD-1 | **A retried upload never duplicates the record** | **TESTED — awaiting approval** `0b1bf60`. The field case that produced it: a tablet at the edge of coverage sends 2 MB, the server stores it and commits, the answer is lost on the way back, and the technician taps *Try again* — two photographs on a job card somebody is about to sign, indistinguishable from a deliberate second shot. Every upload path (job photograph, checklist evidence, machine photograph) now mints an idempotency key ONCE per capture and reuses it for every attempt at that capture, and `uploadRoute` honours it — scoped to the actor, the operation and the request's content, the file's bytes included, so a key reused for a DIFFERENT photograph is refused rather than answered about the wrong one. A deliberate second photograph is a new capture with a new key, so `uploadRoute`'s original reasoning — *"a retried upload is a second attachment"* — is kept and still holds for the case it was written about |
| MEDIA-5 | Video capture | **TESTED — awaiting approval.** *Built 21 October 2026.* A technician records or chooses a clip; the server sniffs the CONTAINER BRAND (`isom`/`mp4`/`avc1`/`qt`/`3gp`, plus Matroska's EBML header), so an HEIC still or an M4A voice note in the same `ftyp` container is refused rather than filed as a video. Its own 60 MB limit, which is also a memory budget because the route buffers the body; the photograph path keeps its 25 MB. Stored through `storeAndMeasure` like everything else, read back, measured, checksummed, authorised on retrieval by the same rule as a photograph, and PLAYED in the grid rather than drawn as an icon. **Two things are deliberately NOT decided here.** A video does not reach the customer's job card — that document is a PDF and cannot carry one, so `visibility` is forced to `internal` **by the server**, and *does a customer ever receive a video, and how* is recorded as EJE's to answer. And capture is online-only: the held-work queue is 40 MB for ALL of a technician's unsent captures, so one clip could fill it, and it is refused with that reason rather than crowding out the photographs a job needs |
| MEDIA-6 | **A captured photograph is actually stored, and can be read back** | **TESTED — awaiting approval** `a690dda`; *amended 17 October 2026* `0b1bf60` — the job photo panel now mints an idempotency key when a photograph is CHOSEN and reuses it on every attempt, so *Try again* after a dropped connection cannot attach the same photograph twice (TAB-UPLOAD-1). The original entry follows. Recorded as its own ID because it is the property the old simulation broke, and nothing in this register named it: an attachment row on a job card must mean a file exists. `addMedia` now stores the bytes before recording the row and raises if they did not land, and `GET /api/jobs/:jobId/media/:attachmentId` serves one back after authorising the JOB, not the file — a storage key is not a credential and there is no route that takes one. A row from before this existed, with a key and no bytes, answers 404 and renders as a placeholder that does not pretend to be a photograph. The photograph is served INLINE, unlike a document, because a thumbnail has to render; that is safe only because the type is sniffed server-side and restricted to raster images, with `nosniff` and a `default-src 'none'; sandbox` policy on the response. Proved over the real HTTP surface in `media-api.test.ts` (21 tests, including a PDF refused, an executable refused, a media id moved onto another job refused, a document id refused through the media route, and a technician who may not see the job getting 404 rather than 403) and end to end in a real browser by `scripts/smoke.mjs`, which waits for the browser to DECODE the bytes it fetched |
| EMAIL-2 | Microsoft 365 / Graph adapter | **DONE** `8479a69` — `GraphEmailService`. *Amended 26 September 2026 by CR-09 Phase 1:* the row read **NOT IMPLEMENTED — simulated only** until the adapter existed. Graph is production; SMTP (`src/services/development/email.ts`) is a development and testing transport and is refused in production |
| DRAFT-1 | Draft jobs, Master-only | **TESTED — awaiting approval** `aaf5a33`, amended `f129e22`. *Amended 22 October 2026; the row read **NOT IMPLEMENTED** — creation always `open`.* **The two rules it rested on were answered from what the system already says, not guessed.** (1) *What may a draft omit?* Exactly what the TECHNICIAN supplies — the fault description and the machine — and nothing else. Who the job is FOR is still required, because a draft addressed to nobody is not a draft of a job card. (2) *Which day’s rates does a released draft use?* The question does not arise: COST-8 freezes rates at SIGNATURE, not at creation, so a draft carries no rates to go stale. **Releasing defers the validation and never weakens it:** `assertReadyForWork` is one function called by both `createJob` and `releaseDraft`, so there is one rule rather than two copies, and releasing re-asks every question against the job as it now stands. The job NUMBER is kept, so drafting does not move the sequence. **A draft is invisible to everybody but a Master**, including a Coordinator who may otherwise read every job in the business and a technician named on one as an intention: `jobs.manageDrafts` is Master-only, `withoutHiddenDrafts` filters every list, and the draft rule is applied **before** the `jobs.viewAll` short-circuit — which is where the route test found two real holes, a 200 from `loadJobView` and a 403 from `loadVisibleJob` that confirmed the job existed. A hidden draft is a **404**. It is absent from the calendar for its own reason rather than by being inactive, and absent from the Jobs spreadsheet for everybody but a Master (`f129e22`, six cases, which ask for drafts explicitly because the export’s default `open-work` filter excludes them anyway). **Evidence:** 21 application tests, 9 over the real HTTP routes, 6 on the export |
| SPARE-2 | Spares: description, notes, photo, request date | **TESTED — awaiting approval** `2de1e65`. *Amended 26 September 2026:* the row read **PARTIAL — only `awaiting_spares_reason`**, one free-text line that conflated the part somebody has to order with anything else going on, had nowhere for the photograph, and recorded no date — so nobody could say how long a machine had stood. `Job.sparesRequest` now carries all four. **Two readings are made explicit rather than guessed at:** *request date* is the moment the request was RAISED, stamped from the server's clock and absent from the API schema so a client cannot backdate it — **not** an expected-return date, which would be a different field and is not invented here; and *photo* is a reference to one of the job's OWN photographs, refused if the id belongs to another job, **not** a second upload path. Migration `0008_spares_request.sql` is additive and renames nothing — `awaiting_spares_reason` keeps its data as the description. **`returnToInProgress` no longer CLEARS it**: the status moves and the history stays, because how long a job waited is what the office is asked afterwards, and the resume audit line now says it. A persisted demonstration snapshot is upgraded in place (v12→v13) rather than discarded; the one thing it cannot recover is the original request date, and it says so |
| CUST-CR | Customer change requests | **TESTED — awaiting approval; BOTH halves now exist (`9750b40`…`c44515d` for the register half, `6a8b7c8` for the job half).** *Amended 22 October 2026; the row read **PARTIAL — the other half is NOT IMPLEMENTED and stays blocked on #27**.* **THE JOB HALF, and its three questions answered the way the register half answered its own — by building the MESSAGE and leaving the CHANGE to a person.** (1) *Who raises one?* Somebody at EJE, on the customer’s behalf: a customer has no account, no portal and no role in this system, so a customer’s request arrives by telephone and is written down. `raisedBy` is the EJE person who took the call and `requestedByContactId` is the customer contact who made it, chosen from that customer’s own contacts and NULLABLE, because the office does not always know which of four people telephoned and a required field that gets filled in with "the customer" is worse than an empty one. (2) *What may it change?* Nothing, by itself — exactly as in the register half. It is a recorded request and the office’s recorded decision; the office then makes any change on the screen that already authorises it. (3) *What does it do to a job in progress, and how does it meet CR-01’s finality?* Nothing and therefore nothing: a request carries no proposed value and cannot touch a job, so a signed job card stays untouchable and the post-signature question remains BD-02’s, where it was. **Authority to resolve follows the SUBJECT, not the table:** a job request is decided by `jobs.viewAll` and a register request by `customers.manage`, because the person who can answer "did we agree to that" is the person who runs the job. The request is visible only to somebody who may see the job, the audit lands on the job’s own trail, and a job id or a contact on a register-subject request is REFUSED both in the operation and by the database. 19 application tests and 6 more on PostgreSQL, over the 40 below. **THE REGISTER HALF, unchanged:** *Amended 18 October 2026; the row read **NOT IMPLEMENTED**.* **Read the split first, because the requirement's own wording is wider than what was built.** Issue #27 asks for *a CUSTOMER's request to change something on a JOB*, and its three questions — who raises one, what it may change and what it does to a job already in progress, and how it meets CR-01's finality after signature (IMMUT-9, BD-02) — are **unanswered, so that half was not built and must not be inferred from this one.** What IS built is the half the register already promised and the machine work kept pointing at: a report that a customer, site or machine record is wrong, raised by anybody who can READ the customer — which is the point, because the people who find the register wrong are the ones who may not edit it — and resolved by `customers.manage` with a note that is required on BOTH outcomes, since "declined" with no reason is how people stop reporting things. **It is a message about a record, not a pending edit.** There is deliberately no proposed-value column and nothing here writes to the register: *applied* records that a person made the change on the screen that already authorises it, and the dialog says so, because a button labelled "apply" that changes nothing would be a lie about what happened. Whether an approval should apply a change automatically, and what MACH-HIST would then have to record, are EJE's to decide (#27, #28) and are NOT invented here. What the database enforces, because a store cannot: a report has to say something; the state and the attribution cannot disagree, so resolved-with-nobody-recorded and open-while-claiming-to-be-resolved are both refused; and every foreign key RESTRICTs, so deleting the record a report is about cannot quietly erase the report. Resolving is conditional on `state = 'open'` IN THE WRITE, so two office users deciding at once is settled by the database and the second is told it has been dealt with rather than overwriting the first. A technician asking for the office's register gets a **403 rather than an empty list**, because an empty list reads as "there are no problems with the register", which is a different and false statement; the customer screen composes the reports SERVER-SIDE so the field is empty in a technician's own response. 40 tests (21 application, 10 over the real HTTP routes, 9 on PostgreSQL for the constraints, the foreign keys and the concurrent decision) and three steps of `scripts/smoke.mjs` in a real browser |
| MACH-HIST | Machine location history | **TESTED — awaiting approval** `1299e4a`. *Amended 22 October 2026; the row read **NOT IMPLEMENTED**, and the paragraph below is kept because it is still the reason the model is the shape it is.* **WHAT WAS BUILT:** `machine_movements` (migration `0024`) records where a machine came FROM, where it went TO, the day it took effect, a note, and who wrote it down. `updateMachine` writes one only when the site or the customer actually changed, so amending a model number does not invent a relocation, and the movement’s effective day is the office’s to give rather than the day somebody got round to the screen. Rows are insert-only — a movement is a historical statement and correcting one is a different question — and the history reads newest-first with `recorded_at` breaking a same-day tie. `machineLocationAsAt(movements, on)` is a pure, tested function that answers *"where did this machine stand on that date"*, which is the whole point of keeping the record. **WHAT IS STILL EJE’S (BD-20):** whether a JOB screen should show where the machine stood AT THE TIME of the work instead of where it stands now. The function to answer it exists and nothing calls it from a job screen, because that changes what a finished job card appears to say. **The history starts EMPTY and that is deliberate, not a failed backfill:** there is no record of past moves to import, and inventing a first movement from today’s register would be a statement nobody made. 11 application tests and 7 on PostgreSQL. *The 18 October amendment* `0e6e0d1`: no movement record, no effective dates and no relocation workflow were invented — the canonical model and whether a customer change needs approval are EJE's to decide (#28). Two things around it were fixed. **The register is now internally consistent:** `createMachine` and `updateMachine` took the customer and the site straight from the request, and the database's foreign keys have nothing to say about the PAIR being wrong, so a machine could be recorded against one customer standing at another's site, or at a site withdrawn last year, and every job raised on it afterwards inherited that. Both now refuse an unknown customer, a site that is not that customer's (one refusal for "no such site" and "somebody else's", so the response cannot be used to ask which ids exist), an archived site a machine is being MOVED onto, and a withdrawn customer on CREATE only — while amending a machine already standing on a since-withdrawn site stays allowed, because otherwise archiving a site would make its machines uneditable. **And the job screen no longer presents today's register as history:** a finished job resolves its machine and site live, which reads like a record of where the work happened; both cards now say they are the register as it stands today and name the real historical record — the issued document, whose bytes cannot change. 7 application tests, 1 on PostgreSQL for concurrent amendments, and a browser assertion that the label is on a closed job and ABSENT from one in progress. **Amended 23 October 2026: BD-20 ANSWERED** `7203721`. A CLOSED job now shows where the machine stood AT THE TIME OF THE WORK, as at the day it was completed, resolved server-side from the movement history; a job in progress shows the current register. **Where the history cannot answer it says so** rather than letting today’s register be read as historical fact — the common case today, since movements record only moves made from now on |
| COST-5 | Additional charges and discounts | **TESTED — awaiting approval** `149bf7e`, amended `6008e35`. *Amended 22 October 2026; the row read **NOT IMPLEMENTED**.* **The shape is a RECOMMENDATION and BD-19 is open:** a discount is a single fixed amount off, applied BEFORE VAT, authorised by a Master with a reason that is required — and the alternatives EJE may prefer instead (a percentage, a per-line discount, a Coordinator ceiling) are recorded in BD-19 rather than decided here. **An additional charge is a description and an amount**, with no quantity and no unit price, because the things it exists for — a call-out levy, a courier, a consumable nobody stocks — are not measured in units; anything that is belongs on a parts or labour line, where it already has a rate. **The discount is a NEGATIVE line in the snapshot**, so summing the lines still equals the subtotal and no reader has to know a discount exists to total a job card correctly. It is **capped at the gross subtotal** in the calculation and **refused above it** in the operation, so a discount can never make a job card negative, and VAT is computed on what is left rather than on what was asked. **What the database enforces, because a store cannot:** a discount’s amount, authoriser, timestamp and reason are all-or-nothing (NULL-proof equivalences, since a NULL inside a CHECK reads as satisfied); a discount is strictly positive; a charge has a description that is not merely whitespace — `~ '[^[:space:]]'` rather than `btrim(x) <> ''`, which trims SPACES ONLY and let a tab-only description through; and a snapshot’s discount never exceeds its gross subtotal. **Two defects this found in itself:** a blank description answered 200 because `text(500)` has nothing to say about whitespace (now trimmed and refused in the operation, where the message belongs), and migration `0023` silently kept the OLD line constraint when it was written with `duplicate_object` — which refused the negative discount line and ACCEPTED a discount recorded as a positive amount, i.e. one that anything summing the lines would have ADDED to the bill (`6008e35`, with `redefinitions.test.ts` to stop the class of mistake recurring). **Evidence:** 16 application tests, 11 over the real HTTP routes, 14 on PostgreSQL for the constraints. **Amended 23 October 2026: BD-19 ANSWERED, and the recommended shape STANDS** — a fixed amount, before VAT, Master only, with the Coordinator ceiling DECLINED. No code changed; `7203721` adds the assertion that a Coordinator does not hold `jobs.applyDiscount` |
| AUDIT-2 | Structured before/after values | **TESTED — awaiting approval** `9c5ed5e`. *Amended 26 September 2026:* the row read **PARTIAL — narrative detail only**, and CR-10 pinned the gap to `audit_events.metadata` — a `jsonb` column that existed and was never written to. It is written now. `ActivityEvent.changes` carries `{field, from, to}` with values kept as they are (cents as numbers, an enum as its own string, absence as null) rather than pre-formatted, because a trail holding "R1 850,00" could never be compared or re-rendered. Populated where an existing recorded value was REPLACED — an amended labour, travel or part line, and the charge-out rates — and **only for the fields that actually moved**. Every other event carries an empty list and the column stays NULL. The screens are unchanged: the schema's own note says `metadata` is used sparingly and that `summary` and `detail` remain the record a person reads, and they still are. `audit-changes.test.ts` covers the operations; `job-history.db.test.ts` covers the round trip through the column, including a row whose `metadata` predates this and one carrying a malformed entry |
| AUDIT-3 | **Every change to what the customer is charged is recorded, including a charge being taken AWAY** | **TESTED — awaiting approval** `3ab8d94`. *Found while implementing AUDIT-2 and deliberately left for its own change rather than widened into that one; the AUDIT-2 commit and issue #5 both flagged it.* **Two operations wrote a job and recorded nothing, on any reachable path.** `removeLineItem` deletes a labour, travel or parts line — the one edit that takes money OFF what the customer is asked to pay — and its only trail was `recordPostSignatureChange`, which cannot fire here because `assertEditable` refuses a signed job first. `setCalloutApplied` puts a fixed sum on the customer's document or takes it off (COST-CALLOUT) and recorded nothing in any job state. So a three-hour labour line could be deleted and nothing anywhere said it had ever existed, which is precisely what an invoice dispute asks six months later. Both now write an event of their own — `line_item_removed` and `callout_changed` — carrying AUDIT-2's structured changes: a removal reports every field of the line going to **null**, so the trail says WHICH line went and not merely that one did. **The call-out event carries no money amount, deliberately:** the fee comes from the charge-out rates and is frozen into the pricing snapshot at submission, and a figure copied into the trail would be a second, unreconciled number. A value posted back unchanged still records nothing (AUDIT-2). `removeLineItem` additionally **refuses** a line that is not on the job, where it used to filter nothing, save, and report success — which is how a stale screen could be told its deletion had gone through twice. Surfaced where the office looks: both types carry an icon in the activity feed and join the *Work captured* filter group. **Deliberately NOT changed, and recorded so the decision is visible:** `startChecklist`, `answerChecklistItem`, `addChecklistPhoto` and `startSignature` also write without an event. None of them changes a charge — they are stage navigation and stored answers, and `completeChecklist` and `captureSignature` record the facts that matter. Auditing each checklist answer would fill the trail without adding to it | 17 Oct 2026, AUDIT-3 |
| SEARCH-4 | CSV / Excel export | **TESTED — awaiting approval** `636491c`. *Amended 18 October 2026:* the row read **NOT IMPLEMENTED**. Two exports now exist, and each is **the screen's own authorised read written as a file** rather than a second query: `/api/jobs/export` goes through `loadActiveJobList`, so DECISION 5 decides what is in a technician's file, and the filters are applied by `filterJobListRows` — the same function the Jobs screen itself calls, moved out of the page component precisely so an export cannot hold a second copy of the predicates and drift from the screen; `/api/jobs/closed/export` goes through `loadClosedJobs`, which **refuses** a role without `jobs.viewAll` before it reads a row, so a technician asking for the archive as a file is refused by the READ, with the archive's own wording and no bytes. **The format is written once** in `src/lib/csv.ts`: RFC 4180 quoting, CRLF, a UTF-8 BOM so Excel on Windows does not read "Müller" as "MÃ¼ller", and **formula injection neutralised** — a cell beginning `=`, `+`, `-`, `@` or a tab is prefixed with an apostrophe unless it is a plain number, so `=HYPERLINK(…)` typed into an order number is data while `-150.00` stays a figure. A result over the 5,000-row limit is **refused with the filters named as the remedy, never truncated**. **NO XLSX**, and that is a dependency decision rather than an omission: there is no spreadsheet library in this project and a real `.xlsx` writer is a zip container and a schema, which is not something to add behind an export button. **WHAT IS DELIBERATELY NOT EXPORTED, and is an owner decision — see BD-17:** the archive's read model carries each closed job's issued pricing snapshot (it is there so a historical document re-renders at its own rates) and the export does **not** carry it, because the archive SCREEN shows no figures and a spreadsheet of what every job was charged at is a disclosure EJE have not been asked about. No contact details, no storage keys, no staff email addresses and nothing about a session appear in either file — asserted against the bytes. **Evidence:** `csv.test.ts` (19), `exports.test.ts` (15, including a technician's file compared with an office file, a formula typed into a job's order number, and the archive's own prices asserted absent), `export-api.test.ts` (8, including 403 with no bytes and 400 for a filter nobody offers), and two smoke steps that catch the real download. **A defect the smoke suite caught:** the client read the file with `response.text()`, which strips a leading BOM — the server sent one and the saved file had none. **Amended 22 October 2026** `9959a91`: the price columns now EXIST, behind `jobs.exportPrices` — **a capability no role holds**, so the answer to BD-17 is a one-line change to `src/domain/access.ts` rather than a feature to build, and today every role’s file is byte-for-byte what it was. An empty cell rather than `0.00` for a job whose totals were never issued, because a zero claims a figure somebody recorded. **Amended 23 October 2026** `0ad0500`: **BD-17 and BD-18 are both ANSWERED.** The price columns now go to a MASTER and a COORDINATOR (`jobs.exportPrices`, in both office role lists and no other), and **every export is recorded on the audit trail and kept indefinitely** — the switch is gone, exports have their own activity group, and the record names the columns taken and never the rows. An export that was refused records nothing |
| LIB-5 | Full-text PDF search / OCR | **TESTED — awaiting approval; full-text search `17132af`, the indexing architecture, and the local engine `2ba76e4`. OCR is now IMPLEMENTED and OFF, which are two different statements.** *Amended 22 October 2026; the row read **PARTIAL — OCR is NOT implemented and is recorded, not performed**.* **THE LOCAL ENGINE IS FINISHED AND PROVED, not asserted:** `tesseract` and `pdftoppm` (poppler) behind the existing port, installed in a development container, run against an image-only PDF built for the purpose — `pdftotext` returns nothing from it — through the real queue and the real worker, ending in a full-text search that FINDS the alarm code only recognition could have produced. **Nothing leaves the premises and there is no hosted path to switch on:** the code to call an external provider does not exist, so no configuration mistake can send a customer’s drawing to one. **Every limit is explicit, named in the environment and reported by `npm run library:ocr --report`:** a deadline (20 minutes by default), a maximum input size (40 MB), a page cap, a recognised-text budget (2 MB), and the language data to use. A document that hits one is recorded as **searchable IN PART with the reason**, never as fully indexed and never as failed, and the pages that could not be read are counted. **Missing language data is detected and NAMED** rather than reported as an unreadable document, because the remedy is one `apt-get` line and nobody will guess it from "no text found". A customer’s file is written to a temporary workspace that is removed in a `finally`, on every path including a refusal. **It is OFF on every deployment:** `EJE_OCR` is unset, the preflight says so in those words, and whether EJE switch it on — on a VPS where recognising a 214-page manual is twenty minutes to an hour of CPU — is **BD-21**. *The earlier state:* *Amended 18 October 2026:* the row read **NOT IMPLEMENTED**, and what existed was metadata search — a term matched against the name, description, model, manufacturer and tags, which are the fields somebody typed into the upload form. **It starts with the file, because there was no file:** `addDocument` recorded metadata and allocated a storage key for bytes nobody ever sent (the dialog asked for a TYPED file name and asserted a page count of twelve). `POST /api/library/upload` is new — multipart, sniffed rather than believed, PDFs only — and it stores the bytes, takes the page count and size from the file, and indexes the text; the dialog now chooses a file. **The extractor is first-party** (`src/lib/pdf/extract-text.ts`): it inflates `/FlateDecode` streams and reads the text operators, with the positioning operators turned into spaces so a two-column page does not come back as one word. **What it cannot do is reported rather than discovered:** a scanned manual becomes `needs_ocr` with the reason; fonts carrying no usable encoding are checked for a plausible proportion of readable characters and reported as needing OCR rather than indexed as mojibake; encrypted or not-a-PDF becomes `failed` with the reason; a stream that will not decompress is counted and the count kept. **One index row per REVISION** (`library_document_text`, migration `0011`), so a new revision indexes itself and can neither inherit nor be shadowed by the text of the revision it supersedes; two CHECK constraints make the state and the text unable to disagree, because `indexed` with nothing behind it is the state in which a search silently finds nothing and looks like it worked. `search` is a GENERATED `tsvector` with a GIN index on the `simple` configuration — the rule `src/lib/text-search.ts` states and the demonstration store applies in JavaScript, so a search finds the same manuals on either backend; **no stemming**, which means "megger" does not find "meggered" and is a documented limit rather than an accident. **Authorisation is the same answer as every other library read:** `library.view` or nothing, decided in the read; only CURRENT revisions are answers, for everybody, because a pending upload is not reference material and an archived one has been withdrawn; and the index is never consulted for a document the application has not already cleared. **This found a real leak:** `runSearch` ran over every document whatever its status and whoever was asking, which made the global search box the way round the library screen's own filters. **What is NOT searchable is said out loud** — a badge per row, a count in the answer, and a `document_indexed` audit event per extraction. **AND THE PREVIEW IS THE REAL DOCUMENT.** *Amended 18 October 2026* `8ce8c86`: the in-page preview was a FACSIMILE — a white box with the manufacturer's name, the title and nine grey bars, captioned "Document preview is simulated in this demonstration". It was honest about being fake and useless for the only thing a preview is for: a technician cannot read a wiring diagram out of grey bars, and a Master cannot approve a document they have not seen. `DocumentPdfPreview` fetches the REVISION'S OWN BYTES through the authorised route and hands them to the browser's viewer. Nothing is reconstructed — no HTML rendering, no extracted text standing in for the page, no sample content — and there are five distinct outcomes: loading, ready, **no viewer** (Chrome on Android: the panel says so and offers the download, because a machine builder's manual cannot be redrawn the way our own job card can), **not a PDF** (the stored bytes carry no PDF header, so the file in storage is wrong), and **unavailable** (the server's own refusal, in its words). **THE REVISION IS CHECKED RATHER THAN ASSUMED:** the route names what it served (`X-EJE-Document-Revision`, `X-EJE-Document-Version`) and the preview refuses bytes whose revision is not the one it asked for. **Proved in a browser on both PDF paths** (`npm run tablet-pdf-check`, 12 steps): on a browser with a viewer the frame's `blob:` is read back inside the page and asserted for the `%PDF-` header, the exact uploaded byte length and the blob's type — the assertion a facsimile could never pass; on a browser without one, no frame, no `embed`, no `object`, no facsimile caption, the byte length still asserted and the download still offered; and another technician fetching a pending revision from their own browser gets 404 and no bytes. **AND THE STORED FILE CAN NOW BE OPENED.** `GET /api/library/:documentId/file` serves the bytes through `canOpenDocumentFile` — a current or archived revision to anybody who may read the library, a `pending_approval` one only to the office that has to read it to approve it or to the person who uploaded it, and a refusal that is a **404 rather than a 403** so the response cannot be used to ask what is waiting for approval. A record with no bytes behind it (every seeded document is metadata) answers 404 and says exactly that instead of an empty file. **A leak found by its own test:** `/api/library` returned every document's `storageKey` to the browser, which has no use for one; the view strips them now, which is the rule the job-attachment routes already stated. **INGESTION IS BOUNDED, AND THE `/ObjStm` CLAIM IS WITHDRAWN.** *Amended 18 October 2026* `8ce8c86`: a decompression bomb is stopped by `maxOutputLength` rather than inflated (32 MB of zeroes in a few kilobytes is counted as one unreadable stream and the rest of the document is still indexed — tested with a real bomb); the file size, the per-stream and total inflated bytes, the stream count and the page count are each bounded and each reported with the number that was exceeded; and **a corrupt file is no longer called `needs_ocr`** — a header with nothing behind it is `failed` with "truncated or corrupt, upload the document again", because reporting it as needing OCR sends somebody looking for a service they do not need. The old message blamed OBJECT STREAMS for finding no text and was wrong: the specification forbids putting a stream object inside an `/ObjStm`, so a file that packs its catalogue and page tree away still has its CONTENT streams at the top level, where this reads them — a fixture with an object stream and a cross-reference stream proves it. **AN INDEX CAN BE RETRIED.** `reindexDocument` re-reads the stored bytes for ONE revision (the office's capability, like approve and archive): without it the only way to re-index was to upload the document again, which creates a new revision — the library would gain a duplicate to fix a missing index. It is idempotent per revision, refuses a record with no stored file with that as the reason, and **cannot touch another revision's index**, proved by failing a re-index of version 2.0 and asserting version 1.0's index and text are untouched. The library screen shows the reason against each unsearchable document with the retry beside it, to the office only. **STILL NOT DONE, and not claimed:** OCR itself (no service is added and none is implied — whether EJE pay for one is their decision), and PDFs whose page content this parser cannot reach for some other reason, which are reported as needing OCR with what WAS found rather than guessed at. **Evidence:** `extract-text.test.ts` (11, including a real two-page PDF this system rendered, a Flate-compressed one, a scan, a subset font with no encoding, an encrypted file and a corrupt stream that is counted), `library-search.test.ts` (19, every one through a real PDF uploaded through the real operation), `library-search-api.test.ts` (10) and `library-text.db.test.ts` (8 on real PostgreSQL, including that the GIN index serves the query and that the constraints refuse a row whose state and content disagree). **Amended 23 October 2026: BD-21 ANSWERED — the demonstration environment first, measured** `fe3dd1e`. **23 to 25 seconds per A4 page at 300 dpi**, two samples, 0 pages failed, byte-identical text. So **a 214-page manual is ~83–89 minutes and cannot be read under the shipped defaults** — it is partially indexed and says "Searchable in part", which is honest but means a search may miss an alarm code. Raising a limit is EJE’s decision and is reported in `docs/library-ocr.md` §5 rather than taken. Nothing was installed on the production VPS |
| BACKUP-1 | Database **and files** backed up | **TESTED — awaiting approval**, amended 20 October 2026 by `5de49a6`, `49e79b4`, `36623b1`, `8197f78`, `56352d6`: the half of this requirement that was checked by nothing is now checked. A stored document was written with `writeFile` (no `fsync`, not atomic); `final_documents.size_bytes` and `.checksum_sha256` were never written at all; and the restore test's cross-check compared a storage key against FILE NAMES, so every reference in the database read as a missing document — a check that fails on a healthy backup, which is how it came to be switched off with `EJE_RESTORE_ALLOW_ORPHANS`. All four fixed, with the measurement recorded in an append-only `final_document_verifications` because the document row itself is write-once and the database refuses UPDATE on it. The original row follows. **TESTED — awaiting approval** `4684cf4`. *Amended 26 September 2026:* the row read **PARTIAL — `pg_dump` documented; storage not covered**, and the uncovered half was the one that cannot be rebuilt. `npm run backup` (`src/db/backup/`) writes the database dump AND an archive of `EJE_STORAGE_DIR` into one timestamped directory with a manifest of sizes, SHA-256 checksums and the build that produced them, reading the same variables the application reads. It **refuses rather than producing half a backup**: a missing or empty document directory, a dump `pg_restore` cannot read, or an archive holding fewer files than the directory does, each remove the part-written directory and exit non-zero — a database-only directory that looked like a backup would be worse than none. Artefacts are `0600` inside a `0700` directory, and a failing `pg_dump`'s message is kept while the password is removed from inside it. **`docs/vps-deployment.md`'s one-line `pg_dump` is replaced, not supplemented.** What is NOT done: it is not scheduled on any host (that is deployment) and it is not copied off the machine by anything here. *Amended 16 October 2026 by BACKUP-2 `0dbc071`:* what this command writes is now `database.dump.enc` and `storage.tar.gz.enc` — encrypted, with the plaintext removed in the same step — and it refuses to run at all without `EJE_BACKUP_KEY`. Everything else in this row still holds, including the two things it says are NOT done |
| BACKUP-2 | Encrypted, integrity-verified, restore-tested | **TESTED — awaiting approval**, amended 20 October 2026 by `d313756`, `f40bbd5`: the live server had **no scheduled backup of any kind**, so every backup on it was taken by hand. Nightly and weekly timers, an alert unit, a `last-run.json` written on every outcome, retention whose every rule is a refusal, and an off-site copy by mounted volume or rclone (`copy` AND `check`) — with a run that has no off-site destination saying so every time. `npm run dump:inspect` reads an old dump in a scratch database it drops again. **An off-site destination itself is still required from EJE** (see `docs/vps-backups.md`), and until one exists EJE have no backup that survives the machine. The original row follows. **TESTED — awaiting approval** `0dbc071`. *The original row is kept as written:* **NOT IMPLEMENTED** — and deliberately untouched by BACKUP-1 `4684cf4`; the checksums BACKUP-1 records are what a restore test would check against, they are not that test, and nothing was encrypted. All three parts now exist. **Encrypted:** AES-256-GCM, key from `EJE_BACKUP_KEY` only, never written into the backup and never printed; the manifest carries a truncated-SHA-256 fingerprint of the key so an operator holding several can tell which one a directory needs. **DECISION WORTH REVIEWING: there is no unencrypted path at all.** `npm run backup` refuses without a key rather than offering a flag, because a flag to write a complete copy of every signed job card in the clear would be used the first time somebody was in a hurry — and nothing is scheduled on any host yet, so this is the cheapest moment to make it absolute. **Integrity-verified:** `npm run backup:verify` recomputes the recorded SHA-256 *and* decrypts, because a checksum catches damage while only the GCM tag catches ALTERATION — whoever edits an artefact can recompute a checksum and cannot forge a tag. It decrypts into a temporary directory it removes, so running the check never leaves plaintext beside the ciphertext. **Restore-tested:** `npm run backup:restore-test` restores the dump into a scratch database it creates and drops — the name is generated, matched against a pattern and against the source's name, and an existing one is refused rather than replaced — then unpacks the archive and walks **every `storage_key` in the restored database** demanding the file, which is the failure BACKUP-1 exists to prevent checked rather than argued. Both commands append a dated record to the manifest. A seeded development database has rows naming documents that were never generated; `EJE_RESTORE_ALLOW_ORPHANS=yes` accepts those and the unresolved count still goes into the manifest, because a restore record that cannot be told apart from a clean one is worth nothing. **What is still NOT done:** nothing is scheduled on any host and nothing copies a backup off the machine — both are deployment, as they were under BACKUP-1. *Amended 17 October 2026 `1cdc2d3` (issue #23):* **the scratch database name was only as unique as the second it was generated in.** `scratchDatabaseName` was the timestamp alone, so two `backup:restore-test` invocations starting inside the same second computed the SAME name and the second failed — not dangerously, since an existing database was already refused rather than replaced, but a run that should have succeeded did not. It now carries four random bytes after the timestamp, which stays first so a leftover database is still legible to whoever finds one. **The collision check was NOT relaxed to make room for it:** the two are independent protections and both are kept — randomness stops the collision happening, the refusal stops anything being overwritten if it ever does. The claim is now one injectable function, `claimScratchDatabase`, so the collision case is provoked EXACTLY in a test rather than waited for: 10,000 names generated at one fixed instant are all distinct, 50 claims against one server at one instant each take their own database, and a forced identical suffix is refused with the first claim's database untouched. On real PostgreSQL an occupied scratch database is refused with its rows intact, and two restore tests in parallel both complete and leave nothing behind. **Discriminating:** with the timestamp-only name restored, 5 unit tests fail and the parallel test fails with the collision itself *Amended 18 October 2026 `3600686`:* three gaps, all in the half that handles a file somebody else may have touched. **THE DOCUMENT ARCHIVE WAS UNPACKED ON TRUST** — a bare `tar -xzf`, which believes the archive describes ordinary files under its own root. Misplaced for the same reason the backup is encrypted: a backup exists in order to be COPIED, so by the time anybody restore-tests one it has been rsynced, carried on a disk and handled by people who are not EJE — and the GCM tag proves the bytes are unaltered, never that the archive was MADE honestly. `archive.ts` now lists the members and judges them BEFORE a byte is written: an absolute path, any `..` component, a symlink or hardlink (the dangerous one — `docs -> /home/user` followed by `docs/authorized_keys` writes outside the workspace while every path still looks relative), a device, FIFO or socket, and the same document twice (tar would overwrite, the restored bytes could not be identified, and the file count would still match the manifest). Two ceilings bound it — how many members, and how many bytes they CLAIM — so an archive that unpacks to 60 GB is refused before the partition fills. Afterwards the filesystem is compared with the listing: a file nobody declared, or a symlink on disk, is reported rather than smoothed over. GNU tar still does the reading and writing, because the point of `tar.gz` is that a person at a terminal can unpack it without this repository. **CTRL-C WAS A LEAK:** `finally` covers success and failure, not a signal — and a signal is the likely ending, with a scratch database holding a copy of the whole production database and a workspace holding every signed job card in plaintext. Both now go on SIGINT and SIGTERM through one idempotent cleanup, with the exit codes a shell expects; the warnings are written with `writeSync`, because `process.stderr.write` to a pipe is asynchronous and `process.exit` on the next line threw the message away. **AND NOTHING PROVED THE DATA SURVIVES:** a known caption and a known document now go in, and after backup, encryption, verification, decryption, restore and extraction the row is read back out of PostgreSQL and the file is compared BYTE FOR BYTE. 25 tests on the archive rules (the parser against hand-written listings including a device and an unreadable line; then every refusal against REAL archives built with real tar, each asserting the target directory is left EMPTY) and 22 in `backup.db.test.ts`. **The key's rotation and recovery procedure is now written out in `docs/vps-deployment.md` AND labelled as what it is — an operator procedure.** There is no key store, no scheduled rotation, no re-encryption command and no enforcement that an old key is kept until the last backup needing it is gone; BACKUP-2 cannot be called operationally complete until EJE's deployment and key-handling procedures are validated |
| IDEM-2 | Duplicate acceptance / submission tested | **TESTED — awaiting approval** `9f352cd`. *Amended 26 September 2026:* the row read **PARTIAL — mechanism present, untested**, and the mechanism turned out to be incomplete rather than merely unproven — two CONCURRENT requests issued the same job card twice and emailed the customer twice. Duplicate acceptance and duplicate submission are now covered at three layers: stale-copy refusals in `src/application/duplicate-operations.test.ts`, concurrent and repeated REQUESTS in `src/server/api/duplicate-operations.test.ts`, and the row-version race on real PostgreSQL in `src/server/api/duplicate-operations.db.test.ts`. *Amended `5112482`:* the row read **Duplicate submission is not proven against PostgreSQL — it cannot be, until AUD-10 is fixed**. AUD-10 was fixed at `11f8c0e` and it now is: see QA-2 |
| ARCH-6 | CI pipeline | **TESTED — awaiting approval** `43b4594`, amended `8a0a42b` and `660f2ad`. *Amended 18 October 2026:* the row read **NOT IMPLEMENTED**; see AUD-5 and QA-4, which carry the detail. `.github/workflows/ci.yml` runs three jobs on every push — the project's own gates, the PostgreSQL suite against a disposable `postgres:16` service with a health check, and the browser gates against a built application on the demonstration backend. No `continue-on-error`, no skipped suite, no secrets declared or needed. **The first remote run was RED while every local gate was green, and the cause is worth recording:** `playwright install chromium` also installs `chrome-headless-shell`, which Playwright launches and which reports `navigator.pdfViewerEnabled === false` — the same answer Chrome on Android gives. The application correctly drew the HTML job card (PDF-3) and the suite was waiting for the `<iframe>`, so 15 e2e steps failed and the smoke job was skipped. The suite was asserting which binary the runner installed. Both branches of the preview now carry one test id, the e2e asserts the branch MATCHES the browser's own capability, and `tablet-pdf-check` — which pins each branch to its own capability — is now a CI step, as is the tablet and phone layout audit. **The headless shell is kept deliberately: it is the more faithful simulation of the EJE tablets.** **Verified remotely, not inferred:** run `39105109269` on `17132af` — all three jobs and every step `success`, including the end-to-end workflow, the signed-document check on both PDF paths and the smoke suite |

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
>   correctly BLOCKED behind it. **Both addressed 27 September 2026
>   `28557da`.** This finding was right about the cause and understated the
>   consequence: with nothing to filter by, the customer's job card printed the
>   caption of every photograph on the job, including the ones taken for EJE
>   alone.
> - **DRAFT-1** — confirmed NOT IMPLEMENTED: `job-creation.ts:316` always
>   creates at `open`. **Noted inconsistency:** the browser demonstration seed
>   nevertheless contains a `draft` job, which is a state the application cannot
>   produce. Recorded under AUD-8's family of demo-data findings.
> - **AUDIT-2** — confirmed PARTIAL: `audit_events.metadata` is a `jsonb`
>   column that exists and is not used for structured before/after values. The
>   trail is narrative. **Addressed 26 September 2026 `9c5ed5e`** — the
>   column is now written, and this finding is what said where to write it. No
>   migration was needed, which is the whole reason this was the next thing
>   worth doing.
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
BD-11. **Answered and retained:** BD-07 (by CR-05), BD-09 (by CR-08),
BD-12 (by CR-12), BD-13 (by CR-13).

**Added 17 October 2026:** BD-14 (may a technician photograph an
official machine record — MACH-PHOTO-2), BD-15 (what happens to a capture the
server refuses after it was held offline — OFF-QUEUE-DEC-1), BD-16 (does unsent
work survive sign-out on a shared tablet — OFF-QUEUE-DEC-2). **ALL THREE WERE
ANSWERED BY EJE ON 18 OCTOBER 2026** and are implemented in `b813cc3` and
`e1f9bc0`; each row below carries the answer, and the section *CR-09 Phase 4,
STEP TWO* carries what it became (MACH-PHOTO-3, CAP-REF-1…5, OFF-SEC-1…2).
**Answered is not approved:** the implementation is TESTED and awaits the
owner's sign-off like everything else (PROC-4).

**Open at 18 October 2026:** BD-02, BD-03, BD-04, BD-05, BD-06, BD-08, BD-10,
BD-11. **Added 18 October 2026 by the reporting batch:** BD-17 (may the issued
prices be exported, and by whom — SEARCH-4), **OPEN**. **Added by the batch
after it:** BD-18 (is an export recorded on the audit trail — SEARCH-4),
**OPEN**; the mechanism exists and writes nothing.

**Added 22 October 2026 by the feature batch:** BD-19 (what shape is a
discount — COST-5), BD-20 (does a job screen show where the machine stood at the
time — MACH-HIST), BD-21 (is local text recognition switched on, and on what —
LIB-5).

**ALL FIVE WERE ANSWERED BY THE OWNER ON 23 OCTOBER 2026** — BD-17, BD-18,
BD-19, BD-20 and BD-21 — and each row below carries the answer and what it took.
**Two needed no code at all**, which is what building up to a decision rather than
past it is for: BD-19 chose the shape that had already shipped, and BD-17 was a
capability added to two role lists. **Answered is not approved:** the
implementations are TESTED and await the owner’s sign-off like everything else
(PROC-4), and none of the five issues is closed. **All three OPEN, and all three are decisions about a feature that is
already BUILT:** each one is configuration or a capability list rather than work,
which is deliberate — a question EJE have not been asked should not be answered
by a release. **BD-17 and BD-18 are also still OPEN**, and both are now a one-line
change: a capability no role holds, and an environment variable nothing sets.

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
| **BD-12** | ~~**MAY A TECHNICIAN ISSUE A PARTS COLLECTION?**~~ **ANSWERED 25 September 2026 by CR-12.** EJE chose option (b): a parts collection is counter work the OFFICE does, start to finish. `jobs.processParts` is held by the Master and the Coordinator and no longer by the technician, who is not part of the collection workflow at any point — not to accept one, not to process one, not to issue its note. Held as PARTS-14 and PARTS-15. *The question as it was asked, kept:* “`jobs.processParts` is held by the Master, the Coordinator **and the technician**, so a technician can today accept a parts job and issue its collection note — while the prose of CR-05, CR-07 and SUBMIT-10 consistently describes a parts collection as counter work the OFFICE processes. One of the two is wrong, and which one is a business question, not an implementation detail.” *Its three options, kept:* **(a)** confirm that a technician at the counter may, and amend the prose to say “whoever is at the counter”; **(b)** remove `jobs.processParts` from `TECHNICIAN_CAPABILITIES`, making parts strictly office work — **chosen**; **(c)** split the capability so a technician may process a collection they prepared but not one they did not | ROLE-5, SUBMIT-10, MOD-11 |
| **BD-13** | ~~**DOES A PARTS COLLECTION KEEP ITS "COLLECTION DETAILS" FIELD?**~~ **ANSWERED 25 September 2026 by CR-13.** EJE chose option (b): the field is removed from parts creation, and the document prints no section where there is nothing to print. Held as PARTS-17…PARTS-21. *The question as it was asked, kept:* **DOES A PARTS COLLECTION KEEP ITS "COLLECTION DETAILS" FIELD?** Raised by CR-12 and **deliberately not decided**. The instruction listed five fields to remove from parts creation: *scheduled date, priority, assignment, Courier Collection, collection details*. Items 4 and 5 read as one subject — the courier answer and the courier information that goes with it, both of which moved to the Collection step — but "Collection details" is also the on-screen label the fault-description field takes on a parts job, and that field is printed on the collection note as **Notes**. The two readings differ in what the customer's document says. **Current behaviour: the field is KEPT and still required**, because removing a field that carries printed customer-facing content on an ambiguous reading is not a change to make silently — and because the document section of the same instruction lists what a collection note must contain without mentioning a description either way. Options: **(a)** keep it as it is; **(b)** remove it from creation and print no Notes section on a collection (the empty-section rule DOC-1 already handles that); **(c)** keep it but make it optional | PARTS-7 |
| **BD-14** | ~~**MAY A TECHNICIAN PHOTOGRAPH AN OFFICIAL MACHINE RECORD?**~~ **ANSWERED 18 October 2026.** EJE chose **(b)**, narrowed to the work: *technicians may photograph official machines without changing official machine data.* So the permission is not "a technician may photograph any machine" — it is "a technician may photograph a machine their work is on", and the server decides whether that is true: the request names a job, and the job must be on this machine, carry the actor on its crew, and still be live. A photograph never touches a field, an approval or the history; the pending-approval and change-request workflows are exactly as they were; the register screen stays office-only. Implemented `b813cc3`, held as MACH-PHOTO-3. *The question as it was asked, kept:* Raised 17 October 2026 by MACH-PHOTO-1 and **deliberately not decided.** Today: refused (403). A technician may photograph only a machine they raised themselves while it is still awaiting approval, which mirrors what they could already do when raising it. The case for allowing more: a technician standing at the machine is the person who can photograph its rating plate, and a photograph adds information without changing any field. The case against: it attaches content to a record the scope says technicians may not change outside the change-request process, and nobody has said whether such a photograph should be visible immediately or wait for a Master. Options: **(a)** keep the refusal; **(b)** allow it outright, since a photograph changes no data; **(c)** allow it but hold the photograph pending Master approval, as a discovered machine is held. | MACH-PHOTO-2 |
| **BD-15** | ~~**WHAT HAPPENS TO A CAPTURE THE SERVER REFUSES AFTER IT WAS HELD OFFLINE?**~~ **ANSWERED 18 October 2026.** EJE chose **(c)**: *retain the capture and send it to the office for resolution.* The capture is kept with its original idempotency key and the server's actual refusal, marked as needing the office, and nothing replays it from the tablet; the technician's screen stops asking them to do anything about it. The office resolves it on *Field Captures* — applying it through the ordinary operation, with every domain rule intact and the referral left OPEN if the job still refuses, or recording no action with a reason. Option (b), re-aiming a capture at another job, was NOT chosen. No new role (one narrow capability on the existing Master and Coordinator), and no new job status. Implemented `b813cc3`, held as CAP-REF-1…5. *The question as it was asked, kept:* (Recorded as **OFF-QUEUE-DEC-1**.) Raised 17 October 2026 by Phase 4 step one. The structural half is settled and is not up for decision: nothing is silently overwritten, and the server's refusal stands. What is undecided is the REMEDY. A technician worked three hours on a job that was signed, closed or reassigned while their tablet was out of signal; the hours are real and the job will not take them. Today the capture is kept on the tablet with the server's own words on it, and the technician either tries again or discards it explicitly. Options: **(a)** keep that — the technician tells the office and the office decides; **(b)** let the refused capture be re-aimed at another job, which raises its own question about whose hours those are; **(c)** give the office a queue of refused captures to adjudicate, which needs a server-side store this batch deliberately did not build. **Until this is answered, no automatic resolution of any kind may be added.** | OFF-9, OFF-QUEUE-7 |
| **BD-16** | ~~**DOES UNSENT WORK SURVIVE SIGN-OUT ON A SHARED TABLET?**~~ **ANSWERED 18 October 2026.** EJE chose **(a)**, with the retention made account-bound: *retain unsent work securely under the original user's identity and restore it only after that user authenticates again.* Every write to the store now names the user it acts for and refuses a row belonging to anybody else; a sign-out explains the retention and says the next person will not see the work; a revoked session stops synchronisation without destroying anything. No credential, cookie or token is written to the device, and no encryption is claimed — the boundary is the application's, and the device's own is the tablet's screen lock and EJE's device policy. Answering it also exposed OFF-SEC-2, where an offline sign-out left the session usable; that is fixed in the same commit. Implemented `b813cc3`, held as OFF-SEC-1…2. *The question as it was asked, kept:* (Recorded as **OFF-QUEUE-DEC-2**.) Raised 17 October 2026 by Phase 4 step one. Today: **it survives**, keyed to its owner, and the sign-out dialog says so. The reasoning: destroying a technician's only record of work they did is the one thing CR-02 forbids outright, and a tablet whose battery died is the ordinary case rather than the exception. The cost: captured hours — the technician's own text, not customer data — stay in the device's IndexedDB after they sign out, on a device the next shift may pick up. They are shown only to their owner and cannot be read through the application by anybody else, but they are on the device. Options: **(a)** keep it; **(b)** refuse the sign-out while anything is unsent, which strands a technician who has to hand the tablet over; **(c)** clear it and warn loudly, which loses the work. | OFF-6, OFF-QUEUE-9 |
| **BD-17** | ~~**MAY THE ISSUED PRICES BE EXPORTED, AND BY WHOM?**~~ **ANSWERED 23 October 2026: THE OFFICE — A MASTER AND A COORDINATOR.** Implemented `0ad0500`: `jobs.exportPrices` is in both office role lists and in no other. A technician still may not, and the archive itself was already office-only (`loadClosedJobs` refuses a role without `jobs.viewAll` before it reads a row). Asserted against the FILE BYTES for the granted roles and the refused one, because a column list that drifted from the writer would pass a cheaper assertion and leak the money. The figures come from the write-once snapshot and are never recomputed.  Raised 18 October 2026 by SEARCH-4. The closed-job archive is an office screen (`jobs.viewAll`) and its read model carries each job's **issued pricing snapshot**, because a historical job card must re-render at the rates it was issued at. The archive SCREEN shows no figures, and the CSV export therefore carries none. But a spreadsheet of what every job was charged at is exactly what an office would want for invoicing and exactly what should not leave the building by accident, and the two questions are different: *may it be exported at all*, and *by Master only or by Coordinator too*. Nothing was decided: the columns are simply absent, which is the current behaviour and not the answer. | SEARCH-4. **Amended 22 October 2026** `9959a91`: *may it* and *by whom* are now separate. The four columns (subtotal excluding VAT, VAT, total including VAT, and the date the figures were issued) are built and tested; `jobs.exportPrices` gates them and **no role holds it**, so nothing changed for anybody until EJE name the roles. The figures come from the write-once pricing snapshot, so an export cannot reprice history |
| **BD-18** | ~~**IS A SPREADSHEET EXPORT RECORDED ON THE AUDIT TRAIL?**~~ **ANSWERED 23 October 2026: YES, ALL OF THEM, RETAINED INDEFINITELY.** Implemented `0ad0500`: THE SWITCH IS GONE. It had been a boolean in the source and then an environment variable — both were ways of not deciding on EJE’s behalf — and there is now no configuration that turns it off, which a test proves by setting the old `EJE_EXPORT_AUDIT=off` and watching the event be written anyway. The preflight SAYS SO when a stale variable is still in an environment file, because an operator who set it on an earlier release would otherwise believe they could switch the auditing back off. **Exports now have their own activity group:** every other event on that trail is a CHANGE to a record and an export is a READ. **Retention is "indefinitely" by BEHAVIOUR rather than by promise** — there is no retention job, no sweeper and no TTL anywhere in this system, which the PostgreSQL cases show rather than assert. An export that was REFUSED records nothing, because nothing left the building.  Raised 18 October 2026, from the third open question on SEARCH-4 (issue #25). A bulk read of customer data is arguably worth a trail — and three things change if one is written, each of them the owner's: **what the trail MEANS** (every event in it today is a CHANGE to a record; reads are not on it anywhere, so adding one kind of read makes its silence about every other read significant); **what the office SEES** (the activity screen is where a Master looks for what happened to a job, and a trail carrying every download needs filtering before it is useful); and **what EJE RETAIN about their own staff** ("who exported the customer list, when, with which filters" is monitoring, defensible and not to be switched on unasked). **The mechanism exists and writes nothing:** `src/application/export-audit.ts` has `EXPORT_AUDIT.recording = false`, both export routes call it, and `export-audit.test.ts` asserts the trail is unchanged after a real export. Enabling it needs: `recording` set true, a `data_exported` event type, an icon and filter group on the activity screen, and a retention decision — the `audit_events.type` column is `text`, so no migration. | SEARCH-4. **Amended 22 October 2026** `9959a91`, `b55599a`: the switch moved out of the source and into the environment, which matters in both directions. A boolean in a file is flipped by whoever is reading the file — which is how an unapproved record about EJE’s own staff gets switched on by somebody who thought they were finishing a feature — while `EJE_EXPORT_AUDIT=on` is a deployment decision, made by whoever administers the server, in the file where decisions of that kind live. **And answering BD-18 no longer needs a release.** When it is on, a real `data_exported` event is written: who, when, which export, which filters, how many rows and which columns — and **never the rows**, because an audit entry holding a copy of the exported data would be a second, unreviewed store of the same customer information. It is **off on every deployment today**, which the test asserts by counting events either side of a real export, and the preflight prints its state and says plainly that switching it on is monitoring of staff with retention unmanaged |
| **BD-19** | ~~**WHAT SHAPE IS A DISCOUNT?**~~ **ANSWERED 23 October 2026: THE RECOMMENDED SHAPE STANDS — a fixed amount, before VAT, MASTER ONLY — and the Coordinator ceiling was DECLINED.** So **no code changed**, which is the point of having built it to the recommendation. What `7203721` added is the ASSERTION that a Coordinator does not hold `jobs.applyDiscount`, checked at the capability and again at the operation: "let the Coordinator authorise small ones" is exactly the kind of convenience that gets added later without anybody treating it as a decision.  Raised 22 October 2026 by COST-5, which is built and needs this to be right rather than merely working. **What was built, and it is a RECOMMENDATION:** one fixed amount off the whole job, applied BEFORE VAT, authorised by a **Master** only, with a **reason that is required** and recorded against the job, capped at the gross subtotal and refused above it. **The four alternatives, each a different rule and each cheap to switch to now and expensive later:** (a) a **percentage** instead of an amount — which is how trade discount is usually agreed, and which then has to decide what it does to a job whose lines change after it was agreed; (b) **per-line** discounts rather than one on the job, which is what a parts-only concession looks like; (c) **after VAT** rather than before, which changes what SARS is owed and is therefore not ours to choose; (d) a **Coordinator ceiling** — an amount or a percentage a Coordinator may authorise without a Master — which is the one EJE are most likely to want and the one that needs a number. **Recommended: keep (the fixed amount, before VAT, Master-authorised) and add (d) with a figure EJE name.** Until then the code does what is described above and `AUDIT-3` records every discount applied and cleared. | COST-5 |
| **BD-20** | ~~**DOES A JOB SCREEN SHOW WHERE THE MACHINE STOOD AT THE TIME?**~~ **ANSWERED 23 October 2026: a CLOSED job shows the location at the time of the work; a job in progress shows the current register.** Implemented `7203721` as `JobView.machineLocationAtWork`, resolved server-side because naming a site means reading the register, archived sites included. As at THE DAY THE WORK WAS COMPLETED, not the day it was booked — a job scheduled for Tuesday and done on Thursday was done on Thursday. **And `{ known: false }` with a reason where the history cannot answer**, which is the case the owner was explicit about and the common one today, because `machine_movements` records only moves made from now on. A discriminated union rather than a nullable site, because "we do not know" and "it was here" are different answers and the screen says different things about them.  Raised 22 October 2026 by MACH-HIST, which is built and stops deliberately short of this. The movement history exists and `machineLocationAsAt(movements, on)` answers the question as a pure function; **no job screen calls it.** The reason it is a decision and not a detail: a finished job card today resolves its machine and site LIVE, and both cards say so in those words. Making a job screen show the historical site instead would change what a completed job appears to say about work already done — and the two readings are both defensible. *"The job happened at the site the machine stood at then"* is what an engineer means; *"the machine is at this customer now"* is what an office needs when telephoning about it. **Recommended: show BOTH on a closed job** — the historical site as the place the work happened, the current one labelled as the register today — and leave a job in progress showing the register alone, because there is nothing historical about it yet. **Also open with it:** whether an approved customer change request should move a machine automatically, which is the question CUST-CR and this one circle. | MACH-HIST, CUST-CR |
| **BD-21** | ~~**IS LOCAL TEXT RECOGNITION SWITCHED ON, AND ON WHAT?**~~ **ANSWERED 23 October 2026: THE DEMONSTRATION ENVIRONMENT FIRST, and measure before any production decision.** Implemented `fe3dd1e`, and **the measurement is the point**: a ten-page A4 300 dpi scan with no text layer, twice, took 248.1 s and 231.6 s — **23 to 25 seconds per page**, 0 pages failed, byte-identical text both times. That is SLOWER than the 5–15 seconds §2(a) estimated, and it means **a 214-page manual is ~83–89 minutes and cannot be read under the shipped defaults**: it meets `EJE_OCR_MAX_PAGES=40` at about page 40, and without that cap would meet the 20-minute deadline at about page 50. So a long manual is PARTIALLY INDEXED by default — recorded as "Searchable in part" with the reason, which is honest, but somebody searching for alarm 414 may not find it. **Raising either limit is a decision about how much of the VPS one document may occupy, so it is reported in `docs/library-ocr.md` §5 rather than changed on the owner’s behalf.** `deploy/eje-staging-ocr.env.example` is the demonstration configuration, in its own file so it cannot be pasted into a production environment file by accident, and the preflight WARNS when `EJE_OCR=local` is set on a deployment that declares itself production. **Nothing was installed on the production VPS and OCR was not enabled there.**  Raised 22 October 2026 by LIB-5, which is finished and off. The engine is local, proved against a real scan, and costs nothing per document — but recognising a 214-page manual is **twenty minutes to an hour of CPU**, and EJE’s VPS also serves the tablets. Three things need an answer and none of them is ours: **(1)** is it on at all (`EJE_OCR=local`, and `apt-get install tesseract-ocr tesseract-ocr-eng poppler-utils` on the server — which this development pass deliberately did NOT do on the production machine); **(2)** are the defaults right for that machine — a 20-minute deadline, 40 MB of input, a 2 MB text budget, all configurable and all reported by `npm run library:ocr --report`; **(3)** does the worker run on the same VPS or on a separate machine, since a long recognition on the web server is felt by whoever is using a tablet at the time. **Recommended: switch it on for the DEMONSTRATION first, with the defaults, and watch what a real manual costs before deciding about production.** Until then every scan is recorded as not searchable and SAYS so, which is truthful and costs nothing. | LIB-5 |
| **BD-10** | The `review` STATUS keeps its name although it is no longer an office review — it is where a signed job card waits for its own technician to submit it, and where a refused one waits for the office. Renaming it would touch stored history and would misdescribe the refusal case, so it was left; the rail therefore still reads *Review* between Customer Signature and Closed. Rename, or accept? | cosmetic |

---

## Retired behaviour, kept readable

`master_amended_after_signature` remains in `ActivityEventType` and nothing can
produce it. Jobs amended under the pre-CR-01 rule carry it, and v2.0 §17 asks
that historical records stay traceable — so the type is retired, not deleted.
`line-editing.test.ts` holds it unreachable.
