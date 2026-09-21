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
  /** Hand a completed job card over / issue it. */
  | 'jobs.submit'
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
  'availability.manage',
  'admin.access',
  'users.manageTechnicians',
  'activity.viewAll',
];

const TECHNICIAN_CAPABILITIES: readonly Capability[] = [
  'jobs.acceptField',
  'jobs.captureWork',
  'jobs.submit',
  'jobs.processParts',
  'customers.view',
  'library.view',
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
