import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import type { OfficeQueue } from '@/application/office-lifecycle';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE OFFICE LIFECYCLE AND THE PARTS RULES, OVER THE REAL HTTP SURFACE.
 * Issue #73, Batches 1 and 2.
 *
 * What a browser — or an old client — can actually do: submit, handle, record
 * an invoice number; and what the server refuses whatever is sent.
 */
const FIELD_JOB = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: 'machine-abc-lv40',
  jobType: 'breakdown',
  priority: 'urgent',
  scheduledDate: null,
  scheduledEndDate: null,
  // No PO when raised: these tests walk the Awaiting PO path. PO-FLOW-1 below
  // raises jobs WITH one.
  orderNumber: '',
  referenceNumber: '',
  faultDescription: 'Coolant pump alarming.',
  additionalTechnicianIds: [],
  courierCollection: false,
  deliveryNote: '',
} as const;

const jobOf = async (client: ApiTestClient, jobNumber: string): Promise<Job> =>
  (await client.get<{ view: { job: Job } }>(`/api/jobs/${jobNumber}`)).data.view.job;

const codes = (response: { error?: unknown }): readonly string[] =>
  (
    (response.error as { violations?: readonly { code: string }[] } | undefined)?.violations ?? []
  ).map((violation) => violation.code);

const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

