import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addPart,
  captureSignature,
  confirmJobCardDelivery,
  issueJobCard,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { handleJobCard, loadOfficeQueue, recordInvoiceNumber, recordPurchaseOrder } from './office-lifecycle';
import { emptyClosedJobFilters, loadClosedJobs } from './closed-jobs';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { canTransition, currentRefusal, type Job } from '@/domain';

/**
 * THE OFFICE LIFECYCLE AFTER A TECHNICIAN SUBMITS. Issue #73, Batch 1.
 *
 *   technician submits -> Office Handling -> (handled) -> Awaiting PO
 *                      -> (invoice number) -> Invoiced
 *
 * Proved through the real operations: submission does not close the job, the
 * office's two steps are the office's alone, an invoice number is required and
 * persists, delivery moves nothing, and the signed record survives untouched.
 */
const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const EMAIL = 'customer@example-demo.co.za';

const codesOf = async (attempt: Promise<unknown>): Promise<readonly string[]> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof WorkflowError) return error.violations.map((violation) => violation.code);
    throw error;
  }
  throw new Error('expected a refusal');
};

/** INV-FLOW-1: an Awaiting PO job given its PO number, now Awaiting Invoice No. */
const withPo = (harness: Harness, job: Job, number = 'PO-TEST'): Promise<Job> =>
  recordPurchaseOrder(harness.as(master), job, number);

/**
 * A seeded job worked, signed and submitted. With NO PO by default — the
 * Awaiting PO path these tests walk; PO-FLOW-1 passes one.
 */
const submitted = async (harness: Harness, jobNumber = 'EJE-1048', orderNumber = ''): Promise<Job> => {
  const seeded = await harness.repos.jobs.findByJobNumber(jobNumber);
  const opened = await harness.repos.jobs.save({ ...seeded!, orderNumber });
  const context = harness.as(technician);
  let job = await acceptJob(context, opened);
  job = await addLabour(context, job, { date: '2026-10-20', rateType: 'normal', hours: 2, description: '' });
  job = await saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the coolant pump seal.',
  });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  job = await captureSignature(context, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });
  return (await issueJobCard(context, job, EMAIL, 'Pieter Nel')).job;
};

describe('a technician submission', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('enters Office Handling, and does NOT close the job', async () => {
    const job = await submitted(harness);
    expect(job.status).toBe('office_handling');
    expect(job.closedAt).toBeNull();
    expect(job.officeHandling).toBeNull();
    expect(job.invoice).toBeNull();
    // The signed job card, its signature and its document are all in place.
    expect(job.signature).not.toBeNull();
    expect(job.finalDocument).not.toBeNull();
    const stored = await harness.repos.jobs.findById(job.id);
    expect(stored?.status).toBe('office_handling');
  });

  it('tells the office it is waiting for them, in their Inbox', async () => {
    const job = await submitted(harness);
    for (const office of [master, coordinator]) {
      const notices = (await harness.repos.notifications.list(office.id)).filter(
        (notice) => notice.type === 'job_submitted' && notice.jobId === job.id,
      );
      expect(notices.length, office.id).toBeGreaterThan(0);
      expect(notices[0]?.handledAt).toBeNull();
      expect(notices[0]?.body).toMatch(/waiting for the office/);
    }
  });
});

