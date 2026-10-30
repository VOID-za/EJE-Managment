import { beforeEach, describe, expect, it } from 'vitest';
import { businessToday } from '@/lib/business-time';
import { monthOfDate, previousMonth } from '@/lib/payroll-files';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE TESTER'S CHANGES OF 30 OCTOBER 2026, THROUGH THE REAL ROUTES. A screen
 * can hide a button; these are the answers a client gets without the screen.
 */
const MONTH = previousMonth(monthOfDate(businessToday()));

const idOf = async (client: ApiTestClient): Promise<string> =>
  (await client.get<{ user: { id: string } }>('/api/auth/me')).data.user.id;

const jobBody = async (client: ApiTestClient) => {
  const customers = (await client.get<readonly { customer?: { id: string }; id?: string }[]>('/api/customers')).data;
  const customerId = customers[0]?.customer?.id ?? customers[0]?.id ?? '';
  const detail = (await client.get<{ sites?: readonly { id: string }[]; contacts?: readonly { id: string }[]; machines?: readonly { id: string }[] }>(`/api/customers/${customerId}`)).data;
  return {
    customerId,
    siteId: detail.sites?.[0]?.id ?? '',
    contactId: detail.contacts?.[0]?.id ?? '',
    machineId: detail.machines?.[0]?.id ?? null,
    jobType: 'breakdown',
    priority: 'normal',
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: '',
    referenceNumber: '',
    faultDescription: 'Spindle will not start.',
    primaryTechnicianId: null,
    additionalTechnicianIds: [],
    courierCollection: false,
    deliveryNote: '',
  };
};

describe('the tester’s changes over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses a technician who tries to raise a job, whatever the screen shows; the office still may', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const body = await jobBody(coordinator);
    const refused = await technician.post('/api/jobs', body);
    expect(refused.status).toBe(403);
    const raised = await coordinator.post<{ jobNumber: string }>('/api/jobs', body);
    expect(raised.status, JSON.stringify(raised.error)).toBeLessThan(300);
  });

  it('lists every user’s availability for the Coordinator — names and availability only — and refuses a technician', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const staff = await coordinator.get<{ today: string; rows: readonly Record<string, unknown>[] }>('/api/staff');
    expect(staff.status).toBe(200);
    const roles = new Set(staff.data.rows.map((row) => row.role));
    expect([...roles].sort()).toEqual(['coordinator', 'master', 'technician']);
    for (const row of staff.data.rows) {
      // Not an account screen: nothing to sign in with, contact or change.
      expect(Object.keys(row).sort()).toEqual(['active', 'id', 'jobTitle', 'name', 'role', 'today', 'upcoming']);
    }
    expect((await (await signedInAs(DEMO_USERS.technician)).get('/api/staff')).status).toBe(403);
    expect((await (await signedInAs(DEMO_USERS.master)).get('/api/staff')).status).toBe(200);
  });

  it('shows EVERY user in the office’s month — Masters, Coordinators and Technicians — and who has submitted', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const before = await coordinator.get<{ rows: readonly { technician: { id: string; role: string }; submittedAt: string | null; status: string }[] }>(`/api/payroll/months/${MONTH}`);
    expect(before.status).toBe(200);
    const roles = new Set(before.data.rows.map((row) => row.technician.role));
    expect(roles.has('master') && roles.has('coordinator') && roles.has('technician')).toBe(true);

    // The Coordinator submits HER OWN month (My Monthly Forms), once.
    const me = await idOf(coordinator);
    const submitted = await coordinator.post(`/api/payroll/${me}/${MONTH}/submit`, { confirmUnrecorded: true });
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(200);
    expect((await coordinator.post(`/api/payroll/${me}/${MONTH}/submit`, { confirmUnrecorded: true })).status).toBe(422);

    const master = await signedInAs(DEMO_USERS.master);
    const after = await master.get<{ rows: readonly { technician: { id: string }; submittedAt: string | null; status: string; selectable: boolean }[] }>(`/api/payroll/months/${MONTH}`);
    const hers = after.data.rows.find((row) => row.technician.id === me);
    expect(hers?.submittedAt).not.toBeNull();
    expect(hers?.status).toBe('ready');
    expect(hers?.selectable).toBe(true);

    // And the Master may include her in a package: two one-page PDFs for her.
    const prepared = await master.post<{ package: { attachments: readonly { technicianId: string; pageCount: number }[] } }>(
      '/api/payroll/packages', { month: MONTH, technicianIds: [me] }, { idempotencyKey: 'tester-prepare-coordinator' },
    );
    expect(prepared.status, JSON.stringify(prepared.error)).toBe(200);
    expect(prepared.data.package.attachments.filter((attachment) => attachment.technicianId === me)).toHaveLength(2);
    expect(prepared.data.package.attachments.every((attachment) => attachment.pageCount === 1)).toBe(true);
  });

  it('keeps each person’s monthly history: their own, or the office’s view; never another technician’s', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const me = await idOf(technician);
    expect((await technician.get<readonly unknown[]>(`/api/payroll/${me}/history`)).data).toEqual([]);
    expect((await technician.post(`/api/payroll/${me}/${MONTH}/submit`, { confirmUnrecorded: true })).status).toBe(200);
    const history = await technician.get<readonly { month: string; fileNames: { attendance: string } }[]>(`/api/payroll/${me}/history`);
    expect(history.status).toBe(200);
    expect(history.data.map((entry) => entry.month)).toEqual([MONTH]);
    expect(history.data[0]?.fileNames.attendance).toMatch(/ ATTEN [A-Z]+\.pdf$/u);

    const other = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await other.get(`/api/payroll/${me}/history`)).status).toBe(403);
    expect((await (await signedInAs(DEMO_USERS.coordinator)).get(`/api/payroll/${me}/history`)).status).toBe(200);
  });

  it('carries a technician’s message to the office and the reply back, kept in the conversation; a stranger cannot read it', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const master = await signedInAs(DEMO_USERS.master);
    const started = await technician.post<{ conversation: { id: string } }>('/api/conversations', {
      recipientIds: [await idOf(master)],
      body: 'The spindle drive needs a new encoder.',
    });
    expect(started.status, JSON.stringify(started.error)).toBeLessThan(300);
    const id = started.data.conversation.id;
    const reply = await master.post(`/api/conversations/${id}/send`, { body: 'Ordered — it arrives Monday.' });
    expect(reply.status, JSON.stringify(reply.error)).toBeLessThan(300);

    const screen = await technician.get<{ thread: readonly { body: string }[] }>(`/api/conversations?conversationId=${id}`);
    expect(screen.status).toBe(200);
    expect(screen.data.thread.map((message) => message.body)).toEqual(['The spindle drive needs a new encoder.', 'Ordered — it arrives Monday.']);

    const stranger = await signedInAs(DEMO_USERS.otherTechnician);
    // Not found, not 403: a conversation one is not in is not confirmed to exist.
    expect((await stranger.post(`/api/conversations/${id}/send`, { body: 'I should not be here.' })).status).toBe(404);
    expect((await stranger.get(`/api/conversations?conversationId=${id}`)).status).toBe(404);
  });
});
