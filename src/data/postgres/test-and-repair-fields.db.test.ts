import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { Database } from '@/db/client';
import { jobFixture, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresJobRepository } from './job-repository';

/**
 * THE TEST & REPAIR FIELDS ON PostgreSQL. Test & Repair §4.
 *
 * Two things that only exist here:
 *
 *  - THE FOUR COLUMNS ROUND TRIP, which is what "stored properly" means. The
 *    three text ones default to '' so there is no null-versus-empty ambiguity
 *    on the jobs that existed before `0028`; the quantity stays nullable
 *    because it is the one value that can be genuinely absent.
 *  - A QUANTITY THAT EXISTS IS A REAL ONE. Zero claims somebody counted
 *    nothing, which is not goods on a counter, and the schema's refusal is
 *    only half the guard — a direct write has to be refused too.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const messageOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the statement was expected to be refused, and was not');
};

describeDb('a Test & Repair job’s own fields, on PostgreSQL', () => {
  let db: Database;
  let jobs: PostgresJobRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    jobs = new PostgresJobRepository(db);
  });

  const repairJob = async (over: Record<string, unknown> = {}) => {
    const allocated = await jobs.allocateJobNumber();
    return jobs.save(
      jobFixture(allocated.jobNumber, {
        jobType: 'test_and_repair',
        quoteNumber: 'Q-20451',
        repairItem: { partNumber: 'ABC-123', description: 'Servo motor', quantity: 3 },
        ...over,
      }),
    );
  };

  it('round trips all four through the repository', async () => {
    const saved = await repairJob();
    const reloaded = await jobs.findById(saved.id);

    expect(reloaded?.quoteNumber).toBe('Q-20451');
    expect(reloaded?.repairItem).toEqual({
      partNumber: 'ABC-123',
      description: 'Servo motor',
      quantity: 3,
    });
  });

  it('stores an absent quantity as a real NULL', async () => {
    const saved = await repairJob({
      repairItem: { partNumber: 'ABC-123', description: '', quantity: null },
    });

    const [row] = await db
      .select({
        quantity: schema.jobs.repairQuantity,
        description: schema.jobs.repairDescription,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, saved.id));

    expect(row?.quantity).toBeNull();
    // The text column is '' rather than null, which is the ambiguity the
    // defaults exist to avoid.
    expect(row?.description).toBe('');
  });

  it('REFUSES a quantity of zero', async () => {
    const allocated = await jobs.allocateJobNumber();
    const message = await messageOf(
      jobs.save(
        jobFixture(allocated.jobNumber, {
          jobType: 'test_and_repair',
          repairItem: { partNumber: 'ABC-123', description: '', quantity: 0 },
        }),
      ),
    );
    expect(message).toContain('jobs_repair_quantity_positive');
  });

  it('REFUSES a negative quantity', async () => {
    const allocated = await jobs.allocateJobNumber();
    const message = await messageOf(
      jobs.save(
        jobFixture(allocated.jobNumber, {
          jobType: 'test_and_repair',
          repairItem: { partNumber: 'ABC-123', description: '', quantity: -3 },
        }),
      ),
    );
    expect(message).toContain('jobs_repair_quantity_positive');
  });

  it('leaves a job of another type carrying the empty defaults', async () => {
    const allocated = await jobs.allocateJobNumber();
    const breakdown = await jobs.save(jobFixture(allocated.jobNumber, { jobType: 'breakdown' }));
    const reloaded = await jobs.findById(breakdown.id);

    expect(reloaded?.quoteNumber).toBe('');
    expect(reloaded?.repairItem).toEqual({ partNumber: '', description: '', quantity: null });
  });
});
