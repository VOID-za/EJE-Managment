import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFiles } from '../seed/env';
import { recordVerification, verifyInto } from './integrity';
import { BackupRefused, databaseNameFrom, redactSecrets } from './plan';
import {
  assertSafeToDrop,
  claimScratchDatabase,
  postgresScratchServer,
  withDatabase,
} from './scratch';

/**
 * `npm run backup:restore-test <directory>` — PROVING A BACKUP CAN BE
 * RESTORED, BY RESTORING IT. BACKUP-2.
 *
 * The last and only honest part of the requirement. A dump `pg_restore --list`
 * can read, with checksums that match and a tag that verifies, is a file that
 * LOOKS restorable; every one of those checks can pass on an archive that
 * `pg_restore` then refuses halfway through. The only evidence that a backup
 * works is a database built out of it.
 *
 * AND IT CHECKS THE THING THIS SYSTEM ACTUALLY DEPENDS ON. `job_media`,
 * `final_documents`, `machine_photos`, `checklist_answer_photos` and
 * `library_document_versions` hold a `storage_key` and no bytes — the bytes are
 * files under `EJE_STORAGE_DIR`. So the test restores the database AND unpacks
 * the archive, then walks every storage key in the restored database and
 * demands the file. That is the failure BACKUP-1 was written to prevent,
 * checked rather than argued: a restored row pointing at a signed job card
 * that is not there.
 *
 * WHAT IT WILL NOT DO. It will not touch the database it is restoring a copy
 * OF. It creates its own database, whose name it generates and then checks
 * against both a pattern and the source's name, and it drops only that. It
 * refuses a name that already exists rather than replacing it. Nothing here
 * takes a name from the manifest, because a manifest is a file somebody could
 * have edited.
 */

/** Tables whose loss would end the business. Asserted present by name. */
const CORE_TABLES = [
  'jobs',
  'users',
  'customers',
  'machines',
  'final_documents',
  'job_media',
  'job_signatures',
  'audit_events',
] as const;

const run = (
  command: string,
  args: readonly string[],
): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    return { ok: false, stdout: '', stderr: `${command} could not be run: ${result.error.message}` };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
  };
};

const psql = (url: string, sql: string): { ok: boolean; stdout: string; stderr: string } =>
  run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);

/** Every file under a directory, as paths relative to it. */
const filesUnder = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1));
};

