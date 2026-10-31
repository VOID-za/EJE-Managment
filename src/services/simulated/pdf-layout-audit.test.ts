import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadJobView } from '@/application/job-view';
import { buildHarness } from '@/application/test-harness';
import type { TimesheetDocument } from '@/application/timesheets';
import { buildAttendanceRows, type AttendanceDocument } from '@/application/attendance-document';
import { buildDeliveryNoteModel } from '@/lib/job-card/delivery-note';
import { inspectPdf, pdfPlainText } from '@/lib/pdf/inspect';
import type { CorrectionDocumentSource, FinalDocumentSource } from '@/services/ports';
import { renderAttendancePdf } from './attendance-pdf';
import { renderCorrectionPdf } from './correction-pdf';
import { renderDeliveryNotePdf } from './delivery-note-pdf';
import { renderJobCardPdf } from './job-card-pdf';
import { renderTimesheetPdf } from './timesheet-pdf';

/**
 * EVERY PDF EJE PRODUCES, WITH THE LONGEST REAL CONTENT. UX-TAB-1 §7.
 *
 * A document that renders is not a document that is right: a long customer
 * name printed past the margin, or over the panel beside it, is cut off on
 * paper and nobody is told. `final-document-layout.test.ts` measures the job
 * card on the seeded jobs; this measures every document type — the job card,
 * the correction addendum, the delivery note, the timesheet and the
 * attendance form — with the longest values EJE's own register produces, and
 * holds each to the same rule: nothing past a margin, nothing printed over
 * anything else, and every value present in the text of the page.
 */

const CUSTOMER = 'Hoërskool Pretoria-Oos Tegniese Afdeling en Ingenieurswerkswinkel (Edms) Bpk — Kampus Noord';
const MACHINE = 'Doosan Puma 2600SY II multi-axis CNC turning centre with sub-spindle, Y-axis and bar feeder';
const LONG_TEXT =
  'Spindle drive alarm 9031 on start-up after the weekend; the encoder cable was chafed where it ' +
  'passes the coolant manifold, which caused intermittent loss of position and a hard stop. ';
const TECHNICIAN = 'Johannes Christiaan van der Merwe-Mostert';

/**
 * With EJE_PDF_SAMPLES=<folder>, every document is also written there, so a
 * person can open the real file and look at it (scripts/pdf-audit.mjs renders
 * each page to an image).
 */
const keep = (name: string, bytes: Uint8Array): void => {
  const folder = process.env.EJE_PDF_SAMPLES;
  if (folder === undefined || folder === '') return;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), bytes);
};

/** Every geometry fault, for the margin the document is drawn to. */
const faults = (bytes: Uint8Array, margin: number): readonly string[] =>
  inspectPdf(bytes, { margin, edge: 12 }).problems;

/**
 * The words of a value, as they appear in the text of the page (wrapped lines).
 * Punctuation-only "words" are skipped: an em dash is in the file as WinAnsi
 * byte 0x97, which the byte-level reader does not map back to "—".
 */
const present = (bytes: Uint8Array, value: string): boolean => {
  const text = pdfPlainText(bytes).replace(/\s+/gu, ' ');
  return value
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .every((word) => text.includes(word));
};

