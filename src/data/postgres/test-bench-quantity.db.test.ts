import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { Database } from '@/db/client';
import { jobFixture, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresJobRepository } from './job-repository';

/**
 * THE TEST BENCH QUANTITY ON PostgreSQL. BENCH-QTY-1, migration 0044.
 *
 * A job written without a quantity reads 1 (the default — every earlier job
 * carried the fee at most once); the repository round trips a quantity; the
 * database refuses one outside 1–99; and once the customer has signed, the
 * quantity is frozen by the signed-job guard exactly as the flag beside it is.
 * Machine-optional installations and services (JOB-MACH-OPT-1) store a NULL
 * machine here too.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const postgresMessage = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    const error = cause as { message?: string; cause?: { message?: string } };
    return `${error.message ?? ''} ${error.cause?.message ?? ''}`;
  }
  throw new Error('expected the database to refuse the statement');
};

describeDb('migration 0044 — the test bench quantity', () => {
  let db: Database;
  let repository: PostgresJobRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    repository = new PostgresJobRepository(db);
  });

  const newJob = async (over: Parameters<typeof jobFixture>[1] = {}) => {
    const allocated = await repository.allocateJobNumber();
    return repository.save(jobFixture(allocated.jobNumber, { machineId: null, ...over }));
  };

  it('defaults to 1 for a row written without it, and round trips a quantity', async () => {
    const job = await newJob({ testBenchApplied: true, testBenchQuantity: 3 });
    expect((await repository.findById(job.id))?.testBenchQuantity).toBe(3);
    const [fresh] = await db
      .select({ quantity: schema.jobs.testBenchQuantity })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, (await newJob()).id));
    expect(fresh?.quantity).toBe(1);
  });

  it('refuses a quantity outside 1–99', async () => {
    const job = await newJob();
    for (const bad of [0, 100, -3]) {
      expect(
        await postgresMessage(db.update(schema.jobs).set({ testBenchQuantity: bad }).where(eq(schema.jobs.id, job.id))),
      ).toContain('jobs_test_bench_quantity_range');
    }
  });

  it('freezes the quantity once the customer has signed', async () => {
    const job = await newJob({
      status: 'review',
      testBenchApplied: true,
      testBenchQuantity: 2,
      signature: {
        customerName: 'Pieter',
        customerSurname: 'Nel',
        strokeData: 'M0,0 L1,1',
        signedAt: '2026-11-01T12:00:00.000Z',
        declaration: 'I confirm that the work described above has been completed.',
      },
    });
    expect(
      await postgresMessage(db.update(schema.jobs).set({ testBenchQuantity: 5 }).where(eq(schema.jobs.id, job.id))),
    ).toMatch(/has been signed by the customer/u);
    expect((await repository.findById(job.id))?.testBenchQuantity).toBe(2);
  });

  it('stores an installation and a service with NO machine (JOB-MACH-OPT-1)', async () => {
    for (const jobType of ['installation', 'service'] as const) {
      const job = await newJob({ jobType, machineId: null });
      expect((await repository.findById(job.id))?.machineId).toBeNull();
    }
  });
});
