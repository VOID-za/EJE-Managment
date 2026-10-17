/**
 * The installed application's icons. PWA-1, MANDATE-2.
 *
 * WHY A GENERATOR AND NOT TWO BINARY FILES DROPPED IN. An icon is part of the
 * deliverable: it is what a technician taps on a tablet home screen, and when
 * the brand colour changes somebody has to be able to produce the set again.
 * A committed script says exactly what the pixels are and lets anybody rebuild
 * them; a committed PNG with no source says only that somebody once had one.
 *
 * NO IMAGE DEPENDENCY. Node's own `zlib` is all a PNG needs — a header, one
 * deflated block of filtered scanlines and a checksum. Adding `sharp` or a
 * canvas implementation to the production tree to draw four rectangles would
 * cost more than it is worth, and both are native builds that then have to
 * work on the deployment host.
 *
 *   node scripts/generate-pwa-icons.mjs
 *
 * Writes `public/icons/`. Run it when the brand colour or the mark changes,
 * and commit the result.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The application's own dark navy — the same value as `viewport.themeColor`. */
const NAVY = [0x1b, 0x24, 0x34];
/** The mark, in near-white, so it reads on the navy at 48 pixels. */
const CHALK = [0xf5, 0xf7, 0xfa];

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
};

/** An RGBA bitmap as a PNG. Colour type 6, bit depth 8, no interlacing. */
const encodePng = (width, height, rgba) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // One filter byte per scanline, filter 0 (none): the images are flat colour,
  // so a cleverer filter would save nothing worth the complexity.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/**
 * The mark: a bold E, drawn from four rectangles.
 *
 * Deliberately geometric. Rendering the words "EJE" needs a font, a shaper and
 * a rasteriser; a letter made of rectangles is legible at 48 pixels, which is
 * the size that actually matters on a home screen, and it is unmistakably the
 * same mark at 512.
 */
const draw = (size, { bleed }) => {
  const rgba = Buffer.alloc(size * size * 4);
  // `bleed` is for the maskable icon: Android may crop to a circle, so the
  // background runs to every edge and the mark sits inside the safe zone.
  const inset = bleed ? 0 : Math.round(size * 0.08);
  const radius = bleed ? 0 : Math.round(size * 0.18);

  const put = (x, y, [r, g, b]) => {
    const offset = (y * size + x) * 4;
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = 0xff;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inX = x >= inset && x < size - inset;
      const inY = y >= inset && y < size - inset;
      if (!inX || !inY) continue;

      // Rounded corners, by distance from the corner centre.
      if (radius > 0) {
        const left = inset + radius;
        const right = size - inset - radius - 1;
        const top = inset + radius;
        const bottom = size - inset - radius - 1;
        const cornerX = x < left ? left : x > right ? right : x;
        const cornerY = y < top ? top : y > bottom ? bottom : y;
        const dx = x - cornerX;
        const dy = y - cornerY;
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      put(x, y, NAVY);
    }
  }

  // The E: a spine and three arms, proportioned off the icon so every size
  // looks like the same mark rather than a scaled accident.
  const safe = bleed ? Math.round(size * 0.22) : Math.round(size * 0.28);
  const left = safe;
  const right = size - safe;
  const top = safe;
  const bottom = size - safe;
  const bar = Math.max(2, Math.round((bottom - top) * 0.18));
  const spine = Math.max(2, Math.round((right - left) * 0.22));

  const fill = (x0, y0, x1, y1) => {
    for (let y = Math.max(0, y0); y < Math.min(size, y1); y += 1) {
      for (let x = Math.max(0, x0); x < Math.min(size, x1); x += 1) put(x, y, CHALK);
    }
  };

  fill(left, top, left + spine, bottom); // spine
  fill(left, top, right, top + bar); // top arm
  fill(left, Math.round((top + bottom) / 2 - bar / 2), right - Math.round(bar * 0.8), Math.round((top + bottom) / 2 + bar / 2)); // middle arm
  fill(left, bottom - bar, right, bottom); // bottom arm

  return encodePng(size, size, rgba);
};

const directory = join(process.cwd(), 'public', 'icons');
mkdirSync(directory, { recursive: true });

const icons = [
  ['icon-192.png', 192, { bleed: false }],
  ['icon-512.png', 512, { bleed: false }],
  ['icon-maskable-512.png', 512, { bleed: true }],
  ['apple-touch-icon.png', 180, { bleed: true }],
];

for (const [name, size, options] of icons) {
  const png = draw(size, options);
  writeFileSync(join(directory, name), png);
  process.stdout.write(`icons    ${name} ${size}x${size}, ${png.length} bytes\n`);
}
