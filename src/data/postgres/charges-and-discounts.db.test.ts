import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';

/**
 * WHAT THE DATABASE REFUSES ABOUT MONEY ON A JOB. COST-5.
 *
 * The application's rules are tested against the demonstration backend, where
 * nothing enforces a constraint. These are the guarantees that exist only on
 * PostgreSQL — and they are the ones that matter, because every one of them
 * describes a row that would produce a wrong customer document:
 *
 *   - a charge with no description prints a figure with nothing beside it;
 *   - a charge of nothing, or of a negative amount, is a discount wearing the
 *     wrong name and would be ADDED by anything summing the lines;
 *   - a discount with nobody behind it cannot be defended when the invoice is
 *     queried, and one with no amount is not a discount at all;
 *   - and a discount line in the write-once pricing snapshot has to be
 *     NEGATIVE, or the figure the customer signed cannot be recovered from it.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const JOB = '00000000-0000-4000-8000-0000000000e1';

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

describeDb('charges and discounts, on PostgreSQL', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  const seedJob = async (overrides: Record<string, unknown> = {}): Promise<void> => {
    await db.insert(schema.jobs).values({
      id: JOB,
      jobNumber: 'EJE-9101',
      jobNumberSeq: 9101,
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobTypeCode: 'service',
      priority: 'normal',
      status: 'in_progress',
      ...overrides,
    });
  };

  const charge = (overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    jobId: JOB,
    description: 'Workshop consumables',
    amountCents: 45_000,
    capturedAt: '2026-10-22T09:00:00.000Z',
    capturedBy: IDS.master,
    ...overrides,
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await seedJob();
  });

  it('stores a charge and reads it back with its own amount', async () => {
    await db.insert(schema.jobAdditionalCharges).values(charge());

    const rows = await db.select().from(schema.jobAdditionalCharges);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amountCents).toBe(45_000);
    expect(rows[0]?.description).toBe('Workshop consumables');
  });

  it('REFUSES a charge with no description, including one made of spaces', async () => {
    for (const description of ['', '   ', '\t']) {
      const said = await messageOf(
        db.insert(schema.jobAdditionalCharges).values(charge({ description })),
      );
      expect(said, JSON.stringify(description)).toMatch(/job_additional_charges_has_description/u);
    }
  });

  it('REFUSES a charge of nothing, and a negative one', async () => {
    for (const amountCents of [0, -4500]) {
      const said = await messageOf(
        db.insert(schema.jobAdditionalCharges).values(charge({ amountCents })),
      );
      expect(said, `${amountCents}`).toMatch(/job_additional_charges_amount_positive/u);
    }
  });

  it('takes its charges with the job when the job goes', async () => {
    // Cascade, like every other line: a charge is part of the job, not a
    // record about it.
    await db.insert(schema.jobAdditionalCharges).values(charge());
    await db.delete(schema.jobs);
    expect(await db.select().from(schema.jobAdditionalCharges)).toHaveLength(0);
  });

  it('stores a whole discount: amount, reason, who and when', async () => {
    await db
      .update(schema.jobs)
      .set({
        discountCents: 20_000,
        discountReason: 'Goodwill on a repeat call-out',
        discountAuthorisedBy: IDS.master,
        discountAuthorisedAt: '2026-10-22T09:30:00.000Z',
      });

    const [row] = await db.select().from(schema.jobs);
    expect(row?.discountCents).toBe(20_000);
    expect(row?.discountAuthorisedBy).toBe(IDS.master);
  });

  it('REFUSES HALF A DISCOUNT, in every direction', async () => {
    /*
     * The CHECK is written as an equivalence precisely so it refuses both
     * halves of the mistake. A NULL in a CHECK reads as satisfied, which is the
     * trap that made two earlier constraints in this schema accept the row they
     * were written to refuse — so each arm is NULL-proof and each is asserted.
     */
    const halves = [
      // An amount nobody authorised.
      { discountCents: 20_000, discountReason: 'Goodwill' },
      // An authorisation with no amount.
      { discountAuthorisedBy: IDS.master, discountAuthorisedAt: '2026-10-22T09:30:00.000Z' },
      // An amount and a person, with no time.
      { discountCents: 20_000, discountReason: 'Goodwill', discountAuthorisedBy: IDS.master },
      // A whole discount with a reason of spaces, which is no reason at all.
      {
        discountCents: 20_000,
        discountReason: '   ',
        discountAuthorisedBy: IDS.master,
        discountAuthorisedAt: '2026-10-22T09:30:00.000Z',
      },
      // A reason with no discount: a leftover that would read as one.
      { discountReason: 'Goodwill' },
    ];

    for (const half of halves) {
      const said = await messageOf(db.update(schema.jobs).set(half));
      expect(said, JSON.stringify(half)).toMatch(/jobs_discount_is_whole_or_absent/u);
    }
  });

  it('REFUSES a discount of zero or less', async () => {
    for (const discountCents of [0, -500]) {
      const said = await messageOf(
        db.update(schema.jobs).set({
          discountCents,
          discountReason: 'Goodwill',
          discountAuthorisedBy: IDS.master,
          discountAuthorisedAt: '2026-10-22T09:30:00.000Z',
        }),
      );
      expect(said, `${discountCents}`).toMatch(/jobs_discount_is_positive/u);
    }
  });

  it('keeps the four columns absent on an ordinary job', async () => {
    // The shape every existing row is in after the migration, and it has to be
    // a legal shape — otherwise the migration itself could not be applied.
    const [row] = await db.select().from(schema.jobs);
    expect(row?.discountCents).toBeNull();
    expect(row?.discountReason).toBe('');
    expect(row?.discountAuthorisedBy).toBeNull();
  });
});

