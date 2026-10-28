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
  readonly editable: boolean;
  readonly days: readonly {
    date: string;
    comment: string;
    recorded: boolean;
    entries: readonly { id: string; customerName: string; overtimeHours: number; workshop: boolean }[];
  }[];
}

describe('the attendance register over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('the office records a day and reads it back; a technician records only their OWN day and cannot read the register', async () => {
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
    // ATTEND-2: their own day, yes; somebody else's, no.
    const own = await technician.post('/api/attendance', {
      userId: 'user-tech-sipho', date: today, status: 'absent', absenceReason: 'sick_leave', note: '',
    });
    expect(own.status).toBe(200);
    const refused = await technician.post('/api/attendance', {
      userId: 'user-tech-riaan', date: today, status: 'present', note: '',
    });
    expect(refused.status).toBe(403);
    const mine = await technician.get<{ days: readonly { date: string; record: { status: string } | null }[] }>(
      `/api/attendance/mine?from=${today}&to=${today}`,
    );
    expect(mine.status).toBe(200);
    expect(mine.data.days[0]?.record?.status).toBe('absent');
  });

  it('the office exports a range as a CSV, audited; a technician is refused', async () => {
    const today = businessToday();
    const office = await signedInAs(DEMO_USERS.master);
    await office.post('/api/attendance', { userId: 'user-tech-sipho', date: today, status: 'present', note: '' });
    const file = await office.download(`/api/attendance/export?from=${today}&to=${today}`);
    expect(file.status).toBe(200);
    const lines = file.text.replace(/^﻿/u, '').trim().split('\r\n');
    expect(lines[0]).toBe('Date,Person,Role,Attendance,Absence reason,Note,Recorded by,Recorded at,Planned leave');
    expect(lines.some((line) => line.includes('Sipho Mahlangu') && line.includes('Present'))).toBe(true);
    const activity = await office.get<{ events: readonly { type: string; summary: string }[] }>('/api/activity');
    expect(activity.data.events.some((event) => event.type === 'data_exported' && event.summary.startsWith('The attendance register exported'))).toBe(true);

    const technician = await signedInAs(DEMO_USERS.technician);
    expect((await technician.download(`/api/attendance/export?from=${today}&to=${today}`)).status).toBe(403);
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

  it('a technician enters, corrects and removes their OWN lines; nobody else may (TIMESHEET-2)', async () => {
    const today = businessToday();
    const technician = await signedInAs(DEMO_USERS.technician);
    const added = await technician.post<{ entry: { id: string } }>('/api/timesheets/user-tech-sipho/entries', {
      date: today, customerName: 'ABC Engineering', overtimeHours: 1, doubleHours: 0, calloutAmount: 45000,
    });
    expect(added.status).toBe(200);
    const id = added.data.entry.id;
    const corrected = await technician.post('/api/timesheets/user-tech-sipho/entries', {
      entryId: id, date: today, customerName: 'ABC Engineering', overtimeHours: 2.5, doubleHours: 0, calloutAmount: 45000,
    });
    expect(corrected.status).toBe(200);
    const sheet = await technician.get<Sheet>(`/api/timesheets/user-tech-sipho?from=${today}&to=${today}`);
    expect(sheet.data.editable).toBe(true);
    expect(sheet.data.days[0]).toMatchObject({ recorded: true });
    expect(sheet.data.days[0]?.entries.map((entry) => entry.overtimeHours)).toEqual([2.5]);

    // Not on somebody else's sheet, and not the office on the technician's.
    expect((await technician.post('/api/timesheets/user-tech-riaan/entries', {
      date: today, customerName: 'X', overtimeHours: 1, doubleHours: 0,
    })).status).toBe(403);
    const office = await signedInAs(DEMO_USERS.master);
    expect((await office.post('/api/timesheets/user-tech-sipho/entries', {
      date: today, customerName: 'X', overtimeHours: 1, doubleHours: 0,
    })).status).toBe(403);
    expect((await office.get<Sheet>(`/api/timesheets/user-tech-sipho?from=${today}&to=${today}`)).data.editable).toBe(false);
    // A value the schema refuses never reaches the operation.
    expect((await technician.post('/api/timesheets/user-tech-sipho/entries', {
      date: today, customerName: 'X', overtimeHours: 30, doubleHours: 0,
    })).status).toBe(400);
    // NT is not entered on a new line (TS-07): refused by the operation, 422.
    expect((await technician.post('/api/timesheets/user-tech-sipho/entries', {
      date: today, customerName: 'X', normalHours: 4, overtimeHours: 0, doubleHours: 0,
    })).status).toBe(422);

    const removed = await technician.post(`/api/timesheets/user-tech-sipho/entries/${id}/remove`, {});
    expect(removed.status).toBe(200);
    const after = await technician.get<Sheet>(`/api/timesheets/user-tech-sipho?from=${today}&to=${today}`);
    expect(after.data.days[0]?.recorded).toBe(false);
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
    expect(after.data.days.find((day) => day.date === today)?.comment).toBe('Waited for the crane');

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
      'Date,Day,Customer,OT,DT,Callout (R),Callout shared,Internal km,Customer km,NT (historical),Callouts (historical count),Day comment (historical),Attendance',
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
