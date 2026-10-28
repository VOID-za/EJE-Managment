import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { businessToday } from '@/lib/business-time';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * ATTEND-1 AND TIMESHEET-1, ON REAL POSTGRESQL (migration 0033).
 *
 * The rows, and what the database itself refuses: a second attendance row for
 * the same person and day (the unique key — the application corrects instead),
 * a status that is neither present nor absent, and a blank comment. The
 * timesheet's hours are read from `job_labour`, and the labour row is the same
 * row afterwards.
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

describeDb('attendance and timesheets on PostgreSQL', () => {
  let db: Database;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

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

  it('a recorded day is corrected in place: one row, the later answer, a higher version', async () => {
    const today = businessToday();
    const office = await signIn('christene@example-test.co.za');
    for (const status of ['present', 'absent']) {
      const response = await office.post('/api/attendance', {
        userId: IDS.technician, date: today, status, note: status === 'absent' ? 'Phoned in' : '',
        // ATT-01: an absent day says why.
        ...(status === 'absent' ? { absenceReason: 'sick_leave' } : {}),
      });
      expect(response.status).toBe(200);
    }
    const rows = await db
      .select()
      .from(schema.attendance)
      .where(and(eq(schema.attendance.userId, IDS.technician), eq(schema.attendance.workDate, today)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'absent', absenceReason: 'sick_leave', note: 'Phoned in', recordedBy: IDS.coordinator, version: 2 });
  });

  it('the database refuses a second row for a day, an unknown status and a blank comment', async () => {
    const values = {
      userId: IDS.technician,
      workDate: '2026-10-01',
      status: 'present',
      recordedBy: IDS.master,
      recordedAt: '2026-10-01T08:00:00.000Z',
    };
    await db.insert(schema.attendance).values({ id: crypto.randomUUID(), ...values });
    expect(await postgresMessage(db.insert(schema.attendance).values({ id: crypto.randomUUID(), ...values })))
      .toContain('attendance_user_date_key');
    expect(
      await postgresMessage(
        db.insert(schema.attendance).values({ id: crypto.randomUUID(), ...values, workDate: '2026-10-02', status: 'late' }),
      ),
    ).toContain('attendance_status_known');
    expect(
      await postgresMessage(
        db.insert(schema.timesheetComments).values({
          id: crypto.randomUUID(),
          userId: IDS.technician,
          workDate: '2026-10-01',
          comment: '   ',
          updatedBy: IDS.technician,
          commentedAt: '2026-10-01T08:00:00.000Z',
        }),
      ),
    ).toContain('timesheet_comments_not_blank');
  });

  it('the timesheet is MANUAL: job labour is never read; typed lines and the comment are stored (TIMESHEET-2)', async () => {
    const today = businessToday();
    const master = await signIn('elmarie@example-test.co.za');
    const created = await master.post<{ id: string }>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: '',
      referenceNumber: '',
      faultDescription: 'Drive tripping under load.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
    });
    expect(created.status).toBe(200);
    const tech = await signIn('sipho@example-test.co.za');
    expect((await tech.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(200);
    expect(
      (await tech.post(`/api/jobs/${created.data.id}/add_labour`, {
        date: today, rateType: 'overtime', hours: 3, description: 'After hours',
      })).status,
    ).toBe(200);
    const labourBefore = await db.select().from(schema.jobLabour).where(eq(schema.jobLabour.jobId, created.data.id));

    // Three hours of labour on a job — and the timesheet shows nothing for it.
    const before = await tech.get<{ totals: { overtimeHours: number; unrecordedDays: number } }>(
      `/api/timesheets/${IDS.technician}?from=${today}&to=${today}`,
    );
    expect(before.status).toBe(200);
    expect(before.data.totals).toMatchObject({ overtimeHours: 0, unrecordedDays: 1 });

    // What the technician types is what is stored, with the owner from the session.
    const added = await tech.post<{ entry: { id: string } }>(`/api/timesheets/${IDS.technician}/entries`, {
      date: today, customerId: IDS.customer, customerName: '', overtimeHours: 2, doubleHours: 0,
      calloutAmount: 45000, calloutShared: true, internalKm: 5.5, customerKm: 30,
    });
    expect(added.status, JSON.stringify(added.error)).toBe(200);
    const rows = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, IDS.technician));
    expect(rows).toHaveLength(1);
    // Migration 0037's columns: NT 0 on a new line, the call-out as an amount, both kilometres.
    expect(rows[0]).toMatchObject({
      customerId: IDS.customer, normalHours: '0.00', overtimeHours: '2.00', callouts: 0,
      calloutAmountCents: 45000, calloutShared: true, internalKm: '5.5', customerKm: '30.0', workshop: false,
    });
    expect(rows[0]?.customerName.length).toBeGreaterThan(0);
    const corrected = await tech.post(`/api/timesheets/${IDS.technician}/entries`, {
      entryId: added.data.entry.id, date: today, customerId: IDS.customer, customerName: '', overtimeHours: 2.5, doubleHours: 0,
      calloutAmount: 45000, calloutShared: true, internalKm: 5.5, customerKm: 30,
    });
    expect(corrected.status).toBe(200);
    const after = await db.select().from(schema.timesheetEntries).where(eq(schema.timesheetEntries.userId, IDS.technician));
    expect(after.map((row) => [row.overtimeHours, row.version])).toEqual([['2.50', 2]]);
    await expect(
      db.insert(schema.timesheetEntries).values({
        id: '00000000-0000-4000-8000-0000000000aa', userId: IDS.technician, workDate: today, customerName: 'x',
        normalHours: '25', updatedBy: IDS.technician, recordedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();

    expect((await tech.post(`/api/timesheets/${IDS.technician}/comment`, { date: today, comment: 'Crane late' })).status).toBe(200);
    const comments = await db.select().from(schema.timesheetComments).where(eq(schema.timesheetComments.userId, IDS.technician));
    expect(comments.map((row) => row.comment)).toEqual(['Crane late']);

    expect(await db.select().from(schema.jobLabour).where(eq(schema.jobLabour.jobId, created.data.id)))
      .toEqual(labourBefore);

    // Cleared: the row goes, and the clearing is on the trail.
    expect((await tech.post(`/api/timesheets/${IDS.technician}/comment`, { date: today, comment: '' })).status).toBe(200);
    expect(await db.select().from(schema.timesheetComments).where(eq(schema.timesheetComments.userId, IDS.technician)))
      .toHaveLength(0);
  });

  it('Send to office is stored once with its snapshot, and the database refuses to rewrite or delete it (migration 0037)', async () => {
    const today = businessToday();
    const month = today.slice(0, 7);
    const tech = await signIn('sipho@example-test.co.za');
    expect((await tech.post(`/api/timesheets/${IDS.technician}/entries`, {
      date: today, customerName: '', workshop: true, overtimeHours: 1, doubleHours: 0,
    })).status).toBe(200);
    expect((await tech.post(`/api/timesheets/${IDS.technician}/months/${month}/comment`, { comment: 'Workshop week.' })).status).toBe(200);
    const sent = await tech.post(`/api/timesheets/${IDS.technician}/months/${month}/submit`, {});
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect((await tech.post(`/api/timesheets/${IDS.technician}/months/${month}/submit`, {})).status).toBe(422);

    const rows = await db.select().from(schema.timesheetMonths).where(eq(schema.timesheetMonths.userId, IDS.technician));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month, comment: 'Workshop week.', submittedBy: IDS.technician });
    expect(rows[0]?.submittedAt).not.toBeNull();
    expect((rows[0]?.snapshot as { entries: unknown[] }).entries).toHaveLength(1);

    // The write-once trigger: no script or bug can change or un-send it.
    expect(await postgresMessage(
      db.update(schema.timesheetMonths).set({ comment: 'rewritten' }).where(eq(schema.timesheetMonths.id, rows[0]!.id)),
    )).toContain('sent to the office');
    expect(await postgresMessage(
      db.delete(schema.timesheetMonths).where(eq(schema.timesheetMonths.id, rows[0]!.id)),
    )).toContain('sent to the office');
  });

  it('the database refuses a reason on a present day, an unknown reason, and a Workshop line naming a customer', async () => {
    const values = {
      userId: IDS.technician, workDate: '2026-10-05', recordedBy: IDS.master, recordedAt: '2026-10-05T08:00:00.000Z',
    };
    expect(await postgresMessage(
      db.insert(schema.attendance).values({ id: crypto.randomUUID(), ...values, status: 'present', absenceReason: 'leave' }),
    )).toContain('attendance_absence_reason_known');
    expect(await postgresMessage(
      db.insert(schema.attendance).values({ id: crypto.randomUUID(), ...values, status: 'absent', absenceReason: 'holiday' }),
    )).toContain('attendance_absence_reason_known');
    await db.insert(schema.attendance).values({ id: crypto.randomUUID(), ...values, status: 'absent', absenceReason: null });
    expect(await postgresMessage(
      db.insert(schema.timesheetEntries).values({
        id: crypto.randomUUID(), userId: IDS.technician, workDate: '2026-10-05', customerId: IDS.customer,
        workshop: true, updatedBy: IDS.technician, recordedAt: '2026-10-05T08:00:00.000Z',
      }),
    )).toContain('timesheet_entries_reviewer_bounded');
  });
});
