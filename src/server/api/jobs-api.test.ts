import { beforeEach, describe, expect, it } from 'vitest';
import type { JobListRow } from '@/application/job-view';
import { asUserId, JOB_STATUS_ORDER, type Job } from '@/domain';
import {
  DEMO_USERS,
  signedInAs,
  startTestServer,
  type ApiTestClient,
} from '@/test/api-harness';

interface JobsPayload {
  readonly rows: readonly JobListRow[];
}

interface JobViewPayload {
  readonly view: { readonly job: Job };
  readonly users: readonly { readonly id: string }[];
}

const jobsFor = async (client: ApiTestClient): Promise<readonly JobListRow[]> =>
  (await client.get<JobsPayload>('/api/jobs')).data.rows;

/**
 * The finished work a technician can reach, by the route they actually reach it.
 *
 * The operational Jobs list is CURRENT work — closed and cancelled jobs are not
 * in it. Historical work is reached the way Decision 5 describes it:
 * Customers -> customer -> machine -> history. These tests used to discover a
 * closed job through `/api/jobs`, which worked only because that list carried
 * every job ever raised; discovering it here keeps the tests honest about the
 * path a technician has.
 */
const historyFor = async (client: ApiTestClient): Promise<readonly JobListRow[]> => {
  type CustomerEntry = { readonly customer?: { readonly id: string }; readonly id?: string };
  const customers = (await client.get<readonly CustomerEntry[]>('/api/customers')).data;

  const rows: JobListRow[] = [];
  for (const entry of customers) {
    const customerId = entry.customer?.id ?? entry.id;
    if (customerId === undefined) continue;
    const record = await client.get<{ readonly machines: readonly { readonly id: string }[] }>(
      `/api/customers/${customerId}`,
    );
    if (record.status !== 200) continue;
    for (const machine of record.data.machines) {
      const detail = await client.get<{ readonly jobRows: readonly JobListRow[] }>(
        `/api/machines/${machine.id}`,
      );
      if (detail.status === 200) rows.push(...detail.data.jobRows);
    }
  }
  return rows;
};

/**
 * DECISION 5 over HTTP.
 *
 * The visibility rule was already proven at the application layer. What is
 * proven here is that the API cannot be talked out of it: not by asking for a
 * job directly, not by searching for it, not by reaching it through a machine.
 */