describe('the job card, with the longest content', () => {
  it('prints a long customer, site, machine and write-up inside the margins, on every page', async () => {
    const harness = buildHarness();
    const view = await loadJobView(harness.repos, 'EJE-1044');
    expect(view).not.toBeNull();
    const source: FinalDocumentSource = {
      job: {
        ...view!.job,
        faultDescription: LONG_TEXT.repeat(4),
        orderNumber: 'PO-2026-0099321-KAMPUS-NOORD-WERKSWINKEL',
        referenceNumber: 'REF-HPO-TEGNIES-2026-10-31-A',
        completionReport: {
          faultFindings: LONG_TEXT.repeat(3),
          diagnosis: LONG_TEXT.repeat(2),
          workPerformed: LONG_TEXT.repeat(6),
          recommendations: LONG_TEXT.repeat(2),
          generalNotes: LONG_TEXT,
        },
      },
      customer: { ...view!.customer, name: CUSTOMER },
      site: { ...view!.site, name: `${CUSTOMER} — Werkswinkel 3` },
      contact: view!.contact,
      machine: view!.machine === null ? null : { ...view!.machine, model: MACHINE },
      settings: view!.settings,
      checklistTemplate: view!.checklistTemplate,
      users: view!.users,
    };
    const rendered = renderJobCardPdf(source, 'EJE-1044.pdf', '2026-10-31T16:00:00.000Z');
    keep('long-job-card.pdf', rendered.bytes);
    expect(faults(rendered.bytes, 40)).toEqual([]);
    expect(rendered.pageCount).toBeGreaterThan(1);
    expect(present(rendered.bytes, 'Hoërskool Pretoria-Oos Tegniese Afdeling')).toBe(true);
    expect(present(rendered.bytes, 'encoder cable was chafed')).toBe(true);
    const report = inspectPdf(rendered.bytes);
    for (let page = 1; page <= report.pageCount; page += 1) {
      expect(report.runs.some((run) => run.page === page && run.value.includes(`Page ${page} of ${report.pageCount}`)), `page ${page} numbered`).toBe(true);
    }
  });
});

describe('the correction addendum, with the longest content', () => {
  it('wraps a long customer and machine rather than running them off the page', () => {
    const source: CorrectionDocumentSource = {
      company: {
        name: 'EJE Industrial Services (Pty) Ltd',
        address: '14 Industrie Street, Kya Sand, Randburg, Gauteng, 2163',
        contactLine: '+27 11 708 0000 · office@eje-demo.co.za',
        registrationLine: 'Reg. 2001/012345/07 · VAT 4123456789',
      },
      jobNumber: 'EJE-1044',
      customerName: CUSTOMER,
      machineDescription: `${MACHINE} · S/N DPM-2600SY-II-0049321`,
      original: { fileName: 'EJE-1044 JOB CARD.pdf', issuedAt: '2026-10-20T10:00:00.000Z', signed: true },
      correction: {
        sequence: 2,
        reason: LONG_TEXT.repeat(2),
        narrative: LONG_TEXT.repeat(5),
        areas: [],
        raisedBy: 'Elmarie Coetzee',
        raisedAt: '2026-10-31T09:00:00.000Z',
        acknowledgementRequired: true,
        acknowledged: null,
      },
      simulated: true,
    };
    const rendered = renderCorrectionPdf(source, 'EJE-1044 CORRECTION 2.pdf');
    keep('long-correction.pdf', rendered.bytes);
    expect(faults(rendered.bytes, 40)).toEqual([]);
    expect(present(rendered.bytes, CUSTOMER)).toBe(true);
    expect(present(rendered.bytes, 'DPM-2600SY-II-0049321')).toBe(true);
  });
});

describe('the delivery note, with the longest content', () => {
  it('wraps a long consignee, details and item descriptions inside the margins', async () => {
    const harness = buildHarness();
    const view = await loadJobView(harness.repos, 'EJE-1044');
    const model = buildDeliveryNoteModel(view!, '2026-10-31T16:00:00.000Z');
    const long = {
      ...model,
      deliverTo: [CUSTOMER, `${CUSTOMER} — Werkswinkel 3, Lynnwoodweg 1200, Pretoria-Oos, Gauteng, 0081`],
      details: model.details.map((detail) => ({ ...detail, value: `${detail.value} ${'— aanvullende besonderhede '.repeat(3)}`.trim() })),
      items: Array.from({ length: 6 }, (_, index) => ({
        kind: index === 0 ? ('Repaired unit' as const) : ('Part' as const),
        partNumber: `A06B-6114-H${200 + index}#H580-REV-C`,
        description: `${MACHINE} — ${LONG_TEXT}`,
        quantity: String(index + 1),
      })),
    };
    const rendered = renderDeliveryNotePdf(long);
    keep('long-delivery-note.pdf', rendered.bytes);
    expect(faults(rendered.bytes, 40)).toEqual([]);
    expect(present(rendered.bytes, CUSTOMER)).toBe(true);
    // Wrapped by character within its own column (x = MARGIN + 80), so read
    // down that column: in reading order its halves sit either side of a
    // description line.
    const column = inspectPdf(rendered.bytes).runs.filter((run) => Math.abs(run.x - 120) < 0.5).map((run) => run.value).join('');
    expect(column).toContain('A06B-6114-H205#H580-REV-C');
  });
});

