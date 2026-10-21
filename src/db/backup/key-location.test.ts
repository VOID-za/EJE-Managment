import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEY_BESIDE_BACKUP_WARNING, keyIsBesideBackup, strayKeyFiles } from './key-location';

/**
 * The owner's rule, as a test: the key may not be the backup's neighbour.
 *
 * Both halves matter. `keyIsBesideBackup` must say yes to the arrangement that
 * loses the business and no to an escrowed key on a USB stick, because a
 * warning that cries wolf is a warning an operator learns to skip.
 */

const KEY = 'a'.repeat(64);

const temporary = (): string => mkdtempSync(join(tmpdir(), 'eje-key-location-'));

describe('a key stored beside its backup', () => {
  it('is beside it when it is IN the backup directory', () => {
    expect(keyIsBesideBackup('/var/backups/eje/eje-eje_production-2026', '/var/backups/eje/eje-eje_production-2026/key')).toBe(true);
  });

  it('is beside it when it is in the backup ROOT, one level out', () => {
    // This is the real arrangement: one key unlocking every backup under it.
    expect(keyIsBesideBackup('/var/backups/eje/eje-eje_production-2026', '/var/backups/eje/eje-backup-key')).toBe(true);
  });

  it('is beside it anywhere else under the backup root', () => {
    expect(keyIsBesideBackup('/var/backups/eje/eje-2026', '/var/backups/eje/keys/eje-backup-key')).toBe(true);
  });

  it('is NOT beside it on a mounted volume', () => {
    expect(keyIsBesideBackup('/var/backups/eje/eje-2026', '/mnt/usb/eje-backup-key')).toBe(false);
  });

  it('is NOT beside it in an operator home directory', () => {
    expect(keyIsBesideBackup('/var/backups/eje/eje-2026', '/home/jc/.config/eje/key')).toBe(false);
  });

  it('is NOT beside it one level ABOVE the backup root', () => {
    // `/var/backups` holds other things. A key there is badly placed and is
    // somebody else's finding; this check is about THIS backup's neighbours.
    expect(keyIsBesideBackup('/var/backups/eje/eje-2026', '/var/backups/eje-backup-key')).toBe(false);
  });

  it('resolves relative paths rather than comparing strings', () => {
    expect(keyIsBesideBackup('/var/backups/eje/eje-2026', '/var/backups/eje/eje-2026/../key')).toBe(true);
  });

  it('says what is wrong without saying the key', () => {
    expect(KEY_BESIDE_BACKUP_WARNING).toMatch(/NOT this server/u);
    expect(KEY_BESIDE_BACKUP_WARNING).not.toMatch(/[0-9a-f]{32}/u);
  });
});

describe('a stray key in the backup root', () => {
  it('is found and named', () => {
    const root = temporary();
    writeFileSync(join(root, 'eje-backup-key'), `${KEY}\n`);
    expect(strayKeyFiles(root)).toEqual(['eje-backup-key']);
  });

  it('is found whatever it is called', () => {
    const root = temporary();
    writeFileSync(join(root, 'notes.txt'), KEY);
    expect(strayKeyFiles(root)).toEqual(['notes.txt']);
  });

  it('leaves the backups themselves alone', () => {
    const root = temporary();
    mkdirSync(join(root, 'eje-eje_production-2026'));
    writeFileSync(join(root, 'eje-eje_production-2026', 'manifest.json'), '{}');
    expect(strayKeyFiles(root)).toEqual([]);
  });

  it('does not read a file too large to be a key', () => {
    const root = temporary();
    writeFileSync(join(root, 'database.dump.enc'), 'x'.repeat(200_000));
    expect(strayKeyFiles(root)).toEqual([]);
  });

  it('is not confused by a fingerprint, which is public and short', () => {
    const root = temporary();
    writeFileSync(join(root, 'fingerprint'), '0c4665cc6dda8e1d');
    expect(strayKeyFiles(root)).toEqual([]);
  });

  it('does not recurse into the backups looking for one', () => {
    const root = temporary();
    mkdirSync(join(root, 'eje-2026'));
    writeFileSync(join(root, 'eje-2026', 'key'), KEY);
    // Reported by `key-check` when that key is NAMED, not by walking the tree:
    // a backup command that read every small file under its root would be
    // reading the operator's files to look for secrets.
    expect(strayKeyFiles(root)).toEqual([]);
  });

  it('returns nothing for a directory that is not there', () => {
    expect(strayKeyFiles(join(temporary(), 'missing'))).toEqual([]);
  });
});
