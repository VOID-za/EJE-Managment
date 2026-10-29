import { A4_HEIGHT, A4_WIDTH, PdfBuilder, textWidth } from '@/lib/pdf/writer';
import { BAND, BODY, INK, MUTED, RULE, RULE_SOFT, TRACK_TITLE } from './pdf-sheet';

/**
 * ONE PAGE, ALWAYS. PAY-04 (29 October 2026): every timesheet and attendance
 * PDF is EXACTLY one A4 page — a hard acceptance condition.
 *
 * A form is a heading, labelled fields, one table, notes and an optional
 * comments box. This lays the WHOLE form out on a single page and draws
 * nothing until it knows it fits:
 *
 *   1. One table across the page, at full size; then smaller, step by step,
 *      down to a floor that stays legible on paper (the body never below
 *      MIN_BODY_PT).
 *   2. If that is still too tall, the table is split into TWO side-by-side
 *      panels (rows continue from the left panel into the right, each panel
 *      with its own header) and the same sizes are tried again.
 *
 * NOTHING IS CUT. Every cell wraps — a long customer name, a long note — so no
 * value is truncated or hidden; every row, note and comment line is placed.
 * If even two panels at the floor cannot hold the form, it is REFUSED with
 * `OnePageOverflow` rather than spilling onto a second page or dropping rows;
 * the caller says so in plain words. The chosen layout is returned so tests can
 * see how much room was left.
 */

export interface FormColumn {
  readonly key: string;
  readonly header: string;
  /** Relative width; the columns share the panel's width in proportion. */
  readonly weight: number;
  readonly align: 'left' | 'right';
}

export interface FormRow {
  readonly cells: Readonly<Record<string, string>>;
  /** Drawn in the muted colour (an unrecorded day). */
  readonly muted?: boolean;
  /** Draws a slightly stronger rule above this row (a new day). */
  readonly groupStart?: boolean;
  /**
   * Shorter values for the two-panel layout (a date without its year, which the
   * Period line already gives). Same information, less width.
   */
  readonly compact?: Readonly<Record<string, string>>;
}

export interface FormSpec {
  readonly companyName: string;
  /** The big title, top right: "TIME SHEET", "ATTENDANCE". */
  readonly title: string;
  readonly fields: readonly (readonly [label: string, value: string])[];
  readonly columns: readonly FormColumn[];
  readonly rows: readonly FormRow[];
  /** The totals line under the table, by column key, with its label in the first text column. */
  readonly totals?: { readonly label: string; readonly cells: Readonly<Record<string, string>> };
  readonly notes: readonly string[];
  /** A boxed comment, e.g. "Comments". Omitted when undefined. */
  readonly comment?: { readonly title: string; readonly text: string };
  readonly footer: string;
}

export interface FormLayout {
  readonly scale: number;
  readonly panels: 1 | 2;
  readonly bodyPt: number;
  /** Points of the page left unused below the content (as planned). */
  readonly spare: number;
  /** The lowest baseline actually drawn above the footer, in points from the bottom edge. */
  readonly lowestBaseline: number;
  /** Where the footer zone begins: nothing but the footer is drawn below it. */
  readonly footerTop: number;
}

export interface RenderedForm {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly layout: FormLayout;
}

export class OnePageOverflow extends Error {
  constructor(readonly rows: number) {
    super(`This form has ${rows} table rows and cannot be printed legibly on one page.`);
  }
}

const MARGIN = 28;
const WIDTH = A4_WIDTH - MARGIN * 2;
const FOOTER = 14;
const PANEL_GAP = 10;
const BASE_BODY = 8;
export const MIN_BODY_PT = 5.4;
const PAD = 2.5;

interface Sizes {
  readonly body: number;
  readonly leading: number;
  readonly company: number;
  readonly title: number;
  readonly field: number;
  readonly fieldLeading: number;
  readonly note: number;
  readonly gap: number;
}