describe('Office Handling -> Awaiting PO', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is done by the office, records who and when, and audits it', async () => {
    const job = await submitted(harness);
    const handled = await handleJobCard(harness.as(coordinator), job);

    expect(handled.status).toBe('awaiting_po');
    expect(handled.officeHandling?.handledBy).toBe(coordinator.id);
    expect(handled.officeHandling?.handledAt).toBeTruthy();
    expect((await harness.repos.jobs.findById(job.id))?.status).toBe('awaiting_po');

    const events = await harness.repos.activity.list(job.id);
    expect(events.some((event) => event.type === 'job_office_handled')).toBe(true);
  });

  it('files every office user’s job_submitted notice at once', async () => {
    const job = await submitted(harness);
    await handleJobCard(harness.as(master), job);
    for (const office of [master, coordinator]) {
      const open = (await harness.repos.notifications.list(office.id)).filter(
        (notice) => notice.type === 'job_submitted' && notice.jobId === job.id && notice.handledAt === null,
      );
      expect(open, office.id).toHaveLength(0);
    }
  });

  it('preserves the signed job card, its signature, its document and its history', async () => {
    const job = await submitted(harness);
    const before = await harness.repos.activity.list(job.id);
    const handled = await handleJobCard(harness.as(master), job);
    const invoiced = await recordInvoiceNumber(harness.as(master), await withPo(harness, handled), 'INV-1001');

    for (const after of [handled, invoiced]) {
      expect(after.signature).toEqual(job.signature);
      expect(after.finalDocument).toEqual(job.finalDocument);
      expect(after.completionReport).toEqual(job.completionReport);
      expect(after.labour).toEqual(job.labour);
      expect(after.pricingSnapshot).toEqual(job.pricingSnapshot);
    }
    const afterEvents = await harness.repos.activity.list(job.id);
    // Only added to: every earlier entry is still there.
    for (const event of before) expect(afterEvents.map((entry) => entry.id)).toContain(event.id);
  });

  it('is REFUSED to a technician, with nothing changed', async () => {
    const job = await submitted(harness);
    expect(await codesOf(handleJobCard(harness.as(technician), job))).toContain('not_permitted');
    expect((await harness.repos.jobs.findById(job.id))?.status).toBe('office_handling');
  });

  it('is refused on a job not waiting for the office', async () => {
    const job = await submitted(harness);
    const handled = await handleJobCard(harness.as(master), job);
    expect(await codesOf(handleJobCard(harness.as(master), handled))).toContain('not_in_office_handling');

    const open = await harness.repos.jobs.findByJobNumber('EJE-1052');
    expect(await codesOf(handleJobCard(harness.as(master), open!))).toContain('not_in_office_handling');
  });

  it('handles a LEGACY awaiting-delivery job the same way', async () => {
    const job = await submitted(harness);
    // As a job submitted before the office lifecycle would be stored.
    const legacy = await harness.repos.jobs.save({ ...job, status: 'awaiting_delivery' });
    const handled = await handleJobCard(harness.as(coordinator), legacy);
    expect(handled.status).toBe('awaiting_po');
  });

  it('leaves a historical Closed job alone — it is never reclassified', async () => {
    const job = await submitted(harness);
    const historical = await harness.repos.jobs.save({
      ...job,
      status: 'closed',
      closedAt: '2026-10-01T10:00:00.000Z',
    });
    expect(await codesOf(handleJobCard(harness.as(master), historical))).toContain('not_in_office_handling');
    expect(await codesOf(recordInvoiceNumber(harness.as(master), historical, 'INV-X'))).toContain(
      'not_awaiting_invoice_no',
    );
    const stored = await harness.repos.jobs.findById(job.id);
    expect(stored?.status).toBe('closed');
    expect(stored?.invoice).toBeNull();
  });
});

/*
 * INV-FLOW-1 (the tester, 2 November 2026): Handled → Awaiting PO → Awaiting
 * Invoice No → Invoiced. The PO number is mandatory to leave Awaiting PO and
 * cannot be skipped; an invoice number is not a substitute for it; the invoice
 * number is mandatory to reach Invoiced.
 */