/** Raises, works, signs and submits a job through the real routes. */
const submittedJob = async (master: ApiTestClient, tech: ApiTestClient, orderNumber = ''): Promise<Job> => {
  const techId = await userId(master, DEMO_USERS.technician);
  const job = (await master.post<Job>('/api/jobs', { ...FIELD_JOB, orderNumber, primaryTechnicianId: techId })).data;
  expect((await tech.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
  await tech.post(`/api/jobs/${job.id}/add_labour`, {
    date: '2026-10-20',
    rateType: 'normal',
    hours: 1,
    description: '',
  });
  await tech.post(`/api/jobs/${job.id}/save_report`, {
    faultFindings: '',
    diagnosis: '',
    workPerformed: 'Replaced the coolant pump seal.',
    recommendations: '',
    generalNotes: '',
  });
  await tech.post(`/api/jobs/${job.id}/start_completion`);
  await tech.post(`/api/jobs/${job.id}/start_signature`);
  expect(
    (
      await tech.post(`/api/jobs/${job.id}/capture_signature`, {
        customerName: 'Pieter',
        customerSurname: 'Nel',
        strokeData: 'M0,0 L10,10',
      })
    ).status,
  ).toBe(200);
  const issued = await tech.post<Job>(`/api/jobs/${job.id}/issue`, {});
  expect(issued.status, JSON.stringify(issued.error)).toBe(200);
  return jobOf(master, job.jobNumber);
};

describe('the office lifecycle, over the API', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let tech: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    tech = await signedInAs(DEMO_USERS.technician);
  });

  it('a technician submission lands in Office Handling, not Closed', async () => {
    const job = await submittedJob(master, tech);
    expect(job.status).toBe('office_handling');
    expect(job.closedAt).toBeNull();
    expect(job.finalDocument).not.toBeNull();
    expect(job.signature).not.toBeNull();
  });

  it('handled -> Awaiting PO -> PO number -> Awaiting Invoice No -> invoice number -> Invoiced, by the office (INV-FLOW-1)', async () => {
    const job = await submittedJob(master, tech);

    const handled = await coordinator.post<Job>(`/api/jobs/${job.id}/handle_office`, {});
    expect(handled.status, JSON.stringify(handled.error)).toBe(200);
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_po');

    // An invoice number does not stand in for the PO: refused, and the job stays Awaiting PO.
    const skipped = await coordinator.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: 'INV-API-1' });
    expect(skipped.status).toBe(422);
    expect(codes(skipped)).toContain('po_number_required');
    // A blank PO is refused too.
    const blankPo = await coordinator.post(`/api/jobs/${job.id}/record_po`, { poNumber: '  ' });
    expect(blankPo.status).toBe(422);
    expect(codes(blankPo)).toContain('po_number_required');
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_po');

    const po = await coordinator.post(`/api/jobs/${job.id}/record_po`, { poNumber: 'PO-API-1' });
    expect(po.status, JSON.stringify(po.error)).toBe(200);
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_invoice_no');
    // A second PO is refused; the first stays.
    expect((await master.post(`/api/jobs/${job.id}/record_po`, { poNumber: 'PO-API-2' })).status).toBe(422);

    // Saving with no invoice number: refused, and the job stays Awaiting Invoice No.
    const blank = await coordinator.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: '  ' });
    expect(blank.status).toBe(422);
    expect(codes(blank)).toContain('invoice_number_required');
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_invoice_no');

    const invoiced = await coordinator.post(`/api/jobs/${job.id}/record_invoice`, {
      invoiceNumber: 'INV-API-1',
    });
    expect(invoiced.status, JSON.stringify(invoiced.error)).toBe(200);
    const reread = await jobOf(master, job.jobNumber);
    expect(reread.status).toBe('invoiced');
    expect(reread.invoice?.number).toBe('INV-API-1');
    expect(reread.purchaseOrder?.number).toBe('PO-API-1');
    expect(reread.officeHandling).not.toBeNull();
  });

  it('refuses both office steps to a technician with a 403, and changes nothing', async () => {
    const job = await submittedJob(master, tech);
    expect((await tech.post(`/api/jobs/${job.id}/handle_office`, {})).status).toBe(403);
    await master.post(`/api/jobs/${job.id}/handle_office`, {});
    expect((await tech.post(`/api/jobs/${job.id}/record_po`, { poNumber: 'PO-X' })).status).toBe(403);
    await master.post(`/api/jobs/${job.id}/record_po`, { poNumber: 'PO-X' });
    expect(
      (await tech.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: 'INV-X' })).status,
    ).toBe(403);
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_invoice_no');
  });

  it('refuses a body on handle_office, and a malformed invoice request, by schema', async () => {
    const job = await submittedJob(master, tech);
    expect((await master.post(`/api/jobs/${job.id}/handle_office`, { status: 'invoiced' })).status).toBe(400);
    await master.post(`/api/jobs/${job.id}/handle_office`, {});
    expect(
      (await master.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: 'INV', status: 'x' })).status,
    ).toBe(400);
  });

  it('a delivery confirmation from the outbox does not close or move the job', async () => {
    const job = await submittedJob(master, tech);
    const messageId = job.delivery?.messageId ?? '';
    expect(messageId).not.toBe('');
    const reported = await master.post(`/api/outbox/${messageId}/delivery`, { state: 'delivered' });
    expect(reported.status, JSON.stringify(reported.error)).toBe(200);
    const reread = await jobOf(master, job.jobNumber);
    expect(reread.status).toBe('office_handling');
    expect(reread.delivery?.state).toBe('delivered');
    expect(reread.closedAt).toBeNull();
  });

  it('serves the office tabs’ jobs to the office, from the persisted status', async () => {
    const job = await submittedJob(master, tech);
    const queueOf = async (client: ApiTestClient) =>
      (await client.get<{ officeQueue: OfficeQueue | null }>('/api/notifications')).data.officeQueue;

    expect((await queueOf(master))?.handling.map((row) => row.jobNumber)).toContain(job.jobNumber);
    await master.post(`/api/jobs/${job.id}/handle_office`, {});
    expect((await queueOf(coordinator))?.awaitingPo.map((row) => row.jobNumber)).toContain(job.jobNumber);
    await master.post(`/api/jobs/${job.id}/record_po`, { poNumber: 'PO-TAB-1' });
    expect((await queueOf(coordinator))?.awaitingInvoiceNo.map((row) => row.jobNumber)).toContain(job.jobNumber);
    await master.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: 'INV-TAB-1' });
    // INVOICED-CLOSED-1: out of the office queue, and into Closed Jobs with its PO and invoice number.
    expect((await queueOf(master))?.invoiced).toEqual([]);
    expect((await queueOf(master))?.awaitingInvoiceNo.map((row) => row.jobNumber)).not.toContain(job.jobNumber);
    const closed = await master.get<{ rows: readonly { job: { jobNumber: string; invoice: { number: string } | null; purchaseOrder: { number: string } | null } }[] }>('/api/jobs/closed?outcome=invoiced');
    expect(closed.status).toBe(200);
    const invoiced = closed.data.rows.find((row) => row.job.jobNumber === job.jobNumber);
    expect(invoiced?.job.invoice?.number).toBe('INV-TAB-1');
    expect(invoiced?.job.purchaseOrder?.number).toBe('PO-TAB-1');

    // A technician has no office tabs at all.
    expect(await queueOf(tech)).toBeNull();
  });
});