const sizesAt = (scale: number): Sizes => {
  const body = BASE_BODY * scale;
  return {
    body,
    // Tighter lines as the type gets smaller: 1.22 at full size, 1.12 at the floor.
    leading: body * (1.12 + 0.1 * Math.min(1, Math.max(0, (scale - MIN_BODY_PT / BASE_BODY) / (1 - MIN_BODY_PT / BASE_BODY)))),
    company: 12 * Math.max(scale, 0.8),
    title: 16 * Math.max(scale, 0.8),
    field: 8.5 * Math.max(scale, 0.72),
    fieldLeading: 8.5 * Math.max(scale, 0.72) * (scale < 0.85 ? 1.3 : 1.45),
    note: Math.max(body * 0.95, MIN_BODY_PT),
    gap: 10 * Math.max(scale, 0.7),
  };
};

interface PlacedRow {
  readonly row: FormRow;
  readonly lines: Readonly<Record<string, readonly string[]>>;
  readonly height: number;
}

const widthsFor = (columns: readonly FormColumn[], panelWidth: number): readonly number[] => {
  const total = columns.reduce((sum, column) => sum + column.weight, 0);
  return columns.map((column) => (column.weight / total) * panelWidth);
};

/** A row's cells in this layout: the compact values when the table is in two panels. */
const cellsOf = (row: FormRow, panels: 1 | 2): Readonly<Record<string, string>> =>
  panels === 2 && row.compact !== undefined ? { ...row.cells, ...row.compact } : row.cells;

const wordsOf = (value: string): string[] => value.split(/\s+/u).filter((word) => word.length > 0);

/**
 * Column widths from the CONTENT at this size. Every column starts at the width
 * its longest value needs on one line (a header may wrap by word, so a header
 * never forces its column wider than its longest word). If that is wider than
 * the panel, the columns holding the most text — a customer, a note — give up
 * width first, down to their longest single word; a date, an amount or a
 * status keeps what it needs and never wraps unless nothing else can give.
 */
const contentWidths = (spec: FormSpec, panelWidth: number, size: number, panels: 1 | 2): readonly number[] => {
  const columns = spec.columns;
  const rows = spec.rows.map((row) => cellsOf(row, panels));
  const longestWord = (value: string, bold = false) =>
    Math.max(0, ...wordsOf(value).map((word) => Math.min(textWidth(word, size, bold ? 'bold' : 'regular'), panelWidth / 3)));
  const natural = columns.map((column) =>
    Math.max(longestWord(column.header, true), ...rows.map((cells) => textWidth(cells[column.key] ?? '', size))) + PAD * 2 + 1,
  );
  const minimum = columns.map((column) =>
    Math.max(longestWord(column.header, true), ...rows.map((cells) => longestWord(cells[column.key] ?? ''))) + PAD * 2 + 1,
  );
  const sumNatural = natural.reduce((a, b) => a + b, 0);
  if (sumNatural <= panelWidth) {
    const surplus = widthsFor(columns, panelWidth - sumNatural);
    return natural.map((width, index) => width + surplus[index]!);
  }
  const volume = columns.map((column) => rows.reduce((sum, cells) => sum + textWidth(cells[column.key] ?? '', size), 0));
  const widths = [...natural];
  let excess = sumNatural - panelWidth;
  const order = columns.map((_, index) => index).sort((a, b) => volume[b]! - volume[a]!);
  for (const index of order) {
    if (excess <= 0) break;
    const give = Math.min(excess, widths[index]! - minimum[index]!);
    if (give > 0) {
      widths[index]! -= give;
      excess -= give;
    }
  }
  if (excess > 0) {
    // Nothing left to give at word level: every column shrinks in proportion
    // (a long word then breaks by character, as the browser would).
    const total = widths.reduce((a, b) => a + b, 0);
    return widths.map((width) => (width * panelWidth) / total);
  }
  return widths;
};

const wrapCell = (value: string, width: number, size: number, bold = false): readonly string[] =>
  value.length === 0 ? [''] : PdfBuilder.wrap(value, Math.max(width - PAD * 2, 4), size, bold ? 'bold' : 'regular');

