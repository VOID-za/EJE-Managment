import { beforeEach, describe, expect, it } from 'vitest';
import { businessToday } from '@/lib/business-time';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * THE REVIEWER'S CHANGES THROUGH THE REAL ROUTES (28 October 2026).
 *
 * Send to office, its lock, the PDF Layout and the delivery note are each a
 * permission or a state rule, so each is proved against the HTTP surface — a
 * client that never loads the screen gets exactly the same answers.
 */
/** A calendar date `days` from another, by the calendar (no time zone). */
const shift = (date: string, days: number): string => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

interface PeriodDocument {
  readonly technicianName: string;
  readonly from: string;
  readonly to: string;
  readonly comment: string;
  readonly submittedAt: string | null;
  readonly rows: readonly { recorded: boolean; customer: string }[];
}

describe('timesheet Send to office over HTTP, for a chosen From/To period (TS-02, TS-03, TS-14)', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('sends once, then the period is read-only for the technician; the office is notified and reads the submitted version', async () => {
    const today = businessToday();
    const from = shift(today, -2);
    const period = `from=${from}&to=${today}`;
    const technician = await signedInAs(DEMO_USERS.technician);
    const added = await technician.post<{ entry: { id: string } }>('/api/timesheets/user-tech-sipho/entries', {
      date: today, customerName: '', workshop: true, overtimeHours: 2, doubleHours: 0, calloutAmount: 0,
    });
    expect(added.status, JSON.stringify(added.error)).toBe(200);
    expect((await technician.post('/api/timesheets/user-tech-sipho/period/comment', { from, to: today, comment: 'Bench days.' })).status).toBe(200);

    const sent = await technician.post<{ period: { submittedAt: string; from: string; to: string } }>('/api/timesheets/user-tech-sipho/period/submit', { from, to: today });
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect(sent.data.period).toMatchObject({ from, to: today });

    // The lock, on every write path; no second submission; no overlapping one.
    expect((await technician.post('/api/timesheets/user-tech-sipho/period/submit', { from, to: today })).status).toBe(422);
    expect((await technician.post('/api/timesheets/user-tech-sipho/period/submit', { from: shift(today, -5), to: from })).status).toBe(422);
    expect((await technician.post('/api/timesheets/user-tech-sipho/entries', {
      date: today, customerName: 'X', overtimeHours: 1, doubleHours: 0,
    })).status).toBe(422);
    expect((await technician.post(`/api/timesheets/user-tech-sipho/entries/${added.data.entry.id}/remove`, {})).status).toBe(422);
    expect((await technician.post('/api/timesheets/user-tech-sipho/period/comment', { from, to: today, comment: 'changed' })).status).toBe(422);

    // The office was told — in-app, through the existing notifications.
    const office = await signedInAs(DEMO_USERS.coordinator);
    const notes = await office.get<{ notifications: readonly { type: string; title: string; link: string | null }[] }>('/api/notifications');
    const told = notes.data.notifications.filter((n) => n.type === 'timesheet_submitted');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ link: '/timesheets' });
    expect(told[0]!.title).toContain('Sipho');

    // The office reads what was sent, read-only.
    const document = await office.get<PeriodDocument>(`/api/timesheets/user-tech-sipho/period?${period}`);
    expect(document.status).toBe(200);
    expect(document.data).toMatchObject({ technicianName: 'Sipho Mahlangu', comment: 'Bench days.', from, to: today });
    expect(document.data.submittedAt).toBe(sent.data.period.submittedAt);
    expect(document.data.rows.filter((row) => row.recorded).map((row) => row.customer)).toEqual(['Workshop']);
    expect((await office.post('/api/timesheets/user-tech-sipho/period/submit', { from, to: today })).status).toBe(403);
    expect((await office.post('/api/timesheets/user-tech-sipho/period/comment', { from, to: today, comment: 'x' })).status).toBe(403);
  });

  it('the PDF Layout: the owner and the office get it; another technician does not; From after To is refused', async () => {
    const today = businessToday();
    const period = `from=${shift(today, -6)}&to=${today}`;
    const technician = await signedInAs(DEMO_USERS.technician);
    const own = await technician.download(`/api/timesheets/user-tech-sipho/period/pdf?${period}`);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('application/pdf');
    expect(own.text.slice(0, 5)).toBe('%PDF-');
    for (const header of ['Date', 'Customer', 'OT', 'D/T', 'Callout', 'Int Km', 'Cust Km']) expect(own.text, header).toContain(`(${header})`);
    expect(own.text).not.toContain('(Hm)');
    const office = await signedInAs(DEMO_USERS.master);
    expect((await office.download(`/api/timesheets/user-tech-sipho/period/pdf?${period}`)).status).toBe(200);
    const other = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await other.download(`/api/timesheets/user-tech-sipho/period/pdf?${period}`)).status).toBe(403);
    expect((await other.get(`/api/timesheets/user-tech-sipho/period?${period}`)).status).toBe(403);
    expect((await other.post('/api/timesheets/user-tech-sipho/period/submit', { from: shift(today, -6), to: today })).status).toBe(403);
    expect((await technician.get(`/api/timesheets/user-tech-sipho/period?from=${today}&to=${shift(today, -6)}`)).status).toBe(422);
    // Opening it wrote nothing: the period is still a draft.
    expect((await office.get<PeriodDocument>(`/api/timesheets/user-tech-sipho/period?${period}`)).data.submittedAt).toBeNull();
  });
});

