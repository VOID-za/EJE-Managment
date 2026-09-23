import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@/db/client';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { applySeed } from './apply';

/**
 * RUNNING THE SEED TWICE MUST CHANGE NOTHING THE SECOND TIME.
 *
 * This is the property the staging deployment depends on. `npm run db:seed:demo`
 * will be run against eje.syncza.co.za's database more than once — after a
 * redeploy, after a migration, by somebody who is not sure whether it worked —
 * and a second run that duplicated every customer, or reset a password somebody
 * had changed, would be worse than no seed at all.
 *
 * It is asserted against a REAL PostgreSQL rather than a fake, because what is
 * actually being tested is the "have I written this already?" question the seed
 * asks of the database: unique constraints, the derived ids in `./ids.ts` and
 * the job-number sequence are the mechanism, and none of them exist in a fake.
 *
 * The same `applySeed` both commands call — there is only one, which is why
 * this covers both.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

/** Everything the seed writes, counted in one round-trip. */
const census = async (db: Database): Promise<Record<string, number>> => {
  const rows = await db.execute<{ kind: string; n: string }>(sql`
    select 'users' as kind, count(*)::text as n from users
    union all select 'customers', count(*)::text from customers
    union all select 'sites', count(*)::text from sites
    union all select 'contacts', count(*)::text from contacts
    union all select 'machines', count(*)::text from machines
    union all select 'checklists', count(*)::text from checklists
    union all select 'checklist_versions', count(*)::text from checklist_versions
    union all select 'library_documents', count(*)::text from library_documents
    union all select 'jobs', count(*)::text from jobs
    union all select 'job_technicians', count(*)::text from job_technicians
    union all select 'job_participants', count(*)::text from job_participants
    union all select 'job_transfers', count(*)::text from job_transfers
    union all select 'audit_events', count(*)::text from audit_events
    union all select 'availability', count(*)::text from availability
    union all select 'chat_conversations', count(*)::text from chat_conversations
    union all select 'chat_messages', count(*)::text from chat_messages
    union all select 'notifications', count(*)::text from notifications
    union all select 'system_settings', count(*)::text from system_settings
  `);
  return Object.fromEntries([...rows].map((row) => [row.kind, Number(row.n)]));
};

describeDb('the seed, applied twice', () => {
  let db: Database;
  let first: Record<string, number>;
  let second: Record<string, number>;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    await truncateAll(db);

    await applySeed(db, { resetPasswords: false });
    first = await census(db);

    await applySeed(db, { resetPasswords: false });
    second = await census(db);
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  it('writes a dataset worth signing into', () => {
    // Not a smoke test of "it ran". These are the records the browser test plan
    // in docs/vps-smoke-test.md walks through.
    expect(first.users).toBeGreaterThanOrEqual(5);
    expect(first.customers).toBeGreaterThanOrEqual(5);
    expect(first.sites).toBeGreaterThanOrEqual(5);
    expect(first.contacts).toBeGreaterThanOrEqual(5);
    expect(first.machines).toBeGreaterThanOrEqual(10);
    expect(first.jobs).toBeGreaterThanOrEqual(20);
    expect(first.checklists).toBeGreaterThanOrEqual(2);
    expect(first.notifications).toBeGreaterThanOrEqual(5);
    expect(first.system_settings).toBe(1);
  });

  it('adds not one row on the second run', () => {
    expect(second).toEqual(first);
  });

  it('exercises every job type and a spread of statuses', async () => {
    const rows = await db.execute<{ job_type_code: string; status: string }>(
      sql`select job_type_code, status from jobs`,
    );
    const all = [...rows];
    const types = new Set(all.map((row) => row.job_type_code));
    const statuses = new Set(all.map((row) => row.status));

    for (const type of ['breakdown', 'installation', 'service', 'test_and_repair']) {
      expect(types).toContain(type);
    }
    // Open work, work in hand, work stuck on parts, work at the customer's pen,
    // and work finished — the five shapes the dashboards and registers show.
    for (const status of [
      'open',
      'in_progress',
      'awaiting_spares',
      'customer_signature',
      'closed',
    ]) {
      expect(statuses).toContain(status);
    }
  });

  it('spreads the work across the technicians', async () => {
    const rows = await db.execute<{ primary_technician_id: string; n: string }>(sql`
      select primary_technician_id, count(*)::text as n
        from jobs
       where primary_technician_id is not null
       group by 1
    `);
    // Three, because the visibility rule cannot be demonstrated with two: one
    // technician has to be uninvolved in another's job.
    expect([...rows].length).toBeGreaterThanOrEqual(3);
  });

  it('leaves a password somebody changed alone', async () => {
    // resetPasswords is off, so the seed writes a hash only where there is
    // none. A demo account whose password was changed on the staging site stays
    // changed until somebody asks for it back with --reset-passwords.
    await db.execute(
      sql`update users set password_hash = 'changed-by-hand' where email = 'master@eje-demo.local'`,
    );
    await applySeed(db, { resetPasswords: false });

    const rows = await db.execute<{ password_hash: string }>(
      sql`select password_hash from users where email = 'master@eje-demo.local'`,
    );
    expect([...rows][0]?.password_hash).toBe('changed-by-hand');
  });
});
