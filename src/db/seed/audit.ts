import { asActivityId, type ActivityEvent } from '@/domain';
import { demoId } from './ids';
import { timeAgo } from './calendar';
import { COORDINATOR, MASTER, TECH1, TECH2 } from './people';
import { jobId } from './jobs';

/**
 * A short audit trail behind the seeded jobs.
 *
 * Not one event per field change — that would be inventing a history nobody
 * lived. Just enough that the Activity screen and the trail on a job card have
 * real entries: who raised each notable job, who accepted it, who signed it off
 * and who moved one from one technician to another.
 */
const event = (
  key: string,
  jobNumber: string | null,
  type: ActivityEvent['type'],
  summary: string,
  detail: string,
  actorId: typeof MASTER,
  occurredAt: string,
): ActivityEvent => ({
  id: asActivityId(demoId(`activity:${key}`)),
  jobId: jobNumber === null ? null : jobId(jobNumber),
  type,
  summary,
  detail,
  actorId,
  occurredAt,
});

export const seedActivity: readonly ActivityEvent[] = [
  event(
    'a1',
    'EJE-2015',
    'job_created',
    'Job raised',
    'Breakdown raised for ACME Engineering Solutions (DEMO).',
    MASTER,
    timeAgo(21, 7),
  ),
  event(
    'a2',
    'EJE-2015',
    'job_accepted',
    'Job accepted',
    'Mike Technician accepted the job and started work.',
    TECH1,
    timeAgo(21, 7, 25),
  ),
  event(
    'a3',
    'EJE-2015',
    'customer_signed',
    'Customer signature captured',
    'Signed by Pieter Nel.',
    TECH1,
    timeAgo(21, 12, 10),
  ),
  event(
    'a4',
    'EJE-2015',
    'job_closed',
    'Job closed',
    'Signed job card delivered to the customer.',
    MASTER,
    timeAgo(21, 12, 25),
  ),
  event(
    'a5',
    'EJE-2018',
    'customer_refused_to_sign',
    'Customer refused to sign',
    'Recorded on site. The reason is held on the job, not on the trail.',
    TECH1,
    timeAgo(1, 15, 30),
  ),
  event(
    'a6',
    'EJE-2019',
    'customer_refused_to_sign',
    'Customer refused to sign',
    'Recorded on site. The reason is held on the job, not on the trail.',
    TECH2,
    timeAgo(14, 15, 45),
  ),
  event(
    'a7',
    'EJE-2019',
    'signature_refusal_resolved',
    'Refusal resolved',
    'The job card was corrected and returned for signature.',
    MASTER,
    timeAgo(13, 9, 30),
  ),
  event(
    'a8',
    'EJE-2019',
    'job_closed',
    'Job closed',
    'Corrected job card signed and delivered.',
    MASTER,
    timeAgo(13, 10, 15),
  ),
  event(
    'a9',
    'EJE-2023',
    'job_transferred_to_technician',
    'Job handed to another technician',
    'Moved from Mike Technician to David Technician: vehicle problem.',
    COORDINATOR,
    timeAgo(0, 10, 15),
  ),
  event(
    'a10',
    'EJE-2016',
    'job_closed',
    'Job closed',
    'Signed job card delivered to the customer.',
    MASTER,
    timeAgo(35, 13, 40),
  ),
];
