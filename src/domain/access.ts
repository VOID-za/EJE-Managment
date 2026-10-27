import type { UserRole } from './types/user';

/**
 * Capability-based access rules.
 *
 * Components and operations ask `can(role, 'jobs.create')` rather than testing
 * `role === 'master'`, so adding a role is a change here and nowhere else.
 *
 * There are three roles, and the distinction that matters is not seniority but
 * WHERE the person works:
 *
 * - `master`     — full administration, including the commercial settings and
 *                  other Masters.
 * - `coordinator`— the office administrator. Runs customers, machines, jobs,
 *                  scheduling and technicians day to day, and prepares the
 *                  paperwork the business invoices from. Not a field worker.
 * - `technician` — does the work on site.
 *
 * The Coordinator is deliberately NOT "a technician with more buttons". She
 * cannot accept or execute a field job, because the person who attended the
 * machine has to be the person recorded as having attended it. She can do
 * everything around that.
 *
 * AND THE MASTER IS NOT A SUPERSET OF EVERYONE. `jobs.issueFinal` is the
 * technician's and no one else's on field work — see CR-07. Seniority is not
 * the axis this table turns on; WHERE THE PERSON WORKS is.
 */
export type Capability =
  // Jobs
  | 'jobs.viewAll'
  | 'jobs.create'
  | 'jobs.assign'
  /** Accept and execute a field job: the person who goes to the machine. */
  | 'jobs.acceptField'
  /** Capture work on a job — hours, travel, parts, the write-up. */
  | 'jobs.captureWork'
  /**
   * THE FINAL SUBMISSION OF A SIGNED JOB CARD. THE TECHNICIAN'S. CR-07.
   *
   * One call that freezes the price, renders and stores the customer's copy,
   * emails it and moves the job into the delivery handshake. It is the last
   * act of the job, and it belongs to the person who did the work.
   *
   * THIS USED TO BE THE MASTER'S, and the change is a business decision, not a
   * refactor. The normal signed journey ran
   * `technician signs → office review → Master submits`, which made the office
   * a mandatory participant in every completed job it had not attended and
   * left a signed job card sitting in someone else's queue. EJE confirmed on
   * 25 September 2026 that there is no office step in the normal journey:
   * the technician signs, checks the signed document and submits it.
   *
   * WHAT DID NOT MOVE WITH IT: the OFFICE review of a job the customer
   * REFUSED to sign. That is a genuine exception the office owns, and it is
   * `jobs.resolveSignatureRefusal`, which is a different capability held by
   * different people for a different reason.
   *
   * A PARTS COLLECTION IS NOT FIELD WORK and does not go through this: it is
   * handed over at the EJE counter by the office, so `issueJobCard` gates a
   * collection on `jobs.processParts` instead. Nor does it go through
   * `acceptJobRefusal`, which once carried the same exception and now refuses
   * a collection outright — CR-12 removed the acceptance step from the
   * collection workflow entirely.
   */
  | 'jobs.issueFinal'
  /**
   * SUBMIT A SIGNED JOB CARD ON BEHALF OF A TECHNICIAN WHO CANNOT. CR-08.
   *
   * The exception to CR-07, and deliberately a capability of its own rather
   * than a loosening of `jobs.issueFinal`. The office does not submit signed
   * job cards; it rescues one that would otherwise be stuck, and only when the
   * people who could submit it are provably unavailable — see
   * `submissionCover`, which decides that from the availability register and
   * the user record, not from anybody's opinion.
   *
   * It is NOT `jobs.resolveSignatureRefusal`. A refusal is a different
   * workflow with a different question in front of it, and merging the two
   * would put the refusal review back into the signed journey by the back
   * door. A takeover submits the document that already exists and changes
   * nothing else: the job is signed, so it is final, and there is nothing on
   * it a takeover could edit even if it wanted to.
   */
  | 'jobs.takeOverSubmission'
  /**
   * Resolve a customer's refusal to sign, so the job card can move on.
   *
   * The office — Masters and Coordinators. A refusal is an exception the office
   * owns: the technician who was turned away is not the person to decide what
   * EJE does about it.
   */
  | 'jobs.resolveSignatureRefusal'
  /**
   * See any job's signature refusal, not only one's own.
   *
   * The office again. A technician sees refusals recorded against work they
   * were sent to and nothing else; see `canSeeSignatureRefusal`.
   */
  | 'jobs.viewAnySignatureRefusal'
  /**
   * Correct a job card the technician has already submitted.
   *
   * Administrative, and distinct from `jobs.captureWork`: this is the office
   * putting right what the customer objected to, on a job that has left the
   * technician's hands. Every such edit is audited against the person who made
   * it, so the technician's original submission stays legible underneath.
   */
  | 'jobs.editSubmittedJob'
  /**
   * Send a corrected job card back to the customer for signature.
   *
   * The action that closes the correction loop. Office only — a technician
   * cannot put their own refused job back in front of the customer.
   */
  | 'jobs.resubmitForSignature'
  /**
   * Process a Parts collection end to end.
   *
   * Separate from `jobs.acceptField` because a parts collection happens at the
   * counter, not on a customer's site: the office hands over the goods and takes
   * the collector's signature itself.
   *
   * **THE OFFICE'S ALONE, from 25 September 2026 (CR-12).** It was also the
   * technician's, which made a collection something either the counter or the
   * field could pick up — and left the question of who really owns one open
   * (BD-12). EJE answered it: a parts job is raised and processed by a Master
   * or a Coordinator, start to finish, and a technician is not part of the
   * collection workflow at any point.
   */
  | 'jobs.processParts'
  /**
   * CANCEL OR DELETE A JOB THAT HAS NOT STARTED. CR-11.
   *
   * The office's, both of them — a Master and a Coordinator raise jobs, so
   * they are the people who undo one raised in error or one the customer has
   * called off. It is deliberately NOT the technician's: a job they may be
   * assigned is not theirs to remove.
   *
   * IT IS NOT ON ITS OWN A RIGHT TO CANCEL ANYTHING. `canCancelJob` and
   * `canDeleteJob` pair it with the state of the job, which is the other half
   * of the rule: OPEN, and with nobody's name on it. A job already given to a
   * technician is transferred, not deleted behind their back.
   *
   * This replaces `role === 'master'` written inline in both predicates —
   * which was the reason a Coordinator was never offered either action.
   */
  | 'jobs.endUnstartedJob'
  /**
   * Capture completion information on someone else's job, for administration.
   *
   * Recorded as an administrative capture, never as field execution: the
   * technician who did the work stays the technician on the job.
   */
  | 'jobs.captureAdministratively'
  // Records
  /**
   * Read the customer register: the company, its sites, its contacts and its
   * machines. Held by every role, technicians included.
   *
   * THE WHOLE RECORD, COMMERCIAL FIELDS INCLUDED. Payment terms, the VAT
   * number and the registration number are readable by a technician — EJE
   * confirmed this as a business rule, so it is not an open question to be
   * rediscovered and quietly "tightened" later. Do not suppress them.
   *
   * Note what this does NOT reach around: DECISION 5 still governs the JOBS
   * hanging off a customer. Reading who the customer is and reading what EJE
   * charged on another technician's job are different things, and the second
   * is decided by `jobVisibilityFor`, not by this.
   */
  | 'customers.view'
  /** Create or change the official customer record. The office only. */
  | 'customers.manage'
  | 'machines.manage'
  | 'library.view'
  | 'library.manage'
  // Scheduling
  /**
   * READ the calendar: scheduled work and who is unavailable. MASTER SCOPE
   * §3.3 and §16 — "Technicians MUST be able to view the Calendar."
   *
   * Deliberately separate from `availability.manage`. Reading the schedule and
   * deciding who is on leave are different acts, and conflating them is what
   * made the calendar an office-only screen: the technician who needs to know
   * when they are booked was refused because they may not book anybody else.
   */
  | 'calendar.view'
  /** WRITE the calendar: record, change or cancel an absence. The office. */
  | 'availability.manage'
  /**
   * RECORD AND CORRECT THE ATTENDANCE REGISTER. ATTEND-1. The office — Master
   * and Coordinator. A technician does not mark themselves present: the
   * register is the office's record of who was at work, not a self-report.
   */
  | 'attendance.manage'
  /**
   * READ EVERY TECHNICIAN'S TIMESHEET, export it, and write its daily
   * comments. TIMESHEET-1. The office. A technician reads — and comments on —
   * their OWN timesheet, which needs no capability because it is their own.
   */
  | 'timesheets.viewAll'
  // Administration
  | 'admin.access'
  | 'users.manageTechnicians'
  /** Create, edit, disable or promote a Master. Masters only, always. */
  | 'users.manageMasters'
  /**
   * System settings that are not rates or checklists — the demonstration
   * reset among them. A Master's alone.
   */
  /**
   * THE OFFICE LIFECYCLE AFTER SUBMISSION. Issue #73, Batch 1.
   *
   * Mark a submitted job card handled (Office Handling -> Awaiting PO) and
   * record the invoice number that finishes it (Awaiting PO -> Invoiced). The
   * office's — Master and Coordinator — and never a technician's: the
   * technician's part ends at submission.
   */
  | 'jobs.officeHandling'
  | 'settings.manage'
  /**
   * Charge-out rates, travel, call-out and VAT. The Master AND the Coordinator.
   *
   * Split out of `settings.manage` because the owner asked for the office to
   * maintain the rates and the checklists, and for nothing else of the system
   * settings to move with them. Changing a rate still never re-prices a job
   * the customer has signed: the pricing snapshot is frozen at signature.
   */
  | 'settings.rates'
  /**
   * Checklist templates: draft, publish, retire. The Master AND the Coordinator.
   *
   * The immutability of a version a job has completed against is unchanged —
   * it is enforced in `checklist-admin.ts` for every role, so the office
   * publishes a new version exactly as a Master does and cannot rewrite one a
   * customer has seen.
   */
  | 'settings.checklists'
  | 'activity.viewAll'
  /**
   * Resolve a capture a tablet held that the server refused. BD-15.
   *
   * THE NARROWEST PERMISSION THAT DOES THE JOB, deliberately. It is not
   * `admin.access` (which also opens the system screens), not
   * `jobs.captureAdministratively` (which is about capturing on a job directly)
   * and not a new ROLE. It answers exactly one question: may this person look
   * at work a technician could not get onto a job, and decide what happens to
   * it? The office — Master and Coordinator — may. A technician may see their
   * OWN referrals, which needs no capability because it is their own work.
   */
  | 'captures.resolveReferral'

  /**
   * RAISE A CORRECTION TO AN ISSUED JOB CARD. BD-02, IMMUT-9, AUD-3.
   *
   * MASTER ONLY, and that is the owner's rule rather than a choice made here:
   * "A Master can initiate a correction/addendum linked to the original job
   * card." It is the narrowest permission that does the job — not
   * `jobs.editSubmittedJob`, which is about a job card that has not been
   * issued, and emphatically not a way to edit an issued one, which nothing
   * has.
   *
   * A Coordinator may READ a correction and may RECORD the customer's
   * acknowledgement of one (see below). What she may not do is decide that a
   * document EJE have issued says the wrong thing.
   */
  | 'jobs.raiseCorrection'

  /**
   * Record that the customer has acknowledged a correction.
   *
   * THE OFFICE, both of them, because this is clerical: somebody telephoned
   * the customer, the customer said they had seen it, and that fact is written
   * down. Deciding a correction is needed is a Master's; writing down what the
   * customer said is the office's.
   */
  | 'jobs.recordCorrectionAcknowledgement'

  /**
   * AUTHORISE SENDING A JOB CARD THE CUSTOMER DID NOT SIGN. BD-06.
   *
   * MASTER ONLY, and the owner's rule again: "A Master must explicitly
   * authorise any exceptional delivery." Closing a job without a signature is
   * the Coordinator's (`jobs.resolveSignatureRefusal`); deciding that the
   * customer should nevertheless be sent the unsigned document is not.
   */
  | 'jobs.authoriseUnsignedDelivery'
  /**
   * TAKING MONEY OFF A JOB. COST-5.
   *
   * A Master's alone, and the reasoning is EJE's own: `settings.manage` is
   * Master-only precisely so that "the charge-out rates stay with a Master",
   * and a discount is the same decision made for one customer instead of all of
   * them. A Coordinator captures the work and prices the parts; what the
   * customer is let off is not clerical.
   *
   * **This is the shipped recommendation, not a settled EJE rule.** Issue #24
   * carries the question: may a Coordinator discount, and up to what figure? If
   * the answer is "up to R500 without asking", this capability gains a limit
   * and the Coordinator gains the capability — one list and one check.
   *
   * ADDING a charge deliberately needs no new capability: it rides on
   * `jobs.captureWork`, like a part, because a technician already enters part
   * prices and a consumable is the same act.
   */
  /**
   * RAISING, READING AND RELEASING A DRAFT JOB. DRAFT-1.
   *
   * A Master's alone, which is what the requirement says: "Draft jobs,
   * Master-only". It is three rights in one deliberately — a draft a
   * Coordinator could READ but not release would put half-finished job cards
   * on the office's screen with nothing anybody could do about them, and the
   * point of a draft is that it is not yet a job the business is working on.
   *
   * It governs VISIBILITY and not merely the buttons: `jobVisibilityFor`
   * returns nothing at all for a draft to anybody without this, so a draft is
   * absent from every list, every tally and every read — including a
   * technician who happens to be named on one.
   */
  | 'jobs.manageDrafts'
  /**
   * CORRECTING A JOB'S RECORDED DETAILS. JOB-EDIT-1 (#72).
   *
   * THE OFFICE: A MASTER AND A COORDINATOR — the owner's mandate on #72,
   * 23 October 2026, adopting the documented default. The order number, the
   * reference number, the delivery note, the quote number, the fault
   * description and the Test & Repair unit booked in were written once by
   * `createJob` and never again, by anybody.
   *
   * WHAT IT DOES NOT LOOSEN: the edit runs through `assertEditable`, so it
   * stops exactly where every other change stops — at the customer's
   * signature, and wherever `canEditJob` already closes the job to this role.
   * After signature the remedy is a correction with its own addendum (IMMUT-9),
   * never an edit.
   *
   * A TECHNICIAN DOES NOT HOLD IT. One who finds a detail wrong raises a change
   * request, exactly as they do for a serial number on the register.
   */
  | 'jobs.editDetails'
  /**
   * EXPORTING WHAT EVERY CLOSED JOB WAS CHARGED AT. BD-17, ANSWERED.
   *
   * **THE OFFICE: A MASTER AND A COORDINATOR.** The owner answered BD-17 (#56)
   * on 23 October 2026 — the issued prices may be exported, by both office
   * roles. A TECHNICIAN IS NOT ONE OF THEM, and that is the part worth stating
   * rather than leaving to the lists below: the closed-job archive is already
   * office-only (`loadClosedJobs` refuses a role without `jobs.viewAll` before
   * it reads a row), and this narrows the money further still.
   *
   * WHAT THE COLUMNS CARRY: the subtotal excluding VAT, the VAT, the total
   * including VAT, and the date the figures were frozen — read from the
   * write-once pricing snapshot, never recomputed, because a Master may amend
   * a job after the customer signed and before it is issued, and recomputing
   * would report what the job says TODAY rather than what the customer SIGNED
   * FOR. A job with no snapshot exports an empty cell, not "0.00".
   *
   * `export-prices-and-audit.test.ts` asserts the granted roles against the
   * FILE BYTES and the refused ones against the bytes too — a column list that
   * drifted from the writer would pass a cheaper assertion and leak the money.
   */
  | 'jobs.exportPrices';

