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
import { handleJobCard, loadOfficeQueue, recordInvoiceNumber } from './office-lifecycle';
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

const submitted = async (harness: Harness, jobNumber = 'EJE-1048'): Promise<Job> => {
  const opened = await harness.repos.jobs.findByJobNumber(jobNumber);
  const context = harness.as(technician);
  let job = await acceptJob(context, opened!);
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
    const invoiced = await recordInvoiceNumber(harness.as(master), handled, 'INV-1001');

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
      'not_awaiting_po',
    );
    const stored = await harness.repos.jobs.findById(job.id);
    expect(stored?.status).toBe('closed');
    expect(stored?.invoice).toBeNull();
  });
});

describe('Awaiting PO -> Invoiced, on an invoice number', () => {
  let harness: Harness;
  let awaitingPo: Job;
  beforeEach(async () => {
    harness = buildHarness();
    awaitingPo = await handleJobCard(harness.as(master), await submitted(harness));
  });

  it('REFUSES a save with no invoice number, and the job stays Awaiting PO', async () => {
    for (const blank of ['', '   ', '\t']) {
      expect(await codesOf(recordInvoiceNumber(harness.as(coordinator), awaitingPo, blank))).toContain(
        'invoice_number_required',
      );
    }
    const stored = await harness.repos.jobs.findById(awaitingPo.id);
    expect(stored?.status).toBe('awaiting_po');
    expect(stored?.invoice).toBeNull();
  });

  it('refuses a number that is too long or carries control characters', async () => {
    expect(
      await codesOf(recordInvoiceNumber(harness.as(master), awaitingPo, 'X'.repeat(61))),
    ).toContain('invoice_number_required');
    expect(
      await codesOf(recordInvoiceNumber(harness.as(master), awaitingPo, 'INV\n2')),
    ).toContain('invoice_number_required');
    expect((await harness.repos.jobs.findById(awaitingPo.id))?.status).toBe('awaiting_po');
  });

  it('moves to Invoiced on a valid number, which PERSISTS, trimmed, with who and when', async () => {
    const invoiced = await recordInvoiceNumber(harness.as(coordinator), awaitingPo, '  INV-2026-0042 ');
    expect(invoiced.status).toBe('invoiced');
    expect(invoiced.invoice?.number).toBe('INV-2026-0042');
    expect(invoiced.invoice?.recordedBy).toBe(coordinator.id);

    const stored = await harness.repos.jobs.findById(awaitingPo.id);
    expect(stored?.status).toBe('invoiced');
    expect(stored?.invoice?.number).toBe('INV-2026-0042');
    expect(stored?.closedAt).toBeNull();

    const events = await harness.repos.activity.list(awaitingPo.id);
    expect(events.some((event) => event.type === 'job_invoiced' && /INV-2026-0042/.test(event.summary))).toBe(true);
  });

  it('never replaces a recorded invoice number', async () => {
    const invoiced = await recordInvoiceNumber(harness.as(master), awaitingPo, 'INV-1');
    expect(await codesOf(recordInvoiceNumber(harness.as(master), invoiced, 'INV-2'))).toContain(
      'already_invoiced',
    );
    expect((await harness.repos.jobs.findById(awaitingPo.id))?.invoice?.number).toBe('INV-1');
  });

  it('is REFUSED to a technician', async () => {
    expect(await codesOf(recordInvoiceNumber(harness.as(technician), awaitingPo, 'INV-1'))).toContain(
      'not_permitted',
    );
    expect((await harness.repos.jobs.findById(awaitingPo.id))?.status).toBe('awaiting_po');
  });

  it('cannot skip Handled: an invoice number before handling is refused', async () => {
    const fresh = buildHarness();
    const job = await submitted(fresh);
    expect(await codesOf(recordInvoiceNumber(fresh.as(master), job, 'INV-1'))).toContain('not_awaiting_po');
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
    const invoiced = await recordInvoiceNumber(harness.as(master), awaitingPo, 'INV-7');
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

    const invoiced = await recordInvoiceNumber(harness.as(master), awaitingPo, 'INV-9');
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

    await recordInvoiceNumber(harness.as(master), awaitingPo, 'INV-55');
    const afterInvoice = await loadOfficeQueue(harness.repos, master);
    expect(afterInvoice?.awaitingPo.map((row) => row.jobNumber)).not.toContain(handling.jobNumber);
    const row = afterInvoice?.invoiced.find((entry) => entry.jobNumber === handling.jobNumber);
    expect(row?.invoice?.number).toBe('INV-55');

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
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const context = harness.as(technician);
    let job = await acceptJob(context, opened!);
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

  it('is in the office queue, and goes Handled -> Awaiting PO -> Invoiced', async () => {
    const queue = await loadOfficeQueue(harness.repos, master);
    expect(queue?.handling.map((row) => row.jobNumber)).toContain('EJE-1048');

    // An invoice number before handling is refused: no office step is skipped.
    expect(await codesOf(recordInvoiceNumber(harness.as(master), resolved, 'INV-BD22'))).toContain(
      'not_awaiting_po',
    );

    const awaitingPo = await handleJobCard(harness.as(master), resolved);
    expect(awaitingPo.status).toBe('awaiting_po');
    expect(awaitingPo.officeHandling?.handledBy).toBe(master.id);

    expect(await codesOf(recordInvoiceNumber(harness.as(master), awaitingPo, '  '))).toContain(
      'invoice_number_required',
    );
    expect((await harness.repos.jobs.findByJobNumber('EJE-1048'))?.status).toBe('awaiting_po');

    const invoiced = await recordInvoiceNumber(harness.as(master), awaitingPo, 'INV-BD22');
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
    const first = await handleJobCard(harness.as(master), await submitted(harness, 'EJE-1048'));
    // The second job only has to be Awaiting PO: put a seeded one there directly.
    const seeded = await harness.repos.jobs.findByJobNumber('EJE-1061');
    const second = await harness.repos.jobs.save({
      ...seeded!,
      status: 'awaiting_po',
      officeHandling: { handledBy: master.id, handledAt: '2026-10-25T08:00:00.000Z' },
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
