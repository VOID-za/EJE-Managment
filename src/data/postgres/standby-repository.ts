import { and, asc, between, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  STANDBY_POSITIONS,
  asUserId,
  type IsoDate,
  type IsoDateTime,
  type StandbyEligibility,
  type StandbyPosition,
  type StandbySwapKind,
  type StandbySwapRequest,
  type StandbyDayOverride,
  type StandbyDayPair,
  type StandbyDaySwap,
  type StandbyDaySwapStatus,
  STANDBY_DAY_SWAP_ACTIVE,
  standbyHolderOn,
  type StandbySwapStatus,
  type StandbyWeek,
  type StandbyWeekStatus,
  type UserId,
} from '@/domain';
import type {
  StandbyApproval,
  StandbyDayApproval,
  StandbyDayMove,
  StandbyDaySwapDecision,
  StandbyRepository,
  StandbySwapDecision,
} from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { isUuid } from './identifiers';
import { standbyWeekOf as standbyWeekOfDate } from '@/domain';

type WeekRow = typeof schema.standbyWeeks.$inferSelect;
type AssignmentRow = typeof schema.standbyAssignments.$inferSelect;
type RequestRow = typeof schema.standbySwapRequests.$inferSelect;
type EligibilityRow = typeof schema.standbyEligibility.$inferSelect;

const optionalUser = (value: string | null): UserId | null => (value === null ? null : asUserId(value));

const toEligibility = (row: EligibilityRow): StandbyEligibility => ({
  userId: asUserId(row.userId),
  main: row.mayMain,
  helper: row.mayHelper,
  apprentice: row.mayApprentice,
  updatedBy: optionalUser(row.updatedBy),
  updatedAt: row.updatedAt,
});

const toWeek = (row: WeekRow, places: readonly AssignmentRow[]): StandbyWeek => ({
  id: row.id,
  weekStart: row.weekStart,
  status: row.status as StandbyWeekStatus,
  publishedBy: optionalUser(row.publishedBy),
  publishedAt: row.publishedAt,
  createdBy: optionalUser(row.createdBy),
  createdAt: row.createdAt,
  assignments: STANDBY_POSITIONS.map((position) => {
    const place = places.find((candidate) => candidate.position === position);
    return {
      position,
      userId: optionalUser(place?.userId ?? null),
      assignedBy: optionalUser(place?.assignedBy ?? null),
      assignedAt: place?.assignedAt ?? null,
    };
  }),
});

const toRequest = (row: RequestRow, mondays: ReadonlyMap<string, IsoDate>): StandbySwapRequest => ({
  id: row.id,
  kind: row.kind as StandbySwapKind,
  requesterId: asUserId(row.requesterId),
  requesterWeekStart: mondays.get(row.requesterWeekId) ?? '',
  requesterPosition: row.requesterPosition as StandbyPosition,
  counterpartId: asUserId(row.counterpartId),
  counterpartWeekStart: mondays.get(row.counterpartWeekId) ?? '',
  counterpartPosition: row.counterpartPosition as StandbyPosition,
  reason: row.reason,
  status: row.status as StandbySwapStatus,
  requestedAt: row.requestedAt,
  decidedBy: optionalUser(row.decidedBy),
  decidedAt: row.decidedAt,
  decisionNote: row.decisionNote,
  cancelledAt: row.cancelledAt,
});

/**
 * The standby calendar in PostgreSQL. STANDBY-1…8, migration 0045.
 *
 * Every method runs on the executor it was built with — inside a request, the
 * request's transaction — so an approval's two place changes and its decision
 * commit together or not at all. Approval also LOCKS the request and both
 * places (`FOR UPDATE`, request first, then places in week order) so two
 * approvals, or an approval and a manual change, cannot interleave: the second
 * waits, then finds the request decided or the place changed, and stops.
 */