const placeRows = (spec: FormSpec, widths: readonly number[], sizes: Sizes, panels: 1 | 2): PlacedRow[] =>
  spec.rows.map((row) => {
    const cells = cellsOf(row, panels);
    const lines: Record<string, readonly string[]> = {};
    let most = 1;
    spec.columns.forEach((column, index) => {
      const wrapped = wrapCell(cells[column.key] ?? '', widths[index]!, sizes.body);
      lines[column.key] = wrapped;
      most = Math.max(most, wrapped.length);
    });
    return { row, lines, height: most * sizes.leading + 0.5 };
  });

const headerHeight = (spec: FormSpec, widths: readonly number[], sizes: Sizes): number => {
  let most = 1;
  spec.columns.forEach((column, index) => {
    most = Math.max(most, wrapCell(column.header, widths[index]!, sizes.body, true).length);
  });
  return most * sizes.leading + 4;
};

/** Splits rows between panels so neither is taller than `limit`; null when impossible. */
const splitRows = (placed: readonly PlacedRow[], panels: 1 | 2, limit: number): PlacedRow[][] | null => {
  if (panels === 1) {
    return placed.reduce((sum, row) => sum + row.height, 0) <= limit ? [[...placed]] : null;
  }
  const total = placed.reduce((sum, row) => sum + row.height, 0);
  // Fill the left panel to about half (never past the limit); the rest goes right.
  let left = 0;
  let index = 0;
  while (index < placed.length && left + placed[index]!.height <= Math.min(limit, Math.ceil(total / 2) + placed[index]!.height / 2)) {
    left += placed[index]!.height;
    index += 1;
  }
  const right = total - left;
  if (left > limit || right > limit) return null;
  return [placed.slice(0, index), placed.slice(index)];
};

interface Plan {
  readonly sizes: Sizes;
  readonly scale: number;
  readonly panels: 1 | 2;
  readonly widths: readonly number[];
  readonly panelWidth: number;
  readonly head: number;
  readonly split: PlacedRow[][];
  readonly fieldsHeight: number;
  readonly notes: readonly string[];
  readonly commentLines: readonly string[];
  readonly commentHeight: number;
  readonly used: number;
}

export const plan = (spec: FormSpec, scale: number, panels: 1 | 2): Plan | null => {
  const sizes = sizesAt(scale);
  const panelWidth = panels === 1 ? WIDTH : (WIDTH - PANEL_GAP) / 2;
  const widths = contentWidths(spec, panelWidth, sizes.body, panels);
  const top = Math.max(sizes.company, sizes.title) + sizes.gap;
  const fieldsHeight = spec.fields.length * sizes.fieldLeading + sizes.gap * 0.6;
  const notes = spec.notes.flatMap((note) => PdfBuilder.wrap(note, WIDTH, sizes.note));
  const notesHeight = notes.length * sizes.note * 1.35 + (notes.length > 0 ? sizes.gap * 0.5 : 0);
  const commentLines = spec.comment === undefined || spec.comment.text.trim().length === 0
    ? []
    : PdfBuilder.wrap(spec.comment.text.trim(), WIDTH - 12, Math.max(sizes.body, MIN_BODY_PT));
  const commentHeight = spec.comment === undefined
    ? 0
    : Math.max(30 * Math.max(scale, 0.7), 14 + commentLines.length * Math.max(sizes.body, MIN_BODY_PT) * 1.35) + sizes.gap * 0.5;
  const totalsHeight = spec.totals === undefined ? 0 : sizes.leading + 6;
  const head = headerHeight(spec, widths, sizes);
  const available = A4_HEIGHT - MARGIN * 2 - FOOTER;
  const fixed = top + fieldsHeight + head + totalsHeight + notesHeight + commentHeight + sizes.gap * 0.5;
  const placed = placeRows(spec, widths, sizes, panels);
  const split = splitRows(placed, panels, available - fixed);
  if (split === null) return null;
  const tallest = Math.max(...split.map((panel) => panel.reduce((sum, row) => sum + row.height, 0)), 0);
  return {
    sizes, scale, panels, widths, panelWidth, head, split, fieldsHeight, notes, commentLines, commentHeight,
    used: fixed + tallest,
  };
};

