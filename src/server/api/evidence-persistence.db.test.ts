import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { asChecklistTemplateId, type ChecklistTemplate } from '@/domain';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { PostgresChecklistTemplateRepository } from '@/data/postgres/checklist-template-repository';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { hashPassword } from '@/server/auth/passwords';
import { ApiTestClient, startPostgresTestServer } from '@/test/api-harness';

/**
 * CHECKLIST EVIDENCE AND MACHINE PHOTOGRAPHS, ON REAL POSTGRESQL AND REAL
 * STORAGE. CHK-EVIDENCE-1, MACH-PHOTO-1.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE API TESTS. Those run against the
 * demonstration backend, where storage keeps bytes in a process-local store and
 * the repositories are in memory. Everything about these two paths that could
 * go wrong on the real backend is in the parts that file cannot reach: the
 * `checklist_answer_photos` row and its foreign key to the ANSWER (which is
 * itself keyed to the question and the version), the `machine_photos` row, and
 * the filesystem adapter actually holding the bytes.
 *
 * AUD-6's lesson, applied: a path that has never run against PostgreSQL is a
 * path nobody has tested. So each upload here is made through the real route
 * and then verified twice — the row is read straight out of the table, and the
 * bytes are fetched back through the authenticated download route.
 *
 * This file opens, truncates and seeds its own database (QA-6): it reads no
 * row it did not write, so its result cannot depend on which file ran first.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const PASSWORD = 'a-real-test-password';
const MASTER = 'elmarie@example-test.co.za';
const TECHNICIAN = 'sipho@example-test.co.za';

const png = (label: string): Uint8Array => {
  const text = new TextEncoder().encode(label);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...text]);
};

/** A service checklist with one item that REQUIRES a photograph. */
const TEMPLATE_ID = asChecklistTemplateId('00000000-0000-4000-8000-000000000200');
const SECTION_ID = '00000000-0000-4000-8000-000000000201';
const ITEM_ID = '00000000-0000-4000-8000-000000000202';

const template = (): ChecklistTemplate => ({
  id: TEMPLATE_ID,
  name: 'Service checklist',
  description: 'Planned preventative maintenance.',
  jobTypeCode: 'service',
  version: '1.0',
  status: 'current',
  sourceDocument: 'TEST CONTENT',
  updatedAt: '2026-10-01T08:00:00.000Z',
  sections: [
    {
      id: SECTION_ID,
      title: 'Condition',
      description: '',
      items: [
        {
          id: ITEM_ID,
          text: 'Spindle bearing condition photographed',
          helpText: '',
          responseType: 'pass_fail_na',
          required: true,
          photoRequired: true,
          unit: null,
          expectedRange: null,
        },
      ],
    },
  ],
});

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
}
interface MachineBody {
  readonly id: string;
  readonly approval: string;
}
interface EvidenceList {
  readonly photos: readonly { readonly id: string; readonly sizeBytes: number }[];
}
interface PhotoList {
  readonly photos: readonly { readonly id: string; readonly sizeBytes: number }[];
}