const main = async (): Promise<void> => {
  loadEnvFiles();
  const directory = process.argv[2];
  if (directory === undefined || directory.length === 0) {
    throw new BackupRefused(
      'Name the backup directory to restore-test: npm run backup:restore-test <directory>',
    );
  }

  const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
  if (databaseUrl.length === 0) {
    throw new BackupRefused(
      'DATABASE_URL is not set. A restore test needs a PostgreSQL SERVER to build its own ' +
        'scratch database on; it never writes to the database named in that URL.',
    );
  }

  const now = new Date();
  const source = databaseNameFrom(databaseUrl);
  const admin = withDatabase(databaseUrl, 'postgres');
  const server = postgresScratchServer(admin);
  const workspace = mkdtempSync(join(tmpdir(), 'eje-restore-'), { mode: 0o700 } as never);
  /*
   * Named only once it has been CLAIMED, so there is no window in which this
   * command believes it owns a database it has not created.
   */
  let scratch: string | null = null;

  try {
    // ---- 1. integrity, and the decrypted artefacts ------------------------
    const { manifest, artefacts } = await verifyInto(directory, workspace, process.env);
    const dump = artefacts.find((entry) => entry.name.startsWith('database.dump'))?.plaintext;
    const archive = artefacts.find((entry) => entry.name.startsWith('storage.tar.gz'))?.plaintext;
    if (dump === undefined || archive === undefined) {
      throw new BackupRefused(
        'this backup does not contain both a database dump and a document archive, so there ' +
          'is no point restoring half of it.',
      );
    }

    // ---- 2. a database of its own ----------------------------------------
    scratch = claimScratchDatabase(server, source, now);
    const target = withDatabase(databaseUrl, scratch);

    // ---- 3. the restore itself -------------------------------------------
    const restored = run('pg_restore', [
      '--dbname',
      target,
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      dump,
    ]);
    if (!restored.ok) {
      throw new BackupRefused(
        `pg_restore refused this dump: ${redactSecrets(restored.stderr, databaseUrl)}`,
      );
    }

    // ---- 4. the records that matter are there ----------------------------
    const missing: string[] = [];
    const counts: string[] = [];
    for (const table of CORE_TABLES) {
      const present = psql(
        target,
        `SELECT to_regclass('public.${table}') IS NOT NULL`,
      );
      if (!present.ok || present.stdout.trim() !== 't') {
        missing.push(table);
        continue;
      }
      const rows = psql(target, `SELECT count(*) FROM public.${table}`);
      counts.push(`${table}=${rows.stdout.trim()}`);
    }
    if (missing.length > 0) {
      throw new BackupRefused(
        `the restored database has no ${missing.join(', ')}. The dump restored and the ` +
          'business records are not in it.',
      );
    }

    // ---- 5. the documents, and the rows that point at them ---------------
    const unpacked = join(workspace, 'storage');
    mkdirSync(unpacked, { recursive: true, mode: 0o700 });
    const untarred = run('tar', ['-xzf', archive, '-C', unpacked]);
    if (!untarred.ok) {
      throw new BackupRefused(`the document archive would not unpack: ${untarred.stderr}`);
    }

    const files = await filesUnder(unpacked);
    if (files.length !== manifest.storedFiles) {
      throw new BackupRefused(
        `the archive unpacked to ${files.length} files and the manifest records ` +
          `${manifest.storedFiles}. A restore would be missing documents.`,
      );
    }

    /*
     * THE CROSS-CHECK. Which tables carry a storage key is read from the
     * RESTORED database rather than written out here, so a table added later
     * is covered by this check without anybody remembering to come back.
     */
    const keyTables = psql(
      target,
      "SELECT table_name FROM information_schema.columns WHERE column_name = 'storage_key' " +
        "AND table_schema = 'public' ORDER BY 1",
    );
    if (!keyTables.ok) throw new BackupRefused(`could not read the restored schema: ${keyTables.stderr}`);

    const present = new Set(files);
    const orphans: string[] = [];
    let referenced = 0;
    for (const table of keyTables.stdout.split('\n').filter((line) => line.length > 0)) {
      const keys = psql(target, `SELECT storage_key FROM public.${table}`);
      if (!keys.ok) throw new BackupRefused(`could not read ${table}: ${keys.stderr}`);
      for (const key of keys.stdout.split('\n').filter((line) => line.length > 0)) {
        referenced += 1;
        if (!present.has(key)) orphans.push(`${table}:${key}`);
      }
    }
    /*
     * ORPHANS ARE A FAILURE, AND THE FLAG DOES NOT MAKE THEM PASS QUIETLY.
     *
     * A restore that cannot produce a signed job card the restored database
     * refers to is a failed restore, so this is loud by default. But the cause
     * is not always the backup: a database seeded for development has
     * `final_documents` rows whose PDFs were never generated, and they were
     * already dangling before `pg_dump` ran. `EJE_RESTORE_ALLOW_ORPHANS=yes`
     * says "I know, this is that database" — and the count still goes into the
     * manifest, because a restore test whose record cannot be told apart from a
     * clean one is worth nothing.
     */
    const allowOrphans = (process.env.EJE_RESTORE_ALLOW_ORPHANS ?? '').trim() === 'yes';
    if (orphans.length > 0 && !allowOrphans) {
      throw new BackupRefused(
        `${orphans.length} of ${referenced} restored row(s) point at documents that are not in ` +
          `the backup — for example ${orphans.slice(0, 3).join(', ')}. THIS IS THE FAILURE ` +
          'BACKUP-1 EXISTS TO PREVENT: the database came back and a signed job card did not. ' +
          'If these rows were ALREADY dangling before the backup was taken — which is true of ' +
          'a development database that was seeded rather than worked in — re-run with ' +
          'EJE_RESTORE_ALLOW_ORPHANS=yes, and the count will be recorded in the manifest ' +
          'rather than hidden.',
      );
    }

    // ---- 6. say so, in the manifest --------------------------------------
    recordVerification(directory, manifest, {
      kind: 'restore',
      at: now.toISOString(),
      detail:
        `restored into a scratch database and dropped again; ${counts.join(' ')}; ` +
        `${files.length} document(s) unpacked; ${referenced} storage key(s) referenced, ` +
        (orphans.length === 0
          ? 'all resolved.'
          : `${orphans.length} UNRESOLVED and accepted under EJE_RESTORE_ALLOW_ORPHANS.`),
    });

    process.stdout.write(
      `restore  ${directory}\n` +
        `restore  dump restored into ${scratch} on the same server, then dropped\n` +
        `restore  ${counts.join('  ')}\n` +
        `restore  ${files.length} document(s), ${referenced} storage key(s), ` +
        `${orphans.length} missing\n` +
        (orphans.length === 0
          ? ''
          : `restore  WARNING: ${orphans.length} storage key(s) did not resolve, accepted ` +
            'under EJE_RESTORE_ALLOW_ORPHANS and recorded in the manifest\n') +
        'restore  RESTORE-TESTED — recorded in manifest.json\n',
    );
  } finally {
    if (scratch !== null) {
      /*
       * ONLY THE DATABASE THIS INVOCATION CLAIMED, and checked again right
       * here: the first check was fifty lines ago and this is the line that
       * destroys something. Dropped whatever happened above — a failed restore
       * test that leaves a copy of the production database on the server has
       * created the very exposure the encryption was for.
       */
      assertSafeToDrop(scratch, source);
      try {
        server.drop(scratch);
      } catch (cause: unknown) {
        process.stderr.write(
          `restore  WARNING: ${cause instanceof Error ? cause.message : String(cause)}\n`,
        );
      }
    }
    rmSync(workspace, { recursive: true, force: true });
    if (existsSync(workspace)) {
      process.stderr.write(`restore  WARNING: ${workspace} still exists and holds plaintext\n`);
    }
  }
};

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`restore  FAILED: ${message}\n`);
  process.exitCode = 1;
});
