import { textWidth } from '@/lib/pdf/writer';
import {
  CORRECTED_AREA_LABEL,
  SIMULATED_NOTICE_PRINT,
  correctionTitle,
  type CorrectedArea,
} from '@/domain';
import {
  BAND,
  BODY,
  CONTENT_WIDTH,
  FAINT,
  GAP,
  INK,
  MARGIN,
  MUTED,
  RIGHT,
  RULE,
  Sheet,
  SIZE,
  TRACK_HEADING,
  TRACK_TITLE,
} from './pdf-sheet';
import type { CorrectionDocumentSource, RenderedPdf } from '../ports';

/**
 * THE CORRECTION ADDENDUM. BD-02, IMMUT-9, AUD-3.
 *
 * WHAT THIS IS NOT, and it is the whole design: it is not a re-rendered job
 * card. A re-render would produce a different document carrying the original's
 * date — the exact failure a frozen job card exists to prevent, and the reason
 * `final_documents` refuses UPDATE at the database. The customer keeps the job
 * card they were sent and receives this BESIDE it.
 *
 * SO IT SAYS, IN THIS ORDER, what somebody holding two pieces of paper needs:
 *
 *   1. that it is a CORRECTION, in the largest words on the page;
 *   2. which job card it corrects, by number and by issue date;
 *   3. that the original stands and its signature is untouched;
 *   4. why it was wrong;
 *   5. which parts of it are affected;
 *   6. what the correction says;
 *   7. who raised it and when;
 *   8. whether the customer's acknowledgement was required, and what it was.
 *
 * It shares `pdf-sheet.ts` with the job card so the two are visibly the same
 * company's paper, and nothing else.
 */

const heading = (sheet: Sheet, source: CorrectionDocumentSource): void => {
  const top = sheet.cursor;

  sheet.pdf.rect(MARGIN, top - 24, 31, 31, INK);
  sheet.pdf.text(MARGIN + 6, top - 14, 'EJE', { font: 'bold', size: 9, colour: '#ffffff' });

  sheet.pdf.text(MARGIN + 39, top - 6, source.company.name, {
    font: 'bold',
    size: SIZE.companyName,
    colour: INK,
  });
  sheet.pdf.text(MARGIN + 39, top - 17, source.company.address, {
    size: SIZE.small,
    colour: MUTED,
  });
  sheet.pdf.text(MARGIN, top - 40, source.company.contactLine, { size: SIZE.small, colour: MUTED });
  sheet.pdf.text(MARGIN, top - 50, source.company.registrationLine, {
    size: SIZE.small,
    colour: MUTED,
  });

  /*
   * THE WORD "CORRECTION" IS THE DOCUMENT'S NAME, in the job number's size.
   * Somebody filing paperwork reads the top right corner and nothing else, and
   * the one thing they must not conclude is that this is the job card.
   */
  const title = 'CORRECTION TO JOB CARD';
  sheet.pdf.text(RIGHT - textWidth(title, SIZE.small, 'bold', TRACK_TITLE), top - 6, title, {
    font: 'bold',
    size: SIZE.small,
    colour: MUTED,
    tracking: TRACK_TITLE,
  });
  const number = `${source.jobNumber} · ${source.correction.sequence}`;
  sheet.pdf.text(RIGHT - textWidth(number, SIZE.jobNumber, 'bold'), top - 24, number, {
    font: 'bold',
    size: SIZE.jobNumber,
    colour: INK,
  });

  sheet.setCursor(top - 68);
  sheet.rule();
  sheet.move(GAP.section);
};

/** The band that says the original still stands. */
const standing = (sheet: Sheet, source: CorrectionDocumentSource): void => {
  const lines = [
    `This corrects job card ${source.jobNumber}, issued ${source.original.issuedAt}.`,
    source.original.signed
      ? 'THE ORIGINAL JOB CARD AND THE SIGNATURE ON IT STAND UNCHANGED. Nothing has been ' +
        'edited, replaced or re-issued; this document is read beside it.'
      : 'THE ORIGINAL JOB CARD STANDS UNCHANGED. It was issued without a customer signature, ' +
        'and nothing has been edited, replaced or re-issued; this document is read beside it.',
  ];

  const height = 20 + lines.length * 22;
  sheet.need(height);
  const top = sheet.cursor;
  sheet.pdf.rect(MARGIN, top - height + 12, CONTENT_WIDTH, height, BAND);
  sheet.move(6);

  for (const line of lines) {
    sheet.paragraph(line, { size: SIZE.body, colour: BODY, width: CONTENT_WIDTH - 20, x: MARGIN + 10 });
    sheet.move(4);
  }
  sheet.setCursor(top - height + 4);
  sheet.move(GAP.section);
};

const block = (sheet: Sheet, label: string, body: string): void => {
  sheet.sectionTitle(label);
  sheet.paragraph(body, { size: SIZE.body, colour: BODY });
  sheet.move(GAP.tight);
};

