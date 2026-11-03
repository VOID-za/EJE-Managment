import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { asLineItemId, asUserId, STANDBY_POSITIONS, type StandbyWeek, type TimesheetPeriod } from '@/domain';
import type { Database } from '@/db/client';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresJobRepository } from './job-repository';
import { PostgresAttendanceRepository } from './attendance-repository';
import { PostgresStandbyRepository } from './standby-repository';

/**
 * MIGRATION 0048 ON PostgreSQL — 3 November 2026.
 *
 * The Delivery Note job type (DELIVERY-NOTE-1): its delivery date and part
 * comments persist, and the database itself refuses a price, a labour line,
 * a call-out or the invoicing workflow on one. Overlapping timesheet
 * submissions (TS-OVERLAP-1): an earlier one is superseded, never deleted,
 * and only one is current for any day. A Senior Tech on the main and helper
 * standby places, never an apprentice place (STANDBY-ELIG-2).
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;
const NOW = '2026-11-03T08:00:00.000Z';
const TECH = asUserId(IDS.technician);

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    const error = cause as { message?: string; cause?: { message?: string } };
    return `${error.message ?? ''} ${error.cause?.message ?? ''}`;
  }
  throw new Error('expected the database to refuse the statement');
};

describeDb('migration 0048 — Delivery Notes, overlapping timesheets, Senior Tech standby', () => {
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

  const deliveryNote = async () => {
    const jobs = new PostgresJobRepository(db);
    const allocated = await jobs.allocateJobNumber();
    return jobs.save(
      jobFixture(allocated.jobNumber, {
        jobType: 'delivery_note',
        status: 'completion',
        primaryTechnicianId: null,
        deliveryDate: '2026-11-03',
        parts: [
          { id: asLineItemId(crypto.randomUUID()), partNumber: 'LU-200', description: 'Loan servo drive', quantity: 1, unitPrice: 0, comment: 'Loan unit', capturedAt: NOW, capturedBy: asUserId(IDS.coordinator) },
        ],
      }),
    );
  };

  it('DELIVERY-NOTE-1: the job type is on file; the delivery date and the part comment persist', async () => {
    const [row] = await db.execute<{ label: string }>(sql`select label from job_types where code = 'delivery_note'`);
    expect(row?.label).toBe('Delivery Note');
    const job = await deliveryNote();
    const read = await new PostgresJobRepository(db).findById(job.id);
    expect(read?.jobType).toBe('delivery_note');
    expect(read?.deliveryDate).toBe('2026-11-03');
    expect(read?.parts.map((part) => [part.partNumber, part.unitPrice, part.comment])).toEqual([['LU-200', 0, 'Loan unit']]);
  });

  it('DELIVERY-NOTE-1: the database refuses a price, a labour line, a call-out and the invoicing workflow', async () => {
    const job = await deliveryNote();
    expect(await refusal(db.execute(sql`update job_parts set unit_price_cents = 1500 where job_id = ${job.id}`))).toMatch(/carries no price/u);
    expect(await refusal(db.execute(sql`insert into job_labour (id, job_id, technician_id, work_date, rate_type, hours, description, captured_at)
      values (${crypto.randomUUID()}, ${job.id}, ${IDS.technician}, '2026-11-03', 'normal', 1, 'x', now())`))).toMatch(/carries no job_labour line|carries no/u);
    expect(await refusal(db.execute(sql`update jobs set callout_applied = true where id = ${job.id}`))).toMatch(/no call-out/u);
    for (const status of ['office_handling', 'awaiting_po', 'awaiting_invoice_no', 'invoiced']) {
      expect(await refusal(db.execute(sql`update jobs set status = ${status}::job_status where id = ${job.id}`))).toMatch(/never enters the invoicing workflow/u);
    }
    // Closing it is allowed: that is where a signed Delivery Note goes.
    await db.execute(sql`update jobs set status = 'closed', closed_at = now() where id = ${job.id}`);
    // Every other job type is untouched by the guard.
    const jobs = new PostgresJobRepository(db);
    const allocated = await jobs.allocateJobNumber();
    const ordinary = await jobs.save(jobFixture(allocated.jobNumber));
    await db.execute(sql`update jobs set callout_applied = true where id = ${ordinary.id}`);
  });

  const period = (from: string, to: string): TimesheetPeriod => ({
    id: crypto.randomUUID(),
    userId: TECH,
    from,
    to,
    comment: '',
    updatedBy: TECH,
    updatedAt: NOW,
    submittedAt: NOW,
    submittedBy: TECH,
    snapshot: { technicianName: 'Sipho Mahlangu', from, to, comment: '', entries: [] },
  });

  it('TS-OVERLAP-1: an overlapping submission supersedes the earlier one; one current per day; nothing deleted', async () => {
    const attendance = new PostgresAttendanceRepository(db);
    const first = (await attendance.submitPeriod(period('2026-10-01', '2026-10-31')))!;
    // Without superseding first, the guard refuses a second current submission for the same days.
    expect(await refusal(attendance.submitPeriod(period('2026-10-15', '2026-11-14')))).toMatch(/overlaps a period already sent/u);
    const replaced = await attendance.supersedeOverlappingPeriods({ userId: TECH, from: '2026-10-15', to: '2026-11-14', exceptId: null, at: NOW, by: TECH });
    expect(replaced.map((row) => row.id)).toEqual([first.id]);
    const second = (await attendance.submitPeriod(period('2026-10-15', '2026-11-14')))!;
    expect((await attendance.listSubmittedPeriods(TECH, '2026-09-01', '2026-12-31')).map((row) => row.id)).toEqual([second.id]);
    // Kept, not deleted; and current again only by being SENT again.
    expect((await attendance.findPeriod(TECH, '2026-10-01', '2026-10-31'))?.supersededAt).toBeTruthy();
    expect(await refusal(db.execute(sql`update timesheet_periods set superseded_at = null where id = ${first.id}`))).toMatch(/current again only when it is sent again/u);
    expect(await refusal(db.execute(sql`delete from timesheet_periods where id = ${first.id}`))).toMatch(/cannot be deleted/u);
    await attendance.supersedeOverlappingPeriods({ userId: TECH, from: '2026-10-01', to: '2026-10-31', exceptId: first.id, at: NOW, by: TECH });
    const again = await attendance.resubmitPeriod({ ...first, submittedAt: new Date(Date.now() + 1000).toISOString() });
    expect(again?.supersededAt ?? null).toBeNull();
    expect((await attendance.listSubmittedPeriods(TECH, '2026-09-01', '2026-12-31')).map((row) => row.id)).toEqual([first.id]);
  });

  it('STANDBY-ELIG-2: a Senior Tech stands in a main place, never an apprentice place', async () => {
    const standby = new PostgresStandbyRepository(db);
    const master = asUserId(IDS.master);
    await standby.saveEligibility({ userId: master, main: true, helper: true, apprentice: false, updatedBy: asUserId(IDS.coordinator), updatedAt: NOW });
    const week = (weekStart: string, holders: Partial<Record<(typeof STANDBY_POSITIONS)[number], string>>): StandbyWeek => ({
      id: crypto.randomUUID(), weekStart, status: 'draft', publishedBy: null, publishedAt: null, createdBy: asUserId(IDS.master), createdAt: NOW,
      assignments: STANDBY_POSITIONS.map((position) => ({
        position,
        userId: holders[position] === undefined ? null : asUserId(holders[position]!),
        assignedBy: holders[position] === undefined ? null : asUserId(IDS.master),
        assignedAt: holders[position] === undefined ? null : NOW,
      })),
    });
    await standby.createWeeks([week('2027-03-01', { main: IDS.master })]);
    expect((await standby.findWeek('2027-03-01'))?.assignments.find((place) => place.position === 'main')?.userId).toBe(IDS.master);
    // Even with an apprentice tick written behind the application's back, the database refuses the place.
    await db.execute(sql`update standby_eligibility set may_apprentice = true where user_id = ${IDS.master}`);
    expect(await refusal(db.execute(sql`update standby_assignments set user_id = ${IDS.master}
      where position = 'apprentice_1' and week_id = (select id from standby_weeks where week_start = '2027-03-01')`))).toMatch(/technician, apprentice or Senior Tech/u);
    // An Office account still never stands by.
    await standby.saveEligibility({ userId: asUserId(IDS.coordinator), main: true, helper: false, apprentice: false, updatedBy: asUserId(IDS.master), updatedAt: NOW });
    expect(await refusal(db.execute(sql`update standby_assignments set user_id = ${IDS.coordinator}
      where position = 'helper' and week_id = (select id from standby_weeks where week_start = '2027-03-01')`))).toMatch(/technician, apprentice or Senior Tech/u);
  });
});
