import {
  buildPartsDocument,
  calculateJobTotals,
  contactFullName,
  customerFacingNotes,
  getJobTypeDefinition,
  jobScheduleWindow,
  jobStatusLabel,
  machineDisplayName,
  userFullName,
  PARTS_COLLECTION_DECLARATION,
  type ChecklistResponse,
  type CostLine,
} from '@/domain';
import { formatCurrency, formatDate, formatDateTime, formatHours } from '@/lib/format';
import { A4_HEIGHT, A4_WIDTH, PdfBuilder, textWidth } from '@/lib/pdf/writer';
import { SIGNATURE_INK } from '@/components/jobs/signature-path';
import type { FinalDocumentSource, RenderedPdf } from '../ports';

/**
 * Renders the EJE job card and parts collection note to PDF bytes.
 *
 * Fed from the same values the on-screen `JobCardDocument` renders and through
 * the same domain functions — `calculateJobTotals`, `customerFacingNotes`,
 * `buildPartsDocument` — so the figures on the file a customer keeps cannot
 * disagree with the figures they were shown. In particular the totals come from
 * `calculateJobTotals`, which prefers the job's frozen pricing snapshot, so a
 * later rate change cannot reach a document that has already been issued.
 *
 * This is the demo's renderer. Production renders the same `FinalDocumentSource`
 * server-side; the bytes are written to storage once either way.
 */

const MARGIN = 40;
const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
const RIGHT = A4_WIDTH - MARGIN;

const INK = '#000000';
const MUTED = '#5b6472';
const RULE = '#b9c0ca';
const BAND = '#eef1f5';

/** Vertical layout over the writer: a cursor, and page breaks when it runs out. */
class Sheet {
  readonly pdf = new PdfBuilder();
  private y = 0;

  constructor() {
    this.newPage();
  }

  private newPage(): void {
    this.pdf.addPage();
    this.y = A4_HEIGHT - MARGIN;
  }

  /** Reserves vertical space, breaking to a new page if it will not fit. */
  need(height: number): void {
    if (this.y - height < MARGIN + 28) this.newPage();
  }

  move(by: number): void {
    this.y -= by;
  }

  get cursor(): number {
    return this.y;
  }

  rule(): void {
    this.need(8);
    this.y -= 4;
    this.pdf.line(MARGIN, this.y, RIGHT, this.y, 0.6, RULE);
    this.y -= 6;
  }

  sectionHeading(label: string): void {
    this.need(26);
    this.y -= 14;
    this.pdf.text(MARGIN, this.y, label.toUpperCase(), { font: 'bold', size: 9, colour: MUTED });
    this.y -= 4;
    this.pdf.line(MARGIN, this.y, RIGHT, this.y, 0.8, RULE);
    this.y -= 10;
  }

  /** A label above its value, wrapped. Returns nothing when the value is empty. */
  block(label: string, value: string): void {
    if (value.trim().length === 0) return;
    const lines = PdfBuilder.wrap(value, CONTENT_WIDTH, 9.5);
    this.need(14 + lines.length * 12);
    this.pdf.text(MARGIN, this.y, label, { font: 'bold', size: 8.5, colour: MUTED });
    this.y -= 12;
    for (const line of lines) {
      this.pdf.text(MARGIN, this.y, line, { size: 9.5, colour: INK });
      this.y -= 12;
    }
    this.y -= 3;
  }

