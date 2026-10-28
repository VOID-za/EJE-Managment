import { signatureFacsimile, SIGNATURE_INK } from '@/lib/signature';
import { buildJobCardModel, type ChargeRow, type JobCardModel, type LabelValue } from '@/lib/job-card/model';
import { PdfBuilder, textWidth } from '@/lib/pdf/writer';
import { displaySize, type PreparedPhoto } from '@/lib/pdf/image';
import { SIMULATED_NOTICE_PRINT } from '@/domain';
import type { FinalDocumentSource, RenderedPdf } from '../ports';

/**
 * The EJE job card, rendered to PDF.
 *
 * Consumes `buildJobCardModel` — the same definition the on-screen job card
 * renders — so the two cannot carry different content, labels or section order.
 * What this file owns is only how that model is drawn on paper.
 *
 * The scale mirrors the on-screen document: it is 820px wide with 40px padding,
 * so 740px of content become 515pt here, a factor of about 0.7. Every size and
 * gap below is the screen's Tailwind value at that scale, which is what keeps
 * the printed document recognisably the same document rather than a denser
 * relative of it.
 */

import {
  BAND,
  BODY,
  COL_AMOUNT,
  COL_QTY,
  COL_RATE,
  CONTENT_WIDTH,
  FAINT,
  GAP,
  INK,
  MARGIN,
  MUTED,
  RIGHT,
  RULE,
  RULE_SOFT,
  Sheet,
  SIZE,
  TRACK_HEADING,
  TRACK_TITLE,
} from './pdf-sheet';


const labelValueRows = (
  sheet: Sheet,
  rows: readonly LabelValue[],
  x: number,
  width: number,
): void => {
  /*
   * The label column is as wide as the widest label in THIS block, never
   * narrower than it has always been.
   *
   * It was a fixed 78pt, which every label fitted until the customer's machine
   * number arrived: "Machine number" measures wider than that, so the value was
   * printed hard against it — "Machine numberMID1" — on the document the
   * customer keeps. A fixed column cannot be right for labels that are data.
   * The floor keeps every block whose labels already fit laid out exactly as
   * before, so no document that renders correctly today moves.
   */
  const widest = rows.reduce(
    (max, row) => Math.max(max, textWidth(row.label, SIZE.body)),
    0,
  );
  const labelWidth = Math.max(78, Math.ceil(widest) + 6);
  for (const row of rows) {
    sheet.need(GAP.line);
    sheet.pdf.text(x, sheet.cursor, row.label, { size: SIZE.body, colour: MUTED });
    for (const [index, line] of PdfBuilder.wrap(
      row.value,
      width - labelWidth,
      SIZE.body,
      row.mono === true ? 'regular' : 'regular',
    ).entries()) {
      if (index > 0) sheet.move(GAP.line);
      sheet.pdf.text(x + labelWidth, sheet.cursor, line, { size: SIZE.body, colour: BODY });
    }
    sheet.move(GAP.line);
  }
};

const header = (sheet: Sheet, model: JobCardModel): void => {
  const top = sheet.cursor;

  // The dark EJE tile, at the screen's size-11 (44px -> 31pt).
  sheet.pdf.rect(MARGIN, top - 24, 31, 31, INK);
  sheet.pdf.text(MARGIN + 6, top - 14, 'EJE', { font: 'bold', size: 9, colour: '#ffffff' });

  sheet.pdf.text(MARGIN + 39, top - 6, model.company.name, {
    font: 'bold',
    size: SIZE.companyName,
    colour: INK,
  });
  sheet.pdf.text(MARGIN + 39, top - 17, model.company.address, {
    size: SIZE.small,
    colour: MUTED,
  });

  sheet.pdf.text(MARGIN, top - 40, model.company.contactLine, { size: SIZE.small, colour: MUTED });
  sheet.pdf.text(MARGIN, top - 50, model.company.registrationLine, {
    size: SIZE.small,
    colour: MUTED,
  });

  const title = model.documentTitle.toUpperCase();
  sheet.pdf.text(
    RIGHT - textWidth(title, SIZE.small, 'bold', TRACK_TITLE),
    top - 6,
    title,
    { font: 'bold', size: SIZE.small, colour: MUTED, tracking: TRACK_TITLE },
  );
  sheet.pdf.text(
    RIGHT - textWidth(model.jobNumber, SIZE.jobNumber, 'bold'),
    top - 24,
    model.jobNumber,
    { font: 'bold', size: SIZE.jobNumber, colour: INK },
  );
  /*
   * The header is the document's name and its number. Nothing else.
   *
   * It used to carry "Breakdown · Urgent" and "Status: Review" as well — EJE's
   * own workflow state, printed at the top of a page handed to a customer who
   * has no idea what Review means and no reason to. The job type and priority
   * are the job's own details and are printed with the rest of them.
   */
  sheet.move(48);
  sheet.rule(INK, 1.4);
  sheet.move(GAP.section);
};

