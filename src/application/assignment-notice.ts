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
 * TWO CHANNELS, AND NEITHER OF THEM SENDS ANYTHING FROM HERE.
 *
 *  - The IN-APP notification is a row in this database, written inside the same
 *    transaction as the assignment. It either commits with the assignment or
 *    neither happens, so there is no such thing as an assignment nobody was
 *    notified of.
 *  - WHATSAPP is also a row: an OUTBOX entry saying what must be sent, written
 *    in that same transaction. The message leaves the building afterwards, in
 *    `outbox-dispatch`, once the assignment has committed.
 *
 * WHY NOT JUST CALL META HERE. Because this code runs inside a PostgreSQL
 * transaction, and a transaction that waits on a network round trip is a
 * connection nobody else can have. Worse, it left nothing to retry from: commit
 * the assignment, fail the call, and the obligation to tell somebody existed
 * only in an audit line.
 *
 * WHAT IS NEVER RECORDED: that a message was sent, when it was not. Queued is
 * not sent; sent means the provider accepted it; delivered would need a
 * delivery report this deployment does not receive. Three different words for
 * three different facts, and none of them borrowed for another.
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
  /**
   * Whether a WhatsApp message was QUEUED. Not sent, and certainly not
   * delivered: the outbox row is the promise, and `outbox-dispatch` is what
   * tries to keep it.
   */
  readonly queued: boolean;
  /** Why nothing was queued. Null when something was. */
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
    return { queued: false, failureReason: 'No mobile number on the account.' };
  }

  /*
   * ENQUEUED, NOT SENT — and this is the whole change.
   *
   * This runs inside the transaction that is recording the assignment. It
   * writes a row saying a message must go, and commits with the assignment.
   * The send happens afterwards, outside any transaction, and updates that row
   * with what actually happened.
   *
   * What that buys: no PostgreSQL transaction is held open across a network
   * call to Meta, and a commit can no longer lose the obligation. Before this,
   * a failed HTTP call left an audit line saying so and nothing to retry from.
   */
  await context.repos.outbox.enqueue({
    id: context.services.ids.next('outbox'),
    channel: 'whatsapp',
    template: ASSIGNMENT_TEMPLATE,
    recipient: technician.mobile,
    parameters: [job.jobNumber, details.customerName, details.siteName, details.subject],
    preview: buildAssignmentMessage(job, details, occasion),
    jobId: job.id,
    state: 'pending',
    attempts: 0,
    providerMessageId: null,
    failureReason: '',
    createdAt: context.services.clock.now(),
    lastAttemptAt: null,
  });

  await audit(context, {
    jobId: job.id,
    type: 'assignment_notified',
    summary: `${userFullName(technician)} notified of the assignment`,
    detail:
      'In-app notification raised and a WhatsApp message queued for delivery. Queued is not sent, and sent is not delivered — the outbox records what the provider actually says.',
  });

  return { queued: true, failureReason: null };
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
