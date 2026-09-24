import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  asLineItemId,
  asUserId,
  canSeeJob,
  jobVisibilityFor,
  technicianHistoryFrom,
  visibleJobsFor,
  type Job,
  type PricingSnapshot,
  type User,
} from '@/domain';
import type { Database } from '@/db/client';
import * as schema from '@/db/schema';
import { PostgresJobRepository } from './job-repository';
import { createPostgresRepositories } from './repositories';
import { withTransaction } from './transaction';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { IDS, jobFixture, seedBaseline } from './test-fixtures';
import { deleteJob } from '@/application/job-operations';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SystemClock } from '@/services/simulated/system';
import { UuidGenerator } from '@/services/production/ids';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';

/**
 * What a job LEAVES BEHIND, in PostgreSQL.
 *
 * Three histories that the demonstration could not keep and production must:
 * who was ever on a job, what the customer was actually charged, and what
 * happened to a job that no longer exists. Each of them survives the thing it
 * describes, which is the whole reason they are separate records.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const SNAPSHOT: PricingSnapshot = {
  labourRates: { normal: 95_000, overtime: 142_500, double: 190_000 },
  calloutRate: 85_000,
  kilometreRate: 1_850,
  vatPercentage: 15,
  capturedAt: '2026-09-20T15:00:00.000Z',
  reason: 'customer_signature',
};

describeDb('what a job leaves behind', () => {
  let db: Database;
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
    jobs = new PostgresJobRepository(db);
  });

  const newJob = async (over: Partial<Job> = {}): Promise<Job> => {
    const allocated = await jobs.allocateJobNumber();
    return jobFixture(allocated.jobNumber, over);
  };

  describe('DECISION 5 — who was ever on a job', () => {
    it('keeps a technician’s participation after the job is reassigned', async () => {
      const job = await jobs.save(
        await newJob({
          status: 'in_progress',
          primaryTechnicianId: asUserId(IDS.technician),
          acceptedAt: '2026-09-20T07:00:00.000Z',
        }),
      );

      await jobs.save({ ...job, primaryTechnicianId: asUserId(IDS.otherTechnician) });

      // `primary_technician_id` has forgotten her. `job_participants` has not,
      // which is the entire reason that table exists.
      const hers = await jobs.listParticipatedJobs(asUserId(IDS.technician));
      expect(hers.map((entry) => entry.jobNumber)).toEqual([job.jobNumber]);

      const rows = await db
        .select()
        .from(schema.jobParticipants)
        .where(eq(schema.jobParticipants.jobId, job.id))
        .orderBy(asc(schema.jobParticipants.createdAt));
      expect(rows).toHaveLength(2);
      const closed = rows.find((row) => row.userId === IDS.technician);
      expect(closed?.until).not.toBeNull();
      expect(closed?.endedReason).toBe('no longer assigned');
    });

    it('records an additional technician in their own right', async () => {
      const job = await jobs.save(
        await newJob({
          status: 'in_progress',
          primaryTechnicianId: asUserId(IDS.technician),
          additionalTechnicianIds: [asUserId(IDS.otherTechnician)],
          acceptedAt: '2026-09-20T07:00:00.000Z',
        }),
      );

      const theirs = await jobs.listParticipatedJobs(asUserId(IDS.otherTechnician));
      expect(theirs.map((entry) => entry.id)).toEqual([job.id]);
    });

    it('shows a technician the pool, their own work, and nothing else that is live', async () => {
      const open = await jobs.save(await newJob({ status: 'open', primaryTechnicianId: null }));
      const mine = await jobs.save(
        await newJob({
          status: 'in_progress',
          primaryTechnicianId: asUserId(IDS.technician),
          acceptedAt: '2026-09-20T07:00:00.000Z',
        }),
      );
      const theirs = await jobs.save(
        await newJob({
          status: 'in_progress',
          primaryTechnicianId: asUserId(IDS.otherTechnician),
          acceptedAt: '2026-09-20T07:00:00.000Z',
        }),
      );

      const viewer = { id: asUserId(IDS.technician), role: 'technician' } as Pick<
        User,
        'id' | 'role'
      >;
      const history = technicianHistoryFrom(
        await jobs.listParticipatedJobs(asUserId(IDS.technician)),
      );
      const visible = visibleJobsFor(viewer, await jobs.list(), history);

      expect(visible.map((entry) => entry.id).sort()).toEqual([open.id, mine.id].sort());
      expect(canSeeJob(viewer, theirs, history)).toBe(false);
    });

    it('opens a machine’s finished history to a technician who has worked it, without prices', async () => {
      const worked = await jobs.save(
        await newJob({
          status: 'closed',
          primaryTechnicianId: asUserId(IDS.technician),
          acceptedAt: '2026-09-01T07:00:00.000Z',
          closedAt: '2026-09-02T15:00:00.000Z',
        }),
      );
      const somebodyElses = await jobs.save(
        await newJob({
          status: 'closed',
          primaryTechnicianId: asUserId(IDS.otherTechnician),
          acceptedAt: '2026-09-10T07:00:00.000Z',
          closedAt: '2026-09-11T15:00:00.000Z',
          parts: [
            {
              id: asLineItemId(crypto.randomUUID()),
              partNumber: 'ENC-INC-1024',
              description: 'Incremental encoder',
              quantity: 2,
              unitPrice: 386_000,
              capturedAt: '2026-09-10T10:00:00.000Z',
              capturedBy: asUserId(IDS.otherTechnician),
            },
          ],
        }),
      );

      const viewer = { id: asUserId(IDS.technician), role: 'technician' } as Pick<
        User,
        'id' | 'role'
      >;
      const history = technicianHistoryFrom(
        await jobs.listParticipatedJobs(asUserId(IDS.technician)),
      );

      // Same machine, so she may read what was done to it.
      expect(jobVisibilityFor(viewer, somebodyElses, history)).toBe('machine_history');

      const visible = visibleJobsFor(viewer, await jobs.list(), history);
      const reached = visible.find((entry) => entry.id === somebodyElses.id);
      expect(reached).toBeDefined();
      // She can see two encoders were fitted. What anybody paid is not there to
      // be rendered, exported or typed into a URL.
      expect(reached?.parts[0]?.quantity).toBe(2);
      expect(reached?.parts[0]?.unitPrice).toBe(0);

      // Her own job keeps its figures.
      expect(visible.some((entry) => entry.id === worked.id)).toBe(true);
    });
  });

  describe('a handover, as a record and not only as prose', () => {
    it('keeps the reason and the description structured, both ways a job moves', async () => {
      const job = await jobs.save(
        await newJob({
          status: 'in_progress',
          primaryTechnicianId: asUserId(IDS.technician),
          acceptedAt: '2026-09-20T07:00:00.000Z',
        }),
      );

      await jobs.recordTransfer({
        jobId: job.id,
        fromUserId: asUserId(IDS.technician),
        toUserId: asUserId(IDS.otherTechnician),
        reason: 'vehicle_problem',
        description: 'Bakkie would not start at Isando.',
        transferredBy: asUserId(IDS.master),
        transferredAt: '2026-09-20T09:00:00.000Z',
      });
      await jobs.recordTransfer({
        jobId: job.id,
        fromUserId: asUserId(IDS.otherTechnician),
        toUserId: null,
        reason: 'scheduling_conflict',
        description: '',
        transferredBy: asUserId(IDS.master),
        transferredAt: '2026-09-20T11:00:00.000Z',
      });

      const rows = await db
        .select()
        .from(schema.jobTransfers)
        .orderBy(asc(schema.jobTransfers.transferredAt));

      expect(rows).toHaveLength(2);
      // "How often does a job move because the vehicle broke down?" is now a
      // query rather than a reading exercise.
      expect(rows[0]?.reason).toBe('vehicle_problem');
      expect(rows[0]?.toUserId).toBe(IDS.otherTechnician);
      // Back to the pool, which is a person-less destination.
      expect(rows[1]?.toUserId).toBeNull();
    });

    it('refuses "other" with nothing said, at the database', async () => {
      const job = await jobs.save(await newJob());
      await expect(
        jobs.recordTransfer({
          jobId: job.id,
          fromUserId: null,
          toUserId: asUserId(IDS.technician),
          reason: 'other',
          description: '   ',
          transferredBy: asUserId(IDS.master),
          transferredAt: '2026-09-20T09:00:00.000Z',
        }),
      ).rejects.toThrow();
    });

    it('never rewrites a handover that happened', async () => {
      const job = await jobs.save(await newJob());
      await jobs.recordTransfer({
        jobId: job.id,
        fromUserId: null,
        toUserId: asUserId(IDS.technician),
        reason: 'customer_requested',
        description: 'The customer asked for Sipho.',
        transferredBy: asUserId(IDS.master),
        transferredAt: '2026-09-20T09:00:00.000Z',
      });

      await expect(
        db.update(schema.jobTransfers).set({ reason: 'other' }),
      ).rejects.toThrow();
      await expect(db.delete(schema.jobTransfers)).rejects.toThrow();
    });
  });

  describe('the frozen price', () => {
    const priced = async (): Promise<Job> =>
      newJob({
        status: 'customer_signature',
        primaryTechnicianId: asUserId(IDS.technician),
        acceptedAt: '2026-09-20T07:00:00.000Z',
        calloutApplied: true,
        labour: [
          {
            id: asLineItemId(crypto.randomUUID()),
            technicianId: asUserId(IDS.technician),
            date: '2026-09-20',
            rateType: 'normal',
            hours: 2,
            description: 'Spindle drive repair',
            capturedAt: '2026-09-20T10:00:00.000Z',
            capturedBy: asUserId(IDS.technician),
          },
        ],
        travel: [
          {
            id: asLineItemId(crypto.randomUUID()),
            technicianId: asUserId(IDS.technician),
            date: '2026-09-20',
            kilometres: 60,
            description: 'Isando and back',
            capturedAt: '2026-09-20T10:00:00.000Z',
            capturedBy: asUserId(IDS.technician),
          },
        ],
        parts: [
          {
            id: asLineItemId(crypto.randomUUID()),
            partNumber: 'FAN-24V-120',
            description: 'Cooling fan',
            quantity: 1,
            unitPrice: 128_000,
            capturedAt: '2026-09-20T10:00:00.000Z',
            capturedBy: asUserId(IDS.technician),
          },
        ],
        pricingSnapshot: SNAPSHOT,
      });

    it('writes the lines the customer signed for, not only the rates', async () => {
      const job = await jobs.save(await priced());

      const lines = await db
        .select()
        .from(schema.pricingSnapshotLines)
        .orderBy(asc(schema.pricingSnapshotLines.position));

      expect(lines.map((line) => line.lineKind)).toEqual([
        'labour',
        'callout',
        'travel',
        'part',
      ]);
      expect(Number(lines[0]?.quantity)).toBe(2);
      expect(lines[0]?.unitPriceCents).toBe(95_000);
      expect(lines[0]?.lineTotalCents).toBe(190_000);
      expect(lines[1]?.lineTotalCents).toBe(85_000);
      expect(lines[2]?.lineTotalCents).toBe(60 * 1_850);
      expect(lines[3]?.lineTotalCents).toBe(128_000);

      const snapshots = await db.select().from(schema.pricingSnapshots);
      const expectedSubtotal = 190_000 + 85_000 + 60 * 1_850 + 128_000;
      expect(snapshots[0]?.subtotalCents).toBe(expectedSubtotal);
      expect(snapshots[0]?.vatCents).toBe(Math.round(expectedSubtotal * 0.15));
      expect(snapshots[0]?.jobId).toBe(job.id);
    });

    it('REFUSES the office amending the job after the customer signed', async () => {
      /*
       * MASTER SCOPE CR-01. This asserted that such an amendment was
       * legitimate and that the snapshot survived it — true under the old rule,
       * where the office corrected a signed card before issuing it. A
       * customer-signed job card is now legally final, and `0007` enforces it
       * at the database as well as in `assertEditable`, so the repository
       * write itself is refused.
       *
       * The snapshot question this case has always asked — "what did the
       * customer put their name to?" — is still answered below, from the
       * untouched record.
       */
      /*
       * A SIGNATURE, not merely a price. `priced()` freezes a snapshot without
       * one — the snapshot is taken at signature OR refusal OR issue — and the
       * rule is written against the signature, so the fixture has to carry one
       * for this to be the case it claims to be.
       */
      const job = await jobs.save({
        ...(await priced()),
        status: 'review',
        signature: {
          customerName: 'Pieter',
          customerSurname: 'Nel',
          strokeData: 'M0,0 L1,1',
          signedAt: '2026-09-20T15:00:00.000Z',
          declaration: 'I confirm that the work described above has been completed.',
        },
      });

      const refusal = await jobs
        .save({
          ...job,
          parts: [{ ...job.parts[0]!, quantity: 4 }],
          completionReport: { ...job.completionReport, generalNotes: 'Corrected part count.' },
        })
        .then(() => null)
        .catch((cause: unknown) => cause);

      expect(refusal).not.toBeNull();
      // drizzle wraps the driver error, so the trigger's own sentence — and
      // its SQLSTATE — are on `cause` rather than on the message.
      const driver = (refusal as { cause?: { message?: string; code?: string } }).cause;
      expect(driver?.message).toMatch(/signed by the customer/i);
      expect(driver?.code).toBe('23001');

      const lines = await db
        .select()
        .from(schema.pricingSnapshotLines)
        .orderBy(asc(schema.pricingSnapshotLines.position));

      expect(lines).toHaveLength(4);
      expect(Number(lines[3]?.quantity)).toBe(1);
      expect(lines[3]?.lineTotalCents).toBe(128_000);

      const read = await jobs.findById(job.id);
      expect(read?.parts[0]?.quantity).toBe(1);
    });

    it('refuses to rewrite a priced line, at the database', async () => {
      await jobs.save(await priced());
      await expect(
        db
          .update(schema.pricingSnapshotLines)
          .set({ lineTotalCents: 1 })
          .where(eq(schema.pricingSnapshotLines.position, 0)),
      ).rejects.toThrow();
    });
  });

  describe('DECISION 6 — through the application, against a real database', () => {
    const services = () => {
      const outbox = new SimulatedOutbox();
      const clock = new SystemClock();
      const ids = new UuidGenerator();
      return {
        clock,
        ids,
        email: new SimulatedEmailService(outbox, clock, ids),
        whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
        pdf: new SimulatedPdfService(clock),
        storage: new DemoStorageService(inMemoryFileStore()),
      };
    };

    const master = (): User => ({
      id: asUserId(IDS.master),
      firstName: 'Elmarie',
      lastName: 'Coetzee',
      initials: 'EC',
      email: 'elmarie@example-test.co.za',
      mobile: '',
      role: 'master',
      jobTitle: '',
      active: true,
      createdAt: '2026-01-01T08:00:00.000Z',
    });

    it('destroys the job and keeps the evidence, both in one transaction', async () => {
      const job = await jobs.save(await newJob());

      await withTransaction(db, async (tx) => {
        const repos = createPostgresRepositories(tx);
        const stored = await repos.jobs.findById(job.id);
        await deleteJob(
          { repos, services: services(), actor: master() },
          stored!,
          'Raised against the wrong customer.',
        );
      });

      expect(await jobs.findById(job.id)).toBeNull();

      const events = await db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.type, 'job_deleted'));
      expect(events).toHaveLength(1);
      // The job is gone; the event still names it, by number and by id.
      expect(events[0]?.jobNumber).toBe(job.jobNumber);
      expect(events[0]?.jobId).toBe(job.id);
      expect(events[0]?.actorName).toBe('Elmarie Coetzee');
      expect(events[0]?.actorRole).toBe('master');
      expect(events[0]?.detail).toContain('Raised against the wrong customer.');
    });

    it('does not pretend the deletion happened when the database refuses it', async () => {
      const job = await jobs.save(await newJob());

      /*
       * A job a technician has accepted cannot be deleted by the workflow at
       * all, so the failure is forced at the database instead: a foreign key
       * that refuses. What is under test is the SECOND phase failing after the
       * first has been recorded — the caller must be told, not reassured.
       */
      await db.execute(sql`
        alter table job_notes
          drop constraint job_notes_job_id_jobs_id_fk,
          add constraint job_notes_job_id_jobs_id_fk
            foreign key (job_id) references jobs (id) on delete restrict
      `);
      await db.insert(schema.jobNotes).values({
        id: crypto.randomUUID(),
        jobId: job.id as string,
        body: 'Something that now pins the job in place.',
        authorId: IDS.master,
      });

      const repos = createPostgresRepositories(db);
      const stored = await repos.jobs.findById(job.id);

      await expect(
        deleteJob(
          { repos, services: services(), actor: master() },
          stored!,
          'Raised against the wrong customer.',
        ),
      ).rejects.toThrow();

      // Still there, and the trail says both what was intended and what became
      // of it — a trail recording a deletion that did not happen would be worse
      // than no trail at all.
      expect(await jobs.findById(job.id)).not.toBeNull();

      const types = (await db.select().from(schema.auditEvents)).map((event) => event.type);
      expect(types).toContain('job_deleted');
      expect(types).toContain('job_deletion_failed');

      // Put the schema back, so the forced failure stays inside this test.
      await db.execute(sql`
        alter table job_notes
          drop constraint job_notes_job_id_jobs_id_fk,
          add constraint job_notes_job_id_jobs_id_fk
            foreign key (job_id) references jobs (id) on delete cascade
      `);
    });
  });

  describe('one transaction across every repository', () => {
    it('leaves nothing behind when any part of the work throws', async () => {
      const allocated = await jobs.allocateJobNumber();

      await expect(
        withTransaction(db, async (tx) => {
          const repos = createPostgresRepositories(tx);
          await repos.jobs.save(jobFixture(allocated.jobNumber));
          await repos.notifications.create({
            id: crypto.randomUUID() as never,
            recipientId: asUserId(IDS.master),
            type: 'job_assigned',
            title: 'Job assigned',
            body: '',
            jobId: null,
            link: null,
            createdAt: '2026-09-20T08:00:00.000Z',
            readAt: null,
            handledAt: null,
            channels: ['in_app'],
          });
          throw new Error('the operation failed after both writes');
        }),
      ).rejects.toThrow(/failed after both writes/);

      expect(await jobs.findByJobNumber(allocated.jobNumber)).toBeNull();
      expect(await db.select().from(schema.notifications)).toHaveLength(0);
    });
  });
});