const MASTER_CAPABILITIES: readonly Capability[] = [
  'jobs.viewAll',
  // BD-17, answered by the owner on 23 October 2026: the office may export
  // what each closed job was charged at. A technician may not.
  'jobs.exportPrices',
  'jobs.create',
  'jobs.assign',
  'jobs.acceptField',
  'jobs.captureWork',
  // `jobs.issueFinal` IS DELIBERATELY ABSENT — see CR-07 and the capability's
  // own note. The Master no longer submits a signed job card somebody else
  // completed; the technician who did the work does. What the Master keeps is
  // the REFUSAL, below, which is the one case where the office is needed.
  'jobs.resolveSignatureRefusal',
  'jobs.takeOverSubmission',
  'jobs.viewAnySignatureRefusal',
  'jobs.editSubmittedJob',
  'jobs.resubmitForSignature',
  'jobs.processParts',
  'jobs.captureAdministratively',
  'jobs.endUnstartedJob',
  'customers.view',
  'customers.manage',
  'machines.manage',
  'library.view',
  'library.manage',
  'calendar.view',
  'availability.manage',
  // The attendance register and every technician's timesheet. ATTEND-1, TIMESHEET-1.
  'attendance.manage',
  'timesheets.viewAll',
  'admin.access',
  'users.manageTechnicians',
  'users.manageMasters',
  'jobs.officeHandling',
  'settings.manage',
  'settings.rates',
  'settings.checklists',
  'activity.viewAll',
  'captures.resolveReferral',
  // A document EJE have issued says the wrong thing: BD-02. Master's alone.
  'jobs.raiseCorrection',
  'jobs.recordCorrectionAcknowledgement',
  // Sending a job card the customer did not sign: BD-06. Master's alone.
  'jobs.authoriseUnsignedDelivery',
  // Money off a job: COST-5. Master's alone, for the same reason the rates are.
  // Draft job cards: DRAFT-1. "Master-only" is the requirement's own wording.
  'jobs.manageDrafts',
  // Correcting a job's recorded details before signature: JOB-EDIT-1 (#72).
  'jobs.editDetails',
];

