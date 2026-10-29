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
 * THE MARK — THE APPLICATION'S OWN "EJE" TILE (the sidebar's `Logo`): the
 * letters EJE on the brand blue, with the thin rule under them. Updated 29
 * October 2026 so the favicon, the home-screen icons and the in-app logo are
 * ONE mark; before, the favicon was a blue tile in a system font and these
 * icons were a navy tile with a single E. There is no other EJE logo in the
 * repository, and none is invented here — when the company's real logo is
 * supplied, it replaces this generator's rectangles.
 *
 * Drawn from rectangles in unit space, so the same geometry is rasterised for
 * every PNG and written as vector rectangles for `src/app/icon.svg`: no font,
 * no shaper, identical on every device and legible at 48 pixels.
 */
const BRAND = [0x00, 0x78, 0xe4]; // --eje-blue-500, oklch(0.575 0.19 252), as sRGB
const RULE = [0x80, 0xbb, 0xf1]; // the Logo's white/45 rule over the brand blue

/** The letters and the rule, in a 1×1 box: [x, y, width, height, kind]. */
const markRects = () => {
  const width = 0.27; // one letter
  const gap = 0.095;
  const total = width * 3 + gap * 2;
  const left = (1 - total) / 2;
  const height = 0.42;
  const top = 0.27;
  const stroke = height * 0.2; // horizontal strokes
  const stem = width * 0.32; // vertical strokes
  const rects = [];
  const letterE = (x) => {
    rects.push([x, top, stem, height, 'mark']);
    rects.push([x, top, width, stroke, 'mark']);
    rects.push([x, top + height / 2 - stroke / 2, width * 0.82, stroke, 'mark']);
    rects.push([x, top + height - stroke, width, stroke, 'mark']);
  };
  const letterJ = (x) => {
    rects.push([x, top, width, stroke, 'mark']);
    rects.push([x + width - stem, top, stem, height, 'mark']);
    rects.push([x, top + height - stroke, width, stroke, 'mark']);
    rects.push([x, top + height * 0.6, stem, height * 0.4, 'mark']);
  };
  letterE(left);
  letterJ(left + width + gap);
  letterE(left + (width + gap) * 2);
  rects.push([left + 0.03, top + height + 0.09, total - 0.06, 0.035, 'rule']);
  return rects;
};

const draw = (size, { bleed }) => {
  const rgba = Buffer.alloc(size * size * 4);
  // `bleed` is for the maskable and Apple icons: the background runs to every
  // edge (the platform crops it) and the mark shrinks into the safe zone.
  const inset = bleed ? 0 : Math.round(size * 0.06);
  const radius = bleed ? 0 : Math.round(size * 0.2);
  // The mark sits inside the tile with the Logo's padding; a maskable icon keeps it
  // inside the circle Android may crop to.
  const scale = bleed ? 0.66 : 0.72;

  const put = (x, y, [r, g, b]) => {
    const offset = (y * size + x) * 4;
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = 0xff;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (x < inset || x >= size - inset || y < inset || y >= size - inset) continue;
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
      put(x, y, BRAND);
    }
  }

  const offset = (1 - scale) / 2;
  for (const [rx, ry, rw, rh, kind] of markRects()) {
    const x0 = Math.round((offset + rx * scale) * size);
    const y0 = Math.round((offset + ry * scale) * size);
    const x1 = Math.max(x0 + 1, Math.round((offset + (rx + rw) * scale) * size));
    const y1 = Math.max(y0 + 1, Math.round((offset + (ry + rh) * scale) * size));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) put(x, y, kind === 'rule' ? RULE : CHALK);
    }
  }
  return encodePng(size, size, rgba);
};

/** The favicon: the same rectangles, as vectors. */
const svg = () => {
  const hex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  const rects = markRects()
    .map(([x, y, w, h, kind]) =>
      // The same placement as the PNG tile: 0.72 of the tile, centred.
      `  <rect x="${((0.14 + x * 0.72) * 64).toFixed(2)}" y="${((0.14 + y * 0.72) * 64).toFixed(2)}" width="${(w * 0.72 * 64).toFixed(2)}" height="${(h * 0.72 * 64).toFixed(2)}" fill="${kind === 'rule' ? hex(RULE) : hex(CHALK)}" />`,
    )
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <!-- Generated by scripts/generate-pwa-icons.mjs: the same mark as the home-screen icons and the in-app logo. -->\n  <rect width="64" height="64" rx="13" fill="${hex(BRAND)}" />\n${rects}\n</svg>\n`;
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
writeFileSync(join(process.cwd(), 'src', 'app', 'icon.svg'), svg());
process.stdout.write('icons    src/app/icon.svg (favicon), the same mark\n');
