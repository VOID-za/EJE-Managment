import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * IS THE KEY SITTING NEXT TO THE THING IT DECRYPTS? BACKUP-2.
 *
 * The owner's rule, and it is categorical: *"the encryption key must never be
 * stored beside the encrypted backup as the only recovery method."* A key in
 * `/var/backups/eje/` is not a key — it is a second copy of the plaintext with
 * extra steps. The disk that loses the backups loses it, the stolen volume
 * carries it, and the restore drill passes right up until the day it matters.
 *
 * NOTHING HERE CAN PREVENT THE ARRANGEMENT, and it does not pretend to: a file
 * somebody puts on a server is not this application's to delete. What it can do
 * is make the arrangement VISIBLE at the two moments an operator is looking —
 * when a backup is written, and when an escrowed key is checked — rather than
 * leave it to be discovered.
 *
 * THE KEY ITSELF IS NEVER READ OUT OF A BACKUP DIRECTORY BY ANY COMMAND. The
 * backup takes it from `EJE_BACKUP_KEY` and `key-check` from the environment or
 * a named file. This module only decides whether a PATH is in the wrong place,
 * and `looksLikeAKeyFile` reads at most a few bytes to answer whether a stray
 * file is a key — it never prints, logs or returns what it read.
 */

/** A key is a backup key's worth of hexadecimal and nothing else. */
const KEY_PATTERN = /^[0-9a-fA-F]{64}$/u;

/**
 * The most a key file can be: 64 characters plus whatever line ending and
 * stray whitespace an editor, `echo` or a Windows copy added. Anything larger
 * is not read at all, so this never pulls a dump into memory.
 */
const KEY_FILE_LIMIT = 128;

/** Is `candidate` inside `directory`, or the directory itself? */
const within = (directory: string, candidate: string): boolean => {
  const step = relative(resolve(directory), resolve(candidate));
  if (step.length === 0) return true;
  return !step.startsWith(`..${sep}`) && step !== '..' && !isAbsolute(step);
};

/**
 * Is this key file stored beside the backup it unlocks?
 *
 * "Beside" is the backup directory AND the directory holding it — the backup
 * root. A key in `/var/backups/eje/` unlocks every backup under it, so being
 * one level out is not being somewhere else.
 */
export const keyIsBesideBackup = (backupDirectory: string, keyFile: string): boolean =>
  within(backupDirectory, keyFile) || within(dirname(resolve(backupDirectory)), keyFile);

/** The warning, in one place, so the two commands say the same thing. */
export const KEY_BESIDE_BACKUP_WARNING =
  'THIS KEY IS STORED BESIDE THE BACKUP IT UNLOCKS. If that is the only copy, it is ' +
  'not a recovery method: whatever happens to the backups happens to it, and an ' +
  'encrypted backup whose key travels with it is an unencrypted backup. Keep the ' +
  'recovery copy somewhere that is NOT this server and NOT the backup volume — see ' +
  'docs/vps-backups.md §2.1.';

/**
 * Files directly under `root` whose entire contents are a backup key.
 *
 * Used by `npm run backup` to say so while an operator is watching. It reads
 * only files small enough to BE a key, never recurses, and never reports what
 * a file contained — only its name.
 */
export const strayKeyFiles = (root: string): readonly string[] => {
  let entries: readonly string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > KEY_FILE_LIMIT) continue;
      if (KEY_PATTERN.test(readFileSync(path, 'utf8').trim())) found.push(entry);
    } catch {
      // Unreadable is not a finding. This is a warning, not an audit.
    }
  }
  return found;
};