describe('reading a job', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('answers 404 — never 403 — for another technician’s live job', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technician = await signedInAs(DEMO_USERS.technician);

    const mine = await technician.get<{ user: { id: string } }>('/api/auth/me');
    const all = await jobsFor(master);
    const someoneElses = all.find(
      (row) =>
        row.job.status === 'in_progress' &&
        row.job.primaryTechnicianId !== null &&
        row.job.primaryTechnicianId !== mine.data.user.id &&
        !row.job.additionalTechnicianIds.includes(asUserId(mine.data.user.id)),
    );
    expect(someoneElses).toBeDefined();

    const response = await technician.get(`/api/jobs/${someoneElses?.job.jobNumber ?? ''}`);

    expect(response.status).toBe(404);
    expect(response.error?.code).toBe('not_found');
    // A job that exists and a job number nobody issued must be identical.
    const invented = await technician.get('/api/jobs/EJE-999999');
    expect(response.error?.message).toBe(invented.error?.message);
  });

  it('lists only the jobs a technician may actually see', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technician = await signedInAs(DEMO_USERS.technician);
    const me = await technician.get<{ user: { id: string } }>('/api/auth/me');

    const everything = await jobsFor(master);
    const visible = await jobsFor(technician);
    expect(everything.length).toBeGreaterThan(visible.length);

    for (const row of visible) {
      const mine =
        row.job.primaryTechnicianId === me.data.user.id ||
        row.job.additionalTechnicianIds.includes(asUserId(me.data.user.id));
      const pool = row.job.status === 'open' && row.job.primaryTechnicianId === null;
      const finished = row.job.status === 'closed' || row.job.status === 'cancelled';

      // Somebody else's LIVE job is the case that must never appear.
      expect(mine || pool || finished).toBe(true);
    }

    // And specifically: no live job belonging to another technician.
    const otherLive = visible.filter(
      (row) =>
        row.job.status === 'in_progress' && row.job.primaryTechnicianId !== me.data.user.id,
    );
    expect(otherLive).toEqual([]);
  });

  it('does not let search discover a job the actor may not read', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technician = await signedInAs(DEMO_USERS.technician);

    const mine = await technician.get<{ user: { id: string } }>('/api/auth/me');
    const hidden = (await jobsFor(master)).find(
      (row) =>
        row.job.status === 'in_progress' && row.job.primaryTechnicianId !== mine.data.user.id,
    );
    expect(hidden).toBeDefined();

    const term = hidden?.job.jobNumber ?? '';
    const found = await technician.get<{ jobs: readonly { jobNumber: string }[] }>(
      `/api/search?q=${encodeURIComponent(term)}`,
    );

    const numbers = JSON.stringify(found.data);
    expect(numbers).not.toContain(term);

    // The office finds it by the same search.
    const office = await master.get(`/api/search?q=${encodeURIComponent(term)}`);
    expect(JSON.stringify(office.data)).toContain(term);
  });

  it('serves a technician the history of a machine they have worked, without prices', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const me = await technician.get<{ user: { id: string } }>('/api/auth/me');
    const visible = await historyFor(technician);

    // A FINISHED job on a machine they have worked, which was somebody else's:
    // reached through the machine rather than through the assignment, so the
    // prices are removed rather than hidden.
    const historical = visible.find(
      (row) =>
        row.job.status === 'closed' &&
        row.job.primaryTechnicianId !== me.data.user.id &&
        !row.job.additionalTechnicianIds.includes(asUserId(me.data.user.id)),
    );
    expect(historical).toBeDefined();

    const response = await technician.get<JobViewPayload>(
      `/api/jobs/${historical?.job.jobNumber ?? ''}`,
    );
    expect(response.status).toBe(200);

    const { job } = response.data.view;
    expect(job.pricingSnapshot).toBeNull();
    expect(job.calloutApplied).toBe(false);
    for (const part of job.parts) expect(part.unitPrice).toBe(0);
  });

  it('serves a technician their OWN finished job with its prices intact', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const me = await technician.get<{ user: { id: string } }>('/api/auth/me');
    // Finished work, reached the way a technician reaches it: machine history.
    const own = (await historyFor(technician)).find(
      (row) => row.job.status === 'closed' && row.job.primaryTechnicianId === me.data.user.id,
    );
    expect(own).toBeDefined();

    const response = await technician.get<JobViewPayload>(
      `/api/jobs/${own?.job.jobNumber ?? ''}`,
    );

    // Their own work, which they captured: withholding it would be withholding
    // what they themselves wrote down.
    expect(response.data.view.job.pricingSnapshot).not.toBeNull();
  });

  it('does not leak a suppressed price through any property of the response', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const technician = await signedInAs(DEMO_USERS.technician);
    const me = await technician.get<{ user: { id: string } }>('/api/auth/me');

    const closed = (await historyFor(technician)).find(
      (row) =>
        row.job.status === 'closed' &&
        row.job.primaryTechnicianId !== me.data.user.id &&
        !row.job.additionalTechnicianIds.includes(asUserId(me.data.user.id)),
    );
    expect(closed).toBeDefined();
    const jobNumber = closed?.job.jobNumber ?? '';

    // What the office is served, so the test is comparing against the real
    // figures rather than an assumption about the seed.
    const office = await master.get<JobViewPayload>(`/api/jobs/${jobNumber}`);
    expect(office.data.view.job.pricingSnapshot).not.toBeNull();

    const field = await technician.get<JobViewPayload>(`/api/jobs/${jobNumber}`);
    const { job } = field.data.view;

    // Suppression by REMOVAL: there is no property left holding the figure,
    // used or unused, so nothing downstream can render it.
    expect(job.pricingSnapshot).toBeNull();
    expect(job.calloutApplied).toBe(false);
    for (const part of job.parts) expect(part.unitPrice).toBe(0);

    const body = JSON.stringify(field.raw);
    expect(body).not.toContain('"pricingSnapshot":{');
    for (const price of office.data.view.job.parts.map((part) => part.unitPrice)) {
      if (price > 0) expect(body).not.toContain(`"unitPrice":${price}`);
    }

    /*
     * The rows the technician lists carry the suppression MORE strongly than
     * the record does: a list row is a summary, which has no price fields at
     * all, so there is no suppressed value that could be un-suppressed by
     * accident.
     *
     * Asserted as ABSENCE rather than as null. `expect(undefined).not.toBeNull()`
     * passes for a property that no longer exists, which is how a rule gets
     * deleted with a green suite.
     */
    const listed = (await historyFor(technician)).find((row) => row.job.jobNumber === jobNumber);
    expect(listed, 'the technician must still reach this job through machine history').toBeDefined();
    expect(listed?.job).not.toHaveProperty('pricingSnapshot');
    expect(listed?.job).not.toHaveProperty('parts');
    expect(listed?.job).not.toHaveProperty('labour');
  });

  it('refuses the closed-job archive to a technician entirely', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    expect((await technician.get('/api/jobs/closed')).status).toBe(403);
  });

  it('serves the closed-job archive to the office', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const response = await master.get<{ rows: readonly JobListRow[] }>('/api/jobs/closed');

    expect(response.status).toBe(200);
    expect(response.data.rows.length).toBeGreaterThan(0);
    for (const row of response.data.rows) expect(row.job.status).toBe('closed');
  });
});

