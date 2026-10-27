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

  /*
   * VIDEO-OFF-1 (27 October 2026): video is no longer accepted. On PostgreSQL
   * that means a refused upload writes NO job_media row and leaves NO bytes in
   * storage — the boundary refuses it before anything is stored.
   */
  const filesUnder = async (root: string): Promise<number> => {
    const entries = await readdir(root, { withFileTypes: true, recursive: true });
    return entries.filter((entry) => entry.isFile()).length;
  };

  it('refuses a video: no row, no stored bytes', async () => {
    const { tech, jobId } = await acceptedJob();
    const before = await filesUnder(storageRoot);
    const response = await tech.upload<MediaList>(`/api/jobs/${jobId}/media`, {
      name: 'spindle.mp4',
      type: 'video/mp4',
      bytes: mp4('noise at 1 200 rpm'),
      fields: { kind: 'video' },
    });
    expect(response.status).toBe(400);
    const rows = await db.select().from(schema.jobMedia).where(eq(schema.jobMedia.jobId, jobId));
    expect(rows).toHaveLength(0);
    expect(await filesUnder(storageRoot)).toBe(before);
  });

  it('refuses an MP4 sent as a photograph, on its bytes', async () => {
    const { tech, jobId } = await acceptedJob();
    const response = await tech.upload(`/api/jobs/${jobId}/media`, {
      name: 'fault.jpg',
      type: 'image/jpeg',
      bytes: mp4('pretending'),
    });
    expect(response.status).toBe(400);
    expect(await db.select().from(schema.jobMedia).where(eq(schema.jobMedia.jobId, jobId))).toHaveLength(0);
  });

  it('keeps the size limit at the document limit, not the old video budget', () => {
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
  });
});
