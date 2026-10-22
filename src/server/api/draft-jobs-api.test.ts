import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import type { JobListRow } from '@/application/job-view';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * DRAFT JOBS OVER THE REAL ROUTES. DRAFT-1.
 *
 * What the HTTP layer adds to the application tests is the thing a screen can
 * never be trusted with: that a draft is ABSENT from the payload a Coordinator
 * is served, rather than merely unrendered — and that asking for it directly is
 * a 404 and not a 403, because refusing confirms it exists.
 */
interface JobsPayload {
  readonly rows: readonly JobListRow[];
}

const register = async (client: ApiTestClient) => {
  type CustomerEntry = {
    readonly customer?: { readonly id: string };
    readonly id?: string;
  };
  const customers = (await client.get<readonly CustomerEntry[]>('/api/customers')).data;
  const customerId = customers[0]?.customer?.id ?? customers[0]?.id ?? '';
  const detail = (
    await client.get<{
      readonly sites?: readonly { readonly id: string }[];
      readonly contacts?: readonly { readonly id: string }[];
      readonly machines?: readonly { readonly id: string }[];
    }>(`/api/customers/${customerId}`)
  ).data;
  return {
    customerId,
    siteId: detail.sites?.[0]?.id ?? '',
    contactId: detail.contacts?.[0]?.id ?? '',
    machineId: detail.machines?.[0]?.id ?? null,
  };
};

const body = (ids: Awaited<ReturnType<typeof register>>, over: Record<string, unknown> = {}) => ({
  ...ids,
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
  ...over,
});

describe('a draft job over the API', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let technician: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  const draft = async (over: Record<string, unknown> = {}) => {
    const ids = await register(master);
    return master.post<Job>('/api/jobs', body(ids, { ...over, asDraft: true }));
  };

  it('is created at `draft` by a Master', async () => {
    const created = await draft();
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    expect(created.data.status).toBe('draft');
  });

  it('is REFUSED to a Coordinator, who may otherwise raise any job', async () => {
    const ids = await register(coordinator);
    const refused = await coordinator.post('/api/jobs', body(ids, { asDraft: true }));

    // 403: permanent for this actor, which is the API's own convention.
    expect(refused.status).toBe(403);

    // AND THE ORDINARY ROUTE STILL WORKS, so the refusal is about drafting and
    // not about the Coordinator raising jobs.
    const raised = await coordinator.post<Job>('/api/jobs', body(ids));
    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.data.status).toBe('open');
  });

  it('is ABSENT from the Coordinator’s payload, not merely unrendered', async () => {
    const created = await draft();
    const rows = (await coordinator.get<JobsPayload>('/api/jobs')).data.rows;

    expect(rows.some((row) => row.job.id === created.data.id)).toBe(false);
    // Asserted against the BYTES, because a row filtered by a component is a
    // row that still reached the browser.
    expect(JSON.stringify(rows)).not.toContain(created.data.jobNumber);
  });

  it('answers 404 to a Coordinator asking for it directly', async () => {
    // Not 403. Refusing confirms it exists, which is the one thing a hidden
    // record must not do.
    const created = await draft();
    const asked = await coordinator.get(`/api/jobs/${created.data.jobNumber}`);
    expect(asked.status).toBe(404);
  });

  it('answers 404 to the TECHNICIAN named on it', async () => {
    const created = await draft({ primaryTechnicianId: null });
    const asked = await technician.get(`/api/jobs/${created.data.jobNumber}`);
    expect(asked.status).toBe(404);
  });

  it('may be saved with no fault description and no machine', async () => {
    const created = await draft({ faultDescription: '', machineId: null });
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    expect(created.data.faultDescription).toBe('');
  });

  it('is released by a Master, and refused to a Coordinator', async () => {
    const created = await draft();

    const refused = await coordinator.post(`/api/jobs/${created.data.id}/release_draft`, {});
    // 404, because the Coordinator cannot see the draft at all — the
    // visibility check at the boundary runs before the operation's own rule.
    expect(refused.status).toBe(404);

    const released = await master.post<Job>(`/api/jobs/${created.data.id}/release_draft`, {});
    expect(released.status, JSON.stringify(released.error)).toBe(200);
    expect(released.data.status).toBe('open');
  });

  it('refuses a release that would produce an incomplete job', async () => {
    const created = await draft({ faultDescription: '', machineId: null });
    const released = await master.post(`/api/jobs/${created.data.id}/release_draft`, {});

    expect(released.status).toBe(422);
    expect(JSON.stringify(released.error)).toMatch(/fault_description_required|machine_required/u);
  });

  it('refuses a body on the release, because that would be an edit', async () => {
    const created = await draft();
    const released = await master.post(`/api/jobs/${created.data.id}/release_draft`, {
      faultDescription: 'Typed at release time',
    });
    expect(released.status).toBe(400);
  });
});
