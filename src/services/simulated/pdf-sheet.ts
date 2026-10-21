import { A4_HEIGHT, A4_WIDTH, PdfBuilder, textWidth, type PdfFont } from '@/lib/pdf/writer';

/**
 * THE PAPER ITSELF: page geometry, the type scale, the colours and the cursor.
 *
 * Extracted from `job-card-pdf.ts` when a SECOND document needed it — the
 * correction addendum (BD-02). The two documents are different documents and
 * must look like the same company's paper, which they will only do while there
 * is one definition of what that paper is.
 *
 * The scale mirrors the on-screen document: it is 820px wide with 40px
 * padding, so 740px of content become 515pt here, a factor of about 0.7. Every
 * size and gap below is the screen's Tailwind value at that scale, which is
 * what keeps the printed document recognisably the same document rather than a
 * denser relative of it.
 */

export const MARGIN = 40;
export const CONTENT_WIDTH = A4_WIDTH - MARGIN * 2;
export const RIGHT = A4_WIDTH - MARGIN;
export const FOOTER_SPACE = 44;

/** Type scale, from the screen's px values at 0.7. */
export const SIZE = {
  companyName: 12.5, // text-lg
  jobNumber: 17, // text-2xl
  small: 7.5, // text-xs
  body: 9, // 13px base
  tiny: 7, // text-[11px]
  total: 11, // text-base
  signature: 17,
} as const;

/** Vertical rhythm, from the screen's spacing utilities at 0.7. */
export const GAP = {
  section: 17, // mt-6
  sectionLarge: 22, // mt-8
  line: 12,
  tight: 10,
} as const;

/**
 * The screen's letter-spaced section headings.
 *
 * `tracking-[0.12em]` at 7.5pt is 0.9pt; the wider `tracking-[0.18em]` on the
 * document title is 1.35pt. Applied through the PDF `Tc` operator, so the text
 * stays one searchable word rather than being padded with spaces.
 */
export const TRACK_HEADING = 0.9;
export const TRACK_TITLE = 1.35;

export const INK = '#1b2434'; // steel-900
export const BODY = '#39414f'; // steel-700/800
export const MUTED = '#6b7481'; // steel-500
export const FAINT = '#9aa2ad'; // steel-400
export const RULE = '#dfe3e8'; // steel-200
export const RULE_SOFT = '#eef0f3'; // steel-100
export const BAND = '#f6f7f9'; // steel-50

/** Column geometry for the charges table, mirroring the screen's widths. */
export const COL_QTY = RIGHT - 190;
export const COL_RATE = RIGHT - 120;
export const COL_AMOUNT = RIGHT;

export class Sheet {
  readonly pdf = new PdfBuilder();
  private y = 0;

  constructor() {
    this.break();
  }

  private break(): void {
    this.pdf.addPage();
    this.y = A4_HEIGHT - MARGIN;
  }

  get cursor(): number {
    return this.y;
  }

  move(by: number): void {
    this.y -= by;
  }

  /**
   * Places the cursor at an absolute position.
   *
   * Two-column blocks need it: each column is laid out from the same top, and
   * the block continues below whichever ran longer. Nudging a relative cursor
   * backwards instead is how the customer's contact details came to be printed
   * over the job details beside them.
   */
  setCursor(y: number): void {
    this.y = y;
  }

  /** True if `height` will not fit on the current page. */
  wouldOverflow(height: number): boolean {
    return this.y - height < MARGIN + FOOTER_SPACE;
  }

  /** Breaks to a new page when `height` will not fit. */
  need(height: number): void {
    if (this.wouldOverflow(height)) this.break();
  }

  text(x: number, value: string, options: { font?: PdfFont; size?: number; colour?: string } = {}): void {
    this.pdf.text(x, this.y, value, options);
  }

  /** Right-aligned at `x`. */
  textRight(x: number, value: string, options: { font?: PdfFont; size?: number; colour?: string } = {}): void {
    const size = options.size ?? SIZE.body;
    this.pdf.text(x - textWidth(value, size, options.font ?? 'regular'), this.y, value, options);
  }

  rule(colour = RULE, width = 0.6, from = MARGIN, to = RIGHT): void {
    this.pdf.line(from, this.y, to, this.y, width, colour);
  }

  /** The screen's uppercase, letter-spaced section heading. */
  sectionTitle(label: string): void {
    this.need(GAP.line + 14);
    this.pdf.text(MARGIN, this.y, label.toUpperCase(), {
      font: 'bold',
      size: SIZE.small,
      colour: MUTED,
      tracking: TRACK_HEADING,
    });
    this.move(GAP.line);
  }

  paragraph(
    value: string,
    options: { font?: PdfFont; size?: number; colour?: string; width?: number; x?: number; leading?: number } = {},
  ): void {
    const size = options.size ?? SIZE.body;
    const width = options.width ?? CONTENT_WIDTH;
    const leading = options.leading ?? size * 1.45;
    for (const line of PdfBuilder.wrap(value, width, size, options.font ?? 'regular')) {
      this.need(leading);
      this.pdf.text(options.x ?? MARGIN, this.y, line, {
        font: options.font,
        size,
        colour: options.colour ?? BODY,
      });
      this.move(leading);
    }
  }
}
