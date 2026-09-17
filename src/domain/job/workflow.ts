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
  'cancelled',
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
  draft: ['open', 'cancelled'],
  // A technician handing a job back returns it to Open, which is why the
  // reverse edge exists. It carries all the work already recorded with it.
  open: ['in_progress', 'cancelled'],
  // Awaiting spares may be entered and left any number of times.
  in_progress: ['awaiting_spares', 'completion', 'open'],
  awaiting_spares: ['in_progress', 'open'],
  // Handing back from the write-up stage is legitimate — a technician taken
  // ill before the customer signs should not have to abandon the job.
  completion: ['customer_signature', 'in_progress', 'awaiting_spares', 'open'],
  customer_signature: ['review', 'completion'],
  review: ['submitted', 'completion'],
  submitted: ['closed'],
  closed: [],
  // Terminal. A cancelled job is history, not something to resurrect: raise a
  // new job instead, so the record of what was cancelled stays intact.
  cancelled: [],
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
    case 'cancelled':
      return 'Cancelled';
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
export const isJobEditable = (status: JobStatus): boolean =>
  status !== 'closed' && status !== 'cancelled';

/**
 * Whether THIS ROLE may edit a job in this state.
 *
 * Technicians work a job up to the point they hand it over. Masters keep editing
 * through Master Review, which is the whole purpose of that stage: the office
 * corrects and completes the job card before the customer ever sees it.
 */
export const canEditJob = (role: UserRole, status: JobStatus): boolean => {
  if (status === 'closed' || status === 'cancelled') return false;
  if (status === 'submitted') return role === 'master';
  return true;
};

/**
 * Deletion is for an administrative mistake — a duplicate, the wrong customer,
 * a job that should never have existed. Once a technician has accepted it there
 * is real work attached, and the honest action is to CANCEL, which keeps
 * everything.
 */
export const canDeleteJob = (role: UserRole, job: Pick<Job, 'status' | 'acceptedAt'>): boolean => {
  if (role !== 'master') return false;
  if (job.acceptedAt !== null) return false;
  return job.status === 'open' || job.status === 'draft';
};

export const deleteJobRefusal = (
  role: UserRole,
  job: Pick<Job, 'status' | 'acceptedAt'>,
): string | null => {
  if (canDeleteJob(role, job)) return null;
  if (role !== 'master') return 'Only a Master can delete a job.';
  if (job.acceptedAt !== null) {
    return 'A technician has already accepted this job, so it can no longer be deleted. Cancel it instead — that keeps the work and the history.';
  }
  return `A ${jobStatusLabel(job.status).toLowerCase()} job cannot be deleted. Only a job that has not been started can be.`;
};

/**
 * Cancellation is for a legitimate job that will not happen. Allowed while the
 * job is still waiting to be started; once work is under way, cancelling would
 * discard it, so that is deliberately not offered here.
 */
export const canCancelJob = (role: UserRole, status: JobStatus): boolean =>
  role === 'master' && (status === 'open' || status === 'draft');

export const cancelJobRefusal = (role: UserRole, status: JobStatus): string | null => {
  if (canCancelJob(role, status)) return null;
  if (role !== 'master') return 'Only a Master can cancel a job.';
  if (status === 'cancelled') return 'This job is already cancelled.';
  return `A ${jobStatusLabel(status).toLowerCase()} job cannot be cancelled from here, because work has already been recorded against it.`;
};

/** A job that has left the active workflow, whichever way it left. */
export const isJobInactive = (job: Pick<Job, 'status' | 'deletedAt'>): boolean =>
  job.deletedAt !== null || job.status === 'cancelled';

/**
 * Whether this user may hand this job on.
 *
 * A technician transfers their OWN active job — that is the whole point, since
 * the person who cannot attend is the one who knows. A Master may transfer any
 * active job. Nobody transfers a job that has reached the signature or beyond:
 * the work is done and the customer has signed for it.
 */
export const canTransferJob = (
  actor: { readonly id: string; readonly role: UserRole },
  job: Pick<Job, 'status' | 'primaryTechnicianId' | 'deletedAt'>,
): boolean => {
  if (job.deletedAt !== null) return false;
  if (!TRANSFERABLE_STATUSES.includes(job.status)) return false;
  if (actor.role === 'master') return true;
  return job.primaryTechnicianId === actor.id;
};

const TRANSFERABLE_STATUSES: readonly JobStatus[] = [
  'open',
  'in_progress',
  'awaiting_spares',
  'completion',
];

export const transferJobRefusal = (
  actor: { readonly id: string; readonly role: UserRole },
  job: Pick<Job, 'status' | 'primaryTechnicianId' | 'deletedAt'>,
): string | null => {
  if (canTransferJob(actor, job)) return null;
  if (job.deletedAt !== null) return 'This job has been deleted.';
  if (!TRANSFERABLE_STATUSES.includes(job.status)) {
    return `A ${jobStatusLabel(job.status).toLowerCase()} job cannot be transferred. The customer has already signed for this work.`;
  }
  return 'You can only transfer a job assigned to you.';
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

  // A parts collection records no work and no hours: it is a receipt for goods.
  if (!definition.capturesLabourAndTravel) {
    if (job.parts.length === 0) {
      violations.push({
        code: 'parts_required',
        message: 'At least one part line is required before the collector signs.',
      });
    }
    return violations.length === 0 ? ok : blocked(violations);
  }

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