describeDb('evidence that is actually stored, on PostgreSQL', () => {
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
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-evidence-'));
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
    await new PostgresChecklistTemplateRepository(db).save(template());
  });

  /** A service job, accepted, with its checklist started. */
  const startedChecklist = async (): Promise<{
    tech: ApiTestClient;
    job: JobBody;
  }> => {
    const master = await signIn(MASTER);
    const created = await master.post<JobBody>('/api/jobs', {
      customerId: IDS.customer,
      siteId: IDS.site,
      contactId: IDS.contact,
      machineId: IDS.machine,
      jobType: 'service',
      priority: 'normal',
      scheduledDate: '2026-10-20',
      scheduledEndDate: null,
      orderNumber: 'PO-91000',
      referenceNumber: '',
      faultDescription: 'Six-monthly service.',
      primaryTechnicianId: IDS.technician,
      courierCollection: false,
      deliveryNote: '',
    });
    expect(created.status).toBe(200);

    const tech = await signIn(TECHNICIAN);
    expect((await tech.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(200);
    expect((await tech.post(`/api/jobs/${created.data.id}/start_checklist`)).status).toBe(200);
    return { tech, job: created.data };
  };

  /* -- checklist evidence -------------------------------------------------- */

  it('writes a checklist_answer_photos row, bound to the answer', async () => {
    const { tech, job } = await startedChecklist();
    const bytes = png('bearing condition');

    const uploaded = await tech.upload<EvidenceList>(
      `/api/jobs/${job.id}/checklist/${ITEM_ID}/photo`,
      { name: 'bearing.png', type: 'image/png', bytes, fields: { caption: 'Bearing' } },
    );
    expect(uploaded.status).toBe(200);
    expect(uploaded.data.photos[0]?.sizeBytes).toBe(bytes.length);

    const rows = await db.select().from(schema.checklistAnswerPhotos);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fileName).toBe('bearing.png');
    expect(rows[0]?.caption).toBe('Bearing');
    expect(Number(rows[0]?.sizeBytes)).toBe(bytes.length);
    expect(rows[0]?.uploadedBy).toBe(IDS.technician);
    // A real generated key, not a client-supplied path.
    expect(rows[0]?.storageKey.length).toBeGreaterThan(0);
    expect(rows[0]?.storageKey).not.toContain('..');

    // And the row hangs off the ANSWER, which hangs off the question and the
    // version — so the evidence can never drift onto another item.
    const answers = await db
      .select()
      .from(schema.checklistAnswers)
      .where(eq(schema.checklistAnswers.id, rows[0]?.answerId ?? ''));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.questionId).toBe(ITEM_ID);
  });

  it('serves the exact bytes back through the authenticated route', async () => {
    const { tech, job } = await startedChecklist();
    const bytes = png('the frame itself, on postgres');

    const uploaded = await tech.upload<EvidenceList>(
      `/api/jobs/${job.id}/checklist/${ITEM_ID}/photo`,
      { name: 'frame.png', type: 'image/png', bytes },
    );
    const id = uploaded.data.photos[0]?.id ?? '';

    const download = await tech.download(`/api/jobs/${job.id}/media/${id}`);
    expect(download.status).toBe(200);
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
  });

  it('keeps the evidence through a reload of the job', async () => {
    // The round trip that matters: it is read back out of PostgreSQL by the
    // ordinary job read, not from anything the upload left in memory.
    const { tech, job } = await startedChecklist();
    await tech.upload(`/api/jobs/${job.id}/checklist/${ITEM_ID}/photo`, {
      name: 'kept.png',
      type: 'image/png',
      bytes: png('kept'),
      fields: { caption: 'Still here' },
    });

    const view = await tech.get<{
      view: {
        job: {
          checklist: {
            templateVersion: string;
            responses: readonly { itemId: string; photos: readonly { caption: string }[] }[];
          };
        };
      };
    }>(`/api/jobs/${job.jobNumber}`);

    const answered = view.data.view.job.checklist.responses.find(
      (response) => response.itemId === ITEM_ID,
    );
    expect(view.data.view.job.checklist.templateVersion).toBe('1.0');
    expect(answered?.photos.map((photo) => photo.caption)).toEqual(['Still here']);
  });

  it('writes ONE row when the same capture is retried', async () => {
    const { tech, job } = await startedChecklist();
    const bytes = png('sent twice');
    const key = 'evidence-retry-on-postgres';

    const first = await tech.upload<EvidenceList>(
      `/api/jobs/${job.id}/checklist/${ITEM_ID}/photo`,
      { name: 'retry.png', type: 'image/png', bytes },
      { idempotencyKey: key },
    );
    const retry = await tech.upload<EvidenceList>(
      `/api/jobs/${job.id}/checklist/${ITEM_ID}/photo`,
      { name: 'retry.png', type: 'image/png', bytes },
      { idempotencyKey: key },
    );

    expect(first.status).toBe(200);
    expect(retry.headers.get('Idempotent-Replay')).toBe('true');
    // THE POINT: one photograph in the table, not two.
    expect(await db.select().from(schema.checklistAnswerPhotos)).toHaveLength(1);
    // And the marker was written in the same transaction as the work.
    const markers = await db.select().from(schema.apiIdempotency);
    expect(markers).toHaveLength(1);
  });

  it('writes NOTHING when the file is refused', async () => {
    const { tech, job } = await startedChecklist();
    // Starting the checklist already writes the instance and an answer row per
    // question, so the claim worth making is that the REFUSAL adds nothing —
    // not that the table is empty.
    const answersBefore = await db.select().from(schema.checklistAnswers);

    const refused = await tech.upload(`/api/jobs/${job.id}/checklist/${ITEM_ID}/photo`, {
      name: 'order.pdf',
      type: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF-1.4 a quotation'),
    });

    expect(refused.status).toBe(400);
    // No photograph row, and no bytes: the file is sniffed and refused before
    // `storeUpload` is reached, so there is nothing to clean up afterwards.
    expect(await db.select().from(schema.checklistAnswerPhotos)).toHaveLength(0);
    expect(await db.select().from(schema.checklistAnswers)).toHaveLength(answersBefore.length);
    // And no idempotency marker was left behind to block a later, valid retry.
    expect(await db.select().from(schema.apiIdempotency)).toHaveLength(0);
  });

  /* -- machine photographs ------------------------------------------------- */

  const raiseMachine = async (client: ApiTestClient, serial: string) =>
    client.post<MachineBody>('/api/machines', {
      customerId: IDS.customer,
      siteId: IDS.site,
      manufacturer: 'Mazak',
      model: 'QT-200',
      serialNumber: serial,
      machineNumber: '',
      machineType: 'CNC Lathe',
      year: 2019,
      installationDate: '2019-06-01',
      controlSystem: 'Mazatrol',
      notes: '',
      active: true,
    });

  it('writes a machine_photos row with the measured size, and serves it back', async () => {
    const master = await signIn(MASTER);
    const machine = await raiseMachine(master, 'QT200-DB-1');
    expect(machine.status).toBe(200);
    const bytes = png('rating plate on postgres');

    const uploaded = await master.upload<PhotoList>(`/api/machines/${machine.data.id}/photos`, {
      name: 'plate.png',
      type: 'image/png',
      bytes,
      fields: { caption: 'Rating plate' },
    });
    expect(uploaded.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.machinePhotos)
      .where(eq(schema.machinePhotos.machineId, machine.data.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.caption).toBe('Rating plate');
    expect(Number(rows[0]?.sizeBytes)).toBe(bytes.length);
    expect(rows[0]?.uploadedBy).toBe(IDS.master);

    const download = await master.download(
      `/api/machines/${machine.data.id}/photos/${uploaded.data.photos[0]?.id ?? ''}`,
    );
    expect(download.status).toBe(200);
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
  });

  it('refuses a technician photographing an approved machine, and writes no row', async () => {
    const master = await signIn(MASTER);
    const machine = await raiseMachine(master, 'QT200-DB-2');
    const tech = await signIn(TECHNICIAN);

    const refused = await tech.upload(`/api/machines/${machine.data.id}/photos`, {
      name: 'plate.png',
      type: 'image/png',
      bytes: png('not allowed'),
    });

    expect(refused.status).toBe(403);
    expect(await db.select().from(schema.machinePhotos)).toHaveLength(0);
    // And the machine itself is untouched — still approved, still the office's.
    const stored = await db
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, machine.data.id));
    expect(stored[0]?.approval).toBe('approved');
  });

  it('lets a technician photograph their OWN pending machine, and keeps it pending', async () => {
    const tech = await signIn(TECHNICIAN);
    const machine = await raiseMachine(tech, 'QT200-DB-3');
    expect(machine.data.approval).toBe('pending_approval');

    const uploaded = await tech.upload<PhotoList>(`/api/machines/${machine.data.id}/photos`, {
      name: 'as-found.png',
      type: 'image/png',
      bytes: png('as found'),
    });

    expect(uploaded.status).toBe(200);
    expect(await db.select().from(schema.machinePhotos)).toHaveLength(1);

    const stored = await db
      .select()
      .from(schema.machines)
      .where(eq(schema.machines.id, machine.data.id));
    // A photograph is not an approval. MACH-PHOTO-1.
    expect(stored[0]?.approval).toBe('pending_approval');
  });
});