/**
 * The office administrator.
 *
 * Everything an office runs on, and nothing that belongs on a customer's site.
 * Note what is absent: `jobs.acceptField`, so she cannot take a breakdown as
 * though she attended it; `users.manageMasters`, so she cannot make herself
 * one; and `settings.manage`, the system settings that are not rates or
 * checklists. The rates and the checklists ARE hers (`settings.rates`,
 * `settings.checklists`): the owner asked for the office to maintain both.
 *
 * `jobs.issueFinal` IS ALSO ABSENT, and it is now absent from the MASTER too.
 * She is the office: she reviews, she edits, she resolves a customer's refusal
 * either way — Customer Signature or Without Customer Signature — and she is
 * notified of it. What she does not do is submit an ordinary signed job card,
 * because under CR-07 nobody in the office does: that is the technician's.
 */
const COORDINATOR_CAPABILITIES: readonly Capability[] = [
  'jobs.viewAll',
  // BD-17, answered: the Coordinator is the office too, and the owner named
  // both roles.
  'jobs.exportPrices',
  'jobs.create',
  'jobs.assign',
  'jobs.captureWork',
  // Handling a customer who would not sign is office work, and the Coordinator
  // IS the office. Note what this still does not include: `jobs.acceptField`.
  // Correcting a job card is administration; attending the machine is not.
  'jobs.resolveSignatureRefusal',
  // The CR-08 rescue, not a submission right: it unlocks only when the people
  // who could submit the job are provably unavailable.
  'jobs.takeOverSubmission',
  'jobs.viewAnySignatureRefusal',
  'jobs.editSubmittedJob',
  'jobs.resubmitForSignature',
  'jobs.processParts',
  'jobs.captureAdministratively',
  'jobs.endUnstartedJob',
  'customers.view',
  'customers.manage',
  'machines.manage',
  'library.view',
  'library.manage',
  'calendar.view',
  'availability.manage',
  // The attendance register and every technician's timesheet. ATTEND-1, TIMESHEET-1.
  'attendance.manage',
  'timesheets.viewAll',
  'admin.access',
  'users.manageTechnicians',
  /*
   * RATES AND CHECKLISTS, and no other system setting. The owner asked for the
   * Coordinator to maintain both from Administration. What does NOT come with
   * them: `settings.manage` (everything else). (Discounts were withdrawn on 27
   * October 2026 — DISCOUNT-OFF-1 — so there is no discount capability at all.)
   */
  'settings.rates',
  'settings.checklists',
  // Handling submitted job cards and recording invoice numbers. Issue #73.
  'jobs.officeHandling',
  'activity.viewAll',
  // The office deals with work a tablet could not get onto a job. BD-15.
  'captures.resolveReferral',
  /*
   * SHE RECORDS THE CUSTOMER'S ACKNOWLEDGEMENT, AND DOES NOT RAISE THE
   * CORRECTION. BD-02. Deciding that an issued document is wrong is a
   * Master's; writing down that the customer has seen the correction is
   * clerical work the office does, and making her fetch a Master for it would
   * mean the acknowledgement simply does not get recorded.
   */
  'jobs.recordCorrectionAcknowledgement',
  /*
   * JOB-EDIT-1 (#72). The office corrects a job's recorded details — the owner
   * named both office roles. A Coordinator is the person at the counter when a
   * unit is booked in without its part number, so she is the one who fills it
   * in once somebody finds it.
   */
  'jobs.editDetails',
];