describe('deleting a job', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('destroys it permanently, keeps the audit event, and offers no way back', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await jobsFor(master);
    /*
     * OPEN AND UNASSIGNED. CR-11.
     *
     * It used to take the first Open job it found, and most Open jobs in the
     * register are assigned to somebody — which is now, correctly, a refusal.
     * The subject here is what deletion DOES, so the fixture asks for a job
     * deletion applies to.
     */
    const target = rows.find(
      (row) =>
        row.job.status === 'open' &&
        row.job.primaryTechnicianId === null &&
        row.job.additionalTechnicianIds.length === 0,
    );
    expect(target).toBeDefined();
    const jobNumber = target?.job.jobNumber ?? '';

    const deleted = await master.post(`/api/jobs/${jobNumber}/delete`, {
      reason: 'Raised against the wrong customer.',
    });
    expect(deleted.status).toBe(200);

    // Gone from the read...
    expect((await master.get(`/api/jobs/${jobNumber}`)).status).toBe(404);
    // ...from the list...
    expect((await jobsFor(master)).some((row) => row.job.jobNumber === jobNumber)).toBe(false);
    // ...from search...
    const search = await master.get(`/api/search?q=${encodeURIComponent(jobNumber)}`);
    expect(JSON.stringify(search.data)).not.toContain(`"jobNumber":"${jobNumber}"`);
    // ...and from the closed archive.
    const closed = await master.get(`/api/jobs/closed`);
    expect(JSON.stringify(closed.data)).not.toContain(`"jobNumber":"${jobNumber}"`);

    // The audit event survives and still names the job by its historical number.
    const activity = await master.get<{ events: readonly { detail: string; summary: string }[] }>(
      '/api/activity',
    );
    const trail = JSON.stringify(activity.data);
    expect(trail).toContain(jobNumber);
    expect(trail).toContain('Raised against the wrong customer.');
  });

  it('refuses a technician deleting a job', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const mine = await jobsFor(technician);
    const target = mine[0];

    const response = await technician.post(`/api/jobs/${target?.job.jobNumber ?? ''}/delete`, {
      reason: 'Not mine to delete.',
    });

    expect([403, 404]).toContain(response.status);
  });

  it('has no endpoint that reads a deleted job', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await jobsFor(master);
    // Open AND unassigned — the only kind CR-11 lets anyone delete.
    const jobNumber =
      rows.find(
        (row) =>
          row.job.status === 'open' &&
          row.job.primaryTechnicianId === null &&
          row.job.additionalTechnicianIds.length === 0,
      )?.job.jobNumber ?? '';

    await master.post(`/api/jobs/${jobNumber}/delete`, { reason: 'Duplicate.' });

    // There is no restore, no trash and no include-deleted flag.
    expect((await master.post(`/api/jobs/${jobNumber}/restore`, {})).status).toBe(404);
    expect((await master.get(`/api/jobs/${jobNumber}`)).status).toBe(404);
  });
});

