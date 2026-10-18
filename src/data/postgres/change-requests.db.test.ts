import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { asCustomerId, asSiteId, asUserId, type ChangeRequest } from '@/domain';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { PostgresChangeRequestRepository } from './change-request-repository';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, seedBaseline } from './test-fixtures';

/**
 * REPORTS THAT THE REGISTER IS WRONG, ON REAL POSTGRESQL. CUST-CR.
 *
 * What the demonstration store cannot test: the constraints that make an
 * impossible row impossible, the foreign keys that stop a report being erased
 * by deleting the record it is about, and the conditional write that settles
 * two office users deciding at once.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

/** The message PostgreSQL actually raised, which the driver keeps on the cause. */
const postgresMessage = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the statement was expected to be refused, and was not');
};

describeDb('the PostgreSQL change-request repository', () => {
  let db: Database;
  let requests: PostgresChangeRequestRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    requests = new PostgresChangeRequestRepository(db);
  });

  const newRequest = (over: Partial<ChangeRequest> = {}): ChangeRequest => ({
    id: crypto.randomUUID(),
    subject: 'customer',
    customerId: asCustomerId(IDS.customer),
    siteId: null,
    machineId: null,
    details: 'The accounts email bounces.',
    raisedBy: asUserId(IDS.technician),
    raisedAt: '2026-10-18T07:30:00.000Z',
    state: 'open',
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: '',
    ...over,
  });

  it('round trips a report and reads it back by customer and by raiser', async () => {
    const saved = await requests.save(
      newRequest({ siteId: asSiteId(IDS.site), subject: 'site', details: 'Access notes are stale.' }),
    );

    expect(await requests.findById(saved.id)).toEqual(saved);
    expect(await requests.listForCustomer(asCustomerId(IDS.customer))).toEqual([saved]);
    expect(await requests.listForRaiser(asUserId(IDS.technician))).toEqual([saved]);
  });

  /**
   * OPEN FIRST, THEN LONGEST-WAITING FIRST — the opposite of a referral's
   * newest-first, and deliberately: the report that has been waiting a week is
   * the one somebody should read next.
   */
  it('puts what is waiting in front of what is done, oldest first', async () => {
    const old = await requests.save(newRequest({ raisedAt: '2026-10-01T06:00:00.000Z', details: 'Oldest.' }));
    const recent = await requests.save(newRequest({ raisedAt: '2026-10-17T06:00:00.000Z', details: 'Newer.' }));
    const settled = await requests.save(newRequest({ raisedAt: '2026-09-01T06:00:00.000Z', details: 'Done.' }));
    await requests.resolve({
      ...settled,
      state: 'applied',
      resolvedBy: asUserId(IDS.master),
      resolvedAt: '2026-09-02T06:00:00.000Z',
      resolutionNote: 'Fixed.',
    });

    const rows = await requests.list();
    expect(rows.map((row) => row.details)).toEqual(['Oldest.', 'Newer.', 'Done.']);
    expect((await requests.list({ state: 'open' })).map((row) => row.id)).toEqual([old.id, recent.id]);
  });

  it('records the office’s decision', async () => {
    const saved = await requests.save(newRequest());
    const resolved = await requests.resolve({
      ...saved,
      state: 'applied',
      resolvedBy: asUserId(IDS.master),
      resolvedAt: '2026-10-18T08:00:00.000Z',
      resolutionNote: 'Corrected the address by hand.',
    });

    expect(resolved?.state).toBe('applied');
    expect(resolved?.resolvedBy).toBe(IDS.master);
    expect(resolved?.resolutionNote).toMatch(/by hand/u);
  });

  /**
   * TWO OFFICE USERS DECIDING AT ONCE, settled in the WRITE rather than by a
   * read-then-write check, which is a race. The second changes no rows and gets
   * null, and the first decision stands.
   */
  it('refuses a second decision, and keeps the first', async () => {
    const saved = await requests.save(newRequest());
    const decision = {
      ...saved,
      resolvedBy: asUserId(IDS.master),
      resolvedAt: '2026-10-18T08:00:00.000Z',
    };

    const first = await requests.resolve({
      ...decision,
      state: 'applied',
      resolutionNote: 'Applied.',
    });
    const second = await requests.resolve({
      ...decision,
      state: 'declined',
      resolutionNote: 'Declined.',
    });

    expect(first?.state).toBe('applied');
    expect(second).toBeNull();
    expect((await requests.findById(saved.id))?.resolutionNote).toBe('Applied.');
  });

  /* -- the constraints, which are the half a store cannot have -------------- */

  it('REFUSES a report with nothing in it, at the database', async () => {
    const message = await postgresMessage(
      db.insert(schema.customerChangeRequests).values({
        id: crypto.randomUUID(),
        subject: 'customer',
        customerId: IDS.customer,
        details: '   ',
        raisedBy: IDS.technician,
        raisedAt: '2026-10-18T07:30:00.000Z',
      }),
    );
    expect(message).toMatch(/customer_change_requests_details_present/u);
  });

  it('REFUSES a resolved report that nobody is recorded as having resolved', async () => {
    const saved = await requests.save(newRequest());
    const message = await postgresMessage(
      db
        .update(schema.customerChangeRequests)
        .set({ state: 'applied' })
        .where(eq(schema.customerChangeRequests.id, saved.id)),
    );
    // The state and the attribution cannot disagree: "the office dealt with it"
    // and "nobody is recorded as having dealt with it" is the shape that makes
    // an audit trail worthless.
    expect(message).toMatch(/customer_change_requests_resolved_is_attributed/u);
  });

  it('REFUSES an open report that claims to have been resolved', async () => {
    const saved = await requests.save(newRequest());
    const message = await postgresMessage(
      db
        .update(schema.customerChangeRequests)
        .set({ resolvedAt: '2026-10-18T08:00:00.000Z', resolvedBy: IDS.master })
        .where(eq(schema.customerChangeRequests.id, saved.id)),
    );
    expect(message).toMatch(/customer_change_requests_resolved_is_attributed/u);
  });

  /**
   * THE REPORT OUTLIVES AN ATTEMPT TO MAKE IT DISAPPEAR. Every foreign key is
   * RESTRICT: deleting the customer, site or machine a report is about is the
   * one thing that must not quietly remove the report.
   */
  /*
   * A CUSTOMER OF ITS OWN, because the seeded one has jobs against it and
   * would be undeletable for that reason — which would make these two tests
   * pass while proving nothing about this table's own foreign keys.
   */
  const standaloneCustomer = async (withSite = false): Promise<{ customerId: string; siteId: string }> => {
    const customerId = crypto.randomUUID();
    const siteId = crypto.randomUUID();
    await db.insert(schema.customers).values({
      id: customerId,
      name: 'Nothing Refers To This (Pty) Ltd',
      accountNumber: `ACC-${customerId.slice(0, 6)}`,
      industry: 'Testing',
      active: true,
    });
    /*
     * The site is created only where the test needs one. A customer's own site
     * references it too, so leaving one here would have the SITE's foreign key
     * refuse the delete and this test would pass while proving nothing about
     * the report's — which is exactly what the first version did.
     */
    if (withSite) {
      await db.insert(schema.sites).values({
        id: siteId,
        customerId,
        name: 'Its only site',
        addressLine1: '1 Test Road',
        city: 'Johannesburg',
        province: 'Gauteng',
        postalCode: '2000',
      });
    }
    return { customerId, siteId };
  };

  it('REFUSES deleting the customer a report is about', async () => {
    const { customerId } = await standaloneCustomer();
    // Deletable until the report exists, which is what makes the refusal below
    // the report's own doing.
    await requests.save(newRequest({ customerId: asCustomerId(customerId) }));

    const message = await postgresMessage(
      db.delete(schema.customers).where(eq(schema.customers.id, customerId)),
    );
    expect(message).toMatch(/customer_change_requests/u);
  });

  it('REFUSES deleting the site a report is about', async () => {
    const { customerId, siteId } = await standaloneCustomer(true);
    await requests.save({
      ...newRequest({ customerId: asCustomerId(customerId) }),
      subject: 'site',
      siteId: asSiteId(siteId),
    });

    const message = await postgresMessage(
      db.delete(schema.sites).where(eq(schema.sites.id, siteId)),
    );
    expect(message).toMatch(/customer_change_requests/u);
  });
});