const choosePlan = (spec: FormSpec): Plan => {
  for (const panels of [1, 2] as const) {
    for (let scale = 1; BASE_BODY * scale >= MIN_BODY_PT - 1e-9; scale = Math.round((scale - 0.02) * 100) / 100) {
      const found = plan(spec, scale, panels);
      if (found !== null) return found;
    }
  }
  throw new OnePageOverflow(spec.rows.length);
};

export const renderOnePageForm = (spec: FormSpec): RenderedForm => {
  const chosen = choosePlan(spec);
  const { sizes, widths, panelWidth } = chosen;
  const pdf = new PdfBuilder();
  pdf.addPage();
  let y = A4_HEIGHT - MARGIN - Math.max(sizes.company, sizes.title) * 0.8;

  // Heading: the company, and the form's title on the right.
  pdf.text(MARGIN, y, spec.companyName, { font: 'bold', size: sizes.company, colour: INK });
  const titleWidth = textWidth(spec.title, sizes.title, 'bold') + TRACK_TITLE * spec.title.length;
  pdf.text(A4_WIDTH - MARGIN - titleWidth, y, spec.title, { font: 'bold', size: sizes.title, colour: INK, tracking: TRACK_TITLE });
  y -= sizes.gap + sizes.field * 0.4;

  // Labelled fields.
  for (const [label, value] of spec.fields) {
    pdf.text(MARGIN, y, label, { size: sizes.field, colour: MUTED });
    pdf.text(MARGIN + 92, y, value, { font: 'bold', size: sizes.field, colour: INK });
    y -= sizes.fieldLeading;
  }
  y -= sizes.gap * 0.6 - sizes.fieldLeading + sizes.leading;

  // The table, in one or two panels.
  const tableTop = y;
  let lowest = y;
  chosen.split.forEach((panelRows, panelIndex) => {
    const left = MARGIN + panelIndex * (panelWidth + PANEL_GAP);
    let cursor = tableTop;
    pdf.rect(left, cursor - chosen.head + sizes.leading - 1, panelWidth, chosen.head, BAND);
    let x = left;
    spec.columns.forEach((column, index) => {
      const lines = wrapCell(column.header, widths[index]!, sizes.body, true);
      lines.forEach((line, lineIndex) => {
        const at = column.align === 'right' ? x + widths[index]! - PAD - textWidth(line, sizes.body, 'bold') : x + PAD;
        pdf.text(at, cursor - lineIndex * sizes.leading, line, { font: 'bold', size: sizes.body, colour: INK });
      });
      x += widths[index]!;
    });
    cursor -= chosen.head;
    pdf.line(left, cursor + sizes.leading - 1, left + panelWidth, cursor + sizes.leading - 1, 0.6, RULE);
    for (const placed of panelRows) {
      if (placed.row.groupStart === true) {
        pdf.line(left, cursor + sizes.leading - 0.5, left + panelWidth, cursor + sizes.leading - 0.5, 0.4, RULE);
      }
      let cellX = left;
      spec.columns.forEach((column, index) => {
        (placed.lines[column.key] ?? []).forEach((line, lineIndex) => {
          if (line.length === 0) return;
          const at = column.align === 'right' ? cellX + widths[index]! - PAD - textWidth(line, sizes.body) : cellX + PAD;
          pdf.text(at, cursor - lineIndex * sizes.leading, line, { size: sizes.body, colour: placed.row.muted === true ? MUTED : BODY });
        });
        cellX += widths[index]!;
      });
      cursor -= placed.height;
      pdf.line(left, cursor + sizes.leading, left + panelWidth, cursor + sizes.leading, 0.3, RULE_SOFT);
    }
    lowest = Math.min(lowest, cursor);
  });
  y = lowest;

  // Totals, under the table, full width (the left panel's geometry).
  if (spec.totals !== undefined) {
    const totalsWidths = chosen.panels === 1 ? widths : contentWidths(spec, WIDTH, sizes.body, 1);
    pdf.line(MARGIN, y + sizes.leading - 1, A4_WIDTH - MARGIN, y + sizes.leading - 1, 0.8, RULE);
    y -= 3;
    let x = MARGIN;
    const labelColumn = spec.columns.findIndex((column) => column.align === 'left' && (spec.totals!.cells[column.key] ?? '') === '');
    spec.columns.forEach((column, index) => {
      const value = index === labelColumn ? spec.totals!.label : spec.totals!.cells[column.key] ?? '';
      if (value.length > 0) {
        const at = column.align === 'right' ? x + totalsWidths[index]! - PAD - textWidth(value, sizes.body, 'bold') : x + PAD;
        pdf.text(at, y, value, { font: 'bold', size: sizes.body, colour: INK });
      }
      x += totalsWidths[index]!;
    });
    y -= sizes.leading + 3;
  }

  // Notes.
  if (chosen.notes.length > 0) {
    y -= sizes.gap * 0.3;
    for (const line of chosen.notes) {
      pdf.text(MARGIN, y, line, { size: sizes.note, colour: MUTED });
      y -= sizes.note * 1.35;
    }
  }

  let lowestBaseline = y + sizes.leading;
  // The comments box.
  if (spec.comment !== undefined) {
    y -= sizes.gap * 0.3;
    const height = chosen.commentHeight - sizes.gap * 0.5;
    const top = y + sizes.leading;
    pdf.line(MARGIN, top, A4_WIDTH - MARGIN, top, 0.8, RULE);
    pdf.line(MARGIN, top - height, A4_WIDTH - MARGIN, top - height, 0.8, RULE);
    pdf.line(MARGIN, top, MARGIN, top - height, 0.8, RULE);
    pdf.line(A4_WIDTH - MARGIN, top, A4_WIDTH - MARGIN, top - height, 0.8, RULE);
    const size = Math.max(sizes.body, MIN_BODY_PT);
    let line = top - 10;
    pdf.text(MARGIN + 6, line, spec.comment.title, { font: 'bold', size: Math.max(size * 0.95, MIN_BODY_PT), colour: MUTED });
    line -= size * 1.5;
    for (const text of chosen.commentLines) {
      pdf.text(MARGIN + 6, line, text, { size, colour: BODY });
      line -= size * 1.35;
    }
    lowestBaseline = Math.min(line + size * 1.35, top - height);
  }
  const footerTop = MARGIN + FOOTER - 6;
  if (lowestBaseline < footerTop) {
    // A planning defect, never a data problem: refuse rather than print over the footer.
    throw new Error('one-page layout overran the page (' + lowestBaseline.toFixed(1) + ' < ' + footerTop + ')');
  }

  // The footer.
  const footerSize = 6.5;
  const footer = PdfBuilder.wrap(spec.footer, WIDTH - 50, footerSize)[0] ?? '';
  pdf.text(MARGIN, MARGIN - 10, footer, { size: footerSize, colour: MUTED });
  pdf.text(A4_WIDTH - MARGIN - textWidth('Page 1 of 1', footerSize), MARGIN - 10, 'Page 1 of 1', { size: footerSize, colour: MUTED });

  return {
    bytes: pdf.toBytes(),
    pageCount: pdf.pageCount,
    layout: {
      scale: chosen.scale,
      panels: chosen.panels,
      bodyPt: Math.round(sizes.body * 100) / 100,
      spare: Math.round((A4_HEIGHT - MARGIN * 2 - FOOTER - chosen.used) * 10) / 10,
      lowestBaseline: Math.round(lowestBaseline * 10) / 10,
      footerTop,
    },
  };
};