describe('Awaiting PO -> Awaiting Invoice No, on the PO number', () => {
  let harness: Harness;
  let awaitingPo: Job;
  beforeEach(async () => {
    harness = buildHarness();
    awaitingPo = await handleJobCard(harness.as(master), await submitted(harness));
  });

  it('REFUSES an invoice number on Awaiting PO — the PO step cannot be skipped — and nothing changes', async () => {
    expect(await codesOf(recordInvoiceNumber(harness.as(master), awaitingPo, 'INV-1'))).toContain('po_number_required');
    const stored = await harness.repos.jobs.findById(awaitingPo.id);
    expect(stored?.status).toBe('awaiting_po');
    expect(stored?.invoice).toBeNull();
    expect(stored?.purchaseOrder).toBeNull();
  });

  it('REFUSES a blank, too-long or control-character PO number, and the job stays Awaiting PO', async () => {
    for (const bad of ['', '   ', '\t', 'X'.repeat(61), 'PO\n2']) {
      expect(await codesOf(recordPurchaseOrder(harness.as(coordinator), awaitingPo, bad))).toContain('po_number_required');
    }
    const stored = await harness.repos.jobs.findById(awaitingPo.id);
    expect(stored?.status).toBe('awaiting_po');
    expect(stored?.purchaseOrder).toBeNull();
  });

  it('moves to Awaiting Invoice No on a valid PO, which PERSISTS, trimmed, with who and when, audited', async () => {
    const next = await recordPurchaseOrder(harness.as(coordinator), awaitingPo, '  PO-4471 ');
    expect(next.status).toBe('awaiting_invoice_no');
    expect(next.purchaseOrder).toMatchObject({ number: 'PO-4471', recordedBy: coordinator.id });
    const stored = await harness.repos.jobs.findById(awaitingPo.id);
    expect(stored?.status).toBe('awaiting_invoice_no');
    expect(stored?.purchaseOrder?.number).toBe('PO-4471');
    expect(stored?.invoice).toBeNull();
    const events = await harness.repos.activity.list(awaitingPo.id);
    expect(events.some((event) => event.type === 'job_po_recorded' && /PO-4471/.test(event.summary))).toBe(true);
  });

  it('never replaces a recorded PO number, and refuses recording one twice', async () => {
    const next = await recordPurchaseOrder(harness.as(master), awaitingPo, 'PO-1');
    expect(await codesOf(recordPurchaseOrder(harness.as(master), next, 'PO-2'))).toContain('po_already_recorded');
    expect((await harness.repos.jobs.findById(awaitingPo.id))?.purchaseOrder?.number).toBe('PO-1');
  });

  it('is REFUSED to a technician', async () => {
    expect(await codesOf(recordPurchaseOrder(harness.as(technician), awaitingPo, 'PO-1'))).toContain('not_permitted');
    expect((await harness.repos.jobs.findById(awaitingPo.id))?.status).toBe('awaiting_po');
  });

  it('cannot skip Handled: a PO number before handling is refused', async () => {
    const fresh = buildHarness();
    const job = await submitted(fresh);
    expect(await codesOf(recordPurchaseOrder(fresh.as(master), job, 'PO-1'))).toContain('not_awaiting_po');
    expect((await fresh.repos.jobs.findById(job.id))?.status).toBe('office_handling');
  });
});

