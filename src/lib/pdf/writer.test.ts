import { describe, expect, it } from 'vitest';
import { A4_HEIGHT, A4_WIDTH, PdfBuilder, textWidth } from './writer';

/**
 * The PDF writer.
 *
 * A job card that downloads but will not open is worse than no download at
 * all, so these assert the structure a viewer actually requires: the header,
 * one indirect object per page, a cross-reference table whose offsets point at
 * the objects they claim to, and a trailer.
 */

const decode = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

describe('a written PDF', () => {
  it('starts with the PDF header and ends with the EOF marker', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.text(40, 800, 'EJE-1065');
    const text = decode(pdf.toBytes());

    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('declares a catalogue, a page tree and an A4 page box', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.text(40, 800, 'x');
    const text = decode(pdf.toBytes());

    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Type /Pages');
    expect(text).toContain('/Type /Page ');
    expect(text).toContain(`/MediaBox [0 0 ${A4_WIDTH.toFixed(2)} ${A4_HEIGHT.toFixed(2)}]`);
  });

  it('points every cross-reference offset at the object it claims', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.text(40, 800, 'Final job card');
    pdf.addPage();
    pdf.text(40, 800, 'Page two', { font: 'bold' });
    const text = decode(pdf.toBytes());

    const startxref = /startxref\n(\d+)\n/.exec(text);
    expect(startxref).not.toBeNull();
    expect(text.slice(Number(startxref![1]))).toMatch(/^xref\n/);

    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(offsets.length).toBeGreaterThan(4);
    offsets.forEach((offset, index) => {
      // Object numbering starts at 1 and the free entry is not listed here.
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj\\n`));
    });
  });

  it('declares a content stream length in bytes that matches the stream', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.text(40, 800, 'Rand values like R 1 900,00 must not break the length');
    const text = decode(pdf.toBytes());

    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text);
    expect(match).not.toBeNull();
    expect(match![2]!.length).toBe(Number(match![1]));
  });

  it('counts the pages it was given', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.addPage();
    pdf.addPage();
    expect(pdf.pageCount).toBe(3);
    expect(decode(pdf.toBytes())).toContain('/Count 3');
  });

  it('escapes brackets and backslashes, which would otherwise end the string', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.text(40, 800, 'ABC Engineering (Pty) Ltd \\ Site');
    const text = decode(pdf.toBytes());
    expect(text).toContain('(ABC Engineering \\(Pty\\) Ltd \\\\ Site)');
  });

  it('maps the characters the application really emits into WinAnsi', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    // The currency formatter uses non-breaking spaces; headings use middots
    // and em dashes. Each must be one byte, or every later offset is wrong.
    pdf.text(40, 800, 'R 1 900,00 · Johannesburg — 10°C');
    const bytes = pdf.toBytes();
    const text = decode(bytes);

    const match = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/.exec(text);
    expect(match![2]!.length).toBe(Number(match![1]));
    expect(text).toContain('R 1 900,00 \xb7 Johannesburg \x97 10\xb0C');
  });

  it('never emits a multi-byte character, so byte offsets stay exact', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.text(40, 800, 'unmapped: 中文 → done');
    const bytes = pdf.toBytes();
    expect(bytes.every((byte) => byte <= 0xff)).toBe(true);
    const text = decode(bytes);
    // Unmapped glyphs are visibly substituted rather than silently wrong.
    expect(text).toContain('unmapped: ?? -> done');
  });

  it('draws a normalised signature path into the box it is given', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.normalisedPath('M0,0 L1,1', { x: 100, y: 200, width: 200, height: 50 }, {
      colour: '#000000',
    });
    const text = decode(pdf.toBytes());

    // Top-left normalised (0,0) becomes the top of the box in PDF space.
    expect(text).toContain('100 250 m');
    expect(text).toContain('300 200 l');
    expect(text).toContain('0 0 0 RG');
  });

  it('ignores signature data that carries no path, rather than emitting rubbish', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.text(40, 800, 'x');
    pdf.normalisedPath('demo-signature-anita-ferreira', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    const text = decode(pdf.toBytes());
    expect(text).not.toContain(' m ');
  });

  it('only declares the fonts it used', () => {
    const regularOnly = new PdfBuilder();
    regularOnly.addPage();
    regularOnly.text(40, 800, 'plain');
    expect(decode(regularOnly.toBytes())).not.toContain('Helvetica-Bold');

    const withBold = new PdfBuilder();
    withBold.addPage();
    withBold.text(40, 800, 'heading', { font: 'bold' });
    expect(decode(withBold.toBytes())).toContain('Helvetica-Bold');
  });

  it('can return to an earlier page, so footers can be drawn last', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    pdf.addPage();
    pdf.text(40, 800, 'body of page two');
    pdf.selectPage(0);
    pdf.text(40, 30, 'page 1 of 2');
    const text = decode(pdf.toBytes());

    const streams = [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1]);
    expect(streams).toHaveLength(2);
    expect(streams[0]).toContain('page 1 of 2');
    expect(streams[0]).not.toContain('body of page two');
    expect(streams[1]).toContain('body of page two');
  });

  it('refuses a page index that does not exist', () => {
    const pdf = new PdfBuilder();
    pdf.addPage();
    expect(() => pdf.selectPage(3)).toThrow('No page at index 3');
  });

  it('produces a valid file even with nothing drawn on it', () => {
    const text = decode(new PdfBuilder().toBytes());
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('/Count 1');
    expect(text).toContain('/Font');
  });
});

describe('text measurement and wrapping', () => {
  it('grows with the string and with the point size', () => {
    expect(textWidth('mm', 10)).toBeGreaterThan(textWidth('ii', 10));
    expect(textWidth('EJE', 20)).toBeGreaterThan(textWidth('EJE', 10));
  });

  it('wraps to lines that fit the width it was given', () => {
    const paragraph =
      'Replaced the spindle drive cooling fan and retested the machine under load ' +
      'before handing it back to the customer.';
    const lines = PdfBuilder.wrap(paragraph, 200, 9);

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(textWidth(line, 9)).toBeLessThanOrEqual(200);
    }
    expect(lines.join(' ')).toBe(paragraph);
  });

  it('keeps deliberate line breaks', () => {
    expect(PdfBuilder.wrap('one\ntwo', 400, 10)).toEqual(['one', 'two']);
  });

  it('does not lose a word longer than the line', () => {
    const lines = PdfBuilder.wrap('LW-V40-70214-EXTREMELY-LONG-SERIAL', 20, 9);
    expect(lines.join('')).toContain('LW-V40-70214');
  });
});
