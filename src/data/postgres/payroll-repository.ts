import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  asUserId,
  type AttendanceSnapshot,
  type FinancePackage,
  type FinancePackageAttachment,
  type FinancePackageStatus,
  type AttendancePeriodSnapshot,
  type MonthlySubmission,
  type PayrollDocumentKind,
  type PayrollDocumentName,
  type PayrollSubmission,
  type PayrollSubmissionDocument,
  type UserId,
} from '@/domain';
import type { PayrollReplacement, PayrollRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { isUuid } from './identifiers';

type SubmissionRow = typeof schema.monthlySubmissions.$inferSelect;
type PackageRow = typeof schema.financePackages.$inferSelect;
type PayrollRow = typeof schema.payrollSubmissions.$inferSelect;
type NameRow = typeof schema.payrollDocumentNames.$inferSelect;

const toPayrollSubmission = (row: PayrollRow): PayrollSubmission => ({
  id: row.id,
  userId: asUserId(row.userId),
  from: row.periodFrom,
  to: row.periodTo,
  financeMonth: row.financeMonth,
  timesheetRequired: row.timesheetRequired,
  timesheetPeriodId: row.timesheetPeriodId,
  attendance: row.attendanceSnapshot as AttendancePeriodSnapshot,
  fileNames: { timesheet: row.timesheetFileName, attendance: row.attendanceFileName },
  documents: row.documents as PayrollSubmissionDocument[],
  submittedAt: row.submittedAt,
  submittedBy: asUserId(row.submittedBy),
  supersededAt: row.supersededAt,
  supersededBy: row.supersededBy === null ? null : asUserId(row.supersededBy),
  supersededBySubmission: row.supersededBySubmission,
});

const toName = (row: NameRow): PayrollDocumentName => ({
  userId: asUserId(row.userId),
  kind: row.kind as PayrollDocumentKind,
  fileName: row.fileName,
  updatedBy: asUserId(row.updatedBy),
  updatedAt: row.updatedAt,
});

const toSubmission = (row: SubmissionRow): MonthlySubmission => ({
  id: row.id,
  userId: asUserId(row.userId),
  month: row.month,
  timesheetPeriodId: row.timesheetPeriodId,
  attendance: row.attendanceSnapshot as AttendanceSnapshot,
  submittedAt: row.submittedAt,
  submittedBy: asUserId(row.submittedBy),
  supersededAt: row.supersededAt,
  supersededBy: row.supersededBy === null ? null : asUserId(row.supersededBy),
  supersededBySubmission: row.supersededBySubmission,
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


  async replaceMonthlySubmissions(input: PayrollReplacement): Promise<readonly MonthlySubmission[]> {
    const ids = input.ids.filter(isUuid);
    if (ids.length === 0) return [];
    const rows = await this.db
      .update(schema.monthlySubmissions)
      .set({ supersededAt: input.at, supersededBy: input.by, supersededBySubmission: input.bySubmission })
      .where(
        and(
          eq(schema.monthlySubmissions.userId, input.userId),
          inArray(schema.monthlySubmissions.id, ids),
          isNull(schema.monthlySubmissions.supersededAt),
        ),
      )
      .returning();
    return rows.map(toSubmission);
  }

  async listPayrollSubmissionsFor(userId: UserId): Promise<readonly PayrollSubmission[]> {
    const rows = await this.db
      .select()
      .from(schema.payrollSubmissions)
      .where(eq(schema.payrollSubmissions.userId, userId))
      .orderBy(desc(schema.payrollSubmissions.periodTo), desc(schema.payrollSubmissions.submittedAt));
    return rows.map(toPayrollSubmission);
  }

  async listPayrollSubmissionsForMonth(financeMonth: string): Promise<readonly PayrollSubmission[]> {
    const rows = await this.db
      .select()
      .from(schema.payrollSubmissions)
      .where(eq(schema.payrollSubmissions.financeMonth, financeMonth))
      .orderBy(asc(schema.payrollSubmissions.periodTo), asc(schema.payrollSubmissions.submittedAt));
    return rows.map(toPayrollSubmission);
  }

  async findPayrollSubmission(id: string): Promise<PayrollSubmission | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.select().from(schema.payrollSubmissions).where(eq(schema.payrollSubmissions.id, id)).limit(1);
    return rows[0] === undefined ? null : toPayrollSubmission(rows[0]);
  }

  async createPayrollSubmission(submission: PayrollSubmission): Promise<PayrollSubmission | null> {
    const rows = await this.db
      .insert(schema.payrollSubmissions)
      .values({
        id: submission.id,
        userId: submission.userId,
        periodFrom: submission.from,
        periodTo: submission.to,
        financeMonth: submission.financeMonth,
        timesheetRequired: submission.timesheetRequired,
        timesheetPeriodId: submission.timesheetPeriodId,
        attendanceSnapshot: submission.attendance,
        timesheetFileName: submission.fileNames.timesheet,
        attendanceFileName: submission.fileNames.attendance,
        documents: submission.documents,
        submittedAt: submission.submittedAt,
        submittedBy: submission.submittedBy,
      })
      .onConflictDoNothing({
        target: [schema.payrollSubmissions.userId, schema.payrollSubmissions.periodFrom, schema.payrollSubmissions.periodTo],
        where: isNull(schema.payrollSubmissions.supersededAt),
      })
      .returning();
    return rows[0] === undefined ? null : toPayrollSubmission(rows[0]);
  }

  async replacePayrollSubmissions(input: PayrollReplacement): Promise<readonly PayrollSubmission[]> {
    const ids = input.ids.filter(isUuid);
    if (ids.length === 0) return [];
    // The guard serialises one person's submissions; this takes the same lock first.
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtext('payroll_submissions:' || ${input.userId}::text))`);
    const rows = await this.db
      .update(schema.payrollSubmissions)
      .set({ supersededAt: input.at, supersededBy: input.by, supersededBySubmission: input.bySubmission })
      .where(
        and(
          eq(schema.payrollSubmissions.userId, input.userId),
          inArray(schema.payrollSubmissions.id, ids),
          isNull(schema.payrollSubmissions.supersededAt),
        ),
      )
      .returning();
    return rows.map(toPayrollSubmission);
  }

  async listDocumentNames(userId: UserId): Promise<readonly PayrollDocumentName[]> {
    const rows = await this.db.select().from(schema.payrollDocumentNames).where(eq(schema.payrollDocumentNames.userId, userId));
    return rows.map(toName);
  }

  async saveDocumentName(name: PayrollDocumentName): Promise<PayrollDocumentName> {
    const rows = await this.db
      .insert(schema.payrollDocumentNames)
      .values({ userId: name.userId, kind: name.kind, fileName: name.fileName, updatedBy: name.updatedBy, updatedAt: name.updatedAt })
      .onConflictDoUpdate({
        target: [schema.payrollDocumentNames.userId, schema.payrollDocumentNames.kind],
        set: {
          fileName: name.fileName,
          updatedBy: name.updatedBy,
          updatedAt: name.updatedAt,
          version: sql`${schema.payrollDocumentNames.version} + 1`,
        },
      })
      .returning();
    return toName(rows[0]!);
  }

  async deleteDocumentName(userId: UserId, kind: PayrollDocumentKind): Promise<void> {
    await this.db
      .delete(schema.payrollDocumentNames)
      .where(and(eq(schema.payrollDocumentNames.userId, userId), eq(schema.payrollDocumentNames.kind, kind)));
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
