import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { Database } from '@/db/client';
import { jobFixture, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresJobRepository } from './job-repository';

/**
 * AN UNGRADED JOB, ON PostgreSQL. Create New Job §3B / §4.
 *
 * `jobs.priority` was NOT NULL until `0027`. The column is the only place the
 * absence could have been lost — the domain can hold null, the operation now
 * writes it, and a NOT NULL column would have turned that into an error at the
 * last possible moment, on the live database rather than in a test.
 *
 * So these cases write null THROUGH THE REPOSITORY and read it back, which is
 * the path the application actually uses, and then check the column directly.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

describeDb('a job with no priority, on PostgreSQL', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
  });

  const jobWith = async (repository: PostgresJobRepository, priority: 'high' | 'urgent' | null) => {
    const allocated = await repository.allocateJobNumber();
    return repository.save(jobFixture(allocated.jobNumber, { priority }));
  };

  it('round trips null through the repository', async () => {
    const repository = new PostgresJobRepository(db);
    const saved = await jobWith(repository, null);

    expect(saved.priority).toBeNull();

    const reloaded = await repository.findById(saved.id);
    expect(reloaded?.priority).toBeNull();
  });

  it('stores it as a real NULL in the column, not as a string', async () => {
    const repository = new PostgresJobRepository(db);
    const saved = await jobWith(repository, null);

    const [row] = await db
      .select({ priority: schema.jobs.priority })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, saved.id));
    expect(row?.priority).toBeNull();
  });

  it('still stores a priority that IS given', async () => {
    const repository = new PostgresJobRepository(db);
    const saved = await jobWith(repository, 'high');
    expect((await repository.findById(saved.id))?.priority).toBe('high');
  });

  it('leaves an existing graded job alone — dropping NOT NULL rewrites nothing', async () => {
    const repository = new PostgresJobRepository(db);
    const graded = await jobWith(repository, 'urgent');
    expect(graded.priority).toBe('urgent');
  });
});
