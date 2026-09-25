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
   * handed over at the EJE counter by whoever is there, so `issueJobCard`
   * gates a collection on `jobs.processParts` instead. Same exception, same
   * shape, as `acceptJobRefusal`.
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
  // Administration
  | 'admin.access'
  | 'users.manageTechnicians'
  /** Create, edit, disable or promote a Master. Masters only, always. */
  | 'users.manageMasters'
  /** Charge-out rates, VAT, checklist templates, system settings. */
  | 'settings.manage'
  | 'activity.viewAll';

const MASTER_CAPABILITIES: readonly Capability[] = [
  'jobs.viewAll',
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
  'admin.access',
  'users.manageTechnicians',
  'users.manageMasters',
  'settings.manage',
  'activity.viewAll',
];

/**
 * The office administrator.
 *
 * Everything an office runs on, and nothing that belongs on a customer's site.
 * Note what is absent: `jobs.acceptField`, so she cannot take a breakdown as
 * though she attended it; `users.manageMasters`, so she cannot make herself
 * one; and `settings.manage`, so the charge-out rates stay with a Master.
 *
 * `jobs.issueFinal` IS ALSO ABSENT, and it is now absent from the MASTER too.
 * She is the office: she reviews, she edits, she resolves a customer's refusal
 * either way — Customer Signature or Without Customer Signature — and she is
 * notified of it. What she does not do is submit an ordinary signed job card,
 * because under CR-07 nobody in the office does: that is the technician's.
 */
const COORDINATOR_CAPABILITIES: readonly Capability[] = [
  'jobs.viewAll',
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
  'admin.access',
  'users.manageTechnicians',
  'activity.viewAll',
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
  'jobs.processParts',
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