const parties = (sheet: Sheet, model: JobCardModel): void => {
  const columnWidth = (CONTENT_WIDTH - 24) / 2;
  const rightX = MARGIN + columnWidth + 24;
  const top = sheet.cursor;

  // Left column: the customer, their site address and the site contact.
  sheet.sectionTitle('Customer');
  sheet.paragraph(model.customer.name, { font: 'bold', colour: INK, width: columnWidth });
  for (const line of model.customer.addressLines) {
    sheet.paragraph(line, { colour: MUTED, width: columnWidth, leading: GAP.line });
  }
  if (model.customer.contact !== null) {
    sheet.move(5);
    sheet.paragraph(model.customer.contact.name, {
      font: 'bold',
      colour: BODY,
      width: columnWidth,
      leading: GAP.line,
    });
    sheet.paragraph(model.customer.contact.position, {
      colour: MUTED,
      width: columnWidth,
      leading: GAP.line,
    });
    sheet.paragraph(model.customer.contact.contactLine, {
      colour: MUTED,
      width: columnWidth,
      leading: GAP.line,
    });
  }
  const leftBottom = sheet.cursor;

  // Right column: the machine, then the job's own details. Laid out from the
  // same top as the left column, not from where the left column ended.
  sheet.setCursor(top);
  if (model.machine !== null) {
    sheet.pdf.text(rightX, sheet.cursor, 'MACHINE', {
      font: 'bold',
      size: SIZE.small,
      colour: MUTED,
      tracking: TRACK_HEADING,
    });
    sheet.move(GAP.line);
    sheet.paragraph(model.machine.title, {
      font: 'bold',
      colour: INK,
      width: columnWidth,
      x: rightX,
      leading: GAP.line,
    });
    labelValueRows(sheet, model.machine.rows, rightX, columnWidth);
    sheet.move(6);
  }

  sheet.pdf.text(rightX, sheet.cursor, 'JOB DETAILS', {
    font: 'bold',
    size: SIZE.small,
    colour: MUTED,
    tracking: TRACK_HEADING,
  });
  sheet.move(GAP.line);
  labelValueRows(sheet, model.jobDetails, rightX, columnWidth);
  const rightBottom = sheet.cursor;

  // Continue below whichever column ran longer.
  sheet.setCursor(Math.min(leftBottom, rightBottom));
  sheet.move(GAP.section);
};

const fault = (sheet: Sheet, model: JobCardModel): void => {
  // Nothing to report, so no heading and no empty box. See the model.
  if (model.faultDescription === null) return;
  sheet.sectionTitle('Reported fault');
  const lines = PdfBuilder.wrap(model.faultDescription, CONTENT_WIDTH - 18, SIZE.body);
  const boxHeight = lines.length * GAP.line + 12;
  sheet.need(boxHeight + 6);

  // The screen's bordered, tinted box.
  sheet.pdf.rect(MARGIN, sheet.cursor - boxHeight + GAP.line, CONTENT_WIDTH, boxHeight, BAND);
  sheet.move(3);
  for (const line of lines) {
    sheet.pdf.text(MARGIN + 9, sheet.cursor, line, { size: SIZE.body, colour: BODY });
    sheet.move(GAP.line);
  }
  sheet.move(GAP.section - 3);
};

