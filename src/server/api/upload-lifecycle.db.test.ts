import { chdir, cwd } from 'node:process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';
import { FilesystemStorageService } from '@/services/production/file-storage';

/**
 * THE PARTS OF AN UPLOAD'S LIFE THAT NOTHING ELSE COVERED.
 *
 * The other files here cover the round trip, the refusals, who may read one
 * back, the rollback of a failed insert, and the backup. Four questions were
 * left, and each of them is a way a file-handling system fails in production
 * rather than in a test:
 *
 *   - DOES A FILE SURVIVE A NEW RELEASE DIRECTORY? A deployment replaces
 *     `/opt/eje/app`. If anything addresses storage relative to where the
 *     application happens to be running, every document uploaded before the
 *     deployment becomes unreachable — and nothing would notice until somebody
 *     opened a job from last month.
 *   - WHAT HAPPENS WHEN THE WRITE ITSELF FAILS? A full disk, a path that is
 *     not a directory. The row must not be written, because a row pointing at
 *     bytes that were never stored is the failure the whole ordering exists to
 *     prevent.
 *   - TWO FILES WITH THE SAME NAME. A technician photographing two nameplates
 *     on an iPhone sends `IMG_0001.jpg` twice.
 *   - TWO UPLOADS AT THE SAME INSTANT. Both must land, with their own bytes.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';

const pdf = (label: string): Uint8Array =>
  new TextEncoder().encode(`%PDF-1.4\n${label}\n%%EOF`);

interface DocumentBody {
  readonly document: {
    readonly id: string;
    readonly fileName: string;
    readonly sizeBytes: number;
    readonly checksumSha256: string | null;
  };
}

describeDb('the rest of an upload’s life, on PostgreSQL', () => {
  let db: Database;
  let storageRoot: string;
  let originalCwd: string;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

  const attach = (client: ApiTestClient, name: string, body: string) =>
    client.upload<DocumentBody>(`/api/customers/${IDS.customer}/documents`, {
      name,
      type: 'application/pdf',
      bytes: pdf(body),
      fields: { caption: body },
    });

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    originalCwd = cwd();
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-lifecycle-'));
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  afterAll(async () => {
    chdir(originalCwd);
    await db.$client.end({ timeout: 5 });
    await rm(storageRoot, { recursive: true, force: true });
    delete process.env.EJE_STORAGE_DIR;
  });

  beforeEach(async () => {
    chdir(originalCwd);
    await truncateAll(db);
    await seedBaseline(db);
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    /*
     * A FRESH STORE PER TEST, not just a fresh database. QA-6: no test may
     * depend on another's leftovers — and the first version of this file shared
     * one directory, so the concurrency test counted five files and failed on
     * the two the tests before it had left behind. Truncating the database and
     * not the store is exactly the half-measure that produces a test whose
     * result depends on which order they ran in.
     */
    await rm(storageRoot, { recursive: true, force: true });
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-lifecycle-'));
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  it('SURVIVES THE APPLICATION MOVING TO A NEW RELEASE DIRECTORY', async () => {
    const master = await signIn(MASTER);
    const attached = await attach(master, 'service-agreement.pdf', 'the signed agreement');
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);

    const rows = await db.select().from(schema.customerDocuments);
    const key = rows[0]?.storageKey ?? '';
    expect(key.length).toBeGreaterThan(0);

    /*
     * A DEPLOYMENT, AS FAR AS THE PROCESS IS CONCERNED. `npm run build` goes
     * into `/opt/eje/releases/<commit>` and the symlink moves, so the next
     * process runs from a directory that did not exist when this file was
     * uploaded. Everything in memory is gone and the working directory is
     * different.
     *
     * The bytes are addressed by `EJE_STORAGE_DIR`, which is an absolute path
     * on a volume outside the release — so a brand-new adapter, built while the
     * process is CHDIR'd somewhere else entirely, still finds them. If anything
     * resolved storage relative to the application, this is the assertion that
     * would fail, and in production the symptom would be every document from
     * before the deployment quietly 404ing.
     */
    const releaseDirectory = await mkdtemp(join(tmpdir(), 'eje-release-'));
    chdir(releaseDirectory);
    startPostgresTestServer(url ?? '');

    const afterDeployment = new FilesystemStorageService({ root: storageRoot });
    const stored = await afterDeployment.getDocument(key);

    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored!.bytes)).toContain('the signed agreement');

    // And through the running application, which is what an office would do.
    const again = await signIn(MASTER);
    const download = await again.download(
      `/api/customers/${IDS.customer}/documents/${rows[0]?.id ?? ''}`,
    );
    expect(download.status).toBe(200);

    await rm(releaseDirectory, { recursive: true, force: true });
  });

  it('WRITES NO ROW WHEN THE STORAGE WRITE FAILS', async () => {
    /*
     * A FULL DISK, OR A PATH THAT IS NOT A DIRECTORY. Produced here the second
     * way, because it is the one a deployment actually gets wrong:
     * `EJE_STORAGE_DIR` pointed at a file. The adapter cannot create
     * `<root>/uploads/` under it, so the write raises — which is the contract
     * `storeUpload` has, and this is what proves the caller honours it.
     */
    const notADirectory = join(await mkdtemp(join(tmpdir(), 'eje-blocked-')), 'storage');
    await writeFile(notADirectory, 'this is a file, not a directory');

    process.env.EJE_STORAGE_DIR = notADirectory;
    startPostgresTestServer(url ?? '');

    const master = await signIn(MASTER);
    const attached = await attach(master, 'order.pdf', 'a customer order');

    /*
     * The office is told it failed, AND THE REASON IS THE STORAGE WRITE. Worth
     * asserting rather than accepting any 4xx: a test that passes because the
     * request was refused for an unrelated reason would prove nothing about
     * the ordering it is here for.
     */
    expect(attached.status).toBeGreaterThanOrEqual(400);
    expect(
      `${attached.error?.message ?? ''} ${(attached.error?.violations ?? [])
        .map((violation) => violation.message)
        .join(' ')}`.toLowerCase(),
    ).toMatch(/could not be stored/u);
    // And NO ROW. A row pointing at bytes that were never written is the
    // failure the bytes-first ordering exists to prevent.
    expect(await db.select().from(schema.customerDocuments)).toHaveLength(0);

    /*
     * AND THE PATH IS NOT IN THE ANSWER. `StorageWriteFailed` carries the
     * filesystem's own message, which names the directory — useful in the
     * server log, which is where `logUnexpected` puts it, and not something to
     * hand to a browser. The mapper uses fixed text; nothing from the cause
     * reaches the client.
     */
    const said = JSON.stringify(attached.error ?? {});
    expect(said).not.toContain(notADirectory);
    expect(said).not.toContain('/tmp');

    await rm(notADirectory, { force: true });
  });

  it('keeps two files with the SAME NAME apart', async () => {
    const master = await signIn(MASTER);

    // An iPhone sends IMG_0001.jpg for every photograph it has ever taken.
    const first = await attach(master, 'IMG_0001.pdf', 'the first nameplate');
    const second = await attach(master, 'IMG_0001.pdf', 'the second nameplate');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const rows = await db.select().from(schema.customerDocuments);
    expect(rows).toHaveLength(2);

    // Distinct keys, because a key is GENERATED and never derived from a name —
    // which is also what makes a name unable to be a path traversal.
    const keys = new Set(rows.map((row) => row.storageKey));
    expect(keys.size).toBe(2);

    // And both sets of bytes are there, each its own.
    const store = new FilesystemStorageService({ root: storageRoot });
    for (const row of rows) {
      const stored = await store.getDocument(row.storageKey);
      expect(stored).not.toBeNull();
      expect(new TextDecoder().decode(stored!.bytes)).toContain('nameplate');
    }
    const bodies = await Promise.all(
      rows.map(async (row) =>
        new TextDecoder().decode((await store.getDocument(row.storageKey))!.bytes),
      ),
    );
    expect(new Set(bodies).size).toBe(2);
  });

  it('lands BOTH of two uploads sent at the same instant', async () => {
    const master = await signIn(MASTER);

    /*
     * BOTH AT ONCE. Each upload generates its own key, so there is nothing to
     * collide over — but "nothing to collide over" is a claim about the
     * implementation, and this is the only way to find out whether the
     * transaction boundary, the idempotency store and the rollback tracking
     * cope with two at a time.
     */
    const [first, second] = await Promise.all([
      attach(master, 'one.pdf', 'the first document'),
      attach(master, 'two.pdf', 'the second document'),
    ]);

    expect(first.status, JSON.stringify(first.error)).toBe(200);
    expect(second.status, JSON.stringify(second.error)).toBe(200);

    const rows = await db.select().from(schema.customerDocuments);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.storageKey)).size).toBe(2);

    // Two files on the disk, and no third from a rollback that fired wrongly.
    const files = (await readdir(storageRoot, { recursive: true, withFileTypes: true })).filter(
      (entry) => entry.isFile() && entry.name.endsWith('.bin'),
    );
    expect(files).toHaveLength(2);
  });

  it('measures each concurrent upload against its OWN bytes', async () => {
    const master = await signIn(MASTER);
    const short = 'a';
    const long = 'a much longer document body, for a different length entirely';

    const [first, second] = await Promise.all([
      attach(master, 'short.pdf', short),
      attach(master, 'long.pdf', long),
    ]);

    // The failure this rules out is a shared buffer or a shared measurement
    // between two in-flight uploads: each row has to describe its own file.
    const byName = new Map(
      [first, second].map((response) => [
        response.data.document.fileName,
        response.data.document.sizeBytes,
      ]),
    );
    expect(byName.get('short.pdf')).toBe(pdf(short).byteLength);
    expect(byName.get('long.pdf')).toBe(pdf(long).byteLength);
    expect(byName.get('short.pdf')).not.toBe(byName.get('long.pdf'));
  });
});
