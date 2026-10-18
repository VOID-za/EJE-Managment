import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_INDEXED_CHARACTERS, extractPdfText } from './extract-text';
import { loadJobView } from '@/application/job-view';
import { buildHarness, seedUser } from '@/application/test-harness';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SystemClock } from '@/services/simulated/system';

/**
 * READING THE TEXT OUT OF A PDF. MASTER SCOPE LIB-5.
 *
 * The cases are the ones a technical library actually receives: a PDF produced
 * by a writer (text, uncompressed), one produced by every normal tool (text,
 * Flate-compressed), a manual that was scanned (a picture of a page, with no
 * text in it at all), one whose fonts carry no usable encoding, an encrypted
 * one, and a file that is not a PDF.
 *
 * WHAT MATTERS MOST HERE IS THE HONESTY OF THE ANSWER. A scanned manual must
 * come back as `needs_ocr` and NOT as an indexed document with no words in it,
 * because the second one tells a technician the library has been searched when
 * it has not.
 */
const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'latin1'));

/** A PDF with one page whose content stream is given as-is. */
const onePage = (content: Buffer, { filter = '', extra = '' } = {}): Uint8Array => {
  const header = '%PDF-1.4\n';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R ${extra}>>\nendobj\n`,
    `4 0 obj\n<< /Length ${content.length} ${filter}>>\nstream\n${content.toString('latin1')}\nendstream\nendobj\n`,
  ].join('');
  return bytes(`${header}${objects}trailer\n<< /Root 1 0 R >>\n%%EOF\n`);
};

const page = (text: string): Buffer =>
  Buffer.from(`BT /F1 11 Tf 40 800 Td (${text}) Tj ET\n`, 'latin1');

describe('a PDF this system wrote', () => {
  it('reads back as the words that are on the page', async () => {
    const harness = buildHarness();
    const view = await loadJobView(harness.repos, 'EJE-1044', seedUser('user-master-elmarie'));
    if (view === null) throw new Error('EJE-1044 is not seeded');

    const clock = new SystemClock();
    const rendered = await new SimulatedPdfService(clock).render(view, 'final', clock.now());
    const outcome = extractPdfText(rendered.bytes);

    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;
    expect(outcome.pages).toBe(2);
    expect(outcome.text).toContain('JOB CARD');
    expect(outcome.text).toContain('EJE-1044');
    // The escaped brackets a plain byte search would miss.
    expect(outcome.text).toContain('ABC Engineering (Pty) Ltd');
    expect(outcome.unreadableStreams).toBe(0);
  });
});

describe('a PDF produced the way every other tool produces one', () => {
  it('is decompressed and read', () => {
    const outcome = extractPdfText(
      onePage(deflateSync(page('Spindle drive fault codes and the megger test')), {
        filter: '/Filter /FlateDecode ',
      }),
    );
    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;
    expect(outcome.text).toContain('megger test');
  });

  it('reads a hex string as its characters', () => {
    const content = Buffer.from('BT /F1 11 Tf 40 800 Td <48656c6c6f20486f697374> Tj ET\n', 'latin1');
    const outcome = extractPdfText(onePage(content));
    expect(outcome.kind).toBe('needs_ocr');
    // Too short to be a document's text — but what WAS read is the right text,
    // which the next case proves on a page with enough of it.
    const long = extractPdfText(
      onePage(
        Buffer.from(
          `BT /F1 11 Tf 40 800 Td <48656c6c6f20486f697374> Tj ET ${'BT (padding for length) Tj ET '.repeat(4)}`,
          'latin1',
        ),
      ),
    );
    expect(long.kind).toBe('text');
    if (long.kind !== 'text') return;
    expect(long.text).toContain('Hello Hoist');
  });

  it('keeps the words apart where the page moved the cursor', () => {
    const content = Buffer.from(
      'BT /F1 11 Tf 40 800 Td (Hydraulic power pack) Tj 0 -14 Td (Pressure relief valve) Tj ET\n',
      'latin1',
    );
    const outcome = extractPdfText(onePage(content));
    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;
    expect(outcome.text).toContain('Hydraulic power pack');
    expect(outcome.text).toContain('Pressure relief valve');
    expect(outcome.text).not.toContain('packPressure');
  });
});

describe('a scanned manual', () => {
  /*
   * THE CASE LIB-5 NAMES EXPLICITLY. There is no text in the file: the page is
   * one image. The answer has to be "not searchable yet, and here is why",
   * because an empty index that calls itself complete is worse than no index.
   */
  it('is reported as needing OCR, with a reason, and never as indexed', () => {
    const image = Buffer.from(`BI /W 1200 /H 1600 /CS /G ID ${'ÿ'.repeat(400)} EI\n`, 'latin1');
    const outcome = extractPdfText(onePage(image, { extra: '/XObject << /Im1 5 0 R >> ' }));
    expect(outcome.kind).toBe('needs_ocr');
    if (outcome.kind !== 'needs_ocr') return;
    expect(outcome.reason).toMatch(/OCR/);
    expect(outcome.pages).toBe(1);
  });

  it('is reported as needing OCR when the fonts carry no readable encoding', () => {
    // What a subset font with a custom encoding and no `/ToUnicode` produces:
    // glyph ids, not characters.
    const glyphs = Array.from({ length: 300 }, (_unused, index) =>
      String.fromCharCode(1 + (index % 25)),
    ).join('');
    const content = Buffer.from(`BT /F1 11 Tf 40 800 Td (${glyphs}) Tj ET\n`, 'latin1');
    const outcome = extractPdfText(onePage(content));
    expect(outcome.kind).toBe('needs_ocr');
    if (outcome.kind !== 'needs_ocr') return;
    expect(outcome.reason).toMatch(/readable/);
  });
});

describe('a file that cannot be read at all', () => {
  it('is refused when it is not a PDF', () => {
    const outcome = extractPdfText(bytes('PK\u0003\u0004 this is a zip'));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toMatch(/PDF header/);
  });

  it('is refused when it is empty', () => {
    expect(extractPdfText(new Uint8Array()).kind).toBe('failed');
  });

  it('is refused when it is encrypted, rather than indexed as nothing', () => {
    const encrypted = bytes(
      '%PDF-1.6\n1 0 obj\n<< /Encrypt 9 0 R /Type /Page >>\nendobj\ntrailer\n%%EOF\n',
    );
    const outcome = extractPdfText(encrypted);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toMatch(/encrypted/);
  });
});

describe('what could not be read is counted, never swallowed', () => {
  it('counts a stream that claims compression and is corrupt', () => {
    const broken = Buffer.from('not actually deflate data at all', 'latin1');
    const good = deflateSync(page('The readable half of the document, with plenty of words in it'));
    const file = bytes(
      `%PDF-1.4\n` +
        `1 0 obj\n<< /Type /Page >>\nendobj\n` +
        `2 0 obj\n<< /Length ${good.length} /Filter /FlateDecode >>\nstream\n${good.toString('latin1')}\nendstream\nendobj\n` +
        `3 0 obj\n<< /Length ${broken.length} /Filter /FlateDecode >>\nstream\n${broken.toString('latin1')}\nendstream\nendobj\n` +
        `trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    );

    const outcome = extractPdfText(file);
    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;
    expect(outcome.text).toContain('readable half');
    expect(outcome.unreadableStreams).toBe(1);
  });
});

describe('a very large document', () => {
  it('is cut at the index limit and says so', () => {
    const line = 'Lubrication schedule for the main spindle bearing assembly. ';
    const content = Buffer.from(
      `BT /F1 11 Tf 40 800 Td (${line.repeat(Math.ceil(MAX_INDEXED_CHARACTERS / line.length) + 200)}) Tj ET\n`,
      'latin1',
    );
    const outcome = extractPdfText(onePage(content));
    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;
    expect(outcome.truncated).toBe(true);
    expect(outcome.text).toHaveLength(MAX_INDEXED_CHARACTERS);
  });
});
