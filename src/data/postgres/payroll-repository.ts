import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  asUserId,
  type AttendanceSnapshot,
  type FinancePackage,
  type FinancePackageAttachment,
  type FinancePackageStatus,
  type MonthlySubmission,
  type UserId,
} from '@/domain';
import type { PayrollRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { isUuid } from './identifiers';

type SubmissionRow = typeof schema.monthlySubmissions.$inferSelect;
type PackageRow = typeof schema.financePackages.$inferSelect;

const toSubmission = (row: SubmissionRow): MonthlySubmission => ({
  id: row.id,
  userId: asUserId(row.userId),
  month: row.month,
  timesheetPeriodId: row.timesheetPeriodId,
  attendance: row.attendanceSnapshot as AttendanceSnapshot,
  submittedAt: row.submittedAt,
  submittedBy: asUserId(row.submittedBy),
});

const toPackage = (row: PackageRow): FinancePackage => ({
  id: row.id,
  month: row.month,
  status: row.status as FinancePackageStatus,
  recipient: row.recipient,
  attachments: row.manifest as FinancePackageAttachment[],
  totalBytes: row.totalBytes,
  preparedBy: asUserId(row.preparedBy),
  preparedAt: row.preparedAt,
  sentBy: row.sentBy === null ? null : asUserId(row.sentBy),
  sendStartedAt: row.sendStartedAt,
  sentAt: row.sentAt,
  providerMessageId: row.providerMessageId,
  providerState: row.providerState,
  failureReason: row.failureReason,
  failureKind: row.failureKind,
  attempts: row.attempts,
});

/** Monthly submissions and Finance packages, in PostgreSQL. PAY-02, PAY-05…08. */
export class PostgresPayrollRepository implements PayrollRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async findSubmission(userId: UserId, month: string): Promise<MonthlySubmission | null> {
    const rows = await this.db
      .select()
      .from(schema.monthlySubmissions)
      .where(and(eq(schema.monthlySubmissions.userId, userId), eq(schema.monthlySubmissions.month, month)))
      .limit(1);
    return rows[0] === undefined ? null : toSubmission(rows[0]);
  }

  async listSubmissions(month: string): Promise<readonly MonthlySubmission[]> {
    const rows = await this.db.select().from(schema.monthlySubmissions).where(eq(schema.monthlySubmissions.month, month));
    return rows.map(toSubmission);
  }

  async listSubmissionsFor(userId: UserId): Promise<readonly MonthlySubmission[]> {
    const rows = await this.db
      .select()
      .from(schema.monthlySubmissions)
      .where(eq(schema.monthlySubmissions.userId, userId))
      .orderBy(desc(schema.monthlySubmissions.month));
    return rows.map(toSubmission);
  }

  async createSubmission(submission: MonthlySubmission): Promise<MonthlySubmission | null> {
    const rows = await this.db
      .insert(schema.monthlySubmissions)
      .values({
        id: submission.id,
        userId: submission.userId,
        month: submission.month,
        timesheetPeriodId: submission.timesheetPeriodId,
        attendanceSnapshot: submission.attendance,
        submittedAt: submission.submittedAt,
        submittedBy: submission.submittedBy,
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] === undefined ? null : toSubmission(rows[0]);
  }

  async findPackage(id: string): Promise<FinancePackage | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.select().from(schema.financePackages).where(eq(schema.financePackages.id, id)).limit(1);
    return rows[0] === undefined ? null : toPackage(rows[0]);
  }

  async listPackages(month: string): Promise<readonly FinancePackage[]> {
    const rows = await this.db
      .select()
      .from(schema.financePackages)
      .where(eq(schema.financePackages.month, month))
      .orderBy(desc(schema.financePackages.preparedAt));
    return rows.map(toPackage);
  }

  async createPackage(financePackage: FinancePackage): Promise<FinancePackage | null> {
    const rows = await this.db
      .insert(schema.financePackages)
      .values({
        id: financePackage.id,
        month: financePackage.month,
        status: 'prepared',
        recipient: financePackage.recipient,
        manifest: financePackage.attachments,
        attachmentCount: financePackage.attachments.length,
        totalBytes: financePackage.totalBytes,
        preparedBy: financePackage.preparedBy,
        preparedAt: financePackage.preparedAt,
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] === undefined ? null : toPackage(rows[0]);
  }

  async transitionPackage(
    id: string,
    from: readonly FinancePackageStatus[],
    to: FinancePackageStatus,
    patch: Partial<Pick<FinancePackage, 'sentBy' | 'sendStartedAt' | 'sentAt' | 'providerMessageId' | 'providerState' | 'failureReason' | 'failureKind' | 'attempts'>>,
  ): Promise<FinancePackage | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .update(schema.financePackages)
      .set({
        status: to,
        ...patch,
        updatedAt: sql`now()`,
        version: sql`${schema.financePackages.version} + 1`,
      })
      .where(and(eq(schema.financePackages.id, id), inArray(schema.financePackages.status, [...from])))
      .returning();
    return rows[0] === undefined ? null : toPackage(rows[0]);
  }
}
