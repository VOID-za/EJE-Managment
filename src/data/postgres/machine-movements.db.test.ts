import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';

/**
 * WHAT THE DATABASE REFUSES ABOUT A MACHINE'S HISTORY. MACH-HIST.
 *
 * The rules that only exist on PostgreSQL, and each is a row that would make
 * the history lie:
 *
 *   - a "move" where nothing moved, which would fill the record with rows
 *     saying the machine stayed where it was;
 *   - half a starting point, which is not a starting point;
 *   - and a SITE deleted out from under a movement that names it, which would
 *     leave the history pointing at somewhere that does not exist.
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

describeDb('a machine’s movement history, on PostgreSQL', () => {
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

  const movement = (over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    machineId: IDS.machine,
    fromSiteId: IDS.site,
    fromCustomerId: IDS.customer,
    toSiteId: IDS.otherSite,
    toCustomerId: IDS.otherCustomer,
    effectiveOn: '2026-09-14',
    note: 'Sold to the other customer.',
    recordedBy: IDS.master,
    recordedAt: '2026-09-20T09:00:00.000Z',
    ...over,
  });

  it('stores a move with both ends and the day it happened', async () => {
    await db.insert(schema.machineMovements).values(movement());

    const [row] = await db.select().from(schema.machineMovements);
    expect(row?.fromSiteId).toBe(IDS.site);
    expect(row?.toSiteId).toBe(IDS.otherSite);
    expect(row?.effectiveOn).toBe('2026-09-14');
    // Written down six days after it happened, and both are kept.
    expect(row?.recordedAt).not.toBe('2026-09-14');
  });

  it('stores a FIRST record with no starting point', async () => {
    await db
      .insert(schema.machineMovements)
      .values(movement({ fromSiteId: null, fromCustomerId: null }));

    const [row] = await db.select().from(schema.machineMovements);
    expect(row?.fromSiteId).toBeNull();
  });

  it('REFUSES a move where nothing moved', async () => {
    const said = await messageOf(
      db.insert(schema.machineMovements).values(
        movement({ toSiteId: IDS.site, toCustomerId: IDS.customer }),
      ),
    );
    expect(said).toMatch(/machine_movements_moves_something/u);
  });

  it('ACCEPTS a move to the same site under a different customer', async () => {
    // A site can change hands with the machine standing on it. The constraint
    // asks whether anything moved, not whether the SITE moved.
    await db.insert(schema.machineMovements).values(
      movement({ toSiteId: IDS.site, toCustomerId: IDS.otherCustomer }),
    );
    expect(await db.select().from(schema.machineMovements)).toHaveLength(1);
  });

  it('REFUSES half a starting point, in both directions', async () => {
    for (const half of [
      { fromSiteId: IDS.site, fromCustomerId: null },
      { fromSiteId: null, fromCustomerId: IDS.customer },
    ]) {
      const said = await messageOf(db.insert(schema.machineMovements).values(movement(half)));
      expect(said, JSON.stringify(half)).toMatch(/machine_movements_from_is_whole/u);
    }
  });

  it('REFUSES a site being deleted out from under a movement', async () => {
    /*
     * RESTRICT and not CASCADE, deliberately. Deleting the site would leave
     * the history saying the machine moved somewhere that no longer exists,
     * which is worse than refusing the delete — and a site with history is
     * withdrawn rather than deleted anyway.
     *
     * The DESTINATION site is the one tried here, because it is the one the
     * history would be pointing at if the delete went through.
     */
    await db.insert(schema.machineMovements).values(movement());

    const said = await messageOf(
      db.delete(schema.sites).where(eq(schema.sites.id, IDS.otherSite)),
    );
    expect(said).toMatch(/machine_movements_to_site_id_sites_id_fk|violates foreign key/u);
    expect(await db.select().from(schema.machineMovements)).toHaveLength(1);
  });

  it('takes its history with the machine when the machine is deleted', async () => {
    // CASCADE on the machine's own key: a machine deleted outright (one no job
    // was ever done on) has no history to keep.
    await db.insert(schema.machineMovements).values(movement());
    await db.delete(schema.machines);
    expect(await db.select().from(schema.machineMovements)).toHaveLength(0);
  });
});
