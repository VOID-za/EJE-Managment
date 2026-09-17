/**
 * A minimal PDF writer.
 *
 * First-party for the same reason the design system, icon set and formatting
 * helpers are: the alternative is a dependency to carry for one job, and the
 * subset of PDF needed to issue a job card — pages, Helvetica text, rules and
 * the signature's own path geometry — is small and stable.
 *
 * Pure: no DOM, no Node APIs, no I/O. It takes drawing instructions and returns
 * bytes, so it is equally usable from the browser today and from the Phase 2
 * server-side renderer.
 *
 * Deliberately NOT a layout engine. Callers position content in PDF user space
 * (points, origin bottom-left) because the job card is a fixed form, and a
 * general layout engine would be far more code than the document needs.
 */

/** A4 in PostScript points, the page size every EJE document uses. */
export const A4_WIDTH = 595.28;
export const A4_HEIGHT = 841.89;

export type PdfFont = 'regular' | 'bold' | 'italic';

const FONT_RESOURCE: Record<PdfFont, string> = {
  regular: 'F1',
  bold: 'F2',
  italic: 'F3',
};

const FONT_BASE: Record<PdfFont, string> = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
};

/**
 * Approximate Helvetica advance widths, in 1/1000 em.
 *
 * Enough to wrap text and right-align a currency column without embedding a
 * font metrics table. Overestimating slightly is the safe direction: a line
 * breaks a word early rather than running into the margin.
 */
const AVERAGE_WIDTH = 520;
const NARROW = new Set(' iljtfrI.,:;\'`|!/()[]-'.split(''));
const WIDE = new Set('mwMW@%'.split(''));

export const textWidth = (text: string, size: number, font: PdfFont = 'regular'): number => {
  let thousandths = 0;
  for (const character of text) {
    if (NARROW.has(character)) thousandths += 290;
    else if (WIDE.has(character)) thousandths += 830;
    else if (character >= 'A' && character <= 'Z') thousandths += 680;
    else thousandths += AVERAGE_WIDTH;
  }
  // Bold Helvetica is a little wider than regular at the same size.
  const weight = font === 'bold' ? 1.06 : 1;
  return (thousandths / 1000) * size * weight;
};

/**
 * Characters outside the printable ASCII range, mapped into WinAnsiEncoding.
 *
 * Everything the application can actually put on a job card: the South African
 * rand sign, the separators used in headings, degree and quote marks. Anything
 * unmapped degrades to a plain ASCII stand-in rather than emitting a byte the
 * viewer would render as a different glyph.
 */
const WIN_ANSI: Record<string, number> = {
  ' ': 32, // non-breaking space — the currency formatter uses these
  ' ': 32,
  ' ': 32,
  '·': 0xb7,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '°': 0xb0,
  '±': 0xb1,
  '×': 0xd7,
  '€': 0x80,
  '£': 0xa3,
  '©': 0xa9,
  '®': 0xae,
  '…': 0x85,
};

const ASCII_FALLBACK: Record<string, string> = {
  '→': '->',
  '≤': '<=',
  '≥': '>=',
  '⁄': '/',
};

/** WinAnsi bytes for a string, so `/Length` in bytes equals the string length. */
const toWinAnsi = (text: string): string => {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 63;
    if (code >= 32 && code <= 126) {
      out += character;
      continue;
    }
    const mapped = WIN_ANSI[character];
    if (mapped !== undefined) {
      out += String.fromCharCode(mapped);
      continue;
    }
    const fallback = ASCII_FALLBACK[character];
    if (fallback !== undefined) {
      out += fallback;
      continue;
    }
    // Latin-1 passes through; anything else becomes a question mark, which is
    // visible and honest rather than a silently wrong glyph.
    out += code >= 160 && code <= 255 ? String.fromCharCode(code) : '?';
  }
  return out;
};

/** Escapes a WinAnsi string for a PDF literal string. */
const escapeLiteral = (text: string): string =>
  toWinAnsi(text).replace(/[\\()]/g, (character) => `\\${character}`);

const round = (value: number): string => {
  const fixed = value.toFixed(3);
  return fixed.replace(/\.?0+$/, '') || '0';
};

export interface TextOptions {
  readonly font?: PdfFont;
  readonly size?: number;
  /** 0..1 grey, or a hex colour. Defaults to black. */
  readonly colour?: string;
}

