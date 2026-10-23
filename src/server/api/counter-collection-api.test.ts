import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE COLLECTION ANSWER CANNOT BE SET EARLY BY A DIRECT REQUEST.
 * Job completion §6.
 *
 * Removing the tick box from the form is half the job; the owner asked for the
 * rule to be enforced server-side so a direct API request cannot set it early.
 * That is what these cases are: the HTTP surface, not the operation.
 *
 * A refusal of the OPERATION is a 422, which is the house convention — the
 * request is well formed and the rules say no.
 */
const jobOf = async (client: ApiTestClient, jobNumber: string): Promise<Job> =>
  (await client.get<{ view: { job: Job } }>(`/api/jobs/${jobNumber}`)).data.view.job;

describe('recording who is collecting, over the API', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  const raiseWorkshopJob = async (courierCollection: boolean) =>
    master.post<Job>('/api/jobs', {
      customerId: 'cust-abc',
      siteId: 'site-abc-jhb',
      contactId: 'contact-abc-jhb',
      machineId: 'machine-abc-lv40',
      jobType: 'test_and_repair',
      priority: null,
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: '',
      referenceNumber: '',
      faultDescription: '',
      primaryTechnicianId: null,
      additionalTechnicianIds: [],
      courierCollection,
      deliveryNote: '',
    });

  it('IGNORES a courier answer sent at creation, rather than storing it', async () => {
    const raised = await raiseWorkshopJob(true);

    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.data.courierCollection).toBe(false);

    // And on a fresh read, so nothing stored it quietly.
    const reread = await jobOf(master, raised.data.jobNumber);
    expect(reread.courierCollection).toBe(false);
  });

  it('REFUSES set_collection on a job that has only just been raised — 422', async () => {
    const raised = await raiseWorkshopJob(false);
    const response = await master.post(`/api/jobs/${raised.data.id}/set_collection`, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });

    expect(response.status).toBe(422);
    expect((response.error?.violations ?? []).map((v) => v.code)).toContain('job_not_completed');
  });

  it('leaves the job unchanged after that refusal', async () => {
    const raised = await raiseWorkshopJob(false);
    await master.post(`/api/jobs/${raised.data.id}/set_collection`, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });

    const after = await jobOf(master, raised.data.jobNumber);
    expect(after.courierCollection).toBe(false);
    expect(after.waybillNumber).toBe('');
  });

  it('REFUSES it on a breakdown, naming the job type rather than the stage', async () => {
    const job = await jobOf(master, 'EJE-1048');
    const response = await master.post(`/api/jobs/${job.id}/set_collection`, {
      courier: true,
      waybillNumber: 'DAW-1',
    });

    expect(response.status).toBe(422);
    expect((response.error?.violations ?? []).map((v) => v.code)).toContain('not_a_collection');
  });
});