const work = (sheet: Sheet, model: JobCardModel): void => {
  if (model.workBlocks.length === 0) return;
  sheet.sectionTitle('Work carried out');
  for (const block of model.workBlocks) {
    sheet.need(GAP.line * 2);
    sheet.pdf.text(MARGIN, sheet.cursor, block.label.toUpperCase(), {
      font: 'bold',
      size: SIZE.small,
      colour: BODY,
      tracking: 0.45,
    });
    sheet.move(GAP.line);
    // As in `JobCardDocument`: an unwritten field is not a block at all
    // (DOC-1), so there is no faint "Not recorded" variant left to render.
    sheet.paragraph(block.value, { colour: BODY, font: 'regular' });
    sheet.move(7);
  }
  sheet.move(GAP.section - 7);
};

const notes = (sheet: Sheet, model: JobCardModel): void => {
  if (model.notes.length === 0) return;
  sheet.sectionTitle('Job notes');
  for (const note of model.notes) {
    sheet.paragraph(note.body, { colour: BODY });
    sheet.paragraph(note.byline, { size: SIZE.tiny, colour: MUTED, leading: GAP.tight });
    sheet.move(5);
  }
  sheet.move(GAP.section - 5);
};

const chargeLine = (sheet: Sheet, row: ChargeRow): void => {
  const descriptionWidth = COL_QTY - MARGIN - 14;
  const description =
    row.detail.length > 0 ? `${row.description} — ${row.detail}` : row.description;
  const lines = PdfBuilder.wrap(description, descriptionWidth, SIZE.body);

  sheet.need(lines.length * GAP.line + 8);
  const rowTop = sheet.cursor;

  lines.forEach((line, index) => {
    sheet.pdf.text(MARGIN, sheet.cursor, line, {
      size: SIZE.body,
      colour: index === 0 ? BODY : MUTED,
    });
    if (index < lines.length - 1) sheet.move(GAP.line);
  });

  // Figures align to the first line of a wrapped description.
  sheet.pdf.text(COL_QTY - textWidth(row.quantity, SIZE.body), rowTop, row.quantity, {
    size: SIZE.body,
    colour: BODY,
  });
  sheet.pdf.text(COL_RATE - textWidth(row.rate, SIZE.body), rowTop, row.rate, {
    size: SIZE.body,
    colour: BODY,
  });
  sheet.pdf.text(COL_AMOUNT - textWidth(row.amount, SIZE.body, 'bold'), rowTop, row.amount, {
    size: SIZE.body,
    font: 'bold',
    colour: INK,
  });

  sheet.move(7);
  sheet.rule(RULE_SOFT, 0.5);
  sheet.move(GAP.line - 2);
};

const charges = (sheet: Sheet, model: JobCardModel): void => {
  if (model.charges === null) return;
  sheet.sectionTitle('Labour, travel and parts');

  // Header band, as on screen.
  sheet.need(30);
  sheet.pdf.rect(MARGIN, sheet.cursor - 5, CONTENT_WIDTH, 16, BAND);
  sheet.rule(RULE, 0.6);
  sheet.move(-1);
  sheet.pdf.text(MARGIN, sheet.cursor, 'Description', { font: 'bold', size: SIZE.small, colour: BODY });
  for (const [x, label] of [
    [COL_QTY, 'Qty'],
    [COL_RATE, 'Rate'],
    [COL_AMOUNT, 'Amount'],
  ] as const) {
    sheet.pdf.text(x - textWidth(label, SIZE.small, 'bold'), sheet.cursor, label, {
      font: 'bold',
      size: SIZE.small,
      colour: BODY,
    });
  }
  sheet.move(11);
  sheet.rule(RULE, 0.6);
  sheet.move(GAP.line);

  for (const row of model.charges.rows) chargeLine(sheet, row);

  sheet.move(4);
  for (const [label, value] of [
    ['Subtotal', model.charges.subtotal],
    [model.charges.vatLabel, model.charges.vat],
  ] as const) {
    sheet.need(GAP.line);
    sheet.pdf.text(COL_RATE - textWidth(label, SIZE.body), sheet.cursor, label, {
      size: SIZE.body,
      colour: MUTED,
    });
    sheet.pdf.text(COL_AMOUNT - textWidth(value, SIZE.body), sheet.cursor, value, {
      size: SIZE.body,
      colour: BODY,
    });
    sheet.move(GAP.line + 2);
  }

  sheet.need(24);
  sheet.rule(INK, 1.2, COL_QTY - 40, RIGHT);
  sheet.move(GAP.line + 2);
  sheet.pdf.text(COL_RATE - textWidth('Total', SIZE.total, 'bold'), sheet.cursor, 'Total', {
    font: 'bold',
    size: SIZE.total,
    colour: INK,
  });
  sheet.pdf.text(
    COL_AMOUNT - textWidth(model.charges.total, SIZE.total, 'bold'),
    sheet.cursor,
    model.charges.total,
    { font: 'bold', size: SIZE.total, colour: INK },
  );
  sheet.move(GAP.section + 4);
};

