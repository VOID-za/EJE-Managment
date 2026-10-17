import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import manifest from './manifest';
import { EJE_THEME_COLOR } from '@/lib/theme';

/**
 * WHETHER THE TABLET CAN ACTUALLY INSTALL IT. PWA-1, PWA-2, ACC-PWA-1,
 * ACC-PWA-2.
 *
 * Installability is a checklist a browser applies silently: name, start URL,
 * standalone display, and an icon of at least 192px that genuinely exists and
 * genuinely is a PNG of the size claimed. Get one wrong and there is no error
 * anywhere — the "Install" option simply never appears, which is the hardest
 * kind of failure to notice from a development machine.
 *
 * So every claim in the manifest is checked against the file it points at.
 * ACC-PWA-1 and ACC-PWA-2 still require the rugged tablet itself; these tests
 * are what make that visit worth making.
 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height out of a PNG's IHDR, which is always the first chunk. */
const pngSize = (bytes: Buffer): { width: number; height: number } => ({
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

describe('the web manifest', () => {
  const generated = manifest();

  it('names the application, and gives a short name a launcher can fit', () => {
    expect(generated.name).toBe('EJE Job Card Management');
    expect(generated.short_name).toBe('EJE Job Cards');
    // Android truncates beyond roughly this, and a truncated name under an
    // icon is how an installed app looks like a mistake.
    expect((generated.short_name ?? '').length).toBeLessThanOrEqual(14);
  });

  it('launches standalone, which is the whole of PWA-2', () => {
    expect(generated.display).toBe('standalone');
  });

  it('owns the whole origin, so the sign-in page is inside the installed app', () => {
    expect(generated.start_url).toBe('/');
    expect(generated.scope).toBe('/');
  });

  it('matches the document’s own theme colour, so the system bars do not flash', () => {
    // One constant, read by the document meta and by the manifest, so a
    // divergence is not possible rather than merely tested for.
    expect(generated.theme_color).toBe(EJE_THEME_COLOR);
    expect(generated.background_color).toBe(EJE_THEME_COLOR);
  });

  it('declares South African English, because the job card is written in it', () => {
    expect(generated.lang).toBe('en-ZA');
  });

  /* -- the icons, which are where installability is usually lost ----------- */

  it('offers an icon big enough for a browser to accept the install', () => {
    const sizes = (generated.icons ?? []).map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('offers a maskable icon, so Android does not crop the corners off', () => {
    const maskable = (generated.icons ?? []).filter((icon) => icon.purpose === 'maskable');
    expect(maskable).toHaveLength(1);
    expect(maskable[0]?.sizes).toBe('512x512');
  });

  it('points at files that exist, are PNGs, and are the size they claim', () => {
    for (const icon of generated.icons ?? []) {
      const path = join(process.cwd(), 'public', String(icon.src));
      expect(existsSync(path), `${String(icon.src)} is missing`).toBe(true);

      const bytes = readFileSync(path);
      expect(Array.from(bytes.subarray(0, 8))).toEqual(PNG_SIGNATURE);

      const [declared] = String(icon.sizes).split('x');
      const { width, height } = pngSize(bytes);
      expect(width).toBe(Number(declared));
      expect(height).toBe(Number(declared));
    }
  });

  it('ships the Apple touch icon the iOS home screen reads instead', () => {
    const path = join(process.cwd(), 'public', 'icons', 'apple-touch-icon.png');
    expect(existsSync(path)).toBe(true);
    expect(Array.from(readFileSync(path).subarray(0, 8))).toEqual(PNG_SIGNATURE);
  });

  /*
   * Both would be real manifest features and both would be product decisions
   * nobody has made — which screens belong on a long-press menu, and what the
   * store listing looks like. PROC-4: implementation does not decide those.
   */
  it('invents no shortcuts and no screenshots', () => {
    expect(generated.shortcuts).toBeUndefined();
    expect(generated.screenshots).toBeUndefined();
  });
});
