import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * CANCEL AND DELETE, OVER THE REAL HTTP API. MASTER SCOPE CR-11.
 *
 * THE TWO REFUSALS COME BACK WITH DIFFERENT STATUS CODES, and that is the
 * existing convention rather than anything this change introduced:
 * `delete_not_permitted` is listed in `PERMISSION_CODES`, so a refused deletion
 * is a 403, while a refused cancellation carries `cancel_not_permitted` and is
 * a 422. Both are refusals and both leave the job exactly as it was; the tests
 * below assert the code each route actually returns rather than flattening the
 * difference.
 *
 * The screen asks the same predicate the operation does, so a button cannot be
 * offered that the server would refuse — but a button is not what these prove.
 * Somebody with a terminal and a session cookie can POST to any job in any
 * state, and the server is what has to say no. Every case below goes through
 * the route, with a real session, exactly as a hand-written request would.
 */

interface JobsPayload {
  readonly rows: readonly { readonly job: Job }[];
}

const jobs = async (client: Awaited<ReturnType<typeof signedInAs>>): Promise<readonly Job[]> =>
  (await client.get<JobsPayload>('/api/jobs')).data.rows.map((row) => row.job);

const openUnassigned = (all: readonly Job[]): Job => {
  const job = all.find(
    (candidate) =>
      candidate.status === 'open' &&
      candidate.primaryTechnicianId === null &&
      candidate.additionalTechnicianIds.length === 0,
  );
  if (job === undefined) throw new Error('the register has no Open unassigned job');
  return job;
};

const openAssigned = (all: readonly Job[]): Job => {
  const job = all.find(
    (candidate) => candidate.status === 'open' && candidate.primaryTechnicianId !== null,
  );
  if (job === undefined) throw new Error('the register has no Open assigned job');
  return job;
};

describe('the office may end an Open unassigned job, over the API', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('CANCEL-1: a Master cancels one', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const target = openUnassigned(await jobs(master));

    const response = await master.post(`/api/jobs/${target.jobNumber}/cancel`, {
      reason: 'customer_resolved',
      description: 'Customer fixed it themselves.',
    });
    expect(response.status).toBe(200);
  });

  it('CANCEL-2: a Coordinator cancels one', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const target = openUnassigned(await jobs(coordinator));

    const response = await coordinator.post(`/api/jobs/${target.jobNumber}/cancel`, {
      reason: 'duplicate',
      description: 'Raised twice.',
    });
    expect(response.status).toBe(200);
  });

  it('DELETE-2: a Coordinator deletes one', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const target = openUnassigned(await jobs(coordinator));

    const response = await coordinator.post(`/api/jobs/${target.jobNumber}/delete`, {
      reason: 'Raised against the wrong customer.',
    });
    expect(response.status).toBe(200);
    expect((await coordinator.get(`/api/jobs/${target.jobNumber}`)).status).toBe(404);
  });
});

describe('the server refuses every other case, however the request is made', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('CANCEL-3: an Open job that is already ASSIGNED is refused', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const target = openAssigned(await jobs(master));

    const cancel = await master.post(`/api/jobs/${target.jobNumber}/cancel`, {
      reason: 'duplicate',
      description: 'Raised twice.',
    });
    expect(cancel.status).toBe(422);

    const remove = await master.post(`/api/jobs/${target.jobNumber}/delete`, {
      reason: 'Duplicate.',
    });
    expect(remove.status).toBe(403);

    // And the job is still there, untouched.
    const after = await master.get<{ readonly view: { readonly job: Job } }>(
      `/api/jobs/${target.jobNumber}`,
    );
    expect(after.status).toBe(200);
    expect(after.data.view.job.status).toBe('open');
  });

  it('CANCEL-4 / DELETE-3: an accepted, in-progress job is refused', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const inProgress = (await jobs(master)).find((job) => job.status === 'in_progress');
    expect(inProgress).toBeDefined();
    const jobNumber = inProgress?.jobNumber ?? '';

    expect(
      (
        await master.post(`/api/jobs/${jobNumber}/cancel`, {
          reason: 'duplicate',
          description: 'x',
        })
      ).status,
    ).toBe(422);
    expect((await master.post(`/api/jobs/${jobNumber}/delete`, { reason: 'x' })).status).toBe(403);
  });

  it('CANCEL-5 / DELETE-4: an awaiting-spares job is refused', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const spares = (await jobs(master)).find((job) => job.status === 'awaiting_spares');
    expect(spares).toBeDefined();
    const jobNumber = spares?.jobNumber ?? '';

    expect(
      (
        await master.post(`/api/jobs/${jobNumber}/cancel`, {
          reason: 'duplicate',
          description: 'x',
        })
      ).status,
    ).toBe(422);
    expect((await master.post(`/api/jobs/${jobNumber}/delete`, { reason: 'x' })).status).toBe(403);
  });

  it('CANCEL-6 / DELETE-5: a signed job and one in the retired review stage are refused', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const all = await jobs(master);
    for (const status of ['review', 'submitted'] as const) {
      const target = all.find((job) => job.status === status);
      expect(target, status).toBeDefined();
      const jobNumber = target?.jobNumber ?? '';

      expect(
        (
          await master.post(`/api/jobs/${jobNumber}/cancel`, {
            reason: 'duplicate',
            description: 'x',
          })
        ).status,
        `cancel ${status}`,
      ).toBe(422);
      expect(
        (await master.post(`/api/jobs/${jobNumber}/delete`, { reason: 'x' })).status,
        `delete ${status}`,
      ).toBe(403);
    }
  });

  it('a technician is refused on an Open unassigned job, which is the one case the office may do', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const target = openUnassigned(await jobs(master));

    const technician = await signedInAs(DEMO_USERS.technician);
    const cancel = await technician.post(`/api/jobs/${target.jobNumber}/cancel`, {
      reason: 'duplicate',
      description: 'x',
    });
    expect([422, 404]).toContain(cancel.status);
    const remove = await technician.post(`/api/jobs/${target.jobNumber}/delete`, { reason: 'x' });
    expect([403, 404]).toContain(remove.status);
  });
});