  /** Label/value pairs in two columns, as the printed job card sets them. */
  pairs(entries: readonly (readonly [string, string])[]): void {
    const columnWidth = CONTENT_WIDTH / 2;
    const rows = Math.ceil(entries.length / 2);
    this.need(rows * 13 + 6);
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < 2; column += 1) {
        const entry = entries[row * 2 + column];
        if (entry === undefined) continue;
        const x = MARGIN + column * columnWidth;
        this.pdf.text(x, this.y, entry[0], { font: 'bold', size: 8.5, colour: MUTED });
        this.pdf.text(x + 92, this.y, entry[1], { size: 9, colour: INK });
      }
      this.y -= 13;
    }
    this.y -= 2;
  }

  /** A costed table. `money` false renders a quantity-only table, for a courier. */
  table(headers: readonly string[], rows: readonly (readonly string[])[], numeric: number): void {
    if (rows.length === 0) return;
    const columns = headers.length;
    const firstWidth = CONTENT_WIDTH - (columns - 1) * 78;

    const columnX = (index: number): number =>
      index === 0 ? MARGIN : MARGIN + firstWidth + (index - 1) * 78;

    const draw = (values: readonly string[], bold: boolean): void => {
      values.forEach((value, index) => {
        const isNumeric = index >= columns - numeric;
        const x = isNumeric
          ? columnX(index) + 72 - textWidth(value, 8.5, bold ? 'bold' : 'regular')
          : columnX(index);
        this.pdf.text(x, this.y, value, {
          size: 8.5,
          font: bold ? 'bold' : 'regular',
          colour: bold ? MUTED : INK,
        });
      });
    };

    this.need(24 + rows.length * 12);
    draw(headers, true);
    this.y -= 4;
    this.pdf.line(MARGIN, this.y, RIGHT, this.y, 0.5, RULE);
    this.y -= 10;

    for (const row of rows) {
      this.need(14);
      draw(row, false);
      this.y -= 12;
    }
    this.y -= 2;
  }

  /** A right-aligned totals row; `strong` for the payable figure. */
  totalRow(label: string, value: string, strong = false): void {
    this.need(16);
    const size = strong ? 11 : 9.5;
    const font = strong ? 'bold' : 'regular';
    if (strong) {
      this.y -= 2;
      this.pdf.line(RIGHT - 220, this.y + 12, RIGHT, this.y + 12, 0.8, INK);
    }
    this.pdf.text(RIGHT - 220, this.y, label, { size, font, colour: strong ? INK : MUTED });
    this.pdf.text(RIGHT - textWidth(value, size, font), this.y, value, {
      size,
      font,
      colour: INK,
    });
    this.y -= strong ? 18 : 14;
  }
}

const dash = (value: string): string => (value.trim().length > 0 ? value : '—');

const costRows = (lines: readonly CostLine[]): readonly (readonly string[])[] =>
  lines.map((line) => [
    `${line.label}${line.detail.length > 0 ? ` — ${line.detail}` : ''}`,
    `${line.quantity} ${line.unit}`.trim(),
    formatCurrency(line.unitPrice),
    formatCurrency(line.total),
  ]);

const header = (sheet: Sheet, source: FinalDocumentSource, title: string): void => {
  const { job } = source;
  const top = sheet.cursor;

  sheet.pdf.rect(MARGIN, top - 30, 34, 34, '#1b2434');
  sheet.pdf.text(MARGIN + 5, top - 21, 'EJE', { font: 'bold', size: 13, colour: '#ffffff' });

  sheet.pdf.text(MARGIN + 44, top - 8, 'EJE INDUSTRIAL ELECTRONICS', {
    font: 'bold',
    size: 13,
    colour: INK,
  });
  sheet.pdf.text(MARGIN + 44, top - 22, title.toUpperCase(), { size: 9, colour: MUTED });

  const number = job.jobNumber;
  sheet.pdf.text(RIGHT - textWidth(number, 17, 'bold'), top - 10, number, {
    font: 'bold',
    size: 17,
    colour: INK,
  });
  const status = `${getJobTypeDefinition(job.jobType).label} · ${jobStatusLabel(job.status)}`;
  sheet.pdf.text(RIGHT - textWidth(status, 8.5), top - 24, status, { size: 8.5, colour: MUTED });

  sheet.move(38);
  sheet.pdf.line(MARGIN, sheet.cursor, RIGHT, sheet.cursor, 1.4, INK);
  sheet.move(8);
};