/**
 * The goods, on a document that carries no prices.
 *
 * A courier Delivery Note used to list nothing at all: the whole parts table
 * lived inside the charges block, and the charges block is withheld from a
 * courier's copy in full — correctly, since none of the driver's business is
 * what the customer paid. The consequence was a delivery note with no delivery
 * on it, which neither the driver nor the receiving store could check a load
 * against, and which disagreed with the note shown on screen.
 *
 * Part numbers and quantities, and nothing that is a price. The model decides
 * whether this block exists at all, so no renderer can put it on the wrong copy.
 */
const collection = (sheet: Sheet, model: JobCardModel): void => {
  if (model.collection === null) return;
  sheet.sectionTitle(model.collection.heading);

  sheet.need(30);
  sheet.pdf.rect(MARGIN, sheet.cursor - 5, CONTENT_WIDTH, 16, BAND);
  sheet.rule(RULE, 0.6);
  sheet.move(-1);
  sheet.pdf.text(MARGIN, sheet.cursor, 'Part', {
    font: 'bold',
    size: SIZE.small,
    colour: BODY,
  });
  sheet.pdf.text(
    COL_AMOUNT - textWidth('Quantity', SIZE.small, 'bold'),
    sheet.cursor,
    'Quantity',
    { font: 'bold', size: SIZE.small, colour: BODY },
  );
  sheet.move(11);
  sheet.rule(RULE, 0.6);
  sheet.move(GAP.line);

  for (const line of model.collection.lines) {
    const width = COL_AMOUNT - MARGIN - 80;
    const text =
      line.description.length > 0 ? `${line.partNumber} — ${line.description}` : line.partNumber;
    const wrapped = PdfBuilder.wrap(text, width, SIZE.body);

    sheet.need(wrapped.length * GAP.line + 8);
    const rowTop = sheet.cursor;
    wrapped.forEach((part, index) => {
      sheet.pdf.text(MARGIN, sheet.cursor, part, {
        size: SIZE.body,
        colour: index === 0 ? BODY : MUTED,
      });
      if (index < wrapped.length - 1) sheet.move(GAP.line);
    });
    sheet.pdf.text(
      COL_AMOUNT - textWidth(line.quantity, SIZE.body, 'bold'),
      rowTop,
      line.quantity,
      { size: SIZE.body, font: 'bold', colour: INK },
    );

    sheet.move(7);
    sheet.rule(RULE_SOFT, 0.5);
    sheet.move(GAP.line - 2);
  }

  /*
   * "Items", never "Total".
   *
   * A count of goods is not a figure of money, and the word "Total" on a
   * document that deliberately carries no prices invites exactly the reading
   * the suppression exists to prevent.
   */
  sheet.need(20);
  sheet.pdf.text(MARGIN, sheet.cursor, model.collection.totalLabel, {
    font: 'bold',
    size: SIZE.body,
    colour: INK,
  });
  sheet.pdf.text(
    COL_AMOUNT - textWidth(model.collection.totalQuantity, SIZE.body, 'bold'),
    sheet.cursor,
    model.collection.totalQuantity,
    { font: 'bold', size: SIZE.body, colour: INK },
  );
  sheet.move(GAP.line + 2);

  sheet.paragraph(model.collection.priceNote, { size: SIZE.tiny, colour: MUTED });
  sheet.move(GAP.section - 6);
};

