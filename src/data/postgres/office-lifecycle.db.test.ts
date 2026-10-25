import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { PostgresJobRepository } from './job-repository';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import * as schema from '@/db/schema';
import { asUserId, type Job } from '@/domain';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';

/**
 * MIGRATION 0032, AGAINST REAL POSTGRESQL. Issue #73, Batch 1.
 *
 * The three new statuses, the five columns and what the database itself
 * refuses: an invoiced job with no invoice number, an Awaiting PO job nobody
 * handled, a blank invoice number, and — by trigger — rewriting a recorded
 * one. Historical rows are not touched by the migration; that is asserted by
 * reading a Closed job back unchanged.
 */
const postgresMessage = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the statement was expected to be refused, and was not');
};

const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;
const MASTER = asUserId(IDS.master);

describeDb('the office lifecycle in PostgreSQL (migration 0032)', () => {
  let db: Database;
  let repository: PostgresJobRepository;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.execute(sql`select 1`);
  });

  beforeEach(async () => {
    await truncateAll(db);
    repository = new PostgresJobRepository(db);
    await seedBaseline(db);
  });

  const newJob = async (over: Partial<Job> = {}): Promise<Job> => {
    const allocated = await repository.allocateJobNumber();
    return jobFixture(allocated.jobNumber, { machineId: null, ...over });
  };

  it('stores and reads back each office step, with who and when', async () => {
    const handling = await repository.save(await newJob({ status: 'office_handling' }));
    expect((await repository.findById(handling.id))?.status).toBe('office_handling');

    const awaitingPo = await repository.save({
      ...handling,
      status: 'awaiting_po',
      officeHandling: { handledBy: MASTER, handledAt: '2026-10-25T09:00:00.000Z' },
    });
    const readPo = await repository.findById(awaitingPo.id);
    expect(readPo?.status).toBe('awaiting_po');
    expect(readPo?.officeHandling?.handledBy).toBe(MASTER);

    const invoiced = await repository.save({
      ...awaitingPo,
      status: 'invoiced',
      invoice: { number: 'INV-PG-1', recordedBy: MASTER, recordedAt: '2026-10-25T10:00:00.000Z' },
    });
    const read = await repository.findById(invoiced.id);
    expect(read?.status).toBe('invoiced');
    expect(read?.invoice?.number).toBe('INV-PG-1');
    expect(read?.invoice?.recordedBy).toBe(MASTER);
    expect(read?.closedAt).toBeNull();

    // And the summaries the Notifications tabs read carry the same records.
    const [summary] = await repository.listSummaries({ statuses: ['invoiced'] });
    expect(summary?.invoice?.number).toBe('INV-PG-1');
    expect(summary?.officeHandling?.handledBy).toBe(MASTER);
  });

  it('REFUSES an invoiced job with no invoice number', async () => {
    const job = await repository.save(await newJob());
    const message = await postgresMessage(
      db.update(schema.jobs).set({ status: 'invoiced' }).where(eq(schema.jobs.id, job.id)),
    );
    expect(message).toMatch(/jobs_invoiced_has_invoice_number|jobs_awaiting_po_was_handled/);
  });

  it('REFUSES Awaiting PO on a job nobody handled', async () => {
    const job = await repository.save(await newJob());
    const message = await postgresMessage(
      db.update(schema.jobs).set({ status: 'awaiting_po' }).where(eq(schema.jobs.id, job.id)),
    );
    expect(message).toMatch(/jobs_awaiting_po_was_handled/);
  });

  it('REFUSES a blank invoice number, and half an invoice record', async () => {
    const job = await repository.save(await newJob());
    expect(
      await postgresMessage(
        db
          .update(schema.jobs)
          .set({ invoiceNumber: '   ', invoicedBy: IDS.master, invoicedAt: '2026-10-25T10:00:00Z' })
          .where(eq(schema.jobs.id, job.id)),
      ),
    ).toMatch(/jobs_invoice_is_whole_or_absent/);
    expect(
      await postgresMessage(
        db.update(schema.jobs).set({ invoiceNumber: 'INV-1' }).where(eq(schema.jobs.id, job.id)),
      ),
    ).toMatch(/jobs_invoice_is_whole_or_absent/);
  });

  it('NEVER lets a recorded invoice number be rewritten — the trigger refuses it', async () => {
    const job = await repository.save(
      await newJob({
        status: 'invoiced',
        officeHandling: { handledBy: MASTER, handledAt: '2026-10-25T09:00:00.000Z' },
        invoice: { number: 'INV-ORIGINAL', recordedBy: MASTER, recordedAt: '2026-10-25T10:00:00.000Z' },
      }),
    );
    const message = await postgresMessage(
      db.update(schema.jobs).set({ invoiceNumber: 'INV-REWRITTEN' }).where(eq(schema.jobs.id, job.id)),
    );
    expect(message).toMatch(/invoice number is never rewritten/);
    expect((await repository.findById(job.id))?.invoice?.number).toBe('INV-ORIGINAL');
  });

  it('leaves a historical Closed job exactly as it was', async () => {
    const closed = await repository.save(
      await newJob({ status: 'closed', closedAt: '2026-10-01T10:00:00.000Z' }),
    );
    const read = await repository.findById(closed.id);
    expect(read?.status).toBe('closed');
    expect(read?.closedAt).not.toBeNull();
    expect(read?.invoice).toBeNull();
    expect(read?.officeHandling).toBeNull();
  });
});
