import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { extractArchiveSafely } from './archive';
import { decryptFile } from './crypto';
import {
  claimScratchDatabase,
  postgresScratchServer,
  scratchDatabaseName,
  withDatabase,
} from './scratch';

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

/**
 * A test key. BACKUP-2 means there is no unencrypted path, so every run needs
 * one — it lives in the helper rather than at each call site so that no test
 * can accidentally assert the behaviour of a backup with no key.
 */
const TEST_KEY = 'c'.repeat(64);
const KEY = Buffer.from(TEST_KEY, 'hex');

const runCommand = (
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync('npx', ['tsx', script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, EJE_BACKUP_KEY: TEST_KEY, ...env },
    cwd: process.cwd(),
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

const runVerify = (directory: string, env: Readonly<Record<string, string>> = {}) =>
  runCommand('src/db/backup/verify.ts', [directory], env);

const runRestoreTest = (directory: string, env: Readonly<Record<string, string>> = {}) =>
  runCommand('src/db/backup/restore-test.ts', [directory], { DATABASE_URL: url ?? '', ...env });

const runBackup = (
  env: Readonly<Record<string, string>>,
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync('npx', ['tsx', 'src/db/backup/run.ts'], {
    encoding: 'utf8',
    env: { ...process.env, EJE_BACKUP_KEY: TEST_KEY, ...env },
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

  it('writes a readable dump and every document, with a manifest', async () => {
    const result = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });
    expect(result.status, result.stderr).toBe(0);

    const directory = onlyDirectory(into);
    /*
     * ENCRYPTED, AND THE PLAINTEXT IS NOT ALSO SITTING THERE. BACKUP-2.
     * `database.dump` and `storage.tar.gz` are gone, not kept "just in case" —
     * a directory holding both is a directory holding the plaintext.
     */
    expect(readdirSync(directory).sort()).toEqual([
      'database.dump.enc',
      'manifest.json',
      'storage.tar.gz.enc',
    ]);

    // THE DUMP IS ONE pg_restore CAN READ. A file of the right name proves
    // nothing; this is the tool a restore would actually use. It is decrypted
    // first, which is also the proof that encryption did not corrupt it.
    const plainDump = join(directory, 'decrypted.dump');
    await decryptFile(join(directory, 'database.dump.enc'), plainDump, KEY);
    const listed = spawnSync('pg_restore', ['--list', plainDump], { encoding: 'utf8' });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('Archive created at');

    // AND THE SIGNED JOB CARD IS IN THE ARCHIVE. This is the half that was
    // missing before BACKUP-1: the database row points at this file.
    const plainArchive = join(directory, 'decrypted.tar.gz');
    await decryptFile(join(directory, 'storage.tar.gz.enc'), plainArchive, KEY);
    const inArchive = spawnSync('tar', ['-tzf', plainArchive], { encoding: 'utf8' });
    expect(inArchive.stdout).toContain('jobcards/final/EJE-1048.pdf');
    expect(inArchive.stdout).toContain('uploads/order.pdf');

    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      storedFiles: number;
      artefacts: { name: string; bytes: number; sha256: string; plainSha256: string }[];
      notVerifiedBy: string;
      encryption: { algorithm: string; keyFingerprint: string };
    };
    expect(manifest.storedFiles).toBe(2);
    expect(manifest.artefacts.map((entry) => entry.name).sort()).toEqual([
      'database.dump.enc',
      'storage.tar.gz.enc',
    ]);
    for (const artefact of manifest.artefacts) {
      expect(artefact.bytes).toBeGreaterThan(0);
      expect(artefact.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(artefact.plainSha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    // It still says, in the file, that nobody has read these bytes back.
    expect(manifest.notVerifiedBy).toMatch(/NO RESTORE has been/u);
    // And the key itself is nowhere in it. BACKUP-2.
    expect(manifest.encryption.keyFingerprint).toMatch(/^[0-9a-f]{16}$/u);
    expect(JSON.stringify(manifest)).not.toContain(TEST_KEY);
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
    for (const name of ['database.dump.enc', 'storage.tar.gz.enc', 'manifest.json']) {
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
    // would compute only within the same second. Through the helper, so it
    // carries a key like every other run — BACKUP-2 refuses without one, and a
    // run refused for the WRONG reason proves nothing about overwriting.
    const again = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
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

/**
 * BACKUP-2 — ENCRYPTED, INTEGRITY-VERIFIED, RESTORE-TESTED.
 *
 * The claims here are the ones somebody will depend on during an outage, so
 * each is checked by doing the thing rather than by inspecting a file:
 *
 *   - a backup that has been ALTERED is refused, including when whoever altered
 *     it recomputed the checksum, which is the whole reason for a tag;
 *   - the wrong key is told apart from a damaged backup;
 *   - a dump is restored into a database built for the purpose, which is then
 *     dropped — and the ROWS are checked against the DOCUMENTS, because a
 *     restored row pointing at a missing signed job card is this system's worst
 *     failure and the only way to find it is to look.
 */
describeDb('npm run backup:verify and backup:restore-test', () => {
  let db: Database;
  let storage: string;
  let into: string;

  /**
   * THIS BLOCK SEEDS ITS OWN ROWS, AND THAT IS THE POINT.
   *
   * It used to read whatever storage keys happened to be in `eje_test` and
   * build a storage directory from them — so it depended on which OTHER test
   * file had run before it and what that file had left behind. Every db test
   * file drops and rebuilds the schema in its own `beforeAll`, so "before" is
   * decided by vitest's file order, which is not stable: it uses the previous
   * run's timings, and a run with no cache orders them differently.
   *
   * On such a run this block found NO storage keys, wrote NO files, and `npm
   * run backup` then refused — correctly — with "holds no files at all",
   * failing 8 tests and blaming the backup command for the test's own empty
   * fixture. That is the `8 failed | 194 passed` run recorded on issue #23,
   * reproduced on 17 October 2026 by restarting PostgreSQL and running the
   * suite with a cold vitest cache.
   */
  const SEEDED_KEYS = [
    'machines/eje-m-0001-plate.jpg',
    'machines/eje-m-0001-controller.jpg',
  ] as const;

  /** Writes the file each seeded row points at, and proves it wrote some. */
  const documentsTheDatabaseRefersTo = (root: string): number => {
    const keys = spawnSync(
      'psql',
      [
        url ?? '',
        '-At',
        '-c',
        "select storage_key from public.machine_photos union all select storage_key from public.job_media union all select storage_key from public.final_documents",
      ],
      { encoding: 'utf8' },
    ).stdout.split('\n').filter((line) => line.length > 0);

    for (const key of keys) {
      mkdirSync(join(root, key.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(root, key), `%PDF-1.4 ${key}`);
    }

    /*
     * The guard that makes the old failure impossible to misread. An empty
     * fixture is this test's bug, and it now says so here rather than being
     * reported as a refusal by the command under test.
     */
    if (keys.length === 0) {
      throw new Error(
        'the test database holds no storage keys, so there is nothing for a backup to archive — ' +
          'the fixture did not seed. This block must not depend on another test file.',
      );
    }
    return keys.length;
  };

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    storage = mkdtempSync(join(tmpdir(), 'eje-docs2-'));
    into = mkdtempSync(join(tmpdir(), 'eje-backups2-'));
    roots.push(storage, into);

    // Deterministic, and owned by this block: two machine photographs, which
    // are rows carrying a `storage_key` and needing nothing but the seeded
    // machine. That is all the cross-check needs to have something to resolve.
    await truncateAll(db);
    await seedBaseline(db);
    await db.insert(schema.machinePhotos).values(
      SEEDED_KEYS.map((key, index) => ({
        id: `00000000-0000-4000-8000-0000000009${String(index + 10).padStart(2, '0')}`,
        machineId: IDS.machine,
        fileName: key.split('/').pop() ?? key,
        caption: `Seeded for the backup tests (${index + 1})`,
        storageKey: key,
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        uploadedAt: '2026-10-17T08:00:00.000Z',
        uploadedBy: IDS.master,
      })),
    );
  });

  const freshBackup = (): string => {
    documentsTheDatabaseRefersTo(storage);
    const result = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });
    expect(result.status, result.stderr).toBe(0);
    const entries = readdirSync(into);
    expect(entries).toHaveLength(1);
    return join(into, entries[0]!);
  };

  const manifestOf = (directory: string) =>
    JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      artefacts: { name: string; bytes: number; sha256: string; plainSha256: string }[];
      storedFiles: number;
      encryption: { keyFingerprint: string };
      verifications?: { kind: string; at: string; detail: string }[];
    };

  it('verifies a fresh backup and records that it did', () => {
    const directory = freshBackup();
    const verified = runVerify(directory);

    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toMatch(/intact and authentic/u);

    const manifest = manifestOf(directory);
    expect(manifest.verifications?.[0]?.kind).toBe('integrity');
    expect(manifest.verifications?.[0]?.at).toMatch(/^20\d\d-/u);
  });

  it('leaves no decrypted copy behind after verifying', () => {
    const directory = freshBackup();
    expect(runVerify(directory).status).toBe(0);
    // Still only the three files. Verification decrypts into a temporary
    // directory of its own and removes it; a plaintext dump left beside the
    // ciphertext would make running the check the dangerous act.
    expect(readdirSync(directory).sort()).toEqual([
      'database.dump.enc',
      'manifest.json',
      'storage.tar.gz.enc',
    ]);
  });

  it('REFUSES a backup whose bytes have changed', () => {
    const directory = freshBackup();
    const target = join(directory, 'database.dump.enc');
    const bytes = readFileSync(target);
    bytes[Math.floor(bytes.length / 2)] = bytes[Math.floor(bytes.length / 2)]! ^ 0xff;
    writeFileSync(target, bytes);

    const verified = runVerify(directory);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toMatch(/does not match its recorded SHA-256/u);
  });

  it('REFUSES an alteration whose checksum was recomputed — what the tag is for', () => {
    /*
     * THE CASE A CHECKSUM CANNOT CATCH.
     *
     * Whoever edits the file can recompute a SHA-256 and write it into the
     * manifest; there is nothing secret in either. They cannot produce a GCM
     * tag that verifies without the key. This simulates exactly that attacker
     * and is the reason the artefacts are authenticated rather than merely
     * checksummed.
     */
    const directory = freshBackup();
    const target = join(directory, 'storage.tar.gz.enc');
    const bytes = readFileSync(target);
    bytes[20] = bytes[20]! ^ 0x01;
    writeFileSync(target, bytes);

    const manifest = manifestOf(directory);
    const recomputed = spawnSync('sha256sum', [target], { encoding: 'utf8' }).stdout.split(' ')[0]!;
    writeFileSync(
      join(directory, 'manifest.json'),
      JSON.stringify(
        {
          ...manifest,
          artefacts: manifest.artefacts.map((artefact) =>
            artefact.name === 'storage.tar.gz.enc'
              ? { ...artefact, sha256: recomputed, bytes: bytes.length }
              : artefact,
          ),
        },
        null,
        2,
      ),
    );

    const verified = runVerify(directory);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toMatch(/did not authenticate/u);
  });

  it('tells the wrong key apart from a damaged backup', () => {
    const directory = freshBackup();
    const verified = runVerify(directory, { EJE_BACKUP_KEY: 'e'.repeat(64) });

    expect(verified.status).toBe(1);
    // Not "altered or truncated" — that would send an operator looking for
    // damage that is not there.
    expect(verified.stderr).toMatch(/wrong key is configured/u);
    expect(verified.stderr).toContain(manifestOf(directory).encryption.keyFingerprint);
  });

  it('RESTORES the dump into a database of its own, and drops it', () => {
    const directory = freshBackup();
    const restored = runRestoreTest(directory);

    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toMatch(/jobs=\d+/u);
    expect(restored.stdout).toMatch(/0 missing/u);
    expect(restored.stdout).toMatch(/RESTORE-TESTED/u);

    // The scratch database is gone. A copy of the production database left on
    // the server would undo the encryption this backup was given.
    const left = spawnSync(
      'psql',
      [url ?? '', '-At', '-c', "select datname from pg_database where datname like 'eje_restore_test_%'"],
      { encoding: 'utf8' },
    );
    expect(left.stdout.trim()).toBe('');

    const record = manifestOf(directory).verifications?.find((entry) => entry.kind === 'restore');
    expect(record?.detail).toMatch(/restored into a scratch database and dropped again/u);
    expect(record?.detail).toMatch(/all resolved/u);
  });

  it('REFUSES when a restored row points at a document the backup does not hold', () => {
    /*
     * THE FAILURE BACKUP-1 EXISTS TO PREVENT, checked rather than argued. One
     * signed job card is removed from the storage directory before the backup
     * is taken; the database row that names it is still in the dump.
     */
    documentsTheDatabaseRefersTo(storage);
    // One of the rows this block seeded, taken away before the backup is made.
    const missing = SEEDED_KEYS[0];
    rmSync(join(storage, missing));

    const taken = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });
    expect(taken.status, taken.stderr).toBe(0);
    const directory = join(into, readdirSync(into)[0]!);

    const restored = runRestoreTest(directory);
    expect(restored.status).toBe(1);
    expect(restored.stderr).toMatch(/point at documents that are not in the backup/u);
    expect(restored.stderr).toContain(missing);
  });

  it('records the unresolved count rather than hiding it when orphans are accepted', () => {
    documentsTheDatabaseRefersTo(storage);
    // One of the rows this block seeded, taken away before the backup is made.
    const missing = SEEDED_KEYS[0];
    rmSync(join(storage, missing));

    expect(
      runBackup({ DATABASE_URL: url ?? '', EJE_STORAGE_DIR: storage, EJE_BACKUP_DIR: into }).status,
    ).toBe(0);
    const directory = join(into, readdirSync(into)[0]!);

    const restored = runRestoreTest(directory, { EJE_RESTORE_ALLOW_ORPHANS: 'yes' });
    expect(restored.status, restored.stderr).toBe(0);
    // Permitted, and NOT quiet: a restore record that cannot be told apart from
    // a clean one is worth nothing.
    expect(restored.stdout).toMatch(/1 missing/u);
    expect(restored.stdout).toMatch(/WARNING/u);
    const record = manifestOf(directory).verifications?.find((entry) => entry.kind === 'restore');
    expect(record?.detail).toMatch(/1 UNRESOLVED/u);
  });

  /**
   * THE WHOLE ROUND TRIP, WITH THE BYTES CHECKED AT THE FAR END. BACKUP-2.
   *
   * Every other test here checks one link of the chain: the dump is readable,
   * the checksums match, the tag verifies, `pg_restore` accepts the archive,
   * the storage keys resolve. None of them has ever answered the question EJE
   * would actually ask on the worst morning — *is my data still in there?*
   *
   * So this one goes the whole way with nothing mocked: a known row and a known
   * file go in, the backup is taken and ENCRYPTED, the artefacts are verified,
   * decrypted, restored into a scratch database and unpacked into a scratch
   * directory, and then the row is read back and the file is compared BYTE FOR
   * BYTE. Not a count, not a checksum of a checksum — the caption somebody
   * typed and the bytes of the document.
   *
   * It does the restore itself rather than calling `backup:restore-test`,
   * because that command drops its scratch database on the way out; the point
   * of this test is to look inside it first.
   */
  it('round-trips a real record and a real document through encryption and restore', async () => {
    const canary = `Round-trip canary ${new Date().toISOString()}`;
    await db
      .update(schema.machinePhotos)
      .set({ caption: canary })
      .where(eq(schema.machinePhotos.storageKey, SEEDED_KEYS[0]));

    documentsTheDatabaseRefersTo(storage);
    const documentBytes = readFileSync(join(storage, SEEDED_KEYS[0]));

    const taken = runBackup({
      DATABASE_URL: url ?? '',
      EJE_STORAGE_DIR: storage,
      EJE_BACKUP_DIR: into,
    });
    expect(taken.status, taken.stderr).toBe(0);
    const directory = join(into, readdirSync(into)[0]!);

    // The backup on the shelf is ciphertext, and the plaintext is not beside it.
    expect(readdirSync(directory).sort()).toEqual([
      'database.dump.enc',
      'manifest.json',
      'storage.tar.gz.enc',
    ]);

    const scratchDir = mkdtempSync(join(tmpdir(), 'eje-roundtrip-'));
    roots.push(scratchDir);
    const dump = join(scratchDir, 'database.dump');
    const archive = join(scratchDir, 'storage.tar.gz');
    const manifest = manifestOf(directory);

    // Decrypted, and the plaintext checksums recorded in the manifest are what
    // came out — the half a ciphertext checksum cannot answer.
    expect(await decryptFile(join(directory, 'database.dump.enc'), dump, KEY)).toBe(
      manifest.artefacts.find((a) => a.name === 'database.dump.enc')?.plainSha256,
    );
    expect(await decryptFile(join(directory, 'storage.tar.gz.enc'), archive, KEY)).toBe(
      manifest.artefacts.find((a) => a.name === 'storage.tar.gz.enc')?.plainSha256,
    );

    const admin = withDatabase(url ?? '', 'postgres');
    const server = postgresScratchServer(admin);
    const source = new URL(url ?? '').pathname.slice(1);
    const scratch = claimScratchDatabase(server, source, new Date());
    try {
      const target = withDatabase(url ?? '', scratch);
      const restored = spawnSync(
        'pg_restore',
        ['--dbname', target, '--no-owner', '--no-privileges', '--exit-on-error', dump],
        { encoding: 'utf8' },
      );
      expect(restored.status, restored.stderr ?? '').toBe(0);

      // THE RECORD. Read out of the restored database, by the key it went in
      // under, and compared with what a person typed.
      const readBack = spawnSync(
        'psql',
        [
          target,
          '-v',
          'ON_ERROR_STOP=1',
          '-At',
          '-c',
          `select caption from public.machine_photos where storage_key = '${SEEDED_KEYS[0]}'`,
        ],
        { encoding: 'utf8' },
      );
      expect(readBack.status, readBack.stderr ?? '').toBe(0);
      expect(readBack.stdout.trim()).toBe(canary);
    } finally {
      server.drop(scratch);
    }

    // THE DOCUMENT. Unpacked through the same guarded extraction a restore test
    // uses, and compared byte for byte with the file that went in.
    const unpacked = join(scratchDir, 'storage');
    mkdirSync(unpacked, { recursive: true });
    const { files } = await extractArchiveSafely(archive, unpacked);
    expect(files).toContain(SEEDED_KEYS[0]);
    expect(readFileSync(join(unpacked, SEEDED_KEYS[0])).equals(documentBytes)).toBe(true);
    expect(files).toHaveLength(manifest.storedFiles);
  });

  /* -- the scratch database, on the real server -------------------------- */

  /**
   * AN EXISTING DATABASE IS REFUSED, AND NOT TOUCHED. BACKUP-2, issue #23.
   *
   * The claim logic is unit-tested against a fake server; this is the same
   * logic against a real PostgreSQL, with real rows inside the database it
   * refuses to take. The name is generated with a FIXED suffix so the test can
   * put something in the way — which is the only reason the suffix is
   * injectable.
   */
  it('REFUSES an existing scratch database on real PostgreSQL, leaving it untouched', () => {
    const fixedNow = new Date('2026-10-17T09:14:03.000Z');
    const occupied = scratchDatabaseName(fixedNow, () => 'f00dbabe');
    const admin = withDatabase(url ?? '', 'postgres');
    const server = postgresScratchServer(admin);

    const sqlIn = (database: string, statement: string): string => {
      const result = spawnSync(
        'psql',
        [withDatabase(url ?? '', database), '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement],
        { encoding: 'utf8' },
      );
      expect(result.status, result.stderr ?? '').toBe(0);
      return (result.stdout ?? '').trim();
    };

    server.create(occupied);
    try {
      sqlIn(occupied, 'create table marker (id integer primary key)');
      sqlIn(occupied, 'insert into marker values (42)');

      expect(() =>
        claimScratchDatabase(server, 'eje_test', fixedNow, () => 'f00dbabe'),
      ).toThrow(/Refused rather than replaced/u);

      // THE ROWS ARE STILL THERE. Refusing is only worth anything if the
      // database it refused is exactly as it was.
      expect(sqlIn(occupied, 'select id from marker')).toBe('42');
    } finally {
      server.drop(occupied);
    }

    expect(
      spawnSync('psql', [admin, '-At', '-c', `select 1 from pg_database where datname = '${occupied}'`], {
        encoding: 'utf8',
      }).stdout.trim(),
    ).toBe('');
  });

  /**
   * TWO RESTORE TESTS AT ONCE, FOR REAL. BACKUP-2, issue #23.
   *
   * The deterministic proof is in `scratch.test.ts`; this is the integration
   * check that the two processes really do take different databases. Before
   * the fix the name was the timestamp to the second, so two invocations
   * starting in the same second computed the same name and the second was
   * refused for a collision rather than a real conflict.
   */
  it('runs two restore tests in parallel without either claiming the other name', async () => {
    const directory = freshBackup();

    const invoke = (): Promise<{ status: number; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn('npx', ['tsx', 'src/db/backup/restore-test.ts', directory], {
          env: { ...process.env, EJE_BACKUP_KEY: TEST_KEY, DATABASE_URL: url ?? '' },
          cwd: process.cwd(),
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.stdout.on('data', () => {
          /* drained so the pipe cannot fill and stall the child */
        });
        child.on('close', (status) => resolve({ status: status ?? -1, stderr }));
      });

    const [first, second] = await Promise.all([invoke(), invoke()]);

    for (const [label, result] of [
      ['first', first],
      ['second', second],
    ] as const) {
      expect(result.stderr, `${label} collided on a scratch name`).not.toMatch(/already exists/u);
      expect(result.status, `${label}: ${result.stderr}`).toBe(0);
    }

    // And neither left its database behind.
    expect(
      spawnSync(
        'psql',
        [url ?? '', '-At', '-c', "select datname from pg_database where datname like 'eje_restore_test_%'"],
        { encoding: 'utf8' },
      ).stdout.trim(),
    ).toBe('');
  });

  /**
   * CTRL-C IS NOT A LEAK. BACKUP-2.
   *
   * The likely way a restore test ends is neither success nor an exception: an
   * operator presses Ctrl-C because it is slower than they expected, or a
   * deployment script's timeout sends SIGTERM. `finally` does not run for a
   * signal, and what was being held at that moment is a scratch database
   * containing a COPY OF THE WHOLE DATABASE and a workspace holding the
   * decrypted dump and every signed job card in plaintext. Leaving either
   * behind undoes the encryption.
   *
   * So the command is started, waited for until it has actually CLAIMED its
   * database — polling the server, not sleeping a guessed interval — and then
   * terminated. Nothing may be left on the server afterwards.
   */
  it('cleans up its scratch database when it is TERMINATED rather than finished', async () => {
    const directory = freshBackup();

    const scratchDatabases = (): readonly string[] =>
      spawnSync(
        'psql',
        [
          url ?? '',
          '-At',
          '-c',
          "select datname from pg_database where datname like 'eje_restore_test_%'",
        ],
        { encoding: 'utf8' },
      )
        .stdout.split('\n')
        .filter((line) => line.trim().length > 0);

    expect(scratchDatabases(), 'a previous test left a scratch database').toEqual([]);

    /*
     * `node --import tsx` ON PURPOSE, where every other test here uses
     * `npx tsx`. This one signals the process, and `npx tsx` is two processes
     * above the one holding the scratch database: terminating the wrapper
     * tears the tree down from outside, which proves nothing about the
     * handler. One node process means SIGTERM is delivered where the handler
     * is — the same place `systemd`, a CI runner or an operator's Ctrl-C would
     * send it in production, since those signal the process group that the
     * command itself leads.
     */
    const child = spawn('node', ['--import', 'tsx', 'src/db/backup/restore-test.ts', directory], {
      env: { ...process.env, EJE_BACKUP_KEY: TEST_KEY, DATABASE_URL: url ?? '' },
      cwd: process.cwd(),
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const finished = new Promise<{ status: number | null; signal: string | null }>((resolve) => {
      child.on('close', (status, signal) => resolve({ status, signal }));
    });

    // Wait for the window this test is about: a database has been claimed and
    // the command is still working. Bounded, so a change that makes the claim
    // unreachable fails here instead of hanging.
    const deadline = Date.now() + 60_000;
    let claimed: readonly string[] = [];
    while (claimed.length === 0 && Date.now() < deadline) {
      claimed = scratchDatabases();
      if (claimed.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(claimed, 'the restore test never claimed a scratch database').toHaveLength(1);

    child.kill('SIGTERM');
    const ended = await finished;

    /*
     * THE HANDLER RAN. The database disappearing is the outcome; this line is
     * the evidence that it disappeared because the command cleaned up, rather
     * than because something else happened to drop it.
     */
    expect(
      stderr,
      `exit ${String(ended.status)} / signal ${String(ended.signal)} / stderr ${JSON.stringify(stderr)} / stdout ${JSON.stringify(stdout)}`,
    ).toMatch(/SIGTERM — cleaning up before exit/u);
    // Terminated, not finished: 143 is what a shell reports for SIGTERM, and a
    // process killed outright reports the signal instead of a code.
    expect(
      ended.status === 143 || ended.signal === 'SIGTERM',
      `exit ${String(ended.status)} / signal ${String(ended.signal)}: ${stderr}`,
    ).toBe(true);

    // THE POINT OF THE TEST. No copy of the database is left on the server.
    expect(scratchDatabases(), `left behind: ${scratchDatabases().join(', ')}`).toEqual([]);
  });

  it('REFUSES a directory with no manifest at all', () => {
    const bare = mkdtempSync(join(tmpdir(), 'eje-bare-'));
    roots.push(bare);
    const verified = runVerify(bare);
    expect(verified.status).toBe(1);
    expect(verified.stderr).toMatch(/nothing saying what this directory should contain/u);
  });
});