const checklist = (sheet: Sheet, model: JobCardModel): void => {
  if (model.checklist === null) return;

  sheet.sectionTitle(model.checklist.title);
  sheet.paragraph(model.checklist.summary, { size: SIZE.small, colour: MUTED, leading: GAP.line });
  sheet.move(5);

  for (const section of model.checklist.sections) {
    // A section heading alone at the foot of a page helps nobody.
    sheet.need(GAP.line * 3);
    sheet.pdf.text(MARGIN, sheet.cursor, section.title.toUpperCase(), {
      font: 'bold',
      size: SIZE.small,
      colour: BODY,
      tracking: 0.45,
    });
    sheet.move(6);
    sheet.rule(RULE, 0.6);
    sheet.move(GAP.line);

    for (const item of section.items) {
      const answerWidth = textWidth(item.answer, SIZE.body, 'bold');
      // A long text answer gets its own line rather than colliding with the
      // question, which is what made the on-screen and PDF versions differ.
      const inline = answerWidth < 150;
      const questionWidth = inline ? CONTENT_WIDTH - answerWidth - 18 : CONTENT_WIDTH;
      const lines = PdfBuilder.wrap(item.text, questionWidth, SIZE.body);
      const noteLines =
        item.note.length > 0
          ? PdfBuilder.wrap(`Note: ${item.note}`, CONTENT_WIDTH - 12, SIZE.tiny)
          : [];

      sheet.need((lines.length + noteLines.length + (inline ? 0 : 1)) * GAP.line + 8);
      const rowTop = sheet.cursor;

      lines.forEach((line, index) => {
        sheet.pdf.text(MARGIN, sheet.cursor, line, { size: SIZE.body, colour: BODY });
        if (index < lines.length - 1) sheet.move(GAP.line);
      });

      if (inline) {
        sheet.pdf.text(RIGHT - answerWidth, rowTop, item.answer, {
          font: 'bold',
          size: SIZE.body,
          colour: INK,
        });
      } else {
        sheet.move(GAP.line);
        for (const line of PdfBuilder.wrap(item.answer, CONTENT_WIDTH - 12, SIZE.body, 'bold')) {
          sheet.pdf.text(MARGIN + 12, sheet.cursor, line, {
            font: 'bold',
            size: SIZE.body,
            colour: INK,
          });
          sheet.move(GAP.line);
        }
        sheet.move(-GAP.line);
      }

      for (const line of noteLines) {
        sheet.move(GAP.tight);
        sheet.pdf.text(MARGIN + 12, sheet.cursor, line, { size: SIZE.tiny, colour: MUTED });
      }

      sheet.move(6);
      sheet.rule(RULE_SOFT, 0.5);
      sheet.move(GAP.line - 2);
    }
    sheet.move(6);
  }
  sheet.move(GAP.section - 6);
};

/**
 * THE PHOTOGRAPHS THEMSELVES, NOT THEIR CAPTIONS.
 *
 * This printed a bullet list of captions — and the on-screen card a grey box
 * labelled "Photograph" — because the writer could not draw an image and the
 * model carried no pixels. Now each customer-facing photograph is drawn in the
 * on-screen card's own grid: three across, each in a 4:3 cell, the photograph
 * fitted inside it at its own proportions (never stretched, never cropped) and
 * centred, with its caption beneath.
 *
 * A photograph whose file cannot be drawn — not loaded, not in storage, a
 * format the writer cannot embed — gets the same cell with a plain statement
 * of why, so the document never shows an empty frame that reads as a picture.
 */
