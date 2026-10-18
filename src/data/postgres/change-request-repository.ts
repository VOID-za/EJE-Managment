import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  ChangeRequest,
  ChangeRequestState,
  ChangeRequestSubject,
  CustomerId,
  IsoDateTime,
  MachineId,
  SiteId,
  UserId,
} from '@/domain';
import type { ChangeRequestRepository } from '../repositories';
import * as schema from '@/db/schema';
import type { DatabaseExecutor } from '@/db/client';

type Row = typeof schema.customerChangeRequests.$inferSelect;

const toRequest = (row: Row): ChangeRequest => ({
  id: row.id,
  subject: row.subject as ChangeRequestSubject,
  customerId: row.customerId as CustomerId,
  siteId: row.siteId === null ? null : (row.siteId as SiteId),
  machineId: row.machineId === null ? null : (row.machineId as MachineId),
  details: row.details,
  raisedBy: (row.raisedBy ?? '') as UserId,
  raisedAt: row.raisedAt as IsoDateTime,
  state: row.state as ChangeRequestState,
  resolvedBy: row.resolvedBy === null ? null : (row.resolvedBy as UserId),
  resolvedAt: row.resolvedAt === null ? null : (row.resolvedAt as IsoDateTime),
  resolutionNote: row.resolutionNote,
});

/**
 * Register change requests on PostgreSQL. CUST-CR.
 *
 * NO VERSION COLUMN AND NO LEDGER, for the same reason as
 * `PostgresCaptureReferralRepository`: the one write that races is a second
 * office user resolving the same report, and the state answers that on its own.
 * `resolve` below is conditional on `state = 'open'`, so the loser changes no
 * rows and is told it has already been dealt with — an optimistic-concurrency
 * token would add a round trip to say the same thing.
 *
 * THE ROW IS NEVER UPDATED EXCEPT TO RESOLVE IT. A report is what somebody
 * said; editing their words afterwards would make the trail worthless, so
 * `save` inserts and nothing else writes `details`.
 */
export class PostgresChangeRequestRepository implements ChangeRequestRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async list(filter: { readonly state?: ChangeRequestState } = {}): Promise<
    readonly ChangeRequest[]
  > {
    const rows =
      filter.state === undefined
        ? await this.db
            .select()
            .from(schema.customerChangeRequests)
            /*
             * Open first, because that is what the office acts on, and then
             * OLDEST first — the report that has been waiting longest is the
             * one somebody should look at next, which is the opposite of a
             * referral's ordering and deliberately so.
             *
             * `asc(state)` CANNOT EXPRESS THIS, and the first draft used it:
             * the states sort alphabetically, so `applied` and `declined` came
             * before `open` and the office's screen led with the work that was
             * already done. Its own test caught that. The open-ness is what is
             * being ordered by, so it is said explicitly.
             */
            .orderBy(
              sql`case when ${schema.customerChangeRequests.state} = 'open' then 0 else 1 end`,
              asc(schema.customerChangeRequests.raisedAt),
            )
        : await this.db
            .select()
            .from(schema.customerChangeRequests)
            .where(eq(schema.customerChangeRequests.state, filter.state))
            .orderBy(asc(schema.customerChangeRequests.raisedAt));
    return rows.map(toRequest);
  }

  async listForCustomer(customerId: CustomerId): Promise<readonly ChangeRequest[]> {
    const rows = await this.db
      .select()
      .from(schema.customerChangeRequests)
      .where(eq(schema.customerChangeRequests.customerId, customerId))
      .orderBy(desc(schema.customerChangeRequests.raisedAt));
    return rows.map(toRequest);
  }

  async listForRaiser(raisedBy: UserId): Promise<readonly ChangeRequest[]> {
    const rows = await this.db
      .select()
      .from(schema.customerChangeRequests)
      .where(eq(schema.customerChangeRequests.raisedBy, raisedBy))
      .orderBy(desc(schema.customerChangeRequests.raisedAt));
    return rows.map(toRequest);
  }

  async findById(id: string): Promise<ChangeRequest | null> {
    const rows = await this.db
      .select()
      .from(schema.customerChangeRequests)
      .where(eq(schema.customerChangeRequests.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRequest(row);
  }

  async save(request: ChangeRequest): Promise<ChangeRequest> {
    const inserted = await this.db
      .insert(schema.customerChangeRequests)
      .values({
        id: request.id,
        subject: request.subject,
        customerId: request.customerId as string,
        siteId: request.siteId,
        machineId: request.machineId,
        details: request.details,
        raisedBy: request.raisedBy.length === 0 ? null : (request.raisedBy as string),
        raisedAt: request.raisedAt,
        state: request.state,
        resolvedBy: request.resolvedBy,
        resolvedAt: request.resolvedAt,
        resolutionNote: request.resolutionNote,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) throw new Error('the change request vanished during insert');
    return toRequest(row);
  }

  async resolve(request: ChangeRequest): Promise<ChangeRequest | null> {
    const updated = await this.db
      .update(schema.customerChangeRequests)
      .set({
        state: request.state,
        resolvedBy: request.resolvedBy,
        resolvedAt: request.resolvedAt,
        resolutionNote: request.resolutionNote,
      })
      /*
       * THE CONDITION IS IN THE WRITE. Two office users deciding on the same
       * report at once: the second changes no rows and is told it has been
       * dealt with, rather than overwriting the first decision.
       */
      .where(
        and(
          eq(schema.customerChangeRequests.id, request.id),
          eq(schema.customerChangeRequests.state, 'open'),
        ),
      )
      .returning();
    const row = updated[0];
    return row === undefined ? null : toRequest(row);
  }
}