const colourOperands = (colour: string | undefined): string => {
  if (colour === undefined) return '0 0 0';
  const hex = colour.replace('#', '');
  if (hex.length !== 6) return '0 0 0';
  const channel = (offset: number): string =>
    round(Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return `${channel(0)} ${channel(2)} ${channel(4)}`;
};

class PdfPage {
  readonly operations: string[] = [];
}

export class PdfBuilder {
  private readonly pages: PdfPage[] = [];
  private current: PdfPage | null = null;
  private readonly usedFonts = new Set<PdfFont>();

  addPage(): void {
    const page = new PdfPage();
    this.pages.push(page);
    this.current = page;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /**
   * Makes an already-added page current again.
   *
   * Needed for footers: "page 2 of 4" cannot be written until the content has
   * decided how many pages there are, so footers are drawn in a pass after the
   * body rather than the body being laid out twice.
   */
  selectPage(index: number): void {
    const page = this.pages[index];
    if (page === undefined) throw new Error(`No page at index ${index}`);
    this.current = page;
  }

  private page(): PdfPage {
    if (this.current === null) this.addPage();
    // Non-null: addPage always assigns.
    return this.current!;
  }

  /** Draws text with its baseline at (x, y), y measured from the page bottom. */
  text(x: number, y: number, value: string, options: TextOptions = {}): void {
    const font = options.font ?? 'regular';
    const size = options.size ?? 10;
    this.usedFonts.add(font);
    this.page().operations.push(
      `BT ${colourOperands(options.colour)} rg /${FONT_RESOURCE[font]} ${round(size)} Tf ` +
        `1 0 0 1 ${round(x)} ${round(y)} Tm (${escapeLiteral(value)}) Tj ET`,
    );
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.6, colour?: string): void {
    this.page().operations.push(
      `${colourOperands(colour)} RG ${round(width)} w ` +
        `${round(x1)} ${round(y1)} m ${round(x2)} ${round(y2)} l S`,
    );
  }

  rect(x: number, y: number, width: number, height: number, colour: string): void {
    this.page().operations.push(
      `${colourOperands(colour)} rg ${round(x)} ${round(y)} ${round(width)} ${round(height)} re f`,
    );
  }

  /**
   * Draws an SVG-style path of `M x,y L x,y` commands whose coordinates are
   * normalised 0..1, scaled into the given box.
   *
   * This is how a captured signature reaches the PDF: the same normalised
   * geometry `strokesToPath` produced when the customer signed, so the mark on
   * the document is the mark they made — not a picture of a name.
   */
  normalisedPath(
    path: string,
    box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
    options: { readonly width?: number; readonly colour?: string } = {},
  ): void {
    const commands = path.match(/[ML]\s*-?[\d.]+\s*,\s*-?[\d.]+/g);
    if (commands === null || commands.length === 0) return;

    const segments: string[] = [];
    for (const command of commands) {
      const kind = command[0] === 'M' ? 'm' : 'l';
      const [rawX, rawY] = command.slice(1).split(',');
      const nx = Number.parseFloat(rawX ?? '');
      const ny = Number.parseFloat(rawY ?? '');
      if (Number.isNaN(nx) || Number.isNaN(ny)) continue;
      // PDF's origin is bottom-left; the normalised geometry is top-left.
      const x = box.x + nx * box.width;
      const y = box.y + box.height - ny * box.height;
      segments.push(`${round(x)} ${round(y)} ${kind}`);
    }
    if (segments.length === 0) return;

    this.page().operations.push(
      `${colourOperands(options.colour)} RG ${round(options.width ?? 1.6)} w 1 J 1 j ` +
        `${segments.join(' ')} S`,
    );
  }

  /** Greedy word wrap at `maxWidth`, returning the lines to draw. */
  static wrap(text: string, maxWidth: number, size: number, font: PdfFont = 'regular'): string[] {
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      let line = '';
      for (const word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
        const candidate = line.length === 0 ? word : `${line} ${word}`;
        if (textWidth(candidate, size, font) <= maxWidth) {
          line = candidate;
        } else {
          if (line.length > 0) lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    // A trailing empty paragraph adds nothing to a document.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Assembles the PDF. Byte offsets in the cross-reference table are exact. */
  toBytes(): Uint8Array {
    if (this.pages.length === 0) this.addPage();

    const fonts: PdfFont[] = ['regular', 'bold', 'italic'].filter((font) =>
      this.usedFonts.has(font as PdfFont),
    ) as PdfFont[];
    // A page with no text still needs a font resource dictionary to be valid.
    if (fonts.length === 0) fonts.push('regular');

    const firstPageObject = 3;
    const contentBase = firstPageObject + this.pages.length;
    const fontBase = contentBase + this.pages.length;
    const totalObjects = fontBase + fonts.length - 1;

    const fontResources = fonts
      .map((font, index) => `/${FONT_RESOURCE[font]} ${fontBase + index} 0 R`)
      .join(' ');

    const objects: string[] = [];
    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
    objects.push(
      `<< /Type /Pages /Kids [${this.pages
        .map((_, index) => `${firstPageObject + index} 0 R`)
        .join(' ')}] /Count ${this.pages.length} >>`,
    );
    this.pages.forEach((_, index) => {
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(A4_WIDTH)} ${round(A4_HEIGHT)}] ` +
          `/Resources << /Font << ${fontResources} >> >> /Contents ${contentBase + index} 0 R >>`,
      );
    });
    this.pages.forEach((page) => {
      const stream = page.operations.join('\n');
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    });
    fonts.forEach((font) => {
      objects.push(
        `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_BASE[font]} /Encoding /WinAnsiEncoding >>`,
      );
    });

    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((object, index) => {
      offsets.push(body.length);
      body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });

    const xrefOffset = body.length;
    let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    const trailer =
      `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`;

    const file = body + xref + trailer;
    // Latin-1: every character is one byte, which is what makes the offsets
    // above correct.
    const bytes = new Uint8Array(file.length);
    for (let index = 0; index < file.length; index += 1) {
      bytes[index] = file.charCodeAt(index) & 0xff;
    }
    return bytes;
  }
}