describeDb('the write-once pricing snapshot, with a discount in it', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  const SNAPSHOT = '00000000-0000-4000-8000-0000000000e2';

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await db.insert(schema.jobs).values({
      id: JOB,
      jobNumber: 'EJE-9102',
      jobNumberSeq: 9102,
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobTypeCode: 'service',
      priority: 'normal',
      status: 'review',
    });
    await db.insert(schema.pricingSnapshots).values({
      id: SNAPSHOT,
      jobId: JOB,
      attempt: 1,
      labourNormalCents: 95_000,
      labourOvertimeCents: 142_500,
      labourDoubleCents: 190_000,
      calloutRateCents: 85_000,
      kilometreRateCents: 1_250,
      vatPercentBasisPoints: 1_500,
      grossSubtotalCents: 200_000,
      discountCents: 20_000,
      subtotalCents: 180_000,
      vatCents: 27_000,
      totalCents: 207_000,
      capturedAt: '2026-10-22T09:00:00.000Z',
      reason: 'customer_signature',
    });
  });

  const line = (overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    snapshotId: SNAPSHOT,
    lineKind: 'labour',
    position: 1,
    description: 'Normal Time',
    detail: 'Fault finding',
    quantity: '2.00',
    unitLabel: 'hrs',
    unitPriceCents: 95_000,
    lineTotalCents: 190_000,
    ...overrides,
  });

  it('stores a NEGATIVE discount line, which is what makes the lines add up', async () => {
    await db.insert(schema.pricingSnapshotLines).values(
      line({
        lineKind: 'discount',
        position: 2,
        description: 'Discount',
        detail: 'Goodwill on a repeat call-out',
        unitPriceCents: -20_000,
        lineTotalCents: -20_000,
      }),
    );

    const rows = await db.select().from(schema.pricingSnapshotLines);
    expect(rows[0]?.lineTotalCents).toBe(-20_000);
  });

  it('REFUSES a discount line recorded as a POSITIVE amount', async () => {
    /*
     * The one the old constraint accepted. A positive discount line would be
     * ADDED by anything summing the lines, so the record would say the customer
     * signed for the work PLUS the discount — the error in the worst direction,
     * and invisible unless somebody added it up by hand.
     */
    const said = await messageOf(
      db.insert(schema.pricingSnapshotLines).values(
        line({ lineKind: 'discount', position: 2, unitPriceCents: 20_000, lineTotalCents: 20_000 }),
      ),
    );
    expect(said).toMatch(/pricing_snapshot_lines_amounts_non_negative/u);
  });

  it('REFUSES a discount line of zero', async () => {
    const said = await messageOf(
      db.insert(schema.pricingSnapshotLines).values(
        line({ lineKind: 'discount', position: 2, unitPriceCents: 0, lineTotalCents: 0 }),
      ),
    );
    expect(said).toMatch(/pricing_snapshot_lines_amounts_non_negative/u);
  });

  it('still refuses a NEGATIVE amount on a line that is work', async () => {
    // The old rule, unchanged for every kind but the discount.
    const said = await messageOf(
      db.insert(schema.pricingSnapshotLines).values(line({ lineTotalCents: -190_000 })),
    );
    expect(said).toMatch(/pricing_snapshot_lines_amounts_non_negative/u);
  });

  it('REFUSES a snapshot whose discount exceeds the gross it was taken from', async () => {
    const said = await messageOf(
      db.insert(schema.pricingSnapshots).values({
        id: crypto.randomUUID(),
        jobId: JOB,
        attempt: 2,
        labourNormalCents: 95_000,
        labourOvertimeCents: 142_500,
        labourDoubleCents: 190_000,
        calloutRateCents: 85_000,
        kilometreRateCents: 1_250,
        vatPercentBasisPoints: 1_500,
        grossSubtotalCents: 100_000,
        discountCents: 150_000,
        subtotalCents: 0,
        vatCents: 0,
        totalCents: 0,
        capturedAt: '2026-10-22T09:00:00.000Z',
        reason: 'customer_signature',
      }),
    );
    expect(said).toMatch(/pricing_snapshots_discount_within_gross/u);
  });

  it('REFUSES half of the pair, so a pre-COST-5 snapshot cannot be imitated', async () => {
    const said = await messageOf(
      db.insert(schema.pricingSnapshots).values({
        id: crypto.randomUUID(),
        jobId: JOB,
        attempt: 3,
        labourNormalCents: 95_000,
        labourOvertimeCents: 142_500,
        labourDoubleCents: 190_000,
        calloutRateCents: 85_000,
        kilometreRateCents: 1_250,
        vatPercentBasisPoints: 1_500,
        // A gross with no discount beside it cannot be told from a snapshot
        // written before this existed, which is why it is refused.
        grossSubtotalCents: 100_000,
        subtotalCents: 100_000,
        vatCents: 15_000,
        totalCents: 115_000,
        capturedAt: '2026-10-22T09:00:00.000Z',
        reason: 'customer_signature',
      }),
    );
    expect(said).toMatch(/pricing_snapshots_discount_within_gross/u);
  });
});
