import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { asAttachmentId, asUserId } from '@/domain';
import type { Database } from '@/db/client';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresJobRepository } from './job-repository';

/**
 * MIGRATION 0049 ON PostgreSQL — 3 November 2026.
 *
 * A Delivery Note may have no site; every other job type still must
 * (DN-SITE-OPT-1). The office's delivery-note photo on a Test & Repair job is
 * an internal photo, and the database keeps it so — it can never become
 * customer-facing, and so never reach the job card (TR-REF-PHOTO-1).
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;
const NOW = '2026-11-03T08:00:00.000Z';

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    const error = cause as { message?: string; cause?: { message?: string } };
    return `${error.message ?? ''} ${error.cause?.message ?? ''}`;
  }
  throw new Error('expected the database to refuse the statement');
};

describeDb('migration 0049 — the Test & Repair delivery-note photo, a Delivery Note without a site', () => {
  let db: Database;
  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
  });

  it('DN-SITE-OPT-1: a Delivery Note is saved and read without a site; any other job type is refused one', async () => {
    const jobs = new PostgresJobRepository(db);
    const note = await jobs.save(jobFixture((await jobs.allocateJobNumber()).jobNumber, {
      jobType: 'delivery_note', status: 'completion', primaryTechnicianId: null, siteId: null, deliveryDate: '2026-11-03',
    }));
    expect((await jobs.findById(note.id))?.siteId).toBeNull();
    const breakdown = await jobs.save(jobFixture((await jobs.allocateJobNumber()).jobNumber));
    expect(await refusal(db.execute(sql`update jobs set site_id = null where id = ${breakdown.id}`))).toMatch(/jobs_site_required_unless_delivery_note/u);
  });

  it('TR-REF-PHOTO-1: the reference photo persists as internal, and the database refuses it customer-facing', async () => {
    const jobs = new PostgresJobRepository(db);
    const job = await jobs.save(jobFixture((await jobs.allocateJobNumber()).jobNumber, { jobType: 'test_and_repair' }));
    const id = asAttachmentId(crypto.randomUUID());
    await jobs.save({
      ...job,
      photos: [{
        id, kind: 'photo', visibility: 'internal', purpose: 'delivery_note_reference', fileName: 'delivery-note.jpg', caption: 'Delivery note (reference)',
        storageKey: 'uploads/dn', uploadedAt: NOW, uploadedBy: asUserId(IDS.coordinator), sizeBytes: 10, checksumSha256: null, provenance: 'genuine',
      }],
    });
    const read = await jobs.findById(job.id);
    expect(read?.photos.find((photo) => photo.id === id)).toMatchObject({ purpose: 'delivery_note_reference', visibility: 'internal' });
    expect(await refusal(db.execute(sql`update job_media set visibility = 'customer_facing' where id = ${id}`))).toMatch(/job_media_reference_photo_internal/u);
    expect(await refusal(db.execute(sql`update job_media set purpose = 'anything' where id = ${id}`))).toMatch(/job_media_purpose_known/u);
    // An ordinary photo is untouched by the rule.
    const plain = asAttachmentId(crypto.randomUUID());
    await db.execute(sql`insert into job_media (id, job_id, kind, visibility, file_name, storage_key, uploaded_at) values (${plain}, ${job.id}, 'photo', 'customer_facing', 'fault.jpg', 'uploads/f', now())`);
  });
});
