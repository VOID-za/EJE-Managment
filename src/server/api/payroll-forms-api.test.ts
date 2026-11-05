import { beforeEach, describe, expect, it } from 'vitest';
import { businessToday } from '@/lib/business-time';
import { monthBounds, monthOfDate, previousMonth } from '@/lib/payroll-files';
import { DEMO_USERS, signedInAs, startTestServer, submitForms } from '@/test/api-harness';

/**
 * PAYROLL-ONE-1 THROUGH THE REAL ROUTES: the lines saving themselves, the
 * forms for a period, the rename, the one submission — what a client gets
 * without the screen.
 */
const SIPHO = 'user-tech-sipho';
const MONTH = previousMonth(monthOfDate(businessToday()));
const { from: FROM, to: TO } = monthBounds(MONTH);
const fileNameOf = (disposition: string | null): string =>
  decodeURIComponent(/filename\*=UTF-8''([^;]+)/u.exec(disposition ?? '')?.[1] ?? '');
const typed = (overtime: string, customerName = 'ABC Engineering') => ({
  pick: '', customerName, overtime, double: '0', callout: '0', internalKm: '0', customerKm: '0',
});

describe('payroll forms over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('a line saves as typed — complete, or a draft — and a save from an older revision is refused', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const id = crypto.randomUUID();
    const draft = await technician.post<{ line: { revision: string; complete: boolean; problems: readonly { field: string }[] } }>(
      `/api/timesheets/${SIPHO}/lines`, { id, date: `${MONTH}-03`, typed: typed('abc'), expectedRevision: null },
    );
    expect(draft.status, JSON.stringify(draft.error)).toBe(200);
    expect(draft.data.line).toMatchObject({ complete: false, problems: [{ field: 'overtime' }] });
    const lines = await technician.get<readonly { id: string; complete: boolean }[]>(`/api/timesheets/${SIPHO}/lines`);
    expect(lines.data.find((candidate) => candidate.id === id)?.complete).toBe(false);
    const fixed = await technician.post<{ line: { revision: string; complete: boolean } }>(
      `/api/timesheets/${SIPHO}/lines`, { id, date: `${MONTH}-03`, typed: typed('2'), expectedRevision: draft.data.line.revision },
    );
    expect(fixed.data.line.complete).toBe(true);
    const stale = await technician.post(`/api/timesheets/${SIPHO}/lines`, { id, date: `${MONTH}-03`, typed: typed('5'), expectedRevision: draft.data.line.revision });
    expect(stale.status).toBe(422);
    expect(stale.error?.violations[0]?.code).toBe('timesheet_line_changed');
    // Unknown fields are refused by the schema, not ignored; the office and another technician write nothing.
    expect((await technician.post(`/api/timesheets/${SIPHO}/lines`, { id, date: `${MONTH}-03`, typed: typed('5'), expectedRevision: null, entryId: id })).status).toBe(400);
    const master = await signedInAs(DEMO_USERS.master);
    expect((await master.post(`/api/timesheets/${SIPHO}/lines`, { id: crypto.randomUUID(), date: `${MONTH}-03`, typed: typed('1'), expectedRevision: null })).status).toBe(403);
    expect((await master.post(`/api/timesheets/${SIPHO}/lines/${id}/remove`, {})).status).toBe(403);
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await riaan.get(`/api/timesheets/${SIPHO}/lines`)).status).toBe(403);
    expect((await technician.post(`/api/timesheets/${SIPHO}/lines/${id}/remove`, {})).data).toEqual({ removed: true });
    expect((await technician.post(`/api/timesheets/${SIPHO}/lines/${id}/remove`, {})).data).toEqual({ removed: false });
  });

  it('the working PDFs download under the stored name; a rename is validated, kept and the owner’s only', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    const pdf = (kind: string) => technician.download(`/api/payroll/forms/${SIPHO}/${kind}/pdf?from=${FROM}&to=${TO}`);
    expect(fileNameOf((await pdf('attendance')).headers.get('content-disposition'))).toMatch(/ ATTEN [A-Z]+\.pdf$/u);
    const renamed = await technician.post<{ fileName: string }>(`/api/payroll/forms/${SIPHO}/rename`, { kind: 'attendance', name: 'Sipho — Attendance' });
    expect(renamed.status).toBe(422);
    expect(renamed.error?.violations[0]?.code).toBe('invalid_file_name');
    const ok = await technician.post<{ fileName: string }>(`/api/payroll/forms/${SIPHO}/rename`, { kind: 'attendance', name: 'Sipho Attendance Ünïcode' });
    expect(ok.data.fileName).toBe('Sipho Attendance Ünïcode.pdf');
    const file = await pdf('attendance');
    expect(file.status).toBe(200);
    expect(fileNameOf(file.headers.get('content-disposition'))).toBe('Sipho Attendance Ünïcode.pdf');
    // Signing out and in again: the same name (it is the server's).
    const again = await signedInAs(DEMO_USERS.technician);
    expect((await again.get<{ fileNames: { attendance: string } }>(`/api/payroll/forms/${SIPHO}?from=${FROM}&to=${TO}`)).data.fileNames.attendance).toBe('Sipho Attendance Ünïcode.pdf');
    for (const traversal of ['../../x', 'a/b', 'a\\b', 'C:x']) {
      expect((await technician.post(`/api/payroll/forms/${SIPHO}/rename`, { kind: 'timesheet', name: traversal })).status, traversal).toBe(422);
    }
    const master = await signedInAs(DEMO_USERS.master);
    expect((await master.post(`/api/payroll/forms/${SIPHO}/rename`, { kind: 'timesheet', name: 'x' })).status).toBe(403);
    expect((await master.download(`/api/payroll/forms/${SIPHO}/attendance/pdf?from=${FROM}&to=${TO}`)).status).toBe(200);
    expect((await (await signedInAs(DEMO_USERS.otherTechnician)).download(`/api/payroll/forms/${SIPHO}/attendance/pdf?from=${FROM}&to=${TO}`)).status).toBe(403);
  });

  it('one submission of both forms: a replayed request is answered from the record; the stored PDFs download as they went', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    await technician.post(`/api/timesheets/${SIPHO}/lines`, { id: crypto.randomUUID(), date: `${MONTH}-05`, typed: typed('1'), expectedRevision: null });
    const forms = await technician.get<{ revision: string; financeMonth: string }>(`/api/payroll/forms/${SIPHO}?from=${FROM}&to=${TO}`);
    expect(forms.data.financeMonth).toBe(MONTH);
    const body = { from: FROM, to: TO, revision: forms.data.revision, confirmUnrecorded: true };
    const first = await technician.post<{ submission: { id: string; documents: readonly { kind: string; fileName: string }[] } }>(
      `/api/payroll/forms/${SIPHO}/submit`, body, { idempotencyKey: 'pay-forms-1' },
    );
    expect(first.status, JSON.stringify(first.error)).toBe(200);
    const replay = await technician.post<{ submission: { id: string } }>(`/api/payroll/forms/${SIPHO}/submit`, body, { idempotencyKey: 'pay-forms-1' });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(replay.data.submission.id).toBe(first.data.submission.id);
    // A fresh second request is refused: the forms are no longer what it reviewed.
    expect((await technician.post(`/api/payroll/forms/${SIPHO}/submit`, body)).error?.violations[0]?.code).toBe('payroll_forms_changed');
    const history = await technician.get<readonly { id: string }[]>(`/api/payroll/forms/${SIPHO}/history`);
    expect(history.data.map((entry) => entry.id)).toEqual([first.data.submission.id]);
    for (const document of first.data.submission.documents) {
      const file = await technician.download(`/api/payroll/submissions/${first.data.submission.id}/${document.kind}/pdf`);
      expect(file.status).toBe(200);
      expect(fileNameOf(file.headers.get('content-disposition'))).toBe(document.fileName);
      expect(file.headers.get('x-content-sha256')).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect((await (await signedInAs(DEMO_USERS.otherTechnician)).download(`/api/payroll/submissions/${first.data.submission.id}/attendance/pdf`)).status).toBe(422);
    expect((await (await signedInAs(DEMO_USERS.coordinator)).download(`/api/payroll/submissions/${first.data.submission.id}/attendance/pdf`)).status).toBe(200);
  });

  it('a partial overlap is refused naming it; the two old submission points are retired', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    expect((await submitForms(technician, SIPHO, FROM, TO)).status).toBe(200);
    // Days 20–28 are only part of the month submitted: refused, even with the replacement confirmed.
    const partial = await submitForms(technician, SIPHO, `${MONTH}-20`, `${MONTH}-28`, { confirmReplace: true });
    expect(partial.status).toBe(422);
    expect(partial.error?.violations[0]?.code).toBe('payroll_partial_overlap');
    const cut = await technician.get<{ partialOverlaps: readonly unknown[]; canSubmit: boolean }>(`/api/payroll/forms/${SIPHO}?from=${MONTH}-20&to=${monthBounds(monthOfDate(businessToday())).from}`);
    expect(cut.data.partialOverlaps).toHaveLength(1);
    expect(cut.data.canSubmit).toBe(false);
    for (const path of [`/api/timesheets/${SIPHO}/period/submit`, `/api/payroll/${SIPHO}/${MONTH}/submit`]) {
      const answer = await technician.post(path, { from: FROM, to: TO, confirmUnrecorded: true });
      expect(answer.status, path).toBe(422);
      expect(answer.error?.violations[0]?.code).toBe('submission_moved');
    }
  });
});
