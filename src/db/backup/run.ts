import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { loadEnvFiles } from '../seed/env';
import { encryptFile, keyFingerprint } from './crypto';
import { filesUnder } from './archive';
import {
  resolveReferences,
  scansForReferences,
  unresolved,
  type StorageReference,
} from './references';
import { planOffsite, rcloneCommands, sameMediaWarning } from './offsite';
import { chooseBackupsToPrune, readRetention } from './retention';
import {
  BackupRefused,
  buildManifest,
  planBackup,
  redactSecrets,
  type ArtefactRecord,
  type BackupPlan,
  type DanglingReference,
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
/**
 * Encrypts an artefact in place and takes the plaintext away. BACKUP-2.
 *
 * `database.dump` becomes `database.dump.enc` and the original is removed in the
 * same step, because a directory holding both is a directory holding the
 * plaintext. The checksum of the original is kept in the manifest — that is
 * what a restore checks after decrypting, and it is the only thing that can
 * prove the bytes that came out are the bytes that went in.
 */
const seal = async (
  destination: string,
  name: string,
  key: Buffer,
): Promise<ArtefactRecord> => {
  const plain = join(destination, name);
  const sealed = `${plain}.enc`;
  const encrypted = await encryptFile(plain, sealed, key);
  rmSync(plain, { force: true });
  chmodSync(sealed, 0o600);
  return {
    name: `${name}.enc`,
    bytes: encrypted.bytes,
    sha256: encrypted.sha256,
    plainSha256: encrypted.plainSha256,
  };
};

/**
 * Every storage key the database refers to, and which table refers to it.
 *
 * READ FROM `information_schema` RATHER THAN A LIST IN THIS FILE, for the same
 * reason the restore test does it: a table that gains a `storage_key` column
 * later is covered without anybody remembering to come back here. Five tables
 * carry one today.
 *
 * A failure to read them is NOT fatal to the backup. The dump and the archive
 * are what a restore needs; this list only tells a later restore test which
 * references were already dangling, and a backup that refused itself over a
 * missing nicety would be a worse outcome than one whose manifest says less.
 */
const referencedStorageKeys = (
  databaseUrl: string,
): { readonly keys: readonly StorageReference[]; readonly read: boolean } => {
  const tables = spawnSync(
    'psql',
    [
      databaseUrl,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      "SELECT table_name FROM information_schema.columns WHERE column_name = 'storage_key' " +
        "AND table_schema = 'public' ORDER BY 1",
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (tables.status !== 0) return { keys: [], read: false };

  const keys: StorageReference[] = [];
  for (const table of (tables.stdout ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .filter(scansForReferences)) {
    const rows = spawnSync(
      'psql',
      [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-At', '-c', `SELECT storage_key FROM public.${table}`],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (rows.status !== 0) return { keys: [], read: false };
    for (const storageKey of (rows.stdout ?? '').split('\n').filter((line) => line.length > 0)) {
      keys.push({ table, storageKey });
    }
  }
  return { keys, read: true };
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

  /*
   * ---- which references the store cannot produce, RIGHT NOW ---------------
   *
   * Taken before the plaintext is sealed, against the live storage directory
   * the archive was just made from — so what is recorded is the state of the
   * deployment at the moment of the backup rather than a guess made later.
   */
  const referenced = referencedStorageKeys(plan.databaseUrl);
  const onDisk = storageMissing ? new Set<string>() : new Set(await filesUnder(plan.storageRoot));
  const resolved = resolveReferences(referenced.keys, onDisk);
  const dangling: readonly DanglingReference[] = unresolved(resolved).map((entry) => ({
    table: entry.table,
    storageKey: entry.storageKey,
    verdict: entry.verdict,
  }));

  /*
   * ---- encryption ---------------------------------------------------------
   *
   * BACKUP-2. Last, so that everything above it — the readable dump, the
   * counted archive — has already been proved on the plaintext. Encrypting
   * first would mean checking the things a restore depends on through a layer
   * that could hide them.
   */
  const artefacts = [
    await seal(plan.destination, 'database.dump', plan.key),
    await seal(plan.destination, 'storage.tar.gz', plan.key),
  ];

  // ---- the manifest -------------------------------------------------------
  const manifest = buildManifest({
    plan,
    now,
    storedFiles,
    artefacts,
    appCommit: appCommit(),
    keyFingerprint: keyFingerprint(plan.key),
    ...(referenced.read
      ? { referencedKeys: referenced.keys.length, danglingReferences: dangling }
      : {}),
  });
  writeFileSync(join(plan.destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });

  /*
   * ---- off this machine ---------------------------------------------------
   *
   * After the manifest, so what is copied is the complete artefact including
   * its own description. A failure here does NOT remove the local backup: a
   * backup that exists on one machine is worth more than no backup, and an
   * unreachable off-site destination is an operational problem rather than a
   * reason to destroy the copy that worked. It is reported loudly and the
   * command still fails, so a timer does not record success.
   */
  const offsite = planOffsite(process.env, dirname(plan.destination));
  const offsiteLines: string[] = [...offsite.notes];
  let offsiteFailed = offsite.refusal;

  for (const destination of offsite.destinations) {
    if (destination.kind === 'directory') {
      try {
        mkdirSync(destination.target, { recursive: true, mode: 0o700 });
        const warning = sameMediaWarning(
          destination.target,
          statSync(dirname(plan.destination)).dev,
          statSync(destination.target).dev,
        );
        if (warning !== null) offsiteLines.push(warning);
        const target = join(destination.target, basename(plan.destination));
        cpSync(plan.destination, target, { recursive: true, errorOnExist: true, force: false });
        offsiteLines.push(`copied to ${target}`);
      } catch (cause) {
        offsiteFailed = `the copy to ${destination.target} failed: ${
          cause instanceof Error ? cause.message : 'unknown error'
        }`;
      }
      continue;
    }

    for (const step of rcloneCommands(
      plan.destination,
      destination.target,
      basename(plan.destination),
    )) {
      const result = run(step.command, step.args);
      if (!result.ok) {
        offsiteFailed = `\`${step.command} ${step.args[0]}\` to ${destination.target} failed: ${result.stderr}`;
        break;
      }
      offsiteLines.push(`${step.args[0]} to ${destination.target} ok`);
    }
  }

  /*
   * ---- retention ----------------------------------------------------------
   *
   * Last, and only on a backup that got this far: pruning before a new backup
   * is proven would be trading a good copy for an unproven one. Off by
   * default — see `retention.ts` for why every rule there is a refusal.
   */
  const pruning = chooseBackupsToPrune({
    entries: readdirSync(dirname(plan.destination)),
    databaseName: plan.databaseName,
    justWritten: basename(plan.destination),
    keep: readRetention(process.env),
  });
  for (const name of pruning.remove) {
    rmSync(join(dirname(plan.destination), name), { recursive: true, force: true });
  }

  process.stdout.write(
    `backup   ${plan.destination}\n` +
      `backup   database ${plan.databaseName}, ${manifest.artefacts[0]?.bytes ?? 0} bytes\n` +
      `backup   documents ${storedFiles} files, ${manifest.artefacts[1]?.bytes ?? 0} bytes\n` +
      (referenced.read
        ? `backup   ${referenced.keys.length} storage key(s) referenced, ${dangling.length} ` +
          'with no file — recorded in the manifest so a restore test can tell them from ' +
          'documents this backup loses\n'
        : 'backup   WARNING: the storage keys could not be read, so the manifest records none. ' +
          'A restore test will have to be told which missing documents were already missing.\n') +
      `backup   encrypted aes-256-gcm, key ${manifest.encryption.keyFingerprint}\n` +
      offsiteLines.map((line) => `backup   ${line}\n`).join('') +
      (pruning.remove.length === 0
        ? `backup   ${pruning.note}\n`
        : `backup   ${pruning.note} Removed ${pruning.remove.length}: ` +
          `${pruning.remove.join(', ')}\n`) +
      'backup   NOT restore-tested yet — run: npm run backup:restore-test ' +
      `${plan.destination}\n`,
  );

  if (offsiteFailed !== null) {
    throw new BackupRefused(
      `the backup was written to ${plan.destination} and IS intact, but it did not get off this ` +
        `machine: ${offsiteFailed}. Deal with the destination and copy it by hand; the local ` +
        'copy has deliberately been left in place.',
    );
  }
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
/**
 * WHAT HAPPENED LAST TIME, where somebody can see it. BACKUP-2.
 *
 * A scheduled backup fails silently by nature: nobody is watching at 02:00,
 * and `journalctl` is only read by somebody who already suspects something.
 * So every run — successful or not — writes `last-run.json` beside the
 * backups, which is the first thing `docs/vps-backups.md` tells an operator to
 * look at and the thing a monitoring check can read without credentials.
 *
 * Best-effort: a status file that cannot be written must not turn a successful
 * backup into a failed one, and a failed backup's real message has already
 * been printed.
 */
const recordRunStatus = (
  outcome: 'ok' | 'failed',
  detail: string,
  startedAt: Date,
): void => {
  const into = (process.env.EJE_BACKUP_DIR ?? '').trim();
  if (into.length === 0) return;
  try {
    mkdirSync(into, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(into, 'last-run.json'),
      `${JSON.stringify(
        {
          outcome,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          detail,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Nothing useful to do, and nothing worth hiding the real outcome behind.
  }
};

const main = async (): Promise<void> => {
  loadEnvFiles();
  const now = new Date();
  await backup(planBackup(process.env, now, process.cwd()), now);
  recordRunStatus('ok', 'database and documents backed up, encrypted and recorded', now);
};

const startedAt = new Date();

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`backup   REFUSED: ${message}\n`);
  recordRunStatus('failed', message, startedAt);
  process.exitCode = 1;
});
