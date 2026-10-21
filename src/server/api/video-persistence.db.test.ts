import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';
import { MAX_UPLOAD_BYTES } from '@/lib/upload-limits';

/**
 * A VIDEO ON REAL POSTGRESQL AND REAL STORAGE. MEDIA-5.
 *
 * The API tests run against the demonstration backend, where storage keeps
 * bytes as base64 in a snapshot. Three things only the real backend can answer,
 * and all three are here:
 *
 *   - THE SIZE. A clip larger than the 25 MB a document may be has to go
 *     through, and the demonstration store cannot be used to show it: base64
 *     of 26 MB in a test process takes twenty seconds and proves nothing about
 *     the route. Through the filesystem adapter it is a write and a hash.
 *   - THE ROW. `job_media` with `kind = 'video'`, its measured size and its
 *     checksum, read straight out of the table rather than from a response.
 *   - SURVIVAL. The bytes are still there, and still identical, after the
 *     server has been rebuilt from nothing — which is what "durable" has to
 *     mean for a file on a job.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const TECHNICIAN = 'sipho@example-test.co.za';
const OTHER_TECHNICIAN = 'lerato@example-test.co.za';

/** An ISO base media header: box length, `ftyp`, then the brand. */
const mp4 = (label: string): Uint8Array => {
  const text = new TextEncoder().encode(label);
  return new Uint8Array([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...text,
  ]);
};

interface MediaList {
  readonly videos: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly sizeBytes: number;
    readonly visibility: string;
  }[];
}

describeDb('a video on PostgreSQL', () => {
  let db: Database;
  let storageRoot: string;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-video-'));
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await rm(storageRoot, { recursive: true, force: true });
    delete process.env.EJE_STORAGE_DIR;
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  /** A breakdown job, accepted by the technician, so capture is permitted. */
  const acceptedJob = async (): Promise<{ tech: ApiTestClient; jobId: string }> => {
    const master = await signIn(MASTER);
    const created = await master.post<{ id: string }>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: 'PO-92000',
      referenceNumber: '',
      faultDescription: 'Intermittent noise from the spindle.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
    });
    expect(created.status, JSON.stringify(created.error)).toBe(200);

    const tech = await signIn(TECHNICIAN);
    expect((await tech.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(200);
    return { tech, jobId: created.data.id };
  };

  const record = async (
    client: ApiTestClient,
    jobId: string,
    bytes: Uint8Array,
    caption = '',
  ) =>
    client.upload<MediaList>(`/api/jobs/${jobId}/media`, {
      name: 'spindle.mp4',
      type: 'video/mp4',
      bytes,
      fields: { kind: 'video', caption },
    });

  it('writes the row, the bytes and the checksum the store measured', async () => {
    const { tech, jobId } = await acceptedJob();
    const bytes = mp4('spindle noise at 1 200 rpm');

    const uploaded = await record(tech, jobId, bytes, 'Noise at 1 200 rpm');
    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(200);

    const rows = await db.select().from(schema.jobMedia).where(eq(schema.jobMedia.jobId, jobId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('video');
    expect(rows[0]?.sizeBytes).toBe(bytes.byteLength);
    expect(rows[0]?.checksumSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    // Filed for the office, decided by the server. See the route.
    expect(rows[0]?.visibility).toBe('internal');

    // And the bytes are on the disk under the key the row carries.
    const stored = await readdir(storageRoot, { recursive: true, withFileTypes: true });
    expect(stored.filter((entry) => entry.isFile() && entry.name.endsWith('.bin'))).toHaveLength(1);
  });

  it('CARRIES A CLIP LARGER THAN A DOCUMENT MAY BE', async () => {
    /*
     * The whole reason video has a limit of its own. 26 MB is past the 25 MB
     * ceiling on a document and well inside what a video may be, so this is
     * the one assertion that would fail if the route kept the document bound.
     */
    const { tech, jobId } = await acceptedJob();
    const big = new Uint8Array(MAX_UPLOAD_BYTES + 1024 * 1024);
    big.set(mp4('a long clip'), 0);

    const uploaded = await record(tech, jobId, big);

    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(200);
    expect(uploaded.data.videos[0]?.sizeBytes).toBe(big.byteLength);

    const rows = await db.select().from(schema.jobMedia);
    expect(rows[0]?.sizeBytes).toBe(big.byteLength);
  }, 30_000);

  it('gives back the exact bytes, and still does after the server is rebuilt', async () => {
    const { tech, jobId } = await acceptedJob();
    const bytes = mp4('the one and only clip');
    const uploaded = await record(tech, jobId, bytes);
    const id = uploaded.data.videos[0]?.id ?? '';

    const first = await tech.download(`/api/jobs/${jobId}/media/${id}`);
    expect(first.status).toBe(200);
    expect(Array.from(first.bytes)).toEqual(Array.from(bytes));

    /*
     * EVERYTHING IN MEMORY IS THROWN AWAY. A new runtime, new repositories, a
     * new storage adapter over the same directory — which is what a restart,
     * or a deployment into a new release directory, actually does to this
     * process. The bytes are on a filesystem outside it, so they survive.
     */
    startPostgresTestServer(url ?? '');
    const again = await signIn(TECHNICIAN);
    const second = await again.download(`/api/jobs/${jobId}/media/${id}`);

    expect(second.status).toBe(200);
    expect(Array.from(second.bytes)).toEqual(Array.from(bytes));
    expect(second.headers.get('content-type')).toBe('video/mp4');
  });

  it('is included in the backup reference count, like any other stored file', async () => {
    /*
     * Not an incidental property. `job_media.storage_key` is one of the
     * columns the backup and the restore test read, so a video is covered by
     * both the moment it is a row — there is nothing video-specific to
     * remember. Asserted on the column rather than by running a backup, which
     * `backup.db.test.ts` does.
     */
    const { tech, jobId } = await acceptedJob();
    await record(tech, jobId, mp4('clip'));

    const rows = await db.select().from(schema.jobMedia);
    expect(rows[0]?.storageKey).toMatch(/^uploads\//u);
  });

  it('is refused for a technician who is not on the job, as not found', async () => {
    const { jobId } = await acceptedJob();
    const stranger = await signIn(OTHER_TECHNICIAN);

    const refused = await record(stranger, jobId, mp4('not their job'));
    // 404, not 403: a job that is not theirs and one that does not exist must
    // be indistinguishable from outside.
    expect(refused.status).toBe(404);

    const rows = await db.select().from(schema.jobMedia);
    expect(rows).toHaveLength(0);
  });
});
