import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * CANCEL AND DELETE, OVER THE REAL HTTP API. MASTER SCOPE CR-11.
 *
 * THE STATUS CODE FOLLOWS THE CAUSE OF THE REFUSAL, NOT THE ROUTE. AUD-9,
 * corrected here. A refusal about WHO IS ASKING is 403 on both routes; a
 * refusal about THE JOB'S STATE is 422 on both, and carries the server's own
 * sentence. Both leave the job exactly as it was.
 *
 * *This file used to assert the opposite, and said so:* every delete refusal
 * was a 403 because `delete_not_permitted` covered both causes and sat in
 * `PERMISSION_CODES`, and every cancel refusal was a 422 because
 * `cancel_not_permitted` covered both causes and sat outside it. So each route
 * was wrong for half its cases. The tests still assert the code each route
 * actually returns rather than flattening the difference; the codes themselves
 * have changed.
 *
 * What the wrong code costs: a 403 states that the refusal is permanent for
 * this actor, so a client may stop offering the action and `describeFailure`
 * replaces the message with a fixed "your role does not include this screen".
 * Neither is true of "this job is assigned, so it cannot be deleted". The
 * cancel/delete dialog shows the server's sentence either way — `useOperation`
 * passes it through — so this was not a wrong word on that screen; it was a
 * wrong fact in the response, which is what anything else reading it believes.
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
    /*
     * 422, NOT 403. The Master is the role that deletes jobs; what stops this
     * one is the job, and the sentence saying so has to reach the screen.
     */
    expect(remove.status).toBe(422);
    expect(JSON.stringify(remove.raw)).toContain('delete_refused');
    expect(JSON.stringify(remove.raw)).toMatch(/assigned|cannot be deleted/iu);

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
    expect((await master.post(`/api/jobs/${jobNumber}/delete`, { reason: 'x' })).status).toBe(422);
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
    expect((await master.post(`/api/jobs/${jobNumber}/delete`, { reason: 'x' })).status).toBe(422);
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
      ).toBe(422);
    }
  });

  it('a technician is refused on an Open unassigned job, which is the one case the office may do', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const target = openUnassigned(await jobs(master));

    const technician = await signedInAs(DEMO_USERS.technician);
    /*
     * A PERMISSION REFUSAL ON BOTH ROUTES NOW. 403, or 404 where the job is not
     * one this technician may see at all — which is the visibility rule
     * answering first, and is equally correct.
     */
    const cancel = await technician.post(`/api/jobs/${target.jobNumber}/cancel`, {
      reason: 'duplicate',
      description: 'x',
    });
    expect([403, 404]).toContain(cancel.status);
    if (cancel.status === 403) {
      expect(JSON.stringify(cancel.raw)).toContain('cancel_not_permitted');
    }

    const remove = await technician.post(`/api/jobs/${target.jobNumber}/delete`, { reason: 'x' });
    expect([403, 404]).toContain(remove.status);
    if (remove.status === 403) {
      expect(JSON.stringify(remove.raw)).toContain('delete_not_permitted');
    }
  });

  it('AUD-9: the same route answers 403 for who is asking and 422 for the job', async () => {
    /*
     * THE WHOLE POINT, ON ONE ROUTE AND ONE PAIR OF JOBS.
     *
     * The office is refused by the STATE of an assigned job — 422, with the
     * explanation. A technician is refused by WHO THEY ARE on the very job the
     * office may end — 403, where "speak to the office" is true and useful.
     * Before this change the delete route answered 403 to both, so the office
     * was told its role was wrong.
     */
    const master = await signedInAs(DEMO_USERS.master);
    const all = await jobs(master);

    const byState = await master.post(`/api/jobs/${openAssigned(all).jobNumber}/delete`, {
      reason: 'x',
    });
    expect(byState.status, 'office, assigned job').toBe(422);
    expect(JSON.stringify(byState.raw)).toContain('delete_refused');

    const technician = await signedInAs(DEMO_USERS.technician);
    const byRole = await technician.post(`/api/jobs/${openUnassigned(all).jobNumber}/delete`, {
      reason: 'x',
    });
    expect([403, 404], 'technician, deletable job').toContain(byRole.status);
    if (byRole.status === 403) {
      expect(JSON.stringify(byRole.raw)).toContain('delete_not_permitted');
      // The 403 presentation discards the server sentence, so a 403 must only
      // ever be sent where "your role" really is the reason.
      expect(JSON.stringify(byRole.raw)).toMatch(/only the office/iu);
    }
  });
});
