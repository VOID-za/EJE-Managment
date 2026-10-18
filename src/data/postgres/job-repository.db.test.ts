import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { PostgresJobRepository } from './job-repository';
import { ConcurrencyError, SignedJobCardAltered, withTransaction } from './transaction';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import * as schema from '@/db/schema';
import { asAttachmentId, asUserId, asLineItemId, type Job } from '@/domain';
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

  describe('media visibility (MEDIA-1)', () => {
    const photo = (id: string, caption: string, visibility: 'customer_facing' | 'internal') => ({
      id: asAttachmentId(id),
      kind: 'photo' as const,
      visibility,
      fileName: `${id}.jpg`,
      caption,
      storageKey: `uploads/${id}`,
      uploadedAt: '2026-09-20T09:00:00.000Z',
      uploadedBy: asUserId(TECHNICIAN),
      sizeBytes: 2_140_000,
    });

    it('round trips both classifications', async () => {
      const job = await newJob({
        photos: [
          photo(crypto.randomUUID(), 'Failed transformer', 'customer_facing'),
          photo(crypto.randomUUID(), 'Leaking roof', 'internal'),
        ],
      });
      await repository.save(job);

      const read = await repository.findById(job.id);
      const byCaption = new Map(read!.photos.map((item) => [item.caption, item.visibility]));
      expect(byCaption.get('Failed transformer')).toBe('customer_facing');
      expect(byCaption.get('Leaking roof')).toBe('internal');
    });

    it('defaults a row written without one to customer-facing', async () => {
      /*
       * The column carries a database default, so a row inserted by anything that
       * predates MEDIA-1 — an older build mid-deploy, a support script — is
       * recorded as what every photograph already was rather than as nothing.
       */
      const job = await repository.save(await newJob());
      const id = crypto.randomUUID();
      await db.insert(schema.jobMedia).values({
        id,
        jobId: job.id,
        kind: 'photo',
        fileName: 'legacy.jpg',
        caption: 'Written without a visibility',
        storageKey: `uploads/${id}`,
        uploadedAt: '2026-09-20T09:00:00.000Z',
        uploadedBy: TECHNICIAN,
      });

      const read = await repository.findById(job.id);
      expect(read?.photos.find((item) => item.caption === 'Written without a visibility')?.visibility).toBe(
        'customer_facing',
      );
    });

    it('refuses to reclassify a photograph on a SIGNED job card', async () => {
      const id = crypto.randomUUID();
      const stored = await repository.save(
        await newJob({
          status: 'review',
          signature: {
            customerName: 'Pieter',
            customerSurname: 'Nel',
            strokeData: 'M0,0 L1,1',
            signedAt: '2026-09-20T12:00:00.000Z',
            declaration: 'I confirm that the work described above has been completed.',
          },
          photos: [photo(id, 'Failed transformer', 'customer_facing')],
        }),
      );

      /*
       * IMMUT-7, at the repository. The document the customer signed showed
       * exactly the customer-facing photographs of that moment, so `visibility`
       * belongs in the frozen fingerprint — without it this save would pass here
       * and die inside `0007`'s trigger as a 500, which is the shape of defect
       * AUD-10 was.
       */
      const altered = {
        ...stored,
        photos: stored.photos.map((item) => ({ ...item, visibility: 'internal' as const })),
      };

      await expect(repository.save(altered)).rejects.toThrow(SignedJobCardAltered);
      await expect(repository.save(altered)).rejects.toThrow(/media/u);

      expect((await repository.findById(stored.id))?.photos[0]?.visibility).toBe('customer_facing');
    });
  });

  describe('the spares request (SPARE-2)', () => {
    it('round trips all four fields', async () => {
      const job = await newJob({
        status: 'awaiting_spares',
        sparesRequest: {
          description: 'IGBT module, Siemens 6SL3120-1TE21-0AA4.',
          notes: 'On back-order. Machine isolated.',
          photoId: null,
          requestedAt: '2026-09-20T09:15:00.000Z',
        },
      });
      await repository.save(job);

      const read = await repository.findById(job.id);
      expect(read?.sparesRequest).toEqual({
        description: 'IGBT module, Siemens 6SL3120-1TE21-0AA4.',
        notes: 'On back-order. Machine isolated.',
        photoId: null,
        requestedAt: '2026-09-20T09:15:00.000Z',
      });
    });

    it('answers null for a job that has never waited for a part', async () => {
      /*
       * `awaiting_spares_requested_at` is what decides this. A job with no
       * request must not read back as a request whose fields happen to be empty
       * — the screens would then have to tell the two apart.
       */
      const job = await repository.save(await newJob());
      expect(job.sparesRequest).toBeNull();

      const read = await repository.findById(job.id);
      expect(read?.sparesRequest).toBeNull();
    });

    it('keeps the request after the job resumes', async () => {
      const job = await repository.save(
        await newJob({
          status: 'awaiting_spares',
          sparesRequest: {
            description: 'Spindle drive belt.',
            notes: '',
            photoId: null,
            requestedAt: '2026-09-20T09:15:00.000Z',
          },
        }),
      );

      // What `returnToInProgress` writes: the status moves, the request does not.
      const resumed = await repository.save({ ...job, status: 'in_progress' });

      expect(resumed.status).toBe('in_progress');
      expect(resumed.sparesRequest?.description).toBe('Spindle drive belt.');
      expect(resumed.sparesRequest?.requestedAt).toBe('2026-09-20T09:15:00.000Z');
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

    /*
     * THE REPOSITORY'S OWN HALF OF IMMUT-7. AUD-10.
     *
     * The trigger above is the last line. These are the one before it: a signed
     * job's job card is not rewritten, so saving one that has been ALTERED is
     * refused here, by name, rather than being silently dropped or dying inside
     * the driver. Saving a signed job that has NOT been altered is the ordinary
     * workflow write — issuing it, recording the delivery, closing it — and
     * must go straight through.
     */
    const signed = {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
      signedAt: '2026-09-20T12:00:00.000Z',
      declaration: 'I confirm that the work described above has been completed.',
    } as const;

    const signedJobWithEvidence = async (): Promise<Job> => {
      const job = await newJob({
        status: 'review',
        signature: signed,
        labour: [
          {
            id: asLineItemId(crypto.randomUUID()),
            technicianId: asUserId(TECHNICIAN),
            capturedBy: asUserId(TECHNICIAN),
            date: '2026-09-20',
            rateType: 'normal',
            hours: 3,
            description: 'Replaced the coolant pump.',
            capturedAt: '2026-09-20T11:00:00.000Z',
          },
        ],
      });
      return repository.save(job);
    };

    it('moves a signed job through the workflow without rewriting its job card', async () => {
      const stored = await signedJobWithEvidence();

      // Exactly what issuing does: the workflow columns move, the evidence does
      // not. Before AUD-10 was fixed this raised `restrict_violation`.
      const issued = await repository.save({
        ...stored,
        status: 'awaiting_delivery',
        submittedAt: '2026-09-20T12:30:00.000Z',
      });

      expect(issued.status).toBe('awaiting_delivery');
      expect(issued.labour).toHaveLength(1);
      expect(issued.labour[0]?.hours).toBe(3);
    });

    it('refuses to save a signed job whose job card has been altered', async () => {
      const stored = await signedJobWithEvidence();

      const altered = {
        ...stored,
        labour: stored.labour.map((entry) => ({ ...entry, hours: 99 })),
      };

      await expect(repository.save(altered)).rejects.toThrow(SignedJobCardAltered);
      // And it names what it would not rewrite, for whoever reads the log.
      await expect(repository.save(altered)).rejects.toThrow(/labour/u);

      // Nothing was written: the stored line is still the signed one.
      const read = await repository.findById(stored.id);
      expect(read?.labour[0]?.hours).toBe(3);
    });

    /* -- the delivery record, which was never written at all -------------- */

    /**
     * WHAT THE PROVIDER SAID, KEPT. MANDATE-3, AUD-10's neighbour.
     *
     * `delivery_attempts` was READ by the mapper and written by nothing. So on
     * PostgreSQL the whole delivery record — the provider's message id, the
     * state, the failure reason, how many attempts there had been — lived only
     * in the object the request happened to be holding, and the next read
     * derived `not_started` from an empty table. Three consequences, all of
     * them visible to EJE:
     *
     *   - the office's screen said a customer's copy had not been sent when
     *     Microsoft 365 had accepted it;
     *   - `confirm_delivery` returns early when there is no message id, so a
     *     job could NEVER close on a confirmed delivery — the one transition
     *     the delivery handshake exists to make;
     *   - after a restart nobody could tell whether a copy had gone out, so a
     *     re-send risked a second copy of the same job card.
     *
     * These tests write the record and read it back. With the repository as it
     * was, every one of them fails on the first assertion.
     */
    const sentDelivery = {
      messageId: 'AAMkAGI2THVSAAA=',
      state: 'pending_delivery' as const,
      to: 'accounts@abc-engineering.example',
      acceptedAt: '2026-09-20T12:31:00.000Z',
      confirmedAt: null,
      updatedAt: '2026-09-20T12:31:00.000Z',
      attempts: 1,
      failureReason: '',
      failureKind: null,
    };

    it('keeps the provider message id and state across a reload', async () => {
      const stored = await signedJobWithEvidence();
      await repository.save({
        ...stored,
        status: 'awaiting_delivery',
        submittedAt: '2026-09-20T12:30:00.000Z',
        delivery: sentDelivery,
      });

      const read = await repository.findById(stored.id);
      expect(read?.delivery?.messageId).toBe(sentDelivery.messageId);
      expect(read?.delivery?.state).toBe('pending_delivery');
      expect(read?.delivery?.to).toBe(sentDelivery.to);
      expect(read?.delivery?.acceptedAt).toBe(sentDelivery.acceptedAt);
      expect(read?.delivery?.attempts).toBe(1);
    });

    /**
     * THE KIND OF FAILURE SURVIVES, AND ONLY ON A FAILURE. MANDATE-3.
     *
     * `failure_reason` is the provider's sentence; the KIND is what the office
     * can act on — whether *Send again* can work at all. It is stored, read
     * back, and the table refuses to carry one on an attempt that did not
     * fail, because a kind that explains an accepted send explains nothing.
     */
    it('keeps the KIND of failure, and clears it when the attempt stops failing', async () => {
      const stored = await signedJobWithEvidence();
      const base = { ...stored, status: 'awaiting_delivery' as const };

      await repository.save({
        ...base,
        delivery: {
          ...sentDelivery,
          messageId: '',
          state: 'failed',
          acceptedAt: null,
          failureReason: 'The job card is 4 MB.',
          failureKind: 'attachment_too_large',
        },
      });

      const failed = await repository.findById(stored.id);
      expect(failed?.delivery?.failureKind).toBe('attachment_too_large');

      // The same attempt, now accepted. The kind goes with the failure.
      await repository.save({ ...base, delivery: sentDelivery });
      const accepted = await repository.findById(stored.id);
      expect(accepted?.delivery?.state).toBe('pending_delivery');
      expect(accepted?.delivery?.failureKind).toBeNull();

      const rows = await db
        .select()
        .from(schema.deliveryAttempts)
        .where(eq(schema.deliveryAttempts.jobId, stored.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.failureKind).toBeNull();
    });

    it('reads an unrecognised kind as unclassified rather than passing it up', async () => {
      const stored = await signedJobWithEvidence();
      await repository.save({
        ...stored,
        status: 'awaiting_delivery',
        delivery: {
          ...sentDelivery,
          messageId: '',
          state: 'failed',
          acceptedAt: null,
          failureReason: 'Something a future provider invented.',
          failureKind: 'provider_refused',
        },
      });

      /*
       * The column is `text` so a new transport's failure mode needs no
       * migration. The price of that freedom is paid here: a string the domain
       * does not know reads as NULL rather than arriving on a screen as a kind
       * nothing can narrow.
       */
      await db
        .update(schema.deliveryAttempts)
        .set({ failureKind: 'invented_by_a_later_provider' })
        .where(eq(schema.deliveryAttempts.jobId, stored.id));

      const read = await repository.findById(stored.id);
      expect(read?.delivery?.state).toBe('failed');
      expect(read?.delivery?.failureKind).toBeNull();
      expect(read?.delivery?.failureReason).toMatch(/future provider/u);
    });

    it('REFUSES at the database to explain a send that did not fail', async () => {
      const stored = await signedJobWithEvidence();
      await repository.save({ ...stored, status: 'awaiting_delivery', delivery: sentDelivery });

      const refused = await db
        .update(schema.deliveryAttempts)
        .set({ failureKind: 'credentials_rejected' })
        .where(eq(schema.deliveryAttempts.jobId, stored.id))
        .then(() => null, (error: unknown) => error);

      expect(refused, 'the CHECK did not fire').not.toBeNull();
      expect(await postgresMessage(Promise.reject(refused))).toMatch(
        /delivery_attempts_kind_only_on_failure/u,
      );
    });

    it('keeps a FAILURE and its reason, which is what the office acts on', async () => {
      const stored = await signedJobWithEvidence();
      await repository.save({
        ...stored,
        status: 'awaiting_delivery',
        delivery: {
          ...sentDelivery,
          messageId: '',
          state: 'failed',
          acceptedAt: null,
          failureReason: 'Microsoft 365 refused the credentials (HTTP 401).',
          failureKind: 'credentials_rejected',
        },
      });

      const read = await repository.findById(stored.id);
      expect(read?.delivery?.state).toBe('failed');
      expect(read?.delivery?.failureReason).toMatch(/HTTP 401/u);
    });

    /**
     * EVERY ATTEMPT, NOT A COUNTER. The office's question is "we tried three
     * times — what did it say each time?", and the table was built to answer
     * it. One row per attempt, the latest being the current state.
     */
    it('records each attempt as its own row, keeping what the earlier ones said', async () => {
      const stored = await signedJobWithEvidence();
      await repository.save({
        ...stored,
        status: 'awaiting_delivery',
        delivery: {
          ...sentDelivery,
          messageId: '',
          state: 'failed',
          acceptedAt: null,
          failureReason: 'Mailbox full.',
          failureKind: 'invalid_recipient',
        },
      });
      const second = await repository.save({
        ...stored,
        status: 'awaiting_delivery',
        delivery: { ...sentDelivery, attempts: 2, updatedAt: '2026-09-20T13:00:00.000Z', acceptedAt: '2026-09-20T13:00:00.000Z' },
      });

      expect(second.delivery?.attempts).toBe(2);
      const rows = await db
        .select()
        .from(schema.deliveryAttempts)
        .where(eq(schema.deliveryAttempts.jobId, stored.id));
      expect(rows).toHaveLength(2);
      const first = rows.find((row) => row.attemptNumber === 1);
      expect(first?.state).toBe('failed');
      expect(first?.failureReason).toBe('Mailbox full.');
      expect(rows.find((row) => row.attemptNumber === 2)?.state).toBe('pending_delivery');

      const read = await repository.findById(stored.id);
      expect(read?.delivery?.state).toBe('pending_delivery');
      expect(read?.delivery?.attempts).toBe(2);
    });

    /**
     * SAVING THE SAME ATTEMPT AGAIN IS AN UPDATE, NOT A SECOND ROW. The state
     * of one attempt moves — sending, then accepted, then confirmed — and each
     * step is another save of the same job. A row per save would make
     * `attempts` count saves instead of attempts, and the unique index on
     * (job, channel, attempt) would refuse the second one outright.
     */
    it('moves one attempt through its states without inventing new ones', async () => {
      const stored = await signedJobWithEvidence();
      const base = { ...stored, status: 'awaiting_delivery' as const };

      await repository.save({
        ...base,
        delivery: { ...sentDelivery, state: 'sending', acceptedAt: null, messageId: '' },
      });
      await repository.save({ ...base, delivery: sentDelivery });
      const closed = await repository.save({
        ...base,
        status: 'closed',
        closedAt: '2026-09-20T14:00:00.000Z',
        delivery: {
          ...sentDelivery,
          state: 'delivered',
          confirmedAt: '2026-09-20T14:00:00.000Z',
          updatedAt: '2026-09-20T14:00:00.000Z',
        },
      });

      expect(closed.delivery?.state).toBe('delivered');
      const rows = await db
        .select()
        .from(schema.deliveryAttempts)
        .where(eq(schema.deliveryAttempts.jobId, stored.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('delivered');
      // The table's own CHECK: only a confirmation may claim delivery.
      expect(rows[0]?.confirmedAt).toBe('2026-09-20T14:00:00.000Z');

      const read = await repository.findById(stored.id);
      expect(read?.delivery?.state).toBe('delivered');
      expect(read?.delivery?.attempts).toBe(1);
    });

    it('writes nothing for a job nobody has tried to send', async () => {
      const stored = await signedJobWithEvidence();
      await repository.save({ ...stored, status: 'awaiting_delivery' });

      expect(
        await db
          .select()
          .from(schema.deliveryAttempts)
          .where(eq(schema.deliveryAttempts.jobId, stored.id)),
      ).toEqual([]);
    });

    it('refuses to save a signed job that has GAINED a line', async () => {
      const stored = await signedJobWithEvidence();

      const withExtra = {
        ...stored,
        parts: [
          {
            id: asLineItemId(crypto.randomUUID()),
            partNumber: 'PMP-4410',
            description: 'Coolant pump',
            quantity: 1,
            unitPrice: 185_000,
            capturedAt: '2026-09-20T13:00:00.000Z',
            capturedBy: asUserId(TECHNICIAN),
          },
        ],
      };

      await expect(repository.save(withExtra)).rejects.toThrow(/parts/u);
      expect((await repository.findById(stored.id))?.parts).toHaveLength(0);
    });

    it('refuses to save a signed job that has LOST a line', async () => {
      const stored = await signedJobWithEvidence();

      await expect(repository.save({ ...stored, labour: [] })).rejects.toThrow(/labour/u);
      expect((await repository.findById(stored.id))?.labour).toHaveLength(1);
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