const partiesAndMachine = (sheet: Sheet, source: FinalDocumentSource): void => {
  const { job, customer, site, contact, machine, users } = source;
  const technician =
    users.find((user) => user.id === job.primaryTechnicianId) ?? null;
  const schedule = jobScheduleWindow(job);

  sheet.sectionHeading('Customer and equipment');
  sheet.pairs([
    ['Customer', customer.name],
    ['Machine', machine === null ? 'Not against a machine' : machineDisplayName(machine)],
    ['Site', site.name],
    ['Serial number', machine === null ? '—' : machine.serialNumber],
    ['Contact', contact === null ? '—' : contactFullName(contact)],
    ['Machine type', machine === null ? '—' : machine.machineType],
    ['Address', dash(site.addressLine1)],
    ['Control', machine === null ? '—' : machine.controlSystem],
    ['Order number', dash(job.orderNumber)],
    ['Reference', dash(job.referenceNumber)],
    ['Technician', technician === null ? 'Unassigned' : userFullName(technician)],
    [
      'Scheduled',
      schedule === null
        ? 'Not scheduled'
        : schedule.days === 1
          ? formatDate(schedule.start)
          : `${formatDate(schedule.start)} — ${formatDate(schedule.end)} (${schedule.days} days)`,
    ],
    ['Completed', job.completedAt === null ? '—' : formatDate(job.completedAt)],
    ['Issued', job.closedAt === null ? '—' : formatDate(job.closedAt)],
  ]);
};

const workPerformed = (sheet: Sheet, source: FinalDocumentSource): void => {
  const { job, users } = source;

  if (job.faultDescription.trim().length > 0) {
    sheet.sectionHeading('Reported fault');
    sheet.block('As reported by the customer', job.faultDescription);
  }

  const report = job.completionReport;
  const hasReport = [
    report.faultFindings,
    report.diagnosis,
    report.workPerformed,
    report.recommendations,
  ].some((value) => value.trim().length > 0);

  if (hasReport) {
    sheet.sectionHeading('Work carried out');
    sheet.block('Fault findings', report.faultFindings);
    sheet.block('Diagnosis', report.diagnosis);
    sheet.block('Work performed', report.workPerformed);
    sheet.block('Recommendations', report.recommendations);
    sheet.block('General notes', report.generalNotes);
  }

  // Internal notes are EJE-only. The domain decides which are customer-facing,
  // so this document cannot leak one the preview would have hidden.
  const notes = customerFacingNotes(job.notes);
  if (notes.length > 0) {
    sheet.sectionHeading('Notes');
    for (const note of notes) {
      const author = users.find((user) => user.id === note.authorId);
      sheet.block(
        `${author === undefined ? 'EJE' : userFullName(author)} · ${formatDateTime(note.createdAt)}`,
        note.body,
      );
    }
  }
};

const costs = (sheet: Sheet, source: FinalDocumentSource): void => {
  const { job, settings } = source;
  const totals = calculateJobTotals(job, settings);

  const anything =
    totals.labourLines.length + totals.calloutLines.length + totals.travelLines.length + totals.partLines.length;
  if (anything === 0) return;

  sheet.sectionHeading('Charges');

  if (totals.labourLines.length > 0) {
    sheet.table(['Labour', 'Quantity', 'Rate', 'Amount'], costRows(totals.labourLines), 3);
  }
  if (totals.calloutLines.length > 0) {
    sheet.table(['Call-out', 'Quantity', 'Rate', 'Amount'], costRows(totals.calloutLines), 3);
  }
  if (totals.travelLines.length > 0) {
    sheet.table(['Travel', 'Quantity', 'Rate', 'Amount'], costRows(totals.travelLines), 3);
  }
  if (totals.partLines.length > 0) {
    sheet.table(['Parts and materials', 'Quantity', 'Unit', 'Amount'], costRows(totals.partLines), 3);
  }

  sheet.totalRow('Subtotal', formatCurrency(totals.subtotal));
  sheet.totalRow(`VAT @ ${totals.pricing.vatPercentage}%`, formatCurrency(totals.vat));
  sheet.totalRow('TOTAL', formatCurrency(totals.total), true);

  if (totals.totalHours > 0 || totals.totalKilometres > 0) {
    sheet.pdf.text(
      MARGIN,
      sheet.cursor,
      `Total time on site: ${formatHours(totals.totalHours)} · Distance: ${totals.totalKilometres} km`,
      { size: 8.5, colour: MUTED },
    );
    sheet.move(14);
  }
};

