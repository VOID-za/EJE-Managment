import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Job, JobId } from '@/domain';
import type { JobFilter, JobRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { toDomainJob, toJobRow, type JobRowSet } from './job-mapper';
import { ConcurrencyError } from './transaction';

/**
 * The numeric part of `EJE-1048`.
 *
 * Stored alongside the display number so jobs order numerically rather than
 * lexically — otherwise EJE-1100 would sort before EJE-999. Anything the
 * pattern does not match is rejected rather than coerced to zero, because a job
 * number nobody can order is a job nobody can find.
 */
const sequenceFromJobNumber = (jobNumber: string): number => {
  const digits = /(\d+)\s*$/.exec(jobNumber);
  if (digits === null || digits[1] === undefined) {
    throw new Error(
      `"${jobNumber}" does not end in a number. Job numbers are allocated by allocate_job_number().`,
    );
  }
  return Number(digits[1]);
};

/**
 * The job aggregate, in PostgreSQL.
 *
 * The FIRST production-backed repository, deliberately. The job is the hardest
 * one — eleven child collections, four immutable historical records, optimistic
 * concurrency and the job-number allocation — so proving it against the
 * existing suite proves the persistence approach. Everything else is easier.
 *
 * It satisfies exactly the `JobRepository` interface the demo satisfies, so the
 * two can coexist while the rest of the application is migrated. Nothing above
 * this file knows which is behind the interface, and NOTHING in `src/domain` or
 * `src/application` imports Drizzle.
 */
export class PostgresJobRepository implements JobRepository {
  /**
   * The version each job carried when THIS repository last read it.
   *
   * Optimistic concurrency needs the version the caller reasoned about, and the
   * domain `Job` type deliberately carries no version — it is a persistence
   * concern, not a business fact. A repository instance is one unit of work
   * (one request, one transaction), and an operation always loads a job before
   * it writes one, so what this instance read IS what the caller decided
   * against.
   *
   * Re-reading the version inside `save` instead would defeat the whole thing:
   * it would always match, and the second of two concurrent writers would
   * silently overwrite the first.
   */
  private readonly seenVersions = new Map<string, number>();

  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * Loads the jobs matching a filter, each fully assembled.
   *
   * The root rows are selected first and the children are fetched with one
   * query per collection over the resulting ids — eleven queries for any number
   * of jobs, rather than eleven per job.
   */
  async list(filter?: JobFilter): Promise<readonly Job[]> {
    const conditions = [];
    if (filter?.statuses !== undefined && filter.statuses.length > 0) {
      conditions.push(inArray(schema.jobs.status, [...filter.statuses]));
    }
    if (filter?.customerId !== undefined) {
      conditions.push(eq(schema.jobs.customerId, filter.customerId));
    }
    if (filter?.machineId !== undefined) {
      conditions.push(eq(schema.jobs.machineId, filter.machineId));
    }
    if (filter?.technicianId !== undefined) {
      const technicianId = filter.technicianId;
      conditions.push(
        sql`(${schema.jobs.primaryTechnicianId} = ${technicianId} or exists (
          select 1 from ${schema.jobTechnicians}
           where ${schema.jobTechnicians.jobId} = ${schema.jobs.id}
             and ${schema.jobTechnicians.userId} = ${technicianId}
        ))`,
      );
    }

    /*
     * `filter.includeDeleted` is deliberately ignored.
     *
     * DECISION 6: a deleted job is deleted. There are no soft-deleted rows to
     * include or exclude, so honouring the flag would mean pretending to offer
     * a choice that no longer exists. The flag stays on the interface only
     * while the browser demo, which still soft-deletes, is on the other side
     * of it.
     */
    const rows = await this.db
      .select()
      .from(schema.jobs)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(schema.jobs.jobNumberSeq));

    return this.assemble(rows);
  }

  async findById(id: JobId): Promise<Job | null> {
    const rows = await this.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    const assembled = await this.assemble(rows);
    return assembled[0] ?? null;
  }

  async findByJobNumber(jobNumber: string): Promise<Job | null> {
    const rows = await this.db
      .select()
      .from(schema.jobs)
      .where(sql`lower(${schema.jobs.jobNumber}) = lower(${jobNumber})`)
      .limit(1);
    const assembled = await this.assemble(rows);
    return assembled[0] ?? null;
  }

  /**
   * Allocates the next job number, atomically.
   *
   * `nextval` never hands the same value to two callers and never blocks. A
   * transaction that rolls back leaves a gap, which is the correct trade: a gap
   * is a number nobody used, a duplicate is two job cards claiming to be the
   * same job.
   */
  async allocateJobNumber(): Promise<{ readonly jobNumber: string; readonly sequence: number }> {
    const result = await this.db.execute<{ seq: number; job_number: string }>(
      sql`select * from allocate_job_number()`,
    );
    const row = [...result][0];
    if (row === undefined) {
      throw new Error('allocate_job_number() returned nothing; the migration may not have run.');
    }
    return { jobNumber: row.job_number, sequence: Number(row.seq) };
  }

  /**
   * Writes the job and its children.
   *
   * The whole aggregate is written together, so this must be called inside a
   * transaction — `withTransaction` is what provides one. The children are
   * replaced rather than diffed: a job has a handful of lines, the write is one
   * round trip either way, and a diff is a place for a bug to live.
   *
   * IMMUTABLE RECORDS ARE INSERTED, NEVER REWRITTEN. The signature, the
   * refusals, the pricing snapshot and the final document are written once;
   * attempting to change one raises in the database, not merely here.
   */
  async save(job: Job): Promise<Job> {
    const existing = await this.db
      .select({ version: schema.jobs.version, seq: schema.jobs.jobNumberSeq })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id))
      .limit(1);

    const current = existing[0];

    if (current === undefined) {
      /*
       * A new job arrives with its number already allocated.
       *
       * `createJob` calls `allocateJobNumber()` explicitly, inside the same
       * transaction, so the number exists before the row does. Allocating here
       * instead would burn a sequence value on every save and would hide the
       * allocation from the operation that is supposed to own it.
       */
      await this.db.insert(schema.jobs).values(toJobRow(job, sequenceFromJobNumber(job.jobNumber)));
    } else {
      /*
       * The version this caller last saw, not the one in the row right now.
       *
       * A caller that never read the job through this repository is writing
       * blind; it is given the stored version so the write proceeds, because
       * refusing it would break legitimate first-write paths. A caller that DID
       * read it is held to what it read, which is what makes the second of two
       * concurrent writers lose rather than win.
       */
      const expected = this.seenVersions.get(job.id) ?? current.version;

      const updated = await this.db
        .update(schema.jobs)
        .set({
          ...toJobRow(job, current.seq),
          updatedAt: sql`now()`,
          version: expected + 1,
        })
        .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.version, expected)))
        .returning({ version: schema.jobs.version });

      const written = updated[0];
      if (written === undefined) {
        throw new ConcurrencyError('Job', job.jobNumber, expected);
      }
      this.seenVersions.set(job.id, written.version);
    }

    await this.replaceChildren(job);
    await this.appendImmutableRecords(job);

    const saved = await this.findById(job.id);
    if (saved === null) throw new Error(`${job.jobNumber} vanished during save.`);
    return saved;
  }

  /**
   * Removes the job outright. DECISION 6.
   *
   * The audit event recording the deletion is written by the application layer
   * BEFORE this is called, and survives it — `audit_events.job_id` is
   * deliberately not a foreign key so that the row can outlive the job it
   * describes.
   *
   * The workflow permits this only for a job nobody has accepted; that rule is
   * `deleteJobRefusal`, in the domain, and is not re-implemented here.
   */
  async hardDelete(id: JobId): Promise<void> {
    await this.db.delete(schema.jobs).where(eq(schema.jobs.id, id));
  }

  /* ---------------------------------------------------------------------- */

  /** Children that are freely editable while the job is: replaced wholesale. */
  private async replaceChildren(job: Job): Promise<void> {
    await this.db.delete(schema.jobTechnicians).where(eq(schema.jobTechnicians.jobId, job.id));
    if (job.additionalTechnicianIds.length > 0) {
      await this.db.insert(schema.jobTechnicians).values(
        job.additionalTechnicianIds.map((userId) => ({
          jobId: job.id as string,
          userId: userId as string,
        })),
      );
    }

    await this.db.delete(schema.jobLabour).where(eq(schema.jobLabour.jobId, job.id));
    if (job.labour.length > 0) {
      await this.db.insert(schema.jobLabour).values(
        job.labour.map((entry) => ({
          id: entry.id as string,
          jobId: job.id as string,
          technicianId: entry.technicianId,
          capturedBy: entry.capturedBy,
          workDate: entry.date,
          rateType: entry.rateType,
          hours: String(entry.hours),
          description: entry.description,
          capturedAt: entry.capturedAt,
        })),
      );
    }

    await this.db.delete(schema.jobTravel).where(eq(schema.jobTravel.jobId, job.id));
    if (job.travel.length > 0) {
      await this.db.insert(schema.jobTravel).values(
        job.travel.map((entry) => ({
          id: entry.id as string,
          jobId: job.id as string,
          technicianId: entry.technicianId,
          capturedBy: entry.capturedBy,
          travelDate: entry.date,
          kilometres: String(entry.kilometres),
          description: entry.description,
          capturedAt: entry.capturedAt,
        })),
      );
    }

    await this.db.delete(schema.jobParts).where(eq(schema.jobParts.jobId, job.id));
    if (job.parts.length > 0) {
      await this.db.insert(schema.jobParts).values(
        job.parts.map((entry) => ({
          id: entry.id as string,
          jobId: job.id as string,
          partNumber: entry.partNumber,
          description: entry.description,
          quantity: entry.quantity,
          unitPriceCents: entry.unitPrice,
          capturedAt: entry.capturedAt,
          capturedBy: entry.capturedBy,
        })),
      );
    }

    await this.db.delete(schema.jobNotes).where(eq(schema.jobNotes.jobId, job.id));
    if (job.notes.length > 0) {
      await this.db.insert(schema.jobNotes).values(
        job.notes.map((note) => ({
          id: note.id,
          jobId: job.id as string,
          body: note.body,
          authorId: note.authorId,
          internal: note.internal,
          createdAt: note.createdAt,
        })),
      );
    }

    /*
     * Media is UPSERTED, never deleted and re-inserted.
     *
     * The row carries the storage key of a real file. Deleting and re-inserting
     * it would break the link between the job and bytes that still exist, and
     * removal is a soft mark anyway — a technician taking a photo off a job
     * must not destroy the evidence of what the machine looked like.
     */
    const media = [
      ...job.photos.map((item) => ({ item, kind: 'photo' as const })),
      ...job.videos.map((item) => ({ item, kind: 'video' as const })),
      ...job.attachments.map((item) => ({ item, kind: 'document' as const })),
    ];
    for (const { item, kind } of media) {
      await this.db
        .insert(schema.jobMedia)
        .values({
          id: item.id as string,
          jobId: job.id as string,
          kind,
          fileName: item.fileName,
          caption: item.caption,
          storageKey: item.storageKey,
          sizeBytes: item.sizeBytes,
          uploadedAt: item.uploadedAt,
          uploadedBy: item.uploadedBy,
        })
        .onConflictDoUpdate({
          target: schema.jobMedia.id,
          set: { caption: item.caption, removedAt: null },
        });
    }
  }

  /**
   * Historical records: inserted if absent, otherwise left exactly as they are.
   *
   * `onConflictDoNothing` is the whole point. A `save` of a job that already
   * carries a signature must not rewrite it, and the database would refuse
   * anyway — this simply keeps the repository from asking.
   */
  private async appendImmutableRecords(job: Job): Promise<void> {
    if (job.signature !== null) {
      await this.db
        .insert(schema.jobSignatures)
        .values({
          id: crypto.randomUUID(),
          jobId: job.id as string,
          customerName: job.signature.customerName,
          customerSurname: job.signature.customerSurname,
          strokeData: job.signature.strokeData,
          declaration: job.signature.declaration,
          signedAt: job.signature.signedAt,
        })
        .onConflictDoNothing({ target: schema.jobSignatures.jobId });
    }

    for (const [index, refusal] of job.signatureRefusals.entries()) {
      const attempt = index + 1;
      await this.db
        .insert(schema.signatureRefusals)
        .values({
          id: crypto.randomUUID(),
          jobId: job.id as string,
          attempt,
          reason: refusal.reason,
          recordedBy: refusal.recordedBy,
          recordedAt: refusal.recordedAt,
          resolvedBy: refusal.resolvedBy,
          resolvedAt: refusal.resolvedAt,
          resolution: refusal.resolution,
          resolutionNote: refusal.resolutionNote,
        })
        // Attempt 1 is never overwritten. Only its resolution may be filled in,
        // once, which is what the office does when it deals with the refusal.
        .onConflictDoUpdate({
          target: [schema.signatureRefusals.jobId, schema.signatureRefusals.attempt],
          set: {
            resolvedBy: refusal.resolvedBy,
            resolvedAt: refusal.resolvedAt,
            resolution: refusal.resolution,
            resolutionNote: refusal.resolutionNote,
          },
          setWhere: sql`${schema.signatureRefusals.resolvedAt} is null`,
        });
    }

    if (job.pricingSnapshot !== null) {
      await this.db
        .insert(schema.pricingSnapshots)
        .values({
          id: crypto.randomUUID(),
          jobId: job.id as string,
          attempt: 1,
          labourNormalCents: job.pricingSnapshot.labourRates.normal,
          labourOvertimeCents: job.pricingSnapshot.labourRates.overtime,
          labourDoubleCents: job.pricingSnapshot.labourRates.double,
          calloutRateCents: job.pricingSnapshot.calloutRate,
          kilometreRateCents: job.pricingSnapshot.kilometreRate,
          vatPercentBasisPoints: Math.round(job.pricingSnapshot.vatPercentage * 100),
          // Totals are materialised by the application when it freezes the
          // snapshot; a repository must not compute a price.
          subtotalCents: 0,
          vatCents: 0,
          totalCents: 0,
          capturedAt: job.pricingSnapshot.capturedAt,
          reason: job.pricingSnapshot.reason,
        })
        .onConflictDoNothing({
          target: [schema.pricingSnapshots.jobId, schema.pricingSnapshots.attempt],
        });
    }

    if (job.finalDocument !== null) {
      await this.db
        .insert(schema.finalDocuments)
        .values({
          id: crypto.randomUUID(),
          jobId: job.id as string,
          fileName: job.finalDocument.fileName,
          storageKey: job.finalDocument.storageKey,
          pageCount: job.finalDocument.pageCount,
          rendererVersion: 0,
          generatedAt: job.finalDocument.generatedAt,
          generatedBy: job.finalDocument.generatedBy,
          issuedTo: job.finalDocument.issuedTo,
        })
        .onConflictDoNothing({ target: schema.finalDocuments.jobId });
    }
  }

  /** Fetches every child collection for the given roots and assembles the jobs. */
  private async assemble(
    roots: readonly (typeof schema.jobs.$inferSelect)[],
  ): Promise<readonly Job[]> {
    if (roots.length === 0) return [];
    const ids = roots.map((row) => row.id);

    const [technicians, labour, travel, parts, notes, media, signatures, refusals, snapshots, documents, attempts] =
      await Promise.all([
        this.db.select().from(schema.jobTechnicians).where(inArray(schema.jobTechnicians.jobId, ids)),
        this.db.select().from(schema.jobLabour).where(inArray(schema.jobLabour.jobId, ids)),
        this.db.select().from(schema.jobTravel).where(inArray(schema.jobTravel.jobId, ids)),
        this.db.select().from(schema.jobParts).where(inArray(schema.jobParts.jobId, ids)),
        this.db.select().from(schema.jobNotes).where(inArray(schema.jobNotes.jobId, ids)),
        this.db.select().from(schema.jobMedia).where(inArray(schema.jobMedia.jobId, ids)),
        this.db.select().from(schema.jobSignatures).where(inArray(schema.jobSignatures.jobId, ids)),
        this.db
          .select()
          .from(schema.signatureRefusals)
          .where(inArray(schema.signatureRefusals.jobId, ids))
          .orderBy(schema.signatureRefusals.attempt),
        this.db.select().from(schema.pricingSnapshots).where(inArray(schema.pricingSnapshots.jobId, ids)),
        this.db.select().from(schema.finalDocuments).where(inArray(schema.finalDocuments.jobId, ids)),
        this.db
          .select()
          .from(schema.deliveryAttempts)
          .where(inArray(schema.deliveryAttempts.jobId, ids))
          .orderBy(desc(schema.deliveryAttempts.attemptNumber)),
      ]);

    const by = <T extends { jobId: string }>(rows: readonly T[], id: string): readonly T[] =>
      rows.filter((row) => row.jobId === id);

    for (const root of roots) this.seenVersions.set(root.id, root.version);

    return roots.map((job) =>
      toDomainJob({
        job,
        technicians: by(technicians, job.id),
        labour: by(labour, job.id),
        travel: by(travel, job.id),
        parts: by(parts, job.id),
        notes: by(notes, job.id),
        media: by(media, job.id),
        signature: by(signatures, job.id)[0] ?? null,
        refusals: by(refusals, job.id),
        snapshot: by(snapshots, job.id)[0] ?? null,
        finalDocument: by(documents, job.id)[0] ?? null,
        deliveryAttempts: by(attempts, job.id),
        // Checklists are a separate aggregate with their own repository; this
        // phase persists the job, and the checklist repository follows.
        checklist: null,
      } satisfies JobRowSet),
    );
  }
}
