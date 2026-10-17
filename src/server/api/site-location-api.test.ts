import { beforeEach, describe, expect, it } from 'vitest';
import type { OutboxMessage } from '@/domain';
import { getServerRuntime } from '@/server/runtime';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE SITE-LOCATION OFFER, OVER THE REAL ROUTE. WHATSAPP-1.
 *
 * The flow a technician actually sees: accept a job, be asked *Send Site
 * Location?*, and answer. The application tests cover what the operation does;
 * this file covers the parts only the route can answer for, and each of them
 * was a real hole:
 *
 *   1. WHO MAY ASK. The route is reachable by anybody who can see the job, and
 *      the message is sent under EJE's WhatsApp account at EJE's cost. It now
 *      refuses anybody who is not a field technician ON this job — a
 *      Coordinator runs the office and does not attend machines, and a Master
 *      has the address on the screen in front of them.
 *   2. WHERE IT GOES. The body used to carry an optional `recipientMobile`,
 *      which made this a route for sending EJE-branded WhatsApp templates to
 *      any number somebody chose. The field is gone and the number comes from
 *      the actor's own account.
 *   3. WHAT IT CLAIMS. The answer says `queued`, because the message is written
 *      to the outbox with the request and handed to the provider afterwards.
 */
const NEW_JOB = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: 'machine-abc-lv40',
  jobType: 'breakdown',
  priority: 'urgent',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: 'PO-78500',
  referenceNumber: '',
  faultDescription: 'Spindle drive alarm.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
  readonly status: string;
}

interface SiteLocationBody {
  readonly queued: boolean;
  readonly navigationUrl: string;
  readonly configured: boolean;
  readonly failureReason: string | null;
}

const outbox = (): Promise<readonly OutboxMessage[]> =>
  getServerRuntime().read(({ repos }) => repos.outbox.list());

const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('asking for the site location after accepting a job', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let sipho: ApiTestClient;
  let riaan: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    const siphoId = await userId(master, DEMO_USERS.technician);
    job = (await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId }))
      .data;
    sipho = await signedInAs(DEMO_USERS.technician);
    riaan = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
  });

  const siteLocationsFor = async (): Promise<readonly OutboxMessage[]> =>
    (await outbox()).filter(
      (message) => message.jobId === job.id && message.template === 'eje_site_location',
    );

  /* -- the technician on the job ------------------------------------------- */

  it('queues one message to the technician’s own number, and says queued', async () => {
    const response = await sipho.post<SiteLocationBody>(`/api/jobs/${job.id}/send_site_location`);

    expect(response.status).toBe(200);
    expect(response.data.queued).toBe(true);
    expect(response.data.configured).toBe(true);
    expect(response.data.navigationUrl).toContain('google.com/maps');

    const queued = await siteLocationsFor();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.channel).toBe('whatsapp');
    // Sipho's seeded mobile number, from his account.
    expect(queued[0]?.recipient).toMatch(/\d/u);
    expect(queued[0]?.preview).toContain(job.jobNumber);
    expect(queued[0]?.preview).toContain('google.com/maps');
  });

  it('refuses a destination in the request body, rather than sending to it', async () => {
    /*
     * The field is gone from the schema, and the schema is `.strict()`, so a
     * request that carries one is refused outright instead of being honoured
     * or silently ignored. Nothing is queued.
     */
    const smuggled = await sipho.post(`/api/jobs/${job.id}/send_site_location`, {
      recipientMobile: '+27 82 000 0000',
    });

    expect(smuggled.status).toBe(400);
    expect(await siteLocationsFor()).toHaveLength(0);
  });

  it('records the decline without queuing anything', async () => {
    const declined = await sipho.post(`/api/jobs/${job.id}/decline_site_location`);

    expect(declined.status).toBe(200);
    expect(await siteLocationsFor()).toHaveLength(0);

    const view = await sipho.get<{ activity: readonly { type: string }[] }>(
      `/api/jobs/${job.jobNumber}`,
    );
    expect(view.data.activity.map((entry) => entry.type)).toContain('site_location_declined');
  });

  it('leaves the acceptance alone whatever happens to the message', async () => {
    await sipho.post(`/api/jobs/${job.id}/send_site_location`);

    const view = await sipho.get<{ view: { job: JobBody } }>(`/api/jobs/${job.jobNumber}`);
    expect(view.data.view.job.status).toBe('in_progress');
  });

  /* -- everybody else ------------------------------------------------------ */

  it('refuses a Coordinator: the office does not attend machines', async () => {
    const office = await coordinator.post(`/api/jobs/${job.id}/send_site_location`);

    expect(office.status).toBe(403);
    expect(JSON.stringify(office.raw)).toMatch(/not_field_technician/u);
    expect(await siteLocationsFor()).toHaveLength(0);
  });

  it('refuses a Master for the same reason', async () => {
    const office = await master.post(`/api/jobs/${job.id}/send_site_location`);

    expect(office.status).toBe(403);
    expect(await siteLocationsFor()).toHaveLength(0);
  });

  it('refuses a technician who is not on this job', async () => {
    const stranger = await riaan.post(`/api/jobs/${job.id}/send_site_location`);

    // 403 rather than 404: Riaan can see this job in the pool's history, so
    // the honest answer is that it is not his to ask about.
    expect([403, 404]).toContain(stranger.status);
    expect(await siteLocationsFor()).toHaveLength(0);
  });

  it('refuses a Coordinator declining it, too', async () => {
    // Both halves of the prompt are the technician's, so both are guarded.
    const office = await coordinator.post(`/api/jobs/${job.id}/decline_site_location`);
    expect(office.status).toBe(403);
  });

  it('refuses it with no session at all', async () => {
    const { ApiTestClient } = await import('@/test/api-harness');
    const stranger = await new ApiTestClient().post(`/api/jobs/${job.id}/send_site_location`);
    expect(stranger.status).toBe(401);
  });

  /* -- the message is drained after the response, not during it ------------ */

  it('hands the message to the provider AFTER the response, and records what it said', async () => {
    /*
     * `writeRoute` drains the outbox once the response has been decided, so by
     * the time a second request is made the first message has been attempted.
     * The row carries the provider's own id — the demonstration adapter's, in
     * this suite — and `pending` has become `sent`.
     */
    expect((await sipho.post(`/api/jobs/${job.id}/send_site_location`)).status).toBe(200);
    // Any later write drains what is still pending; a read would not.
    await sipho.post(`/api/jobs/${job.id}/add_note`, {
      body: 'On site, gate 4.',
      internal: true,
    });

    const queued = await siteLocationsFor();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.state).toBe('sent');
    expect(queued[0]?.providerMessageId).not.toBeNull();
    expect(queued[0]?.attempts).toBeGreaterThan(0);
  });
});