describe('idempotency', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('performs the business change once for a repeated key, and says it replayed', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await jobsFor(master);
    const jobNumber = rows.find((row) => row.job.status === 'in_progress')?.job.jobNumber ?? '';

    const body = { body: 'Spares ordered from the supplier.', internal: true };
    const key = 'note-1234';

    const first = await master.post(`/api/jobs/${jobNumber}/add_note`, body, {
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('Idempotent-Replay')).toBeNull();

    const second = await master.post(`/api/jobs/${jobNumber}/add_note`, body, {
      idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replay')).toBe('true');

    const view = await master.get<JobViewPayload>(`/api/jobs/${jobNumber}`);
    const matching = view.data.view.job.notes.filter((note) => note.body === body.body);
    expect(matching).toHaveLength(1);
  });

  it('scopes a key to the user who sent it', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const rows = await jobsFor(master);
    const jobNumber = rows.find((row) => row.job.status === 'in_progress')?.job.jobNumber ?? '';

    const key = 'shared-key';
    await master.post(
      `/api/jobs/${jobNumber}/add_note`,
      { body: 'From the owner.', internal: true },
      { idempotencyKey: key },
    );
    const other = await coordinator.post(
      `/api/jobs/${jobNumber}/add_note`,
      { body: 'From the coordinator.', internal: true },
      { idempotencyKey: key },
    );

    expect(other.headers.get('Idempotent-Replay')).toBeNull();

    const view = await master.get<JobViewPayload>(`/api/jobs/${jobNumber}`);
    const bodies = view.data.view.job.notes.map((note) => note.body);
    expect(bodies).toContain('From the owner.');
    expect(bodies).toContain('From the coordinator.');
  });

  it('lets a failed request be retried with the same key', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await jobsFor(master);
    const jobNumber = rows.find((row) => row.job.status === 'in_progress')?.job.jobNumber ?? '';
    const key = 'retry-me';

    const refused = await master.post(
      `/api/jobs/${jobNumber}/add_note`,
      { body: '', internal: true },
      { idempotencyKey: key },
    );
    expect(refused.status).toBe(400);

    const accepted = await master.post(
      `/api/jobs/${jobNumber}/add_note`,
      { body: 'Second attempt.', internal: true },
      { idempotencyKey: key },
    );
    expect(accepted.status).toBe(200);
  });
});

describe('the workflow is unchanged', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses a step the job is not at, with the violations the screens render', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await jobsFor(master);
    const open = rows.find((row) => row.job.status === 'open');

    const response = await master.post(
      `/api/jobs/${open?.job.jobNumber ?? ''}/start_signature`,
      {},
    );

    expect(response.status).toBe(422);
    expect(response.error?.code).toBe('workflow_refused');
    expect(response.error?.violations.length).toBeGreaterThan(0);
  });

  it('keeps the signature-refusal workflow', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const rows = await jobsFor(master);
    const awaiting = rows.find((row) => row.job.status === 'customer_signature');

    if (awaiting === undefined) {
      // Nothing seeded at that stage; the refusal command still has to exist.
      const any = rows[0];
      const response = await master.post(
        `/api/jobs/${any?.job.jobNumber ?? ''}/record_refusal`,
        { reason: 'The customer would not sign.' },
      );
      expect(response.status).not.toBe(404);
      return;
    }

    const response = await master.post(`/api/jobs/${awaiting.job.jobNumber}/record_refusal`, {
      reason: 'The customer would not sign.',
    });
    expect([200, 422]).toContain(response.status);
  });

  it('introduces no job status beyond the six stages', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const statuses = new Set((await jobsFor(master)).map((row) => row.job.status));

    // The lifecycle is the domain's, unchanged by this phase: the API adds no
    // status of its own, and `submitted` is the retired Master Review stage a
    // few historical jobs are still in.
    for (const status of statuses) {
      expect([...JOB_STATUS_ORDER, 'submitted']).toContain(status);
    }
  });
});
