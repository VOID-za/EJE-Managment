import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyFingerprint } from './crypto';
import { escrowVerdict, isFingerprint } from './escrow-check';

/**
 * CHECKING THE ESCROWED KEY WHERE IT IS KEPT, NOT ON THE SERVER. BACKUP-2.
 *
 * The off-site copy of the backup key is only worth anything if it is the
 * right key, and the check must not require carrying it to the VPS. These pin
 * the comparison and — through the real command — that the key never appears
 * in what is printed.
 */
const KEY = 'ab'.repeat(32);
const FINGERPRINT = keyFingerprint(Buffer.from(KEY, 'hex'));

describe('escrowVerdict', () => {
  it('matches the key the fingerprint was taken from', () => {
    expect(escrowVerdict(KEY, FINGERPRINT)).toEqual({ kind: 'match', fingerprint: FINGERPRINT });
  });

  it('ignores the newline a file or a paste adds, and the case of the hex', () => {
    expect(escrowVerdict(`${KEY.toUpperCase()}\r\n`, FINGERPRINT.toUpperCase()).kind).toBe('match');
  });

  it('says NO MATCH for a different key', () => {
    expect(escrowVerdict('cd'.repeat(32), FINGERPRINT).kind).toBe('mismatch');
  });

  it('refuses to compare something that is not a key', () => {
    for (const candidate of ['', KEY.slice(0, 63), `${KEY}0`, 'z'.repeat(64), `${KEY.slice(0, 32)} ${KEY.slice(32)}`]) {
      expect(escrowVerdict(candidate, FINGERPRINT).kind).toBe('malformed');
    }
  });
});

describe('isFingerprint', () => {
  it('takes 16 hex characters and nothing else', () => {
    expect(isFingerprint('23dba6772da10057')).toBe(true);
    expect(isFingerprint('23DBA6772DA10057')).toBe(true);
    expect(isFingerprint('23dba6772da1005')).toBe(false);
    expect(isFingerprint(KEY)).toBe(false);
  });
});

describe('npm run backup:escrow-check', () => {
  const run = (args: readonly string[], input?: string) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/db/backup/escrow-check.ts', ...args], {
      encoding: 'utf8',
      input,
    });

  it('reads the key from stdin, says MATCH, and never prints the key', () => {
    const result = run(['--expect', FINGERPRINT], `${KEY}\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/MATCH/u);
    expect(result.stdout).not.toContain(KEY);
    expect(result.stdout).not.toContain(KEY.slice(0, 16));
  });

  it('reads the key from a file and exits 1 on the wrong one', () => {
    const directory = mkdtempSync(join(tmpdir(), 'eje-escrow-'));
    try {
      const file = join(directory, 'key');
      writeFileSync(file, `${'cd'.repeat(32)}\n`);
      const result = run(['--expect', FINGERPRINT, '--key-file', file]);
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/NO MATCH/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exits 2 without a fingerprint to compare against', () => {
    expect(run([], `${KEY}\n`).status).toBe(2);
  });
});
