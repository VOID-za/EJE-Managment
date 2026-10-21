import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  PHOTO_CONTENT_TYPES,
  safeFileName,
  sniffContentType,
  validatePhotoUpload,
  validateUpload,
} from './uploads';
import { ApiError } from './errors';

/**
 * THE MODULE THAT DECIDES WHAT THE SERVER WILL ACCEPT, TESTED DIRECTLY.
 *
 * It had no test of its own. Three route tests exercised it in passing, which
 * covers the happy path of each and none of the cases this file is about —
 * and this is the one file in the upload path where a mistake is a security
 * mistake rather than a bug. What it decides:
 *
 *   - what a file IS, from its bytes, never from what the browser said;
 *   - what a file may be CALLED, in a row and in a response header;
 *   - how large it may be.
 *
 * Every case below is something a request can actually contain.
 */

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const TIFF_LE = bytes(0x49, 0x49, 0x2a, 0x00, 0x08, 0x00);
const TIFF_BE = bytes(0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x08);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
const ELF = bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01);

/** The violation codes, which is what a client branches on. */
const codesOf = (work: () => unknown): readonly string[] => {
  try {
    work();
  } catch (error) {
    if (error instanceof ApiError) return error.violations.map((violation) => violation.code);
    throw error;
  }
  throw new Error('that upload was expected to be refused, and was not');
};

describe('what the bytes actually are', () => {
  it('recognises each format EJE accept', () => {
    expect(sniffContentType(PDF)?.contentType).toBe('application/pdf');
    expect(sniffContentType(PNG)?.contentType).toBe('image/png');
    expect(sniffContentType(JPEG)?.contentType).toBe('image/jpeg');
    expect(sniffContentType(TIFF_LE)?.contentType).toBe('image/tiff');
    expect(sniffContentType(TIFF_BE)?.contentType).toBe('image/tiff');
    expect(sniffContentType(WEBP)?.contentType).toBe('image/webp');
  });

  it('recognises nothing else, however plausible', () => {
    expect(sniffContentType(ZIP)).toBeNull();
    expect(sniffContentType(ELF)).toBeNull();
    expect(sniffContentType(new TextEncoder().encode('order number 4471'))).toBeNull();
    expect(sniffContentType(bytes())).toBeNull();
  });

  it('is not fooled by a signature that starts one byte late', () => {
    // A real file's magic is at offset 0. A byte in front of it is a different
    // file that happens to contain those bytes.
    expect(sniffContentType(bytes(0x00, 0x25, 0x50, 0x44, 0x46, 0x2d))).toBeNull();
  });

  it('needs the whole WEBP header, not just RIFF', () => {
    // RIFF is also WAV and AVI. The second half of the check is what makes it
    // a WebP rather than anything else in a RIFF container.
    expect(
      sniffContentType(bytes(0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x41, 0x56, 0x45)),
    ).toBeNull();
  });
});

describe('what the browser said about the file', () => {
  it('is ignored: a PDF name and a PDF content type on a ZIP is refused', () => {
    expect(
      codesOf(() =>
        validateUpload({
          fileName: 'customer-order.pdf',
          declaredContentType: 'application/pdf',
          bytes: ZIP,
        }),
      ),
    ).toEqual(['unsupported_file_type']);
  });

  it('is ignored the other way too: a .txt name on a real PDF is accepted as a PDF', () => {
    const file = validateUpload({
      fileName: 'order.txt',
      declaredContentType: 'text/plain',
      bytes: PDF,
    });
    // The STORED type is the server's finding, which is what later gets served.
    expect(file.contentType).toBe('application/pdf');
  });

  it('never names the format it found, so a refusal teaches a prober nothing', () => {
    try {
      validateUpload({ fileName: 'x', declaredContentType: 'application/zip', bytes: ZIP });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      const said = `${error.message} ${error.violations.map((v) => v.message).join(' ')}`;
      expect(said.toLowerCase()).not.toContain('zip');
      // It says what IS allowed, which is the part that helps.
      expect(said).toContain('PDF');
    }
  });
});

