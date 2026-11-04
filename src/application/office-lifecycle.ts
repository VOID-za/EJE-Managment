import {
  can,
  canTransition,
  invoiceNumberProblem,
  isAwaitingOfficeHandling,
  poNumberProblem,
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
    'Handling a submitted job card and recording its invoice number is done by a Senior Tech or the Office.',
  );
};

/**
 * The job as the store has it NOW. Two office users pressing Handled at once
 * must not both move it — the second reads the stored status and is refused.
 */
const stored = async (context: OperationContext, job: Job): Promise<Job> =>
  (await context.repos.jobs.findById(job.id)) ?? job;

/**
 * THE PO NUMBER A JOB ALREADY HAS, if it has a usable one. PO-FLOW-1.
 *
 * In order: one the office records while handling it; one already recorded
 * against the job; the customer order number taken when the job was raised
 * ("Customer order number", e.g. PO-88123) — which is the customer's PO, and
 * was being ignored, so a job raised WITH its PO still went to Awaiting PO.
 * Blank or whitespace-only is no PO at all.
 */
export const knownPoNumber = (
  job: Pick<Job, 'purchaseOrder' | 'orderNumber'>,
  given?: string,
  /**
   * The office says the order number is NOT the customer's PO ("TBC", "to
   * follow", a quote reference): it is ignored, and the job waits for its PO.
   * The order number is free text, and a PO once recorded is never replaced —
   * so this is the office's way out before it becomes one. PO-FLOW-1.
   */
  declineOrderNumber = false,
): string | null => {
  for (const candidate of [given ?? '', job.purchaseOrder?.number ?? '', declineOrderNumber ? '' : job.orderNumber]) {
    if (candidate.trim().length > 0 && poNumberProblem(candidate) === null) return candidate.trim();
  }
  return null;
};

/**
 * OFFICE HANDLING -> AWAITING PO, or straight on to AWAITING INVOICE NO when
 * the job already has its PO number (PO-FLOW-1). The office has taken the job
 * card on.
 *
 * Accepts `office_handling` and its legacy name `awaiting_delivery` — a job
 * submitted before this lifecycle existed is a signed job card waiting on the
 * office, and is handled exactly the same way. Every office user's
 * `job_submitted` notice for the job is marked handled with it, so the job
 * leaves every Inbox at once.
 */
export const handleJobCard = async (
  context: OperationContext,
  given: Job,
  /** A PO number the office types while handling it. Optional. */
  poNumber?: string,
  /** The office says the job's order number is not its PO. */
  declineOrderNumber = false,
): Promise<Job> => {
  assertOffice(context, 'mark a job card handled');
  const job = await stored(context, given);
  if (poNumber !== undefined && poNumber.trim().length > 0) {
    const problem = poNumberProblem(poNumber);
    if (problem !== null) throw refuse(`${job.jobNumber} needs a usable PO number.`, 'po_number_invalid', problem);
    if (job.purchaseOrder !== null && job.purchaseOrder.number !== poNumber.trim()) {
      throw refuse(
        `${job.jobNumber} already has a PO number.`,
        'po_already_recorded',
        `PO ${job.purchaseOrder.number} is recorded for it, and a PO number is never replaced.`,
      );
    }
  }
  if (!isAwaitingOfficeHandling(job.status) || !canTransition(job.status, 'awaiting_po')) {
    throw refuse(
      `${job.jobNumber} is not waiting for office handling.`,
      'not_in_office_handling',
      `It is ${jobStatusLabel(job.status)}. Only a submitted job card that the office has not yet handled can be marked handled.`,
    );
  }
  const now = context.services.clock.now();
  const po = knownPoNumber(job, poNumber, declineOrderNumber);
  if (po === null) {
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
      detail: `${userFullName(context.actor)} handled the submitted job card. ${job.jobNumber} has no PO number, so it is awaiting the customer's PO and its invoice number.`,
    });
    return saved;
  }

  // PO-FLOW-1: the job has its PO — record it (once; never replaced) and go on.
  const recordedNow = job.purchaseOrder === null;
  const saved = await context.repos.jobs.save({
    ...job,
    status: 'awaiting_invoice_no',
    officeHandling: { handledBy: context.actor.id, handledAt: now },
    purchaseOrder: job.purchaseOrder ?? { number: po, recordedBy: context.actor.id, recordedAt: now },
  });
  await context.repos.notifications.markHandledForJob(job.id, 'job_submitted');
  await audit(context, {
    jobId: job.id,
    type: 'job_office_handled',
    summary: 'Job card handled by the office',
    detail: `${userFullName(context.actor)} handled the submitted job card. ${job.jobNumber} already has PO ${po}, so it is awaiting its invoice number.`,
  });
  if (recordedNow) {
    const source = poNumber !== undefined && poNumber.trim() === po ? 'entered while handling it' : "taken from the job's customer order number";
    await audit(context, {
      jobId: job.id,
      type: 'job_po_recorded',
      summary: `PO recorded — ${po}`,
      detail: `PO ${po} for ${job.jobNumber}, ${source}.`,
      changes: [{ field: 'purchaseOrder.number', from: null, to: po }],
    });
  }
  return saved;
};

