import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  asUserId,
  type AttendanceRecord,
  type AttendanceStatus,
  type TimesheetComment,
  type UserId,
} from '@/domain';
import type { AttendanceRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

type AttendanceRow = typeof schema.attendance.$inferSelect;
type CommentRow = typeof schema.timesheetComments.$inferSelect;

const toDomainRecord = (row: AttendanceRow): AttendanceRecord => ({
  id: row.id,
  userId: asUserId(row.userId),
  date: row.workDate,
  status: row.status as AttendanceStatus,
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
        note: record.note,
        recordedBy: record.recordedBy,
        recordedAt: record.recordedAt,
      })
      .onConflictDoUpdate({
        target: [schema.attendance.userId, schema.attendance.workDate],
        set: {
          status: record.status,
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

  async deleteComment(userId: UserId, date: string): Promise<void> {
    await this.db
      .delete(schema.timesheetComments)
      .where(
        and(eq(schema.timesheetComments.userId, userId), eq(schema.timesheetComments.workDate, date)),
      );
  }
}
