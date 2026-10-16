import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { decryptFile, encryptFile, keyFingerprint, readBackupKey } from './crypto';
import { BackupRefused } from './plan';

/**
 * BACKUP-2's encryption, on real files.
 *
 * The claims worth testing are not "it encrypts": they are that a backup which
 * has been ALTERED is refused rather than restored, that the wrong key is
 * refused rather than producing rubbish, and that nothing anywhere prints the
 * key. Each of those is a thing somebody will one day depend on at the worst
 * possible moment.
 */

const roots: string[] = [];
const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'eje-crypto-'));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots) spawnSync('rm', ['-rf', root]);
});

const KEY = Buffer.from('a'.repeat(64), 'hex');
const OTHER_KEY = Buffer.from('b'.repeat(64), 'hex');

describe('the key', () => {
  it('is read from the environment as 32 bytes of hex', () => {
    const hex = '0123456789abcdef'.repeat(4);
    expect(readBackupKey({ EJE_BACKUP_KEY: hex })).toEqual(Buffer.from(hex, 'hex'));
    // Surrounding whitespace is what an operator's copy-paste actually contains.
    expect(readBackupKey({ EJE_BACKUP_KEY: ` ${hex}\n` })).toHaveLength(32);
  });

  it('refuses an absent key, and says how to make one', () => {
    expect(() => readBackupKey({})).toThrow(BackupRefused);
    expect(() => readBackupKey({ EJE_BACKUP_KEY: '  ' })).toThrow(/openssl rand -hex 32/u);
  });

  it('refuses a passphrase rather than stretching it into a key', () => {
    // The failure this prevents: a backup encrypted with something guessable,
    // reporting success.
    expect(() => readBackupKey({ EJE_BACKUP_KEY: 'correct horse battery staple' })).toThrow(
      /64 hexadecimal characters/u,
    );
    expect(() => readBackupKey({ EJE_BACKUP_KEY: 'ff'.repeat(16) })).toThrow(/32 bytes/u);
    expect(() => readBackupKey({ EJE_BACKUP_KEY: `${'f'.repeat(63)}z` })).toThrow(BackupRefused);
  });

  it('has a fingerprint that identifies it without being it', () => {
    const print = keyFingerprint(KEY);
    expect(print).toMatch(/^[0-9a-f]{16}$/u);
    expect(print).not.toContain(KEY.toString('hex').slice(0, 8));
    expect(keyFingerprint(KEY)).toBe(print); // stable
    expect(keyFingerprint(OTHER_KEY)).not.toBe(print); // and distinguishing
  });
});

describe('encrypting an artefact', () => {
  const sampleOf = (root: string, body: string): string => {
    const path = join(root, 'database.dump');
    writeFileSync(path, body);
    return path;
  };

  it('round-trips the exact bytes, and records both checksums', async () => {
    const root = workspace();
    // Bigger than one stream chunk, so the loop is actually exercised.
    const body = 'PGDMP'.repeat(200_000);
    const source = sampleOf(root, body);
    const encrypted = join(root, 'database.dump.enc');
    const back = join(root, 'restored.dump');

    const record = await encryptFile(source, encrypted, KEY);
    expect(record.bytes).toBe(statSync(encrypted).size);
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.plainSha256).not.toBe(record.sha256);

    // The ciphertext is not the plaintext — the sanity check that catches a
    // cipher that was configured but never applied.
    expect(readFileSync(encrypted).includes('PGDMP')).toBe(false);

    const plainSha = await decryptFile(encrypted, back, KEY);
    expect(readFileSync(back, 'utf8')).toBe(body);
    expect(plainSha).toBe(record.plainSha256);
  });

  it('refuses a file whose ciphertext has been altered', async () => {
    const root = workspace();
    const source = sampleOf(root, 'the signed job card');
    const encrypted = join(root, 'database.dump.enc');
    await encryptFile(source, encrypted, KEY);

    // One byte, in the body. This is the whole point of GCM over a checksum:
    // whoever changed it cannot produce a tag that verifies.
    const bytes = readFileSync(encrypted);
    bytes[20] = bytes[20]! ^ 0x01;
    writeFileSync(encrypted, bytes);

    await expect(decryptFile(encrypted, join(root, 'out'), KEY)).rejects.toThrow(
      /did not authenticate/u,
    );
  });

  it('refuses a truncated file', async () => {
    const root = workspace();
    const source = sampleOf(root, 'the signed job card');
    const encrypted = join(root, 'database.dump.enc');
    await encryptFile(source, encrypted, KEY);

    const bytes = readFileSync(encrypted);
    writeFileSync(encrypted, bytes.subarray(0, bytes.length - 4));
    await expect(decryptFile(encrypted, join(root, 'out'), KEY)).rejects.toThrow(BackupRefused);

    // And one too short to hold even a nonce and a tag.
    writeFileSync(encrypted, Buffer.alloc(8));
    await expect(decryptFile(encrypted, join(root, 'out'), KEY)).rejects.toThrow(/truncated/u);
  });

  it('refuses the wrong key rather than producing rubbish', async () => {
    const root = workspace();
    const source = sampleOf(root, 'the signed job card');
    const encrypted = join(root, 'database.dump.enc');
    await encryptFile(source, encrypted, KEY);

    await expect(decryptFile(encrypted, join(root, 'out'), OTHER_KEY)).rejects.toThrow(
      /did not authenticate/u,
    );
  });

  it('uses a fresh nonce, so the same file twice is not the same ciphertext', async () => {
    const root = workspace();
    const source = sampleOf(root, 'identical input');
    const first = join(root, 'one.enc');
    const second = join(root, 'two.enc');

    const a = await encryptFile(source, first, KEY);
    const b = await encryptFile(source, second, KEY);

    expect(a.plainSha256).toBe(b.plainSha256);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('writes the encrypted artefact 0600, like everything else in a backup', async () => {
    const root = workspace();
    const source = sampleOf(root, 'the signed job card');
    const encrypted = join(root, 'database.dump.enc');
    await encryptFile(source, encrypted, KEY);
    expect(statSync(encrypted).mode & 0o777).toBe(0o600);
  });

  it('never puts the key in a refusal', async () => {
    const root = workspace();
    const source = sampleOf(root, 'the signed job card');
    const encrypted = join(root, 'database.dump.enc');
    await encryptFile(source, encrypted, KEY);
    writeFileSync(encrypted, Buffer.alloc(8));

    const failure = await decryptFile(encrypted, join(root, 'out'), KEY)
      .then(() => null)
      .catch((error: unknown) => error as Error);
    expect(failure?.message ?? '').toMatch(/truncated/u);
    expect(failure?.message ?? '').not.toContain(KEY.toString('hex'));
    expect(failure?.message ?? '').not.toContain(keyFingerprint(KEY));
  });
});
