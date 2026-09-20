import { desc, eq } from 'drizzle-orm';
import { asActivityId, asJobId, asUserId, type ActivityEvent, type JobId } from '@/domain';
import type { ActivityRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';

type AuditRow = typeof schema.auditEvents.$inferSelect;

const toDomainEvent = (row: AuditRow): ActivityEvent => ({
  id: asActivityId(row.id),
  jobId: row.jobId === null ? null : asJobId(row.jobId),
  type: row.type as ActivityEvent['type'],
  summary: row.summary,
  detail: row.detail,
  actorId: asUserId(row.actorId ?? ''),
  occurredAt: row.occurredAt,
});

/**
 * The audit trail, in PostgreSQL. APPEND-ONLY, enforced by a trigger.
 *
 * There is no update and no delete, and the database refuses both even if a
 * future code path asks. `list` reads; `append` writes; that is the whole
 * interface, which is what an audit trail is.
 *
 * WHAT THE REPOSITORY ADDS, AND WHY IT IS NOT BUSINESS LOGIC
 * ----------------------------------------------------------
 * Three columns are filled in here that the domain event does not carry: the
 * actor's role and name AT THE TIME, and the job's number. All three are facts
 * being copied rather than decided — a technician later promoted to Coordinator
 * must not retroactively appear to have acted as one, and a deleted job's
 * events must still name it in a way a person can read.
 *
 * The job number in particular is why DECISION 6 works. The deletion's audit
 * event is written BEFORE the destructive step, so the number is still
 * resolvable when this runs; afterwards the row keeps it by value, and
 * `audit_events.job_id` is deliberately not a foreign key so the row outlives
 * the job it describes.
 *
 * WHAT IS NEVER WRITTEN HERE: a customer's reason for refusing to sign. That
 * lives on the refusal record and nowhere else. Nothing in this file reads it,
 * and the operations no longer put it in `detail`.
 */
export class PostgresActivityRepository implements ActivityRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(jobId?: JobId): Promise<readonly ActivityEvent[]> {
    const rows = await this.db
      .select()
      .from(schema.auditEvents)
      .where(jobId === undefined ? undefined : eq(schema.auditEvents.jobId, jobId))
      .orderBy(desc(schema.auditEvents.occurredAt));
    return rows.map(toDomainEvent);
  }

  async append(event: ActivityEvent): Promise<ActivityEvent> {
    const [actor, job] = await Promise.all([
      event.actorId.length === 0 ? Promise.resolve(null) : this.findActor(event.actorId),
      event.jobId === null ? Promise.resolve(null) : this.findJobNumber(event.jobId),
    ]);

    const inserted = await this.db
      .insert(schema.auditEvents)
      .values({
        id: event.id,
        occurredAt: event.occurredAt,
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        actorName: actor === null ? '' : `${actor.firstName} ${actor.lastName}`,
        type: event.type,
        summary: event.summary,
        detail: event.detail,
        jobId: event.jobId,
        jobNumber: job,
      })
      .returning();

    return toDomainEvent(inserted[0]!);
  }

  /* ---------------------------------------------------------------------- */

  private async findActor(actorId: string) {
    const rows = await this.db
      .select({
        id: schema.users.id,
        role: schema.users.role,
        firstName: schema.users.firstName,
        lastName: schema.users.lastName,
      })
      .from(schema.users)
      .where(eq(schema.users.id, actorId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async findJobNumber(jobId: string): Promise<string | null> {
    const rows = await this.db
      .select({ jobNumber: schema.jobs.jobNumber })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1);
    return rows[0]?.jobNumber ?? null;
  }
}