const PHOTO_COLUMNS = 3;
const PHOTO_GAP = 8.4; // gap-3
const PHOTO_CELL_WIDTH = (CONTENT_WIDTH - PHOTO_GAP * (PHOTO_COLUMNS - 1)) / PHOTO_COLUMNS;
const PHOTO_CELL_HEIGHT = (PHOTO_CELL_WIDTH * 3) / 4; // aspect-4/3
const PHOTO_CAPTION_LEADING = 9;

const photoCell = (
  sheet: Sheet,
  photo: JobCardModel['photos'][number],
  prepared: PreparedPhoto | undefined,
  x: number,
  top: number,
): void => {
  const bottom = top - PHOTO_CELL_HEIGHT;
  sheet.pdf.rect(x, bottom, PHOTO_CELL_WIDTH, PHOTO_CELL_HEIGHT, BAND);

  if (prepared?.kind === 'image') {
    const natural = displaySize(prepared.image);
    const scale = Math.min(PHOTO_CELL_WIDTH / natural.width, PHOTO_CELL_HEIGHT / natural.height);
    const width = natural.width * scale;
    const height = natural.height * scale;
    sheet.pdf.image(
      prepared.image,
      x + (PHOTO_CELL_WIDTH - width) / 2,
      bottom + (PHOTO_CELL_HEIGHT - height) / 2,
      width,
      height,
    );
  } else {
    const reason =
      prepared?.reason ?? 'The image file was not available when this document was produced.';
    const inset = 8;
    let y = top - inset - SIZE.tiny;
    sheet.pdf.text(x + inset, y, 'Photograph not shown', {
      font: 'bold',
      size: SIZE.tiny,
      colour: MUTED,
    });
    for (const line of [
      ...PdfBuilder.wrap(reason, PHOTO_CELL_WIDTH - inset * 2, SIZE.tiny),
      ...PdfBuilder.wrap(photo.fileName, PHOTO_CELL_WIDTH - inset * 2, SIZE.tiny),
    ]) {
      y -= PHOTO_CAPTION_LEADING;
      if (y < bottom + inset) break;
      sheet.pdf.text(x + inset, y, line, { size: SIZE.tiny, colour: FAINT });
    }
  }
  // The cell's hairline, drawn last so the photograph sits inside it.
  sheet.pdf.line(x, top, x + PHOTO_CELL_WIDTH, top, 0.5, RULE);
  sheet.pdf.line(x, bottom, x + PHOTO_CELL_WIDTH, bottom, 0.5, RULE);
  sheet.pdf.line(x, bottom, x, top, 0.5, RULE);
  sheet.pdf.line(x + PHOTO_CELL_WIDTH, bottom, x + PHOTO_CELL_WIDTH, top, 0.5, RULE);
};

const photographs = (
  sheet: Sheet,
  model: JobCardModel,
  images: ReadonlyMap<string, PreparedPhoto> | undefined,
): void => {
  if (model.photos.length === 0) return;
  sheet.sectionTitle('Photographs');
  for (let start = 0; start < model.photos.length; start += PHOTO_COLUMNS) {
    const row = model.photos.slice(start, start + PHOTO_COLUMNS);
    const captions = row.map((photo) =>
      photo.caption.trim().length === 0
        ? []
        : PdfBuilder.wrap(photo.caption, PHOTO_CELL_WIDTH, SIZE.tiny),
    );
    const captionLines = Math.max(0, ...captions.map((lines) => lines.length));
    const rowHeight = PHOTO_CELL_HEIGHT + (captionLines === 0 ? 0 : 4 + captionLines * PHOTO_CAPTION_LEADING);
    // A row is never split across a page: a photograph cut in half is worse
    // than white space at the foot of a page.
    sheet.need(rowHeight + SIZE.small);
    const top = sheet.cursor + SIZE.small;
    row.forEach((photo, column) => {
      const x = MARGIN + column * (PHOTO_CELL_WIDTH + PHOTO_GAP);
      photoCell(sheet, photo, images?.get(photo.id), x, top);
      captions[column]!.forEach((line, index) => {
        sheet.pdf.text(
          x,
          top - PHOTO_CELL_HEIGHT - 4 - SIZE.tiny - index * PHOTO_CAPTION_LEADING,
          line,
          { size: SIZE.tiny, colour: MUTED },
        );
      });
    });
    sheet.move(rowHeight + PHOTO_GAP);
  }
  sheet.move(GAP.section);
};

