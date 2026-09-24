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
   * Hand a completed job card to the OFFICE for review. MASTER SCOPE §7.
   *
   * This is what a technician does at the end of a job, and it is where their
   * authority over it ends. It does not generate the final document, does not
   * email the customer and does not close anything — §7: "Technician submission
   * means Submit for Master Review; it does not email the customer or finalise
   * closure."
   */
  | 'jobs.submit'
  /**
   * THE FINAL OFFICIAL SUBMISSION. MASTER ONLY, and the reason this capability
   * exists separately at all.
   *
   * §3.1 gives the Master "final authority over official job submission/closure
   * and customer delivery"; §7 says the final Master submission "locks the job,
   * creates/stores final PDF, queues customer email and closes it"; §15 says
   * only that submission emails the customer. One capability held by one role
   * is how those three sentences are enforced in one place.
   *
   * It was `jobs.submit` — which technicians hold — so a technician could issue
   * the final job card and email the customer with no office involvement at
   * all. The audit against `95e9848` proved it: a technician calling
   * `POST /api/jobs/:id/issue` was refused only by the job's STATUS, never by
   * permission. Splitting the capability is the fix; nothing else in the issue
   * path changed.
   */
  | 'jobs.issueFinal'
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
  'jobs.submit',
  'jobs.issueFinal',
  'jobs.resolveSignatureRefusal',
  'jobs.viewAnySignatureRefusal',
  'jobs.editSubmittedJob',
  'jobs.resubmitForSignature',
  'jobs.processParts',
  'jobs.captureAdministratively',
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
 * `jobs.issueFinal` IS ALSO ABSENT, and that is the boundary the confirmed
 * refusal decision draws. She is the office: she reviews, she edits, she
 * resolves a customer's refusal either way — Customer Signature or Without
 * Customer Signature — and she is notified of it. What she does not do is the
 * final official submission, because §3.1 keeps "final authority over official
 * job submission/closure and customer delivery" with the Master, and the
 * decision restates it: "MASTER retains final authority… COORDINATOR must NOT
 * gain Master-only powers accidentally."
 */
const COORDINATOR_CAPABILITIES: readonly Capability[] = [
  'jobs.viewAll',
  'jobs.create',
  'jobs.assign',
  'jobs.captureWork',
  'jobs.submit',
  // Handling a customer who would not sign is office work, and the Coordinator
  // IS the office. Note what this still does not include: `jobs.acceptField`.
  // Correcting a job card is administration; attending the machine is not.
  'jobs.resolveSignatureRefusal',
  'jobs.viewAnySignatureRefusal',
  'jobs.editSubmittedJob',
  'jobs.resubmitForSignature',
  'jobs.processParts',
  'jobs.captureAdministratively',
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
 * `jobs.submit` here means SUBMIT FOR OFFICE REVIEW and nothing more — see the
 * capability's own note. `calendar.view` without `availability.manage` is
 * §3.3's "Technicians MUST be able to view the Calendar" without also handing
 * them the leave register: they read the schedule, they do not write it.
 */
const TECHNICIAN_CAPABILITIES: readonly Capability[] = [
  'jobs.acceptField',
  'jobs.captureWork',
  'jobs.submit',
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
