import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_BYTES,
  PHOTO_CONTENT_TYPES,
  safeFileName,
  sniffContentType,
  validateJobMediaUpload,
  validatePhotoUpload,
  validateUpload,
  validateVideoUpload,
  VIDEO_CONTENT_TYPES,
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

/**
 * VIDEO. MEDIA-5.
 *
 * The containers a phone actually writes, and the ones that look like them.
 * MP4, MOV and 3GP are all ISO base media files — four bytes of box length,
 * then `ftyp`, then a brand — so the brand is the only thing distinguishing a
 * video from an HEIC photograph or an M4A voice note in the same container.
 * Those two cases are the reason the brand is checked rather than just `ftyp`.
 */
const iso = (brand: string): Uint8Array =>
  new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    ...[...brand].map((character) => character.charCodeAt(0)),
  ]);

const MP4 = iso('isom');
const MOV = iso('qt  ');
const THREE_GP = iso('3gp4');
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
const HEIC = iso('heic');
const M4A = iso('M4A ');

describe('what a video may be', () => {
  it('recognises what a tablet camera writes', () => {
    expect(sniffContentType(MP4)?.contentType).toBe('video/mp4');
    expect(sniffContentType(MOV)?.contentType).toBe('video/quicktime');
    expect(sniffContentType(THREE_GP)?.contentType).toBe('video/3gpp');
    expect(sniffContentType(WEBM)?.contentType).toBe('video/webm');
  });

  it('refuses an HEIC photograph in the same container', () => {
    // `ftyp` alone would have accepted this and filed a still image as a
    // video — a tile with a play button that plays nothing.
    expect(sniffContentType(HEIC)).toBeNull();
  });

  it('refuses an M4A voice note in the same container', () => {
    expect(sniffContentType(M4A)).toBeNull();
  });

  it('refuses a truncated ISO header rather than reading past it', () => {
    expect(sniffContentType(bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70))).toBeNull();
  });

  it('accepts each container through the video validator', () => {
    for (const video of [MP4, MOV, THREE_GP, WEBM]) {
      expect(
        VIDEO_CONTENT_TYPES.includes(
          validateVideoUpload({ fileName: 'clip', declaredContentType: '', bytes: video })
            .contentType,
        ),
      ).toBe(true);
    }
  });

  it('allows a video larger than the document limit, up to its own', () => {
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    big.set(MP4, 0);
    expect(
      validateVideoUpload({ fileName: 'clip.mp4', declaredContentType: '', bytes: big })
        .contentType,
    ).toBe('video/mp4');
  });

  it('refuses one past the video limit, and says what to do instead', () => {
    const tooBig = new Uint8Array(MAX_VIDEO_BYTES + 1);
    tooBig.set(MP4, 0);
    try {
      validateVideoUpload({ fileName: 'film.mp4', declaredContentType: '', bytes: tooBig });
      throw new Error('expected a refusal');
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      expect(error.violations[0]?.code).toBe('file_too_large');
      expect(error.violations[0]?.message).toContain('shorter');
    }
  });

  it('refuses a photograph sent as a video, and a video sent as a photograph', () => {
    // `kind` picks the rule; the bytes decide the fact. Neither direction is
    // taken on the client's word.
    expect(
      codesOf(() => validateVideoUpload({ fileName: 'x.mp4', declaredContentType: 'video/mp4', bytes: JPEG })),
    ).toEqual(['unsupported_file_type']);
    expect(
      codesOf(() => validatePhotoUpload({ fileName: 'x.jpg', declaredContentType: 'image/jpeg', bytes: MP4 })),
    ).toEqual(['unsupported_file_type']);
  });

  it('refuses a video on the DOCUMENT path, which the sniffer alone would have allowed', () => {
    /*
     * This is the regression the restructuring was for. `validateUpload` used
     * to accept anything the sniffer recognised; the moment the sniffer learned
     * MP4, a video would have been accepted as a customer's order. Every
     * caller now names the types it accepts.
     */
    expect(
      codesOf(() => validateUpload({ fileName: 'order.pdf', declaredContentType: '', bytes: MP4 })),
    ).toEqual(['unsupported_file_type']);
  });
});