/**
 * AWAITING PO -> AWAITING INVOICE NO, on a recorded PO number. INV-FLOW-1
 * (the tester, 2 November 2026: "Handled → Awaiting PO → Awaiting Invoice No →
 * Invoiced"; the PO is mandatory and cannot be skipped, and an invoice number
 * is not a substitute for it).
 *
 * Without a usable PO number NOTHING is written and the job stays Awaiting PO.
 * A PO number already recorded is never replaced (refused here, and by a
 * database trigger).
 */
export const recordPurchaseOrder = async (
  context: OperationContext,
  given: Job,
  poNumber: string,
): Promise<Job> => {
  assertOffice(context, 'record a PO number');
  const job = await stored(context, given);
  if (job.purchaseOrder !== null) {
    throw refuse(
      `${job.jobNumber} already has a PO number.`,
      'po_already_recorded',
      `PO ${job.purchaseOrder.number} is recorded for it, and a PO number is never replaced.`,
    );
  }
  if (job.status !== 'awaiting_po' || !canTransition(job.status, 'awaiting_invoice_no')) {
    throw refuse(
      `${job.jobNumber} is not awaiting a PO.`,
      'not_awaiting_po',
      `It is ${jobStatusLabel(job.status)}. The office marks a submitted job card handled first; the PO number is recorded after that.`,
    );
  }
  const problem = poNumberProblem(poNumber);
  if (problem !== null) {
    throw refuse(`${job.jobNumber} needs a PO number.`, 'po_number_required', problem);
  }
  const number = poNumber.trim();
  const saved = await context.repos.jobs.save({
    ...job,
    status: 'awaiting_invoice_no',
    purchaseOrder: { number, recordedBy: context.actor.id, recordedAt: context.services.clock.now() },
  });
  await audit(context, {
    jobId: job.id,
    type: 'job_po_recorded',
    summary: `PO recorded — ${number}`,
    detail: `${userFullName(context.actor)} recorded PO ${number} for ${job.jobNumber}. It is awaiting its invoice number.`,
    changes: [{ field: 'purchaseOrder.number', from: null, to: number }],
  });
  return saved;
};

/**
 * AWAITING INVOICE NO -> INVOICED, on a recorded invoice number.
 *
 * Only from Awaiting Invoice No, so only once the PO number is recorded
 * (INV-FLOW-1). Without a usable number NOTHING is written and the job stays
 * where it is — the refusal says why. A number already recorded is never
 * replaced: the operation refuses it here, and a database trigger refuses it
 * again.
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
  const poFirst = () =>
    refuse(
      `${job.jobNumber} needs its PO number first.`,
      'po_number_required',
      'The PO number is recorded before the invoice number; an invoice number does not replace it.',
    );
  if (job.status === 'awaiting_po') throw poFirst();
  if (job.status !== 'awaiting_invoice_no' || !canTransition(job.status, 'invoiced')) {
    throw refuse(
      `${job.jobNumber} is not awaiting an invoice number.`,
      'not_awaiting_invoice_no',
      `It is ${jobStatusLabel(job.status)}. The office marks a submitted job card handled, then records the PO number; the invoice number is recorded after that.`,
    );
  }
  if (job.purchaseOrder === null) throw poFirst();
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
  readonly purchaseOrder: Job['purchaseOrder'];
  /**
   * PO-FLOW-1: the PO that handling this job would record — its order number,
   * when that is usable — so the queue can say so before the office presses
   * Mark handled. Null when it would wait in Awaiting PO.
   */
  readonly poOnHandling: string | null;
}

/** The office queue, by lifecycle step. Invoiced is the most recent first. */
export interface OfficeQueue {
  readonly handling: readonly OfficeQueueRow[];
  readonly awaitingPo: readonly OfficeQueueRow[];
  /** INV-FLOW-1: the PO is recorded; the invoice number is not yet. */
  readonly awaitingInvoiceNo: readonly OfficeQueueRow[];
  readonly invoiced: readonly OfficeQueueRow[];
}

/**
 * How many invoiced jobs the queue carries: NONE since INVOICED-CLOSED-1 (the
 * owner, 3 November 2026). An invoiced job has left the active invoicing
 * workflow and is in Closed Jobs, with its PO, invoice number, signed PDF,
 * pricing, attachments, signature and history intact. Kept as a name, so a
 * caller reading the field gets an empty list rather than an error.
 */
export const INVOICED_TAB_LIMIT = 0;

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
      // INVOICED-CLOSED-1: `invoiced` is not active work any more — Closed Jobs holds it.
      statuses: ['office_handling', 'awaiting_delivery', 'awaiting_po', 'awaiting_invoice_no'],
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
    purchaseOrder: job.purchaseOrder,
    poOnHandling: knownPoNumber(job),
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
    awaitingInvoiceNo: summaries
      .filter((job) => job.status === 'awaiting_invoice_no')
      .sort((a, b) => oldestFirst(a.purchaseOrder?.recordedAt, b.purchaseOrder?.recordedAt))
      .map(row),
    invoiced: summaries
      .filter((job) => job.status === 'invoiced')
      .sort((a, b) => oldestFirst(b.invoice?.recordedAt, a.invoice?.recordedAt))
      .slice(0, INVOICED_TAB_LIMIT)
      .map(row),
  };
};
