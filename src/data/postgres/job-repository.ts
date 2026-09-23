import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  asCustomerId,
  asJobId,
  asMachineId,
  asSiteId,
  asUserId,
  type JobSummary,
  materialisePricingSnapshot,
} from '@/domain';
import type {
  Job,
  JobId,
  PricingSnapshot,
  PricingSnapshotTotals,
  UserId,
} from '@/domain';
import type { JobFilter, JobRepository, JobTransferRecord } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { loadChecklists, writeChecklist } from './job-checklist';
import {
  finalDocumentFrom,
  refusalFrom,
  snapshotFrom,
  toDomainJob,
  toJobRow,
  vatBasisPointsFromPercent,
  type JobRowSet,
} from './job-mapper';
import { VersionLedger, requireWritten } from './versions';
import { isUuid } from './identifiers';

/** The three money columns a snapshot carries, named once. */
const totalsOf = (totals: PricingSnapshotTotals) => ({
  subtotalCents: totals.subtotal,
  vatCents: totals.vat,
  totalCents: totals.total,
});

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
  /** What this unit of work last read. See `VersionLedger`. */
  private readonly versions = new VersionLedger();

  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * Loads the jobs matching a filter, each fully assembled.
   *
   * The root rows are selected first and the children are fetched with one
   * query per collection over the resulting ids — eleven queries for any number
   * of jobs, rather than eleven per job.
   */
  /** The WHERE shared by `list` and `listSummaries`, so the two cannot drift. */
  private conditionsFor(filter?: JobFilter) {
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

    return conditions.length === 0 ? undefined : and(...conditions);
  }

  async list(filter?: JobFilter): Promise<readonly Job[]> {
    const rows = await this.db
      .select()
      .from(schema.jobs)
      .where(this.conditionsFor(filter))
      .orderBy(desc(schema.jobs.jobNumberSeq));

    return this.assemble(rows);
  }

  /**
   * The jobs matching a filter, as a LIST ROW needs them.
   *
   * TWO QUERIES, WHATEVER THE FILTER MATCHES. `list()` above assembles complete
   * aggregates — twelve unbounded child reads for parts, labour, travel, media,
   * notes, signatures, refusals, pricing snapshots, final documents, delivery
   * attempts and checklists — which is right for a screen that shows a job and
   * wrong for a screen that shows a table of them. This selects the columns a
   * row renders, plus the one child collection Decision 5 genuinely needs
   * (`job_technicians`, for `additionalTechnicianIds`), and nothing else.
   *
   * A summary carries no price, so there is nothing here for `withoutPrices` to
   * remove — see `summariesVisibleTo` in the domain.
   */
  async listSummaries(filter?: JobFilter): Promise<readonly JobSummary[]> {
    const rows = await this.db
      .select({
        id: schema.jobs.id,
        jobNumber: schema.jobs.jobNumber,
        status: schema.jobs.status,
        jobTypeCode: schema.jobs.jobTypeCode,
        priority: schema.jobs.priority,
        scheduledDate: schema.jobs.scheduledDate,
        closedAt: schema.jobs.closedAt,
        submittedAt: schema.jobs.submittedAt,
        referenceNumber: schema.jobs.referenceNumber,
        orderNumber: schema.jobs.orderNumber,
        faultDescription: schema.jobs.faultDescription,
        customerId: schema.jobs.customerId,
        siteId: schema.jobs.siteId,
        machineId: schema.jobs.machineId,
        primaryTechnicianId: schema.jobs.primaryTechnicianId,
        createdAt: schema.jobs.createdAt,
        completedAt: schema.jobs.completedAt,
        scheduledEndDate: schema.jobs.scheduledEndDate,
      })
      .from(schema.jobs)
      .where(this.conditionsFor(filter))
      .orderBy(desc(schema.jobs.jobNumberSeq));

    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    /*
     * Three child reads, not twelve, and every one of them is something a list
     * genuinely draws: the crew Decision 5 needs, the refusal badge, and
     * whether the archive has an issued document.
     */
    const [crew, refusals, documents] = await Promise.all([
      this.db
        .select({ jobId: schema.jobTechnicians.jobId, userId: schema.jobTechnicians.userId })
        .from(schema.jobTechnicians)
        .where(inArray(schema.jobTechnicians.jobId, ids)),
      this.db
        .select()
        .from(schema.signatureRefusals)
        .where(inArray(schema.signatureRefusals.jobId, ids))
        .orderBy(schema.signatureRefusals.attempt),
      this.db
        .select()
        .from(schema.finalDocuments)
        .where(inArray(schema.finalDocuments.jobId, ids)),
    ]);

    const additional = new Map<string, UserId[]>();
    for (const row of crew) {
      const existing = additional.get(row.jobId);
      if (existing === undefined) additional.set(row.jobId, [asUserId(row.userId)]);
      else existing.push(asUserId(row.userId));
    }

    return rows.map((row) => ({
      id: asJobId(row.id),
      jobNumber: row.jobNumber,
      status: row.status,
      jobType: row.jobTypeCode as JobSummary['jobType'],
      priority: row.priority,
      scheduledDate: row.scheduledDate,
      closedAt: row.closedAt,
      submittedAt: row.submittedAt,
      referenceNumber: row.referenceNumber,
      orderNumber: row.orderNumber,
      faultDescription: row.faultDescription,
      customerId: asCustomerId(row.customerId),
      siteId: asSiteId(row.siteId),
      machineId: row.machineId === null ? null : asMachineId(row.machineId),
      primaryTechnicianId: row.primaryTechnicianId === null ? null : asUserId(row.primaryTechnicianId),
      additionalTechnicianIds: additional.get(row.id) ?? [],
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      scheduledEndDate: row.scheduledEndDate,
      signatureRefusals: refusals.filter((entry) => entry.jobId === row.id).map(refusalFrom),
      finalDocument: (() => {
        const found = documents.find((entry) => entry.jobId === row.id);
        return found === undefined ? null : finalDocumentFrom(found);
      })(),
    }));
  }

  /** One query. The archive asks for these; no other list ever does. */
  async listPricingSnapshots(
    jobIds: readonly JobId[],
  ): Promise<ReadonlyMap<JobId, PricingSnapshot | null>> {
    const found = new Map<JobId, PricingSnapshot | null>();
    if (jobIds.length === 0) return found;

    const rows = await this.db
      .select()
      .from(schema.pricingSnapshots)
      .where(inArray(schema.pricingSnapshots.jobId, [...jobIds] as string[]));

    for (const row of rows) found.set(asJobId(row.jobId), snapshotFrom(row));
    return found;
  }

  async count(filter?: JobFilter): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.jobs)
      .where(this.conditionsFor(filter));
    return row?.total ?? 0;
  }

  async findById(id: JobId): Promise<Job | null> {
    if (!isUuid(id)) return null;
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
      const expected = this.versions.expected(job.id, current.version);

      const updated = await this.db
        .update(schema.jobs)
        .set({
          ...toJobRow(job, current.seq),
          updatedAt: sql`now()`,
          version: expected + 1,
        })
        .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.version, expected)))
        .returning({ version: schema.jobs.version });

      const written = requireWritten(updated, 'Job', job.jobNumber, expected);
      this.versions.remember(job.id, written.version);
    }

    await this.replaceChildren(job);
    await writeChecklist(this.db, job);
    await this.appendImmutableRecords(job);

    const saved = await this.findById(job.id);
    if (saved === null) throw new Error(`${job.jobNumber} vanished during save.`);
    return saved;
  }

  /**
   * Removes the job and its children outright.
   *
   * Every child table cascades from `jobs`, so one delete takes the labour, the
   * travel, the parts, the notes, the media, the participation rows and the
   * historical records with it. That is correct for a job that should never
   * have existed: there is nothing here worth keeping, which is exactly why the
   * workflow refuses this once a technician has accepted it.
   *
   * The audit event recording the deletion is written by the application layer
   * BEFORE this runs and survives it — `audit_events.job_id` is deliberately
   * not a foreign key so the row can outlive the job it describes.
   *
   * `deleteJobRefusal`, in the domain, is what decides whether a job may be
   * deleted at all. It is not re-implemented here.
   */
  /**
   * Every job this person has ever been on, from `job_participants`.
   *
   * Not from `jobs.primary_technician_id`: a transfer overwrites that, and a
   * technician must not lose access to work they captured because somebody
   * else has it now.
   */
  async listParticipatedJobs(userId: UserId): Promise<readonly Job[]> {
    const roots = await this.db
      .select()
      .from(schema.jobs)
      .where(
        sql`exists (
          select 1 from ${schema.jobParticipants}
           where ${schema.jobParticipants.jobId} = ${schema.jobs.id}
             and ${schema.jobParticipants.userId} = ${userId}
        )`,
      )
      .orderBy(desc(schema.jobs.jobNumberSeq));
    return this.assemble(roots);
  }

  /**
   * Writes a handover. APPEND-ONLY, enforced by a trigger.
   *
   * The repository decides nothing here: who may transfer a job, whether the
   * receiving technician does field work, and whether a reason of "other"
   * needs a description are all settled in `job-operations` before this is
   * called. The CHECK constraint on the table is the second line, not the
   * first.
   */
  async recordTransfer(entry: JobTransferRecord): Promise<void> {
    await this.db.insert(schema.jobTransfers).values({
      id: crypto.randomUUID(),
      jobId: entry.jobId as string,
      fromUserId: entry.fromUserId,
      toUserId: entry.toUserId,
      reason: entry.reason,
      description: entry.description,
      transferredBy: entry.transferredBy as string,
      transferredAt: entry.transferredAt,
    });
  }

  async delete(id: JobId): Promise<void> {
    await this.db.delete(schema.jobs).where(eq(schema.jobs.id, id));
    this.versions.forget(id);
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

    await this.recordParticipation(job);

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
      /*
       * The snapshot AND its lines, together.
       *
       * The rates on their own are not enough: the office may amend the job
       * after the customer signed but before it is issued, and once they do,
       * recomputing from "the job as it stands" no longer answers what the
       * customer put their name to. The lines are written down so it always
       * does. Both tables refuse an update at the database, so this happens
       * once or not at all.
       */
      const snapshotId = crypto.randomUUID();
      const inserted = await this.db
        .insert(schema.pricingSnapshots)
        .values({
          id: snapshotId,
          jobId: job.id as string,
          attempt: 1,
          labourNormalCents: job.pricingSnapshot.labourRates.normal,
          labourOvertimeCents: job.pricingSnapshot.labourRates.overtime,
          labourDoubleCents: job.pricingSnapshot.labourRates.double,
          calloutRateCents: job.pricingSnapshot.calloutRate,
          kilometreRateCents: job.pricingSnapshot.kilometreRate,
          vatPercentBasisPoints: vatBasisPointsFromPercent(job.pricingSnapshot.vatPercentage),
          ...totalsOf(materialisePricingSnapshot(job, job.pricingSnapshot).totals),
          capturedAt: job.pricingSnapshot.capturedAt,
          reason: job.pricingSnapshot.reason,
        })
        .onConflictDoNothing({
          target: [schema.pricingSnapshots.jobId, schema.pricingSnapshots.attempt],
        })
        .returning({ id: schema.pricingSnapshots.id });

      // Only when the snapshot was genuinely new. A reread of an already-frozen
      // job must not append a second set of lines to it.
      if (inserted[0] !== undefined) {
        await this.writeSnapshotLines(inserted[0].id, job, job.pricingSnapshot);
      }
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

  /**
   * Keeps `job_participants` in step with who is on the job.
   *
   * Append-and-close, never replace. Somebody currently on the job gets an open
   * row if they have none; somebody no longer on it has their open row closed.
   * Closed rows stay for ever — they are the history the visibility rule reads,
   * and the whole reason this table exists separately from `job_technicians`.
   *
   * Derived from the job the caller is saving rather than decided here: who is
   * on a job is a business fact the operations already establish. This only
   * makes sure the record of it survives the next reassignment.
   */
  private async recordParticipation(job: Job): Promise<void> {
    const now = sql`now()`;

    const current = new Map<string, 'primary_technician' | 'additional_technician'>();
    if (job.primaryTechnicianId !== null) {
      current.set(job.primaryTechnicianId, 'primary_technician');
    }
    for (const userId of job.additionalTechnicianIds) {
      if (!current.has(userId)) current.set(userId, 'additional_technician');
    }

    const open = await this.db
      .select()
      .from(schema.jobParticipants)
      .where(and(eq(schema.jobParticipants.jobId, job.id), isNull(schema.jobParticipants.until)));

    // Anyone no longer on the job has their participation closed, with a reason.
    for (const row of open) {
      if (current.get(row.userId) === row.role) continue;
      await this.db
        .update(schema.jobParticipants)
        .set({ until: now, endedReason: 'no longer assigned' })
        .where(eq(schema.jobParticipants.id, row.id));
    }

    // Anyone on it who has no open row gets one.
    for (const [userId, role] of current) {
      const alreadyOpen = open.some((row) => row.userId === userId && row.role === role);
      if (alreadyOpen) continue;
      await this.db.insert(schema.jobParticipants).values({
        id: crypto.randomUUID(),
        jobId: job.id as string,
        userId,
        role,
        since: job.acceptedAt ?? job.createdAt,
      });
    }
  }

  /**
   * Writes the priced lines that belong to a snapshot.
   *
   * The snapshot freezes the RATES; these freeze what those rates produced, so
   * "what did the customer sign for?" survives the office amending the job
   * afterwards. Computed by `materialisePricingSnapshot` in the domain — the
   * repository labels nothing and prices nothing.
   *
   * Written once, with the snapshot, and never again: both tables refuse an
   * update at the database.
   */
  private async writeSnapshotLines(
    snapshotId: string,
    job: Job,
    snapshot: PricingSnapshot,
  ): Promise<PricingSnapshotTotals> {
    const materialised = materialisePricingSnapshot(job, snapshot);
    if (materialised.lines.length > 0) {
      await this.db.insert(schema.pricingSnapshotLines).values(
        materialised.lines.map((line) => ({
          id: crypto.randomUUID(),
          snapshotId,
          lineKind: line.kind,
          sourceLineId: line.sourceLineId,
          position: line.position,
          description: line.description,
          detail: line.detail,
          quantity: String(line.quantity),
          unitLabel: line.unit,
          unitPriceCents: line.unitPrice,
          lineTotalCents: line.lineTotal,
        })),
      );
    }
    return materialised.totals;
  }

  /** Fetches every child collection for the given roots and assembles the jobs. */
  private async assemble(
    roots: readonly (typeof schema.jobs.$inferSelect)[],
  ): Promise<readonly Job[]> {
    if (roots.length === 0) return [];
    const ids = roots.map((row) => row.id);

    const [
      technicians,
      labour,
      travel,
      parts,
      notes,
      media,
      signatures,
      refusals,
      snapshots,
      documents,
      attempts,
      checklists,
    ] = await Promise.all([
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
      this.db
        .select()
        .from(schema.pricingSnapshots)
        .where(inArray(schema.pricingSnapshots.jobId, ids)),
      this.db
        .select()
        .from(schema.finalDocuments)
        .where(inArray(schema.finalDocuments.jobId, ids)),
      this.db
        .select()
        .from(schema.deliveryAttempts)
        .where(inArray(schema.deliveryAttempts.jobId, ids))
        .orderBy(desc(schema.deliveryAttempts.attemptNumber)),
      loadChecklists(this.db, ids),
    ]);

    const by = <T extends { jobId: string }>(rows: readonly T[], id: string): readonly T[] =>
      rows.filter((row) => row.jobId === id);

    this.versions.rememberAll(roots);

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
        checklist: checklists.get(job.id) ?? null,
      } satisfies JobRowSet),
    );
  }
}
