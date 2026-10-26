# What is actually left, 20 October 2026

> **COMPLETE INVENTORY, 26 October 2026** — made from `docs/SCOPE.md` at
> `87276d3` (CI green, run 40362376094) after the photograph, customer/site and
> attendance/timesheet work. **Nothing below is approved:** 172 register rows
> are *TESTED — awaiting approval*, which is the owner's act (PROC-4). The
> register is the source of truth; this is the map of who has to act.
>
> **1. Safe code changes — being done now, on `claude/office-workflow-parts`**
>
> | Item | What |
> |---|---|
> | MEDIA-7 | Real-browser proof that the PREVIEW carries the photograph — **done 26 Oct** |
> | SITE-2 | Office workflow for legacy multi-site customers: register filter, site-by-site preview — **done 26 Oct** |
> | WA-TRANSFER-1 | A transfer notifies the receiving technician on WhatsApp with the approved assignment template (provisional, BD-25) |
> | Register hygiene | AUD-3, AUD-4, AUD-8, DELIV-7, BD-02, BD-06 rows were overtaken and never marked — **amended 26 Oct** |
> | OFF-10, OFF-11 | Already met by existing behaviour; specified with evidence — **amended 26 Oct** |
> | SITE-1 follow-up | A preflight report of legacy multi-site customers, so the database constraint can be planned — **done 26 Oct** |
> | WA-TRANSFER-1 | **done 26 Oct** (provisional wording, BD-25) |
> | ATTEND-1 reporting | The register exported for a date range, audited — **done 26 Oct** |
>
> **2. Owner decisions that change business behaviour** (each OPEN in *Open business decisions*)
>
> | ID | Question | Behaviour until answered |
> |---|---|---|
> | **BD-23** | Offline signature / refusal (OFF-5) | Needs a connection; recommended default written down |
> | **BD-24** | How a call-out is counted on a timesheet | Once per job per technician, first day — provisional |
> | **BD-25** | Does a transfer need its own WhatsApp wording? | Approved assignment template reused |
> | BD-26 | Does a customer ever receive a video? | Never; videos are internal |
> | BD-27 | When is a correction's acknowledgement required? | The Master states it per correction |
> | BD-28 | May an approved change request move a machine? | No; the office moves it |
> | BD-29 | Resume an interrupted upload byte by byte? | Re-sent whole, never duplicated |
> | BD-30 | May a video be held offline (storage budget)? | Refused offline, with the reason |
> | BD-04 | Is the order number mandatory? | Three-valued waiver (DECISION 2) |
> | BD-05 | Redis queues or the PostgreSQL outbox? | Outbox |
> | BD-11 | An explicit "cannot submit" state? | An all-day absence opens the takeover |
> | BD-03, BD-08, BD-10 | Naming and visibility | Cosmetic |
>
> **3. EJE-supplied credentials and external dependencies** — code ready, live verification impossible without them
>
> | Needed | For | EJE's action |
> |---|---|---|
> | Microsoft 365 app registration (`EMAIL_GRAPH_TENANT_ID`, `_CLIENT_ID`, `_CLIENT_SECRET`, `EMAIL_SENDER`) with **Mail.Send** application permission and admin consent | MANDATE-3, EMAIL-2, DELIV-* | Create it in EJE's tenant; give the values to the operator for the server's environment file only (`docs/integrations.md`) |
> | Meta WhatsApp Business: permanent System User token, phone number id, templates `eje_job_assigned` and `eje_site_location` **approved** | NOTIF-1, WHATSAPP-1, WA-TRANSFER-1 | Submit and get the templates approved under EJE's WhatsApp Business account |
> | An off-site backup destination and its credentials | BACKUP-1 | Choose it (bucket or remote disk) and give the operator write-only credentials (`docs/vps-backups.md`) |
> | A holder for the backup key's escrow copy | BACKUP-2 | Name the person or safe; run `npm run backup:key-check` against them |
> | Permission to install OCR on the production server, with limits | LIB-5, BD-21 | Decide after the demonstration measurement (`docs/library-ocr.md` §5) |
> | GitHub access for this tooling (`gh auth login`) | PROC-6 issues | Allow the requirement issues to be filed from here, or file them by hand |
>
> **3a. Each external dependency in full** — *added 26 October 2026*. Nothing
> here may be faked, and no value below is ever written to the repository, a
> log, a report or an issue: they go in `/etc/eje/eje.env` on the server only.
>
> | Dependency | Configuration names | Who | Verify with | Evidence that closes it |
> |---|---|---|---|---|
> | Microsoft 365 email | `EMAIL_GRAPH_TENANT_ID`, `EMAIL_GRAPH_CLIENT_ID`, `EMAIL_GRAPH_CLIENT_SECRET`, `EMAIL_SENDER` (optional `EMAIL_REPLY_TO`) | EJE's Microsoft 365 administrator: an app registration with the **Mail.Send** application permission and **admin consent**; a real sender mailbox | `npm run integrations:check`, then `-- --probe` (token + mailbox, sends nothing); then one job card issued to an EJE-owned address | The probe output, and the test message received with its delivery recorded as `accepted` on the job — MANDATE-3 |
> | WhatsApp Business | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` (permanent System User token), and `WHATSAPP_BUSINESS_ACCOUNT_ID` so the probe can read the templates' approval | EJE with Meta: templates `eje_job_assigned` and `eje_site_location` submitted and **approved** | `npm run integrations:check -- --probe` (reports each template's status, sends nothing); then one assignment to an EJE technician's own number | Probe shows both templates APPROVED; the technician receives the message — NOTIF-1, WHATSAPP-1, WA-TRANSFER-1 |
> | Off-site backup | `EJE_BACKUP_OFFSITE_DIR` (a mounted volume) **or** `EJE_BACKUP_OFFSITE_RCLONE` (an rclone remote) | EJE chooses the destination; the operator configures write-only credentials | `npm run preflight` (*Off-site backup* OK); the backup unit's log shows the copy | A dated copy present at the destination, and a restore test run from it |
> | Backup key escrow | `EJE_BACKUP_KEY` on the server; a second copy held by a named person or safe | EJE names the holder | `npm run backup:key-check` against the escrowed copy (decrypts nothing) | The key-check output naming the matching fingerprint — BACKUP-2 |
> | Scheduled backups | `deploy/eje-backup.timer`, `deploy/eje-backup-restore-test.timer` | Operator | `systemctl list-timers 'eje-backup*'` | A night's backup and a Sunday restore test both passed — BACKUP-1 |
> | Production OCR | `EJE_OCR=local` plus the limits in `docs/library-ocr.md` §5 | EJE decides; operator installs `tesseract` and `pdftoppm` | `npm run preflight` (*Text recognition*) | **Stays off** until EJE approve it with limits — BD-21 |
> | Legacy multi-site customers | none — application data | The office, in the application | `npm run preflight` (*Customer sites*) | The count reads zero; then the one-site constraint can be added in a later release — SITE-1, SITE-2 |
> | GitHub issue tracking (PROC-6) | `gh auth login` in the environment that files them | Owner / whoever runs the tooling | `gh issue list --repo VOID-za/EJE-Managment` | The issues listed under *GitHub tracking* exist, titled with their IDs |

> **4. Physical acceptance — the rugged tablet** (code complete as far as automation can reach)
>
> MANDATE-2, PWA-8, OFF-13, UX-1, ACC-PWA-1…6, ACC-OFF-1…12: install from the
> launcher, the icon, a standalone launch, the real rear camera, gloved use in
> daylight, and a full job captured with the network off — on the Samsung Tab
> Active (or EJE's chosen device), against the deployed HTTPS origin, using
> `docs/tablet-installation.md`. MANDATE-1 also needs BD-23 before it can be met.
>
> **GitHub tracking (PROC-6), checked 26 October 2026.** 73 issues exist (#1–#73). The register's range IDs are tracked by umbrella issues: OFF-1…13 on #15 (MANDATE-1), PWA-1…8 on #16 (MANDATE-2), QA-4 and AUD-5 on #22 (ARCH-6). **Missing, and NOT created** because this environment has no GitHub authentication: OFFICE-1, OFFICE-2, PARTS-JC-1, WRITEUP-4, MEDIA-7, SITE-1, SITE-2, SITE-3, CONTACT-SITE-1, ATTEND-1, TIMESHEET-1, WA-TRANSFER-1, DEMO-TRUTH-1, OFF-QUEUE (1…10), CAP-REF (1…5), OFF-SEC-1, OFF-CHK-1, OFF-WRITEUP-1, OFF-MEDIA-1, OFF-DETAIL-1, MEDIA-6, TAB-UPLOAD-1, TAB-STATE-1, PARTS-PHOTO-1, and decisions BD-23…BD-30. **Stale labels** to correct by comment: #29 (AUD-3) and #30 (AUD-4) answered 21 Oct; #61–#63 (BD-19…21) answered 23 Oct; #72 (JOB-EDIT-1) built 25 Oct. A repeat-safe `gh` script that creates only what does not exist and comments on the stale ones, including #73, was prepared alongside this pass and is described in the final report; it is deliberately not committed (no tracker tooling in this repository — docs/project-tracking.md).

> **5. Deployment and operator work** (never done from this repository)
>
> | Task | Reference |
> |---|---|
> | Release with the pending migrations **verified at step 0**: four (`0030`…`0033`) if `4634d5d` is still live — the last recorded state — or two (`0032`, `0033`) if `e85f239` was released. *Corrected 26 October 2026; earlier reports said two.* | `docs/deploy-next-release.md`, *NEXT RELEASE* |
> | Declare `EJE_DEPLOYMENT`, pass preflight | `docs/demonstration-isolation.md` |
> | Configure email and WhatsApp, then `npm run integrations:check -- --probe` | `docs/integrations.md` |
> | Schedule the backup, copy it off site, run the restore test and the key check | `docs/vps-backups.md` |
> | Consolidate any legacy multi-site customers in production, then add the one-site constraint | SITE-1, SITE-2 |
> | Run the VPS smoke test after release; keep the rollback plan | `docs/vps-smoke-test.md` |
> | Owner approval of the TESTED rows, recorded on their issues | `docs/project-tracking.md` |

> **Updated later the same day** by the October implementation mandate. Two
> items moved off this list — demonstration labelling (§1) and customer
> attachments (§4) — and the library gained the five categories EJE asked for.
> See `docs/demonstration-data.md` for the classification record and the batch
> section in `docs/SCOPE.md` for the evidence. The two are tracked as
> [#58](https://github.com/VOID-za/EJE-Managment/issues/58) (DEMO-1) and
> [#59](https://github.com/VOID-za/EJE-Managment/issues/59) (CUST-DOC-1).
> Everything still listed below stands.

> **Updated again, 22 October 2026**, by the continuation mandate of that day.
> **Five more items moved off this list and NONE of them moved because a rule
> was supplied** — DRAFT-1 and CUST-CR's job half were answered from what the
> system already says, COST-5 and MACH-HIST were built to a recommended shape
> with the decision recorded instead of taken, and LIB-5's engine is finished
> and switched off. **What is left in "Not built" is now empty of features.**
> Five decisions remain, and two of them (BD-17, BD-18) are a one-line change
> once answered rather than work. See the tenth-batch section in
> `docs/SCOPE.md` for the evidence, and BD-19 to BD-21 there for the three
> questions this batch RAISED by building the features that needed them.

> **Updated again, 23 October 2026**, by the consolidated implementation
> mandate. **ALL FIVE OPEN DECISIONS WERE ANSWERED BY THE OWNER** — BD-17,
> BD-18, BD-19, BD-20 and BD-21 — and **two of them needed no code at all**,
> which is what building up to a decision rather than past it is for: BD-19
> chose the shape that had already shipped, and BD-17 was a capability added to
> two role lists. The owner's handwritten feedback on the Coordinator,
> Customers, Create New Job, Test & Repair, Parts and job-completion screens is
> implemented as CUST-NOTE-1, JOB-OPT-1, TR-1, JOB-ATT-1 and COLL-1. **So this
> document no longer has an "only EJE can answer" list with anything on it that
> blocks work** — see *Decisions only EJE can make* below, where every row is
> now struck through or cosmetic. What is left is in the two sections at the
> end: approval, and the things no repository can settle.

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
| **BD-02 implemented** — a Master corrects an issued job card by adding a correction with its own addendum; the original, its signature and its date are untouched; the customer's acknowledgement is recorded once | IMMUT-9 (#20), AUD-3 (#29) | TESTED — awaiting approval |
| **BD-06 implemented** — closing unsigned still sends nothing; a Master authorises an exceptional send with a reason, to the job's own contact, recorded against the exact document and retryable without re-authorising | DELIV-7 (#19), AUD-4 (#30) | TESTED — awaiting approval |
| **Provenance has a third value, `unknown`** — rows written before the column existed are no longer presented as proven genuine; the default changed from `genuine` to `unknown` so a forgotten field is a visible gap rather than a false claim | DEMO-1 (#58) | TESTED — awaiting approval |
| **A deployment declares itself** — `EJE_DEPLOYMENT=production` makes the demonstration switcher unreachable at runtime and the demo seed refuse outright, and a deployment pointed at a database that contradicts its declaration fails preflight | `docs/demonstration-isolation.md` | TESTED — awaiting approval |
| **`npm run backup:key-check`** — is the key you hold the key this backup needs? The escrow drill, provable without decrypting anything | BACKUP-2 (#23) | TESTED — awaiting approval |
| **Machine documents** — a machine carried photographs and nothing else; its commissioning report, compliance certificate and calibration results now have a home, with the office classifying each one `field` or `office_only` | MACH-DOC-1 (#60) | TESTED — awaiting approval |
| **Two counting defects found on the way** — the reconcile's table list was two tables stale, and a demonstration snapshot upgraded to v18 had no `customerDocuments` array to read | same | FIXED |
| **The OCR investigation** — the local option costed against the hosted one, with a recommendation to count before choosing | `0140034`, `docs/library-ocr.md` | INVESTIGATED, not implemented (#26) |

## Not built

> **Every row in this table is now struck through**, as of 22 October 2026. The
> table is kept rather than deleted because the third column is the record of
> what each item was waiting for — and in four of the six cases the answer
> turned out to be *nothing from EJE*, which is worth being able to read back.
> **"Not built" holds no feature today.** What is left is in *Decisions only
> EJE can make* below, and two of those are a one-line change once answered.

| ID | What | Why it is not merely "to do" |
|---|---|---|
| ~~**DRAFT-1** (#21)~~ | ~~Draft jobs, Master-only. Creation always produces `open`.~~ | **BUILT** on 22 October, `aaf5a33`. **Neither rule needed EJE after all, and that is worth saying plainly rather than quietly:** what a draft may leave blank is exactly what the TECHNICIAN supplies (the fault description and the machine) — everything else is what the office knows when the telephone call ends; and the rates question does not arise at all, because COST-8 freezes rates at SIGNATURE rather than at creation, so a draft carries none to go stale. Asking EJE to decide something the system had already decided would have been a stall, not diligence. Releasing re-runs the SAME validation function, so the check is deferred and never weakened. |
| ~~**COST-5** (#24)~~ | ~~Additional charges and discounts.~~ | **BUILT** on 22 October, `149bf7e`, **to a recommended shape, with the alternatives recorded as BD-19 rather than chosen.** A fixed amount off, before VAT, Master-authorised, reason required, capped at the gross subtotal; an additional charge is a description and an amount with no quantity, because a call-out levy is not measured in units. The discount prints as a NEGATIVE line, so the lines still total the subtotal. **What EJE may still want is a Coordinator ceiling** — an amount a Coordinator may authorise alone — which needs a figure and nothing else. |
| ~~**MEDIA-5** (#18)~~ | ~~Video capture. Type only; no capture path.~~ | **BUILT** on 21 October. A video is recorded or chosen, sniffed by container brand, stored, authorised and played back exactly as a photograph is, with its own 60 MB limit. **One sub-question remains open and is recorded rather than answered:** does a customer ever receive a video, and how, given that a job card is a PDF and cannot carry one? Until EJE answer, a video is filed for the office — enforced by the server, not merely left off a screen. Video capture is also online-only: the held-work queue is 40 MB for ALL of a technician's unsent captures and one clip could fill it, so it is refused with that reason rather than crowding out the photographs a job needs. |
| ~~**LIB-5** (#26)~~ | ~~Full-text PDF search / OCR in the library.~~ | **BUILT AND SWITCHED OFF** on 22 October, `2ba76e4` — two different statements. The local engine (`tesseract`, `pdftoppm`) is finished behind the existing port and **proved against a real scan**: installed in a DEVELOPMENT container, run over an image-only PDF that `pdftotext` finds nothing in, through the real queue and worker, ending in a full-text search that finds an alarm code only recognition could have produced. Every limit is explicit and configurable — a deadline, an input size, a page cap, a text budget, the language data — and a document that hits one is recorded as **searchable in part with the reason** rather than as indexed or failed. Missing language data is NAMED, because the remedy is one `apt-get` line nobody would guess from "no text found". **Nothing was installed on the production VPS and OCR was not enabled there**, as the mandate required. What is left is BD-21: whether it goes on, with which limits, and on which machine. *The earlier state, kept because it is what the architecture rests on:* Search over text-based PDFs works and is tested on real PostgreSQL. An upload with no text layer now queues the document on `library_ocr_queue`, and `npm run library:ocr` reads it afterwards — asynchronous because a 214-page manual is twenty minutes to an hour and cannot happen inside an upload. Recognised text is recorded as `source: 'ocr'` and labelled as recognised wherever it is shown, because a machine's reading of a wiring diagram is not the diagram. **No engine is installed:** `EJE_OCR` is unset everywhere, so every job settles as `unavailable` naming the two packages. Nothing is sent off the premises — the hosted option is deliberately NOT implemented. What remains EJE's: whether to install Tesseract on the VPS, or to authorise a hosted bulk pass, or to re-upload text-based copies instead. `docs/library-ocr.md` §3 costs all three and recommends counting the unsearchable documents first. |
| ~~**MACH-HIST** (#28)~~ | ~~Machine location history.~~ | **BUILT** on 22 October, `1299e4a`. Insert-only movements with the office’s own effective date, written only when the site or the customer actually changed, and `machineLocationAsAt` to answer *"where did it stand on that day"*. **It stops before the job screen on purpose:** showing a historical site on a finished job changes what that job appears to say about work already done, which is BD-20. The history starts EMPTY and that is deliberate — there is nothing to import, and a first movement invented from today’s register would be a statement nobody made. |
| ~~**IMMUT-9** (#20)~~ | ~~Addendum mechanism for post-signature corrections.~~ | **BUILT** on 21 October, now that BD-02 is answered. `job_corrections`, append-only with a write-once acknowledgement, its own addendum PDF, and the original untouched — proved by reading the original's bytes before and after in a browser. |

## Found on 23 October 2026, and recorded rather than guessed

> **BUILT on 25 October 2026, `0d9fa5f` — TESTED, awaiting approval.** The
> owner adopted the recommended default below on #72 (23 October), and it was
> built exactly to it: `jobs.editDetails` for Master and Coordinator, only
> while `assertEditable` allows, only the fields the job type carries, every
> change a from/to pair, and a stale edit refused. See the JOB-EDIT-1 row in
> `docs/SCOPE.md` for the evidence. The text below is kept because it is the
> reasoning the implementation had to respect.

**JOB-EDIT-1 — a job's recorded details cannot be changed after creation, by
anybody.** Not the order number, not the customer reference, not the fault
description, not the delivery note, and not the Test & Repair fields added as
TR-1. There is no operation, no command and no control: every one of these is
written by `createJob` and never again.

This surfaced while verifying TR-1's "persist through edits". **It is not a
defect I introduced and it is not specific to Test & Repair** — it has been true
of every job-detail field since the system was written, and the new fields
simply inherit it. It matters more for them than for the others, though, because
the owner asked that they be OPTIONAL: a unit is booked in at the counter while
somebody is still looking for the part number on the casting, and today that
blank can never be filled in. The nearest thing available is a technician's
change request (CUST-CR), which reports that a record is wrong and still ends
with the office unable to correct it.

**It is reported rather than built, for two reasons.** It is a feature nobody
asked for in any mandate, and it is not a small one: an edit path has to decide
what may change after the customer has signed (IMMUT-9's rules), what reaches
the audit trail as a change rather than an event, and whether a technician may
correct the fault description they wrote. Inventing those rules here would be
answering three business questions by implementation.

**Recommended default, if EJE want it:** the office (`jobs.editDetails`, a new
capability held by Master and Coordinator) may change the order number,
reference number, delivery note, quote number, fault description and the
Test & Repair received-item fields while the job is EDITABLE — that is, before
`assertEditable` stops applying at signature — with every change on the audit
trail as a `from`/`to` pair, exactly as a customer note edit already records.
After signature, nothing changes and the existing addendum mechanism is the
remedy. That is one operation, one command and one panel, and it invents no new
rule: it reuses the two that already govern this question.

## Decisions only EJE can make

> **As of 23 October 2026 NOTHING IN THIS SECTION BLOCKS WORK.** Every row is
> either struck through — answered by the owner and implemented — or marked
> cosmetic. The table is kept rather than deleted because the third column is
> the record of what each decision cost once answered, and in two cases the
> answer cost no code at all.

These block real work. Each one has an issue; none may be answered by
implementation.

**Two fewer than yesterday.** The owner answered BD-02 and BD-06 on 21 October
and both are now implemented, which also closes the two acceptance blockers
that hung off them — AUD-3 (a signed job card with a genuine error had no
remedy at any layer) and AUD-4 (closing without a signature sent the customer
nothing). They are struck through below rather than deleted, because the
reasoning that made them decisions is what the implementation had to respect.

| ID | Question | What it blocks |
|---|---|---|
| ~~**BD-02** (#34)~~ | ~~What is the post-signature correction/addendum mechanism?~~ | **ANSWERED by the owner on 21 October and IMPLEMENTED.** A signed job card stays immutable; a Master raises a correction with its own addendum, linked to the exact bytes of the original. IMMUT-9 and AUD-3 are answered by it, and both await the owner's approval — no issue is closed. **One sub-question remains open:** *when* is the customer's acknowledgement required? The Master states it per correction; nothing in the application decides it. |
| ~~**BD-06** (#33)~~ | ~~Does closing *Without Customer Signature* email the customer their copy, and under whose authority?~~ | **ANSWERED by the owner on 21 October and IMPLEMENTED.** No automatic delivery; a Master authorises an exceptional send with a reason, to the job's own contact, recorded against the exact document. DELIV-7 and AUD-4 are answered by it, and both await the owner's approval — no issue is closed. |
| ~~**BD-17** (#56)~~ | ~~May the issued prices be exported, and by whom?~~ | **ANSWERED 23 October: THE OFFICE — a Master AND a Coordinator**, implemented `0ad0500`. A technician may not, and the archive was already office-only. Asserted against the file bytes for the granted roles and the refused one. |
| ~~**BD-18** (#57)~~ | ~~Is a spreadsheet export recorded on the audit trail?~~ | **ANSWERED 23 October: ALL OF THEM, KEPT INDEFINITELY**, implemented `0ad0500`. The switch is GONE — there is no configuration that turns it off, proved by setting the old `EJE_EXPORT_AUDIT=off` and watching the event be written anyway. Exports have their own activity group; the record names the columns and never the rows; a refused export records nothing. Retention is indefinite by behaviour: no retention job, no sweeper, no TTL. |
| **BD-20 / MACH-HIST** (#28) | ~~Do EJE record a machine’s moves~~ — **they are recorded now** — and what should a job screen then show? | **Half answered by building it, 22 October.** The record exists and the function that reads it as at a date is tested; no job screen calls it, because that changes what a finished job card appears to say. **Recommended: both on a closed job** — the historical site as where the work happened, the current one labelled as the register today. Whether an approved change request may MOVE a machine by itself is still open. |
| ~~**CUST-CR** (#27)~~ | ~~Who raises a CUSTOMER’s change request to a JOB, what may it change, what does it do to a job in progress?~~ | **ANSWERED BY THE SYSTEM’S OWN FACTS and BUILT, 22 October** `6a8b7c8`. A customer has no account, no portal and no role here, so the request arrives by telephone and somebody at EJE writes down who made it; it changes nothing by itself, exactly as the register half does not; and because it carries no proposed value it cannot touch a job in progress or a signed one, so CR-01’s finality is untouched and the post-signature question stays BD-02’s. **Resolution authority follows the subject:** `jobs.viewAll` for a job, `customers.manage` for the register. |
| **BD-04** (#35) | Is the order number mandatory, or is the DECISION 2 waiver correct? | JOB-5. |
| **BD-05** (#36) | Accept the PostgreSQL outbox in place of v2.0's Redis queues? | ARCH-2. Nothing is waiting on it in practice. |
| **BD-11** (#37) | An explicit "cannot submit" state for an unreachable technician? | TAKEOVER-1's condition. |
| ~~**BD-19** (#61)~~ | ~~What shape is a discount?~~ | **ANSWERED 23 October: THE RECOMMENDED SHAPE STANDS** — fixed amount, before VAT, Master only — **and the Coordinator ceiling was DECLINED.** No code changed; `7203721` adds the assertion that a Coordinator does NOT hold `jobs.applyDiscount`, so granting it later is a deliberate act. |
| ~~**BD-20** (#62)~~ | ~~Does a job screen show where the machine stood AT THE TIME of the work?~~ | **ANSWERED 23 October: yes on a CLOSED job, the register on one in progress**, implemented `7203721` as at the day the work was COMPLETED. **Where the history cannot answer it says UNKNOWN** rather than presenting today's register as historical fact — the common case today, and the part the owner was explicit about. |
| ~~**BD-21** (#63)~~ | ~~Is local text recognition switched on, with which limits, and on which machine?~~ | **ANSWERED 23 October: THE DEMONSTRATION FIRST, MEASURED**, implemented `fe3dd1e`. **23–25 seconds per A4 page at 300 dpi**, two samples, byte-identical text — so **a 214-page manual is ~83–89 minutes and cannot be read under the shipped defaults**, and is partially indexed. Raising a limit is a decision about how much of the VPS one document may occupy, and is REPORTED in `docs/library-ocr.md` §5 rather than taken. Nothing was installed on the production VPS. |
| **BD-03** (#38), **BD-08** (#39), **BD-10** (#40) | Naming and visibility questions. | Cosmetic. |

## By the areas asked about

**Customer and machine administration** — built and tested. The register is
internally consistent (a machine cannot stand at another customer's site),
concurrent amendments cannot overwrite each other on PostgreSQL, and archiving
is a withdrawal rather than a delete. Both now carry **files**: a customer’s
paperwork is office-only, and a machine’s is classified per document so a
technician reads the manual and not the invoice. **A machine’s MOVES are now
recorded too** (MACH-HIST, 22 October), insert-only and with the office’s own
effective date. Outstanding: whether a job screen shows the historical site (BD-20)
and whether `field` should be the default audience — both decisions, neither work.

**User administration** — built and tested, including who may create whom (a
Coordinator may add a Technician and nothing else; only a Master may add a
Master). Exercised again on PostgreSQL in this pass.

**Customer notes and documents** — **BUILT** on 23 October. The tab named
"Notes & Documents" held neither: account notes could not be written by anybody
(no operation, no route, no control — since the register was built), and the
Documents card beside them was hard-coded to say storage was simulated while
the real panel sat on the Overview tab. Both real panels are now on that tab,
and an edit to a note says it is an edit while keeping the original author and
date. A Coordinator could always create and edit customers; the refusal message
said otherwise and was wrong.

**Create New Job** — **BUILT** on 23 October. Machine and priority are optional
on a breakdown and a test-and-repair job, and NULL rather than defaulted — a
breakdown used to carry "Urgent" that nobody chose. The attachment control takes
photographs and videos only, enforced on the bytes. Test & Repair carries the
unit booked in (part number, description, quantity) and the customer's quote
number, with the fault description optional there. The Counter Collection tick
box is gone: who is collecting is recorded at the collection, and the server
refuses it before the job is finished.

**Draft-job release** — **BUILT** on 22 October and invisible to everybody but a
Master, including a Coordinator who may otherwise read every job and a technician
named on one. A hidden draft answers 404, never 403, because a 403 confirms it
exists. Two real authorisation holes were found by its own route test, both from
short-circuiting on `jobs.viewAll` before asking about drafts.

**Customer change requests and post-signature corrections** — **both halves of
CUST-CR are now built** (22 October): a technician reports a wrong register record,
and somebody at EJE writes down a customer’s request about a job. Neither
applies itself, which is the whole design — the office makes any change on the
screen that already authorises it. Post-signature correction was built on 21
October under BD-02 and is untouched by this: a customer’s request carries no
proposed value, so it cannot reach a signed job card.

**Document library search and file handling** — file handling is built: stored
files open, a pending revision cannot be fetched by a technician, a scanned
document says it is not searchable. **OCR IS NOW BUILT AND SWITCHED OFF** — the
local engine is finished and proved against a real scan, every limit is explicit,
and no code exists to send a document to an external provider. Whether it goes on
is BD-21.

**Machine photographs and checklist evidence** — built, stored, served back and
proved byte-for-byte in a browser (#46, #45, #53). Awaiting approval.

**CSV/Excel exports and audit requirements** — the export is built (#25); whether
it may carry prices and whether it is audited are still decisions (#56, #57), but
both are now **one line** rather than work: the price columns exist behind a
capability no role holds, and the audit write exists behind an environment variable
nothing sets. **And the export honours draft visibility**, which is asserted rather
than read off the code, because a spreadsheet is the one place a job’s details
leave in bulk.

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
