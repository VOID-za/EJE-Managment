import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * A ROLLED-BACK UPLOAD MUST NOT LEAVE ITS BYTES ON THE DISK.
 *
 * THE DEFECT, stated as the sequence that produced it. Every upload path does
 * this, in this order, and the order is right:
 *
 *   1. write the bytes            — `storeUpload`, outside any transaction
 *   2. read them back and measure — so the row describes real bytes
 *   3. insert the row             — inside the transaction
 *   4. write the audit event      — inside the transaction
 *
 * A failure at 3 or 4 rolls back the row and the audit event. It cannot roll
 * back step 1, because a filesystem has no transaction to join. So the bytes
 * stayed: a customer's document that the office was told had failed to upload,
 * sitting in the storage directory with no row to say whose it was or who may
 * read it — and from there into every backup and every restore of one.
 *
 * HOW THE FAILURE IS PRODUCED HERE. A trigger on `customer_documents` that
 * raises on INSERT. It is a fixture, not a change to the application: what it
 * simulates is the class of failure that actually happens — a constraint, an
 * immutability trigger, a lost connection — at exactly the point where the
 * bytes are already written. No production code is weakened to arrange it, and
 * the last test in this file drops the trigger and shows the same upload
 * succeeding, which is what proves the mechanism is the trigger and not a
 * broken route.
 *
 * It runs on PostgreSQL because that is where the transaction is. The
 * demonstration backend has no transaction to roll back, so this failure mode
 * cannot be expressed there at all.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const AGREEMENT = '%PDF-1.4\nsigned service agreement\n%%EOF';

describeDb('an upload whose database write fails', () => {
  let db: Database;
  let storageRoot: string;

  const signIn = async (email: string): Promise<ApiTestClient> => {
    const client = new ApiTestClient();
    const response = await client.signIn(email, PASSWORD);
    if (response.status !== 200) throw new Error(`sign-in failed for ${email}`);
    return client;
  };

  /** Every `.bin` under the store: the bytes, and nothing else. */
  const storedFiles = async (): Promise<readonly string[]> =>
    (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.bin'))
      .map((entry) => entry.name);

  const refuseInserts = async (): Promise<void> => {
    await db.execute(sql`
      create or replace function test_refuse_customer_document() returns trigger as $$
      begin
        raise exception 'test fixture: this insert is refused';
      end
      $$ language plpgsql
    `);
    await db.execute(sql`
      create trigger test_refuse_customer_document
        before insert on customer_documents
        for each row execute function test_refuse_customer_document()
    `);
  };

  const allowInserts = async (): Promise<void> => {
    await db.execute(
      sql`drop trigger if exists test_refuse_customer_document on customer_documents`,
    );
    await db.execute(sql`drop function if exists test_refuse_customer_document()`);
  };

  const attach = async (client: ApiTestClient) =>
    client.upload<{ document: { id: string } }>(`/api/customers/${IDS.customer}/documents`, {
      name: 'service-agreement.pdf',
      type: 'application/pdf',
      bytes: new TextEncoder().encode(AGREEMENT),
      fields: { caption: 'Signed service agreement, 2026' },
    });

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-upload-rollback-'));
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  afterAll(async () => {
    await allowInserts();
    await db.$client.end({ timeout: 5 });
    await rm(storageRoot, { recursive: true, force: true });
    delete process.env.EJE_STORAGE_DIR;
  });

  beforeEach(async () => {
    await allowInserts();
    await truncateAll(db);
    await seedBaseline(db);
    await db.update(schema.users).set({ passwordHash: await hashPassword(PASSWORD) });
    await rm(storageRoot, { recursive: true, force: true });
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-upload-rollback-'));
    process.env.EJE_STORAGE_DIR = storageRoot;
    startPostgresTestServer(url ?? '');
  });

  it('LEAVES NO FILE BEHIND', async () => {
    const master = await signIn(MASTER);
    await refuseInserts();

    const attached = await attach(master);

    // The office is told it failed, which is the honest answer.
    expect(attached.status).toBeGreaterThanOrEqual(400);

    // No row — the transaction did its job.
    const rows = await db.select().from(schema.customerDocuments);
    expect(rows).toHaveLength(0);

    // AND NO BYTES. This is the assertion the file exists for.
    expect(await storedFiles()).toEqual([]);
  });

  it('leaves no sidecar behind either', async () => {
    const master = await signIn(MASTER);
    await refuseInserts();
    await attach(master);

    const everything = (await readdir(storageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    // Not merely the bytes: a sidecar left on its own is a file nobody can
    // interpret, and the reconcile would report it as half-stored for ever.
    expect(everything).toEqual([]);
  });

  it('leaves nothing behind after several failed attempts', async () => {
    const master = await signIn(MASTER);
    await refuseInserts();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const attached = await attach(master);
      expect(attached.status).toBeGreaterThanOrEqual(400);
    }

    // Three failures used to mean three orphans. The number is what makes the
    // old behaviour visible: it grew with every retry a technician made.
    expect(await storedFiles()).toEqual([]);
  });

  it('keeps the bytes when the insert is allowed, which is what proves the fixture', async () => {
    const master = await signIn(MASTER);

    const attached = await attach(master);
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);

    const rows = await db.select().from(schema.customerDocuments);
    expect(rows).toHaveLength(1);
    expect(await storedFiles()).toHaveLength(1);
  });

  it('does not remove a file an EARLIER, successful upload wrote', async () => {
    /*
     * The rollback must undo only what its own unit of work created. A
     * cleanup that reached further would delete a customer's filed document
     * because somebody else's upload failed afterwards — the orphan problem
     * inverted, and worse.
     */
    const master = await signIn(MASTER);

    const first = await attach(master);
    expect(first.status).toBe(200);
    expect(await storedFiles()).toHaveLength(1);

    await refuseInserts();
    const second = await attach(master);
    expect(second.status).toBeGreaterThanOrEqual(400);

    // The first document's bytes are still there, and only its own.
    expect(await storedFiles()).toHaveLength(1);
    const rows = await db.select().from(schema.customerDocuments);
    expect(rows).toHaveLength(1);
  });
});
