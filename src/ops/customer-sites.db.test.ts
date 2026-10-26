import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql as raw } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { countLegacyMultiSiteCustomers } from './customer-sites';

/**
 * THE PREFLIGHT'S COUNT OF LEGACY MULTI-SITE CUSTOMERS, ON REAL POSTGRESQL.
 * SITE-1. Archived sites are history and do not count; only a customer with
 * two or more ACTIVE sites stands in the way of the one-site constraint.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

describeDb('counting customers that still have several active sites', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(raw`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
  });

  it('is zero when every customer has one site, counts a second active site, and ignores an archived one', async () => {
    expect(await countLegacyMultiSiteCustomers(db.$client)).toBe(0);

    await db.insert(schema.sites).values({ id: crypto.randomUUID(), customerId: IDS.customer, name: 'Wadeville' });
    expect(await countLegacyMultiSiteCustomers(db.$client)).toBe(1);

    await db.insert(schema.sites).values({
      id: crypto.randomUUID(),
      customerId: IDS.otherCustomer,
      name: 'Old yard',
      archivedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await countLegacyMultiSiteCustomers(db.$client)).toBe(1);
  });
});
