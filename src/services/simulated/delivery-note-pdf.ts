import type { DeliveryNoteModel } from '@/lib/job-card/delivery-note';
import { PdfBuilder, textWidth } from '@/lib/pdf/writer';
import { signatureFacsimile, SIGNATURE_INK } from '@/lib/signature';
import {
  BAND,
  BODY,
  CONTENT_WIDTH,
  GAP,
  INK,
  MARGIN,
  MUTED,
  RIGHT,
  RULE,
  RULE_SOFT,
  Sheet,
  SIZE,
  TRACK_TITLE,
} from './pdf-sheet';

/**
 * THE DELIVERY NOTE AS A PDF. PARTS-03, PARTS-04.
 *
 * Drawn from `DeliveryNoteModel` alone, which carries no price at all — so a
 * price cannot reach the courier's copy through this renderer, whatever it is
 * given. Signature lines at the foot for the courier and for EJE, because the
 * printed copy travels with the goods and is signed on paper at the counter.
 */
export const renderDeliveryNotePdf = (model: DeliveryNoteModel): { bytes: Uint8Array; pageCount: number } => {
  const sheet = new Sheet();
  sheet.text(MARGIN, model.company.name, { font: 'bold', size: SIZE.companyName, colour: INK });
  const title = 'DELIVERY NOTE';
  sheet.pdf.text(RIGHT - textWidth(title, SIZE.jobNumber, 'bold', TRACK_TITLE), sheet.cursor, title, {
    font: 'bold',
    size: SIZE.jobNumber,
    colour: INK,
    tracking: TRACK_TITLE,
  });
  sheet.move(GAP.line);
  sheet.text(MARGIN, model.company.address, { size: SIZE.small, colour: MUTED });
  sheet.textRight(RIGHT, model.jobNumber, { font: 'bold', size: SIZE.total, colour: INK });
  sheet.move(GAP.tight);
  sheet.text(MARGIN, model.company.contactLine, { size: SIZE.small, colour: MUTED });
  sheet.move(GAP.sectionLarge);

  sheet.sectionTitle('Deliver to');
  for (const line of model.deliverTo) sheet.paragraph(line, { size: SIZE.body, colour: BODY });
  sheet.move(GAP.tight);

  sheet.sectionTitle('Details');
  for (const row of model.details) {
    // Wrapped in its column: a long site or reference ran off the page.
    const lines = PdfBuilder.wrap(row.value, RIGHT - MARGIN - 170, SIZE.body);
    sheet.need(GAP.line * lines.length);
    sheet.text(MARGIN, row.label, { size: SIZE.body, colour: MUTED });
    for (const [index, line] of lines.entries()) {
      if (index > 0) sheet.move(GAP.line);
      sheet.text(MARGIN + 170, line, { size: SIZE.body, colour: BODY });
    }
    sheet.move(GAP.line);
  }
  sheet.move(GAP.tight);

  sheet.sectionTitle('Goods');
  const QTY = RIGHT;
  const KIND = MARGIN;
  const PART = MARGIN + 80;
  const DESC = MARGIN + 210;
  sheet.need(GAP.line * 2);
  sheet.pdf.rect(MARGIN, sheet.cursor - 4, CONTENT_WIDTH, GAP.line + 2, BAND);
  sheet.text(KIND + 3, 'Item', { font: 'bold', size: SIZE.small, colour: INK });
  sheet.text(PART, 'Part number', { font: 'bold', size: SIZE.small, colour: INK });
  sheet.text(DESC, 'Description', { font: 'bold', size: SIZE.small, colour: INK });
  sheet.textRight(QTY - 3, 'Quantity', { font: 'bold', size: SIZE.small, colour: INK });
  sheet.move(GAP.line + 2);
  if (model.items.length === 0) {
    sheet.paragraph('No goods are listed on this job.', { size: SIZE.body, colour: MUTED });
  }
  for (const item of model.items) {
    const lines = PdfBuilder.wrap(item.description, QTY - 60 - DESC, SIZE.body);
    // A FANUC-style part number (A06B-6114-H208#H580) is wider than its
    // column; it wraps there instead of printing over the description.
    const part = PdfBuilder.wrap(item.partNumber, DESC - PART - 8, SIZE.body);
    const height = Math.max(1, lines.length, part.length);
    sheet.need(GAP.line * height + 4);
    sheet.text(KIND + 3, item.kind, { size: SIZE.body, colour: MUTED });
    sheet.textRight(QTY - 3, item.quantity, { size: SIZE.body, colour: INK });
    for (let index = 0; index < height; index += 1) {
      if (index > 0) sheet.move(GAP.line);
      if (part[index] !== undefined) sheet.text(PART, part[index]!, { size: SIZE.body, colour: INK });
      if (lines[index] !== undefined) sheet.text(DESC, lines[index]!, { size: SIZE.body, colour: BODY });
    }
    sheet.move(GAP.line - 3);
    sheet.rule(RULE_SOFT, 0.4);
    // The next row's capitals stand ~6.3pt above its baseline (9pt type): 5pt
    // below the rule put the rule through them.
    sheet.move(3 + 5);
  }
  sheet.need(GAP.line + 4);
  sheet.rule(RULE, 0.8);
  sheet.move(GAP.line - 2);
  sheet.text(DESC, 'Total items', { font: 'bold', size: SIZE.body, colour: INK });
  sheet.textRight(QTY - 3, model.totalQuantity, { font: 'bold', size: SIZE.body, colour: INK });
  sheet.move(GAP.section);
  sheet.paragraph(model.priceNote, { size: SIZE.small, colour: MUTED });

  const half = (CONTENT_WIDTH - 30) / 2;
  if (model.signature !== null) {
    // THE COURIER'S ONE SIGNATURE, taken on this document (PARTS-03/04).
    const boxHeight = 62;
    sheet.move(GAP.sectionLarge);
    sheet.need(boxHeight + 70);
    sheet.sectionTitle('Courier acceptance');
    const top = sheet.cursor;
    sheet.paragraph(model.signature.declaration, { colour: BODY, width: half });
    for (const [label, value] of [
      ['Name', model.signature.name],
      ['Signed', model.signature.signedAt],
      ['Signature reference', model.signature.reference],
    ] as const) {
      sheet.need(GAP.line);
      sheet.text(MARGIN, label, { size: SIZE.body, colour: MUTED });
      sheet.text(MARGIN + 100, value, { size: SIZE.body, colour: BODY });
      sheet.move(GAP.line);
    }
    const leftBottom = sheet.cursor;
    const x = MARGIN + half + 30;
    const boxTop = top + 10;
    const boxBottom = boxTop - boxHeight;
    sheet.pdf.rect(x, boxBottom, half, boxHeight, BAND);
    sheet.pdf.line(x, boxTop, x + half, boxTop, 0.6, RULE);
    sheet.pdf.line(x, boxBottom, x + half, boxBottom, 0.6, RULE);
    sheet.pdf.line(x, boxTop, x, boxBottom, 0.6, RULE);
    sheet.pdf.line(x + half, boxTop, x + half, boxBottom, 0.6, RULE);
    const mark = signatureFacsimile(model.signature.signatureData);
    if (mark.kind === 'path') {
      sheet.pdf.normalisedPath(
        mark.path,
        { x: x + 10, y: boxBottom + 7, width: half - 20, height: boxHeight - 14 },
        { colour: SIGNATURE_INK, width: 1.5 },
      );
    } else {
      const centred = x + half / 2 - textWidth(mark.text, SIZE.signature, 'script') / 2;
      sheet.pdf.text(centred, boxBottom + boxHeight / 2 - 5, mark.text, { font: 'script', size: SIZE.signature, colour: SIGNATURE_INK });
    }
    sheet.pdf.text(x, boxBottom - 11, 'Courier signature — the same signature is on the priced job card', { size: SIZE.tiny, colour: MUTED });
    sheet.setCursor(Math.min(leftBottom, boxBottom - 11));
    sheet.move(GAP.section);
  } else {
    // Not signed in the system yet: lines for signing on paper at the counter.
    sheet.move(GAP.sectionLarge);
    sheet.need(60);
    sheet.move(30);
    sheet.pdf.line(MARGIN, sheet.cursor, MARGIN + half, sheet.cursor, 0.6, RULE);
    sheet.pdf.line(MARGIN + half + 30, sheet.cursor, RIGHT, sheet.cursor, 0.6, RULE);
    sheet.move(GAP.line);
    sheet.text(MARGIN, 'Collected by (courier) — name, signature, date', { size: SIZE.small, colour: MUTED });
    sheet.text(MARGIN + half + 30, 'Released by (EJE) — name, signature, date', { size: SIZE.small, colour: MUTED });
  }

  const pages = sheet.pdf.pageCount;
  for (let index = 0; index < pages; index += 1) {
    sheet.pdf.selectPage(index);
    sheet.pdf.text(MARGIN, MARGIN - 12, model.footer, { size: SIZE.tiny, colour: MUTED });
    const page = `Page ${index + 1} of ${pages}`;
    sheet.pdf.text(RIGHT - textWidth(page, SIZE.tiny), MARGIN - 12, page, { size: SIZE.tiny, colour: MUTED });
  }
  return { bytes: sheet.pdf.toBytes(), pageCount: pages };
};
