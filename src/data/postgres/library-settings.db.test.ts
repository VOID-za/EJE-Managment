import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { asDocumentId, asUserId, getJobTypeDefinition, type TechnicalDocument } from '@/domain';
import type { Database } from '@/db/client';
import { machineTypeCodeFor, machineTypeFromCode, syncReferenceData } from '@/db/reference-data';
import * as schema from '@/db/schema';
import { PostgresDocumentRepository } from './document-repository';
import { PostgresJobRepository } from './job-repository';
import { PostgresSettingsRepository } from './settings-repository';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, seedBaseline } from './test-fixtures';

/**
 * The technical library, the settings row, and the reference data.
 *
 * The settings tests are the ones that matter most here: `nextJobSequence` has
 * no column, and the thing that replaced it — a PostgreSQL sequence — must
 * report the same number the allocator would hand out, and must be impossible
 * to move by saving the settings.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

describeDb('the library, the settings and the reference data', () => {
  let db: Database;
  let documents: PostgresDocumentRepository;
  let settings: PostgresSettingsRepository;
  let jobs: PostgresJobRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    documents = new PostgresDocumentRepository(db);
    settings = new PostgresSettingsRepository(db);
    jobs = new PostgresJobRepository(db);
  });

  const newDocument = (over: Partial<TechnicalDocument> = {}): TechnicalDocument => {
    const id = asDocumentId(crypto.randomUUID());
    return {
      id,
      name: 'Leadwell V40 machine manual',
      description: 'Operation and maintenance.',
      documentType: 'machine_manual',
      manufacturer: 'Leadwell',
      machineModel: 'V40',
      version: '4.0',
      status: 'current',
      fileName: 'leadwell-v40-manual.pdf',
      fileSizeBytes: 2_400_000,
      pageCount: 184,
      storageKey: `library/${id}/leadwell-v40-manual.pdf`,
      uploadedAt: '2026-02-01T09:00:00.000Z',
      uploadedBy: asUserId(IDS.master),
      tags: ['leadwell', 'v40'],
      ...over,
    };
  };

  describe('the technical library', () => {
    it('round trips a document with its file metadata and tags', async () => {
      const document = await documents.save(newDocument());

      expect(document.version).toBe('4.0');
      expect(document.pageCount).toBe(184);
      expect(document.tags).toEqual(['leadwell', 'v40']);

      const read = await documents.findById(document.id);
      expect(read?.storageKey).toContain('leadwell-v40-manual.pdf');
      expect(read?.status).toBe('current');
    });

    it('holds a technician’s upload as pending until a Master approves it', async () => {
      const pending = await documents.save(
        newDocument({ status: 'pending_approval', uploadedBy: asUserId(IDS.technician) }),
      );
      expect(pending.status).toBe('pending_approval');

      const rows = await db
        .select({ approvedAt: schema.libraryDocumentVersions.approvedAt })
        .from(schema.libraryDocumentVersions)
        .where(eq(schema.libraryDocumentVersions.documentId, pending.id));
      expect(rows[0]?.approvedAt).toBeNull();

      const approved = await documents.save({ ...pending, status: 'current' });
      expect(approved.status).toBe('current');
    });

    it('keeps a superseded revision alongside its successor, with its own file', async () => {
      const previous = await documents.save(newDocument());
      await documents.save({ ...previous, status: 'archived' });

      // The revision keeps the same file NAME, which is what used to collide.
      const revision = await documents.save(
        newDocument({ version: '5.0', fileName: previous.fileName }),
      );

      const all = await documents.list();
      expect(all).toHaveLength(2);
      expect(all.map((entry) => entry.version).sort()).toEqual(['4.0', '5.0']);
      expect(revision.storageKey).not.toBe(previous.storageKey);

      // The archived one still resolves, so a job that referenced it still does.
      const archived = await documents.findById(previous.id);
      expect(archived?.status).toBe('archived');
    });

    it('pins and unpins a document for one person only', async () => {
      const document = await documents.save(newDocument());

      const pinned = await documents.toggleFavourite(asUserId(IDS.technician), document.id);
      expect(pinned).toEqual([document.id]);
      expect(await documents.listFavourites(asUserId(IDS.otherTechnician))).toEqual([]);

      const unpinned = await documents.toggleFavourite(asUserId(IDS.technician), document.id);
      expect(unpinned).toEqual([]);
    });

    it('remembers what somebody looked at, most recent first, each once', async () => {
      const first = await documents.save(newDocument({ name: 'First' }));
      const second = await documents.save(newDocument({ name: 'Second', version: '1.0' }));

      await documents.recordView(asUserId(IDS.technician), first.id);
      await documents.recordView(asUserId(IDS.technician), second.id);
      await documents.recordView(asUserId(IDS.technician), first.id);

      const recent = await documents.listRecentlyViewed(asUserId(IDS.technician));
      expect(recent).toEqual([first.id, second.id]);
      expect(await documents.listRecentlyViewed(asUserId(IDS.master))).toEqual([]);
    });
  });

  describe('the settings row and the job-number sequence', () => {
    it('round trips rates as exact cents and VAT as an exact percentage', async () => {
      const current = await settings.get();
      const saved = await settings.save({
        ...current,
        labourRates: { ...current.labourRates, normal: 98_500 },
        vatPercentage: 15.5,
      });

      expect(saved.labourRates.normal).toBe(98_500);
      // 15.5, not 15.500000000000002 — the column is basis points for this.
      expect(saved.vatPercentage).toBe(15.5);
      expect((await settings.get()).vatPercentage).toBe(15.5);
    });

    it('reports the number the allocator would actually hand out next', async () => {
      const before = await settings.get();
      expect(before.nextJobSequence).toBe(1068);

      const allocated = await jobs.allocateJobNumber();
      expect(allocated.sequence).toBe(1068);
      expect(allocated.jobNumber).toBe('EJE-1068');

      const after = await settings.get();
      expect(after.nextJobSequence).toBe(1069);
    });

    it('cannot be made to move the allocator by saving the settings', async () => {
      const current = await settings.get();
      await settings.save({ ...current, nextJobSequence: 5_000 });

      // The sequence is the allocator. A settings write is not.
      const allocated = await jobs.allocateJobNumber();
      expect(allocated.sequence).toBe(1068);
      expect((await settings.get()).nextJobSequence).toBe(1069);
    });

    it('carries the prefix from the settings row into the allocated number', async () => {
      const current = await settings.get();
      await settings.save({ ...current, jobNumberPrefix: 'EJE/' });

      const allocated = await jobs.allocateJobNumber();
      expect(allocated.jobNumber).toBe('EJE/1068');
    });

    it('says so plainly when there is no settings row to read', async () => {
      await db.execute(sql`delete from system_settings`);
      await expect(settings.get()).rejects.toThrow(/business data/);
    });
  });

  describe('reference data', () => {
    it('projects the job types from the domain definitions', async () => {
      const rows = await db.select().from(schema.jobTypes).orderBy(schema.jobTypes.position);
      expect(rows.map((row) => row.code)).toEqual([
        'breakdown',
        'installation',
        'service',
        'test_and_repair',
        'parts',
      ]);

      const parts = rows.find((row) => row.code === 'parts');
      expect(parts?.orderNumberExpectation).toBe('required');
      expect(parts?.collectedOnCompletion).toBe(true);
      expect(parts?.checklistRequired).toBe(getJobTypeDefinition('parts').checklistRequired);

      // DECISION 2's middle case, which a boolean could not express.
      expect(rows.find((row) => row.code === 'service')?.orderNumberExpectation).toBe('expected');
      expect(rows.find((row) => row.code === 'breakdown')?.orderNumberExpectation).toBe('optional');
    });

    it('is safe to run again, and never removes a type a job was raised under', async () => {
      await syncReferenceData(db);
      await syncReferenceData(db);

      const rows = await db.select().from(schema.jobTypes);
      expect(rows).toHaveLength(5);
    });

    it('maps a machine type label to a key that survives a relabelling', async () => {
      expect(machineTypeCodeFor('CNC Milling Machine')).toBe('cnc_milling_machine');
      expect(machineTypeFromCode('cnc_milling_machine')).toBe('CNC Milling Machine');
      // A type this build has never heard of still lets the machine be opened.
      expect(machineTypeFromCode('plasma_cutter')).toBe('Other');

      const rows = await db.select().from(schema.machineTypes);
      expect(rows).toHaveLength(6);
    });
  });
});
