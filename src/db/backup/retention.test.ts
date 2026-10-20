import { describe, expect, it } from 'vitest';
import {
  backupDirectoryName,
  chooseBackupsToPrune,
  readBackupDirectoryName,
  readRetention,
} from './retention';

/**
 * THE MOST DANGEROUS DECISION IN THIS DIRECTORY, so every refusal is tested.
 *
 * Retention deletes the thing every other part of BACKUP-1 exists to protect.
 * The rules it must never break: nothing is removed unless a number was set,
 * nothing that this system did not write is ever a candidate, and the newest
 * backup and the one just taken are never removed.
 */
const shelf = [
  'eje-eje_production-2026-10-17T02-00-00Z',
  'eje-eje_production-2026-10-18T02-00-00Z',
  'eje-eje_production-2026-10-19T02-00-00Z',
  'eje-eje_production-2026-10-20T02-00-00Z',
];

describe('how many backups to keep', () => {
  it('keeps everything when nothing is configured', () => {
    expect(readRetention({})).toBeNull();
    expect(readRetention({ EJE_BACKUP_KEEP: '' })).toBeNull();
  });

  it('keeps everything when the setting is not a whole number above zero', () => {
    // A typo must fill a disk, never delete a backup.
    for (const value of ['0', '-3', 'seven', '2.5', 'yes', ' ']) {
      expect(readRetention({ EJE_BACKUP_KEEP: value }), value).toBeNull();
    }
  });

  it('reads a sensible number', () => {
    expect(readRetention({ EJE_BACKUP_KEEP: '7' })).toBe(7);
  });
});

describe('choosing what to remove', () => {
  const justWritten = 'eje-eje_production-2026-10-20T02-00-00Z';

  it('removes nothing at all when retention is unset', () => {
    const decision = chooseBackupsToPrune({
      entries: shelf,
      databaseName: 'eje_production',
      justWritten,
      keep: null,
    });
    expect(decision.remove).toEqual([]);
    expect(decision.note).toMatch(/every backup is kept/u);
  });

  it('keeps the newest N and removes the rest, oldest first', () => {
    const decision = chooseBackupsToPrune({
      entries: shelf,
      databaseName: 'eje_production',
      justWritten,
      keep: 2,
    });

    expect(decision.remove).toEqual([
      'eje-eje_production-2026-10-18T02-00-00Z',
      'eje-eje_production-2026-10-17T02-00-00Z',
    ]);
    expect(decision.kept).toContain('eje-eje_production-2026-10-20T02-00-00Z');
    expect(decision.kept).toContain('eje-eje_production-2026-10-19T02-00-00Z');
  });

  it('NEVER removes the backup just written, even when keep is 1', () => {
    const decision = chooseBackupsToPrune({
      entries: shelf,
      databaseName: 'eje_production',
      justWritten,
      keep: 1,
    });
    expect(decision.remove).not.toContain(justWritten);
    expect(decision.kept).toContain(justWritten);
  });

  /**
   * ANYTHING THIS SYSTEM DID NOT WRITE IS NOT A CANDIDATE.
   *
   * The live server has two hand-made dumps sitting in `/opt/eje`
   * (`eje-backup-20260925-092747.dump` and a pre-deploy one). Nothing here may
   * ever decide those are expendable because a count said so.
   */
  it('ignores directories and files it did not write', () => {
    const decision = chooseBackupsToPrune({
      entries: [
        ...shelf,
        'eje-backup-20260925-092747.dump',
        'eje_production_pre_947ef4f_20260924_193700.dump',
        'notes.txt',
        'eje-eje_production-not-a-stamp',
      ],
      databaseName: 'eje_production',
      justWritten,
      keep: 1,
    });

    expect(decision.remove).toEqual([
      'eje-eje_production-2026-10-19T02-00-00Z',
      'eje-eje_production-2026-10-18T02-00-00Z',
      'eje-eje_production-2026-10-17T02-00-00Z',
    ]);
    for (const untouched of [
      'eje-backup-20260925-092747.dump',
      'eje_production_pre_947ef4f_20260924_193700.dump',
      'notes.txt',
      'eje-eje_production-not-a-stamp',
    ]) {
      expect(decision.remove, untouched).not.toContain(untouched);
    }
  });

  it('never touches another database’s backups', () => {
    const decision = chooseBackupsToPrune({
      entries: [...shelf, 'eje-eje_staging-2026-10-01T02-00-00Z'],
      databaseName: 'eje_production',
      justWritten,
      keep: 1,
    });
    expect(decision.remove).not.toContain('eje-eje_staging-2026-10-01T02-00-00Z');
  });

  it('removes nothing when there are fewer than it keeps', () => {
    const decision = chooseBackupsToPrune({
      entries: [justWritten],
      databaseName: 'eje_production',
      justWritten,
      keep: 7,
    });
    expect(decision.remove).toEqual([]);
    expect(decision.note).toMatch(/nothing to remove yet/u);
  });
});

describe('the directory name', () => {
  it('round trips the name a run writes', () => {
    const name = backupDirectoryName('eje_production', new Date('2026-10-20T02:00:00.000Z'));
    expect(name).toBe('eje-eje_production-2026-10-20T02-00-00Z');
    expect(readBackupDirectoryName(name)).toEqual({
      name,
      database: 'eje_production',
      stamp: '2026-10-20T02-00-00Z',
    });
  });

  it('reads a database name that itself contains a dash', () => {
    expect(readBackupDirectoryName('eje-eje-test-2026-10-20T02-00-00Z')?.database).toBe('eje-test');
  });

  it('refuses anything else', () => {
    for (const name of ['backup', 'eje-', 'eje-x-2026-10-20', 'eje-x-2026-13-99T99-99-99Z-extra']) {
      expect(readBackupDirectoryName(name), name).toBeNull();
    }
  });
});