describe('Awaiting Invoice No -> Invoiced, on an invoice number', () => {
  let harness: Harness;
  let awaitingInvoice: Job;
  beforeEach(async () => {
    harness = buildHarness();
    awaitingInvoice = await withPo(harness, await handleJobCard(harness.as(master), await submitted(harness)), 'PO-7788');
  });

  it('REFUSES a save with no invoice number, and the job stays Awaiting Invoice No', async () => {
    for (const blank of ['', '   ', '\t']) {
      expect(await codesOf(recordInvoiceNumber(harness.as(coordinator), awaitingInvoice, blank))).toContain(
        'invoice_number_required',
      );
    }
    const stored = await harness.repos.jobs.findById(awaitingInvoice.id);
    expect(stored?.status).toBe('awaiting_invoice_no');
    expect(stored?.invoice).toBeNull();
  });

  it('refuses a number that is too long or carries control characters', async () => {
    expect(await codesOf(recordInvoiceNumber(harness.as(master), awaitingInvoice, 'X'.repeat(61)))).toContain('invoice_number_required');
    expect(await codesOf(recordInvoiceNumber(harness.as(master), awaitingInvoice, 'INV\n2'))).toContain('invoice_number_required');
    expect((await harness.repos.jobs.findById(awaitingInvoice.id))?.status).toBe('awaiting_invoice_no');
  });

  it('moves to Invoiced on a valid number, which PERSISTS, trimmed, with who and when — the PO kept', async () => {
    const invoiced = await recordInvoiceNumber(harness.as(coordinator), awaitingInvoice, '  INV-2026-0042 ');
    expect(invoiced.status).toBe('invoiced');
    expect(invoiced.invoice?.number).toBe('INV-2026-0042');
    expect(invoiced.invoice?.recordedBy).toBe(coordinator.id);
    expect(invoiced.purchaseOrder?.number).toBe('PO-7788');

    const stored = await harness.repos.jobs.findById(awaitingInvoice.id);
    expect(stored?.status).toBe('invoiced');
    expect(stored?.invoice?.number).toBe('INV-2026-0042');
    expect(stored?.purchaseOrder?.number).toBe('PO-7788');
    expect(stored?.closedAt).toBeNull();

    const events = await harness.repos.activity.list(awaitingInvoice.id);
    expect(events.some((event) => event.type === 'job_invoiced' && /INV-2026-0042/.test(event.summary))).toBe(true);
    // INVOICED-CLOSED-1: out of the active invoicing workflow entirely, and into Closed Jobs — the record whole.
    const queue = await loadOfficeQueue(harness.repos, master);
    expect(queue?.invoiced).toEqual([]);
    expect(queue?.awaitingInvoiceNo.map((row) => row.jobNumber)).not.toContain(awaitingInvoice.jobNumber);
    expect(queue?.awaitingPo.map((row) => row.jobNumber)).not.toContain(awaitingInvoice.jobNumber);
    expect(queue?.handling.map((row) => row.jobNumber)).not.toContain(awaitingInvoice.jobNumber);
    const closed = await loadClosedJobs(harness.repos, master, { ...emptyClosedJobFilters, outcome: 'invoiced' });
    const archived = closed.rows.find((entry) => entry.job.jobNumber === awaitingInvoice.jobNumber);
    expect(archived?.job.invoice?.number).toBe('INV-2026-0042');
    expect(archived?.job.purchaseOrder?.number).toBe('PO-7788');
    expect(archived?.job.finalDocument).not.toBeNull();
    // The full record (signature, pricing snapshot, history) is the stored job, unchanged by invoicing.
    expect((await harness.repos.jobs.findByJobNumber(awaitingInvoice.jobNumber))?.signature).not.toBeNull();
    expect((await harness.repos.jobs.findByJobNumber(awaitingInvoice.jobNumber))?.pricingSnapshot).not.toBeNull();
    // And not a Delivery Note.
    const notes = await loadClosedJobs(harness.repos, master, { ...emptyClosedJobFilters, outcome: 'delivery_note' });
    expect(notes.rows.some((entry) => entry.job.jobNumber === awaitingInvoice.jobNumber)).toBe(false);
  });

  it('never replaces a recorded invoice number, and records no second PO afterwards', async () => {
    const invoiced = await recordInvoiceNumber(harness.as(master), awaitingInvoice, 'INV-1');
    expect(await codesOf(recordInvoiceNumber(harness.as(master), invoiced, 'INV-2'))).toContain('already_invoiced');
    expect(await codesOf(recordPurchaseOrder(harness.as(master), invoiced, 'PO-NEW'))).toContain('po_already_recorded');
    expect((await harness.repos.jobs.findById(awaitingInvoice.id))?.invoice?.number).toBe('INV-1');
  });

  it('is REFUSED to a technician', async () => {
    expect(await codesOf(recordInvoiceNumber(harness.as(technician), awaitingInvoice, 'INV-1'))).toContain('not_permitted');
    expect((await harness.repos.jobs.findById(awaitingInvoice.id))?.status).toBe('awaiting_invoice_no');
  });

  it('cannot skip Handled: an invoice number before handling is refused', async () => {
    const fresh = buildHarness();
    const job = await submitted(fresh);
    expect(await codesOf(recordInvoiceNumber(fresh.as(master), job, 'INV-1'))).toContain('not_awaiting_invoice_no');
    expect((await fresh.repos.jobs.findById(job.id))?.status).toBe('office_handling');
  });
});

