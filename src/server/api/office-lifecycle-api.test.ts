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
  orderNumber: 'PO-73001',
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
const submittedJob = async (master: ApiTestClient, tech: ApiTestClient): Promise<Job> => {
  const techId = await userId(master, DEMO_USERS.technician);
  const job = (await master.post<Job>('/api/jobs', { ...FIELD_JOB, primaryTechnicianId: techId })).data;
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

  it('handled -> Awaiting PO -> invoice number -> Invoiced, by the office', async () => {
    const job = await submittedJob(master, tech);

    const handled = await coordinator.post<Job>(`/api/jobs/${job.id}/handle_office`, {});
    expect(handled.status, JSON.stringify(handled.error)).toBe(200);
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_po');

    // Saving with no invoice number: refused, and the job stays Awaiting PO.
    const blank = await coordinator.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: '  ' });
    expect(blank.status).toBe(422);
    expect(codes(blank)).toContain('invoice_number_required');
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_po');

    const invoiced = await coordinator.post(`/api/jobs/${job.id}/record_invoice`, {
      invoiceNumber: 'INV-API-1',
    });
    expect(invoiced.status, JSON.stringify(invoiced.error)).toBe(200);
    const reread = await jobOf(master, job.jobNumber);
    expect(reread.status).toBe('invoiced');
    expect(reread.invoice?.number).toBe('INV-API-1');
    expect(reread.officeHandling).not.toBeNull();
  });

  it('refuses both office steps to a technician with a 403, and changes nothing', async () => {
    const job = await submittedJob(master, tech);
    expect((await tech.post(`/api/jobs/${job.id}/handle_office`, {})).status).toBe(403);
    await master.post(`/api/jobs/${job.id}/handle_office`, {});
    expect(
      (await tech.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: 'INV-X' })).status,
    ).toBe(403);
    expect((await jobOf(master, job.jobNumber)).status).toBe('awaiting_po');
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

  it('serves the five tabs’ jobs to the office, from the persisted status', async () => {
    const job = await submittedJob(master, tech);
    const queueOf = async (client: ApiTestClient) =>
      (await client.get<{ officeQueue: OfficeQueue | null }>('/api/notifications')).data.officeQueue;

    expect((await queueOf(master))?.handling.map((row) => row.jobNumber)).toContain(job.jobNumber);
    await master.post(`/api/jobs/${job.id}/handle_office`, {});
    expect((await queueOf(coordinator))?.awaitingPo.map((row) => row.jobNumber)).toContain(job.jobNumber);
    await master.post(`/api/jobs/${job.id}/record_invoice`, { invoiceNumber: 'INV-TAB-1' });
    const invoiced = (await queueOf(master))?.invoiced.find((row) => row.jobNumber === job.jobNumber);
    expect(invoiced?.invoice?.number).toBe('INV-TAB-1');

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
