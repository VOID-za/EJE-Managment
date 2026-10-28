import { isUuid } from './identifiers';
import { and, asc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import {
  asCustomerId,
  asUserId,
  type AbsenceReason,
  type AttendanceRecord,
  type TimesheetEntry,
  type TimesheetPeriod,
  type TimesheetSubmissionSnapshot,
  type AttendanceStatus,
  type TimesheetComment,
  type UserId,
} from '@/domain';
import type { AttendanceRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

type AttendanceRow = typeof schema.attendance.$inferSelect;
type CommentRow = typeof schema.timesheetComments.$inferSelect;
type EntryRow = typeof schema.timesheetEntries.$inferSelect;
type PeriodRow = typeof schema.timesheetPeriods.$inferSelect;

const toDomainPeriod = (row: PeriodRow): TimesheetPeriod => ({
  id: row.id,
  userId: asUserId(row.userId),
  from: row.periodFrom,
  to: row.periodTo,
  comment: row.comment,
  updatedBy: asUserId(row.updatedBy),
  updatedAt: row.commentedAt,
  submittedAt: row.submittedAt,
  submittedBy: row.submittedBy === null ? null : asUserId(row.submittedBy),
  snapshot: (row.snapshot as TimesheetSubmissionSnapshot | null) ?? null,
});

const toDomainEntry = (row: EntryRow): TimesheetEntry => ({
  id: row.id,
  userId: asUserId(row.userId),
  date: row.workDate,
  customerId: row.customerId === null ? null : asCustomerId(row.customerId),
  customerName: row.customerName,
  normalHours: Number(row.normalHours),
  overtimeHours: Number(row.overtimeHours),
  doubleHours: Number(row.doubleHours),
  callouts: row.callouts,
  workshop: row.workshop,
  calloutAmount: row.calloutAmountCents,
  calloutShared: row.calloutShared,
  internalKm: Number(row.internalKm),
  customerKm: Number(row.customerKm),
  updatedBy: asUserId(row.updatedBy),
  updatedAt: row.recordedAt,
});

const toDomainRecord = (row: AttendanceRow): AttendanceRecord => ({
  id: row.id,
  userId: asUserId(row.userId),
  date: row.workDate,
  status: row.status as AttendanceStatus,
  absenceReason: (row.absenceReason as AbsenceReason | null) ?? null,
  note: row.note,
  recordedBy: asUserId(row.recordedBy),
  recordedAt: row.recordedAt,
});

const toDomainComment = (row: CommentRow): TimesheetComment => ({
  id: row.id,
  userId: asUserId(row.userId),
  date: row.workDate,
  comment: row.comment,
  updatedBy: asUserId(row.updatedBy),
  updatedAt: row.commentedAt,
});

/**
 * The attendance register and the timesheet comments in PostgreSQL. ATTEND-1,
 * TIMESHEET-1.
 *
 * A SAVE IS AN UPSERT ON (person, day), not on id: `ON CONFLICT` against the
 * unique key, so two office users recording the same person's day at once
 * produce one row with the later answer — never two rows, and never a failed
 * request for the second of them. The operation reads the day first and
 * audits what it said, which is where "what was it before" lives.
 */
export class PostgresAttendanceRepository implements AttendanceRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async listRecords(from: string, to: string, userId?: UserId): Promise<readonly AttendanceRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.attendance)
      .where(
        and(
          gte(schema.attendance.workDate, from),
          lte(schema.attendance.workDate, to),
          userId === undefined ? undefined : eq(schema.attendance.userId, userId),
        ),
      )
      .orderBy(asc(schema.attendance.workDate), asc(schema.attendance.userId));
    return rows.map(toDomainRecord);
  }

  async findRecord(userId: UserId, date: string): Promise<AttendanceRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.attendance)
      .where(and(eq(schema.attendance.userId, userId), eq(schema.attendance.workDate, date)))
      .limit(1);
    return rows[0] === undefined ? null : toDomainRecord(rows[0]);
  }

  async saveRecord(record: AttendanceRecord): Promise<AttendanceRecord> {
    const rows = await this.db
      .insert(schema.attendance)
      .values({
        id: record.id,
        userId: record.userId,
        workDate: record.date,
        status: record.status,
        absenceReason: record.absenceReason,
        note: record.note,
        recordedBy: record.recordedBy,
        recordedAt: record.recordedAt,
      })
      .onConflictDoUpdate({
        target: [schema.attendance.userId, schema.attendance.workDate],
        set: {
          status: record.status,
          absenceReason: record.absenceReason,
          note: record.note,
          recordedBy: record.recordedBy,
          recordedAt: record.recordedAt,
          updatedAt: sql`now()`,
          version: sql`${schema.attendance.version} + 1`,
        },
      })
      .returning();
    return toDomainRecord(rows[0]!);
  }

  async listComments(userId: UserId, from: string, to: string): Promise<readonly TimesheetComment[]> {
    const rows = await this.db
      .select()
      .from(schema.timesheetComments)
      .where(
        and(
          eq(schema.timesheetComments.userId, userId),
          gte(schema.timesheetComments.workDate, from),
          lte(schema.timesheetComments.workDate, to),
        ),
      )
      .orderBy(asc(schema.timesheetComments.workDate));
    return rows.map(toDomainComment);
  }

  async findComment(userId: UserId, date: string): Promise<TimesheetComment | null> {
    const rows = await this.db
      .select()
      .from(schema.timesheetComments)
      .where(
        and(eq(schema.timesheetComments.userId, userId), eq(schema.timesheetComments.workDate, date)),
      )
      .limit(1);
    return rows[0] === undefined ? null : toDomainComment(rows[0]);
  }

  async saveComment(comment: TimesheetComment): Promise<TimesheetComment> {
    const rows = await this.db
      .insert(schema.timesheetComments)
      .values({
        id: comment.id,
        userId: comment.userId,
        workDate: comment.date,
        comment: comment.comment,
        updatedBy: comment.updatedBy,
        commentedAt: comment.updatedAt,
      })
      .onConflictDoUpdate({
        target: [schema.timesheetComments.userId, schema.timesheetComments.workDate],
        set: {
          comment: comment.comment,
          updatedBy: comment.updatedBy,
          commentedAt: comment.updatedAt,
          updatedAt: sql`now()`,
          version: sql`${schema.timesheetComments.version} + 1`,
        },
      })
      .returning();
    return toDomainComment(rows[0]!);
  }

  async listEntries(userId: UserId, from: string, to: string): Promise<readonly TimesheetEntry[]> {
    const rows = await this.db
      .select()
      .from(schema.timesheetEntries)
      .where(
        and(
          eq(schema.timesheetEntries.userId, userId),
          gte(schema.timesheetEntries.workDate, from),
          lte(schema.timesheetEntries.workDate, to),
        ),
      )
      .orderBy(asc(schema.timesheetEntries.workDate), asc(schema.timesheetEntries.createdAt));
    return rows.map(toDomainEntry);
  }

  async findEntry(id: string): Promise<TimesheetEntry | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(schema.timesheetEntries)
      .where(eq(schema.timesheetEntries.id, id))
      .limit(1);
    return rows[0] === undefined ? null : toDomainEntry(rows[0]);
  }

  async saveEntry(entry: TimesheetEntry): Promise<TimesheetEntry> {
    const values = {
      workDate: entry.date,
      customerId: entry.customerId,
      customerName: entry.customerName,
      normalHours: entry.normalHours.toFixed(2),
      overtimeHours: entry.overtimeHours.toFixed(2),
      doubleHours: entry.doubleHours.toFixed(2),
      callouts: entry.callouts,
      workshop: entry.workshop,
      calloutAmountCents: entry.calloutAmount,
      calloutShared: entry.calloutShared,
      internalKm: entry.internalKm.toFixed(1),
      customerKm: entry.customerKm.toFixed(1),
      updatedBy: entry.updatedBy,
      recordedAt: entry.updatedAt,
    };
    const rows = await this.db
      .insert(schema.timesheetEntries)
      .values({ id: entry.id, userId: entry.userId, ...values })
      .onConflictDoUpdate({
        target: schema.timesheetEntries.id,
        set: { ...values, updatedAt: sql`now()`, version: sql`${schema.timesheetEntries.version} + 1` },
      })
      .returning();
    return toDomainEntry(rows[0]!);
  }

  async deleteEntry(id: string): Promise<void> {
    await this.db.delete(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, id));
  }

  async findPeriod(userId: UserId, from: string, to: string): Promise<TimesheetPeriod | null> {
    const rows = await this.db
      .select()
      .from(schema.timesheetPeriods)
      .where(
        and(
          eq(schema.timesheetPeriods.userId, userId),
          eq(schema.timesheetPeriods.periodFrom, from),
          eq(schema.timesheetPeriods.periodTo, to),
        ),
      )
      .limit(1);
    return rows[0] === undefined ? null : toDomainPeriod(rows[0]);
  }

  async listSubmittedPeriods(userId: UserId, from: string, to: string): Promise<readonly TimesheetPeriod[]> {
    const rows = await this.db
      .select()
      .from(schema.timesheetPeriods)
      .where(
        and(
          eq(schema.timesheetPeriods.userId, userId),
          isNotNull(schema.timesheetPeriods.submittedAt),
          lte(schema.timesheetPeriods.periodFrom, to),
          gte(schema.timesheetPeriods.periodTo, from),
        ),
      )
      .orderBy(asc(schema.timesheetPeriods.periodFrom));
    return rows.map(toDomainPeriod);
  }

  async savePeriodComment(period: TimesheetPeriod): Promise<TimesheetPeriod | null> {
    // The conflict update only touches a period that has not been sent; a sent
    // one returns no row, which is the refusal (the trigger would refuse too).
    const rows = await this.db
      .insert(schema.timesheetPeriods)
      .values({
        id: period.id,
        userId: period.userId,
        periodFrom: period.from,
        periodTo: period.to,
        comment: period.comment,
        updatedBy: period.updatedBy,
        commentedAt: period.updatedAt,
      })
      .onConflictDoUpdate({
        target: [schema.timesheetPeriods.userId, schema.timesheetPeriods.periodFrom, schema.timesheetPeriods.periodTo],
        set: {
          comment: period.comment,
          updatedBy: period.updatedBy,
          commentedAt: period.updatedAt,
          updatedAt: sql`now()`,
          version: sql`${schema.timesheetPeriods.version} + 1`,
        },
        setWhere: isNull(schema.timesheetPeriods.submittedAt),
      })
      .returning();
    return rows[0] === undefined ? null : toDomainPeriod(rows[0]);
  }

  async submitPeriod(period: TimesheetPeriod): Promise<TimesheetPeriod | null> {
    const rows = await this.db
      .insert(schema.timesheetPeriods)
      .values({
        id: period.id,
        userId: period.userId,
        periodFrom: period.from,
        periodTo: period.to,
        comment: period.comment,
        updatedBy: period.updatedBy,
        commentedAt: period.updatedAt,
        submittedAt: period.submittedAt,
        submittedBy: period.submittedBy,
        snapshot: period.snapshot,
      })
      .onConflictDoUpdate({
        target: [schema.timesheetPeriods.userId, schema.timesheetPeriods.periodFrom, schema.timesheetPeriods.periodTo],
        set: {
          submittedAt: period.submittedAt,
          submittedBy: period.submittedBy,
          snapshot: period.snapshot,
          updatedAt: sql`now()`,
          version: sql`${schema.timesheetPeriods.version} + 1`,
        },
        setWhere: isNull(schema.timesheetPeriods.submittedAt),
      })
      .returning();
    return rows[0] === undefined ? null : toDomainPeriod(rows[0]);
  }

  async deleteComment(userId: UserId, date: string): Promise<void> {
    await this.db
      .delete(schema.timesheetComments)
      .where(
        and(eq(schema.timesheetComments.userId, userId), eq(schema.timesheetComments.workDate, date)),
      );
  }
}
