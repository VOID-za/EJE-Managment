import type { PdfFont } from './writer';

/**
 * Character advance widths for the base-14 fonts, in 1/1000 em.
 *
 * From the standard AFM metrics for Helvetica, Helvetica-Bold and Times-Italic.
 * Estimating these was a real bug: an approximation that ran about 20% narrow
 * told the line-wrapper a line fitted when it did not, so the customer's
 * contact details and the acceptance declaration overran their columns and were
 * painted over by the panel beside them.
 *
 * A viewer lays text out with exactly these numbers, so measuring with them is
 * the only way a wrap decision can be correct.
 */

const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const TIMES_ITALIC = [
  250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278, 500, 500, 500,
  500, 500, 500, 500, 500, 500, 500, 333, 333, 675, 675, 675, 500, 920, 611, 611, 667, 722, 611,
  611, 722, 722, 333, 444, 667, 556, 833, 667, 722, 611, 722, 611, 500, 556, 722, 611, 833, 611,
  556, 556, 389, 278, 389, 422, 500, 333, 500, 500, 444, 500, 444, 278, 500, 500, 278, 278, 444,
  278, 722, 500, 500, 500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400, 275, 400, 541,
];

/** Non-ASCII characters the job card can actually emit, per font. */
const EXTRAS: Record<'sans' | 'serif', Record<string, number>> = {
  sans: {
    ' ': 278,
    '·': 278,
    '•': 350,
    '–': 556,
    '—': 1000,
    '‘': 222,
    '’': 222,
    '“': 333,
    '”': 333,
    '°': 400,
    '±': 584,
    '×': 584,
    '…': 1000,
    '£': 556,
    '©': 737,
    '®': 737,
  },
  serif: {
    ' ': 250,
    '·': 250,
    '–': 500,
    '—': 889,
    '‘': 333,
    '’': 333,
    '“': 556,
    '”': 556,
    '°': 400,
    '…': 889,
  },
};

const tableFor = (font: PdfFont): readonly number[] => {
  switch (font) {
    case 'bold':
      return HELVETICA_BOLD;
    case 'script':
      return TIMES_ITALIC;
    // Helvetica-Oblique carries the same widths as Helvetica.
    case 'italic':
    case 'regular':
      return HELVETICA;
  }
};

/**
 * Headroom for the font the VIEWER actually uses.
 *
 * The base-14 fonts are named, not embedded — that is the point of them, and it
 * keeps the file small. But a viewer without Helvetica substitutes something
 * metrically similar rather than identical: Chromium typically picks Liberation
 * Sans or DejaVu Sans, and DejaVu in particular sets noticeably wider.
 *
 * Laying out to exact Helvetica widths therefore still overflows in practice —
 * a line the metrics call 236pt rendered at about 270pt, which is how the
 * customer's contact details came to print over the job details beside them.
 * So every layout decision reserves this much headroom, and the PDF inspector
 * measures with it too, so a test sees what a reader would see.
 */
export const SUBSTITUTION_ALLOWANCE = 1.16;

/** Width of one character in 1/1000 em, or a sensible default. */
export const charWidth = (character: string, font: PdfFont): number => {
  const code = character.codePointAt(0) ?? 32;
  if (code >= 32 && code <= 126) {
    return tableFor(font)[code - 32] ?? 500;
  }
  const extras = EXTRAS[font === 'script' ? 'serif' : 'sans'];
  return extras[character] ?? (font === 'script' ? 500 : 556);
};