/**
 * WHAT THE NEW-JOB ATTACHMENT CONTROL ACCEPTS. Create New Job §3C.
 *
 * The owner asked that the control offer photographs and videos rather than
 * arbitrary documents, so `validateJobMediaUpload` is the union of the two
 * media lists and nothing else. Two things make it more than a list:
 *
 *  - THE LIMIT FOLLOWS WHAT THE FILE IS. A video gets the video budget and a
 *    photograph is still held to the photograph one, so a 26 MB photograph is
 *    refused on a route whose outer bound is 60 MB.
 *  - THE ORDER OF REFUSALS IS UNCHANGED. Empty, then size, then type — so an
 *    empty file is reported as empty, and an oversized PDF is reported as the
 *    wrong TYPE rather than as too large, because converting it would not have
 *    helped.
 */
describe('what may be attached to a new job', () => {
  it('accepts every photograph format', () => {
    for (const photo of [PNG, JPEG, TIFF_LE, TIFF_BE, WEBP]) {
      expect(validateJobMediaUpload({ fileName: 'f', declaredContentType: '', bytes: photo }))
        .toBeDefined();
    }
  });

  it('accepts every video format', () => {
    for (const video of [MP4, MOV, THREE_GP, WEBM]) {
      expect(validateJobMediaUpload({ fileName: 'f', declaredContentType: '', bytes: video }))
        .toBeDefined();
    }
  });

  it('REFUSES a PDF, which the document path still accepts', () => {
    expect(
      codesOf(() =>
        validateJobMediaUpload({
          fileName: 'order.pdf',
          declaredContentType: 'application/pdf',
          bytes: PDF,
        }),
      ),
    ).toContain('unsupported_file_type');

    // The same bytes on the DOCUMENT path are fine, which is the point: this
    // narrowing is one control's, not the whole system's.
    expect(
      validateUpload({
        fileName: 'order.pdf',
        declaredContentType: 'application/pdf',
        bytes: PDF,
      }).contentType,
    ).toBe('application/pdf');
  });

  it('refuses a ZIP and an ELF binary', () => {
    for (const hostile of [ZIP, ELF]) {
      expect(
        codesOf(() =>
          validateJobMediaUpload({
            fileName: 'fault.png',
            declaredContentType: 'image/png',
            bytes: hostile,
          }),
        ),
      ).toContain('unsupported_file_type');
    }
  });

  it('holds a PHOTOGRAPH to the photograph limit', () => {
    const huge = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    huge.set(PNG, 0);
    expect(
      codesOf(() =>
        validateJobMediaUpload({ fileName: 'big.png', declaredContentType: '', bytes: huge }),
      ),
    ).toContain('file_too_large');
  });

  it('allows a VIDEO past the photograph limit, up to the video one', () => {
    const large = new Uint8Array(MAX_UPLOAD_BYTES + 1024);
    large.set(MP4, 0);
    expect(
      validateJobMediaUpload({ fileName: 'clip.mp4', declaredContentType: '', bytes: large })
        .contentType,
    ).toBe('video/mp4');

    const tooLarge = new Uint8Array(MAX_VIDEO_BYTES + 1);
    tooLarge.set(MP4, 0);
    expect(
      codesOf(() =>
        validateJobMediaUpload({ fileName: 'clip.mp4', declaredContentType: '', bytes: tooLarge }),
      ),
    ).toContain('file_too_large');
  });

  it('reports an EMPTY file as empty rather than as the wrong type', () => {
    expect(
      codesOf(() =>
        validateJobMediaUpload({
          fileName: 'nothing.png',
          declaredContentType: 'image/png',
          bytes: new Uint8Array(),
        }),
      ),
    ).toContain('empty_file');
  });

  it('sanitises the file name exactly as every other path does', () => {
    expect(
      validateJobMediaUpload({
        fileName: '../../etc/fault.png',
        declaredContentType: '',
        bytes: PNG,
      }).fileName,
    ).toBe('fault.png');
  });
});
