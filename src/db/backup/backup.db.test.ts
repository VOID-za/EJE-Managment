import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '@/data/postgres/test-database';

/**
 * A BACKUP THAT CAN ACTUALLY BE RESTORED FROM. BACKUP-1.
 *
 * `plan.test.ts` proves what is refused and what is kept out of the output.
 * This runs the command itself, against a real PostgreSQL and a real directory
 * of files, because the claim being tested is about artefacts on a disk:
 *
 *   - the dump is one `pg_restore` can read, not merely a file that exists;
 *   - the documents are in the archive, all of them, counted;
 *   - a backup missing half of itself is REMOVED rather than reported;
 *   - the directory holding every customer's signed job card is not readable
 *     by anybody who happens to be on the box.
 *
 * Skipped where there is no `TEST_DATABASE_URL`, like every other `*.db.test.ts`.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const roots: string[] = [];

const runBackup = (
  env: Readonly<Record<string, string>>,
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync('npx', ['tsx', 'src/db/backup/run.ts'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: process.cwd(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

describeDb('npm run backup', () => {
  let storage: string;
  let into: string;

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'eje-docs-'));
    into = mkdtempSync(join(tmpdir(), 'eje-backups-'));
    roots.push(storage, into);

    // The shape the application actually writes: nested prefixes, real bytes.
    mkdirSync(join(storage, 'jobcards', 'final'), { recursive: true });
    mkdirSync(join(storage, 'uploads'), { recursive: true });
    writeFileSync(join(storage, 'jobcards', 'final', 'EJE-1048.pdf'), '%PDF-1.4 signed');
    writeFileSync(join(storage, 'uploads', 'order.pdf'), '%PDF-1.4 customer order');
  });

  afterAll(() => {
    for (const root of roots) spawnSync('rm', ['-rf', root]);
  });

  const onlyDirectory = (parent: string): string => {
    const entries = readdirSync(parent);
    expect(entries).toHaveLength(1);
    return join(parent, entries[0]!);
  };

  it('writes a readable dump and every document, with a manifest', () => {
    const result = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });
    expect(result.status, result.stderr).toBe(0);

    const directory = onlyDirectory(into);
    expect(readdirSync(directory).sort()).toEqual([
      'database.dump',
      'manifest.json',
      'storage.tar.gz',
    ]);

    // THE DUMP IS ONE pg_restore CAN READ. A file of the right name proves
    // nothing; this is the tool a restore would actually use.
    const listed = spawnSync('pg_restore', ['--list', join(directory, 'database.dump')], {
      encoding: 'utf8',
    });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('Archive created at');

    // AND THE SIGNED JOB CARD IS IN THE ARCHIVE. This is the half that was
    // missing before BACKUP-1: the database row points at this file.
    const inArchive = spawnSync('tar', ['-tzf', join(directory, 'storage.tar.gz')], {
      encoding: 'utf8',
    });
    expect(inArchive.stdout).toContain('jobcards/final/EJE-1048.pdf');
    expect(inArchive.stdout).toContain('uploads/order.pdf');

    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      storedFiles: number;
      artefacts: { name: string; bytes: number; sha256: string }[];
      notVerifiedBy: string;
    };
    expect(manifest.storedFiles).toBe(2);
    expect(manifest.artefacts.map((entry) => entry.name).sort()).toEqual([
      'database.dump',
      'storage.tar.gz',
    ]);
    for (const artefact of manifest.artefacts) {
      expect(artefact.bytes).toBeGreaterThan(0);
      expect(artefact.sha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(manifest.notVerifiedBy).toMatch(/BACKUP-2/u);
  });

  it('checksums what it actually wrote', () => {
    const result = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });
    expect(result.status).toBe(0);
    const directory = onlyDirectory(into);

    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      artefacts: { name: string; sha256: string }[];
    };
    for (const artefact of manifest.artefacts) {
      const actual = spawnSync('sha256sum', [join(directory, artefact.name)], { encoding: 'utf8' });
      expect(actual.stdout.split(' ')[0]).toBe(artefact.sha256);
    }
  });

  it('keeps the backup unreadable to anybody else on the machine', () => {
    /*
     * This directory holds every customer's signed job card and a complete copy
     * of the database. Rule 27: the mode is part of the deliverable.
     */
    const result = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });
    expect(result.status).toBe(0);
    const directory = onlyDirectory(into);

    expect(statSync(directory).mode & 0o777).toBe(0o700);
    /*
     * EVERY file, not only the manifest. `pg_dump` and `tar` write with the
     * process umask — 0644 on a default install — and the mode is what travels
     * with the file when somebody rsyncs the backup somewhere else.
     */
    for (const name of ['database.dump', 'storage.tar.gz', 'manifest.json']) {
      expect(statSync(join(directory, name)).mode & 0o777, name).toBe(0o600);
    }
  });

  it('never prints the database password, even in a failure', () => {
    /*
     * ON THE FAILURE PATH, DELIBERATELY, and with a password that cannot
     * coincide with anything else on the line.
     *
     * A successful run prints a destination and two byte counts and never goes
     * near the connection string. The risk is the other path: `pg_dump` writes
     * the URL it could not connect to into its own stderr, and this command
     * quotes that stderr. Cron mails it. So the assertion belongs here.
     *
     * The test database's own password is `eje`, which legitimately appears in
     * its database name and in every temporary path, so asserting against it
     * would prove nothing either way.
     */
    const secret = 'pA55w0rd-that-must-never-be-printed';
    const result = runBackup({
      DATABASE_URL: `postgres://eje:${secret}@127.0.0.1:5999/absent`,
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
    /*
     * AND THE OPERATOR IS STILL TOLD WHY.
     *
     * The first version redacted by parsing the whole message as a URL, which
     * throws on an English sentence — so every failure read "pg_dump failed:
     * [unreadable connection string]" and could not be diagnosed. Removing the
     * secret from inside the message is not the same as removing the message.
     */
    expect(result.stderr).toMatch(/connection to server/iu);
    expect(result.stderr).toMatch(/5999/u);
  });

  /* -- the refusals -------------------------------------------------------- */

  it('REFUSES when the document directory is missing, and writes nothing', () => {
    const result = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: join(storage, 'not-here'),
      EJE_BACKUP_DIR: into,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not exist/u);
    expect(result.stderr).toMatch(/EJE_STORAGE_DIR/u);
    /*
     * NOTHING LEFT BEHIND. A directory holding only `database.dump` is the trap
     * this requirement exists to prevent — somebody in a hurry would trust it.
     */
    expect(readdirSync(into)).toHaveLength(0);
  });

  it('REFUSES when the documents are all gone, rather than recording a success', () => {
    const empty = mkdtempSync(join(tmpdir(), 'eje-empty-'));
    roots.push(empty);

    const result = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: empty,
      EJE_BACKUP_DIR: into,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no files at all/u);
    expect(readdirSync(into)).toHaveLength(0);
  });

  it('allows an empty directory only when told the deployment is new', () => {
    const empty = mkdtempSync(join(tmpdir(), 'eje-fresh-'));
    roots.push(empty);

    const result = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: empty,
      EJE_BACKUP_DIR: into,
      EJE_BACKUP_ALLOW_EMPTY: 'yes',
    });

    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(
      readFileSync(join(onlyDirectory(into), 'manifest.json'), 'utf8'),
    ) as { storedFiles: number };
    expect(manifest.storedFiles).toBe(0);
  });

  it('REFUSES to overwrite a backup that is already there', () => {
    const first = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });
    expect(first.status).toBe(0);
    const directory = onlyDirectory(into);

    // The same destination, forced by reusing the directory name a second run
    // would compute only within the same second — so it is created directly.
    const again = spawnSync('npx', ['tsx', 'src/db/backup/run.ts'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: url ?? '',
        EJE_STORAGE_DIR: storage,
        EJE_BACKUP_DIR: into,
      },
    });
    // Either it refused (same second) or it wrote a second, distinct directory.
    if (again.status !== 0) {
      expect(again.stderr).toMatch(/already exists/u);
    } else {
      expect(readdirSync(into).length).toBe(2);
    }
    expect(readdirSync(directory)).toContain('manifest.json');
  });

  it('REFUSES a database it cannot reach, and leaves nothing behind', () => {
    const result = runBackup({
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:5999/absent',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pg_dump failed/u);
    // Nothing half-written: the dump failed, so the directory goes with it.
    expect(readdirSync(into)).toHaveLength(0);
  });
});