/**
 * The customer's refusal, in place of the signature block.
 *
 * Deliberately NOT a bordered box with the declaration printed beside it: there
 * is no acceptance here and the document must not look as though there nearly
 * was one. It states what happened, why, who took it and when, and draws no
 * signature mark of any kind.
 */
const refusal = (sheet: Sheet, model: JobCardModel): void => {
  const block = model.refusal;
  if (block === null) return;

  sheet.need(110);
  sheet.move(GAP.sectionLarge);
  sheet.rule(INK, 1.4);
  sheet.move(GAP.section);
  sheet.sectionTitle('Customer acceptance');

  sheet.paragraph(block.heading.toUpperCase(), {
    font: 'bold',
    size: SIZE.total,
    colour: INK,
  });
  sheet.move(4);

  sheet.paragraph('Reason', {
    font: 'bold',
    size: SIZE.small,
    colour: MUTED,
    leading: GAP.line,
  });
  sheet.paragraph(block.reason, { colour: BODY });
  sheet.move(5);

  labelValueRows(sheet, block.rows, MARGIN, CONTENT_WIDTH);
  sheet.move(GAP.section);
};

const acceptance = (sheet: Sheet, model: JobCardModel): void => {
  // A refused job card has no acceptance block at all — see `refusal`.
  if (model.refusal !== null) {
    refusal(sheet, model);
    return;
  }

  const columnWidth = (CONTENT_WIDTH - 24) / 2;
  const rightX = MARGIN + columnWidth + 24;
  const boxHeight = 62;

  // The whole acceptance block stays together: a signature on a different page
  // from the declaration it belongs to is not an acceptance.
  sheet.need(boxHeight + 92);

  sheet.move(GAP.sectionLarge);
  sheet.rule(INK, 1.4);
  sheet.move(GAP.section);
  sheet.sectionTitle(
    model.acceptance === null
      ? 'Customer acceptance'
      // "Courier signature — given once, on the Delivery Note" titles as "Courier acceptance".
      : `${model.acceptance.caption.split(' signature')[0]} acceptance`,
  );

  if (model.acceptance === null) {
    sheet.paragraph('Not yet signed.', { font: 'italic', colour: MUTED });
    sheet.move(GAP.section);
    return;
  }

  const top = sheet.cursor;

  // Left column: the declaration, then who signed and when.
  sheet.paragraph(model.acceptance.declaration, { colour: BODY, width: columnWidth });
  sheet.move(5);
  labelValueRows(sheet, model.acceptance.rows, MARGIN, columnWidth);
  const leftBottom = sheet.cursor;

  // Right column: the signature itself, in the screen's bordered, tinted box.
  const boxTop = top + 10;
  const boxBottom = boxTop - boxHeight;
  sheet.pdf.rect(rightX, boxBottom, columnWidth, boxHeight, BAND);
  sheet.pdf.line(rightX, boxTop, rightX + columnWidth, boxTop, 0.6, RULE);
  sheet.pdf.line(rightX, boxBottom, rightX + columnWidth, boxBottom, 0.6, RULE);
  sheet.pdf.line(rightX, boxTop, rightX, boxBottom, 0.6, RULE);
  sheet.pdf.line(rightX + columnWidth, boxTop, rightX + columnWidth, boxBottom, 0.6, RULE);

  const mark = signatureFacsimile(model.acceptance.signatureData);
  if (mark.kind === 'path') {
    // The customer's own geometry, in the same pure black the signature pad and
    // the on-screen job card use.
    sheet.pdf.normalisedPath(
      mark.path,
      { x: rightX + 10, y: boxBottom + 7, width: columnWidth - 20, height: boxHeight - 14 },
      { colour: SIGNATURE_INK, width: 1.5 },
    );
  } else {
    // A seeded job stores a label rather than captured geometry, and the
    // on-screen card draws the name in a cursive face. Matched here, or the two
    // documents would show different things in the same box.
    const centred =
      rightX + columnWidth / 2 - textWidth(mark.text, SIZE.signature, 'script') / 2;
    sheet.pdf.text(centred, boxBottom + boxHeight / 2 - 5, mark.text, {
      font: 'script',
      size: SIZE.signature,
      colour: SIGNATURE_INK,
    });
  }

  sheet.pdf.text(rightX, boxBottom - 11, model.acceptance.caption, {
    size: SIZE.tiny,
    colour: MUTED,
  });

  sheet.setCursor(Math.min(leftBottom, boxBottom - 11));
  sheet.move(GAP.section);
};