describe('how large a file may be', () => {
  it('refuses an empty one before anything else', () => {
    expect(
      codesOf(() => validateUpload({ fileName: 'x.pdf', declaredContentType: '', bytes: bytes() })),
    ).toEqual(['empty_file']);
  });

  it('accepts a file exactly at the limit', () => {
    const atLimit = new Uint8Array(MAX_UPLOAD_BYTES);
    atLimit.set(PDF, 0);
    expect(
      validateUpload({ fileName: 'big.pdf', declaredContentType: '', bytes: atLimit }).bytes
        .byteLength,
    ).toBe(MAX_UPLOAD_BYTES);
  });

  it('refuses one byte over it', () => {
    const overLimit = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    overLimit.set(PDF, 0);
    expect(
      codesOf(() => validateUpload({ fileName: 'big.pdf', declaredContentType: '', bytes: overLimit })),
    ).toEqual(['file_too_large']);
  });

  it('refuses on size BEFORE sniffing, so an oversized unknown file says the useful thing', () => {
    const huge = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    huge.set(ZIP, 0);
    // "too large" is actionable; "wrong type" would send somebody converting a
    // file that was never going to fit.
    expect(codesOf(() => validateUpload({ fileName: 'x', declaredContentType: '', bytes: huge }))).toEqual(
      ['file_too_large'],
    );
  });
});

describe('what a file may be called', () => {
  it('keeps an ordinary name', () => {
    expect(safeFileName('Customer order 4471.pdf')).toBe('Customer order 4471.pdf');
  });

  it('keeps only the last segment of anything path-shaped', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\hennie\\order.pdf')).toBe('order.pdf');
    expect(safeFileName('/var/lib/eje/storage/order.pdf')).toBe('order.pdf');
  });

  it('strips the characters that would forge a Content-Disposition header', () => {
    // The name is echoed in a response header. A newline in it is a second
    // header; a quote ends the filename parameter early.
    const forged = safeFileName('order.pdf"\r\nX-Injected: yes');
    expect(forged).not.toContain('"');
    expect(forged).not.toContain('\r');
    expect(forged).not.toContain('\n');
    expect(forged).toContain('order.pdf');
  });

  it('never returns an empty name', () => {
    // A row has to say the document is called something, and "document" is
    // honest about knowing nothing more.
    expect(safeFileName('')).toBe('document');
    expect(safeFileName('///')).toBe('document');
    expect(safeFileName('   ')).toBe('document');
  });

  it('bounds the length, because a database column and a header both have one', () => {
    expect(safeFileName(`${'a'.repeat(500)}.pdf`)).toHaveLength(200);
  });
});

describe('a photograph is narrower than a document', () => {
  it('accepts the four raster formats', () => {
    for (const image of [PNG, JPEG, TIFF_LE, WEBP]) {
      expect(
        PHOTO_CONTENT_TYPES.includes(
          validatePhotoUpload({ fileName: 'photo', declaredContentType: '', bytes: image })
            .contentType,
        ),
      ).toBe(true);
    }
  });

  it('refuses a PDF, and says where it belongs instead', () => {
    try {
      validatePhotoUpload({ fileName: 'order.pdf', declaredContentType: '', bytes: PDF });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      expect(error.violations[0]?.code).toBe('unsupported_file_type');
      expect(error.violations[0]?.message).toContain('Documents');
    }
  });

  it('is a SUBSET of what a document may be, not a different list', () => {
    // If these ever diverged, a photograph could be accepted at a different
    // size or by a different sniffer than a document. The subset relation is
    // the property worth pinning.
    for (const type of PHOTO_CONTENT_TYPES) expect(ACCEPTED_CONTENT_TYPES).toContain(type);
  });
});
