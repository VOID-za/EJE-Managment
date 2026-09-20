import {
  canReadActivityFeed,
  visibleActivityEvents,
  type ActivityEvent,
  type JobId,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import { WorkflowError } from './errors';

/**
 * Reading the audit trail, with the actor deciding what comes back.
 *
 * Authorisation lives in this function and not in the screen that calls it.
 * `/activity` used to load `repos.activity.list()` and render it, with no check
 * anywhere and no capability consulted — `activity.viewAll` was declared in the
 * capability matrix and never called. A technician could therefore read every
 * customer refusal, every rate change and every role change in the business
 * simply by typing the URL.
 *
 * Hiding the navigation item would not have fixed that, and in Phase 2 these
 * functions become the API handler: whatever refuses here is what refuses when
 * the read is a request over the wire rather than a call in the same process.
 */

export interface ActivityFeed {
  readonly events: readonly ActivityEvent[];
  readonly users: readonly User[];
  /** Job number by job id, for the timeline's links. */
  readonly jobNumbers: ReadonlyMap<string, string>;
}

/**
 * The company-wide audit trail.
 *
 * Refused outright for a role without `activity.viewAll`, because there is no
 * scoped version of "everything that happened at EJE" worth returning: a
 * technician's own work is already on their jobs, where `loadJobActivity`
 * serves it.
 */
export const loadActivityFeed = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'id' | 'role'>,
): Promise<ActivityFeed> => {
  if (!canReadActivityFeed(actor.role)) {
    throw new WorkflowError('The activity trail is an office record.', [
      {
        code: 'not_permitted',
        message:
          'Your role does not read the company-wide audit trail. The history of a job you worked is on the job itself.',
      },
    ]);
  }

  const [events, users, jobs] = await Promise.all([
    repos.activity.list(),
    repos.users.list(),
    repos.jobs.list({ includeDeleted: true }),
  ]);

  const jobsById = new Map(jobs.map((job) => [job.id as string, job]));

  return {
    /*
     * Filtered even for a reader who passed the capability check.
     *
     * `activity.viewAll` is held by Masters and Coordinators, both of whom may
     * see any refusal — so today this removes nothing from them. It is applied
     * anyway because the alternative is a feed whose contents depend on a
     * capability check made somewhere else: if a fourth role is ever given
     * `activity.viewAll` without `jobs.viewAnySignatureRefusal`, this is what
     * keeps the two rules agreeing.
     */
    events: visibleActivityEvents(events, actor, jobsById),
    users,
    jobNumbers: new Map(jobs.map((job) => [job.id as string, job.jobNumber])),
  };
};

/**
 * One job's history, as this viewer may read it.
 *
 * Needs no capability: a job's own timeline is part of the job, and whoever may
 * open the job may read what happened on it. What it does enforce is the
 * refusal rule — the same `canSeeSignatureRefusal` the job record itself is
 * redacted by, so a technician handed a job with no refusals on it is not then
 * shown the refusal in the Activity tab underneath.
 */
export const loadJobActivity = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'id' | 'role'>,
  jobId: JobId,
): Promise<readonly ActivityEvent[]> => {
  const [events, job] = await Promise.all([
    repos.activity.list(jobId),
    repos.jobs.findById(jobId),
  ]);

  const forThisJob = events.filter((event) => event.jobId === jobId);
  const jobsById = new Map(job === null ? [] : [[job.id as string, job] as const]);
  return visibleActivityEvents(forThisJob, actor, jobsById);
};
