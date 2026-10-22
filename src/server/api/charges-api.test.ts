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

describe('a discount over the API', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
  });

  it('is applied by a Master, with the reason recorded', async () => {
    const job = await jobOf(master, 'EJE-1061');
    const response = await master.post(`/api/jobs/${job.id}/apply_discount`, {
      amount: 5_000,
      reason: 'Goodwill on a repeat call-out',
    });

    expect(response.status, JSON.stringify(response.error)).toBe(200);
    const after = await jobOf(master, 'EJE-1061');
    expect(after.discount?.amount).toBe(5_000);
    expect(after.discount?.reason).toBe('Goodwill on a repeat call-out');
  });

  it('REFUSES A COORDINATOR, and says it is a Master’s decision', async () => {
    const job = await jobOf(coordinator, 'EJE-1061');
    const response = await coordinator.post(`/api/jobs/${job.id}/apply_discount`, {
      amount: 5_000,
      reason: 'Goodwill',
    });

    /*
     * 403, which is this API's own convention for `not_permitted`: a refusal
     * that is PERMANENT FOR THIS ACTOR, as against a 422 for something that
     * cannot be done YET. A Coordinator will never be able to discount under
     * the shipped rule, so 403 is the honest code — see `PERMISSION_CODES`.
     */
    expect(response.status).toBe(403);
    const said = JSON.stringify(response.error);
    expect(said).toMatch(/Master/u);

    // AND NOTHING CHANGED, which is what makes the refusal worth anything.
    expect((await jobOf(master, 'EJE-1061')).discount).toBeNull();
  });

  it('refuses a blank reason', async () => {
    const job = await jobOf(master, 'EJE-1061');
    const response = await master.post(`/api/jobs/${job.id}/apply_discount`, {
      amount: 5_000,
      reason: '   ',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await jobOf(master, 'EJE-1061')).discount).toBeNull();
  });

  it('refuses more than the job comes to, naming the figure', async () => {
    const job = await jobOf(master, 'EJE-1061');
    const response = await master.post(`/api/jobs/${job.id}/apply_discount`, {
      amount: 999_999_999,
      reason: 'More than the whole job',
    });

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.error)).toMatch(/before VAT/u);
  });

  it('is cleared by a Master and refused to a Coordinator', async () => {
    const job = await jobOf(master, 'EJE-1061');
    await master.post(`/api/jobs/${job.id}/apply_discount`, {
      amount: 5_000,
      reason: 'Goodwill',
    });

    const refused = await coordinator.post(`/api/jobs/${job.id}/clear_discount`, {});
    expect(refused.status).toBe(403);
    expect((await jobOf(master, 'EJE-1061')).discount?.amount).toBe(5_000);

    const cleared = await master.post(`/api/jobs/${job.id}/clear_discount`, {});
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    expect((await jobOf(master, 'EJE-1061')).discount).toBeNull();
  });

  it('refuses a parameter nobody offers', async () => {
    // `.strict()` everywhere: a client sending `percentage` is a client built
    // against a rule EJE have not settled, and it should be told.
    const job = await jobOf(master, 'EJE-1061');
    const response = await master.post(`/api/jobs/${job.id}/apply_discount`, {
      amount: 5_000,
      reason: 'Goodwill',
      percentage: 10,
    });
    expect(response.status).toBe(400);
  });
});
