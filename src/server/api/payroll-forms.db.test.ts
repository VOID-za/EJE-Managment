import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, completeForm, startPostgresTestServer, submitForms } from '@/test/api-harness';

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

  it('three Submit to Office requests racing make ONE submission; the losers write nothing; both completed forms are marked once', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date: '2026-11-05', typed: typed('1'), expectedRevision: null });
    expect((await completeForm(tech, IDS.technician, 'timesheet', '2026-11-01', '2026-11-25')).status).toBe(200);
    expect((await completeForm(tech, IDS.technician, 'attendance', '2026-11-01', '2026-11-25')).status).toBe(200);
    const answers = await Promise.all([
      tech.post(`/api/payroll/forms/${IDS.technician}/submit`, {}),
      tech.post(`/api/payroll/forms/${IDS.technician}/submit`, {}),
      tech.post(`/api/payroll/forms/${IDS.technician}/submit`, {}),
    ]);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    for (const answer of answers.filter((candidate) => candidate.status !== 200)) {
      expect(answer.status, JSON.stringify(answer.error)).toBeLessThan(500);
    }
    expect(await counts()).toEqual({ payroll: 1, periods: 1, current: 1 });
    const forms = await db.select().from(schema.payrollFormCompletions);
    const [submission] = await db.select().from(schema.payrollSubmissions);
    expect(forms.map((form) => form.submissionId)).toEqual([submission!.id, submission!.id]);
  });

  it('dates already submitted cannot be completed again, in part or in whole: nothing changes', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date: '2026-11-05', typed: typed('1'), expectedRevision: null });
    const first = await submitForms<{ submission: { id: string; timesheetPeriodId: string } }>(tech, IDS.technician, '2026-11-01', '2026-11-25');
    expect(first.status).toBe(200);
    const before = await counts();
    for (const [from, to] of [['2026-11-20', '2026-12-15'], ['2026-11-01', '2026-11-25'], ['2026-10-01', '2026-12-31']]) {
      const again = await submitForms(tech, IDS.technician, from!, to!, { confirmReplace: true });
      expect(again.error?.violations[0]?.code, `${from} – ${to}`).toBe('payroll_period_submitted');
    }
    expect(await counts()).toEqual(before);
    expect((await db.select().from(schema.payrollFormCompletions)).filter((form) => form.submissionId === null)).toHaveLength(0);
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

  /*
   * TWO DEVICES, ONE LINE, AT THE SAME MOMENT — through the real routes, each
   * request its own transaction (PAYROLL-ONE-1 follow-up, migration 0053).
   */
  it('save/save racing from one revision on two devices: exactly one confirmed, the other refused; the stored line is the confirmed one; one row', async () => {
    const phone = await signIn('sipho@example-test.co.za');
    const tablet = await signIn('sipho@example-test.co.za');
    for (let round = 0; round < 6; round += 1) {
      const id = crypto.randomUUID();
      const created = await phone.post<{ line: { revision: string } }>(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-10', typed: typed('1', `RACE-${round}`), expectedRevision: null });
      expect(created.status, JSON.stringify(created.error)).toBe(200);
      const revision = created.data.line.revision;
      const [a, b] = await Promise.all([
        phone.post<{ line: { typed: { overtime: string } } }>(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-10', typed: typed('2', `RACE-${round}`), expectedRevision: revision }),
        tablet.post<{ line: { typed: { overtime: string } } }>(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-10', typed: typed('3', `RACE-${round}`), expectedRevision: revision }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses, JSON.stringify([a.error, b.error])).toEqual([200, 422]);
      const loser = a.status === 422 ? a : b;
      const winner = a.status === 200 ? a : b;
      expect(loser.error?.violations[0]?.code).toBe('timesheet_line_changed');
      const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, id));
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.overtimeHours)).toBe(Number(winner.data.line.typed.overtime));
      // Both devices, refreshed, read the same confirmed line.
      const [onPhone, onTablet] = await Promise.all([phone, tablet].map((device) => device.get<readonly { id: string; typed: { overtime: string } }[]>(`/api/timesheets/${IDS.technician}/lines`)));
      expect(onPhone!.data.find((line) => line.id === id)?.typed.overtime).toBe(winner.data.line.typed.overtime);
      expect(onTablet!.data.find((line) => line.id === id)?.typed.overtime).toBe(winner.data.line.typed.overtime);
    }
  });

  it('save/remove racing on two devices: a confirmed removal is never reversed; a later save is refused explicitly', async () => {
    const phone = await signIn('sipho@example-test.co.za');
    const tablet = await signIn('sipho@example-test.co.za');
    for (let round = 0; round < 6; round += 1) {
      const id = crypto.randomUUID();
      const created = await phone.post<{ line: { revision: string } }>(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-11', typed: typed('1', `GONE-${round}`), expectedRevision: null });
      const revision = created.data.line.revision;
      const [saved, removed] = await Promise.all([
        tablet.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-11', typed: typed('7', `GONE-${round}`), expectedRevision: revision }),
        phone.post<{ removed: boolean }>(`/api/timesheets/${IDS.technician}/lines/${id}/remove`, {}),
      ]);
      expect(removed.status, JSON.stringify(removed.error)).toBe(200);
      // Whichever came first, the line is gone, and a save that lost the race was told so.
      expect(await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, id))).toHaveLength(0);
      expect(await db.select().from(schema.timesheetLineDrafts).where(eq(schema.timesheetLineDrafts.id, id))).toHaveLength(0);
      expect(await db.select().from(schema.timesheetLineRemovals).where(eq(schema.timesheetLineRemovals.id, id))).toHaveLength(1);
      if (saved.status !== 200) expect(saved.error?.violations[0]?.code).toMatch(/^timesheet_line_(removed|changed)$/u);
      // A retry from the page left behind (keepalive), or the other device again: still refused, still removed.
      const late = await tablet.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-11', typed: typed('8', `GONE-${round}`), expectedRevision: null });
      expect(late.error?.violations[0]?.code).toBe('timesheet_line_removed');
      expect(await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, id))).toHaveLength(0);
    }
    // The record of a removal is kept as it is.
    expect(await postgresMessage(db.execute(sql`delete from timesheet_line_removals`))).toContain('kept as it is');
  });

  it('a removal that arrives BEFORE the line\'s first save still wins; somebody else\'s id is left alone', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    const id = crypto.randomUUID();
    expect((await tech.post<{ removed: boolean }>(`/api/timesheets/${IDS.technician}/lines/${id}/remove`, {})).data).toEqual({ removed: false });
    const first = await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-12', typed: typed('1'), expectedRevision: null });
    expect(first.error?.violations[0]?.code).toBe('timesheet_line_removed');
    const lerato = await signIn('lerato@example-test.co.za');
    const hers = crypto.randomUUID();
    expect((await lerato.post(`/api/timesheets/${IDS.otherTechnician}/lines`, { id: hers, date: '2026-11-12', typed: typed('1'), expectedRevision: null })).status).toBe(200);
    expect((await tech.post<{ removed: boolean }>(`/api/timesheets/${IDS.technician}/lines/${hers}/remove`, {})).data).toEqual({ removed: false });
    expect(await db.select().from(schema.timesheetLineRemovals).where(eq(schema.timesheetLineRemovals.id, hers))).toHaveLength(0);
    expect(await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, hers))).toHaveLength(1);
  });

  it('FINANCE (audit F1): the stored manifest records what each person\'s files were made from; a submission made after Prepare makes Send refuse, nothing claimed', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    const office = await signIn('christene@example-test.co.za');
    await db.update(schema.systemSettings).set({ financeEmail: 'payroll@finance.example.test' });
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date: '2026-11-03', typed: typed('1', 'F1-A'), expectedRevision: null });
    expect((await submitForms(tech, IDS.technician, '2026-11-01', '2026-11-10')).status).toBe(200);
    const prepared = await office.post<{ package: { id: string } }>('/api/payroll/packages', { month: '2026-11', technicianIds: [IDS.technician] });
    expect(prepared.status, JSON.stringify(prepared.error)).toBe(200);
    const [stored] = await db.select().from(schema.financePackages).where(eq(schema.financePackages.id, prepared.data.package.id));
    const manifest = stored!.manifest as { basis?: string }[];
    expect(manifest.every((attachment) => attachment.basis?.includes('period:') === true)).toBe(true);
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date: '2026-11-14', typed: typed('2', 'F1-B'), expectedRevision: null });
    expect((await submitForms(tech, IDS.technician, '2026-11-11', '2026-11-25')).status).toBe(200);
    const send = await office.post(`/api/payroll/packages/${prepared.data.package.id}/send`, {});
    expect(send.status).toBe(422);
    expect(send.error?.violations[0]?.code).toBe('package_out_of_date');
    const [after] = await db.select().from(schema.financePackages).where(eq(schema.financePackages.id, prepared.data.package.id));
    expect(after).toMatchObject({ status: 'prepared', attempts: 0 });
  });


  /*
   * FORM-LIFECYCLE-1 (migration 0054): what the database itself keeps — one awaiting form of a kind per person,
   * a completed form never rewritten or deleted, its submission recorded once — and the races the form lock closes.
   */
  it('0054: a completed form is write-once — only its submission is recorded, once; never deleted', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    const done = await completeForm<{ id: string }>(tech, IDS.technician, 'attendance', '2026-11-01', '2026-11-25');
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    const id = done.data.id;
    for (const change of [sql`file_name = 'Other name.pdf'`, sql`period_to = '2026-11-24'`, sql`content = '{}'::jsonb`, sql`document = '{}'::jsonb`, sql`completed_at = now()`]) {
      expect(await postgresMessage(db.execute(sql`update payroll_form_completions set ${change} where id = ${id}`))).toContain('kept exactly as it was completed');
    }
    expect(await postgresMessage(db.execute(sql`delete from payroll_form_completions where id = ${id}`))).toContain('cannot be deleted');
    // A second awaiting attendance form for the person is refused by the unique key.
    expect(
      await postgresMessage(
        db.insert(schema.payrollFormCompletions).values({
          id: crypto.randomUUID(), userId: IDS.technician, kind: 'attendance', periodFrom: '2026-12-01', periodTo: '2026-12-10', fileName: 'Second.pdf',
          content: {}, document: {}, completedAt: new Date().toISOString(), completedBy: IDS.technician,
        }),
      ),
    ).toContain('payroll_form_completions_awaiting_key');
    expect(await postgresMessage(db.execute(sql`update payroll_form_completions set kind = 'other' where id = ${id}`))).toMatch(/kept exactly|kind_known/u);
  });

  it('three Completed (OK) requests racing make ONE completed form; the losers write nothing', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date: '2026-11-05', typed: typed('1'), expectedRevision: null });
    const answers = await Promise.all([1, 2, 3].map(() => completeForm(tech, IDS.technician, 'timesheet', '2026-11-01', '2026-11-25')));
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    for (const answer of answers.filter((candidate) => candidate.status !== 200)) {
      expect(answer.error?.violations[0]?.code, JSON.stringify(answer.error)).toBe('form_already_completed');
    }
    expect(await db.select().from(schema.payrollFormCompletions)).toHaveLength(1);
  });

  it('a line saved while the timesheet is being completed is either in the completed form or refused — never written beside it', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    const id = crypto.randomUUID();
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-05', typed: typed('1'), expectedRevision: null });
    const lines = await tech.get<readonly { id: string; revision: string }[]>(`/api/timesheets/${IDS.technician}/lines`);
    const revision = lines.data.find((line) => line.id === id)!.revision;
    const [completed, saved] = await Promise.all([
      completeForm<{ id: string }>(tech, IDS.technician, 'timesheet', '2026-11-01', '2026-11-25'),
      tech.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-05', typed: typed('7'), expectedRevision: revision }),
    ]);
    expect(completed.status, JSON.stringify(completed.error)).toBe(200);
    const [form] = await db.select().from(schema.payrollFormCompletions);
    const frozen = (form!.content as { timesheet: { entries: { id: string; overtimeHours: number }[] } }).timesheet.entries.find((entry) => entry.id === id)!;
    const [stored] = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, id));
    // Whichever came first, what is stored is what was completed.
    expect(Number(stored!.overtimeHours)).toBe(frozen.overtimeHours);
    if (saved.status !== 200) expect(saved.error?.violations[0]?.code).toBe('form_completed');
    // And Submit to Office finds the timesheet exactly as completed.
    expect((await completeForm(tech, IDS.technician, 'attendance', '2026-11-01', '2026-11-25')).status).toBe(200);
    const sent = await tech.post(`/api/payroll/forms/${IDS.technician}/submit`, {});
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
  });

  it('a completed form is locked against every direct request — lines, the old entries route, attendance, clearing a day', async () => {
    const tech = await signIn('sipho@example-test.co.za');
    const id = crypto.randomUUID();
    await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-05', typed: typed('1'), expectedRevision: null });
    await tech.post('/api/attendance', { userId: IDS.technician, date: '2026-11-05', status: 'present', note: '' });
    expect((await completeForm(tech, IDS.technician, 'timesheet', '2026-11-01', '2026-11-25')).status).toBe(200);
    expect((await completeForm(tech, IDS.technician, 'attendance', '2026-11-01', '2026-11-25')).status).toBe(200);
    const lines = await tech.get<readonly { id: string; revision: string }[]>(`/api/timesheets/${IDS.technician}/lines`);
    const revision = lines.data.find((line) => line.id === id)!.revision;
    const refusals = [
      await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id, date: '2026-11-05', typed: typed('9'), expectedRevision: revision }),
      await tech.post(`/api/timesheets/${IDS.technician}/lines`, { id: crypto.randomUUID(), date: '2026-11-06', typed: typed('1'), expectedRevision: null }),
      await tech.post(`/api/timesheets/${IDS.technician}/lines/${id}/remove`, {}),
      await tech.post(`/api/timesheets/${IDS.technician}/entries`, { date: '2026-11-07', customerName: 'X', overtimeHours: 1, doubleHours: 0 }),
      await tech.post('/api/attendance', { userId: IDS.technician, date: '2026-11-05', status: 'absent', absenceReason: 'leave', note: '' }),
      await tech.post('/api/attendance', { userId: IDS.technician, date: '2026-11-05', status: 'none', note: '' }),
    ];
    for (const answer of refusals) expect(answer.error?.violations[0]?.code, JSON.stringify(answer.error)).toBe('form_completed');
    const [entry] = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.id, id));
    expect(Number(entry!.overtimeHours)).toBe(1);
    expect(await db.select().from(schema.attendance)).toHaveLength(1);
  });
});