/**
 * THE STAMP ON A DEMONSTRATION DOCUMENT. October mandate §1.1.
 *
 * On EVERY PAGE, and in the file itself rather than only on the screen that
 * produced it: a PDF is downloaded, emailed, printed and filed, and by then
 * the screen's badge is long gone. A demonstration job card that reaches
 * somebody's desk looking exactly like an issued one is the single most
 * expensive confusion this system could create — it is the document a customer
 * signs and a dispute is settled by.
 *
 * Drawn in the footer band, where there is always room on every page, and in
 * the strongest ink the document uses rather than the faint grey the rest of
 * the band is in. Nothing is drawn for a genuine document: the absence of this
 * line is what makes its presence mean something.
 */
const simulatedStamp = (sheet: Sheet): void => {
  const width = textWidth(SIMULATED_NOTICE_PRINT, SIZE.small);
  sheet.pdf.rect(MARGIN, MARGIN + 29, CONTENT_WIDTH, 14, BAND);
  sheet.pdf.text(MARGIN + (CONTENT_WIDTH - width) / 2, MARGIN + 33, SIMULATED_NOTICE_PRINT, {
    size: SIZE.small,
    colour: INK,
  });
};

const footers = (
  sheet: Sheet,
  model: JobCardModel,
  fileName: string,
  simulated: boolean,
): void => {
  const total = sheet.pdf.pageCount;
  for (let index = 0; index < total; index += 1) {
    sheet.pdf.selectPage(index);
    if (simulated) simulatedStamp(sheet);
    sheet.pdf.line(MARGIN, MARGIN + 26, RIGHT, MARGIN + 26, 0.5, RULE);

    model.footerLines.forEach((line, lineIndex) => {
      sheet.pdf.text(MARGIN, MARGIN + 16 - lineIndex * 9, line, {
        size: SIZE.tiny,
        colour: FAINT,
      });
    });

    const page = `Page ${index + 1} of ${total}`;
    sheet.pdf.text(RIGHT - textWidth(page, SIZE.tiny), MARGIN + 16, page, {
      size: SIZE.tiny,
      colour: FAINT,
    });
    sheet.pdf.text(
      RIGHT - textWidth(fileName, SIZE.tiny),
      MARGIN + 7,
      fileName,
      { size: SIZE.tiny, colour: FAINT },
    );
  }
};

/** Renders the final document for a job, returning the bytes and page count. */
export const renderJobCardPdf = (
  source: FinalDocumentSource,
  fileName: string,
  generatedAt: string,
): RenderedPdf => {
  const model = buildJobCardModel({ ...source, generatedAt });
  const sheet = new Sheet();

  header(sheet, model);
  parties(sheet, model);
  fault(sheet, model);
  work(sheet, model);
  notes(sheet, model);
  charges(sheet, model);
  collection(sheet, model);
  checklist(sheet, model);
  photographs(sheet, model, source.photoImages);
  acceptance(sheet, model);
  /*
   * WHETHER THIS IS A DEMONSTRATION DOCUMENT, taken from the JOB'S OWN RECORD.
   *
   * `finalDocument.provenance` is what the seed wrote for the six demonstration
   * job cards; a document being issued for the first time has no record yet and
   * is therefore genuine, which is the right default — a preview of a real job
   * must not be stamped.
   */
  footers(sheet, model, fileName, source.job.finalDocument?.provenance === 'simulated');

  return { bytes: sheet.pdf.toBytes(), pageCount: sheet.pdf.pageCount };
};
