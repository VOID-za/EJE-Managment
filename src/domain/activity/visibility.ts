import type { ActivityEvent, ActivityEventType } from '../types/activity';
import type { Job } from '../types/job';
import type { User } from '../types/user';
import { can } from '../access';
import { canSeeSignatureRefusal } from '../job/signature-refusal';

/**
 * Who may read the audit trail, and which of it.
 *
 * The trail is a second copy of almost everything the system knows: who was put
 * on what, what a customer objected to, what the charge-out rates were changed
 * to, whose role was altered. It was readable by anybody signed in, which made
 * it a way around every other rule in the domain — a technician who could not
 * see another technician's signature refusal on the job screen could read the
 * reason verbatim on the activity feed, because the refusal had been written
 * into an audit event and no viewer rule touched audit events.
 *
 * So visibility is decided HERE, beside the rule it has to agree with, rather
 * than by whichever screen happens to render a timeline.
 *
 * Two questions, deliberately separate:
 *
 *  1. May this person read the WHOLE company's trail? `activity.viewAll`.
 *  2. May this person read THIS event, on a job in front of them? The rules
 *     below, which follow the same logic the job itself is redacted by.
 */

/** Whether this role may read the company-wide audit trail at all. */
export const canReadActivityFeed = (role: User['role']): boolean =>
  can(role, 'activity.viewAll');

/**
 * Events that say something about a customer's refusal to sign.
 *
 * They are gated by exactly the same rule as the refusal record itself
 * (`canSeeSignatureRefusal`), because they describe the same fact. Listing them
 * by type rather than by inspecting the text is deliberate: a rule that depends
 * on what somebody happened to type is not a rule.
 */
export const SIGNATURE_REFUSAL_EVENT_TYPES: readonly ActivityEventType[] = [
  'customer_refused_to_sign',
  'signature_refusal_resolved',
  'returned_for_customer_signature',
];

/**
 * Events that describe the running of EJE rather than the doing of a job.
 *
 * Charge-out rates, who was given which role, whose password was reset, what
 * the office corrected after a customer had already signed. These carry no job
 * id and belong to whoever administers the business; a technician has no reason
 * to read them and, in the case of the rates, a commercial reason not to.
 *
 * They are only ever reachable through the company-wide feed, which is already
 * gated — this list exists so that a future per-job or per-person feed cannot
 * surface them by accident.
 */
export const OFFICE_ONLY_EVENT_TYPES: readonly ActivityEventType[] = [
  'settings_updated',
  'user_created',
  'user_updated',
  'user_role_changed',
  'user_disabled',
  'user_reactivated',
  'password_reset_sent',
  'master_amended_after_signature',
  'job_card_corrected',
];

/**
 * Whether this viewer may read this event about this job.
 *
 * `job` is the job the event belongs to, already loaded. Null when the event
 * carries no job id — a register change — which only the office may read.
 *
 * The refusal rule is the one that matters: a technician sees a refusal
 * recorded against work they were sent to, and nothing else. That is
 * `canSeeSignatureRefusal`, unchanged, applied to the audit trail as well as to
 * the record, so the two cannot disagree again.
 */
export const canSeeActivityEvent = (
  viewer: Pick<User, 'id' | 'role'>,
  event: Pick<ActivityEvent, 'type' | 'jobId'>,
  job: Pick<Job, 'id' | 'primaryTechnicianId' | 'signatureRefusals'> | null,
): boolean => {
  if (OFFICE_ONLY_EVENT_TYPES.includes(event.type)) {
    return can(viewer.role, 'activity.viewAll');
  }

  if (SIGNATURE_REFUSAL_EVENT_TYPES.includes(event.type)) {
    // No job to check it against is not a reason to show it: a refusal event
    // whose job cannot be resolved is not readable by anyone but the office.
    if (job === null) return can(viewer.role, 'jobs.viewAnySignatureRefusal');
    return canSeeSignatureRefusal(viewer, job);
  }

  return true;
};

/**
 * The events this viewer may read, out of the ones given.
 *
 * Filtering rather than redacting, because an audit entry is one indivisible
 * fact: there is no useful half of "Customer refused to sign. Reason: …" to
 * show somebody who may not read it, and an entry stripped to its timestamp
 * tells them one happened, which is the thing being withheld.
 */
export const visibleActivityEvents = <T extends Pick<ActivityEvent, 'type' | 'jobId'>>(
  events: readonly T[],
  viewer: Pick<User, 'id' | 'role'>,
  jobsById: ReadonlyMap<string, Pick<Job, 'id' | 'primaryTechnicianId' | 'signatureRefusals'>>,
): readonly T[] =>
  events.filter((event) =>
    canSeeActivityEvent(
      viewer,
      event,
      event.jobId === null ? null : (jobsById.get(event.jobId) ?? null),
    ),
  );
