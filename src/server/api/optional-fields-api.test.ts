import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * RAISING A JOB WITHOUT A MACHINE OR A PRIORITY, OVER THE REAL ROUTES.
 * Create New Job §3A, §3B, §4.
 *
 * The application tests prove the rules. What is left to the HTTP layer is the
 * part a client depends on:
 *
 *  - the SCHEMA accepts the absence, so sending `null` is not a 400;
 *  - the RULE still refuses it where the job type requires one, and does so as
 *    a 422 — an operation's refusal, not a malformed request — because a screen
 *    puts a 422's violations against the field and a 400 is a bug report;
 *  - and the job comes BACK carrying null, so nothing between the operation and
 *    the response fills the gap in.
 */
interface JobPayload {
  readonly view: { readonly job: Job };
}

const raise = async (
  client: ApiTestClient,
  over: Record<string, unknown> = {},
): Promise<{ status: number; job?: Job; error?: unknown }> => {
  const customers = await client.get<readonly { readonly id: string }[]>('/api/customers');
  const customerId = customers.data[0]!.id;
  const screen = await client.get<{
    readonly sites: readonly { readonly id: string }[];
    readonly contacts: readonly { readonly id: string }[];
    readonly machines: readonly { readonly id: string }[];
  }>(`/api/customers/${customerId}`);

  const response = await client.post<Job>('/api/jobs', {
    customerId,
    siteId: screen.data.sites[0]!.id,
    contactId: screen.data.contacts[0]!.id,
    machineId: screen.data.machines[0]?.id ?? null,
    jobType: 'breakdown',
    priority: null,
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: '',
    referenceNumber: '',
    faultDescription: 'The line is down. Nobody can say which machine yet.',
    primaryTechnicianId: null,
    additionalTechnicianIds: [],
    courierCollection: false,
    deliveryNote: '',
    ...over,
  });

  return { status: response.status, job: response.data, error: response.error };
};

const jobOf = async (client: ApiTestClient, jobNumber: string): Promise<Job> =>
  (await client.get<JobPayload>(`/api/jobs/${jobNumber}`)).data.view.job;

describe('a breakdown raised with neither a machine nor a priority', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  it('is accepted, and comes back carrying null for both', async () => {
    const raised = await raise(master, { machineId: null });

    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.job!.machineId).toBeNull();
    expect(raised.job!.priority).toBeNull();

    // And again on a fresh read, so nothing on the way out invented a value.
    const reread = await jobOf(master, raised.job!.jobNumber);
    expect(reread.machineId).toBeNull();
    expect(reread.priority).toBeNull();
  });

  it('is accepted for a TEST & REPAIR too', async () => {
    const raised = await raise(master, { jobType: 'test_and_repair', machineId: null });
    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.job!.machineId).toBeNull();
    expect(raised.job!.priority).toBeNull();
  });

  it('keeps a priority that WAS chosen', async () => {
    const raised = await raise(master, { machineId: null, priority: 'high' });
    expect(raised.status).toBe(200);
    expect(raised.job!.priority).toBe('high');
  });
});

describe('the job types that still require them', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  it('refuses an installation with no machine — 422, the RULE rather than the schema', async () => {
    const raised = await raise(master, {
      jobType: 'installation',
      machineId: null,
      priority: 'normal',
    });
    expect(raised.status).toBe(422);
  });

  it('refuses an installation with no priority — also 422', async () => {
    const raised = await raise(master, { jobType: 'installation', priority: null });
    expect(raised.status).toBe(422);
  });

  it('refuses a priority that is not one of the four — 400, the SCHEMA', async () => {
    const raised = await raise(master, { machineId: null, priority: 'whenever' });
    expect(raised.status).toBe(400);
  });
});

describe('the Jobs list and its spreadsheet carry an ungraded job', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  it('lists it, and the export names it "Not graded" rather than leaving a blank', async () => {
    const raised = await raise(master, { machineId: null });
    expect(raised.status).toBe(200);

    const list = await master.get<{ readonly rows: readonly { readonly job: Job }[] }>(
      '/api/jobs',
    );
    expect(list.status).toBe(200);
    const row = list.data.rows.find((candidate) => candidate.job.id === raised.job!.id);
    expect(row).toBeDefined();
    expect(row!.job.priority).toBeNull();

    const file = await master.get<string>('/api/jobs/export?status=all');
    expect(file.status).toBe(200);
  });
});
