import { isUuid } from './identifiers';
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  asCustomerId,
  asUserId,
  type AbsenceReason,
  type AttendanceRecord,
  type TimesheetEntry,
  type TimesheetPeriod,
  type TimesheetCorrection,
  type TimesheetCorrectionStatus,
  type TimesheetSubmissionSnapshot,
  type AttendanceStatus,
  type TimesheetComment,
  type TimesheetWorkingComment,
  type TimesheetLineDraft,
  type TimesheetLineRemoval,
  type TimesheetLineTyped,
  type UserId,
} from '@/domain';
import type { AttendanceRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

type AttendanceRow = typeof schema.attendance.$inferSelect;
type CommentRow = typeof schema.timesheetComments.$inferSelect;
type EntryRow = typeof schema.timesheetEntries.$inferSelect;
type PeriodRow = typeof schema.timesheetPeriods.$inferSelect;
type CorrectionRow = typeof schema.timesheetCorrections.$inferSelect;
type DraftRow = typeof schema.timesheetLineDrafts.$inferSelect;

const toLineDraft = (row: DraftRow): TimesheetLineDraft => ({
  id: row.id,
  userId: asUserId(row.userId),
  date: row.workDate,
  typed: row.typed as TimesheetLineTyped,
  updatedBy: asUserId(row.updatedBy),
  updatedAt: row.updatedAt,
});

const toDomainCorrection = (row: CorrectionRow): TimesheetCorrection => ({
  id: row.id,
  periodId: row.periodId,
  userId: asUserId(row.userId),
  sequence: row.sequence,
  reason: row.reason,
  before: row.beforeSnapshot as TimesheetSubmissionSnapshot,
  after: row.afterSnapshot as TimesheetSubmissionSnapshot,
  requestedBy: asUserId(row.requestedBy),
  requestedAt: row.requestedAt,
  status: row.status as TimesheetCorrectionStatus,
  decidedBy: row.decidedBy === null ? null : asUserId(row.decidedBy),
  decidedAt: row.decidedAt,
  decisionNote: row.decisionNote,
});

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
  supersededAt: row.supersededAt ?? null,
  supersededBy: row.supersededBy === null || row.supersededBy === undefined ? null : asUserId(row.supersededBy),
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

  async deleteRecord(id: string): Promise<void> {
    await this.db.delete(schema.attendance).where(eq(schema.attendance.id, id));
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
      // PAYROLL-ONE-1 (0052): a replaced period may share its dates with its replacement; the current one is meant.
      .orderBy(sql`${schema.timesheetPeriods.supersededAt} is not null`)
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
          isNull(schema.timesheetPeriods.supersededAt),
          lte(schema.timesheetPeriods.periodFrom, to),
          gte(schema.timesheetPeriods.periodTo, from),
        ),
      )
      .orderBy(asc(schema.timesheetPeriods.periodFrom));
    return rows.map(toDomainPeriod);
  }

  async supersedeOverlappingPeriods(input: {
    readonly userId: UserId;
    readonly from: string;
    readonly to: string;
    readonly exceptId: string | null;
    readonly at: string;
    readonly by: UserId;
  }): Promise<readonly TimesheetPeriod[]> {
    // The guard serialises one person's submissions; this takes the same lock first.
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtext('timesheet_periods:' || ${input.userId}::text))`);
    const rows = await this.db
      .update(schema.timesheetPeriods)
      .set({ supersededAt: input.at, supersededBy: input.by, updatedAt: sql`now()`, version: sql`${schema.timesheetPeriods.version} + 1` })
      .where(
        and(
          eq(schema.timesheetPeriods.userId, input.userId),
          isNotNull(schema.timesheetPeriods.submittedAt),
          isNull(schema.timesheetPeriods.supersededAt),
          lte(schema.timesheetPeriods.periodFrom, input.to),
          gte(schema.timesheetPeriods.periodTo, input.from),
          // TS-PAPER-7: only a submission these dates cover in full is ever replaced.
          gte(schema.timesheetPeriods.periodFrom, input.from),
          lte(schema.timesheetPeriods.periodTo, input.to),
          ...(input.exceptId !== null && isUuid(input.exceptId) ? [ne(schema.timesheetPeriods.id, input.exceptId)] : []),
        ),
      )
      .returning();
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
        targetWhere: isNull(schema.timesheetPeriods.supersededAt),
        set: {
          comment: period.comment,
          updatedBy: period.updatedBy,
          commentedAt: period.updatedAt,
          updatedAt: sql`now()`,
          version: sql`${schema.timesheetPeriods.version} + 1`,
        },
        // RESUBMIT-1: a sent period's comment may change too; sending again replaces the sent one.
      })
      .returning();
    return rows[0] === undefined ? null : toDomainPeriod(rows[0]);
  }


  async findPeriodById(id: string): Promise<TimesheetPeriod | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, id)).limit(1);
    return rows[0] === undefined ? null : toDomainPeriod(rows[0]);
  }

  async listSubmissions(userId: UserId | null): Promise<readonly TimesheetPeriod[]> {
    const rows = await this.db
      .select()
      .from(schema.timesheetPeriods)
      .where(
        and(
          isNotNull(schema.timesheetPeriods.submittedAt),
          ...(userId === null ? [] : [eq(schema.timesheetPeriods.userId, userId)]),
        ),
      )
      .orderBy(desc(schema.timesheetPeriods.periodTo), desc(schema.timesheetPeriods.submittedAt));
    return rows.map(toDomainPeriod);
  }

  async findWorkingComment(userId: UserId): Promise<TimesheetWorkingComment | null> {
    const rows = await this.db
      .select()
      .from(schema.timesheetWorkingComments)
      .where(eq(schema.timesheetWorkingComments.userId, userId))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : { userId: asUserId(row.userId), comment: row.comment, updatedBy: asUserId(row.updatedBy), updatedAt: row.updatedAt };
  }

  async saveWorkingComment(comment: TimesheetWorkingComment): Promise<TimesheetWorkingComment> {
    const rows = await this.db
      .insert(schema.timesheetWorkingComments)
      .values({ userId: comment.userId, comment: comment.comment, updatedBy: comment.updatedBy })
      .onConflictDoUpdate({
        target: schema.timesheetWorkingComments.userId,
        set: {
          comment: comment.comment,
          updatedBy: comment.updatedBy,
          updatedAt: sql`now()`,
          version: sql`${schema.timesheetWorkingComments.version} + 1`,
        },
      })
      .returning();
    const row = rows[0]!;
    return { userId: asUserId(row.userId), comment: row.comment, updatedBy: asUserId(row.updatedBy), updatedAt: row.updatedAt };
  }

  async listLineDrafts(userId: UserId): Promise<readonly TimesheetLineDraft[]> {
    const rows = await this.db
      .select()
      .from(schema.timesheetLineDrafts)
      .where(eq(schema.timesheetLineDrafts.userId, userId))
      .orderBy(sql`${schema.timesheetLineDrafts.workDate} asc nulls last`, asc(schema.timesheetLineDrafts.updatedAt));
    return rows.map(toLineDraft);
  }

  async findLineDraft(id: string): Promise<TimesheetLineDraft | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.select().from(schema.timesheetLineDrafts).where(eq(schema.timesheetLineDrafts.id, id)).limit(1);
    return rows[0] === undefined ? null : toLineDraft(rows[0]);
  }

  async saveLineDraft(draft: TimesheetLineDraft): Promise<TimesheetLineDraft> {
    const rows = await this.db
      .insert(schema.timesheetLineDrafts)
      .values({ id: draft.id, userId: draft.userId, workDate: draft.date, typed: draft.typed, updatedBy: draft.updatedBy, updatedAt: draft.updatedAt })
      .onConflictDoUpdate({
        target: schema.timesheetLineDrafts.id,
        set: {
          workDate: draft.date,
          typed: draft.typed,
          updatedBy: draft.updatedBy,
          updatedAt: draft.updatedAt,
          version: sql`${schema.timesheetLineDrafts.version} + 1`,
        },
        // A draft is only ever its own person's: an id of somebody else's is never overwritten.
        setWhere: eq(schema.timesheetLineDrafts.userId, draft.userId),
      })
      .returning();
    if (rows[0] === undefined) throw new Error(`timesheet line draft ${draft.id} belongs to somebody else`);
    return toLineDraft(rows[0]);
  }

  async lockLine(id: string): Promise<() => void> {
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtext('timesheet_line:' || ${id}))`);
    // Held until the request's transaction ends.
    return () => undefined;
  }

  async findLineRemoval(id: string): Promise<TimesheetLineRemoval | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.select().from(schema.timesheetLineRemovals).where(eq(schema.timesheetLineRemovals.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : { id: row.id, userId: asUserId(row.userId), removedBy: asUserId(row.removedBy), removedAt: row.removedAt };
  }

  async recordLineRemoval(removal: TimesheetLineRemoval): Promise<void> {
    if (!isUuid(removal.id)) return;
    await this.db
      .insert(schema.timesheetLineRemovals)
      .values({ id: removal.id, userId: removal.userId, removedBy: removal.removedBy, removedAt: removal.removedAt })
      .onConflictDoNothing();
  }

  async deleteLineDraft(id: string): Promise<void> {
    if (!isUuid(id)) return;
    await this.db.delete(schema.timesheetLineDrafts).where(eq(schema.timesheetLineDrafts.id, id));
  }

  async deleteCorrections(periodId: string): Promise<void> {
    if (!isUuid(periodId)) return;
    // The guard trigger allows this delete only inside a resubmission (migration 0046).
    await this.db.execute(sql`select set_config('eje.replacing_submission', 'on', true)`);
    await this.db.delete(schema.timesheetCorrections).where(eq(schema.timesheetCorrections.periodId, periodId));
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
        targetWhere: isNull(schema.timesheetPeriods.supersededAt),
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

  async listCorrections(periodId: string): Promise<readonly TimesheetCorrection[]> {
    if (!isUuid(periodId)) return [];
    const rows = await this.db
      .select()
      .from(schema.timesheetCorrections)
      .where(eq(schema.timesheetCorrections.periodId, periodId))
      .orderBy(asc(schema.timesheetCorrections.sequence));
    return rows.map(toDomainCorrection);
  }

  async findCorrection(id: string): Promise<TimesheetCorrection | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(schema.timesheetCorrections)
      .where(eq(schema.timesheetCorrections.id, id))
      .limit(1);
    return rows[0] === undefined ? null : toDomainCorrection(rows[0]);
  }

  async listPendingCorrections(): Promise<readonly TimesheetCorrection[]> {
    const rows = await this.db
      .select()
      .from(schema.timesheetCorrections)
      .where(eq(schema.timesheetCorrections.status, 'pending'))
      .orderBy(asc(schema.timesheetCorrections.requestedAt));
    return rows.map(toDomainCorrection);
  }

  async createCorrection(correction: TimesheetCorrection): Promise<TimesheetCorrection | null> {
    // Any unique conflict — a pending correction already open for the period,
    // or the sequence taken — is "not created", never a second row.
    const rows = await this.db
      .insert(schema.timesheetCorrections)
      .values({
        id: correction.id,
        periodId: correction.periodId,
        userId: correction.userId,
        sequence: correction.sequence,
        reason: correction.reason,
        beforeSnapshot: correction.before,
        afterSnapshot: correction.after,
        requestedBy: correction.requestedBy,
        requestedAt: correction.requestedAt,
        status: 'pending',
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] === undefined ? null : toDomainCorrection(rows[0]);
  }

  async decideCorrection(decision: {
    readonly id: string;
    readonly status: 'accepted' | 'rejected';
    readonly decidedBy: UserId;
    readonly decidedAt: string;
    readonly decisionNote: string;
  }): Promise<TimesheetCorrection | null> {
    if (!isUuid(decision.id)) return null;
    const rows = await this.db
      .update(schema.timesheetCorrections)
      .set({
        status: decision.status,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        decisionNote: decision.decisionNote,
        updatedAt: sql`now()`,
        version: sql`${schema.timesheetCorrections.version} + 1`,
      })
      .where(and(eq(schema.timesheetCorrections.id, decision.id), eq(schema.timesheetCorrections.status, 'pending')))
      .returning();
    return rows[0] === undefined ? null : toDomainCorrection(rows[0]);
  }

  async deleteComment(userId: UserId, date: string): Promise<void> {
    await this.db
      .delete(schema.timesheetComments)
      .where(
        and(eq(schema.timesheetComments.userId, userId), eq(schema.timesheetComments.workDate, date)),
      );
  }
}
