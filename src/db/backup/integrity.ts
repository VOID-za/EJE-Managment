import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decryptFile, keyFingerprint, readBackupKey } from './crypto';
import { BackupRefused, type BackupManifest, type VerificationRecord } from './plan';

/**
 * IS THIS BACKUP STILL WHAT IT WAS? BACKUP-2.
 *
 * The logic behind `npm run backup:verify`, kept apart from the command that
 * runs it — `verify.ts` is the entry point and this is what it does. The split
 * is not tidiness: `restore-test.ts` needs to verify a backup before restoring
 * it, and importing the COMMAND to get at the function ran the command too,
 * which verified the directory twice and left two writers racing for the same
 * manifest. Pure logic here, `void main()` only in the entry points.
 *
 * BACKUP-1 recorded a SHA-256 of each artefact and stopped there, which was
 * honest about itself: a checksum nobody ever recomputes is a note, not a
 * check. This is the recomputation, and it is a command rather than something
 * folded into the backup run, because the question it answers is asked LATER —
 * of a directory that has since been rsynced to another host, copied onto a
 * disk and left in a drawer for a year.
 *
 * IT CHECKS TWO DIFFERENT THINGS, AND BOTH MATTER.
 *
 *   - The recorded SHA-256 of the file as stored. This catches bit rot, a
 *     truncated copy, an interrupted transfer — damage.
 *   - The GCM authentication tag, by actually decrypting. This catches
 *     ALTERATION: a checksum can be recomputed by whoever edited the file, and
 *     a tag cannot be forged without the key.
 *
 * AND IT DECRYPTS TO A TEMPORARY DIRECTORY IT THEN REMOVES. Verification must
 * not leave a plaintext copy of every customer's signed job card lying beside
 * the encrypted one — that would make running the check the most dangerous
 * thing an operator could do.
 */

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

export const readManifest = (directory: string): BackupManifest => {
  const path = join(directory, 'manifest.json');
  if (!existsSync(path)) {
    throw new BackupRefused(
      `${path} does not exist, so there is nothing saying what this directory should contain. ` +
        'A backup without its manifest cannot be verified.',
    );
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
  } catch {
    throw new BackupRefused(`${path} is not readable JSON. The manifest itself is damaged.`);
  }
};

/** Appends a dated record of a check to the manifest. */
export const recordVerification = (
  directory: string,
  manifest: BackupManifest,
  entry: VerificationRecord,
): void => {
  const updated: BackupManifest = {
    ...manifest,
    verifications: [...(manifest.verifications ?? []), entry],
  };
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(updated, null, 2)}\n`, {
    mode: 0o600,
  });
};

export interface VerifiedArtefact {
  readonly name: string;
  /** Where the decrypted bytes were put. The caller must delete this. */
  readonly plaintext: string;
}

/**
 * Verifies every artefact and leaves the decrypted copies in `workspace`.
 *
 * Used directly by `backup:restore-test`, which needs the decrypted dump it has
 * just verified rather than decrypting it a second time.
 */
export const verifyInto = async (
  directory: string,
  workspace: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ manifest: BackupManifest; artefacts: readonly VerifiedArtefact[] }> => {
  const manifest = readManifest(directory);
  const key = readBackupKey(env);

  /*
   * THE KEY IS CHECKED AGAINST THE FINGERPRINT FIRST.
   *
   * Decrypting with the wrong key fails on the authentication tag anyway, but
   * the message would say "altered or truncated, or the wrong key" and send an
   * operator looking for damage that is not there. The fingerprint turns that
   * into "this is not the key this backup was made with".
   */
  const fingerprint = keyFingerprint(key);
  if (manifest.encryption?.keyFingerprint !== undefined) {
    if (manifest.encryption.keyFingerprint !== fingerprint) {
      throw new BackupRefused(
        `this backup was encrypted with key ${manifest.encryption.keyFingerprint} and ` +
          `EJE_BACKUP_KEY is key ${fingerprint}. Nothing is wrong with the backup; the wrong ` +
          'key is configured.',
      );
    }
  }

  const verified: VerifiedArtefact[] = [];
  for (const artefact of manifest.artefacts) {
    const path = join(directory, artefact.name);
    if (!existsSync(path)) {
      throw new BackupRefused(
        `${artefact.name} is in the manifest and not in the directory. This backup is ` +
          'incomplete — a restore would find half of it.',
      );
    }

    const bytes = statSync(path).size;
    if (bytes !== artefact.bytes) {
      throw new BackupRefused(
        `${artefact.name} is ${bytes} bytes and the manifest records ${artefact.bytes}. ` +
          'The copy is damaged or was changed.',
      );
    }

    const digest = sha256(path);
    if (digest !== artefact.sha256) {
      throw new BackupRefused(
        `${artefact.name} does not match its recorded SHA-256. The bytes on this disk are not ` +
          'the bytes that were backed up.',
      );
    }

    // And now the half a checksum cannot do: decrypt, which authenticates.
    const plaintext = join(workspace, artefact.name.replace(/\.enc$/u, ''));
    const plainDigest = await decryptFile(path, plaintext, key);
    if (plainDigest !== artefact.plainSha256) {
      throw new BackupRefused(
        `${artefact.name} decrypted to something other than what was encrypted. The tag ` +
          'verified and the contents still do not match the manifest, which should be ' +
          'impossible — treat this backup as untrustworthy.',
      );
    }
    verified.push({ name: artefact.name, plaintext });
  }

  return { manifest, artefacts: verified };
};
