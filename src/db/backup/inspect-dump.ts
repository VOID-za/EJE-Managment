import { spawnSync } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';
import { loadEnvFiles } from '../seed/env';
import { BackupRefused, databaseNameFrom, redactSecrets } from './plan';
import {
  assertSafeToDrop,
  claimScratchDatabase,
  postgresScratchServer,
  withDatabase,
} from './scratch';

/**
 * `npm run dump:inspect <file.dump>` — WHAT IS IN AN OLD DUMP, WITHOUT
 * RESTORING OVER ANYTHING. BACKUP-2.
 *
 * WHAT IT IS FOR. There are hand-made dumps on the live server from before any
 * of this existed — `/opt/eje/eje-backup-20260925-092747.dump` and
 * `/opt/eje/eje_production_pre_947ef4f_20260924_193700.dump`. When a document
 * is missing, the first question is whether an older copy of the REGISTER says
 * anything useful about it: what its storage key was, when it was issued, what
 * the row recorded. Answering that by restoring the dump over the live database
 * is unthinkable, and reading it with `pg_restore --list` answers nothing about
 * rows — a table of contents is not data, which is why the first attempt at
 * this on the server came back empty.
 *
 * SO IT RESTORES INTO A DATABASE OF ITS OWN AND DROPS IT. Exactly the mechanism
 * `backup:restore-test` uses: a generated name, checked against a pattern AND
 * against the name of the database in `DATABASE_URL`, created here and dropped
 * here, on success, on failure, and on Ctrl-C. It never writes to the database
 * named in `DATABASE_URL`; that URL is used only to reach the SERVER.
 *
 * WHAT A DUMP CANNOT GIVE YOU, and the command says this every time: documents.
 * `final_documents` holds a key and the bytes live under `EJE_STORAGE_DIR`, so
 * a dump can tell you a job card was issued and what it was called, and it can
 * never give you the PDF. Only a storage archive has that.
 */

const run = (
  command: string,
  args: readonly string[],
): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    return { ok: false, stdout: '', stderr: `${command} could not be run: ${result.error.message}` };
  }
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim() };
};

const psql = (url: string, sql: string): { ok: boolean; stdout: string; stderr: string } =>
  run('psql', [url, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);

/** The questions worth asking of an old register, in the order they are asked. */
const QUESTIONS: readonly { readonly label: string; readonly sql: string }[] = [
  { label: 'jobs', sql: 'select count(*)::text from jobs' },
  { label: 'customers', sql: 'select count(*)::text from customers' },
  { label: 'signatures', sql: 'select count(*)::text from job_signatures' },
  { label: 'final documents', sql: 'select count(*)::text from final_documents' },
  {
    label: 'documents WITH a recorded size',
    sql: 'select count(*)::text from final_documents where size_bytes > 0',
  },
  {
    label: 'documents WITH a checksum',
    sql: 'select count(*)::text from final_documents where checksum_sha256 is not null',
  },
  { label: 'machine photographs', sql: 'select count(*)::text from machine_photos' },
  { label: 'library versions', sql: 'select count(*)::text from library_document_versions' },
];

const main = async (): Promise<void> => {
  loadEnvFiles();
  const file = process.argv[2];
  if (file === undefined || file.length === 0) {
    throw new BackupRefused('Name the dump to inspect: npm run dump:inspect <file.dump>');
  }
  if (!existsSync(file)) throw new BackupRefused(`${file} does not exist.`);

  const databaseUrl = (process.env.DATABASE_URL ?? '').trim();
  if (databaseUrl.length === 0) {
    throw new BackupRefused(
      'DATABASE_URL is not set. This needs a PostgreSQL SERVER to build its own scratch ' +
        'database on; it never writes to the database named in that URL.',
    );
  }

  const source = databaseNameFrom(databaseUrl);
  const admin = withDatabase(databaseUrl, 'postgres');
  const server = postgresScratchServer(admin);
  let scratch: string | null = null;

  const warn = (text: string): void => {
    writeSync(2, text);
  };

  let cleaned = false;
  const cleanUp = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (scratch === null) return;
    // Checked again on the line that destroys something, as in restore-test.
    assertSafeToDrop(scratch, source);
    try {
      server.drop(scratch);
    } catch (cause: unknown) {
      warn(`inspect  WARNING: ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  };

  const onSignal = (signal: 'SIGINT' | 'SIGTERM') => () => {
    warn(`inspect  ${signal} — dropping the scratch database before exit\n`);
    cleanUp();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const interrupted = onSignal('SIGINT');
  const terminated = onSignal('SIGTERM');
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', terminated);

  try {
    // A table of contents first: it is free, and it fails early on a file that
    // is not a custom-format dump at all.
    const listed = run('pg_restore', ['--list', file]);
    if (!listed.ok) {
      throw new BackupRefused(
        `pg_restore cannot read ${file}: ${listed.stderr}. If it is a plain-text dump, inspect ` +
          'it with `grep` instead — this command only reads the custom format.',
      );
    }

    scratch = claimScratchDatabase(server, source, new Date());
    const target = withDatabase(databaseUrl, scratch);

    /*
     * NOT `--exit-on-error`, unlike the restore test. An old dump may well
     * carry roles or extensions this server does not have, and the question
     * being asked is "what does the register say", not "is this dump a valid
     * restore point". Errors are reported and the inspection continues.
     */
    const restored = run('pg_restore', ['--dbname', target, '--no-owner', '--no-privileges', file]);
    if (!restored.ok) {
      warn(
        `inspect  pg_restore reported problems (continuing): ` +
          `${redactSecrets(restored.stderr, databaseUrl).split('\n').slice(0, 5).join(' | ')}\n`,
      );
    }

    process.stdout.write(`\n=== DUMP INSPECTION: ${file} ===\n`);
    process.stdout.write(`restored into ${scratch}, which is dropped when this finishes\n\n`);

    for (const question of QUESTIONS) {
      const answer = psql(target, question.sql);
      process.stdout.write(
        `${question.label.padEnd(32)} ${answer.ok ? answer.stdout.trim() : 'not in this dump'}\n`,
      );
    }

    /*
     * AND THE PART A PERSON ACTUALLY NEEDS: which job cards this register says
     * were issued, with the key the bytes were under. That is what you compare
     * against the storage directory when deciding whether something is lost.
     */
    const documents = psql(
      target,
      "select j.job_number || '  ' || d.storage_key || '  ' || " +
        "to_char(d.generated_at, 'YYYY-MM-DD') || '  ' || d.size_bytes::text " +
        'from final_documents d join jobs j on j.id = d.job_id order by j.job_number',
    );
    if (documents.ok && documents.stdout.trim().length > 0) {
      process.stdout.write('\nfinal documents this register recorded (job, key, issued, size):\n');
      for (const line of documents.stdout.split('\n').filter((entry) => entry.length > 0)) {
        process.stdout.write(`  ${line}\n`);
      }
    }

    process.stdout.write(
      '\nA DUMP CONTAINS NO DOCUMENTS. `final_documents` holds a storage key; the bytes live\n' +
        'under EJE_STORAGE_DIR and only a storage archive (storage.tar.gz.enc in a backup taken\n' +
        'by `npm run backup`) can give them back. This tells you what the register SAID.\n',
    );
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', terminated);
    cleanUp();
  }
};

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`inspect  FAILED: ${message}\n`);
  process.exitCode = 1;
});