const checklist = (sheet: Sheet, source: FinalDocumentSource): void => {
  const { job, checklistTemplate } = source;
  if (checklistTemplate === null || job.checklist === null) return;

  const responses = new Map<string, ChecklistResponse>(
    job.checklist.responses.map((response) => [response.itemId, response]),
  );

  // The template resolved by the version RECORDED ON THE JOB, so a revised
  // checklist cannot rewrite paperwork the customer has already signed.
  sheet.sectionHeading(
    `${checklistTemplate.name} — version ${job.checklist.templateVersion}`,
  );

  for (const section of checklistTemplate.sections) {
    sheet.need(20);
    sheet.pdf.text(MARGIN, sheet.cursor, section.title, { font: 'bold', size: 9, colour: INK });
    sheet.move(13);

    for (const item of section.items) {
      const response = responses.get(item.id);
      const answer =
        response === undefined
          ? '—'
          : response.choice !== null
            ? response.choice.toUpperCase()
            : response.yesNo !== null
              ? response.yesNo
                ? 'YES'
                : 'NO'
              : response.measurement !== null
                ? `${response.measurement}${item.unit === null ? '' : ` ${item.unit}`}`
                : dash(response.text);

      const lines = PdfBuilder.wrap(item.text, CONTENT_WIDTH - 90, 8.5);
      sheet.need(lines.length * 11 + 4);
      lines.forEach((line, index) => {
        sheet.pdf.text(MARGIN + 8, sheet.cursor, line, { size: 8.5, colour: INK });
        if (index === 0) {
          sheet.pdf.text(RIGHT - textWidth(answer, 8.5, 'bold'), sheet.cursor, answer, {
            size: 8.5,
            font: 'bold',
            colour: INK,
          });
        }
        sheet.move(11);
      });

      if (response !== undefined && response.notes.trim().length > 0) {
        for (const line of PdfBuilder.wrap(`Note: ${response.notes}`, CONTENT_WIDTH - 100, 8)) {
          sheet.need(11);
          sheet.pdf.text(MARGIN + 18, sheet.cursor, line, { size: 8, colour: MUTED });
          sheet.move(10);
        }
      }
    }
    sheet.move(4);
  }
};

const partsNote = (sheet: Sheet, source: FinalDocumentSource): void => {
  const { job } = source;
  const document = buildPartsDocument(job);

  sheet.sectionHeading(job.courierCollection ? 'Goods for delivery' : 'Parts collected');

  const headers = document.showsPrices
    ? ['Part', 'Description', 'Qty', 'Amount']
    : ['Part', 'Description', 'Qty'];
  const rows = document.lines.map((line) =>
    document.showsPrices
      ? [line.partNumber, line.description, String(line.quantity), formatCurrency(line.lineTotal ?? 0)]
      : [line.partNumber, line.description, String(line.quantity)],
  );
  sheet.table(headers, rows, document.showsPrices ? 2 : 1);

  sheet.totalRow('Total items', String(document.totalQuantity));
  if (document.subtotal !== null) {
    sheet.totalRow('TOTAL', formatCurrency(document.subtotal), true);
  } else {
    // A courier's copy carries no prices at all, and says so rather than
    // leaving a blank the reader has to interpret.
    sheet.pdf.text(MARGIN, sheet.cursor, 'Prices are not shown on a courier delivery note.', {
      size: 8.5,
      font: 'italic',
      colour: MUTED,
    });
    sheet.move(14);
  }
};

