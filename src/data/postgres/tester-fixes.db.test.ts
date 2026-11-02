import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { asUserId } from '@/domain';
import type { Database } from '@/db/client';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresJobRepository } from './job-repository';
import { PostgresAttendanceRepository } from './attendance-repository';
import { PostgresPayrollRepository } from './payroll-repository';
import { PostgresActivityRepository } from './activity-repository';
import { PostgresNotificationRepository } from './notification-repository';
import { withTransaction } from './transaction';

/**
 * MIGRATION 0046 ON PostgreSQL — the tester's critical fixes, 2 November 2026.
 *
 * What the database itself now allows and still refuses: the PO number
 * (INV-FLOW-1), replacing a monthly submission and re-sending a timesheet
 * period (RESUBMIT-1), deleting a correction only inside a resubmission, and
 * deleting an activity event only through the 7-day retention purge (RETAIN-2)
 * — plus the notification purge (RETAIN-1).
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    const error = cause as { message?: string; cause?: { message?: string } };
    return `${error.message ?? ''} ${error.cause?.message ?? ''}`;
  }
  throw new Error('expected the database to refuse the statement');
};

const MASTER = asUserId(IDS.master);
const TECH = asUserId(IDS.technician);
const NOW = new Date().toISOString();
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describeDb('migration 0046 — the tester’s fixes of 2 November 2026', () => {
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

  it('INV-FLOW-1: Awaiting Invoice No needs a PO, which is whole and never rewritten', async () => {
    const jobs = new PostgresJobRepository(db);
    const allocated = await jobs.allocateJobNumber();
    const job = await jobs.save(
      jobFixture(allocated.jobNumber, {
        machineId: null,
        status: 'awaiting_po',
        officeHandling: { handledBy: MASTER, handledAt: NOW },
      }),
    );
    expect(await refusal(db.execute(sql`update jobs set status = 'awaiting_invoice_no' where id = ${job.id}`))).toMatch(/jobs_awaiting_invoice_no_has_po/u);
    expect(await refusal(db.execute(sql`update jobs set po_number = 'PO-1' where id = ${job.id}`))).toMatch(/jobs_po_is_whole_or_absent/u);
    const fresh = (await new PostgresJobRepository(db).findById(job.id))!;
    const withPo = await new PostgresJobRepository(db).save({
      ...fresh,
      status: 'awaiting_invoice_no',
      purchaseOrder: { number: 'PO-1', recordedBy: MASTER, recordedAt: NOW },
    });
    expect(withPo.purchaseOrder?.number).toBe('PO-1');
    expect((await new PostgresJobRepository(db).findById(job.id))?.status).toBe('awaiting_invoice_no');
    expect(await refusal(db.execute(sql`update jobs set po_number = 'PO-2' where id = ${job.id}`))).toMatch(/never rewritten/u);
  });

  const sentPeriod = async () => {
    const attendance = new PostgresAttendanceRepository(db);
    const sent = await attendance.submitPeriod({
      id: crypto.randomUUID(),
      userId: TECH,
      from: '2026-09-01',
      to: '2026-09-30',
      comment: 'first',
      updatedBy: TECH,
      updatedAt: NOW,
      submittedAt: NOW,
      submittedBy: TECH,
      snapshot: { technicianName: 'Sipho Mahlangu', from: '2026-09-01', to: '2026-09-30', comment: 'first', entries: [] },
    });
    return { attendance, sent: sent! };
  };

  it('RESUBMIT-1: a sent timesheet period is sent again in place; never unsent, moved or deleted', async () => {
    const { attendance, sent } = await sentPeriod();
    const later = new Date(Date.now() + 1000).toISOString();
    const again = await attendance.resubmitPeriod({
      ...sent,
      comment: 'second',
      submittedAt: later,
      snapshot: { ...sent.snapshot!, comment: 'second' },
    });
    expect(again?.id).toBe(sent.id);
    expect(again?.snapshot?.comment).toBe('second');
    expect(await refusal(db.execute(sql`update timesheet_periods set submitted_at = null, submitted_by = null, snapshot = null where id = ${sent.id}`))).toMatch(/never moved or unsent|submission_whole/u);
    expect(await refusal(db.execute(sql`update timesheet_periods set period_to = '2026-09-29' where id = ${sent.id}`))).toMatch(/never moved or unsent/u);
    expect(await refusal(db.execute(sql`delete from timesheet_periods where id = ${sent.id}`))).toMatch(/cannot be deleted/u);
  });

  it('RESUBMIT-1: a monthly submission is replaced in place; never moved or deleted', async () => {
    const { sent } = await sentPeriod();
    const payroll = new PostgresPayrollRepository(db);
    const created = await payroll.createSubmission({
      id: crypto.randomUUID(),
      userId: TECH,
      month: '2026-09',
      timesheetPeriodId: sent.id,
      attendance: { technicianName: 'Sipho Mahlangu', month: '2026-09', days: [] },
      submittedAt: NOW,
      submittedBy: TECH,
    });
    const replaced = await payroll.replaceSubmission({
      ...created!,
      attendance: { technicianName: 'Sipho Mahlangu', month: '2026-09', days: [{ date: '2026-09-01', status: 'present', absenceReason: null, note: '' }] },
      submittedAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(replaced.id).toBe(created!.id);
    expect(replaced.attendance.days).toHaveLength(1);
    const rows = await db.execute(sql`select count(*)::int as n from monthly_submissions`);
    expect(Number((rows as unknown as { n: number }[])[0]?.n)).toBe(1);
    expect(await refusal(db.execute(sql`update monthly_submissions set month = '2026-08' where id = ${created!.id}`))).toMatch(/never moved/u);
    expect(await refusal(db.execute(sql`delete from monthly_submissions where id = ${created!.id}`))).toMatch(/cannot be deleted/u);
  });

  it('RESUBMIT-1: a correction is deleted only inside a resubmission of its period', async () => {
    const { attendance, sent } = await sentPeriod();
    const correction = await attendance.createCorrection({
      id: crypto.randomUUID(),
      periodId: sent.id,
      userId: TECH,
      sequence: 1,
      reason: 'Wrong OT',
      before: sent.snapshot!,
      after: { ...sent.snapshot!, comment: 'fixed' },
      requestedBy: TECH,
      requestedAt: NOW,
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      decisionNote: '',
    });
    expect(correction).not.toBeNull();
    expect(await refusal(db.execute(sql`delete from timesheet_corrections where id = ${correction!.id}`))).toMatch(/cannot be deleted/u);
    await withTransaction(db, async (tx) => new PostgresAttendanceRepository(tx).deleteCorrections(sent.id));
    expect(await attendance.listCorrections(sent.id)).toHaveLength(0);
  });

  it('RETAIN-2: an activity event is never updated, and is deleted only by the purge, only when older than 7 days (the message keeps "immutable historical record")', async () => {
    for (const [id, age] of [[crypto.randomUUID(), 10], [crypto.randomUUID(), 3]] as const) {
      await db.execute(sql`insert into audit_events (id, occurred_at, type, summary) values (${id}, ${daysAgo(age)}, 'settings_updated', ${`aged ${age}`})`);
    }
    expect(await refusal(db.execute(sql`delete from audit_events`))).toMatch(/append-only/u);
    expect(await refusal(db.execute(sql`update audit_events set summary = 'changed'`))).toMatch(/append-only/u);
    // Even with the purge's flag, a recent event cannot be deleted.
    expect(
      await refusal(
        withTransaction(db, async (tx) => {
          await tx.execute(sql`select set_config('eje.retention', 'on', true)`);
          await tx.execute(sql`delete from audit_events where summary = 'aged 3'`);
        }),
      ),
    ).toMatch(/append-only/u);
    const deleted = await withTransaction(db, async (tx) => new PostgresActivityRepository(tx).purgeOccurredBefore(daysAgo(7)));
    expect(deleted).toBe(1);
    const left = await db.execute(sql`select summary from audit_events order by summary`);
    expect((left as unknown as { summary: string }[]).map((row) => row.summary)).toEqual(['aged 3']);
    // The flag is local to the purge's transaction: a later delete is refused again.
    expect(await refusal(db.execute(sql`delete from audit_events`))).toMatch(/append-only/u);
  });

  it('RETAIN-1: notifications 15 days old or older are deleted — notifications only', async () => {
    for (const [title, age] of [['old', 16], ['fresh', 2]] as const) {
      await db.execute(sql`insert into notifications (id, recipient_id, type, title, channels, created_at) values (${crypto.randomUUID()}, ${IDS.master}, 'job_assigned', ${title}, '{in_app}', ${daysAgo(age)})`);
    }
    const users = await db.execute(sql`select count(*)::int as n from users`);
    const deleted = await new PostgresNotificationRepository(db).purgeCreatedAtOrBefore(daysAgo(15));
    expect(deleted).toBe(1);
    expect((await new PostgresNotificationRepository(db).list(MASTER)).map((n) => n.title)).toEqual(['fresh']);
    expect(await db.execute(sql`select count(*)::int as n from users`)).toEqual(users);
  });
});
