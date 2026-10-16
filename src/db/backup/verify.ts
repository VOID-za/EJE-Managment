import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFiles } from '../seed/env';
import { recordVerification, verifyInto } from './integrity';
import { BackupRefused } from './plan';

/**
 * `npm run backup:verify <directory>` — the command. BACKUP-2.
 *
 * The checking itself is in `integrity.ts`; this is the entry point, and it is
 * thin on purpose. Anything that lives here runs when the module is IMPORTED,
 * which is how an earlier version of this file came to run a whole verification
 * from inside `restore-test.ts`.
 *
 * It decrypts into a temporary directory and removes it on the way out, pass or
 * fail. Verification must not leave a plaintext copy of every customer's signed
 * job card beside the encrypted one — that would make running the check the
 * most dangerous thing an operator could do.
 */
const main = async (): Promise<void> => {
  loadEnvFiles();
  const directory = process.argv[2];
  if (directory === undefined || directory.length === 0) {
    throw new BackupRefused(
      'Name the backup directory to verify: npm run backup:verify <directory>',
    );
  }

  const workspace = mkdtempSync(join(tmpdir(), 'eje-verify-'), { mode: 0o700 } as never);
  try {
    const { manifest, artefacts } = await verifyInto(directory, workspace, process.env);
    recordVerification(directory, manifest, {
      kind: 'integrity',
      at: new Date().toISOString(),
      detail: `${artefacts.length} artefact(s): recorded SHA-256 matched and each decrypted and authenticated.`,
    });
    process.stdout.write(
      `verify   ${directory}\n` +
        `verify   taken ${manifest.takenAt}, database ${manifest.databaseName}\n` +
        artefacts.map((entry) => `verify   ${entry.name} intact and authentic\n`).join('') +
        'verify   OK — and still NOT restore-tested unless the manifest says so.\n',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
};

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`verify   FAILED: ${message}\n`);
  process.exitCode = 1;
});