describe('a parts job, over the API', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  const raiseParts = async (): Promise<Job> => {
    const created = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType: 'parts',
      machineId: null,
      priority: null,
      faultDescription: '',
      orderNumber: 'PO-PARTS-73',
      primaryTechnicianId: null,
    });
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    await master.post(`/api/jobs/${created.data.id}/add_part`, {
      partNumber: 'ENC-1',
      description: 'Encoder',
      quantity: 1,
      unitPrice: 100_000,
    });
    return created.data;
  };

  it('refuses a write-up and a signature refusal, whatever a client sends', async () => {
    const job = await raiseParts();
    const report = await master.post(`/api/jobs/${job.id}/save_report`, {
      faultFindings: '',
      diagnosis: '',
      workPerformed: 'Handed over.',
      recommendations: '',
      generalNotes: '',
    });
    expect(report.status).toBe(422);
    expect(codes(report)).toContain('not_applicable_to_job_type');

    await master.post(`/api/jobs/${job.id}/start_signature`);
    const refusal = await master.post(`/api/jobs/${job.id}/record_refusal`, { reason: 'Wrong part.' });
    expect(refusal.status).toBe(422);
    expect(codes(refusal)).toContain('not_applicable_to_job_type');
    expect((await jobOf(master, job.jobNumber)).signatureRefusals).toHaveLength(0);
  });

  it('refuses labour, travel and a call-out fee', async () => {
    const job = await raiseParts();
    for (const [action, body] of [
      ['add_labour', { date: '2026-10-20', rateType: 'normal', hours: 1, description: '' }],
      ['add_travel', { date: '2026-10-20', kilometres: 10, description: '' }],
      ['set_callout', { applied: true }],
    ] as const) {
      const answer = await master.post(`/api/jobs/${job.id}/${action}`, body);
      expect(answer.status, action).toBe(422);
      expect(codes(answer), action).toContain('not_applicable_to_job_type');
    }
  });
});

/**
 * PO-FLOW-1 — THE JOB'S OWN PO DECIDES. A job raised with the customer's PO
 * (its customer order number) used to go to Awaiting PO anyway when the office
 * handled it. The server now reads the stored PO: with one, Handled goes
 * straight to Awaiting Invoice No and records it; without one, Awaiting PO.
 */
describe('PO-FLOW-1: handling a job that already has its PO', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('skips Awaiting PO when the PO was entered when the job was raised, and keeps it through to Invoiced', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const tech = await signedInAs(DEMO_USERS.technician);
    const job = await submittedJob(master, tech, '  PO-73001 ');
    expect(job.orderNumber.trim()).toBe('PO-73001');
    const handled = await master.post<Job>(`/api/jobs/${job.id}/handle_office`, {});
    expect(handled.status).toBe(200);
    const read = await jobOf(master, job.jobNumber);
    expect(read.status).toBe('awaiting_invoice_no');
    expect(read.purchaseOrder?.number).toBe('PO-73001');
    expect((await master.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: 'INV-1' })).status).toBe(200);
    const invoiced = await jobOf(master, job.jobNumber);
    expect(invoiced.status).toBe('invoiced');
    expect(invoiced.purchaseOrder?.number).toBe('PO-73001');
    expect(invoiced.orderNumber.trim()).toBe('PO-73001');
  });

  it('skips Awaiting PO when the office enters the PO while handling', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const tech = await signedInAs(DEMO_USERS.technician);
    const job = await submittedJob(master, tech);
    expect((await master.post(`/api/jobs/${job.id}/handle_office`, { poNumber: ' PO-HANDLED-9 ' })).status).toBe(200);
    const read = await jobOf(master, job.jobNumber);
    expect(read.status).toBe('awaiting_invoice_no');
    expect(read.purchaseOrder?.number).toBe('PO-HANDLED-9');
  });

  it('goes to Awaiting PO with no PO, or a whitespace-only one, and on when the PO is added later', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const tech = await signedInAs(DEMO_USERS.technician);
    const job = await submittedJob(master, tech, '   ');
    expect((await master.post(`/api/jobs/${job.id}/handle_office`, { poNumber: '  ' })).status).toBe(200);
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_po');
    expect((await master.post(`/api/jobs/${job.id}/record_po`, { poNumber: 'PO-LATER' })).status).toBe(200);
    const read = await jobOf(master, job.jobNumber);
    expect(read.status).toBe('awaiting_invoice_no');
    expect(read.purchaseOrder?.number).toBe('PO-LATER');
  });

  it('refuses an unusable PO typed while handling, and changes nothing', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const tech = await signedInAs(DEMO_USERS.technician);
    const job = await submittedJob(master, tech);
    const refused = await master.post(`/api/jobs/${job.id}/handle_office`, { poNumber: 'PO\nBAD' });
    expect(refused.status).toBe(422);
    expect(codes(refused)).toContain('po_number_invalid');
    expect((await jobOf(master, job.jobNumber)).status).toBe('office_handling');
  });

  it('is still the office’s alone', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const tech = await signedInAs(DEMO_USERS.technician);
    const job = await submittedJob(master, tech, 'PO-73001');
    const refused = await tech.post(`/api/jobs/${job.id}/handle_office`, {});
    expect(refused.status).not.toBe(200);
    expect((await jobOf(master, job.jobNumber)).status).toBe('office_handling');
  });
});
