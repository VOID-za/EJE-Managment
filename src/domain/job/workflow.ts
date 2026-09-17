import type { Job, JobStatus } from '../types/job';
import type { UserRole } from '../types/user';
import { getJobTypeDefinition } from './job-types';

/**
 * The job workflow state machine.
 *
 * This module is the single source of truth for which transitions are legal and
 * why a transition is blocked. The UI asks it questions; it never re-implements
 * the rules. That is what makes the demo safe to grow into the production
 * system: the same machine will sit behind the REST API.
 */

export const JOB_STATUS_ORDER: readonly JobStatus[] = [
  'draft',
  'open',
  'in_progress',
  'awaiting_spares',
  'completion',
  'customer_signature',
  'review',
  'submitted',
  'closed',
];

/** Statuses shown as the linear progress rail on the job card. */
export const JOB_PROGRESS_STAGES: readonly JobStatus[] = [
  'open',
  'in_progress',
  'completion',
  'customer_signature',
  'review',
  'submitted',
  'closed',
];

const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  draft: ['open'],
  open: ['in_progress'],
  // Awaiting spares may be entered and left any number of times.
  in_progress: ['awaiting_spares', 'completion'],
  awaiting_spares: ['in_progress'],
  completion: ['customer_signature', 'in_progress', 'awaiting_spares'],
  customer_signature: ['review', 'completion'],
  review: ['submitted', 'completion'],
  submitted: ['closed'],
  closed: [],
};

export const jobStatusLabel = (status: JobStatus): string => {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'open':
      return 'Open';
    case 'in_progress':
      return 'In Progress';
    case 'awaiting_spares':
      return 'Awaiting Spares';
    case 'completion':
      return 'Completion';
    case 'customer_signature':
      return 'Customer Signature';
    case 'review':
      return 'Review';
    case 'submitted':
      // Submitted BY THE TECHNICIAN, and now waiting on a Master. The customer
      // has not been emailed at this point.
      return 'Master Review';
    case 'closed':
      return 'Closed';
  }
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  TRANSITIONS[from].includes(to);

export const allowedTransitions = (from: JobStatus): readonly JobStatus[] => TRANSITIONS[from];

/**
 * Whether anyone at all may still change this job.
 *
 * Only a closed job is final. A job in Master Review has been submitted by the
 * technician but not yet issued to the customer, so a Master can still correct
 * it — see `canEditJob`, which is the check screens should use.
 */
export const isJobEditable = (status: JobStatus): boolean => status !== 'closed';

/**
 * Whether THIS ROLE may edit a job in this state.
 *
 * Technicians work a job up to the point they hand it over. Masters keep editing
 * through Master Review, which is the whole purpose of that stage: the office
 * corrects and completes the job card before the customer ever sees it.
 */
export const canEditJob = (role: UserRole, status: JobStatus): boolean => {
  if (status === 'closed') return false;
  if (status === 'submitted') return role === 'master';
  return true;
};

/**
 * Statuses where labour, travel, parts and media may be captured.
 *
 * Includes Master Review, because a Master correcting a job card routinely needs
 * to add a part that was fitted but not captured, or fix an hours entry.
 */
export const isJobWorkable = (role: UserRole, status: JobStatus): boolean => {
  if (status === 'submitted') return role === 'master';
  return status === 'in_progress' || status === 'awaiting_spares' || status === 'completion';
};

/** The job has been signed, so the customer has committed to what it says. */
export const isAfterSignature = (status: JobStatus): boolean =>
  status === 'review' || status === 'submitted' || status === 'closed';

export const isJobOpenWork = (status: JobStatus): boolean =>
  status === 'open' ||
  status === 'in_progress' ||
  status === 'awaiting_spares' ||
  status === 'completion' ||
  status === 'customer_signature' ||
  status === 'review';

export interface RuleViolation {
  readonly code: string;
  readonly message: string;
}

export interface TransitionCheck {
  readonly allowed: boolean;
  readonly violations: readonly RuleViolation[];
}

const ok: TransitionCheck = { allowed: true, violations: [] };

const blocked = (violations: readonly RuleViolation[]): TransitionCheck => ({
  allowed: false,
  violations,
});

/**
 * Requirements that must be satisfied before a job may move from `completion`
 * to `customer_signature`.
 */
export const checkReadyForSignature = (job: Job): TransitionCheck => {
  const definition = getJobTypeDefinition(job.jobType);
  const violations: RuleViolation[] = [];

  if (job.completionReport.workPerformed.trim().length === 0) {
    violations.push({
      code: 'work_performed_required',
      message: 'Work Performed must be completed before the customer signs.',
    });
  }

  if (job.labour.length === 0) {
    violations.push({
      code: 'labour_required',
      message: 'At least one labour entry is required.',
    });
  }

  if (definition.checklistRequired) {
    if (job.checklist === null) {
      violations.push({
        code: 'checklist_missing',
        message: `A ${definition.label.toLowerCase()} checklist is required for this job type.`,
      });
    } else if (job.checklist.completedAt === null) {
      violations.push({
        code: 'checklist_incomplete',
        message: 'The mandatory checklist has not been completed.',
      });
    }
  }

  if (definition.photosRequired && job.photos.length === 0) {
    violations.push({
      code: 'photos_required',
      message: `At least one photo is required for ${definition.label.toLowerCase()} jobs.`,
    });
  }

  return violations.length === 0 ? ok : blocked(violations);
};

/** Requirements before a signed job may be submitted and closed. */
export const checkReadyForSubmission = (job: Job): TransitionCheck => {
  const violations: RuleViolation[] = [];

  if (job.signature === null) {
    violations.push({
      code: 'signature_required',
      message: 'A customer signature is required before submission.',
    });
  }

  const signatureCheck = checkReadyForSignature(job);
  return violations.length === 0 && signatureCheck.allowed
    ? ok
    : blocked([...violations, ...signatureCheck.violations]);
};

/**
 * Whether the given user may accept this job. Technician acceptance is what
 * starts the job — there is deliberately no separate Start action.
 */
export const canAcceptJob = (job: Job): boolean => job.status === 'open';
