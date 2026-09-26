import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFiles } from '../seed/env';
import {
  BackupRefused,
  buildManifest,
  planBackup,
  redactSecrets,
  type ArtefactRecord,
  type BackupPlan,
} from './plan';

/**
 * `npm run backup` — the database AND the documents, together. BACKUP-1.
 *
 * WHY IT SHELLS OUT. `pg_dump` and `tar` are the tools whose output a restore
 * will actually be performed with, by a person at a terminal who may not have
 * this repository. Reimplementing either in Node would produce an archive
 * format only this script understands, which is the opposite of what a backup
 * is for.
 *
 * WHAT IT WILL NOT DO. It will not report success on half a backup. If the
 * documents cannot be archived, the database dump is removed with it and the
 * command fails — see `abort`. A directory containing only `database.dump`
 * would be found by somebody in a hurry and trusted.
 */
const run = (command: string, args: readonly string[]): { ok: boolean; stderr: string } => {
  const result = spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error !== undefined) {
    return { ok: false, stderr: `${command} could not be run: ${result.error.message}` };
  }
  return { ok: result.status === 0, stderr: (result.stderr ?? '').trim() };
};

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Measures and checksums an artefact, and takes everyone else off it first.
 *
 * `pg_dump -f` and `tar -czf` create their output with the process umask, which
 * on a default install is 0644. The directory is 0700, so nothing can reach
 * them through it today — but these two files are a complete copy of the
 * database and every customer's signed job card, and they will be moved,
 * rsynced and copied by people who are not thinking about the umask of the
 * process that made them. The mode travels with the file; the directory's does
 * not. Rule 27.
 */
const record = (destination: string, name: string): ArtefactRecord => {
  const path = join(destination, name);
  chmodSync(path, 0o600);
  return { name, bytes: statSync(path).size, sha256: sha256(path) };
};

/** Every file under a directory, recursively. The count the archive must match. */
const countFiles = async (root: string): Promise<number> => {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).length;
};

const appCommit = (): string => {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  return result.status === 0 ? (result.stdout ?? '').trim() : 'unknown';
};

/**
 * Takes the half-written backup away.
 *
 * The whole point of the requirement is that a restore has both halves. A
 * partial directory left on disk is a trap, so it goes, and the failure is
 * loud.
 */
const abort = (destination: string, message: string): never => {
  rmSync(destination, { recursive: true, force: true });
  throw new BackupRefused(message);
};

const backup = async (plan: BackupPlan, now: Date): Promise<void> => {
  if (existsSync(plan.destination)) {
    throw new BackupRefused(
      `${plan.destination} already exists. A backup never overwrites another one.`,
    );
  }

  const storageMissing = !existsSync(plan.storageRoot);
  if (storageMissing && !plan.allowEmptyStorage) {
    throw new BackupRefused(
      `The document directory ${plan.storageRoot} does not exist, so the signed job cards ` +
        'cannot be backed up. This is almost always a misconfigured EJE_STORAGE_DIR, which is ' +
        'why it is refused rather than skipped. On a genuinely fresh deployment with nothing ' +
        'stored yet, run it again with EJE_BACKUP_ALLOW_EMPTY=yes.',
    );
  }

  /*
   * 0700, BEFORE ANYTHING IS WRITTEN INTO IT.
   *
   * This directory is about to hold every customer's signed job card and a
   * complete copy of the database. Creating it world-readable and tightening it
   * afterwards would leave a window, so the mode is set at creation.
   */
  mkdirSync(plan.destination, { recursive: true, mode: 0o700 });

  // ---- the database -------------------------------------------------------
  const dump = join(plan.destination, 'database.dump');
  const dumped = run('pg_dump', ['-Fc', '--no-password', '-f', dump, plan.databaseUrl]);
  if (!dumped.ok) {
    abort(plan.destination, `pg_dump failed: ${redactSecrets(dumped.stderr, plan.databaseUrl)}`);
  }

  // Readable, not merely present. An empty or truncated dump restores nothing.
  const listed = run('pg_restore', ['--list', dump]);
  if (!listed.ok) {
    abort(plan.destination, `the dump was written but pg_restore cannot read it: ${listed.stderr}`);
  }

  // ---- the documents ------------------------------------------------------
  const archive = join(plan.destination, 'storage.tar.gz');
  const storedFiles = storageMissing ? 0 : await countFiles(plan.storageRoot);

  const archived = storageMissing
    ? run('tar', ['-czf', archive, '--files-from', '/dev/null'])
    : run('tar', ['-czf', archive, '-C', plan.storageRoot, '.']);
  if (!archived.ok) {
    abort(plan.destination, `the documents could not be archived: ${archived.stderr}`);
  }

  /*
   * THE COUNT HAS TO MATCH.
   *
   * `tar` exits 0 having skipped a file it could not read, which is exactly the
   * failure this requirement exists to catch: a backup that ran, reported
   * success, and silently left out the one signed job card whose permissions
   * were wrong.
   */
  const inArchive = run('tar', ['-tzf', archive]);
  if (!inArchive.ok) {
    abort(plan.destination, `the archive was written but tar cannot read it: ${inArchive.stderr}`);
  }
  const archivedFiles = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter((line) => line.length > 0 && !line.endsWith('/')).length;

  if (archivedFiles !== storedFiles) {
    abort(
      plan.destination,
      `the archive holds ${archivedFiles} files but ${plan.storageRoot} holds ${storedFiles}. ` +
        'Something was not readable, so this backup is incomplete and has been removed.',
    );
  }

  if (storedFiles === 0 && !plan.allowEmptyStorage) {
    abort(
      plan.destination,
      `${plan.storageRoot} holds no files at all. On a deployment that has issued job cards ` +
        'that means the documents are already gone, so it is refused rather than recorded as a ' +
        'successful backup. Use EJE_BACKUP_ALLOW_EMPTY=yes if the deployment really is new.',
    );
  }

  // ---- the manifest -------------------------------------------------------
  const manifest = buildManifest({
    plan,
    now,
    storedFiles,
    artefacts: [record(plan.destination, 'database.dump'), record(plan.destination, 'storage.tar.gz')],
    appCommit: appCommit(),
  });
  writeFileSync(join(plan.destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });

  process.stdout.write(
    `backup   ${plan.destination}\n` +
      `backup   database ${plan.databaseName}, ${manifest.artefacts[0]?.bytes ?? 0} bytes\n` +
      `backup   documents ${storedFiles} files, ${manifest.artefacts[1]?.bytes ?? 0} bytes\n` +
      'backup   NOT encrypted and NOT restore-tested — BACKUP-2 owns both.\n',
  );
};

/*
 * No top-level await.
 *
 * `tsx` transpiles this to CommonJS, which cannot `require` a module that awaits
 * at the top level — the failure is an opaque `ERR_REQUIRE_ASYNC_MODULE` rather
 * than anything about backups. A `main` that reports and sets the exit code is
 * also what makes the command usable from cron, which reads the status and
 * nothing else.
 */
const main = async (): Promise<void> => {
  loadEnvFiles();
  const now = new Date();
  await backup(planBackup(process.env, now, process.cwd()), now);
};

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`backup   REFUSED: ${message}\n`);
  process.exitCode = 1;
});
