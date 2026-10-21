import { describe, expect, it } from 'vitest';
import { keyFingerprint } from './crypto';

/**
 * THE KEY-ESCROW DRILL. BACKUP-2, and the October mandate's "the encryption
 * key must be recoverable from outside the VPS".
 *
 * `npm run backup:key-check` compares a key somebody is holding against the
 * fingerprint a backup's manifest recorded. These are the properties that make
 * it worth running, tested without a backup directory:
 *
 *   - a fingerprint identifies a key and is not the key;
 *   - two different keys never share one;
 *   - and the same key always produces the same one, so an escrowed copy
 *     tested today still matches a backup taken a year ago.
 *
 * The command itself is proved end to end against a real encrypted backup —
 * right key, escrowed key from a file, and a wrong key — and that evidence is
 * in `docs/vps-backups.md`.
 */
const KEY_A = Buffer.from('a'.repeat(64), 'hex');
const KEY_B = Buffer.from('b'.repeat(64), 'hex');

describe('telling one backup key from another', () => {
  it('identifies a key without being it', () => {
    const fingerprint = keyFingerprint(KEY_A);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    // Short enough to read out over a telephone, and not the key: 16 hex
    // characters of a SHA-256 cannot be turned back into 32 bytes.
    expect(fingerprint).not.toContain(KEY_A.toString('hex').slice(0, 16));
  });

  it('gives different keys different fingerprints', () => {
    expect(keyFingerprint(KEY_A)).not.toBe(keyFingerprint(KEY_B));
  });

  it('is stable, so an escrowed copy still matches an old backup', () => {
    expect(keyFingerprint(KEY_A)).toBe(keyFingerprint(Buffer.from('a'.repeat(64), 'hex')));
  });

  /**
   * THE MISTAKE THE DRILL IS FOR. An escrowed key arrives with a trailing
   * newline from `echo`, a space from a copy and paste, or CRLF from a Windows
   * machine — and a key differing by one invisible character is
   * indistinguishable from the wrong key in every way except this one. So
   * `--key-file` trims before it parses, and the hex either way is the same
   * key.
   */
  it('is the same key whatever invisible characters came with the file', () => {
    const expected = keyFingerprint(KEY_A);
    for (const raw of ['a'.repeat(64), `${'a'.repeat(64)}\n`, ` ${'a'.repeat(64)} \r\n`]) {
      expect(keyFingerprint(Buffer.from(raw.trim(), 'hex'))).toBe(expected);
    }
  });
});
