import type { Job } from '../types/job';
import type { UserId } from '../types/common';
import type { User } from '../types/user';

/**
 * Who did the work, and who wrote it down.
 *
 * These are not always the same person. A Coordinator in the office routinely
 * types up hours, travel and parts for a technician who telephoned them in, and
 * the record has to say both things: the hours are the TECHNICIAN'S, and the
 * capture is the COORDINATOR'S. Attributing the line to whoever happened to be
 * at the keyboard would put the office on a job card as having worked on a
 * machine they never saw.
 */

/** Whether this person is on the job as a technician. */
export const isJobTechnician = (
  actor: Pick<User, 'id'>,
  job: Pick<Job, 'primaryTechnicianId' | 'additionalTechnicianIds'>,
): boolean =>
  job.primaryTechnicianId === actor.id || job.additionalTechnicianIds.includes(actor.id);

/**
 * Whose work a captured line belongs to.
 *
 * The actor when they are on the job; otherwise the technician the job is
 * assigned to, because that is whose work is being written up. Falls back to
 * the actor only when the job has nobody assigned at all, which is the honest
 * answer — there is no technician to credit.
 */
export const workAttribution = (
  actor: Pick<User, 'id'>,
  job: Pick<Job, 'primaryTechnicianId' | 'additionalTechnicianIds'>,
): UserId => {
  if (isJobTechnician(actor, job)) return actor.id;
  return job.primaryTechnicianId ?? actor.id;
};

/** A capture made by somebody who is not on the job: the office writing it up. */
export const isAdministrativeCapture = (
  actor: Pick<User, 'id'>,
  job: Pick<Job, 'primaryTechnicianId' | 'additionalTechnicianIds'>,
): boolean => !isJobTechnician(actor, job);
