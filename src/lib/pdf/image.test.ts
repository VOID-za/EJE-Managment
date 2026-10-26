import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { displaySize, preparePdfImage, sniffImage, type PdfImage } from './image';

/**
 * PHOTOGRAPHS, MADE READY FOR THE JOB CARD.
 *
 * The fixtures are real image files, encoded by Chromium's own JPEG and PNG
 * encoders from a canvas of four flat quadrants — red, green, blue, yellow —
 * so a test can say not only "an image came out" but "the right pixels came
 * out, in the right places". The PNG has a transparent square at its centre.
 */
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

const JPEG = fixture('quadrants.jpg');
const PNG_ALPHA = fixture('quadrants-alpha.png');

const image = async (bytes: Uint8Array): Promise<PdfImage> => {
  const prepared = await preparePdfImage(bytes);
  if (prepared.kind !== 'image') throw new Error(`expected an image, got: ${prepared.reason}`);
  return prepared.image;
};

/** Inserts an EXIF APP1 segment carrying `orientation` straight after SOI. */
const withOrientation = (jpeg: Uint8Array, orientation: number): Uint8Array => {
  const tiff = [
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, length >> 8, length & 0xff, ...payload,
    ...jpeg.subarray(2),
  ]);
};

/** A PNG built from raw rows, for the layouts Chromium does not emit. */
const png = (
  width: number,
  height: number,
  colorType: number,
  depth: number,
  rows: number[][],
  extra: { plte?: number[]; trns?: number[]; interlace?: number } = {},
): Uint8Array => {
  const chunk = (type: string, data: Uint8Array): number[] => {
    const length = data.length;
    return [
      (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff,
      ...[...type].map((character) => character.charCodeAt(0)),
      ...data,
      0, 0, 0, 0, // CRC: not checked by the reader
    ];
  };
  const ihdr = new Uint8Array([
    0, 0, 0, width, 0, 0, 0, height, depth, colorType, 0, 0, extra.interlace ?? 0,
  ]);
  const raw = new Uint8Array(rows.flatMap((row) => [0, ...row]));
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...(extra.plte === undefined ? [] : chunk('PLTE', new Uint8Array(extra.plte))),
    ...(extra.trns === undefined ? [] : chunk('tRNS', new Uint8Array(extra.trns))),
    ...chunk('IDAT', deflateSync(raw)),
    ...chunk('IEND', new Uint8Array()),
  ]);
};

describe('preparing a JPEG photograph', () => {
  it('embeds the file exactly as stored, with its own dimensions', async () => {
    const prepared = await image(JPEG);
    expect(prepared).toMatchObject({
      width: 320,
      height: 240,
      colorSpace: 'DeviceRGB',
      filter: 'DCTDecode',
      orientation: 1,
    });
    // Not re-encoded: the bytes in the PDF are the bytes the technician took.
    expect(Buffer.from(prepared.data).equals(Buffer.from(JPEG))).toBe(true);
  });

  it('honours the EXIF orientation, so a sideways-stored photograph is upright', async () => {
    const prepared = await image(withOrientation(JPEG, 6));
    expect(prepared.orientation).toBe(6);
    // Stored 320 × 240, seen 240 × 320: the box is sized from what people see.
    expect(displaySize(prepared)).toEqual({ width: 240, height: 320 });
    expect(displaySize(await image(withOrientation(JPEG, 3)))).toEqual({ width: 320, height: 240 });
  });
});

describe('preparing a PNG photograph', () => {
  it('decodes a real PNG with transparency into colour plus a soft mask', async () => {
    const prepared = await image(PNG_ALPHA);
    expect(prepared).toMatchObject({
      width: 320,
      height: 240,
      colorSpace: 'DeviceRGB',
      filter: 'FlateDecode',
    });
    const colour = inflateSync(prepared.data);
    const alpha = inflateSync(prepared.softMask!);
    expect(colour.length).toBe(320 * 240 * 3);
    expect(alpha.length).toBe(320 * 240);

    const rgb = (x: number, y: number) => [...colour.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    // Each quadrant's colour is where Chromium drew it.
    expect(rgb(40, 40)).toEqual([0xd0, 0x20, 0x20]);
    expect(rgb(280, 40)).toEqual([0x20, 0xa0, 0x40]);
    expect(rgb(40, 200)).toEqual([0x20, 0x40, 0xd0]);
    expect(rgb(280, 200)).toEqual([0xe0, 0xc0, 0x20]);
    // The cleared square is transparent; everything else is opaque.
    expect(alpha[120 * 320 + 160]).toBe(0);
    expect(alpha[40 * 320 + 40]).toBe(255);
  });

  it('passes an opaque 8-bit RGB PNG through with its row filters intact', async () => {
    const prepared = await image(png(2, 1, 2, 8, [[255, 0, 0, 0, 0, 255]]));
    expect(prepared.predictorColors).toBe(3);
    expect(prepared.softMask).toBeUndefined();
  });

  it('expands a palette PNG, and its tRNS entry becomes the mask', async () => {
    // Two pixels at 1 bit: index 0 (transparent black), index 1 (opaque white).
    const prepared = await image(
      png(2, 1, 3, 1, [[0b0100_0000]], { plte: [0, 0, 0, 255, 255, 255], trns: [0] }),
    );
    expect([...inflateSync(prepared.data)]).toEqual([0, 0, 0, 255, 255, 255]);
    expect([...inflateSync(prepared.softMask!)]).toEqual([0, 255]);
  });

  it('drops an alpha channel that is fully opaque rather than carrying a mask', async () => {
    const prepared = await image(png(1, 1, 6, 8, [[10, 20, 30, 255]]));
    expect(prepared.softMask).toBeUndefined();
    expect([...inflateSync(prepared.data)]).toEqual([10, 20, 30]);
  });
});

describe('a photograph that cannot be embedded says why', () => {
  it.each([
    ['WebP', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), /WebP/],
    ['TIFF', new Uint8Array([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]), /TIFF/],
    ['not an image', new TextEncoder().encode('<svg></svg>'), /not a photograph/],
    ['a truncated JPEG', JPEG.subarray(0, 40), /damaged/],
    ['a truncated PNG', PNG_ALPHA.subarray(0, 60), /damaged/],
    ['an interlaced PNG', png(1, 1, 2, 8, [[1, 2, 3]], { interlace: 1 }), /Interlaced/],
  ])('%s', async (_, bytes, reason) => {
    const prepared = await preparePdfImage(bytes);
    expect(prepared.kind).toBe('unavailable');
    expect(prepared.kind === 'unavailable' && prepared.reason).toMatch(reason);
  });

  it('knows the files by their signatures, not their names', () => {
    expect(sniffImage(JPEG)).toBe('jpeg');
    expect(sniffImage(PNG_ALPHA)).toBe('png');
  });
});
