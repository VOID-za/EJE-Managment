import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE PARTS RULES, OVER THE REAL HTTP API. MASTER SCOPE CR-12.
 *
 * The screens no longer OFFER acceptance, assignment, labour, travel or a
 * call-out on a collection. That is not the same as refusing them, and this is
 * the file that proves the difference: every request below is one a person
 * with a terminal and a session cookie can make, and the server has to say no
 * to each of them whatever the browser was shown.
 */

const PARTS_JOB = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: null,
  jobType: 'parts',
  priority: 'urgent',
  scheduledDate: '2026-09-28',
  scheduledEndDate: null,
  orderNumber: 'PO-99777',
  referenceNumber: 'REF-1',
  faultDescription: 'Spindle spares for collection.',
  primaryTechnicianId: null,
  additionalTechnicianIds: [],
  courierCollection: true,
  deliveryNote: 'DN-1',
} as const;

const raise = (client: ApiTestClient, over: Record<string, unknown> = {}) =>
  client.post<Job>('/api/jobs', { ...PARTS_JOB, ...over });

describe('raising a collection over the API', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('opens at its close-out, with no technician, no date, no priority and no courier answer', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const response = await raise(master);

    expect(response.status).toBe(200);
    const job = response.data;
    expect(job.status).toBe('completion');
    expect(job.primaryTechnicianId).toBeNull();
    expect(job.acceptedAt).toBeNull();
    // Sent on the request, and decided by the server regardless.
    expect(job.scheduledDate).toBeNull();
    expect(job.priority).toBe('normal');
    expect(job.courierCollection).toBe(false);
  });

  it('lets a Coordinator raise one', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const response = await raise(coordinator, { orderNumber: 'PO-99778' });
    expect(response.status).toBe(200);
    expect(response.data.status).toBe('completion');
  });

  it('refuses one that names a technician', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technicianId = (await master.get<{ readonly users: readonly { id: string; role: string }[] }>(
      '/api/jobs/form',
    )).data.users.find((user) => user.role === 'technician')?.id;
    expect(technicianId).toBeDefined();

    const response = await raise(master, { primaryTechnicianId: technicianId });
    expect(response.status).toBe(422);
  });
});

describe('the server refuses field-service operations on a collection', () => {
  beforeEach(() => {
    startTestServer();
  });

  const collection = async (client: ApiTestClient): Promise<Job> => {
    const response = await raise(client, { orderNumber: `PO-${Math.floor(Math.random() * 100000)}` });
    expect(response.status).toBe(200);
    return response.data;
  };

  it('refuses acceptance — to the office and to a technician alike', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const job = await collection(master);

    expect((await master.post(`/api/jobs/${job.jobNumber}/accept`, {})).status).toBe(403);

    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    expect((await coordinator.post(`/api/jobs/${job.jobNumber}/accept`, {})).status).toBe(403);

    const technician = await signedInAs(DEMO_USERS.technician);
    const asTechnician = await technician.post(`/api/jobs/${job.jobNumber}/accept`, {});
    expect([403, 404]).toContain(asTechnician.status);
  });

  it('refuses assignment', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const job = await collection(master);
    const technicianId = (await master.get<{ readonly users: readonly { id: string; role: string }[] }>(
      '/api/jobs/form',
    )).data.users.find((user) => user.role === 'technician')?.id;

    const response = await master.post(`/api/jobs/${job.jobNumber}/assign_primary`, {
      technicianId,
    });
    expect(response.status).toBe(422);
  });

  it('refuses labour, travel and a call-out fee', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const job = await collection(master);

    const labour = await master.post(`/api/jobs/${job.jobNumber}/add_labour`, {
      date: '2026-09-28',
      rateType: 'normal',
      hours: 2,
      description: '',
    });
    expect(labour.status).toBe(422);

    const travel = await master.post(`/api/jobs/${job.jobNumber}/add_travel`, {
      date: '2026-09-28',
      kilometres: 40,
      description: '',
    });
    expect(travel.status).toBe(422);

    const callout = await master.post(`/api/jobs/${job.jobNumber}/set_callout`, { applied: true });
    expect(callout.status).toBe(422);
  });

  it('takes parts, which is what a collection is', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const job = await collection(master);

    const response = await master.post<Job>(`/api/jobs/${job.jobNumber}/add_part`, {
      partNumber: 'ENC-INC-1024',
      description: 'Incremental encoder',
      quantity: 2,
      unitPrice: 386_000,
    });
    expect(response.status).toBe(200);
    expect(response.data.parts).toHaveLength(1);
  });
});
