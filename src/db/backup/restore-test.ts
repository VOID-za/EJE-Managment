import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFiles } from '../seed/env';
import { extractArchiveSafely } from './archive';
import { recordVerification, verifyInto } from './integrity';
import { runPostgresTool } from './pg-client';
import { BackupRefused, databaseNameFrom, redactSecrets } from './plan';
import { skewDiagnosis } from './versions';
import {
  describeReferences,
  KEY_COLUMN_QUERY,
  keyColumnsFrom,
  partitionOrphans,
  referenceId,
  resolveReferences,
  unresolved,
  type StorageReference,
} from './references';
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

// The URL is passed as PG* variables and a password file, never as an argument.
const psql = (url: string, sql: string): { ok: boolean; stdout: string; stderr: string } =>
  runPostgresTool('psql', url, ['-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);

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

  /*
   * THE ONE PIECE OF CLEANING UP, REACHABLE FROM THREE DIRECTIONS. BACKUP-2.
   *
   * A restore test holds two things that must not outlive it: a scratch
   * database containing a COPY OF THE WHOLE PRODUCTION DATABASE, and a
   * workspace containing the decrypted dump and every customer's signed job
   * card in plaintext. `finally` covers success and failure. It does not cover
   * the third case, which is the likely one in practice — an operator pressing
   * Ctrl-C because the restore is taking longer than they expected, or a
   * deployment script timing out and sending SIGTERM. Before this, that left
   * the plaintext and the copy on the disk, and the encryption with it.
   *
   * Idempotent, because `finally` and a signal can both reach it, and because
   * dropping a database twice is not something to find out about at 2am.
   */
  /*
   * WRITTEN SYNCHRONOUSLY, because the caller may be a signal handler that
   * exits immediately afterwards. `process.stderr.write` to a PIPE is
   * asynchronous in Node, so `process.exit` on the next line throws the
   * message away — which is how the first version of this reported nothing at
   * all about the cleanup it had just performed.
   */
  const warn = (text: string): void => {
    writeSync(2, text);
  };

  let cleaned = false;
  const cleanUp = (): void => {
    if (cleaned) return;
    cleaned = true;
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
        warn(`restore  WARNING: ${cause instanceof Error ? cause.message : String(cause)}\n`);
      }
    }
    rmSync(workspace, { recursive: true, force: true });
    if (existsSync(workspace)) {
      warn(`restore  WARNING: ${workspace} still exists and holds plaintext\n`);
    }
  };

  /*
   * `once`, and the exit code a shell expects for each signal, so a CI job or
   * a wrapper script can still tell it was interrupted rather than failing a
   * check. The handlers are removed in `finally`: this module is also imported
   * by nothing else, but a process-wide listener that outlives the work it was
   * protecting is a leak waiting to be inherited.
   */
  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => () => {
    warn(`restore  ${signal} — cleaning up before exit\n`);
    cleanUp();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const interrupted = onSignal('SIGINT');
  const terminated = onSignal('SIGTERM');
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);

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
    // `--dbname` is the scratch database's NAME; the server and the
    // credentials come from the environment `runPostgresTool` builds.
    const restored = runPostgresTool('pg_restore', target, [
      '--dbname',
      scratch,
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      dump,
    ]);
    if (!restored.ok) {
      const stderr = redactSecrets(restored.stderr, databaseUrl);
      /*
       * The version mismatch names a "configuration parameter", which reads
       * like a server misconfiguration and sends an operator to
       * postgresql.conf. It is not that — see `versions.ts`.
       */
      throw new BackupRefused(`pg_restore refused this dump: ${stderr}${skewDiagnosis(stderr)}`);
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
    /*
     * JUDGED BEFORE IT IS UNPACKED. An archive that has been rsynced, carried
     * on a disk and handed over by somebody else is not trusted to describe
     * only ordinary files under its own root — see `archive.ts` for the four
     * refusals and the two ceilings.
     */
    const { files } = await extractArchiveSafely(archive, unpacked);
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
    const keyTables = psql(target, KEY_COLUMN_QUERY);
    if (!keyTables.ok) throw new BackupRefused(`could not read the restored schema: ${keyTables.stderr}`);

    const present = new Set(files);
    const references: StorageReference[] = [];
    for (const { table, column } of keyColumnsFrom(keyTables.stdout)) {
      const keys = psql(target, `SELECT ${column} FROM public.${table} WHERE ${column} IS NOT NULL`);
      if (!keys.ok) throw new BackupRefused(`could not read ${table}.${column}: ${keys.stderr}`);
      for (const storageKey of keys.stdout.split('\n').filter((line) => line.length > 0)) {
        references.push({ table, storageKey });
      }
    }

    /*
     * RESOLUTION IS THE ADAPTER'S OWN, AND THAT IS THE FIX. BACKUP-1.
     *
     * This used to be `present.has(key)` — a storage key against a file name.
     * The store writes `<key>.bin` and `<key>.json`, so it matched NOTHING and
     * every reference in the database was reported as a missing document: the
     * "25 document references without corresponding stored files" an operator
     * saw on a deployment whose documents were mostly there. A check that
     * fails on a healthy backup gets switched off with
     * EJE_RESTORE_ALLOW_ORPHANS, and then it is not a check.
     */
    const resolvedReferences = resolveReferences(references, present);
    const orphanRefs = unresolved(resolvedReferences);
    const referenced = references.length;

    /*
     * AND WHAT IS LEFT IS DIVIDED BY WHOSE FAULT IT IS. The backup recorded
     * the references that had no file at the moment it ran; anything missing
     * now that is NOT on that list was lost between then and here, which is
     * fatal however the flags are set.
     */
    const recordedDangling = new Set(
      (manifest.danglingReferences ?? []).map((entry) => referenceId(entry)),
    );
    const knowsWhatWasDangling = manifest.danglingReferences !== undefined;
    const partition = partitionOrphans(orphanRefs, recordedDangling);
    const orphans = orphanRefs.map((entry) => referenceId(entry));

    /*
     * THE WHOLE LIST, IN A FILE, rather than three examples in a sentence. An
     * operator deciding whether a document is genuinely gone needs to see
     * which ones, and a message truncated to three cannot tell them.
     */
    if (orphanRefs.length > 0) {
      const reportPath = join(directory, 'unresolved-references.json');
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            checkedAt: now.toISOString(),
            referenced,
            resolved: referenced - orphanRefs.length,
            alreadyMissingWhenTaken: partition.preExisting,
            lostByThisBackup: partition.lost,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      process.stdout.write(`restore  every unresolved reference is listed in ${reportPath}\n`);
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
    process.stdout.write(
      `${describeReferences({
        total: referenced,
        resolvedCount: referenced - orphanRefs.length,
        partition,
      })
        .split('\n')
        .map((line) => `restore  ${line}`)
        .join('\n')}\n`,
    );

    /*
     * A DOCUMENT THIS BACKUP LOST IS ALWAYS FATAL, and no flag changes that.
     *
     * `EJE_RESTORE_ALLOW_ORPHANS` survives for one narrower job: a manifest
     * written before the dangling list existed knows nothing, so everything
     * missing reads as lost, and an operator who KNOWS the deployment was
     * seeded rather than worked in can say so. It cannot excuse a document
     * that the backup's own manifest says was there.
     */
    const allowOrphans = (process.env.EJE_RESTORE_ALLOW_ORPHANS ?? '').trim() === 'yes';
    if (partition.lost.length > 0 && !(allowOrphans && !knowsWhatWasDangling)) {
      throw new BackupRefused(
        `${partition.lost.length} of ${referenced} restored row(s) point at documents that are ` +
          'not in this backup and were not recorded as missing when it was taken — for example ' +
          `${partition.lost.slice(0, 3).map(referenceId).join(', ')}. THIS IS THE FAILURE ` +
          'BACKUP-1 EXISTS TO PREVENT: the database came back and a signed job card did not. ' +
          `The full list is in ${join(directory, 'unresolved-references.json')}. ` +
          (knowsWhatWasDangling
            ? 'This backup DID record which references were already dangling, and these are not ' +
              'among them, so they were lost between the backup and now. Do not accept this ' +
              'backup as a restore point for those documents.'
            : 'This backup predates that record, so nothing can be called pre-existing on its ' +
              'evidence. If the deployment was seeded rather than worked in, re-run with ' +
              'EJE_RESTORE_ALLOW_ORPHANS=yes and the count goes into the manifest rather than ' +
              'being hidden.'),
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
          : `${partition.preExisting.length} already missing when taken, ` +
            `${partition.lost.length} unaccounted for` +
            (partition.lost.length > 0 ? ' and ACCEPTED UNDER EJE_RESTORE_ALLOW_ORPHANS.' : '.')),
    });

    process.stdout.write(
      `restore  ${directory}\n` +
        `restore  dump restored into ${scratch} on the same server, then dropped\n` +
        `restore  ${counts.join('  ')}\n` +
        `restore  ${files.length} document(s) unpacked\n` +
        (partition.lost.length === 0
          ? ''
          : `restore  WARNING: ${partition.lost.length} storage key(s) were lost and accepted ` +
            'under EJE_RESTORE_ALLOW_ORPHANS; the manifest records that\n') +
        'restore  RESTORE-TESTED — recorded in manifest.json\n',
    );
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    cleanUp();
  }
};

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`restore  FAILED: ${message}\n`);
  process.exitCode = 1;
});
