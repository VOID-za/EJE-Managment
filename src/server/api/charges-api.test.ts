import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * CHARGES AND DISCOUNTS OVER THE REAL ROUTES. COST-5.
 *
 * The application tests prove the arithmetic and the authority. What is left to
 * the HTTP layer is what it is always left: that the schema refuses nonsense
 * before anything reaches the rules, and that a refusal of AUTHORITY is a 403
 * while a refusal of the OPERATION is a 422 — because a client distinguishes
 * them and a screen's wording depends on which it was.
 */
interface JobPayload {
  readonly view: { readonly job: Job };
}

const jobOf = async (client: ApiTestClient, jobNumber: string): Promise<Job> =>
  (await client.get<JobPayload>(`/api/jobs/${jobNumber}`)).data.view.job;

describe('additional charges over the API', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
  });

  it('puts a charge on a job, and the job comes back carrying it', async () => {
    const before = await jobOf(master, 'EJE-1061');

    const response = await master.post(`/api/jobs/${before.id}/add_additional_charge`, {
      description: 'Workshop consumables',
      amount: 45_000,
    });

    expect(response.status, JSON.stringify(response.error)).toBe(200);
    const after = await jobOf(master, 'EJE-1061');
    expect(after.additionalCharges).toHaveLength(1);
    expect(after.additionalCharges[0]?.amount).toBe(45_000);
  });

  it('refuses an amount of zero or less, by SCHEMA, with a 400', async () => {
    const job = await jobOf(master, 'EJE-1061');

    for (const amount of [0, -100]) {
      const response = await master.post(`/api/jobs/${job.id}/add_additional_charge`, {
        description: 'Nothing at all',
        amount,
      });
      // 400 and not 422: the body is malformed, not the request refused.
      expect(response.status, `amount ${amount}`).toBe(400);
    }
  });

  it('refuses a charge with no description', async () => {
    const job = await jobOf(master, 'EJE-1061');
    const response = await master.post(`/api/jobs/${job.id}/add_additional_charge`, {
      description: '   ',
      amount: 1_000,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a cent that is not a whole number', async () => {
    // A price with a fraction of a cent on it is a bug upstream, and the job
    // card has to add up exactly.
    const job = await jobOf(master, 'EJE-1061');
    const response = await master.post(`/api/jobs/${job.id}/add_additional_charge`, {
      description: 'Consumables',
      amount: 450.5,
    });
    expect(response.status).toBe(400);
  });

  it('lets a COORDINATOR add a charge, because it is priced like a part', async () => {
    const job = await jobOf(coordinator, 'EJE-1061');
    const response = await coordinator.post(`/api/jobs/${job.id}/add_additional_charge`, {
      description: 'Bench fee',
      amount: 25_000,
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);
  });
});

describe('DISCOUNT-OFF-1: there is no discount over the API (27 October 2026)', () => {
  it('apply_discount and clear_discount do not exist, for anybody, and the job is unchanged', async () => {
    startTestServer();
    const master = await signedInAs(DEMO_USERS.master);
    const job = await jobOf(master, 'EJE-1061');
    for (const action of ['apply_discount', 'clear_discount']) {
      const response = await master.post(`/api/jobs/${job.id}/${action}`, { amount: 5_000, reason: 'Goodwill' });
      expect(response.status, action).toBe(404);
    }
    expect((await jobOf(master, 'EJE-1061')).discount).toBeNull();
  });
});