describe('the monthly forms, with the longest content', () => {
  const days = Array.from({ length: 31 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`);

  it('the timesheet keeps the whole footer — the "Generated" stamp — with a long name and period', () => {
    const doc: TimesheetDocument = {
      companyName: 'EJE Industrial Services (Pty) Ltd',
      technicianName: TECHNICIAN,
      fileName: 'JC TIMESHEET OCT.pdf',
      from: '2026-10-01',
      to: '2026-10-31',
      periodLabel: 'Thu 1 Oct 2026 – Sat 31 Oct 2026',
      rows: days.map((date) => ({
        date,
        weekday: 'Mon',
        customer: CUSTOMER,
        recorded: true,
        overtimeHours: 2.25,
        doubleHours: 1.5,
        calloutAmount: 123456,
        calloutShared: false,
        internalKm: 123.4,
        customerKm: 987.6,
        historicalNormalHours: 0,
        historicalCallouts: 0,
      })),
      comment: LONG_TEXT.repeat(3),
      totals: { overtimeHours: 69.75, doubleHours: 46.5, calloutAmount: 3827136, internalKm: 3825.4, customerKm: 30615.6, historicalNormalHours: 0, historicalCallouts: 0 },
      submittedAt: '2026-10-31T15:00:00.000Z',
      submittedByName: TECHNICIAN,
      versionLabel: 'Correction 2, accepted 2026-11-02 by Christene van Niekerk',
      inForce: true,
      absences: [],
    };
    const rendered = renderTimesheetPdf(doc, { generatedAt: '2026-10-31T16:00:00.000Z' });
    keep('long-timesheet.pdf', rendered.bytes);
    expect(rendered.pageCount).toBe(1);
    expect(faults(rendered.bytes, 28)).toEqual([]);
    expect(present(rendered.bytes, 'Generated')).toBe(true);
    expect(present(rendered.bytes, TECHNICIAN)).toBe(true);
    expect(present(rendered.bytes, 'Hoërskool Pretoria-Oos')).toBe(true);
  });

  it('the attendance form keeps the whole footer and every long note', () => {
    const note = 'Booked off by the clinic in Pretoria-Oos; follow-up on Thursday morning';
    const doc: AttendanceDocument = {
      companyName: 'EJE Industrial Services (Pty) Ltd',
      technicianName: TECHNICIAN,
      fileName: 'JC ATTEN OCT.pdf',
      month: '2026-10',
      monthLabel: 'October 2026',
      ...buildAttendanceRows(
        days.map((date, index) => ({
          date,
          status: index % 5 === 4 ? ('absent' as const) : ('present' as const),
          absenceReason: index % 5 === 4 ? ('sick_leave' as const) : null,
          note: index % 5 === 4 ? note : '',
        })),
        '2026-10-31',
      ),
      submittedAt: '2026-10-31T15:00:00.000Z',
      submittedByName: TECHNICIAN,
      versionLabel: 'Corrected by the office after submission (2 days: Mon 5 Oct 2026, Tue 6 Oct 2026)',
      inForce: true,
      changedAfterSubmission: ['2026-10-05', '2026-10-06'],
    };
    const rendered = renderAttendancePdf(doc, { generatedAt: '2026-10-31T16:00:00.000Z' });
    keep('long-attendance.pdf', rendered.bytes);
    expect(rendered.pageCount).toBe(1);
    expect(faults(rendered.bytes, 28)).toEqual([]);
    expect(present(rendered.bytes, 'Generated')).toBe(true);
    expect(present(rendered.bytes, note)).toBe(true);
  });
});
