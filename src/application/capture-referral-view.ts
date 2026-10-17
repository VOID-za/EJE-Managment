import { userFullName, type CaptureReferral, type JobStatus } from '@/domain';
import type { OperationContext } from './context';

/**
 * A referred capture as a SCREEN needs it. BD-15.
 *
 * The referral itself carries ids. An office screen has to show a job number, a
 * technician's name and where the job has got to — otherwise the first thing
 * anybody does with the list is look all three up. Composed here, the way every
 * other read model in this application is, so a route does no joining.
 *
 * NOTHING COMMERCIAL IS ADDED. No prices, no customer contact details: the
 * question this screen answers is "what work could not be applied, to which
 * job, by whom, and why", and anything beyond that is somebody else's screen.
 */
export interface CaptureReferralRow {
  readonly referral: CaptureReferral;
  readonly jobNumber: string;
  readonly jobStatus: JobStatus;
  readonly technicianName: string;
  /** Who resolved it, where somebody has. */
  readonly resolvedByName: string | null;
}

export const toCaptureReferralRows = async (
  context: OperationContext,
  referrals: readonly CaptureReferral[],
): Promise<readonly CaptureReferralRow[]> => {
  const rows: CaptureReferralRow[] = [];
  /*
   * One read per distinct job and user rather than per referral: a busy week
   * can refer several captures against the same job, and a list screen is not
   * a reason to read it five times.
   */
  const jobs = new Map<string, { jobNumber: string; status: JobStatus } | null>();
  const names = new Map<string, string | null>();

  const jobFor = async (jobId: string) => {
    if (!jobs.has(jobId)) {
      const job = await context.repos.jobs.findById(jobId as CaptureReferral['jobId']);
      jobs.set(jobId, job === null ? null : { jobNumber: job.jobNumber, status: job.status });
    }
    return jobs.get(jobId) ?? null;
  };

  const nameFor = async (userId: string) => {
    if (userId.length === 0) return null;
    if (!names.has(userId)) {
      const user = await context.repos.users.findById(userId as never);
      names.set(userId, user === null ? null : userFullName(user));
    }
    return names.get(userId) ?? null;
  };

  for (const referral of referrals) {
    const job = await jobFor(referral.jobId);
    rows.push({
      referral,
      // A referral's job cannot be deleted (the foreign key restricts it), so a
      // missing job means a demonstration reset rather than lost history.
      jobNumber: job?.jobNumber ?? '—',
      jobStatus: job?.status ?? 'closed',
      technicianName: (await nameFor(referral.technicianId)) ?? 'a technician',
      resolvedByName:
        referral.resolvedBy === null ? null : await nameFor(referral.resolvedBy),
    });
  }

  return rows;
};
