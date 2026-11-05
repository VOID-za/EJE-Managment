import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer, submitForms } from '@/test/api-harness';

/**
 * PAYROLL-ONE-1 ON REAL POSTGRESQL (migration 0052): the coordinated
 * submission in ONE transaction, two racing submissions making ONE, and what
 * the database itself refuses — a rewritten submission, a deleted one, two
 * current ones sharing a day, a Finance month that is not the month of To, an
 * unsafe stored PDF name.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;
const PASSWORD = 'a-real-test-password';

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

const typed = (overtime: string, customerName = 'ABC Engineering') => ({
  pick: '', customerName, overtime, double: '0', callout: '0', internalKm: '0', customerKm: '0',
});

describeDb('payroll forms on PostgreSQL (migration 0052)', () => {
  let db: Database;
  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };
  const counts = async () => ({
    payroll: (await db.select().from(schema.payrollSubmissions)).length,
    periods: (await db.select().from(schema.timesheetPeriods)).length,
    current: (await db.select().from(schema.timesheetPeriods).where(sql`${schema.timesheetPeriods.supersededAt} is null and ${schema.timesheetPeriods.submittedAt} is not null`)).length,
  });

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    startPostgresTestServer(url ?? '');
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    startPostgresTestServer(url ?? '');
  });

  it('a cross-month submission writes the timesheet period, the payroll row and its stored PDFs together; Finance month = month of To', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    for (const date of ['2026-10-24', '2026-11-25']) {
      const saved = await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date, typed: typed('1', `L-${date}`), expectedRevision: null });
      expect(saved.status, JSON.stringify(saved.error)).toBe(200);
    }
    const sent = await submitForms<{ submission: { id: string; timesheetPeriodId: string } }>(tech, IDS.technician, '2026-10-24', '2026-11-25');
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    const [row] = await db.select().from(schema.payrollSubmissions).where(eq(schema.payrollSubmissions.id, sent.data.submission.id));
    expect(row).toMatchObject({ periodFrom: '2026-10-24', periodTo: '2026-11-25', financeMonth: '2026-11', timesheetRequired: true });
    expect((row?.documents as { kind: string; sha256: string }[]).map((document) => document.kind)).toEqual(['timesheet', 'attendance']);
    const [period] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, row!.timesheetPeriodId!));
    expect((period?.snapshot as { entries: { customerName: string }[] }).entries.map((entry) => entry.customerName).sort()).toEqual(['L-2026-10-24', 'L-2026-11-25']);
    for (const kind of ['timesheet', 'attendance']) {
      expect((await tech.download(`/api/payroll/submissions/${row!.id}/${kind}/pdf`)).status).toBe(200);
    }
  });

  it('two submissions racing for the same dates make ONE: the loser writes nothing, not even its timesheet period', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date: '2026-11-05', typed: typed('1'), expectedRevision: null });
    const forms = await tech.get<{ revision: string }>(`/api/payroll/forms/${IDS.technician}?from=2026-11-01&to=2026-11-25`);
    const body = { from: '2026-11-01', to: '2026-11-25', revision: forms.data.revision, confirmUnrecorded: true };
    const answers = await Promise.all([
      tech.post(`/api/payroll/forms/${IDS.technician}/submit`, body),
      tech.post(`/api/payroll/forms/${IDS.technician}/submit`, body),
      tech.post(`/api/payroll/forms/${IDS.technician}/submit`, body),
    ]);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    for (const answer of answers.filter((candidate) => candidate.status !== 200)) {
      expect(answer.status, JSON.stringify(answer.error)).toBeLessThan(500);
    }
    expect(await counts()).toEqual({ payroll: 1, periods: 1, current: 1 });
  });

  it('a complete replacement with the very same dates keeps the original row beside it; a partial one changes nothing', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date: '2026-11-05', typed: typed('1'), expectedRevision: null });
    const first = await submitForms<{ submission: { id: string; timesheetPeriodId: string } }>(tech, IDS.technician, '2026-11-01', '2026-11-25');
    expect(first.status).toBe(200);
    const before = await counts();
    const partial = await submitForms(tech, IDS.technician, '2026-11-20', '2026-12-15', { confirmReplace: true });
    expect(partial.error?.violations[0]?.code).toBe('payroll_partial_overlap');
    expect(await counts()).toEqual(before);
    const second = await submitForms<{ submission: { id: string; timesheetPeriodId: string } }>(tech, IDS.technician, '2026-11-01', '2026-11-25', { confirmReplace: true });
    expect(second.status, JSON.stringify(second.error)).toBe(200);
    expect(await counts()).toEqual({ payroll: 2, periods: 2, current: 1 });
    const [kept] = await db.select().from(schema.payrollSubmissions).where(eq(schema.payrollSubmissions.id, first.data.submission.id));
    expect(kept?.supersededBySubmission).toBe(second.data.submission.id);
    const [keptPeriod] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, first.data.submission.timesheetPeriodId));
    expect(keptPeriod?.supersededAt).not.toBeNull();
  });

  it('the database refuses: a rewritten, deleted or revived submission, two current ones sharing a day, a wrong Finance month, an unsafe name', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    const sent = await submitForms<{ submission: { id: string } }>(tech, IDS.technician, '2026-11-01', '2026-11-25');
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    const id = sent.data.submission.id;
    for (const change of [sql`period_to = '2026-11-24'`, sql`attendance_snapshot = '{}'::jsonb`, sql`timesheet_file_name = 'x.pdf'`, sql`documents = '[]'::jsonb`, sql`submitted_at = now()`]) {
      expect(await postgresMessage(db.execute(sql`update payroll_submissions set ${change} where id = ${id}`))).toMatch(/kept exactly as submitted|finance_month_of_to/u);
    }
    expect(await postgresMessage(db.execute(sql`delete from payroll_submissions where id = ${id}`))).toContain('cannot be deleted');
    const insert = (from: string, to: string, financeMonth: string) =>
      db.insert(schema.payrollSubmissions).values({
        id: crypto.randomUUID(), userId: IDS.technician, periodFrom: from, periodTo: to, financeMonth, timesheetRequired: false,
        timesheetPeriodId: null, attendanceSnapshot: {}, timesheetFileName: '', attendanceFileName: 'Attendance.pdf', documents: [],
        submittedAt: new Date().toISOString(), submittedBy: IDS.technician,
      });
    expect(await postgresMessage(insert('2026-11-20', '2026-12-10', '2026-12'))).toContain('overlaps one already made');
    expect(await postgresMessage(insert('2026-12-01', '2026-12-10', '2026-11'))).toContain('payroll_submissions_finance_month_of_to');
    expect(await postgresMessage(insert('2026-12-10', '2026-12-01', '2026-12'))).toContain('payroll_submissions_range_ordered');
    expect(await postgresMessage(insert('2025-01-01', '2026-10-01', '2026-10'))).toContain('payroll_submissions_range_bounded');
    // A required timesheet must name the person's current sent period for exactly these dates.
    expect(await postgresMessage(
      db.insert(schema.payrollSubmissions).values({
        id: crypto.randomUUID(), userId: IDS.technician, periodFrom: '2026-12-01', periodTo: '2026-12-10', financeMonth: '2026-12', timesheetRequired: true,
        timesheetPeriodId: null, attendanceSnapshot: {}, timesheetFileName: 'T.pdf', attendanceFileName: 'A.pdf', documents: [],
        submittedAt: new Date().toISOString(), submittedBy: IDS.technician,
      }),
    )).toContain('payroll_submissions_timesheet_whole');
    // Replaced once, it stays replaced; a replacement must name what replaced it.
    expect(await postgresMessage(db.execute(sql`update payroll_submissions set superseded_at = now() where id = ${id}`))).toContain('payroll_submissions_superseded_whole');
    // The stored working name is metadata held to safe characters by the table too.
    for (const name of ['../x.pdf', 'a/b.pdf', 'a\\b.pdf', '.hidden.pdf', 'x.exe', 'a..b.pdf']) {
      expect(await postgresMessage(
        db.insert(schema.payrollDocumentNames).values({ userId: IDS.technician, kind: 'timesheet', fileName: name, updatedBy: IDS.technician }),
      ), name).toContain('payroll_document_names_safe');
    }
    await db.insert(schema.payrollDocumentNames).values({ userId: IDS.technician, kind: 'timesheet', fileName: 'Sipho Ünïcode (Nov).pdf', updatedBy: IDS.technician });
  });

  it('a draft line is kept in the table exactly as typed, the owner’s only, and a reload returns it', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    const id = crypto.randomUUID();
    const saved = await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-05', typed: typed('1,2,3'), expectedRevision: null });
    expect(saved.status, JSON.stringify(saved.error)).toBe(200);
    const [draft] = await db.select().from(schema.timesheetLineDrafts).where(eq(schema.timesheetLineDrafts.id, id));
    expect(draft).toMatchObject({ userId: IDS.technician, workDate: '2026-11-05' });
    expect((draft?.typed as { overtime: string }).overtime).toBe('1,2,3');
    const again = await signIn('sipho@example-test.co.za');
    const lines = await again.get<readonly { id: string; complete: boolean }[]>(`/api/timesheets/${IDS.technician}/lines`);
    expect(lines.data.find((line) => line.id === id)?.complete).toBe(false);
    const lerato = await signIn('lerato@example-test.co.za');
    {
      expect((await lerato.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-05', typed: typed('2'), expectedRevision: null })).status).toBe(403);
    }
  });
});
