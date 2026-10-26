/**
 * A photograph, made ready for the PDF writer.
 *
 * WHY THIS EXISTS. The job card printed a grey box labelled "Photograph" where
 * the customer's photograph belonged: the model carried only captions, and the
 * writer could not draw an image at all. This module turns the stored bytes of
 * an uploaded photograph into an image XObject the writer can embed, and says
 * plainly why when it cannot.
 *
 * ONE IMPLEMENTATION FOR BOTH RENDERING PATHS. The in-browser preview and the
 * server's issued copy both call `preparePdfImage` on the same stored bytes, so
 * the photograph a customer is shown before signing is the one in the file they
 * receive. It uses only `DecompressionStream` / `CompressionStream`, which the
 * browser and Node 22 both provide, so there is no second, server-only decoder
 * to drift from it.
 *
 *   - JPEG is embedded as it is (`DCTDecode`): no re-encoding, no quality lost.
 *     Its EXIF orientation is honoured by the drawing matrix, as a browser
 *     honours it on screen.
 *   - PNG is decoded and re-compressed (`FlateDecode`), with its transparency
 *     kept as a soft mask so a screenshot with an alpha channel reads on the
 *     page as it does on screen.
 *   - Anything else (WebP, TIFF, an interlaced PNG) is reported as unavailable,
 *     with the reason, so the document can say so instead of guessing.
 */

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface PdfImage {
  /** Stored pixel dimensions, before orientation is applied. */
  readonly width: number;
  readonly height: number;
  readonly colorSpace: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK';
  readonly filter: 'DCTDecode' | 'FlateDecode';
  readonly data: Uint8Array;
  /** PNG rows still carry their per-row filter byte; the reader undoes it. */
  readonly predictorColors?: number;
  /** Adobe CMYK JPEGs store the channels inverted. */
  readonly invertedCmyk?: boolean;
  /** Alpha, 8-bit greyscale, Flate-compressed, same dimensions. */
  readonly softMask?: Uint8Array;
  readonly orientation: ExifOrientation;
}

export type PreparedPhoto =
  | { readonly kind: 'image'; readonly image: PdfImage }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** Width and height as a person sees the photograph, orientation applied. */
export const displaySize = (image: PdfImage): { width: number; height: number } =>
  image.orientation >= 5
    ? { width: image.height, height: image.width }
    : { width: image.width, height: image.height };

/**
 * The most pixels a PNG may decode to. 40 MP is far beyond any tablet camera;
 * the limit exists so a crafted file cannot make the renderer allocate
 * gigabytes.
 */
const MAX_PIXELS = 40_000_000;

export const unavailable = (reason: string): PreparedPhoto => ({ kind: 'unavailable', reason });

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((value, index) => bytes[offset + index] === value);

