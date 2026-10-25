import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEvent, Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * JOB-EDIT-1 (#72) OVER THE REAL ROUTES.
 *
 * The application tests prove the rules. What is left to the HTTP layer is
 * that each refusal arrives as the right status — because a client acts on the
 * difference — and that the change and its audit record come back:
 *
 *   403  a technician (permanent for this actor)
 *   404  a draft to anybody who may not see drafts (refusing would confirm it)
 *   400  a malformed edit, including a change that does not say what it replaces
 *   422  a business refusal: a signed job, a stale value, an emptied breakdown
 *   200  the corrected job, and a `job_details_edited` event with from/to pairs
 *
 * Seed facts used: EJE-1048 is an open breakdown assigned to Sipho (the
 * harness's technician), EJE-1046 is signed, EJE-1060 is a draft.
 */
const edit = (client: ApiTestClient, job: string, body: unknown) =>
  client.post<Job>(`/api/jobs/${job}/edit_details`, body);

const jobOf = async (client: ApiTestClient, jobNumber: string): Promise<Job> =>
  (await client.get<{ view: { job: Job } }>(`/api/jobs/${jobNumber}`)).data.view.job;

describe('correcting a job’s details over the API', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let technician: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  it('lets a Coordinator correct the order number, and records it as a from/to pair', async () => {
    const before = await jobOf(coordinator, 'EJE-1048');
    const response = await edit(coordinator, 'EJE-1048', {
      changes: { orderNumber: 'PO-88123-A' },
      expected: { orderNumber: before.orderNumber },
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    expect(response.data.orderNumber).toBe('PO-88123-A');
    expect((await jobOf(master, 'EJE-1048')).orderNumber).toBe('PO-88123-A');

    // The job screen's own read carries the job's trail.
    const screen = await master.get<{ activity: readonly ActivityEvent[] }>('/api/jobs/EJE-1048');
    expect(screen.status).toBe(200);
    const events = screen.data.activity.filter((event) => event.type === 'job_details_edited');
    expect(events).toHaveLength(1);
    expect(events[0]!.changes).toEqual([
      { field: 'details.orderNumber', from: before.orderNumber, to: 'PO-88123-A' },
    ]);
  });

  it('refuses a technician with 403, on a job they are assigned to and can see', async () => {
    const before = await jobOf(technician, 'EJE-1048');
    const response = await edit(technician, 'EJE-1048', {
      changes: { orderNumber: 'PO-BY-TECH' },
      expected: { orderNumber: before.orderNumber },
    });
    expect(response.status).toBe(403);
    expect((await jobOf(master, 'EJE-1048')).orderNumber).toBe(before.orderNumber);
  });

  it('answers 404 to a Coordinator editing a DRAFT, which she may not see', async () => {
    const response = await edit(coordinator, 'EJE-1060', {
      changes: { orderNumber: 'PO-X' },
      expected: { orderNumber: '' },
    });
    expect(response.status).toBe(404);
  });

  it('refuses a SIGNED job with 422 and leaves it unchanged', async () => {
    const before = await jobOf(master, 'EJE-1046');
    const response = await edit(master, 'EJE-1046', {
      changes: { orderNumber: 'PO-AFTER-SIGNING' },
      expected: { orderNumber: before.orderNumber },
    });
    expect(response.status).toBe(422);
    const after = await jobOf(master, 'EJE-1046');
    expect(after.orderNumber).toBe(before.orderNumber);
    expect(after.signature).toEqual(before.signature);
  });

  it('refuses a stale edit with 422', async () => {
    const response = await edit(master, 'EJE-1048', {
      changes: { orderNumber: 'PO-NEW' },
      expected: { orderNumber: 'PO-WHAT-I-THOUGHT-IT-WAS' },
    });
    expect(response.status).toBe(422);
  });

  it('refuses emptying a breakdown’s fault description with 422', async () => {
    const before = await jobOf(master, 'EJE-1048');
    const response = await edit(master, 'EJE-1048', {
      changes: { faultDescription: '   ' },
      expected: { faultDescription: before.faultDescription },
    });
    expect(response.status).toBe(422);
  });

  it('refuses a change that does not say what it replaces by SCHEMA — 400', async () => {
    const response = await edit(master, 'EJE-1048', {
      changes: { orderNumber: 'PO-BLIND' },
      expected: {},
    });
    expect(response.status).toBe(400);
  });

  it('refuses an unknown field and an over-long value by SCHEMA — 400', async () => {
    expect(
      (await edit(master, 'EJE-1048', { changes: { priority: 'urgent' }, expected: { priority: 'normal' } }))
        .status,
    ).toBe(400);
    expect(
      (
        await edit(master, 'EJE-1048', {
          changes: { orderNumber: 'x'.repeat(121) },
          expected: { orderNumber: 'PO-88123' },
        })
      ).status,
    ).toBe(400);
  });
});
