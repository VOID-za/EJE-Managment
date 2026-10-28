import type { DeliveryNoteModel } from '@/lib/job-card/delivery-note';
import { PdfBuilder, textWidth } from '@/lib/pdf/writer';
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
  sheet.pdf.text(RIGHT - textWidth(title, SIZE.jobNumber, 'bold') - TRACK_TITLE * 12, sheet.cursor, title, {
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
    sheet.need(GAP.line);
    sheet.text(MARGIN, row.label, { size: SIZE.body, colour: MUTED });
    sheet.text(MARGIN + 170, row.value, { size: SIZE.body, colour: BODY });
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
    sheet.need(GAP.line * Math.max(1, lines.length) + 4);
    sheet.text(KIND + 3, item.kind, { size: SIZE.body, colour: MUTED });
    sheet.text(PART, item.partNumber, { size: SIZE.body, colour: INK });
    sheet.textRight(QTY - 3, item.quantity, { size: SIZE.body, colour: INK });
    for (const [index, line] of lines.entries()) {
      if (index > 0) sheet.move(GAP.line);
      sheet.text(DESC, line, { size: SIZE.body, colour: BODY });
    }
    sheet.move(GAP.line - 3);
    sheet.rule(RULE_SOFT, 0.4);
    sheet.move(3 + 2);
  }
  sheet.need(GAP.line + 4);
  sheet.rule(RULE, 0.8);
  sheet.move(GAP.line - 2);
  sheet.text(DESC, 'Total items', { font: 'bold', size: SIZE.body, colour: INK });
  sheet.textRight(QTY - 3, model.totalQuantity, { font: 'bold', size: SIZE.body, colour: INK });
  sheet.move(GAP.section);
  sheet.paragraph(model.priceNote, { size: SIZE.small, colour: MUTED });
  if (model.signedFor !== null) sheet.paragraph(model.signedFor, { size: SIZE.small, colour: BODY });

  // Signatures on paper: the courier and EJE.
  sheet.move(GAP.sectionLarge);
  sheet.need(60);
  const half = (CONTENT_WIDTH - 30) / 2;
  sheet.move(30);
  sheet.pdf.line(MARGIN, sheet.cursor, MARGIN + half, sheet.cursor, 0.6, RULE);
  sheet.pdf.line(MARGIN + half + 30, sheet.cursor, RIGHT, sheet.cursor, 0.6, RULE);
  sheet.move(GAP.line);
  sheet.text(MARGIN, 'Collected by (courier) — name, signature, date', { size: SIZE.small, colour: MUTED });
  sheet.text(MARGIN + half + 30, 'Released by (EJE) — name, signature, date', { size: SIZE.small, colour: MUTED });

  const pages = sheet.pdf.pageCount;
  for (let index = 0; index < pages; index += 1) {
    sheet.pdf.selectPage(index);
    sheet.pdf.text(MARGIN, MARGIN - 12, model.footer, { size: SIZE.tiny, colour: MUTED });
    const page = `Page ${index + 1} of ${pages}`;
    sheet.pdf.text(RIGHT - textWidth(page, SIZE.tiny), MARGIN - 12, page, { size: SIZE.tiny, colour: MUTED });
  }
  return { bytes: sheet.pdf.toBytes(), pageCount: pages };
};
