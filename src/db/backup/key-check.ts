import { readFileSync } from 'node:fs';
import { loadEnvFiles } from '@/db/seed/env';
import { keyFingerprint, KEY_RECIPE, readBackupKey } from './crypto';
import { readManifest } from './integrity';
import { KEY_BESIDE_BACKUP_WARNING, keyIsBesideBackup } from './key-location';

/**
 * IS THE KEY YOU ARE HOLDING THE KEY THIS BACKUP NEEDS? BACKUP-2.
 *
 * THE PROBLEM THIS EXISTS FOR, and it is the one that ends a business. The
 * encryption key must be recoverable from somewhere that is not the VPS —
 * a password manager, a sealed envelope, somebody's safe — and until somebody
 * has actually tried the escrowed copy against a real backup, "the key is in
 * the password manager" is a belief. The morning it matters is the worst
 * possible time to discover it was the wrong key, or last year's key, or a key
 * with a space on the end.
 *
 * SO THIS IS THE DRILL, and it is safe to run at any time:
 *
 *     npm run backup:key-check /var/backups/eje/eje-eje_production-<stamp>
 *     npm run backup:key-check <directory> --key-file /mnt/usb/eje-backup-key
 *
 * It compares a FINGERPRINT — a truncated SHA-256 of the key — against the one
 * the manifest recorded. It decrypts nothing, restores nothing, writes nothing
 * and touches neither the live database nor the live storage. With
 * `--key-file` it reads the candidate key from a file instead of the
 * environment, which is how an escrowed copy is tested without ever putting it
 * in a shell history or an environment file.
 *
 * WHAT IT DELIBERATELY DOES NOT PRINT: the key, any part of the key, or its
 * length. A fingerprint is not secret — it is in the manifest already — and
 * the output of this command will end up in a terminal somebody is sharing.
 *
 * WHAT A MATCH PROVES AND DOES NOT PROVE. It proves the escrowed key is the
 * key this backup was encrypted with. It does not prove the backup restores —
 * `npm run backup:restore-test` is the only thing that does, and it is a
 * separate command for exactly that reason.
 */

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
};

/** The candidate key: a file if one was named, otherwise the environment. */
const candidateKey = (): { key: Buffer; source: string; file: string | null } => {
  const file = argument('key-file');
  if (file === null) {
    return { key: readBackupKey(process.env), source: 'EJE_BACKUP_KEY', file: null };
  }

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `--key-file ${file} could not be read. Name a file containing the 64 hexadecimal ` +
        'characters and nothing else.',
    );
  }

  /*
   * TRIMMED, because an escrowed key arrives with a trailing newline from
   * `echo`, a space from a copy and paste, or CRLF from a Windows machine —
   * and a key that differs by one invisible character is indistinguishable
   * from the wrong key in every way that matters except this one.
   */
  const trimmed = raw.trim();
  if (!/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
    throw new Error(
      `--key-file ${file} does not contain 64 hexadecimal characters. It is not a backup key. ` +
        `(A key is made with \`${KEY_RECIPE}\`.) Its contents are not printed here.`,
    );
  }
  return { key: Buffer.from(trimmed, 'hex'), source: `--key-file ${file}`, file };
};

const main = (): void => {
  loadEnvFiles();

  const directory = process.argv.find((value, index) => index >= 2 && !value.startsWith('--'));
  if (directory === undefined) {
    throw new Error(
      'Name the backup directory to check against:\n\n' +
        '  npm run backup:key-check /var/backups/eje/eje-<database>-<stamp>\n' +
        '  npm run backup:key-check <directory> --key-file /mnt/usb/eje-backup-key\n',
    );
  }

  const manifest = readManifest(directory);
  const { key, source, file } = candidateKey();
  const mine = keyFingerprint(key);
  const theirs = manifest.encryption.keyFingerprint;

  process.stdout.write('\n=== EJE BACKUP KEY CHECK ===\n');
  process.stdout.write(`backup     ${directory}\n`);
  process.stdout.write(`taken      ${manifest.takenAt}\n`);
  process.stdout.write(`database   ${manifest.databaseName}\n`);
  process.stdout.write(`key from   ${source}\n`);
  process.stdout.write(`needs key  ${theirs}\n`);
  process.stdout.write(`you have   ${mine}\n\n`);

  /*
   * SAID BEFORE THE ANSWER, DELIBERATELY. A drill that ends in MATCH is read
   * as "we can recover", and a key kept in the backup directory makes that
   * conclusion wrong in the one scenario the drill exists for. It is a warning
   * rather than a refusal because the command's job is to answer a question
   * about a key, and refusing would stop an operator finding out which key
   * they are holding — but it is printed whether the answer is yes or no.
   */
  if (file !== null && keyIsBesideBackup(directory, file)) {
    process.stdout.write(`WARNING: ${KEY_BESIDE_BACKUP_WARNING}\n\n`);
  }

  if (mine === theirs) {
    process.stdout.write(
      'MATCH. This key can decrypt this backup.\n' +
        '\nIt does NOT prove the backup restores — `npm run backup:restore-test` is the only\n' +
        'thing that does. Nothing was decrypted, restored or written by this command.\n',
    );
    return;
  }

  process.stdout.write(
    'NO MATCH. This key CANNOT decrypt this backup.\n\n' +
      '  Nothing is wrong with the backup: it is the wrong key. Find the key whose\n' +
      `  fingerprint is ${theirs} — every manifest records the fingerprint of the key\n` +
      '  it was encrypted with, so an operator holding several can tell them apart.\n\n' +
      '  If no copy of that key exists anywhere but this server, this backup is\n' +
      '  unrecoverable the day the server is. See docs/vps-backups.md.\n',
  );
  process.exitCode = 1;
};

try {
  main();
} catch (cause) {
  process.stderr.write(`\n${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
}
