import { beforeEach, describe, expect, it } from 'vitest';
import {
  ApiTestClient,
  DEMO_USERS,
  signedInAs,
  startTestServer,
  type ApiResponse,
} from '@/test/api-harness';

/**
 * Job creation, assignment and acceptance, over the real HTTP surface.
 *
 * WHAT THESE ADD to the application tests. Those prove the rules; these prove
 * the rules are reachable ONLY through them. Every request here is one a
 * `curl` could make: there is no screen in the path, no dropdown constraining
 * what was sent, and nothing in the client deciding who the actor is. If a
 * restriction lives in the UI, these are where that shows.
 */
interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
  readonly status: string;
  readonly acceptedAt: string | null;
  readonly primaryTechnicianId: string | null;
  readonly additionalTechnicianIds: readonly string[];
  readonly contactId: string;
  readonly createdBy: string;
  readonly attachments: readonly { readonly fileName: string }[];
}

const VALID = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: 'machine-abc-lv40',
  jobType: 'breakdown',
  priority: 'urgent',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: 'PO-99500',
  referenceNumber: '',
  faultDescription: 'Coolant pump alarming on low flow.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

const create = (client: ApiTestClient, over: Record<string, unknown> = {}) =>
  client.post<JobBody>('/api/jobs', { ...VALID, ...over });

const codes = (response: ApiResponse<unknown>): readonly string[] =>
  (response.error?.violations ?? []).map((violation) => violation.code);

describe('raising a job over the API', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses an unauthenticated request', async () => {
    const response = await create(new ApiTestClient());
    expect(response.status).toBe(401);
  });

  it('lets a Master raise one', async () => {
    const response = await create(await signedInAs(DEMO_USERS.master));

    expect(response.status).toBe(200);
    expect(response.data.status).toBe('open');
    // Created is not started.
    expect(response.data.acceptedAt).toBeNull();
  });

  it('lets a Coordinator raise one', async () => {
    expect((await create(await signedInAs(DEMO_USERS.coordinator))).status).toBe(200);
  });

  it('refuses a technician raising one, whatever the UI would have shown them', async () => {
    const response = await create(await signedInAs(DEMO_USERS.technician));

    expect(response.status).toBe(403);
    expect(response.error?.code).toBe('forbidden');
  });

  it('stamps createdBy from the SESSION, not from the request', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const me = await master.get<{ user: { id: string } }>('/api/auth/me');

    const response = await create(master);
    expect(response.data.createdBy).toBe(me.data.user.id);
  });

  it('rejects a request that tries to set a server-owned field', async () => {
    const master = await signedInAs(DEMO_USERS.master);

    // The schema is strict, so these are refused as malformed rather than
    // silently dropped — which is what tells a client it got something wrong.
    for (const forged of [
      { status: 'in_progress' },
      { createdBy: 'somebody-else' },
      { createdAt: '2020-01-01T00:00:00.000Z' },
      { acceptedAt: '2020-01-01T00:00:00.000Z' },
      { jobNumber: 'EJE-0001' },
      { pricingSnapshot: { calloutFee: 0 } },
    ]) {
      const response = await create(master, forged);
      expect(response.status).toBe(400);
    }
  });
});

describe('the register relationships, over the API', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses a site belonging to another customer', async () => {
    const response = await create(await signedInAs(DEMO_USERS.master), {
      siteId: 'site-kruger-main',
      machineId: null,
      jobType: 'parts',
      orderNumber: 'PO-99501',
    });

    expect(response.status).toBe(422);
    expect(codes(response)).toContain('site_not_of_customer');
  });

  it('refuses a machine belonging to another customer', async () => {
    const response = await create(await signedInAs(DEMO_USERS.master), {
      machineId: 'machine-kruger-vf2',
    });

    expect(response.status).toBe(422);
    expect(codes(response)).toContain('machine_not_of_customer');
  });

  it('refuses a recipient at another customer', async () => {
    const response = await create(await signedInAs(DEMO_USERS.master), {
      contactId: 'contact-kruger-main',
    });

    expect(response.status).toBe(422);
    expect(codes(response)).toContain('contact_not_of_customer');
  });

  it('refuses a blank fault description as a malformed request', async () => {
    const response = await create(await signedInAs(DEMO_USERS.master), { faultDescription: '  ' });
    expect(response.status).toBe(400);
  });

  it('refuses a technician who does not do field work', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const admin = await master.get<{ users: readonly { id: string; email: string }[] }>(
      '/api/admin',
    );
    const office = admin.data.users.find((user) => user.email === DEMO_USERS.coordinator);

    const response = await create(master, { primaryTechnicianId: office?.id });
    expect(response.status).toBe(422);
    expect(codes(response)).toContain('not_a_field_technician');
  });
});