describe('the attendance absence reason over HTTP (ATT-01)', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('refuses an absent day without a valid reason and records one with it', async () => {
    const today = businessToday();
    const technician = await signedInAs(DEMO_USERS.technician);
    const base = { userId: 'user-tech-sipho', date: today, status: 'absent', note: '' };
    expect((await technician.post('/api/attendance', base)).status).toBe(422);
    expect((await technician.post('/api/attendance', { ...base, absenceReason: 'holiday' })).status).toBe(422);
    const ok = await technician.post<{ absenceReason: string }>('/api/attendance', { ...base, absenceReason: 'iod' });
    expect(ok.status).toBe(200);
    expect(ok.data.absenceReason).toBe('iod');
    // ATT-02: never another technician's day.
    expect((await technician.post('/api/attendance', { ...base, userId: 'user-tech-riaan', absenceReason: 'leave' })).status).toBe(403);
  });
});

describe('the delivery note over HTTP (PARTS-03/04/05)', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('is produced for a courier collection only, as a separate PDF, for whoever may see the job', async () => {
    const office = await signedInAs(DEMO_USERS.master);
    const screen = await office.get<{ view: { job: { id: string; status: string; jobType: string } } }>('/api/jobs/EJE-1064');
    expect(screen.status).toBe(200);
    const job = screen.data.view.job;
    expect(job).toMatchObject({ jobType: 'parts', status: 'completion' });

    // Not a courier collection yet: there is no delivery note.
    expect((await office.post(`/api/jobs/${job.id}/generate_delivery_note`, {})).status).toBe(422);

    const courier = await office.post(`/api/jobs/${job.id}/set_collection`, { courier: true, waybillNumber: 'DAW-1' });
    expect(courier.status, JSON.stringify(courier.error)).toBe(200);
    const note = await office.post<{ fileName: string; contentType: string; base64: string }>(`/api/jobs/${job.id}/generate_delivery_note`, {});
    expect(note.status, JSON.stringify(note.error)).toBe(200);
    expect(note.data.contentType).toBe('application/pdf');
    expect(Buffer.from(note.data.base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');

    // A technician who is not on the job cannot reach it at all.
    const other = await signedInAs(DEMO_USERS.otherTechnician);
    const refused = await other.post(`/api/jobs/${job.id}/generate_delivery_note`, {});
    expect([403, 404]).toContain(refused.status);
  });
});

describe('correcting a sent timesheet over HTTP (TS-16)', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('asks, refuses every bypass, replays a retry without duplicating, and lets the office decide once', async () => {
    const today = businessToday();
    const from = shift(today, -3);
    const to = shift(today, -1);
    const technician = await signedInAs(DEMO_USERS.technician);
    const added = await technician.post<{ entry: { id: string } }>('/api/timesheets/user-tech-sipho/entries', {
      date: to, customerName: 'ABC Engineering', overtimeHours: 2, doubleHours: 0, calloutAmount: 0,
    });
    expect(added.status, JSON.stringify(added.error)).toBe(200);
    expect((await technician.post('/api/timesheets/user-tech-sipho/period/submit', { from, to })).status).toBe(200);

    const body = {
      from,
      to,
      reason: 'Overtime was 3 hours, not 2',
      comment: '',
      lines: [{ entryId: added.data.entry.id, date: to, customerName: 'ABC Engineering', overtimeHours: 3, doubleHours: 0, calloutAmount: 0 }],
    };
    // Another technician, and the office, cannot ask on Sipho's behalf.
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await riaan.post('/api/timesheets/user-tech-sipho/period/corrections', body)).status).toBe(403);
    const master = await signedInAs(DEMO_USERS.master);
    expect((await master.post('/api/timesheets/user-tech-sipho/period/corrections', body)).status).toBe(403);
    // Unknown fields are refused by the schema, not ignored.
    expect((await technician.post('/api/timesheets/user-tech-sipho/period/corrections', { ...body, status: 'accepted' })).status).toBe(400);

    const asked = await technician.post<{ correction: { id: string; sequence: number; status: string } }>(
      '/api/timesheets/user-tech-sipho/period/corrections', body, { idempotencyKey: 'ts16-ask-1' },
    );
    expect(asked.status, JSON.stringify(asked.error)).toBe(200);
    expect(asked.data.correction).toMatchObject({ sequence: 1, status: 'pending' });
    // The same request retried (same key) is answered from the record: the same correction, not a second.
    const replay = await technician.post<{ correction: { id: string } }>(
      '/api/timesheets/user-tech-sipho/period/corrections', body, { idempotencyKey: 'ts16-ask-1' },
    );
    expect(replay.status).toBe(200);
    expect(replay.data.correction.id).toBe(asked.data.correction.id);
    // A fresh second request while one is pending is refused.
    expect((await technician.post('/api/timesheets/user-tech-sipho/period/corrections', body)).status).toBe(422);

    const decide = `/api/timesheets/user-tech-sipho/corrections/${asked.data.correction.id}/decide`;
    expect((await technician.post(decide, { decision: 'accept' })).status).toBe(403);
    expect((await riaan.post(decide, { decision: 'accept' })).status).toBe(403);
    const pending = await master.get<readonly { id: string }[]>('/api/timesheets/corrections/pending');
    expect(pending.data.map((row) => row.id)).toContain(asked.data.correction.id);
    expect((await technician.get<readonly unknown[]>('/api/timesheets/corrections/pending')).data).toEqual([]);

    const accepted = await master.post<{ correction: { status: string } }>(decide, { decision: 'accept' });
    expect(accepted.status, JSON.stringify(accepted.error)).toBe(200);
    expect(accepted.data.correction.status).toBe('accepted');
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    expect((await coordinator.post(decide, { decision: 'reject', note: 'no' })).status).toBe(422);

    // The version in force, and the original, through the period read and the PDF.
    const current = await master.get<PeriodDocument & { versionLabel: string; inForce: boolean }>(`/api/timesheets/user-tech-sipho/period?from=${from}&to=${to}`);
    expect(current.data.versionLabel).toMatch(/^Correction 1, accepted/u);
    const original = await master.get<PeriodDocument & { versionLabel: string; inForce: boolean }>(`/api/timesheets/user-tech-sipho/period?from=${from}&to=${to}&version=original`);
    expect(original.data.inForce).toBe(false);
    expect((await master.get(`/api/timesheets/user-tech-sipho/period?from=${from}&to=${to}&version=bogus`)).status).toBe(400);
    expect((await riaan.get(`/api/timesheets/user-tech-sipho/period?from=${from}&to=${to}&version=original`)).status).toBe(403);
    const told = await technician.get<{ notifications: readonly { type: string }[] }>('/api/notifications');
    expect(told.data.notifications.filter((n) => n.type === 'timesheet_correction_decided')).toHaveLength(1);
  });
});
