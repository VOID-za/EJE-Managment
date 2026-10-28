import { beforeEach, describe, expect, it } from 'vitest';
import { businessToday } from '@/lib/business-time';
import { monthOf } from '@/lib/timesheet-dates';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * THE REVIEWER'S CHANGES THROUGH THE REAL ROUTES (28 October 2026).
 *
 * Send to office, its lock, the PDF Layout and the delivery note are each a
 * permission or a state rule, so each is proved against the HTTP surface — a
 * client that never loads the screen gets exactly the same answers.
 */
interface MonthDocument {
  readonly technicianName: string;
  readonly comment: string;
  readonly submittedAt: string | null;
  readonly rows: readonly { recorded: boolean; customer: string }[];
}

describe('timesheet Send to office over HTTP (TS-02, TS-03, TS-14)', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('sends once, then the month is read-only for the technician; the office reads the submitted version', async () => {
    const today = businessToday();
    const month = monthOf(today);
    const technician = await signedInAs(DEMO_USERS.technician);
    const added = await technician.post<{ entry: { id: string } }>('/api/timesheets/user-tech-sipho/entries', {
      date: today, customerName: '', workshop: true, overtimeHours: 2, doubleHours: 0, calloutAmount: 0,
    });
    expect(added.status, JSON.stringify(added.error)).toBe(200);
    expect((await technician.post(`/api/timesheets/user-tech-sipho/months/${month}/comment`, { comment: 'Bench day.' })).status).toBe(200);

    const sent = await technician.post<{ month: { submittedAt: string } }>(`/api/timesheets/user-tech-sipho/months/${month}/submit`, {});
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect(sent.data.month.submittedAt).toBeTruthy();

    // The lock, on every write path, and no second submission.
    expect((await technician.post(`/api/timesheets/user-tech-sipho/months/${month}/submit`, {})).status).toBe(422);
    expect((await technician.post('/api/timesheets/user-tech-sipho/entries', {
      date: today, customerName: 'X', overtimeHours: 1, doubleHours: 0,
    })).status).toBe(422);
    expect((await technician.post(`/api/timesheets/user-tech-sipho/entries/${added.data.entry.id}/remove`, {})).status).toBe(422);
    expect((await technician.post(`/api/timesheets/user-tech-sipho/months/${month}/comment`, { comment: 'changed' })).status).toBe(422);

    // The office reads what was sent, read-only.
    const office = await signedInAs(DEMO_USERS.coordinator);
    const document = await office.get<MonthDocument>(`/api/timesheets/user-tech-sipho/months/${month}`);
    expect(document.status).toBe(200);
    expect(document.data).toMatchObject({ technicianName: 'Sipho Mahlangu', comment: 'Bench day.' });
    expect(document.data.submittedAt).toBe(sent.data.month.submittedAt);
    expect(document.data.rows.filter((row) => row.recorded).map((row) => row.customer)).toEqual(['Workshop']);
    expect((await office.post(`/api/timesheets/user-tech-sipho/months/${month}/submit`, {})).status).toBe(403);
    expect((await office.post(`/api/timesheets/user-tech-sipho/months/${month}/comment`, { comment: 'x' })).status).toBe(403);
  });

  it('the PDF Layout: the owner and the office get it; another technician does not', async () => {
    const month = monthOf(businessToday());
    const technician = await signedInAs(DEMO_USERS.technician);
    const own = await technician.download(`/api/timesheets/user-tech-sipho/months/${month}/pdf`);
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('application/pdf');
    expect(own.text.slice(0, 5)).toBe('%PDF-');
    const office = await signedInAs(DEMO_USERS.master);
    expect((await office.download(`/api/timesheets/user-tech-sipho/months/${month}/pdf`)).status).toBe(200);
    const other = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await other.download(`/api/timesheets/user-tech-sipho/months/${month}/pdf`)).status).toBe(403);
    expect((await other.get(`/api/timesheets/user-tech-sipho/months/${month}`)).status).toBe(403);
    expect((await other.post(`/api/timesheets/user-tech-sipho/months/${month}/submit`, {})).status).toBe(403);
    // Opening it wrote nothing: the month is still a draft.
    expect((await office.get<MonthDocument>(`/api/timesheets/user-tech-sipho/months/${month}`)).data.submittedAt).toBeNull();
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