const areasBlock = (sheet: Sheet, areas: readonly CorrectedArea[]): void => {
  sheet.sectionTitle('Parts of the job card affected');
  for (const area of areas) {
    sheet.need(GAP.line);
    /*
     * A HYPHEN, NOT A BULLET. The renderer ships the standard 14 fonts with
     * WinAnsi encoding and a `•` came out as a gap — the same lesson the
     * SIMULATED stamp's em dash taught. A list that reads as blank indents is
     * worse than a plain one.
     */
    sheet.text(MARGIN, `-  ${CORRECTED_AREA_LABEL[area]}`, { size: SIZE.body, colour: BODY });
    sheet.move(GAP.line);
  }
  sheet.move(GAP.tight);
};

const attribution = (sheet: Sheet, source: CorrectionDocumentSource): void => {
  const { correction } = source;
  sheet.sectionTitle('Raised by');
  sheet.text(MARGIN, `${correction.raisedBy} — ${correction.raisedAt}`, {
    size: SIZE.body,
    colour: BODY,
  });
  sheet.move(GAP.line + GAP.tight);

  /*
   * THE ACKNOWLEDGEMENT, AND THE HONEST STATE OF IT.
   *
   * "Required and not yet given" is printed as exactly that. The alternative —
   * printing nothing until it arrives — hands the customer a document that
   * looks complete and is not, and leaves EJE with no paper trail of what they
   * were waiting for.
   */
  sheet.sectionTitle("The customer's acknowledgement");
  if (correction.acknowledged !== null) {
    const { by, method, at, note } = correction.acknowledged;
    sheet.paragraph(`Acknowledged by ${by} (${method}) on ${at}.`, {
      size: SIZE.body,
      colour: BODY,
    });
    if (note.trim().length > 0) {
      sheet.move(4);
      sheet.paragraph(note, { size: SIZE.body, colour: MUTED });
    }
  } else if (correction.acknowledgementRequired) {
    sheet.paragraph(
      'REQUIRED, AND NOT YET RECORDED. EJE have asked the customer to confirm they have seen ' +
        'this correction. Until that is recorded, this correction is on file and the ' +
        "acknowledgement is not.",
      { size: SIZE.body, colour: BODY },
    );
  } else {
    sheet.paragraph(
      'Not required for this correction. The original job card and its signature are unchanged.',
      { size: SIZE.body, colour: MUTED },
    );
  }
  sheet.move(GAP.line);
};

const footers = (sheet: Sheet, source: CorrectionDocumentSource, fileName: string): void => {
  const total = sheet.pdf.pageCount;
  for (let index = 0; index < total; index += 1) {
    sheet.pdf.selectPage(index);

    if (source.simulated) {
      /*
       * EVERY PAGE, and the same words as the job card's stamp. A correction to
       * a demonstration job card is demonstration data, and the one line that
       * must be readable is drawn before the footer so nothing overlaps it.
       */
      const width = textWidth(SIMULATED_NOTICE_PRINT, SIZE.small, 'bold', TRACK_HEADING);
      sheet.pdf.text((RIGHT + MARGIN) / 2 - width / 2, MARGIN + 34, SIMULATED_NOTICE_PRINT, {
        font: 'bold',
        size: SIZE.small,
        colour: '#b4530a',
        tracking: TRACK_HEADING,
      });
    }

    sheet.pdf.line(MARGIN, MARGIN + 26, RIGHT, MARGIN + 26, 0.5, RULE);
    sheet.pdf.text(
      MARGIN,
      MARGIN + 16,
      `${correctionTitle({ sequence: source.correction.sequence }, source.jobNumber)} — the ` +
        'original job card is unchanged.',
      { size: SIZE.tiny, colour: FAINT },
    );
    sheet.pdf.text(MARGIN, MARGIN + 7, source.company.name, {
      size: SIZE.tiny,
      colour: FAINT,
    });

    const page = `Page ${index + 1} of ${total}`;
    sheet.pdf.text(RIGHT - textWidth(page, SIZE.tiny), MARGIN + 16, page, {
      size: SIZE.tiny,
      colour: FAINT,
    });
    sheet.pdf.text(RIGHT - textWidth(fileName, SIZE.tiny), MARGIN + 7, fileName, {
      size: SIZE.tiny,
      colour: FAINT,
    });
  }
};

/** Renders a correction addendum, returning the bytes and the page count. */
export const renderCorrectionPdf = (
  source: CorrectionDocumentSource,
  fileName: string,
): RenderedPdf => {
  const sheet = new Sheet();

  heading(sheet, source);
  standing(sheet, source);

  sheet.sectionTitle('Customer');
  sheet.text(MARGIN, source.customerName, { size: SIZE.body, colour: BODY });
  sheet.move(GAP.line);
  if (source.machineDescription.length > 0) {
    sheet.text(MARGIN, source.machineDescription, { size: SIZE.body, colour: MUTED });
    sheet.move(GAP.line);
  }
  sheet.move(GAP.tight);

  block(sheet, 'Why the original was wrong', source.correction.reason);
  areasBlock(sheet, source.correction.areas);
  block(sheet, 'The correction', source.correction.narrative);
  attribution(sheet, source);

  footers(sheet, source, fileName);

  return { bytes: sheet.pdf.toBytes(), pageCount: sheet.pdf.pageCount };
};
