import {
  can,
  canTransition,
  invoiceNumberProblem,
  isAwaitingOfficeHandling,
  jobStatusLabel,
  userFullName,
  type Job,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * THE OFFICE LIFECYCLE AFTER A TECHNICIAN SUBMITS. Issue #73, Batch 1.
 *
 *   office_handling --(handled)--> awaiting_po --(invoice number)--> invoiced
 *
 * The technician's part ends at submission: the signed job card, the customer's
 * signature, the final document and the audit trail are all in place by then,
 * and nothing here touches any of them. The office marks the job card handled
 * once the invoice is being raised — EJE raise invoices in Sage, by hand; this
 * system keeps the invoice NUMBER and does not talk to Sage — and the job is
 * finished when that number is recorded.
 *
 * Email delivery of the customer's copy is tracked separately (`Job.delivery`)
 * and has no say in any of this.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

const assertOffice = (context: OperationContext, what: string): void => {
  if (can(context.actor.role, 'jobs.officeHandling')) return;
  throw refuse(
    `Only the office can ${what}.`,
    'not_permitted',
    'Handling a submitted job card and recording its invoice number is done by a Master or a Coordinator.',
  );
};

/**
 * The job as the store has it NOW. Two office users pressing Handled at once
 * must not both move it — the second reads the stored status and is refused.
 */
const stored = async (context: OperationContext, job: Job): Promise<Job> =>
  (await context.repos.jobs.findById(job.id)) ?? job;

/**
 * OFFICE HANDLING -> AWAITING PO. The office has taken the job card on.
 *
 * Accepts `office_handling` and its legacy name `awaiting_delivery` — a job
 * submitted before this lifecycle existed is a signed job card waiting on the
 * office, and is handled exactly the same way. Every office user's
 * `job_submitted` notice for the job is marked handled with it, so the job
 * leaves every Inbox at once.
 */
export const handleJobCard = async (context: OperationContext, given: Job): Promise<Job> => {
  assertOffice(context, 'mark a job card handled');
  const job = await stored(context, given);
  if (!isAwaitingOfficeHandling(job.status) || !canTransition(job.status, 'awaiting_po')) {
    throw refuse(
      `${job.jobNumber} is not waiting for office handling.`,
      'not_in_office_handling',
      `It is ${jobStatusLabel(job.status)}. Only a submitted job card that the office has not yet handled can be marked handled.`,
    );
  }
  const now = context.services.clock.now();
  const saved = await context.repos.jobs.save({
    ...job,
    status: 'awaiting_po',
    officeHandling: { handledBy: context.actor.id, handledAt: now },
  });
  await context.repos.notifications.markHandledForJob(job.id, 'job_submitted');
  await audit(context, {
    jobId: job.id,
    type: 'job_office_handled',
    summary: 'Job card handled by the office',
    detail: `${userFullName(context.actor)} handled the submitted job card. ${job.jobNumber} is awaiting the customer's PO and its invoice number.`,
  });
  return saved;
};

/**
 * AWAITING PO -> INVOICED, on a recorded invoice number.
 *
 * Without a usable number NOTHING is written and the job stays Awaiting PO —
 * the refusal says why. A number already recorded is never replaced: the
 * operation refuses it here, and a database trigger refuses it again.
 */
export const recordInvoiceNumber = async (
  context: OperationContext,
  given: Job,
  invoiceNumber: string,
): Promise<Job> => {
  assertOffice(context, 'record an invoice number');
  const job = await stored(context, given);
  if (job.invoice !== null) {
    throw refuse(
      `${job.jobNumber} is already invoiced.`,
      'already_invoiced',
      `Invoice ${job.invoice.number} is recorded for it, and an invoice number is never replaced.`,
    );
  }
  if (job.status !== 'awaiting_po' || !canTransition(job.status, 'invoiced')) {
    throw refuse(
      `${job.jobNumber} is not awaiting a PO.`,
      'not_awaiting_po',
      `It is ${jobStatusLabel(job.status)}. The office marks a submitted job card handled first; the invoice number is recorded after that.`,
    );
  }
  const problem = invoiceNumberProblem(invoiceNumber);
  if (problem !== null) {
    throw refuse(`${job.jobNumber} needs an invoice number.`, 'invoice_number_required', problem);
  }
  const number = invoiceNumber.trim();
  const now = context.services.clock.now();
  const saved = await context.repos.jobs.save({
    ...job,
    status: 'invoiced',
    invoice: { number, recordedBy: context.actor.id, recordedAt: now },
  });
  await audit(context, {
    jobId: job.id,
    type: 'job_invoiced',
    summary: `Invoiced — ${number}`,
    detail: `${userFullName(context.actor)} recorded invoice ${number} for ${job.jobNumber}.`,
  });
  return saved;
};

/** One row of the office's queue, as the Notifications tabs list it. Issue #73. */
export interface OfficeQueueRow {
  readonly jobId: string;
  readonly jobNumber: string;
  readonly jobType: Job['jobType'];
  readonly status: Job['status'];
  readonly customerName: string;
  readonly submittedAt: string | null;
  readonly officeHandling: Job['officeHandling'];
  readonly invoice: Job['invoice'];
}

/** The office queue, by lifecycle step. Invoiced is the most recent first. */
export interface OfficeQueue {
  readonly handling: readonly OfficeQueueRow[];
  readonly awaitingPo: readonly OfficeQueueRow[];
  readonly invoiced: readonly OfficeQueueRow[];
}

/** How many invoiced jobs the tab lists. The closed-jobs archive holds them all. */
export const INVOICED_TAB_LIMIT = 100;

/**
 * THE JOBS THE OFFICE OWES SOMETHING, read from the jobs themselves — their
 * persisted status — not inferred from notifications. Office only.
 *
 * `handling` includes the legacy `awaiting_delivery`: a job submitted before
 * this lifecycle is waiting on the office exactly as a new one is.
 */
export const loadOfficeQueue = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'role'>,
): Promise<OfficeQueue | null> => {
  if (!can(actor.role, 'jobs.officeHandling')) return null;
  const [summaries, customers] = await Promise.all([
    repos.jobs.listSummaries({
      statuses: ['office_handling', 'awaiting_delivery', 'awaiting_po', 'invoiced'],
    }),
    repos.customers.list(),
  ]);
  const names = new Map(customers.map((customer) => [customer.id as string, customer.name]));
  const row = (job: (typeof summaries)[number]): OfficeQueueRow => ({
    jobId: job.id,
    jobNumber: job.jobNumber,
    jobType: job.jobType,
    status: job.status,
    customerName: names.get(job.customerId) ?? 'Unknown customer',
    submittedAt: job.submittedAt,
    officeHandling: job.officeHandling,
    invoice: job.invoice,
  });
  const oldestFirst = (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? '').localeCompare(b ?? '');
  return {
    handling: summaries
      .filter((job) => isAwaitingOfficeHandling(job.status))
      .sort((a, b) => oldestFirst(a.submittedAt, b.submittedAt))
      .map(row),
    awaitingPo: summaries
      .filter((job) => job.status === 'awaiting_po')
      .sort((a, b) => oldestFirst(a.officeHandling?.handledAt, b.officeHandling?.handledAt))
      .map(row),
    invoiced: summaries
      .filter((job) => job.status === 'invoiced')
      .sort((a, b) => oldestFirst(b.invoice?.recordedAt, a.invoice?.recordedAt))
      .slice(0, INVOICED_TAB_LIMIT)
      .map(row),
  };
};
