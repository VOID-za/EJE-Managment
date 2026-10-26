import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIMULATED_CAPABILITIES } from './demo';

/**
 * WHAT THE SCREENS SAY IS SIMULATED MUST BE TRUE. Amended 26 October 2026.
 *
 * The demonstration disclosure — the Demo Mode dialog and the Administration
 * page — told EJE that sign-in had no password check, that photographs were
 * placeholder tiles and nothing was uploaded, that there was no offline sync,
 * and that Microsoft 365 and WhatsApp would be connected "in Phase 2". Every
 * one of those had stopped being true. A disclosure that understates the
 * system is as misleading as one that overstates it, so these are pinned.
 */
describe('the demonstration disclosure', () => {
  it('lists only what is actually simulated', () => {
    const ids = SIMULATED_CAPABILITIES.map((capability) => capability.id);
    expect(ids).toEqual(['email', 'whatsapp', 'pdf', 'storage']);
  });

  it('makes none of the claims that stopped being true', () => {
    const text = JSON.stringify(SIMULATED_CAPABILITIES);
    for (const stale of [
      'no password check',
      'No files are uploaded',
      'placeholder tiles',
      'no sync engine',
      'rendered in the browser',
      'nothing is sent automatically',
    ]) {
      expect(text.toLowerCase()).not.toContain(stale.toLowerCase());
    }
  });

  it('no screen promises a "Phase 2" or a "production system" that is already built', () => {
    const root = join(import.meta.dirname, '..', 'app');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('page.tsx')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    const offending = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /in Phase 2|in the production\s+system/u.test(source);
    });
    expect(offending).toEqual([]);
  });
});
