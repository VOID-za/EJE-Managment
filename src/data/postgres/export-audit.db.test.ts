import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { Database } from '@/db/client';
import { asUserId, type User } from '@/domain';
import { describeExport, recordExport } from '@/application/export-audit';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { builtinPdfText } from '@/services/pdf-text';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SystemClock } from '@/services/simulated/system';
import { UuidGenerator } from '@/services/production/ids';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { createPostgresRepositories } from './repositories';
import { IDS, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';

/**
 * AN EXPORT IS RECORDED IN PostgreSQL, AND NOTHING REMOVES IT. BD-18, answered.
 *
 * The application tests prove the event is written; the demonstration store
 * holds the event OBJECT, so it cannot answer what reaches a column. What only
 * PostgreSQL can show is the part the owner's decision turns on:
 *
 *  - THE ROW IS REALLY THERE, in `audit_events`, with the filters in the
 *    untyped `jsonb` metadata column and the actor against it.
 *  - IT SURVIVES further work on the database, which is what "retain
 *    indefinitely" means in practice. A test cannot prove the absence of a
 *    future deletion; it CAN show there is no mechanism doing it today — there
 *    is no retention job, no sweeper and no TTL anywhere in this system.
 *  - AND THE ROW DOES NOT CARRY THE EXPORTED DATA.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

describeDb('the export audit, on PostgreSQL', () => {
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

  const context = () => {
    const repos = createPostgresRepositories(db);
    const clock = new SystemClock();
    // Real UUIDs, because `audit_events.id` is a uuid column — the sequential
    // generator is for the demonstration store, which has no column types.
    const ids = new UuidGenerator();
    const outbox = new SimulatedOutbox();
    const actor = {
      id: asUserId(IDS.master),
      firstName: 'Elmarie',
      lastName: 'van Wyk',
      role: 'master',
    } as User;
    return {
      repos,
      actor,
      services: {
        clock,
        ids,
        email: new SimulatedEmailService(outbox, clock, ids),
        whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
        pdf: new SimulatedPdfService(clock),
        pdfText: builtinPdfText(),
        storage: new DemoStorageService(inMemoryFileStore()),
      },
    };
  };

  const take = async (rowCount: number, filters: Readonly<Record<string, string>> = {}) => {
    const operation = context();
    return recordExport(
      operation,
      describeExport({
        kind: 'closed-jobs',
        actor: operation.actor,
        filters,
        rowCount,
        columns: ['Job number', 'Total (incl. VAT)'],
        takenAt: operation.services.clock.now(),
      }),
    );
  };

  it('writes the row, with the actor and no job against it', async () => {
    const outcome = await take(42, { customerId: 'cust-abc' });
    expect(outcome.written).toBe(true);

    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.type, 'data_exported'));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBe(IDS.master);
    // An export is not about one job, so there is none to point at.
    expect(rows[0]?.jobId).toBeNull();
    expect(rows[0]?.summary).toContain('42');
  });

  it('keeps the FILTERS in the metadata column, which is how "who took what" is answerable', async () => {
    await take(7, { customerId: 'cust-abc', jobType: 'service' });

    const [row] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.type, 'data_exported'));

    expect(row?.metadata).toEqual({
      changes: [
        { field: 'customerId', from: null, to: 'cust-abc' },
        { field: 'jobType', from: null, to: 'service' },
      ],
    });
  });

  it('names the COLUMNS taken, and never a row of data', async () => {
    await take(3);

    const [row] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.type, 'data_exported'));

    expect(row?.detail).toContain('2 column(s)');
    // The record says WHICH columns were taken; it does not reproduce a figure
    // from any of them.
    expect(JSON.stringify(row)).not.toMatch(/\bEJE-1\d{3}\b/u);
  });

  it('SURVIVES further exports and reads — nothing expires an audit event', async () => {
    await take(1);
    const [first] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.type, 'data_exported'));
    expect(first).toBeDefined();

    // More work on the same database, then look again.
    await take(2);
    await take(3);
    await createPostgresRepositories(db).activity.list();

    const still = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.id, first!.id));
    expect(still).toHaveLength(1);

    // And all three are there: none was rotated out to make room.
    const all = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.type, 'data_exported'));
    expect(all).toHaveLength(3);
  });

  it('reads back through the repository as an activity event', async () => {
    await take(5);
    const events = await createPostgresRepositories(db).activity.list();
    const event = events.find((candidate) => candidate.type === 'data_exported');

    expect(event).toBeDefined();
    expect(event!.jobId).toBeNull();
  });
});
