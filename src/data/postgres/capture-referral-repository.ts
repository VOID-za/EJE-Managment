import { and, asc, desc, eq } from 'drizzle-orm';
import type {
  CaptureReferral,
  CaptureReferralState,
  CaptureResolution,
  IsoDateTime,
  JobId,
  UserId,
} from '@/domain';
import type { CaptureReferralRepository } from '../repositories';
import * as schema from '@/db/schema';
import type { DatabaseExecutor } from '@/db/client';

type Row = typeof schema.captureReferrals.$inferSelect;

const toReferral = (row: Row): CaptureReferral => ({
  id: row.id,
  jobId: row.jobId as JobId,
  technicianId: (row.technicianId ?? '') as UserId,
  action: row.action,
  /*
   * `jsonb` comes back as `unknown`. It is cast to a record and never trusted:
   * when the office applies a referral, this payload goes through the action's
   * own zod schema exactly as a browser's body would.
   */
  payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
  summary: row.summary,
  capturedAt: row.capturedAt as IsoDateTime,
  idempotencyKey: row.idempotencyKey,
  refusalCode: row.refusalCode,
  refusalMessage: row.refusalMessage,
  referredAt: row.referredAt as IsoDateTime,
  state: row.state as CaptureReferralState,
  resolvedBy: row.resolvedBy === null ? null : (row.resolvedBy as UserId),
  resolvedAt: row.resolvedAt === null ? null : (row.resolvedAt as IsoDateTime),
  resolution: row.resolution === null ? null : (row.resolution as CaptureResolution),
  resolutionNote: row.resolutionNote,
});

/**
 * Referred captures on PostgreSQL. BD-15.
 *
 * NO VERSION COLUMN AND NO LEDGER, deliberately. The one write that races is a
 * second office user resolving the same referral, and the state machine
 * answers that on its own: `resolveCaptureReferral` refuses a referral that is
 * not `open`, and the update below is conditional on `state = 'open'`, so the
 * loser changes no rows and is told the referral has already been dealt with.
 * An optimistic-concurrency token would add a round trip to say the same thing.
 */
export class PostgresCaptureReferralRepository implements CaptureReferralRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(filter: { readonly state?: CaptureReferralState } = {}): Promise<
    readonly CaptureReferral[]
  > {
    const rows =
      filter.state === undefined
        ? await this.db
            .select()
            .from(schema.captureReferrals)
            // Open first, because that is what the office has to act on, then
            // newest within each state.
            .orderBy(asc(schema.captureReferrals.state), desc(schema.captureReferrals.referredAt))
        : await this.db
            .select()
            .from(schema.captureReferrals)
            .where(eq(schema.captureReferrals.state, filter.state))
            .orderBy(desc(schema.captureReferrals.referredAt));
    return rows.map(toReferral);
  }

  async listForTechnician(technicianId: UserId): Promise<readonly CaptureReferral[]> {
    const rows = await this.db
      .select()
      .from(schema.captureReferrals)
      .where(eq(schema.captureReferrals.technicianId, technicianId))
      .orderBy(desc(schema.captureReferrals.referredAt));
    return rows.map(toReferral);
  }

  async findById(id: string): Promise<CaptureReferral | null> {
    const rows = await this.db
      .select()
      .from(schema.captureReferrals)
      .where(eq(schema.captureReferrals.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toReferral(row);
  }

  async findByCapture(
    technicianId: UserId,
    idempotencyKey: string,
  ): Promise<CaptureReferral | null> {
    const rows = await this.db
      .select()
      .from(schema.captureReferrals)
      .where(
        and(
          eq(schema.captureReferrals.technicianId, technicianId),
          eq(schema.captureReferrals.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toReferral(row);
  }

  async save(referral: CaptureReferral): Promise<CaptureReferral> {
    /*
     * ON CONFLICT ON THE CAPTURE KEY, not on the id.
     *
     * Two tablets — or one tablet twice — referring the same capture must end
     * with ONE referral. The unique index is `(technician_id,
     * idempotency_key)`, so the conflict target is the capture itself, and a
     * second referral of an already-referred capture updates the refusal
     * message rather than inserting a duplicate.
     *
     * The resolution columns are NOT in the update set: a referral the office
     * has already dealt with cannot be reopened by a tablet re-referring it.
     */
    await this.db
      .insert(schema.captureReferrals)
      .values({
        id: referral.id,
        jobId: referral.jobId,
        technicianId: referral.technicianId.length === 0 ? null : referral.technicianId,
        action: referral.action,
        payload: referral.payload,
        summary: referral.summary,
        capturedAt: referral.capturedAt,
        idempotencyKey: referral.idempotencyKey,
        refusalCode: referral.refusalCode,
        refusalMessage: referral.refusalMessage,
        referredAt: referral.referredAt,
        state: referral.state,
        resolvedBy: referral.resolvedBy,
        resolvedAt: referral.resolvedAt,
        resolution: referral.resolution,
        resolutionNote: referral.resolutionNote,
      })
      .onConflictDoUpdate({
        target: [schema.captureReferrals.technicianId, schema.captureReferrals.idempotencyKey],
        set: {
          refusalCode: referral.refusalCode,
          refusalMessage: referral.refusalMessage,
          summary: referral.summary,
        },
        /*
         * And only while it is still open. A resolved referral is history: the
         * office decided, and a tablet that never heard the answer must not be
         * able to rewrite the record it is asking about.
         */
        setWhere: eq(schema.captureReferrals.state, 'open'),
      });

    const stored = await this.findByCapture(referral.technicianId, referral.idempotencyKey);
    return stored ?? referral;
  }

  /**
   * Records the office's decision, and ONLY on a referral still open.
   *
   * Conditional on the state, so two office users resolving the same referral
   * cannot both win: the second changes no rows and the application layer tells
   * them it has already been dealt with.
   */
  async resolve(referral: CaptureReferral): Promise<CaptureReferral | null> {
    const updated = await this.db
      .update(schema.captureReferrals)
      .set({
        state: 'resolved',
        resolvedBy: referral.resolvedBy,
        resolvedAt: referral.resolvedAt,
        resolution: referral.resolution,
        resolutionNote: referral.resolutionNote,
      })
      .where(
        and(eq(schema.captureReferrals.id, referral.id), eq(schema.captureReferrals.state, 'open')),
      )
      .returning();
    const row = updated[0];
    return row === undefined ? null : toReferral(row);
  }
}
