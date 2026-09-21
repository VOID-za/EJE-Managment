import { userFullName, type Job, type User } from '@/domain';
import type { OperationContext } from './context';
import { audit, notify } from './audit';

/**
 * Telling a technician they have been given a job.
 *
 * THE POINT OF THIS MODULE. Until now the system recorded `job_assigned` on the
 * audit trail and told nobody. A technician learned about their work by opening
 * the application and looking — which is not how EJE run: a breakdown raised at
 * 06:40 has to reach the person who is about to drive somewhere else.
 *
 * TWO CHANNELS, AND THEY FAIL DIFFERENTLY.
 *
 *  - The IN-APP notification is a row in this database, written inside the same
 *    transaction as the assignment. It either commits with the assignment or
 *    neither happens, so there is no such thing as an assignment nobody was
 *    notified of.
 *  - WHATSAPP leaves the building. It can fail for reasons that have nothing to
 *    do with EJE — a provider outage, an expired token, a deployment with no
 *    WhatsApp configuration at all — and none of those are a reason to refuse
 *    the office's assignment. So it is attempted, and its ACTUAL outcome is
 *    written to the audit trail.
 *
 * WHAT IS NEVER RECORDED: that a message was sent, when it was not. A failure
 * writes `assignment_notification_failed` carrying the provider's reason. A
 * success writes `assignment_notified` and says only that the provider ACCEPTED
 * it — `pending_delivery` — because no handset has confirmed anything. The
 * distinction is the whole reason this is written down.
 */
export type AssignmentOccasion = 'primary' | 'additional';

const HEADLINE: Record<AssignmentOccasion, string> = {
  primary: 'You have been assigned a job',
  additional: 'You have been added to a job',
};

/**
 * The approved WhatsApp template this sends.
 *
 * Must exist and be APPROVED on EJE's WhatsApp Business account under exactly
 * this name, with four body placeholders in this order. An unapproved or
 * renamed template is refused by the Cloud API, which surfaces here as a
 * recorded failure rather than a silent one.
 */
export const ASSIGNMENT_TEMPLATE = 'eje_job_assigned';

export interface AssignmentContext {
  readonly customerName: string;
  readonly siteName: string;
  /** The machine's description, or the job type where there is no machine. */
  readonly subject: string;
}

/** What the technician reads. Short: it arrives while somebody is working. */
export const buildAssignmentMessage = (
  job: Job,
  context: AssignmentContext,
  occasion: AssignmentOccasion,
): string =>
  [
    `${job.jobNumber} — ${occasion === 'primary' ? 'assigned to you' : 'you have been added'}`,
    `${context.customerName}, ${context.siteName}`,
    context.subject,
    job.faultDescription.length > 160
      ? `${job.faultDescription.slice(0, 157)}...`
      : job.faultDescription,
  ].join('\n');

export interface AssignmentNoticeResult {
  /** Whether the provider ACCEPTED the WhatsApp message. Never "delivered". */
  readonly whatsappAccepted: boolean;
  /** Why it did not go. Null when it did, or when there was no number to use. */
  readonly failureReason: string | null;
}

export const notifyAssignment = async (
  context: OperationContext,
  job: Job,
  technician: User,
  occasion: AssignmentOccasion,
  details: AssignmentContext,
): Promise<AssignmentNoticeResult> => {
  const headline = HEADLINE[occasion];
  const body = `${job.jobNumber} — ${details.customerName}, ${details.siteName}. ${details.subject}.`;

  /*
   * In-app first, and unconditionally.
   *
   * Even when the actor assigned the job to themselves: the notification list
   * is also the technician's record of what they are on, and leaving a gap in
   * it to avoid stating the obvious makes it less useful, not more.
   */
  await notify(context, {
    recipientId: technician.id,
    type: 'job_assigned',
    title: headline,
    body,
    jobId: job.id,
    channels: technician.mobile.trim().length > 0 ? ['in_app', 'whatsapp'] : ['in_app'],
  });

  if (technician.mobile.trim().length === 0) {
    /*
     * No mobile number on the account.
     *
     * Recorded, not ignored: the office should know that this technician can
     * only be reached in the application, because that is a thing they can fix.
     */
    await audit(context, {
      jobId: job.id,
      type: 'assignment_notification_failed',
      summary: `${userFullName(technician)} could not be messaged`,
      detail:
        'No mobile number on their account, so only the in-app notification was raised. The assignment stands.',
    });
    return { whatsappAccepted: false, failureReason: 'No mobile number on the account.' };
  }

  try {
    const entry = await context.services.whatsapp.send({
      to: technician.mobile,
      templateName: ASSIGNMENT_TEMPLATE,
      parameters: [job.jobNumber, details.customerName, details.siteName, details.subject],
      preview: buildAssignmentMessage(job, details, occasion),
    });

    await audit(context, {
      jobId: job.id,
      type: 'assignment_notified',
      summary: `${userFullName(technician)} notified of the assignment`,
      detail: entry.simulated
        ? `In-app notification raised. The WhatsApp message was recorded in the demonstration outbox and NOT transmitted.`
        : `In-app notification raised, and WhatsApp accepted the message (${entry.id}). Acceptance is not delivery — no handset has confirmed it.`,
    });

    return { whatsappAccepted: true, failureReason: null };
  } catch (cause: unknown) {
    const failureReason =
      cause instanceof Error ? cause.message : 'The message could not be queued.';

    /*
     * Deliberately not rethrown, and deliberately not hidden.
     *
     * The assignment is a decision the office made and it stands. What changes
     * is that the trail now says the technician was not reached, so somebody
     * can pick up a phone.
     */
    await audit(context, {
      jobId: job.id,
      type: 'assignment_notification_failed',
      summary: `${userFullName(technician)} could not be messaged`,
      detail: `${failureReason} The in-app notification was raised and the assignment stands.`,
    });

    return { whatsappAccepted: false, failureReason };
  }
};

/**
 * The customer, site and machine for the message, read from the register.
 *
 * Resolved here rather than passed in, so the message cannot describe a job
 * differently from the job card. A record that has gone leaves its line blank
 * rather than failing the assignment.
 */
export const assignmentDetails = async (
  context: OperationContext,
  job: Job,
): Promise<AssignmentContext> => {
  const [customer, site, machine] = await Promise.all([
    context.repos.customers.findById(job.customerId),
    context.repos.customers.findSiteById(job.siteId),
    job.machineId === null
      ? Promise.resolve(null)
      : context.repos.machines.findById(job.machineId),
  ]);

  return {
    customerName: customer?.name ?? 'Customer',
    siteName: site?.name ?? 'Site',
    subject:
      machine === null
        ? job.faultDescription.slice(0, 80)
        : `${machine.manufacturer} ${machine.model}`,
  };
};