/**
 * The field.
 *
 * `jobs.issueFinal` IS HERE, and this is the whole of CR-07: the technician
 * who accepted the job, did the work and took the customer's signature is the
 * person who submits it. No office step, no queue, no hand-over.
 *
 * `calendar.view` without `availability.manage` is §3.3's "Technicians MUST be
 * able to view the Calendar" without also handing them the leave register:
 * they read the schedule, they do not write it.
 */
const TECHNICIAN_CAPABILITIES: readonly Capability[] = [
  'jobs.acceptField',
  'jobs.captureWork',
  'jobs.issueFinal',
  // `jobs.processParts` IS DELIBERATELY ABSENT — CR-12, answering BD-12. A
  // parts collection is counter work the office does; a technician neither
  // accepts one, processes one nor issues its collection note.
  'customers.view',
  'library.view',
  'calendar.view',
];

const BY_ROLE: Record<UserRole, readonly Capability[]> = {
  master: MASTER_CAPABILITIES,
  coordinator: COORDINATOR_CAPABILITIES,
  technician: TECHNICIAN_CAPABILITIES,
};

/**
 * What this role may do.
 *
 * Falls back to nothing for a role the table does not know. A persisted user
 * record with an unrecognised role is corrupt, and the safe reading of corrupt
 * authorisation data is that it grants nothing.
 */
export const capabilitiesFor = (role: UserRole): readonly Capability[] =>
  BY_ROLE[role] ?? NO_CAPABILITIES;

const NO_CAPABILITIES: readonly Capability[] = [];

export const can = (role: UserRole, capability: Capability): boolean =>
  capabilitiesFor(role).includes(capability);