describe('a submitted job card stays read-only through the office lifecycle', () => {
  it('refuses a capture at every office step', async () => {
    const harness = buildHarness();
    const handling = await submitted(harness);
    const awaitingPo = await handleJobCard(harness.as(master), handling);
    const part = { partNumber: 'P-1', description: 'Seal', quantity: 1, unitPrice: 1000 };
    for (const job of [handling, awaitingPo]) {
      await expect(addPart(harness.as(master), job, part)).rejects.toBeInstanceOf(WorkflowError);
    }
    const awaitingInvoice = await withPo(harness, awaitingPo);
    expect(await codesOf(addLabour(harness.as(technician), awaitingInvoice, { date: '2026-10-21', rateType: 'normal', hours: 1, description: '' }))).not.toHaveLength(0);
    const invoiced = await recordInvoiceNumber(harness.as(master), awaitingInvoice, 'INV-7');
    await expect(addPart(harness.as(master), invoiced, part)).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('email delivery is separate, and moves nothing', () => {
  it('a confirmed delivery never closes the job or skips an office step', async () => {
    const harness = buildHarness();
    const job = await submitted(harness);
    harness.outbox.setDelivery(job.delivery!.messageId, 'delivered');

    const atHandling = await confirmJobCardDelivery(harness.as(master), job);
    expect(atHandling.status).toBe('office_handling');
    expect(atHandling.delivery?.state).toBe('delivered');

    const awaitingPo = await handleJobCard(harness.as(master), atHandling);
    expect((await confirmJobCardDelivery(harness.as(master), awaitingPo)).status).toBe('awaiting_po');

    const invoiced = await recordInvoiceNumber(harness.as(master), await withPo(harness, awaitingPo), 'INV-9');
    expect((await confirmJobCardDelivery(harness.as(master), invoiced)).status).toBe('invoiced');
    expect((await harness.repos.jobs.findById(job.id))?.closedAt).toBeNull();
  });
});

describe('the office queue behind the Notifications tabs', () => {
  it('lists jobs by their PERSISTED status, and is the office’s alone', async () => {
    const harness = buildHarness();
    const handling = await submitted(harness, 'EJE-1048');
    const queue = await loadOfficeQueue(harness.repos, master);
    expect(queue?.handling.map((row) => row.jobNumber)).toContain(handling.jobNumber);
    expect(queue?.awaitingPo.map((row) => row.jobNumber)).not.toContain(handling.jobNumber);

    const awaitingPo = await handleJobCard(harness.as(master), handling);
    const afterHandling = await loadOfficeQueue(harness.repos, coordinator);
    expect(afterHandling?.handling.map((row) => row.jobNumber)).not.toContain(handling.jobNumber);
    expect(afterHandling?.awaitingPo.map((row) => row.jobNumber)).toContain(handling.jobNumber);

    const awaitingInvoice = await withPo(harness, awaitingPo);
    const afterPo = await loadOfficeQueue(harness.repos, master);
    expect(afterPo?.awaitingPo.map((row) => row.jobNumber)).not.toContain(handling.jobNumber);
    expect(afterPo?.awaitingInvoiceNo.map((row) => row.jobNumber)).toContain(handling.jobNumber);
    await recordInvoiceNumber(harness.as(master), awaitingInvoice, 'INV-55');
    const afterInvoice = await loadOfficeQueue(harness.repos, master);
    expect(afterInvoice?.awaitingPo.map((row) => row.jobNumber)).not.toContain(handling.jobNumber);
    // INVOICED-CLOSED-1: invoiced leaves every queue list; Closed Jobs has it.
    expect(afterInvoice?.awaitingInvoiceNo.map((row) => row.jobNumber)).not.toContain(handling.jobNumber);
    expect(afterInvoice?.invoiced).toEqual([]);
    const closed = await loadClosedJobs(harness.repos, master, emptyClosedJobFilters);
    expect(closed.rows.find((entry) => entry.job.jobNumber === handling.jobNumber)?.job.invoice?.number).toBe('INV-55');

    expect(await loadOfficeQueue(harness.repos, technician)).toBeNull();
  });
});

/*
 * BD-22, DECIDED BY THE OWNER ON 25 OCTOBER 2026 (issue #73).
 *
 * A refusal resolved "Without Customer Signature" used to CLOSE the job, so an
 * unsigned job card never reached the office and was never invoiced. It must
 * now enter Office Handling and go Handled -> Awaiting PO -> Invoiced like any
 * submission — with the refusal, its resolution and the trail all kept.
 */
describe('BD-22: a refusal resolved Without Customer Signature goes to the office', () => {
  const REASON = 'The planner disputes the hours and will not sign.';

  const refused = async (harness: Harness): Promise<Job> => {
    // No PO when raised: this walks the Awaiting PO path (PO-FLOW-1).
    const seeded = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const opened = await harness.repos.jobs.save({ ...seeded!, orderNumber: '' });
    const context = harness.as(technician);
    let job = await acceptJob(context, opened);
    job = await addLabour(context, job, { date: '2026-10-20', rateType: 'normal', hours: 2, description: '' });
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the coolant pump seal.',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    return recordSignatureRefusal(context, job, { reason: REASON });
  };

  let harness: Harness;
  let resolved: Job;

  beforeEach(async () => {
    harness = buildHarness();
    resolved = await resolveSignatureRefusal(harness.as(coordinator), await refused(harness), 'Invoice to proceed.');
  });

  it('enters Office Handling and is NOT closed', async () => {
    expect(resolved.status).toBe('office_handling');
    expect(resolved.closedAt).toBeNull();
    const stored = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(stored?.status).toBe('office_handling');
    expect(stored?.closedAt).toBeNull();
    // And nothing in the state machine lets Review close a job directly.
    expect(canTransition('review', 'closed')).toBe(false);
  });

  it('keeps the exception: unsigned, the refusal and its resolution intact', () => {
    expect(resolved.signature).toBeNull();
    expect(resolved.finalDocument).not.toBeNull();
    const refusal = currentRefusal(resolved);
    expect(refusal?.reason).toBe(REASON);
    expect(refusal?.recordedBy).toBe(technician.id);
    expect(refusal?.resolution).toBe('issued_unsigned');
    expect(refusal?.resolvedBy).toBe(coordinator.id);
    expect(refusal?.resolutionNote).toBe('Invoice to proceed.');
  });

  it('keeps the audit history, and records a hand-over to the office, not a closure', async () => {
    const trail = await harness.repos.activity.list(resolved.id);
    const types = trail.map((entry) => entry.type);
    expect(types).toContain('customer_refused_to_sign');
    expect(types).toContain('signature_refusal_resolved');
    expect(types).toContain('job_submitted');
    expect(types).not.toContain('job_closed');
    // The hand-over is not recorded before the resolution that caused it.
    const at = (type: string) => trail.find((entry) => entry.type === type)!.occurredAt;
    expect(at('signature_refusal_resolved') <= at('job_submitted')).toBe(true);
  });

  it('is in the office queue, and goes Handled -> Awaiting PO -> Awaiting Invoice No -> Invoiced', async () => {
    const queue = await loadOfficeQueue(harness.repos, master);
    expect(queue?.handling.map((row) => row.jobNumber)).toContain('EJE-1048');

    // An invoice number before handling is refused: no office step is skipped.
    expect(await codesOf(recordInvoiceNumber(harness.as(master), resolved, 'INV-BD22'))).toContain(
      'not_awaiting_invoice_no',
    );

    const awaitingPo = await handleJobCard(harness.as(master), resolved);
    expect(awaitingPo.status).toBe('awaiting_po');
    expect(awaitingPo.officeHandling?.handledBy).toBe(master.id);

    expect(await codesOf(recordInvoiceNumber(harness.as(master), awaitingPo, 'INV-BD22'))).toContain('po_number_required');
    expect((await harness.repos.jobs.findByJobNumber('EJE-1048'))?.status).toBe('awaiting_po');
    const awaitingInvoice = await withPo(harness, awaitingPo, 'PO-BD22');
    expect(await codesOf(recordInvoiceNumber(harness.as(master), awaitingInvoice, '  '))).toContain('invoice_number_required');
    expect((await harness.repos.jobs.findByJobNumber('EJE-1048'))?.status).toBe('awaiting_invoice_no');

    const invoiced = await recordInvoiceNumber(harness.as(master), awaitingInvoice, 'INV-BD22');
    expect(invoiced.status).toBe('invoiced');
    expect(invoiced.invoice?.number).toBe('INV-BD22');
    expect(invoiced.closedAt).toBeNull();
    // Still the unsigned job card, with its refusal, at the end.
    expect(invoiced.signature).toBeNull();
    expect(currentRefusal(invoiced)?.resolution).toBe('issued_unsigned');
  });

  it('records no delivery for a customer copy that was never sent', async () => {
    const after = await confirmJobCardDelivery(harness.as(master), resolved);
    expect(after).toEqual(resolved);
  });
});

/*
 * OWNER DECISION, 25 OCTOBER 2026: invoice numbers need not be unique — one
 * Sage invoice may cover several job cards.
 */
describe('the same invoice number on more than one job card', () => {
  it('is accepted, and each job keeps its own record of it', async () => {
    const harness = buildHarness();
    const first = await withPo(harness, await handleJobCard(harness.as(master), await submitted(harness, 'EJE-1048')));
    // The second job only has to be Awaiting Invoice No: put a seeded one there directly.
    const seeded = await harness.repos.jobs.findByJobNumber('EJE-1061');
    const second = await harness.repos.jobs.save({
      ...seeded!,
      status: 'awaiting_invoice_no',
      officeHandling: { handledBy: master.id, handledAt: '2026-10-25T08:00:00.000Z' },
      purchaseOrder: { number: 'PO-SEEDED', recordedBy: master.id, recordedAt: '2026-10-25T09:00:00.000Z' },
    });

    const a = await recordInvoiceNumber(harness.as(master), first, 'INV-SHARED-7');
    const b = await recordInvoiceNumber(harness.as(coordinator), second, 'INV-SHARED-7');
    expect(a.status).toBe('invoiced');
    expect(b.status).toBe('invoiced');
    expect(a.invoice?.number).toBe('INV-SHARED-7');
    expect(b.invoice?.number).toBe('INV-SHARED-7');
    expect(b.invoice?.recordedBy).toBe(coordinator.id);
  });
});

describe('PO-FLOW-1: the stored PO decides whether a handled job waits for one', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('goes straight to Awaiting Invoice No when the job was raised with its PO, recording it once and auditing it', async () => {
    const job = await submitted(harness, 'EJE-1048', ' PO-RAISED-1 ');
    const handled = await handleJobCard(harness.as(master), job);
    expect(handled.status).toBe('awaiting_invoice_no');
    expect(handled.purchaseOrder?.number).toBe('PO-RAISED-1');
    expect(handled.purchaseOrder?.recordedBy).toBe(master.id);
    expect(handled.officeHandling?.handledBy).toBe(master.id);
    const trail = await harness.repos.activity.list(job.id);
    expect(trail.map((event) => event.type)).toEqual(expect.arrayContaining(['job_office_handled', 'job_po_recorded']));
    // A PO step is never offered twice.
    expect(await codesOf(recordPurchaseOrder(harness.as(master), handled, 'PO-OTHER'))).toContain('po_already_recorded');
    const invoiced = await recordInvoiceNumber(harness.as(master), handled, 'INV-PO-1');
    expect(invoiced.status).toBe('invoiced');
    expect(invoiced.purchaseOrder?.number).toBe('PO-RAISED-1');
  });

  it('uses a PO entered while handling, and refuses an unusable one with nothing changed', async () => {
    const job = await submitted(harness);
    expect(await codesOf(handleJobCard(harness.as(master), job, 'POX'))).toContain('po_number_invalid');
    expect((await harness.repos.jobs.findById(job.id))?.status).toBe('office_handling');
    const handled = await handleJobCard(harness.as(master), job, '  PO-DESK-2 ');
    expect(handled.status).toBe('awaiting_invoice_no');
    expect(handled.purchaseOrder?.number).toBe('PO-DESK-2');
  });

  it('waits in Awaiting PO with no PO or a whitespace-only one, and moves on when it arrives', async () => {
    const job = await submitted(harness, 'EJE-1048', '    ');
    const handled = await handleJobCard(harness.as(master), job, '   ');
    expect(handled.status).toBe('awaiting_po');
    expect(handled.purchaseOrder).toBeNull();
    const withOne = await recordPurchaseOrder(harness.as(master), handled, 'PO-LATE-3');
    expect(withOne.status).toBe('awaiting_invoice_no');
  });

  it('lets the office refuse an order number that is not a PO ("TBC"): it waits in Awaiting PO, and the real PO moves it on', async () => {
    const job = await submitted(harness, 'EJE-1048', 'TBC');
    const queue = await loadOfficeQueue(harness.repos, master);
    expect(queue?.handling.find((row) => row.jobNumber === 'EJE-1048')?.poOnHandling).toBe('TBC');
    const handled = await handleJobCard(harness.as(master), job, undefined, true);
    expect(handled.status).toBe('awaiting_po');
    expect(handled.purchaseOrder).toBeNull();
    const real = await recordPurchaseOrder(harness.as(master), handled, 'PO-REAL-5');
    expect(real.purchaseOrder?.number).toBe('PO-REAL-5');
    expect(real.orderNumber).toBe('TBC');
  });

  it('is refused to a technician, PO or not', async () => {
    const job = await submitted(harness, 'EJE-1048', 'PO-RAISED-4');
    expect(await codesOf(handleJobCard(harness.as(technician), job))).toContain('not_permitted');
    expect((await harness.repos.jobs.findById(job.id))?.status).toBe('office_handling');
  });

  it('the workflow allows Office Handling straight to Awaiting Invoice No, and nothing else new', () => {
    expect(canTransition('office_handling', 'awaiting_invoice_no')).toBe(true);
    expect(canTransition('office_handling', 'invoiced')).toBe(false);
    expect(canTransition('awaiting_po', 'invoiced')).toBe(false);
  });
});
