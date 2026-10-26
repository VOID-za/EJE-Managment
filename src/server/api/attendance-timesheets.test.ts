import { beforeEach, describe, expect, it } from 'vitest';
import { businessToday } from '@/lib/business-time';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * ATTEND-1 AND TIMESHEET-1 THROUGH THE REAL ROUTES.
 *
 * The permissions are decided on the server, so they are proved here against
 * the HTTP surface: the register and every other person's timesheet are the
 * office's, a technician's own timesheet is theirs, and an export is audited.
 */
interface Register {
  readonly rows: readonly { user: { id: string }; record: { status: string } | null }[];
}
interface Sheet {
  readonly technician: { id: string };
  readonly rows: readonly { date: string; comment: string }[];
}

describe('the attendance register over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('the office records a day and reads it back; a technician is refused both', async () => {
    const today = businessToday();
    const office = await signedInAs(DEMO_USERS.coordinator);
    const recorded = await office.post('/api/attendance', {
      userId: 'user-tech-sipho', date: today, status: 'present', note: '',
    });
    expect(recorded.status).toBe(200);
    const register = await office.get<Register>(`/api/attendance?date=${today}`);
    expect(register.status).toBe(200);
    expect(register.data.rows.find((row) => row.user.id === 'user-tech-sipho')?.record?.status).toBe('present');

    const technician = await signedInAs(DEMO_USERS.technician);
    expect((await technician.get(`/api/attendance?date=${today}`)).status).toBe(403);
    const refused = await technician.post('/api/attendance', {
      userId: 'user-tech-sipho', date: today, status: 'present', note: '',
    });
    expect(refused.status).toBe(403);
  });

  it('a status that is not present or absent never reaches the operation', async () => {
    const office = await signedInAs(DEMO_USERS.master);
    const response = await office.post('/api/attendance', {
      userId: 'user-tech-sipho', date: businessToday(), status: 'late', note: '',
    });
    expect(response.status).toBe(400);
  });
});

describe('timesheets over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('a technician reads and comments on their own sheet, and is refused anybody else’s', async () => {
    const today = businessToday();
    const technician = await signedInAs(DEMO_USERS.technician);
    const own = await technician.get<Sheet>(`/api/timesheets/user-tech-sipho?from=${today}&to=${today}`);
    expect(own.status).toBe(200);

    const comment = await technician.post('/api/timesheets/user-tech-sipho/comment', {
      date: today, comment: 'Waited for the crane',
    });
    expect(comment.status).toBe(200);
    const after = await technician.get<Sheet>(`/api/timesheets/user-tech-sipho?from=${today}&to=${today}`);
    expect(after.data.rows.find((row) => row.date === today)?.comment).toBe('Waited for the crane');

    expect((await technician.get(`/api/timesheets/user-tech-riaan?from=${today}&to=${today}`)).status).toBe(403);
    expect(
      (await technician.post('/api/timesheets/user-tech-riaan/comment', { date: today, comment: 'x' })).status,
    ).toBe(403);
    expect((await technician.get<readonly { id: string }[]>('/api/timesheets')).data.map((person) => person.id))
      .toEqual(['user-tech-sipho']);
  });

  it('the office exports a technician’s sheet as a CSV, and the export is on the audit trail', async () => {
    const today = businessToday();
    const office = await signedInAs(DEMO_USERS.master);
    const file = await office.download(`/api/timesheets/user-tech-sipho/export?from=${today}&to=${today}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/csv');
    expect(file.text.replace(/^﻿/u, '').split('\r\n')[0]).toBe(
      'Date,Customer,Jobs,Normal,OT,Dblt,Callout,Comments,Attendance',
    );

    const activity = await office.get<{ events: readonly { type: string; summary: string }[] }>('/api/activity');
    expect(activity.status).toBe(200);
    expect(
      activity.data.events.some(
        (event) => event.type === 'data_exported' && event.summary.startsWith('A technician timesheet exported'),
      ),
    ).toBe(true);
  });
});
