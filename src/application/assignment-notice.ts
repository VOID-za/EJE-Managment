import { getJobTypeDefinition, userFullName, type Job, type User } from '@/domain';
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
/**
 * `transfer` — WA-TRANSFER-1, 26 October 2026. A transfer hands the job to a
 * technician exactly as an assignment does, so they are told the same way, on
 * the same APPROVED template. Whether a transfer deserves wording of its own
 * was BD-25, and the owner decided on 27 October 2026 that it does not: the
 * approved assignment template is reused and no other is invented. The
 * message reads "transferred to you" only in the preview this system keeps,
 * while the template's four placeholders are filled exactly as for an
 * assignment.
 */
export type AssignmentOccasion = 'primary' | 'additional' | 'transfer';

const HEADLINE: Record<AssignmentOccasion, string> = {
  primary: 'You have been assigned a job',
  additional: 'You have been added to a job',
  transfer: 'A job has been transferred to you',
};

const LINE: Record<AssignmentOccasion, string> = {
  primary: 'assigned to you',
  additional: 'you have been added',
  transfer: 'transferred to you',
};

const NOUN: Record<AssignmentOccasion, string> = {
  primary: 'assignment',
  additional: 'assignment',
  transfer: 'transfer',
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

/**
 * A TRANSFER HAS ITS OWN TEMPLATE. INT-WA-1 (the owner, 1 November 2026: "Job
 * transfer — notify receiving technician"). It used to reuse the assignment
 * template, so the receiving technician read "has been assigned to you" for a
 * job somebody handed over mid-way. Same six variables, its own words.
 */
export const TRANSFER_TEMPLATE = 'eje_job_transferred';

/**
 * Where a job is opened in EJE, for the message's link. The link opens the
 * sign-in page for anybody without a session: it carries no token and no
 * customer detail, only the job number (EJE_PUBLIC_URL, default the live site).
 */
export const jobLink = (jobNumber: string): string =>
  `${((process.env.EJE_PUBLIC_URL ?? '').trim() || 'https://eje.syncza.co.za').replace(/\/+$/u, '')}/jobs/${encodeURIComponent(jobNumber)}`;

/**
 * THE TEMPLATE'S SIX VARIABLES, in Meta's order (docs/integrations-setup.md):
 * job number, job type, customer, site, machine, link. Nothing else — not the
 * fault description, not a contact's name or number, not the street address —
 * because the message can be read on a locked phone's screen.
 */
export const assignmentParameters = (job: Job, details: AssignmentContext): readonly string[] => [
  job.jobNumber,
  getJobTypeDefinition(job.jobType).label,
  details.customerName,
  details.siteName,
  details.machineName.length > 0 ? details.machineName : 'Not specified',
  jobLink(job.jobNumber),
];

export interface AssignmentContext {
  /** The machine as "Manufacturer Model", or empty. INT-WA-1. */
  readonly machineName: string;
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
    `${job.jobNumber} — ${LINE[occasion]}`,
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

  return queueAssignmentWhatsApp(context, job, technician, occasion, details);
};

/**
 * The WhatsApp half on its own, for a caller that raises its own in-app
 * notification — a transfer, whose notice carries the transfer's reason.
 */
export const queueAssignmentWhatsApp = async (
  context: OperationContext,
  job: Job,
  technician: User,
  occasion: AssignmentOccasion,
  details: AssignmentContext,
): Promise<AssignmentNoticeResult> => {
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
        `No mobile number on their account, so only the in-app notification was raised. The ${NOUN[occasion]} stands.`,
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
    template: occasion === 'transfer' ? TRANSFER_TEMPLATE : ASSIGNMENT_TEMPLATE,
    purpose: occasion === 'transfer' ? 'transfer' : 'assignment',
    recipient: technician.mobile,
    parameters: [...assignmentParameters(job, details)],
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
    summary: `${userFullName(technician)} notified of the ${NOUN[occasion]}`,
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
    machineName: machine === null ? '' : `${machine.manufacturer} ${machine.model}`.trim(),
    customerName: customer?.name ?? 'Customer',
    siteName: site?.name ?? 'Site',
    subject:
      machine === null
        ? job.faultDescription.slice(0, 80)
        : `${machine.manufacturer} ${machine.model}`,
  };
};
