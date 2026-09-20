import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { PostgresJobRepository } from './job-repository';
import { ConcurrencyError, withTransaction } from './transaction';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { asUserId, asLineItemId, type Job } from '@/domain';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';

/**
 * The PostgreSQL job repository, against a real PostgreSQL.
 *
 * Run with `npm run db:test` and a `TEST_DATABASE_URL`. Skipped entirely when
 * there is none, so the command is safe on a machine with no database — it
 * reports skipped rather than failing, and `npm test` never touches it.
 *
 * What these hold that a schema test cannot: that the aggregate genuinely round
 * trips, that the immutability triggers actually fire, that two concurrent
 * writers cannot both win, and that job numbers cannot collide.
 */

/**
 * The message PostgreSQL actually raised.
 *
 * The driver wraps a failed statement in "Failed query: …" and keeps the
 * server's message on the cause, so asserting on the wrapper would prove only
 * that something failed — not that the right guard refused it.
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

const { master: MASTER, technician: TECHNICIAN, customer: CUSTOMER } = IDS;

describeDb('the PostgreSQL job repository', () => {
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

  /** A minimal, valid job, with its number allocated the way production does. */
  const newJob = async (over: Partial<Job> = {}): Promise<Job> => {
    const allocated = await repository.allocateJobNumber();
    return jobFixture(allocated.jobNumber, { machineId: null, ...over });
  };

  describe('round tripping the aggregate', () => {
    it('saves and reads back a job unchanged', async () => {
      const job = await newJob();
      const saved = await repository.save(job);

      expect(saved.jobNumber).toBe(job.jobNumber);
      expect(saved.faultDescription).toBe(job.faultDescription);

      const read = await repository.findByJobNumber(job.jobNumber);
      expect(read?.id).toBe(job.id);
      expect(read?.customerId).toBe(CUSTOMER);
    });

    it('carries the children: labour, parts and notes', async () => {
      const job = await newJob({
        primaryTechnicianId: asUserId(TECHNICIAN),
        labour: [
          {
            id: asLineItemId(crypto.randomUUID()),
            technicianId: asUserId(TECHNICIAN),
            date: '2026-09-20',
            rateType: 'normal',
            hours: 2.5,
            description: 'Spindle drive repair',
            capturedAt: '2026-09-20T10:00:00.000Z',
            capturedBy: asUserId(TECHNICIAN),
          },
        ],
        parts: [
          {
            id: asLineItemId(crypto.randomUUID()),
            partNumber: 'ENC-INC-1024',
            description: 'Incremental encoder',
            quantity: 2,
            unitPrice: 386_000,
            capturedAt: '2026-09-20T10:05:00.000Z',
            capturedBy: asUserId(TECHNICIAN),
          },
        ],
        notes: [
          {
            id: crypto.randomUUID(),
            body: 'Customer asked for a quote on the second axis.',
            authorId: asUserId(TECHNICIAN),
            createdAt: '2026-09-20T10:10:00.000Z',
            internal: false,
          },
        ],
      });

      await repository.save(job);
      const read = await repository.findById(job.id);

      expect(read?.labour).toHaveLength(1);
      expect(read?.labour[0]?.hours).toBe(2.5);
      expect(read?.parts[0]?.unitPrice).toBe(386_000);
      expect(read?.notes[0]?.body).toContain('second axis');
    });

    it('keeps money as exact integer cents', async () => {
      const job = await newJob({
        parts: [
          {
            id: asLineItemId(crypto.randomUUID()),
            partNumber: 'SIE-6SL3',
            description: 'Drive module',
            quantity: 1,
            unitPrice: 1_240_000,
            capturedAt: '2026-09-20T10:05:00.000Z',
            capturedBy: asUserId(TECHNICIAN),
          },
        ],
      });
      await repository.save(job);

      const read = await repository.findById(job.id);
      // Exact, not 1239999.9999999998.
      expect(read?.parts[0]?.unitPrice).toBe(1_240_000);
    });
  });

  describe('job numbering', () => {
    it('never hands the same number to two callers', async () => {
      const allocated = await Promise.all(
        Array.from({ length: 25 }, () => repository.allocateJobNumber()),
      );
      const numbers = allocated.map((entry) => entry.jobNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('continues from the demonstration numbering rather than colliding with it', async () => {
      // The seeded demo runs EJE-1039 to EJE-1067.
      const first = await repository.allocateJobNumber();
      expect(first.sequence).toBeGreaterThanOrEqual(1068);
      expect(first.jobNumber).toMatch(/^EJE-\d+$/);
    });

    it('refuses a duplicate job number outright', async () => {
      const first = await newJob();
      await repository.save(first);

      const clash = await newJob();
      await expect(
        repository.save({ ...clash, jobNumber: first.jobNumber }),
      ).rejects.toThrow();
    });
  });

  describe('concurrency', () => {
    it('refuses a write that lost the race', async () => {
      const job = await newJob();
      await repository.save(job);

      /*
       * Two requests, so two repository instances.
       *
       * Each is one unit of work, which is how production builds them: a
       * handler opens a transaction and makes a repository bound to it. Both
       * read the job, both decide something, and both try to write.
       */
      const first = new PostgresJobRepository(db);
      const second = new PostgresJobRepository(db);

      const a = await first.findById(job.id);
      const b = await second.findById(job.id);

      await first.save({ ...a!, faultDescription: 'First writer.' });
      await expect(
        second.save({ ...b!, faultDescription: 'Second writer.' }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      // And the first write stands, rather than being silently overwritten.
      const read = await repository.findById(job.id);
      expect(read?.faultDescription).toBe('First writer.');
    });

    it('lets the same unit of work write repeatedly', async () => {
      // An operation legitimately saves a job more than once — capture a line,
      // then transition it — and must not fight itself.
      const job = await newJob();
      const repo = new PostgresJobRepository(db);
      await repo.save(job);

      const read = await repo.findById(job.id);
      const once = await repo.save({ ...read!, faultDescription: 'First change.' });
      const twice = await repo.save({ ...once, faultDescription: 'Second change.' });

      expect(twice.faultDescription).toBe('Second change.');
    });
  });

  describe('immutability, enforced by the database', () => {
    it('refuses to rewrite a captured signature', async () => {
      const job = await newJob({
        status: 'review',
        signature: {
          customerName: 'Pieter',
          customerSurname: 'Nel',
          strokeData: 'M0,0 L1,1',
          signedAt: '2026-09-20T12:00:00.000Z',
          declaration: 'I confirm that the work described above has been completed.',
        },
      });
      await repository.save(job);

      const message = await postgresMessage(
        db.execute(sql`update job_signatures set customer_name = 'Somebody Else'`),
      );
      expect(message).toMatch(/immutable historical record/i);
    });

    it('refuses to rewrite what a technician recorded when the customer refused', async () => {
      const job = await newJob({
        status: 'review',
        signatureRefusals: [
          {
            refused: true,
            reason: 'Site manager left before the work was finished.',
            recordedBy: asUserId(TECHNICIAN),
            recordedAt: '2026-09-20T12:00:00.000Z',
            resolvedBy: null,
            resolvedAt: null,
            resolution: null,
            resolutionNote: '',
          },
        ],
      });
      await repository.save(job);

      const message = await postgresMessage(
        db.execute(sql`update signature_refusals set reason = 'Something else entirely'`),
      );
      expect(message).toMatch(/cannot be changed/i);
    });

    it('lets the office resolve a refusal, once, without touching what was recorded', async () => {
      const base = await newJob({
        status: 'review',
        signatureRefusals: [
          {
            refused: true,
            reason: 'Customer representative was not available to sign.',
            recordedBy: asUserId(TECHNICIAN),
            recordedAt: '2026-09-20T12:00:00.000Z',
            resolvedBy: null,
            resolvedAt: null,
            resolution: null,
            resolutionNote: '',
          },
        ],
      });
      await repository.save(base);

      const read = await repository.findById(base.id);
      const refusal = read!.signatureRefusals[0]!;
      await repository.save({
        ...read!,
        signatureRefusals: [
          {
            ...refusal,
            resolvedBy: asUserId(MASTER),
            resolvedAt: '2026-09-20T13:00:00.000Z',
            resolution: 'issued_unsigned',
            resolutionNote: 'Invoice to proceed.',
          },
        ],
      });

      const after = await repository.findById(base.id);
      expect(after?.signatureRefusals[0]?.resolution).toBe('issued_unsigned');
      // Attempt 1's own record is untouched.
      expect(after?.signatureRefusals[0]?.reason).toBe(
        'Customer representative was not available to sign.',
      );
      expect(after?.signatureRefusals[0]?.recordedBy).toBe(TECHNICIAN);
    });

    it('appends a second refusal rather than overwriting the first', async () => {
      const first = await newJob({
        status: 'review',
        signatureRefusals: [
          {
            refused: true,
            reason: 'First refusal.',
            recordedBy: asUserId(TECHNICIAN),
            recordedAt: '2026-09-20T12:00:00.000Z',
            resolvedBy: asUserId(MASTER),
            resolvedAt: '2026-09-20T13:00:00.000Z',
            resolution: 'resubmitted',
            resolutionNote: 'Hours corrected.',
          },
        ],
      });
      await repository.save(first);

      const read = await repository.findById(first.id);
      await repository.save({
        ...read!,
        signatureRefusals: [
          ...read!.signatureRefusals,
          {
            refused: true,
            reason: 'Second refusal.',
            recordedBy: asUserId(TECHNICIAN),
            recordedAt: '2026-09-21T09:00:00.000Z',
            resolvedBy: null,
            resolvedAt: null,
            resolution: null,
            resolutionNote: '',
          },
        ],
      });

      const after = await repository.findById(first.id);
      expect(after?.signatureRefusals).toHaveLength(2);
      expect(after?.signatureRefusals[0]?.reason).toBe('First refusal.');
      expect(after?.signatureRefusals[1]?.reason).toBe('Second refusal.');
    });

    it('refuses an empty refusal reason', async () => {
      await expect(
        db.execute(sql`
          insert into signature_refusals (id, job_id, attempt, reason, recorded_by, recorded_at)
          values (gen_random_uuid(), gen_random_uuid(), 1, '   ', ${MASTER}, now())
        `),
      ).rejects.toThrow();
    });

    it('refuses to delete an audit event', async () => {
      await db.execute(sql`
        insert into audit_events (id, occurred_at, actor_id, actor_role, type, summary)
        values (gen_random_uuid(), now(), ${MASTER}, 'master', 'job_created', 'Job raised')
      `);
      const message = await postgresMessage(db.execute(sql`delete from audit_events`));
      expect(message).toMatch(/immutable historical record/i);
    });
  });

  describe('DECISION 6 — deletion is permanent, and the audit survives it', () => {
    it('removes the job outright', async () => {
      const job = await newJob();
      await repository.save(job);

      await repository.delete(job.id);

      expect(await repository.findById(job.id)).toBeNull();
      expect(await repository.list()).toHaveLength(0);
    });

    it('keeps the audit event that records the deletion', async () => {
      const job = await newJob();
      await repository.save(job);

      // The application writes this BEFORE deleting, inside the same transaction.
      await db.execute(sql`
        insert into audit_events (id, occurred_at, actor_id, actor_role, type, summary, job_id, job_number)
        values (gen_random_uuid(), now(), ${MASTER}, 'master', 'job_deleted',
                ${'Deleted ' + job.jobNumber}, ${job.id}, ${job.jobNumber})
      `);
      await repository.delete(job.id);

      const events = await db.execute<{ job_number: string; summary: string }>(
        sql`select job_number, summary from audit_events where type = 'job_deleted'`,
      );
      const rows = [...events];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.job_number).toBe(job.jobNumber);
    });
  });

  describe('constraints that make an impossible job unstorable', () => {
    it('refuses a courier collection with no waybill', async () => {
      const job = await newJob({ jobType: 'parts', courierCollection: true, waybillNumber: '  ' });
      await expect(repository.save(job)).rejects.toThrow();
    });

    it('accepts a courier collection that has one', async () => {
      const job = await newJob({
        jobType: 'parts',
        courierCollection: true,
        waybillNumber: 'DSV-4471882',
      });
      const saved = await repository.save(job);
      expect(saved.waybillNumber).toBe('DSV-4471882');
    });

    it('refuses a schedule end without a start', async () => {
      const job = await newJob({ jobType: 'service', scheduledEndDate: '2026-09-25' });
      await expect(repository.save(job)).rejects.toThrow();
    });

    it('refuses a schedule that ends before it starts', async () => {
      const job = await newJob({
        jobType: 'service',
        scheduledDate: '2026-09-25',
        scheduledEndDate: '2026-09-20',
      });
      await expect(repository.save(job)).rejects.toThrow();
    });

    it('allows a job raised with no date at all — DECISION 1', async () => {
      const job = await newJob({ jobType: 'service', scheduledDate: null });
      const saved = await repository.save(job);
      expect(saved.scheduledDate).toBeNull();
    });
  });

  describe('transactions', () => {
    it('leaves nothing behind when the work throws', async () => {
      const job = await newJob();

      await expect(
        withTransaction(db, async (tx) => {
          const repo = new PostgresJobRepository(tx);
          await repo.save(job);
          throw new Error('something went wrong after the write');
        }),
      ).rejects.toThrow('something went wrong');

      expect(await repository.findById(job.id)).toBeNull();
    });

    it('commits the whole aggregate together', async () => {
      const job = await newJob({
        notes: [
          {
            id: crypto.randomUUID(),
            body: 'Written in the same transaction as the job.',
            authorId: asUserId(MASTER),
            createdAt: '2026-09-20T08:05:00.000Z',
            internal: true,
          },
        ],
      });

      await withTransaction(db, async (tx) => {
        await new PostgresJobRepository(tx).save(job);
      });

      const read = await repository.findById(job.id);
      expect(read?.notes).toHaveLength(1);
    });
  });
});
