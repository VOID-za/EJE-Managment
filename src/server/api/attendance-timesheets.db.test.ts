import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** A calendar date `days` from another, by the calendar. */
const shift = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

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

  it('Send to office stores the chosen period once with its snapshot; the database refuses to rewrite, delete or overlap it (migration 0038)', async () => {
    const today = businessToday();
    const from = shift(today, -2);
    const tech = await signIn('sipho@example-test.co.za');
    expect((await tech.post(`/api/timesheets/${IDS.technician}/entries`, {
      date: today, customerName: '', workshop: true, overtimeHours: 1, doubleHours: 0,
    })).status).toBe(200);
    expect((await tech.post(`/api/timesheets/${IDS.technician}/period/comment`, { from, to: today, comment: 'Workshop days.' })).status).toBe(200);
    const sent = await tech.post(`/api/timesheets/${IDS.technician}/period/submit`, { from, to: today });
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect((await tech.post(`/api/timesheets/${IDS.technician}/period/submit`, { from, to: today })).status).toBe(422);

    const rows = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.userId, IDS.technician));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ periodFrom: from, periodTo: today, comment: 'Workshop days.', submittedBy: IDS.technician });
    expect(rows[0]?.submittedAt).not.toBeNull();
    expect((rows[0]?.snapshot as { entries: unknown[] }).entries).toHaveLength(1);

    // The office was notified, once, through the existing notifications table.
    const told = await db.select().from(schema.notifications).where(eq(schema.notifications.type, 'timesheet_submitted'));
    expect(told.map((row) => row.recipientId).sort()).toEqual([IDS.coordinator, IDS.master].sort());

    // The guard trigger: no script or bug can change, un-send or overlap it.
    expect(await postgresMessage(
      db.update(schema.timesheetPeriods).set({ comment: 'rewritten' }).where(eq(schema.timesheetPeriods.id, rows[0]!.id)),
    )).toContain('sent to the office');
    expect(await postgresMessage(
      db.delete(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, rows[0]!.id)),
    )).toContain('sent to the office');
    expect(await postgresMessage(
      db.insert(schema.timesheetPeriods).values({
        id: crypto.randomUUID(), userId: IDS.technician, periodFrom: shift(today, -5), periodTo: from,
        updatedBy: IDS.technician, commentedAt: new Date().toISOString(),
        submittedAt: new Date().toISOString(), submittedBy: IDS.technician, snapshot: { entries: [] },
      }),
    )).toContain('overlaps a period already sent');
    // From after To is refused by the table itself.
    expect(await postgresMessage(
      db.insert(schema.timesheetPeriods).values({
        id: crypto.randomUUID(), userId: IDS.technician, periodFrom: today, periodTo: shift(today, -3),
        updatedBy: IDS.technician, commentedAt: new Date().toISOString(),
      }),
    )).toContain('timesheet_periods_range_valid');
  });

  it('0038 carries a month 0037 may hold across as the period it covered, exactly', async () => {
    const id = crypto.randomUUID();
    await db.insert(schema.timesheetMonths).values({
      id, userId: IDS.technician, month: '2026-02', comment: 'February.', updatedBy: IDS.technician,
      commentedAt: '2026-03-01T08:00:00.000Z', submittedAt: '2026-03-01T08:00:00.000Z', submittedBy: IDS.technician,
      snapshot: { technicianName: 'Sipho', month: '2026-02', comment: 'February.', entries: [] },
    });
    const migration = readFileSync(join(process.cwd(), 'src/db/migrations/0038_timesheet_periods_delivery_notes.sql'), 'utf8');
    const copy = migration.split('--> statement-breakpoint').find((statement) => statement.includes('FROM "timesheet_months"'));
    expect(copy).toBeDefined();
    await db.execute(sql.raw(copy!));
    const [period] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, id));
    expect(period).toMatchObject({ periodFrom: '2026-02-01', periodTo: '2026-02-28', comment: 'February.', submittedBy: IDS.technician });
    expect(period?.snapshot).toMatchObject({ from: '2026-02-01', to: '2026-02-28', comment: 'February.' });
    // Run again (a re-applied migration): nothing doubles.
    await db.execute(sql.raw(copy!));
    expect(await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.userId, IDS.technician))).toHaveLength(1);
  });

  it('a sent timesheet is corrected through a separate, linked, write-once record; the sent period is never touched (migration 0039)', async () => {
    const today = businessToday();
    const from = shift(today, -3);
    const to = shift(today, -1);
    const tech = await signIn('sipho@example-test.co.za');
    const added = await tech.post<{ entry: { id: string } }>(`/api/timesheets/${IDS.technician}/entries`, {
      date: to, customerName: 'ABC Engineering', overtimeHours: 2, doubleHours: 0,
    });
    expect(added.status, JSON.stringify(added.error)).toBe(200);
    expect((await tech.post(`/api/timesheets/${IDS.technician}/period/submit`, { from, to })).status).toBe(200);
    const [sentBefore] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.userId, IDS.technician));

    const body = {
      from, to, reason: 'OT was 3', comment: '',
      lines: [{ entryId: added.data.entry.id, date: to, customerName: 'ABC Engineering', overtimeHours: 3, doubleHours: 0 }],
    };
    const asked = await tech.post<{ correction: { id: string } }>(`/api/timesheets/${IDS.technician}/period/corrections`, body);
    expect(asked.status, JSON.stringify(asked.error)).toBe(200);
    expect((await tech.post(`/api/timesheets/${IDS.technician}/period/corrections`, body)).status).toBe(422);
    const told = await db.select().from(schema.notifications).where(eq(schema.notifications.type, 'timesheet_correction_requested'));
    expect(told.map((row) => row.recipientId).sort()).toEqual([IDS.coordinator, IDS.master].sort());

    const id = asked.data.correction.id;
    const [row] = await db.select().from(schema.timesheetCorrections).where(eq(schema.timesheetCorrections.id, id));
    expect(row).toMatchObject({ periodId: sentBefore!.id, userId: IDS.technician, sequence: 1, status: 'pending', requestedBy: IDS.technician });
    expect((row!.beforeSnapshot as { entries: { overtimeHours: number }[] }).entries[0]?.overtimeHours).toBe(2);
    expect((row!.afterSnapshot as { entries: { overtimeHours: number }[] }).entries[0]?.overtimeHours).toBe(3);

    // What the database refuses on its own.
    const insert = (values: Partial<typeof schema.timesheetCorrections.$inferInsert>) =>
      db.insert(schema.timesheetCorrections).values({
        id: crypto.randomUUID(), periodId: sentBefore!.id, userId: IDS.technician, sequence: 9, reason: 'x',
        beforeSnapshot: {}, afterSnapshot: {}, requestedBy: IDS.technician, requestedAt: new Date().toISOString(),
        ...values,
      });
    expect(await postgresMessage(insert({}))).toContain('timesheet_corrections_one_pending_key');
    expect(await postgresMessage(insert({ status: 'accepted', decidedBy: IDS.master, decidedAt: new Date().toISOString() }))).toContain('starts pending');
    expect(await postgresMessage(insert({ userId: IDS.coordinator, requestedBy: IDS.coordinator }))).toContain('only a timesheet sent to the office');
    expect(await postgresMessage(
      db.update(schema.timesheetCorrections).set({ reason: 'rewritten' }).where(eq(schema.timesheetCorrections.id, id)),
    )).toContain('only the decision');
    expect(await postgresMessage(
      db.update(schema.timesheetCorrections)
        .set({ status: 'accepted', decidedBy: IDS.technician, decidedAt: new Date().toISOString() })
        .where(eq(schema.timesheetCorrections.id, id)),
    )).toContain('timesheet_corrections_decided_by_another');
    expect(await postgresMessage(
      db.update(schema.timesheetCorrections)
        .set({ status: 'rejected', decidedBy: IDS.master, decidedAt: new Date().toISOString(), decisionNote: ' ' })
        .where(eq(schema.timesheetCorrections.id, id)),
    )).toContain('timesheet_corrections_rejection_explained');
    expect(await postgresMessage(db.delete(schema.timesheetCorrections).where(eq(schema.timesheetCorrections.id, id)))).toContain('cannot be deleted');

    // The office decides once; the decision is then write-once.
    const master = await signIn('elmarie@example-test.co.za');
    const decide = `/api/timesheets/${IDS.technician}/corrections/${id}/decide`;
    expect((await tech.post(decide, { decision: 'accept' })).status).toBe(403);
    const accepted = await master.post(decide, { decision: 'accept' });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
    const coordinator = await signIn('christene@example-test.co.za');
    expect((await coordinator.post(decide, { decision: 'reject', note: 'no' })).status).toBe(422);
    expect(await postgresMessage(
      db.update(schema.timesheetCorrections).set({ status: 'rejected', decisionNote: 'reversed' }).where(eq(schema.timesheetCorrections.id, id)),
    )).toContain('already decided');

    // The sent period is exactly as it was; the version in force is the correction.
    const [sentAfter] = await db.select().from(schema.timesheetPeriods).where(eq(schema.timesheetPeriods.id, sentBefore!.id));
    expect(sentAfter).toEqual(sentBefore);
    const current = await master.get<{ totals: { overtimeHours: number }; versionLabel: string }>(`/api/timesheets/${IDS.technician}/period?from=${from}&to=${to}`);
    expect(current.data.totals.overtimeHours).toBe(3);
    expect(current.data.versionLabel).toMatch(/^Correction 1, accepted/u);
    const original = await master.get<{ totals: { overtimeHours: number } }>(`/api/timesheets/${IDS.technician}/period?from=${from}&to=${to}&version=original`);
    expect(original.data.totals.overtimeHours).toBe(2);
    const decided = await db.select().from(schema.notifications).where(eq(schema.notifications.type, 'timesheet_correction_decided'));
    expect(decided.map((n) => n.recipientId)).toEqual([IDS.technician]);
  });

  it('an issued Delivery Note is one per job and write-once (migration 0038)', async () => {
    const master = await signIn('elmarie@example-test.co.za');
    const created = await master.post<{ id: string }>('/api/jobs', {
      customerId: IDS.customer, siteId: IDS.site, contactId: IDS.contact, machineId: null, jobType: 'parts',
      priority: null, scheduledDate: null, scheduledEndDate: null, orderNumber: '', referenceNumber: '',
      faultDescription: '', primaryTechnicianId: null, courierCollection: false, deliveryNote: '',
    });
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    const row = {
      jobId: created.data.id, fileName: 'EJE-X-Delivery-Note.pdf', pageCount: 1, sizeBytes: 100,
      generatedAt: '2026-10-28T10:00:00.000Z', jobCardDocumentKey: 'jobcards/final/EJE-X.pdf',
      signedByName: 'Johan Pretorius', signedAt: '2026-10-28T09:59:00.000Z', signatureSha256: 'a'.repeat(64),
    };
    const id = crypto.randomUUID();
    await db.insert(schema.deliveryNoteDocuments).values({ id, storageKey: 'jobcards/final/EJE-X-delivery-note.pdf', ...row });
    expect(await postgresMessage(
      db.insert(schema.deliveryNoteDocuments).values({ id: crypto.randomUUID(), storageKey: 'other-key.pdf', ...row }),
    )).toContain('delivery_note_documents_job_key');
    expect(await postgresMessage(
      db.update(schema.deliveryNoteDocuments).set({ signedByName: 'Somebody else' }).where(eq(schema.deliveryNoteDocuments.id, id)),
    )).toContain('write-once');
    expect(await postgresMessage(
      db.delete(schema.deliveryNoteDocuments).where(eq(schema.deliveryNoteDocuments.id, id)),
    )).toContain('write-once');
    // A signature is recorded whole or not at all.
    expect(await postgresMessage(
      db.insert(schema.deliveryNoteDocuments).values({ ...row, id: crypto.randomUUID(), storageKey: 'third.pdf', jobId: created.data.id, signatureSha256: null }),
    )).toMatch(/delivery_note_documents_(signature_whole|job_key)/u);
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
