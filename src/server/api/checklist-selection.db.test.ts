import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';
import { scenarios } from './checklist-selection.scenarios';

/**
 * WHICH SERVICE CHECKLIST, ON POSTGRESQL. CHK-SRC-1.
 *
 * The same scenarios as the demonstration backend
 * (`checklist-selection.scenarios.ts`), through the same routes, against the
 * three checklists exactly as migration 0051 writes them: every test truncates
 * and then re-runs the migration's own data statements.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';

const MIGRATION = readFileSync(
  join(import.meta.dirname, '../../db/migrations/0051_source_checklists.sql'),
  'utf8',
);
const INSERT_SOURCE = MIGRATION.slice(MIGRATION.indexOf('-- 4. The three source checklists'))
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) => statement.replace(/^--.*$/gmu, '').trim().length > 0);

describeDb('the Service checklist choice, on PostgreSQL', () => {
  let db: Database;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    startPostgresTestServer(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    for (const statement of INSERT_SOURCE) await db.execute(sql.raw(statement));
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    startPostgresTestServer(url ?? '');
  });

  const cases = scenarios({
    master: () => signIn('elmarie@example-test.co.za'),
    technician: () => signIn('sipho@example-test.co.za'),
    otherTechnician: () => signIn('lerato@example-test.co.za'),
    technicianId: () => Promise.resolve(IDS.technician),
    record: {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
    },
  });

  for (const [name, run] of Object.entries(cases)) it(name, run);
});