export class PostgresStandbyRepository implements StandbyRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  async listEligibility(): Promise<readonly StandbyEligibility[]> {
    const rows = await this.db.select().from(schema.standbyEligibility);
    return rows.map(toEligibility);
  }

  async saveEligibility(record: StandbyEligibility): Promise<StandbyEligibility> {
    const values = {
      mayMain: record.main,
      mayHelper: record.helper,
      mayApprentice: record.apprentice,
      updatedBy: record.updatedBy,
    };
    const rows = await this.db
      .insert(schema.standbyEligibility)
      .values({ userId: record.userId, ...values })
      .onConflictDoUpdate({
        target: schema.standbyEligibility.userId,
        set: { ...values, updatedAt: sql`now()`, version: sql`${schema.standbyEligibility.version} + 1` },
      })
      .returning();
    return toEligibility(rows[0]!);
  }

  private async weeksWithPlaces(rows: readonly WeekRow[]): Promise<readonly StandbyWeek[]> {
    if (rows.length === 0) return [];
    const places = await this.db
      .select()
      .from(schema.standbyAssignments)
      .where(inArray(schema.standbyAssignments.weekId, rows.map((row) => row.id)));
    return rows.map((row) => toWeek(row, places.filter((place) => place.weekId === row.id)));
  }

  async listWeeks(from: IsoDate, to: IsoDate): Promise<readonly StandbyWeek[]> {
    const rows = await this.db
      .select()
      .from(schema.standbyWeeks)
      .where(between(schema.standbyWeeks.weekStart, from, to))
      .orderBy(asc(schema.standbyWeeks.weekStart));
    return this.weeksWithPlaces(rows);
  }

  async findWeek(weekStart: IsoDate): Promise<StandbyWeek | null> {
    const rows = await this.db
      .select()
      .from(schema.standbyWeeks)
      .where(eq(schema.standbyWeeks.weekStart, weekStart))
      .limit(1);
    return (await this.weeksWithPlaces(rows))[0] ?? null;
  }

  async createWeeks(weeks: readonly StandbyWeek[]): Promise<readonly IsoDate[]> {
    const added: IsoDate[] = [];
    for (const week of weeks) {
      // ON CONFLICT DO NOTHING: an existing week — draft or published — is never touched.
      const inserted = await this.db
        .insert(schema.standbyWeeks)
        .values({
          id: week.id,
          weekStart: week.weekStart,
          status: 'draft',
          createdBy: week.createdBy,
          createdAt: week.createdAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.standbyWeeks.id });
      if (inserted[0] === undefined) continue;
      await this.db.insert(schema.standbyAssignments).values(
        week.assignments.map((place) => ({
          id: crypto.randomUUID(),
          weekId: inserted[0]!.id,
          position: place.position,
          userId: place.userId,
          assignedBy: place.assignedBy,
          assignedAt: place.assignedAt,
        })),
      );
      added.push(week.weekStart);
    }
    return added;
  }

  async setAssignment(change: {
    readonly weekStart: IsoDate;
    readonly position: StandbyPosition;
    readonly expectedUserId: UserId | null;
    readonly userId: UserId | null;
    readonly assignedBy: UserId;
    readonly assignedAt: IsoDateTime;
  }): Promise<boolean> {
    const week = await this.db
      .select({ id: schema.standbyWeeks.id })
      .from(schema.standbyWeeks)
      .where(eq(schema.standbyWeeks.weekStart, change.weekStart))
      .limit(1);
    if (week[0] === undefined) return false;
    const holder =
      change.expectedUserId === null
        ? isNull(schema.standbyAssignments.userId)
        : eq(schema.standbyAssignments.userId, change.expectedUserId);
    const updated = await this.db
      .update(schema.standbyAssignments)
      .set({
        userId: change.userId,
        assignedBy: change.assignedBy,
        assignedAt: change.assignedAt,
        updatedAt: sql`now()`,
        version: sql`${schema.standbyAssignments.version} + 1`,
      })
      .where(
        and(
          eq(schema.standbyAssignments.weekId, week[0].id),
          eq(schema.standbyAssignments.position, change.position),
          holder,
        ),
      )
      .returning({ id: schema.standbyAssignments.id });
    return updated.length === 1;
  }

  async publishWeeks(weekStarts: readonly IsoDate[], by: UserId, at: IsoDateTime): Promise<readonly IsoDate[]> {
    if (weekStarts.length === 0) return [];
    const rows = await this.db
      .update(schema.standbyWeeks)
      .set({
        status: 'published',
        publishedBy: by,
        publishedAt: at,
        updatedAt: sql`now()`,
        version: sql`${schema.standbyWeeks.version} + 1`,
      })
      .where(and(inArray(schema.standbyWeeks.weekStart, [...weekStarts]), eq(schema.standbyWeeks.status, 'draft')))
      .returning({ weekStart: schema.standbyWeeks.weekStart });
    return rows.map((row) => row.weekStart).sort();
  }

  private async mondaysFor(rows: readonly RequestRow[]): Promise<ReadonlyMap<string, IsoDate>> {
    const ids = [...new Set(rows.flatMap((row) => [row.requesterWeekId, row.counterpartWeekId]))];
    if (ids.length === 0) return new Map();
    const weeks = await this.db
      .select({ id: schema.standbyWeeks.id, weekStart: schema.standbyWeeks.weekStart })
      .from(schema.standbyWeeks)
      .where(inArray(schema.standbyWeeks.id, ids));
    return new Map(weeks.map((week) => [week.id, week.weekStart]));
  }

  private async requests(rows: readonly RequestRow[]): Promise<readonly StandbySwapRequest[]> {
    const mondays = await this.mondaysFor(rows);
    return rows.map((row) => toRequest(row, mondays));
  }

  async listSwapRequests(): Promise<readonly StandbySwapRequest[]> {
    const rows = await this.db
      .select()
      .from(schema.standbySwapRequests)
      .orderBy(desc(schema.standbySwapRequests.requestedAt));
    return this.requests(rows);
  }

  async findSwapRequest(id: string): Promise<StandbySwapRequest | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(schema.standbySwapRequests)
      .where(eq(schema.standbySwapRequests.id, id))
      .limit(1);
    return (await this.requests(rows))[0] ?? null;
  }

  private async weekId(weekStart: IsoDate): Promise<string | null> {
    const rows = await this.db
      .select({ id: schema.standbyWeeks.id })
      .from(schema.standbyWeeks)
      .where(eq(schema.standbyWeeks.weekStart, weekStart))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async createSwapRequest(request: StandbySwapRequest): Promise<StandbySwapRequest | null> {
    const requesterWeekId = await this.weekId(request.requesterWeekStart);
    const counterpartWeekId = await this.weekId(request.counterpartWeekStart);
    if (requesterWeekId === null || counterpartWeekId === null) return null;
    // Any unique conflict — either place already offered in a pending request — is "not created".
    const rows = await this.db
      .insert(schema.standbySwapRequests)
      .values({
        id: request.id,
        kind: request.kind,
        requesterId: request.requesterId,
        requesterWeekId,
        requesterPosition: request.requesterPosition,
        counterpartId: request.counterpartId,
        counterpartWeekId,
        counterpartPosition: request.counterpartPosition,
        reason: request.reason,
        status: 'pending',
        requestedAt: request.requestedAt,
      })
      .onConflictDoNothing()
      .returning();
    return (await this.requests(rows))[0] ?? null;
  }

  async rejectSwapRequest(decision: StandbySwapDecision): Promise<StandbySwapRequest | null> {
    if (!isUuid(decision.id)) return null;
    const rows = await this.db
      .update(schema.standbySwapRequests)
      .set({
        status: 'rejected',
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        decisionNote: decision.decisionNote,
        updatedAt: sql`now()`,
        version: sql`${schema.standbySwapRequests.version} + 1`,
      })
      .where(and(eq(schema.standbySwapRequests.id, decision.id), eq(schema.standbySwapRequests.status, 'pending')))
      .returning();
    return (await this.requests(rows))[0] ?? null;
  }

  async cancelSwapRequest(id: string, at: IsoDateTime): Promise<StandbySwapRequest | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .update(schema.standbySwapRequests)
      .set({
        status: 'cancelled',
        cancelledAt: at,
        updatedAt: sql`now()`,
        version: sql`${schema.standbySwapRequests.version} + 1`,
      })
      .where(and(eq(schema.standbySwapRequests.id, id), eq(schema.standbySwapRequests.status, 'pending')))
      .returning();
    return (await this.requests(rows))[0] ?? null;
  }

  async approveSwapRequest(decision: StandbySwapDecision): Promise<StandbyApproval> {
    if (!isUuid(decision.id)) return { ok: false, reason: 'not_pending' };
    // 1. The request, locked: a second approval waits here, then sees it decided.
    const locked = await this.db
      .select()
      .from(schema.standbySwapRequests)
      .where(eq(schema.standbySwapRequests.id, decision.id))
      .for('update');
    const request = locked[0];
    if (request === undefined || request.status !== 'pending') return { ok: false, reason: 'not_pending' };

    // 2. Both places, locked in week order so two approvals never deadlock.
    const places = await this.db
      .select({
        id: schema.standbyAssignments.id,
        weekId: schema.standbyAssignments.weekId,
        position: schema.standbyAssignments.position,
        userId: schema.standbyAssignments.userId,
      })
      .from(schema.standbyAssignments)
      .innerJoin(schema.standbyWeeks, eq(schema.standbyWeeks.id, schema.standbyAssignments.weekId))
      .where(
        or(
          and(
            eq(schema.standbyAssignments.weekId, request.requesterWeekId),
            eq(schema.standbyAssignments.position, request.requesterPosition),
          ),
          and(
            eq(schema.standbyAssignments.weekId, request.counterpartWeekId),
            eq(schema.standbyAssignments.position, request.counterpartPosition),
          ),
        ),
      )
      .orderBy(asc(schema.standbyWeeks.weekStart), asc(schema.standbyAssignments.position))
      .for('update', { of: schema.standbyAssignments });
    const mine = places.find(
      (place) => place.weekId === request.requesterWeekId && place.position === request.requesterPosition,
    );
    const theirs = places.find(
      (place) => place.weekId === request.counterpartWeekId && place.position === request.counterpartPosition,
    );
    if (mine?.userId !== request.requesterId || theirs?.userId !== request.counterpartId) {
      return { ok: false, reason: 'assignment_changed' };
    }

    // 3. Exactly those two places, then the decision. A failure anywhere throws
    //    and the request's transaction rolls every statement back.
    for (const [place, next] of [
      [mine, request.counterpartId],
      [theirs, request.requesterId],
    ] as const) {
      await this.db
        .update(schema.standbyAssignments)
        .set({
          userId: next,
          assignedBy: decision.decidedBy,
          assignedAt: decision.decidedAt,
          updatedAt: sql`now()`,
          version: sql`${schema.standbyAssignments.version} + 1`,
        })
        .where(eq(schema.standbyAssignments.id, place.id));
    }
    const decided = await this.db
      .update(schema.standbySwapRequests)
      .set({
        status: 'approved',
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        decisionNote: decision.decisionNote,
        updatedAt: sql`now()`,
        version: sql`${schema.standbySwapRequests.version} + 1`,
      })
      .where(and(eq(schema.standbySwapRequests.id, decision.id), eq(schema.standbySwapRequests.status, 'pending')))
      .returning();
    if (decided[0] === undefined) throw new Error(`standby swap request ${decision.id} changed while locked`);
    return { ok: true, request: (await this.requests(decided))[0]! };
  }

  /* ---- STANDBY-DAY-1: day swaps ------------------------------------------- */

  private toDaySwap(row: typeof schema.standbyDaySwaps.$inferSelect): StandbyDaySwap {
    return {
      id: row.id,
      kind: row.kind as StandbySwapKind,
      requesterId: asUserId(row.requesterId),
      recipientId: asUserId(row.recipientId),
      pairs: row.pairs as unknown as StandbyDayPair[],
      reason: row.reason,
      status: row.status as StandbyDaySwapStatus,
      requestedAt: row.requestedAt,
      recipientDecidedAt: row.recipientDecidedAt,
      recipientNote: row.recipientNote,
      officeDecidedBy: optionalUser(row.officeDecidedBy),
      officeDecidedAt: row.officeDecidedAt,
      officeNote: row.officeNote,
      withdrawnAt: row.withdrawnAt,
    };
  }

  async listDayOverrides(from: IsoDate, to: IsoDate): Promise<readonly StandbyDayOverride[]> {
    const rows = await this.db
      .select()
      .from(schema.standbyDayOverrides)
      .where(between(schema.standbyDayOverrides.date, from, to))
      .orderBy(asc(schema.standbyDayOverrides.date));
    return rows.map((row) => ({
      date: row.date,
      position: row.position as StandbyPosition,
      userId: asUserId(row.userId),
      swapId: row.swapId,
      updatedAt: row.updatedAt,
    }));
  }

  async listDaySwaps(): Promise<readonly StandbyDaySwap[]> {
    const rows = await this.db.select().from(schema.standbyDaySwaps).orderBy(desc(schema.standbyDaySwaps.requestedAt));
    return rows.map((row) => this.toDaySwap(row));
  }

  async findDaySwap(id: string): Promise<StandbyDaySwap | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.select().from(schema.standbyDaySwaps).where(eq(schema.standbyDaySwaps.id, id)).limit(1);
    return rows[0] === undefined ? null : this.toDaySwap(rows[0]);
  }

  /** Every day-swap write takes this lock first, so no two can claim the same day at once. */
  private async lockDays(): Promise<void> {
    await this.db.execute(sql`select pg_advisory_xact_lock(hashtext('eje.standby.days'))`);
  }

  async createDaySwap(swap: StandbyDaySwap): Promise<StandbyDaySwap | null> {
    await this.lockDays();
    const active = await this.db
      .select({ pairs: schema.standbyDaySwaps.pairs })
      .from(schema.standbyDaySwaps)
      .where(inArray(schema.standbyDaySwaps.status, [...STANDBY_DAY_SWAP_ACTIVE]));
    const slots = (pairs: readonly { requesterDate: string; requesterPosition: string; recipientDate: string; recipientPosition: string }[]) =>
      pairs.flatMap((pair) => [`${pair.requesterDate}/${pair.requesterPosition}`, `${pair.recipientDate}/${pair.recipientPosition}`]);
    const claimed = new Set(active.flatMap((row) => slots(row.pairs)));
    if (slots(swap.pairs).some((slot) => claimed.has(slot))) return null;
    const rows = await this.db
      .insert(schema.standbyDaySwaps)
      .values({
        id: swap.id,
        kind: swap.kind,
        requesterId: swap.requesterId,
        recipientId: swap.recipientId,
        pairs: swap.pairs.map((pair) => ({ ...pair })),
        reason: swap.reason,
        status: 'awaiting_recipient',
        requestedAt: swap.requestedAt,
      })
      .returning();
    return this.toDaySwap(rows[0]!);
  }

  private async moveDaySwap(
    id: string,
    from: StandbyDaySwapStatus,
    set: Partial<typeof schema.standbyDaySwaps.$inferInsert>,
  ): Promise<StandbyDaySwap | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .update(schema.standbyDaySwaps)
      .set({ ...set, updatedAt: sql`now()`, version: sql`${schema.standbyDaySwaps.version} + 1` })
      .where(and(eq(schema.standbyDaySwaps.id, id), eq(schema.standbyDaySwaps.status, from)))
      .returning();
    return rows[0] === undefined ? null : this.toDaySwap(rows[0]);
  }

  answerDaySwap(id: string, answer: { readonly approved: boolean; readonly at: IsoDateTime; readonly note: string }): Promise<StandbyDaySwap | null> {
    return this.moveDaySwap(id, 'awaiting_recipient', {
      status: answer.approved ? 'awaiting_office' : 'denied',
      recipientDecidedAt: answer.at,
      recipientNote: answer.note,
    });
  }

  withdrawDaySwap(id: string, at: IsoDateTime): Promise<StandbyDaySwap | null> {
    return this.moveDaySwap(id, 'awaiting_recipient', { status: 'withdrawn', withdrawnAt: at });
  }

  rejectDaySwap(decision: StandbyDaySwapDecision): Promise<StandbyDaySwap | null> {
    return this.moveDaySwap(decision.id, 'awaiting_office', {
      status: 'rejected',
      officeDecidedBy: decision.by,
      officeDecidedAt: decision.at,
      officeNote: decision.note,
    });
  }

  async approveDaySwap(decision: StandbyDaySwapDecision, moves: readonly StandbyDayMove[]): Promise<StandbyDayApproval> {
    if (!isUuid(decision.id)) return { ok: false, reason: 'not_awaiting_office' };
    await this.lockDays();
    // 1. The swap, locked: a second approval waits here, then sees it decided.
    const locked = await this.db.select().from(schema.standbyDaySwaps).where(eq(schema.standbyDaySwaps.id, decision.id)).for('update');
    if (locked[0] === undefined || locked[0].status !== 'awaiting_office') return { ok: false, reason: 'not_awaiting_office' };

    // 2. The weeks those days are in, their places locked, and the days' overrides.
    const dates = [...new Set(moves.map((move) => move.date))].sort();
    const mondays = [...new Set(dates.map((date) => standbyWeekOfDate(date)))];
    const weekRows = mondays.length === 0 ? [] : await this.db.select().from(schema.standbyWeeks).where(inArray(schema.standbyWeeks.weekStart, mondays));
    const placeRows = weekRows.length === 0
      ? []
      : await this.db
          .select()
          .from(schema.standbyAssignments)
          .where(inArray(schema.standbyAssignments.weekId, weekRows.map((row) => row.id)))
          .orderBy(asc(schema.standbyAssignments.weekId), asc(schema.standbyAssignments.position))
          .for('update');
    const weeks = weekRows.map((row) => toWeek(row, placeRows.filter((place) => place.weekId === row.id)));
    const overrides = await this.listDayOverrides(dates[0] ?? '1970-01-01', dates[dates.length - 1] ?? '1970-01-01');
    for (const move of moves) {
      if (standbyHolderOn(move.date, move.position, weeks, overrides) !== move.expectedUserId) {
        return { ok: false, reason: 'assignment_changed' };
      }
    }

    // 3. Every day's override, then the decision. A refusal by the database
    //    (an ineligible person, two places on one day) throws, and the request's
    //    transaction rolls every statement back: all or nothing.
    for (const move of moves) {
      await this.db
        .insert(schema.standbyDayOverrides)
        .values({ id: crypto.randomUUID(), date: move.date, position: move.position, userId: move.userId, swapId: decision.id })
        .onConflictDoUpdate({
          target: [schema.standbyDayOverrides.date, schema.standbyDayOverrides.position],
          set: {
            userId: move.userId,
            swapId: decision.id,
            updatedAt: sql`now()`,
            version: sql`${schema.standbyDayOverrides.version} + 1`,
          },
        });
    }
    const after = await this.listDayOverrides(dates[0] ?? '1970-01-01', dates[dates.length - 1] ?? '1970-01-01');
    for (const date of dates) {
      const holders = STANDBY_POSITIONS.map((position) => standbyHolderOn(date, position, weeks, after)).filter((id) => id !== null);
      if (new Set(holders).size !== holders.length) throw new Error(`somebody would hold two standby places on ${date}`);
    }
    const decided = await this.moveDaySwap(decision.id, 'awaiting_office', {
      status: 'approved',
      officeDecidedBy: decision.by,
      officeDecidedAt: decision.at,
      officeNote: decision.note,
    });
    if (decided === null) throw new Error(`standby day swap ${decision.id} changed while locked`);
    return { ok: true, swap: decided };
  }
}
