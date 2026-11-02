import { describe, expect, it } from 'vitest';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, crc32, readStoredZip, uniqueEntryNames } from './zip';

/** JOB-ATT-2: the archive "Download Attachments" hands over. */
describe('the ZIP writer', () => {
  const pdf = new TextEncoder().encode('%PDF-1.4\nthe customer order\n%%EOF');
  const photo = Uint8Array.from({ length: 5000 }, (_, i) => (i * 37) % 256);

  it('computes the same CRC-32 as zlib', () => {
    for (const bytes of [new Uint8Array(0), pdf, photo]) expect(crc32(bytes)).toBe(zlibCrc32(bytes));
  });

  it('holds every original file, byte for byte, under its name', () => {
    const archive = createZip([
      { name: 'Order.pdf', bytes: pdf, modifiedAt: new Date('2026-11-02T08:30:00Z') },
      { name: 'Photo of the pump.jpg', bytes: photo },
    ]);
    const entries = readStoredZip(archive);
    expect(entries.map((entry) => entry.name)).toEqual(['Order.pdf', 'Photo of the pump.jpg']);
    expect(entries[0]!.bytes).toEqual(pdf);
    expect(entries[1]!.bytes).toEqual(photo);
    expect(entries[1]!.crc).toBe(zlibCrc32(photo));
  });

  it('keeps names in UTF-8', () => {
    const entries = readStoredZip(createZip([{ name: 'Bestelling — Ölpumpe.pdf', bytes: pdf }]));
    expect(entries[0]!.name).toBe('Bestelling — Ölpumpe.pdf');
  });

  it('numbers duplicate names instead of overwriting, case-insensitively, and strips folders', () => {
    expect(uniqueEntryNames(['Order.pdf', 'order.PDF', 'Order.pdf', '../../etc/passwd', '', 'README'])).toEqual([
      'Order.pdf',
      'order (2).PDF',
      'Order (3).pdf',
      'passwd',
      'document',
      'README',
    ]);
  });

  it('is an archive an ordinary tool opens, where one is installed', () => {
    let hasUnzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      hasUnzip = false;
    }
    if (!hasUnzip) return; // CI's Linux runner has unzip; the bytes are proven above either way.
    const dir = mkdtempSync(join(tmpdir(), 'eje-zip-'));
    const file = join(dir, 'a.zip');
    writeFileSync(file, createZip([{ name: 'Order.pdf', bytes: pdf }, { name: 'Order (2).pdf', bytes: photo }]));
    const listing = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    expect(listing).toMatch(/No errors detected/u);
  });
});