const signature = (sheet: Sheet, source: FinalDocumentSource): void => {
  const { job } = source;
  const captured = job.signature;

  sheet.need(150);
  sheet.sectionHeading('Acceptance');

  const declaration =
    captured?.declaration ??
    (job.jobType === 'parts' ? PARTS_COLLECTION_DECLARATION : '');

  if (declaration.length > 0) {
    sheet.pdf.rect(MARGIN, sheet.cursor - 20, CONTENT_WIDTH, 26, BAND);
    for (const line of PdfBuilder.wrap(declaration, CONTENT_WIDTH - 16, 9.5, 'bold')) {
      sheet.pdf.text(MARGIN + 8, sheet.cursor, line, { font: 'bold', size: 9.5, colour: INK });
      sheet.move(12);
    }
    sheet.move(12);
  }

  if (captured === null) {
    sheet.pdf.text(MARGIN, sheet.cursor, 'Not signed.', { size: 9.5, font: 'italic', colour: MUTED });
    sheet.move(14);
    return;
  }

  const boxTop = sheet.cursor;
  const boxHeight = 58;
  sheet.pdf.line(MARGIN, boxTop - boxHeight, MARGIN + 240, boxTop - boxHeight, 0.8, INK);

  // The signature's own geometry, drawn in the same pure black the pad and the
  // on-screen job card use. Not a typeset name: this is the mark that was made.
  sheet.pdf.normalisedPath(
    captured.strokeData,
    { x: MARGIN + 6, y: boxTop - boxHeight + 3, width: 228, height: boxHeight - 8 },
    { colour: SIGNATURE_INK, width: 1.6 },
  );

  sheet.pdf.text(MARGIN, boxTop - boxHeight - 12, `${captured.customerName} ${captured.customerSurname}`, {
    font: 'bold',
    size: 9.5,
    colour: INK,
  });
  sheet.pdf.text(MARGIN, boxTop - boxHeight - 24, `Signed ${formatDateTime(captured.signedAt)}`, {
    size: 8.5,
    colour: MUTED,
  });
  sheet.move(boxHeight + 30);
};

const footers = (sheet: Sheet, fileName: string, simulated: boolean): void => {
  const total = sheet.pdf.pageCount;
  for (let index = 0; index < total; index += 1) {
    sheet.pdf.selectPage(index);
    sheet.pdf.line(MARGIN, MARGIN + 18, RIGHT, MARGIN + 18, 0.5, RULE);
    sheet.pdf.text(MARGIN, MARGIN + 6, fileName, { size: 7.5, colour: MUTED });
    const page = `Page ${index + 1} of ${total}`;
    sheet.pdf.text(RIGHT - textWidth(page, 7.5), MARGIN + 6, page, { size: 7.5, colour: MUTED });
    if (simulated) {
      const note = 'Demonstration build — fictional data';
      sheet.pdf.text(A4_WIDTH / 2 - textWidth(note, 7.5) / 2, MARGIN + 6, note, {
        size: 7.5,
        colour: MUTED,
      });
    }
  }
};

/** Renders the final document for a job, returning the bytes and page count. */
export const renderJobCardPdf = (
  source: FinalDocumentSource,
  fileName: string,
  simulated: boolean,
): RenderedPdf => {
  const isParts = source.job.jobType === 'parts';
  const sheet = new Sheet();

  header(
    sheet,
    source,
    isParts
      ? source.job.courierCollection
        ? 'Delivery note'
        : 'Parts collection note'
      : 'Job card',
  );
  partiesAndMachine(sheet, source);

  if (isParts) {
    partsNote(sheet, source);
  } else {
    workPerformed(sheet, source);
    costs(sheet, source);
    checklist(sheet, source);
  }

  signature(sheet, source);
  footers(sheet, fileName, simulated);

  return { bytes: sheet.pdf.toBytes(), pageCount: sheet.pdf.pageCount };
};