describe('assignment and acceptance, over the API', () => {
  let master: ApiTestClient;
  let siphoId: string;
  let riaanId: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const admin = await master.get<{ users: readonly { id: string; email: string }[] }>(
      '/api/admin',
    );
    siphoId = admin.data.users.find((user) => user.email === DEMO_USERS.technician)?.id ?? '';
    riaanId = admin.data.users.find((user) => user.email === DEMO_USERS.otherTechnician)?.id ?? '';
    expect(siphoId).not.toBe('');
    expect(riaanId).not.toBe('');
  });

  it('assigns at creation, with assistants', async () => {
    const response = await create(master, {
      primaryTechnicianId: siphoId,
      additionalTechnicianIds: [riaanId],
    });

    expect(response.status).toBe(200);
    expect(response.data.primaryTechnicianId).toBe(siphoId);
    expect(response.data.additionalTechnicianIds).toEqual([riaanId]);
  });

  it('raises a notification the technician can actually read', async () => {
    const created = await create(master, { primaryTechnicianId: siphoId });

    const sipho = await signedInAs(DEMO_USERS.technician);
    const inbox = await sipho.get<{
      notifications: readonly { jobId: string | null; type: string }[];
    }>('/api/notifications');

    expect(inbox.status).toBe(200);
    expect(
      inbox.data.notifications.some(
        (item) => item.jobId === created.data.id && item.type === 'job_assigned',
      ),
    ).toBe(true);
  });

  it('refuses a technician assigning work to anybody, including themselves', async () => {
    const created = await create(master);
    const sipho = await signedInAs(DEMO_USERS.technician);

    const response = await sipho.post(`/api/jobs/${created.data.id}/assign_primary`, {
      technicianId: siphoId,
    });
    expect(response.status).toBe(403);
  });

  it('refuses one technician reassigning another technician’s job', async () => {
    // The direct-API version of "arbitrary authenticated user cannot modify
    // another user's assignment".
    const created = await create(master, { primaryTechnicianId: siphoId });
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);

    const response = await riaan.post(`/api/jobs/${created.data.id}/assign_primary`, {
      technicianId: riaanId,
    });
    // 404, not 403: a job he may not see does not exist as far as he is
    // concerned, and saying "forbidden" would confirm that it does.
    expect(response.status).toBe(404);
  });

  it('lets the assigned technician accept, which starts the job', async () => {
    const created = await create(master, { primaryTechnicianId: siphoId });
    const sipho = await signedInAs(DEMO_USERS.technician);

    const accepted = await sipho.post<JobBody>(`/api/jobs/${created.data.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.data.status).toBe('in_progress');
    expect(accepted.data.acceptedAt).not.toBeNull();
  });

  it('refuses a technician accepting a job assigned to somebody else', async () => {
    const created = await create(master, { primaryTechnicianId: siphoId });
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);

    expect((await riaan.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(404);
  });

  it('refuses a Coordinator accepting field work', async () => {
    const created = await create(master, { orderNumber: 'PO-99510' });
    const coordinator = await signedInAs(DEMO_USERS.coordinator);

    const response = await coordinator.post(`/api/jobs/${created.data.id}/accept`);
    expect(response.status).toBe(403);
    expect(codes(response)).toContain('not_field_technician');
  });

  it('refuses a second acceptance rather than repeating its side effects', async () => {
    const created = await create(master, { primaryTechnicianId: siphoId });
    const sipho = await signedInAs(DEMO_USERS.technician);

    expect((await sipho.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(200);

    const again = await sipho.post<JobBody>(`/api/jobs/${created.data.id}/accept`);
    // The state machine refuses it: in_progress has no edge back to itself.
    expect(again.status).toBe(422);
  });

  it('replays a repeated acceptance under one idempotency key, performing it once', async () => {
    const created = await create(master, { primaryTechnicianId: siphoId });
    const sipho = await signedInAs(DEMO_USERS.technician);
    const key = 'accept-once-4f2b';

    const first = await sipho.post<JobBody>(`/api/jobs/${created.data.id}/accept`, undefined, {
      idempotencyKey: key,
    });
    const retry = await sipho.post<JobBody>(`/api/jobs/${created.data.id}/accept`, undefined, {
      idempotencyKey: key,
    });

    expect(first.status).toBe(200);
    // The retry of a dropped connection gets the same answer, not a refusal —
    // and, crucially, does not accept the job a second time.
    expect(retry.status).toBe(200);
    expect(retry.data.acceptedAt).toBe(first.data.acceptedAt);
  });

  it('refuses a creation request that tries to name attachments', async () => {
    /*
     * A document is bytes, and this request carries none.
     *
     * Accepting a list of file names would record attachments pointing at
     * nothing. The schema is strict, so a client still sending them is told so
     * rather than having them quietly dropped — attachments go up to
     * `POST /api/jobs/:id/attachments`, which stores the bytes first.
     */
    const response = await create(master, {
      attachments: [{ fileName: 'order.pdf', contentType: 'application/pdf', sizeBytes: 10 }],
    });

    expect(response.status).toBe(400);
  });

});

/**
 * What the technician is handed once the job is theirs.
 *
 * The workflow requires the address and the contact to be there — a technician
 * who has accepted a breakdown has to be able to drive to it and ring somebody
 * on arrival.
 */
describe('the accepted job, as the technician reads it', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('carries the site address and the contact', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const admin = await master.get<{ users: readonly { id: string; email: string }[] }>(
      '/api/admin',
    );
    const siphoId = admin.data.users.find((user) => user.email === DEMO_USERS.technician)?.id ?? '';

    const created = await create(master, { primaryTechnicianId: siphoId });
    const sipho = await signedInAs(DEMO_USERS.technician);
    await sipho.post(`/api/jobs/${created.data.id}/accept`);

    const view = await sipho.get<{
      view: {
        site: { addressLine1: string; city: string };
        contact: { email: string; phone: string } | null;
        customer: { name: string; paymentTerms: string };
      };
    }>(`/api/jobs/${created.data.jobNumber}`);

    expect(view.status).toBe(200);
    expect(view.data.view.site.addressLine1.length).toBeGreaterThan(0);
    expect(view.data.view.contact?.phone.length).toBeGreaterThan(0);
    // The confirmed customer visibility rule, still holding on this path.
    expect(view.data.view.customer.paymentTerms.length).toBeGreaterThan(0);
  });
});
