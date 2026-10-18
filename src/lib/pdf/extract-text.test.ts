import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_INDEXED_CHARACTERS, MAX_PDF_BYTES, MAX_STREAM_BYTES, extractPdfText } from './extract-text';
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

/* -------------------------------------------------------------------------- */
/* Structures and limits — the ingestion-robustness pass                      */
/* -------------------------------------------------------------------------- */

/**
 * A PDF 1.5 file with a CROSS-REFERENCE STREAM and an OBJECT STREAM.
 *
 * This is what "compressed PDF structure" actually means, and it is the shape
 * the extractor used to blame for finding no text. The catalogue, the page tree
 * and the page object are packed into an `/ObjStm`; the page's CONTENT stream
 * is a top-level Flate stream, because the specification forbids putting a
 * stream object inside an object stream. So the text IS reachable, and this
 * fixture is what proves the old message wrong.
 */
const objectStreamPdf = (text: string): Uint8Array => {
  const packed = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /MediaBox [0 0 595 842] >>',
  ];
  // The object stream's own header: pairs of object number and offset.
  let offsets = '';
  let payload = '';
  for (const [index, object] of packed.entries()) {
    offsets += `${index + 1} ${payload.length} `;
    payload += `${object} `;
  }
  const inner = Buffer.from(`${offsets}${payload}`, 'latin1');
  const objStm = deflateSync(inner);
  const content = deflateSync(Buffer.from(`BT /F1 11 Tf 40 800 Td (${text}) Tj ET\n`, 'latin1'));
  const xref = deflateSync(Buffer.from('', 'latin1'));

  const body =
    `5 0 obj\n<< /Type /ObjStm /N ${packed.length} /First ${offsets.length} /Length ${objStm.length} /Filter /FlateDecode >>\nstream\n${objStm.toString('latin1')}\nendstream\nendobj\n` +
    `4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content.toString('latin1')}\nendstream\nendobj\n` +
    `6 0 obj\n<< /Type /XRef /Size 7 /W [1 2 1] /Root 1 0 R /Length ${xref.length} /Filter /FlateDecode >>\nstream\n${xref.toString('latin1')}\nendstream\nendobj\n`;
  return bytes(`%PDF-1.5\n${body}startxref\n9\n%%EOF\n`);
};

describe('a PDF that packs its objects into an object stream', () => {
  it('is read, because a CONTENT stream is never inside one', () => {
    const outcome = extractPdfText(
      objectStreamPdf('Hydraulic schematic: the pilot valve is fed from port P2 at 40 bar.'),
    );
    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;
    expect(outcome.text).toContain('pilot valve');
    expect(outcome.pages).toBe(1);
  });

  it('is not blamed for a scan: the reason names the pages, not the structure', () => {
    // A real page with no text operators anywhere — a scan.
    const image = Buffer.from(`BI /W 1200 /H 1600 ID ${'\u00fe'.repeat(500)} EI\n`, 'latin1');
    const outcome = extractPdfText(onePage(image));
    expect(outcome.kind).toBe('needs_ocr');
    if (outcome.kind !== 'needs_ocr') return;
    expect(outcome.reason).toMatch(/images/);
    expect(outcome.reason).not.toMatch(/object stream/i);
  });
});

describe('a file that is hostile rather than merely awkward', () => {
  /*
   * A DECOMPRESSION BOMB: 32 MB of zeroes compress to a few kilobytes, and an
   * unbounded `inflateSync` would hand all 32 MB back — repeat it a hundred
   * times in one file and the server is the target. `maxOutputLength` makes
   * zlib throw instead, and the stream is COUNTED as unreadable like any
   * other, so the document still reports what it is.
   */
  it('refuses to inflate a bomb, counts it, and keeps reading the rest', () => {
    const bomb = deflateSync(Buffer.alloc(MAX_STREAM_BYTES * 2, 0));
    expect(bomb.length).toBeLessThan(100_000);
    const good = deflateSync(page('The readable half of this document, with plenty of words in it'));

    const file = bytes(
      '%PDF-1.4\n' +
        '1 0 obj\n<< /Type /Page >>\nendobj\n' +
        `2 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n${bomb.toString('latin1')}\nendstream\nendobj\n` +
        `3 0 obj\n<< /Length ${good.length} /Filter /FlateDecode >>\nstream\n${good.toString('latin1')}\nendstream\nendobj\n` +
        'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    );

    const outcome = extractPdfText(file);
    expect(outcome.kind).toBe('text');
    if (outcome.kind !== 'text') return;
    expect(outcome.text).toContain('readable half');
    expect(outcome.unreadableStreams).toBe(1);
  });

  it('refuses a file larger than it will read, and says the size', () => {
    const huge = new Uint8Array(MAX_PDF_BYTES + 1024);
    huge.set(new TextEncoder().encode('%PDF-1.4\n'));
    const outcome = extractPdfText(huge);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toMatch(/MB/);
    expect(outcome.reason).toMatch(/stored and downloadable/);
  });

  it('refuses a page count that is a claim rather than a document', () => {
    const outcome = extractPdfText(bytes(`%PDF-1.4\n${'/Type /Page \n'.repeat(20_001)}%%EOF\n`));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toMatch(/pages/);
  });
});

describe('a corrupt file is told apart from a scanned one', () => {
  it('reports a header with nothing behind it as truncated, not as needing OCR', () => {
    const outcome = extractPdfText(bytes('%PDF-1.7\n%%EOF\n'));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toMatch(/truncated or corrupt/);
    expect(outcome.reason).toMatch(/upload the document again/i);
  });

  it('still reports a real page with no text as needing OCR', () => {
    const image = Buffer.from(`BI /W 900 /H 1200 ID ${'\u00fd'.repeat(400)} EI\n`, 'latin1');
    const outcome = extractPdfText(onePage(image));
    expect(outcome.kind).toBe('needs_ocr');
  });
});
