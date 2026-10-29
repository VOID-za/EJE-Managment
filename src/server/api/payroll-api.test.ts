import { beforeEach, describe, expect, it } from 'vitest';
import { businessToday } from '@/lib/business-time';
import { monthOfDate, previousMonth } from '@/lib/payroll-files';
import { pdfPageTexts } from '@/lib/pdf/inspect';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * PAY-01 … PAY-08 THROUGH THE REAL ROUTES. A client that never loads the
 * screen gets exactly the same answers: own forms only, the office's month and
 * package only for the office, ONE-page PDFs under the agreed file names, and
 * one send. The demonstration's email is simulated (its outbox), never real.
 */
const MONTH = previousMonth(monthOfDate(businessToday()));
const SIPHO = 'user-tech-sipho';

const fileNameOf = (disposition: string | null): string =>
  decodeURIComponent(/filename\*=UTF-8''([^;]+)/u.exec(disposition ?? '')?.[1] ?? '');

describe('monthly payroll over HTTP', () => {
  beforeEach(() => {
    startTestServer();
  });

  it('serves each form as ONE page under its file name; only to the technician and the office', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    for (const [kind, pattern] of [['timesheet', / TIMESHEET [A-Z]{3}\.pdf$/u], ['attendance', / ATTEN [A-Z]+\.pdf$/u]] as const) {
      const file = await technician.download(`/api/payroll/${SIPHO}/${MONTH}/${kind}/pdf`);
      expect(file.status, file.text.slice(0, 200)).toBe(200);
      expect(file.headers.get('content-type')).toContain('application/pdf');
      expect(fileNameOf(file.headers.get('content-disposition'))).toMatch(pattern);
      expect(file.headers.get('x-page-count')).toBe('1');
      expect(pdfPageTexts(new Uint8Array(file.bytes))).toHaveLength(1);
    }
    const other = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await other.download(`/api/payroll/${SIPHO}/${MONTH}/timesheet/pdf`)).status).toBe(403);
    expect((await other.download(`/api/payroll/${SIPHO}/${MONTH}/attendance/pdf`)).status).toBe(403);
    expect((await other.get(`/api/payroll/${SIPHO}/${MONTH}`)).status).toBe(403);
    const office = await signedInAs(DEMO_USERS.coordinator);
    expect((await office.download(`/api/payroll/${SIPHO}/${MONTH}/attendance/pdf`)).status).toBe(200);
    expect((await technician.get(`/api/payroll/${SIPHO}/2026-13`)).status).toBe(422);
  });

  it('submits the month once, then the office prepares and sends ONE email; technicians are refused every office route', async () => {
    const technician = await signedInAs(DEMO_USERS.technician);
    expect((await technician.post(`/api/payroll/${SIPHO}/${MONTH}/submit`, {})).status).toBe(422); // weekdays unconfirmed
    const submitted = await technician.post(`/api/payroll/${SIPHO}/${MONTH}/submit`, { confirmUnrecorded: true });
    expect(submitted.status, JSON.stringify(submitted.error)).toBe(200);
    expect((await technician.post(`/api/payroll/${SIPHO}/${MONTH}/submit`, { confirmUnrecorded: true })).status).toBe(422);
    const master = await signedInAs(DEMO_USERS.master);
    expect((await master.post(`/api/payroll/${SIPHO}/${MONTH}/submit`, { confirmUnrecorded: true })).status).toBe(403);

    expect((await technician.get(`/api/payroll/months/${MONTH}`)).status).toBe(403);
    expect((await technician.post('/api/payroll/packages', { month: MONTH, technicianIds: [SIPHO] })).status).toBe(403);

    const office = await signedInAs(DEMO_USERS.coordinator);
    const month = await office.get<{ rows: readonly { technician: { id: string }; status: string }[]; recipient: string }>(`/api/payroll/months/${MONTH}`);
    expect(month.status).toBe(200);
    expect(month.data.rows.find((row) => row.technician.id === SIPHO)?.status).toBe('ready');
    const prepared = await office.post<{ package: { id: string; attachments: readonly { fileName: string; pageCount: number }[] } }>(
      '/api/payroll/packages', { month: MONTH, technicianIds: [SIPHO] }, { idempotencyKey: 'pay-prepare-1' },
    );
    expect(prepared.status, JSON.stringify(prepared.error)).toBe(200);
    expect(prepared.data.package.attachments).toHaveLength(2);
    expect(prepared.data.package.attachments.every((attachment) => attachment.pageCount === 1)).toBe(true);
    const id = prepared.data.package.id;
    expect((await technician.post(`/api/payroll/packages/${id}/send`, {})).status).toBe(403);
    expect((await technician.download(`/api/payroll/packages/${id}/files?name=${encodeURIComponent(prepared.data.package.attachments[0]!.fileName)}`)).status).toBe(403);

    const sent = await office.post<{ package: { status: string; attachments: readonly unknown[] } }>(`/api/payroll/packages/${id}/send`, {}, { idempotencyKey: 'pay-send-1' });
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect(sent.data.package.status).toBe('sent');
    // A replayed request is answered from the record; a fresh second send is refused.
    const replay = await office.post<{ package: { status: string } }>(`/api/payroll/packages/${id}/send`, {}, { idempotencyKey: 'pay-send-1' });
    expect(replay.status).toBe(200);
    expect((await office.post(`/api/payroll/packages/${id}/send`, {})).status).toBe(422);

    // The demonstration's simulated outbox: exactly one email to Finance, carrying both files.
    const outbox = await master.get<{ entries: readonly { channel: string; attachments: readonly string[]; to: string }[] }>('/api/outbox');
    expect(outbox.status).toBe(200);
    {
      const finance = outbox.data.entries.filter((entry) => entry.channel === 'email' && entry.to.includes('finance@'));
      expect(finance).toHaveLength(1);
      expect(finance[0]?.attachments).toHaveLength(2);
    }
    const file = await office.download(`/api/payroll/packages/${id}/files?name=${encodeURIComponent(prepared.data.package.attachments[0]!.fileName)}`);
    expect(file.status).toBe(200);
    expect(fileNameOf(file.headers.get('content-disposition'))).toBe(prepared.data.package.attachments[0]!.fileName);
  });
});