/** What kind of file the bytes are, from their own signature. */
export const sniffImage = (bytes: Uint8Array): 'jpeg' | 'png' | 'webp' | 'tiff' | null => {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'tiff';
  }
  return null;
};

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** The EXIF orientation tag (0x0112) from an APP1 segment, or 1. */
const exifOrientation = (bytes: Uint8Array, start: number, end: number): ExifOrientation => {
  // "Exif\0\0" then a TIFF header.
  if (!startsWith(bytes, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00], start)) return 1;
  const tiff = start + 6;
  if (tiff + 8 > end) return 1;
  const little = bytes[tiff] === 0x49;
  const u16 = (at: number): number =>
    little ? bytes[at]! | (bytes[at + 1]! << 8) : (bytes[at]! << 8) | bytes[at + 1]!;
  const u32 = (at: number): number =>
    little
      ? (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
      : ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const entries = u16(ifd);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1;
    }
  }
  return 1;
};

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export const prepareJpeg = (bytes: Uint8Array): PreparedPhoto => {
  let offset = 2;
  let orientation: ExifOrientation = 1;
  let adobe = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return unavailable('The JPEG file is damaged.');
    const marker = bytes[offset + 1]!;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const start = offset + 4;
    const end = offset + 2 + length;
    if (length < 2 || end > bytes.length) return unavailable('The JPEG file is damaged.');
    if (marker === 0xe1) orientation = exifOrientation(bytes, start, end);
    if (marker === 0xee && startsWith(bytes, [0x41, 0x64, 0x6f, 0x62, 0x65], start)) adobe = true;
    if (SOF_MARKERS.has(marker)) {
      const height = (bytes[start + 1]! << 8) | bytes[start + 2]!;
      const width = (bytes[start + 3]! << 8) | bytes[start + 4]!;
      const components = bytes[start + 5]!;
      if (width === 0 || height === 0) return unavailable('The JPEG file has no dimensions.');
      const colorSpace =
        components === 1 ? 'DeviceGray' : components === 3 ? 'DeviceRGB' : components === 4 ? 'DeviceCMYK' : null;
      if (colorSpace === null) return unavailable('The JPEG file uses an unsupported colour layout.');
      return {
        kind: 'image',
        image: {
          width,
          height,
          colorSpace,
          filter: 'DCTDecode',
          data: bytes,
          ...(colorSpace === 'DeviceCMYK' && adobe ? { invertedCmyk: true } : {}),
          orientation,
        },
      };
    }
    if (marker === 0xda || marker === 0xd9) break;
    offset = end;
  }
  return unavailable('The JPEG file is damaged.');
};

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const readStream = async (
  input: Uint8Array,
  transform: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
  limit: number,
): Promise<Uint8Array> => {
  const writer = transform.writable.getWriter();
  // Not awaited: a writer blocks until the reader drains, so both run at once.
  // Its failure surfaces through the reader below.
  void writer.write(input as unknown as BufferSource).then(() => writer.close()).catch(() => {});
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error('The image decompresses to more data than its dimensions allow.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

const inflate = (bytes: Uint8Array, limit: number): Promise<Uint8Array> =>
  readStream(bytes, new DecompressionStream('deflate'), limit);

const deflate = (bytes: Uint8Array): Promise<Uint8Array> =>
  readStream(bytes, new CompressionStream('deflate'), Number.MAX_SAFE_INTEGER);

const u32be = (bytes: Uint8Array, at: number): number =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export const preparePng = async (bytes: Uint8Array): Promise<PreparedPhoto> => {
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = u32be(bytes, offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end > bytes.length) return unavailable('The PNG file is damaged.');
    if (type === 'IHDR') {
      width = u32be(bytes, start);
      height = u32be(bytes, start + 4);
      depth = bytes[start + 8]!;
      colorType = bytes[start + 9]!;
      interlace = bytes[start + 12]!;
    } else if (type === 'PLTE') palette = bytes.subarray(start, end);
    else if (type === 'tRNS') transparency = bytes.subarray(start, end);
    else if (type === 'IDAT') idat.push(bytes.subarray(start, end));
    else if (type === 'IEND') break;
    offset = end + 4; // the CRC
  }

  const channels = CHANNELS[colorType];
  if (width === 0 || height === 0 || channels === undefined || idat.length === 0) {
    return unavailable('The PNG file is damaged.');
  }
  if (interlace !== 0) return unavailable('Interlaced PNG files cannot be embedded in the job card.');
  if (width * height > MAX_PIXELS) return unavailable('The photograph is too large to embed.');
  if (![1, 2, 4, 8, 16].includes(depth)) return unavailable('The PNG file is damaged.');
  if (colorType === 3 && palette === null) return unavailable('The PNG file is damaged.');

  const compressed = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of idat) {
    compressed.set(part, at);
    at += part.length;
  }

  // The common, cheap case: 8-bit grey or RGB with no transparency. The
  // compressed rows go in as they are and the reader undoes PNG's filters.
  if (depth === 8 && (colorType === 0 || colorType === 2) && transparency === null) {
    return {
      kind: 'image',
      image: {
        width,
        height,
        colorSpace: colorType === 0 ? 'DeviceGray' : 'DeviceRGB',
        filter: 'FlateDecode',
        data: compressed,
        predictorColors: channels,
        orientation: 1,
      },
    };
  }

  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  let raw: Uint8Array;
  try {
    raw = await inflate(compressed, (stride + 1) * height);
  } catch {
    return unavailable('The PNG file is damaged.');
  }
  if (raw.length < (stride + 1) * height) return unavailable('The PNG file is damaged.');

  // Undo the per-row filters in place, into `rows`.
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const source = y * (stride + 1) + 1;
    const target = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x]!;
      const left = x >= bpp ? rows[target + x - bpp]! : 0;
      const up = y > 0 ? rows[target - stride + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? rows[target - stride + x - bpp]! : 0;
      let out: number;
      switch (filter) {
        case 0:
          out = value;
          break;
        case 1:
          out = value + left;
          break;
        case 2:
          out = value + up;
          break;
        case 3:
          out = value + ((left + up) >> 1);
          break;
        case 4:
          out = value + paeth(left, up, upLeft);
          break;
        default:
          return unavailable('The PNG file is damaged.');
      }
      rows[target + x] = out & 0xff;
    }
  }

  // One sample, scaled to 8 bits.
  const sample = (y: number, index: number): number => {
    const row = y * stride;
    if (depth === 8) return rows[row + index]!;
    if (depth === 16) return rows[row + index * 2]!;
    const bit = index * depth;
    const value = (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    // Palette indices stay indices; grey levels stretch to 0..255.
    return colorType === 3 ? value : Math.round((value * 255) / ((1 << depth) - 1));
  };
  const rawSample = (y: number, index: number): number => {
    // The unscaled value, for matching a tRNS key colour.
    const row = y * stride;
    if (depth === 16) return (rows[row + index * 2]! << 8) | rows[row + index * 2 + 1]!;
    if (depth === 8) return rows[row + index]!;
    const bit = index * depth;
    return (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };

  const grey = colorType === 0 || colorType === 4;
  const outChannels = grey ? 1 : 3;
  const colour = new Uint8Array(width * height * outChannels);
  let alpha: Uint8Array | null =
    colorType === 4 || colorType === 6 || transparency !== null ? new Uint8Array(width * height) : null;
  let opaque = true;
  const keyGrey = colorType === 0 && transparency !== null ? (transparency[0]! << 8) | transparency[1]! : -1;
  const keyRgb =
    colorType === 2 && transparency !== null && transparency.length >= 6
      ? [
          (transparency[0]! << 8) | transparency[1]!,
          (transparency[2]! << 8) | transparency[3]!,
          (transparency[4]! << 8) | transparency[5]!,
        ]
      : null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      let a = 255;
      if (colorType === 3) {
        const entry = sample(y, x);
        colour[pixel * 3] = palette![entry * 3] ?? 0;
        colour[pixel * 3 + 1] = palette![entry * 3 + 1] ?? 0;
        colour[pixel * 3 + 2] = palette![entry * 3 + 2] ?? 0;
        if (transparency !== null && entry < transparency.length) a = transparency[entry]!;
      } else if (grey) {
        colour[pixel] = sample(y, x * channels);
        if (colorType === 4) a = sample(y, x * channels + 1);
        else if (keyGrey >= 0 && rawSample(y, x) === keyGrey) a = 0;
      } else {
        const base = x * channels;
        colour[pixel * 3] = sample(y, base);
        colour[pixel * 3 + 1] = sample(y, base + 1);
        colour[pixel * 3 + 2] = sample(y, base + 2);
        if (colorType === 6) a = sample(y, base + 3);
        else if (
          keyRgb !== null &&
          rawSample(y, base) === keyRgb[0] &&
          rawSample(y, base + 1) === keyRgb[1] &&
          rawSample(y, base + 2) === keyRgb[2]
        ) {
          a = 0;
        }
      }
      if (alpha !== null) alpha[pixel] = a;
      if (a !== 255) opaque = false;
    }
  }
  // An alpha channel that is fully opaque is not worth a mask.
  if (opaque) alpha = null;

  return {
    kind: 'image',
    image: {
      width,
      height,
      colorSpace: grey ? 'DeviceGray' : 'DeviceRGB',
      filter: 'FlateDecode',
      data: await deflate(colour),
      ...(alpha === null ? {} : { softMask: await deflate(alpha) }),
      orientation: 1,
    },
  };
};

// ---------------------------------------------------------------------------

/**
 * Stored photograph bytes → something the writer can draw, or the reason it
 * cannot. Never throws: a photograph that cannot be embedded must not stop a
 * job card being produced.
 */
export const preparePdfImage = async (bytes: Uint8Array): Promise<PreparedPhoto> => {
  try {
    switch (sniffImage(bytes)) {
      case 'jpeg':
        return prepareJpeg(bytes);
      case 'png':
        return await preparePng(bytes);
      case 'webp':
        return unavailable('WebP photographs cannot be embedded in the job card. The file is kept on the job.');
      case 'tiff':
        return unavailable('TIFF photographs cannot be embedded in the job card. The file is kept on the job.');
      default:
        return unavailable('The file is not a photograph the job card can embed.');
    }
  } catch {
    return unavailable('The photograph could not be read.');
  }
};
