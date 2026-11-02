import {
  mayStandIn,
  standbyCategoryOf,
  type IsoDate,
  type IsoDateTime,
  type StandbyEligibility,
  type StandbyPosition,
  type StandbySwapRequest,
  type StandbyDayOverride,
  type StandbyDaySwap,
  STANDBY_DAY_SWAP_ACTIVE,
  standbyHolderOn,
  type StandbyWeek,
  type UserId,
} from '@/domain';
import type {
  StandbyApproval,
  StandbyDayApproval,
  StandbyDayMove,
  StandbyDaySwapDecision,
  StandbyRepository,
  StandbySwapDecision,
} from '../repositories';
import type { DemoContext } from './repositories';
import type { DemoDatabase } from './store';

/**
 * The standby calendar in the demonstration store. STANDBY-1…8.
 *
 * It refuses what migration 0045 refuses — a person in two places of one week,
 * a place given to somebody who may not stand in it, a place offered in two
 * pending requests, a decided request changed — so the demonstration cannot
 * show something the real database would not allow. Each write is ONE
 * synchronous commit, which is what makes an approval all-or-nothing here.
 */
const holder = (week: StandbyWeek | undefined, position: StandbyPosition): UserId | null =>
  week?.assignments.find((place) => place.position === position)?.userId ?? null;

const assertMayHold = (draft: DemoDatabase, week: StandbyWeek, position: StandbyPosition, userId: UserId) => {
  const user = draft.users.find((candidate) => candidate.id === userId);
  const eligibility = draft.standbyEligibility.find((record) => record.userId === userId);
  if (!mayStandIn(user, eligibility, standbyCategoryOf(position))) {
    throw new Error(`only an active technician eligible for the ${position} place can stand in it`);
  }
  if (week.assignments.some((place) => place.position !== position && place.userId === userId)) {
    throw new Error(`${userId} already holds a place in the standby week of ${week.weekStart}`);
  }
};

export class DemoStandbyRepository implements StandbyRepository {
  constructor(private readonly context: DemoContext) {}

  listEligibility(): Promise<readonly StandbyEligibility[]> {
    return Promise.resolve(this.context.read().standbyEligibility);
  }

  saveEligibility(record: StandbyEligibility): Promise<StandbyEligibility> {
    if (record.apprentice && (record.main || record.helper)) {
      throw new Error('an apprentice is not also eligible for a technician place');
    }
    this.context.commit((draft) => {
      draft.standbyEligibility = [
        ...draft.standbyEligibility.filter((existing) => existing.userId !== record.userId),
        record,
      ];
    });
    return Promise.resolve(record);
  }

  listWeeks(from: IsoDate, to: IsoDate): Promise<readonly StandbyWeek[]> {
    return Promise.resolve(
      this.context
        .read()
        .standbyWeeks.filter((week) => week.weekStart >= from && week.weekStart <= to)
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
    );
  }

  findWeek(weekStart: IsoDate): Promise<StandbyWeek | null> {
    return Promise.resolve(this.context.read().standbyWeeks.find((week) => week.weekStart === weekStart) ?? null);
  }

  createWeeks(weeks: readonly StandbyWeek[]): Promise<readonly IsoDate[]> {
    const added: IsoDate[] = [];
    this.context.commit((draft) => {
      for (const week of weeks) {
        if (draft.standbyWeeks.some((existing) => existing.weekStart === week.weekStart)) continue;
        const fresh: StandbyWeek = { ...week, status: 'draft', publishedBy: null, publishedAt: null };
        for (const place of fresh.assignments) {
          if (place.userId !== null) assertMayHold(draft, fresh, place.position, place.userId);
        }
        draft.standbyWeeks = [...draft.standbyWeeks, fresh];
        added.push(week.weekStart);
      }
    });
    return Promise.resolve(added);
  }

  setAssignment(change: {
    readonly weekStart: IsoDate;
    readonly position: StandbyPosition;
    readonly expectedUserId: UserId | null;
    readonly userId: UserId | null;
    readonly assignedBy: UserId;
    readonly assignedAt: IsoDateTime;
  }): Promise<boolean> {
    let changed = false;
    this.context.commit((draft) => {
      const week = draft.standbyWeeks.find((candidate) => candidate.weekStart === change.weekStart);
      if (week === undefined || holder(week, change.position) !== change.expectedUserId) return;
      if (change.userId !== null && change.userId !== change.expectedUserId) {
        assertMayHold(draft, week, change.position, change.userId);
      }
      const next: StandbyWeek = {
        ...week,
        assignments: week.assignments.map((place) =>
          place.position === change.position
            ? { ...place, userId: change.userId, assignedBy: change.assignedBy, assignedAt: change.assignedAt }
            : place,
        ),
      };
      draft.standbyWeeks = draft.standbyWeeks.map((candidate) => (candidate === week ? next : candidate));
      changed = true;
    });
    return Promise.resolve(changed);
  }

  publishWeeks(weekStarts: readonly IsoDate[], by: UserId, at: IsoDateTime): Promise<readonly IsoDate[]> {
    const published: IsoDate[] = [];
    const wanted = new Set(weekStarts);
    this.context.commit((draft) => {
      draft.standbyWeeks = draft.standbyWeeks.map((week) => {
        if (!wanted.has(week.weekStart) || week.status !== 'draft') return week;
        published.push(week.weekStart);
        return { ...week, status: 'published', publishedBy: by, publishedAt: at };
      });
    });
    return Promise.resolve(published.sort());
  }

  listSwapRequests(): Promise<readonly StandbySwapRequest[]> {
    return Promise.resolve(
      [...this.context.read().standbySwapRequests].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    );
  }

  findSwapRequest(id: string): Promise<StandbySwapRequest | null> {
    return Promise.resolve(this.context.read().standbySwapRequests.find((request) => request.id === id) ?? null);
  }

  createSwapRequest(request: StandbySwapRequest): Promise<StandbySwapRequest | null> {
    let saved: StandbySwapRequest | null = null;
    this.context.commit((draft) => {
      const weekOf = (monday: IsoDate) => draft.standbyWeeks.find((week) => week.weekStart === monday);
      if (
        holder(weekOf(request.requesterWeekStart), request.requesterPosition) !== request.requesterId ||
        holder(weekOf(request.counterpartWeekStart), request.counterpartPosition) !== request.counterpartId
      ) {
        throw new Error('a standby swap names two places the two people actually hold');
      }
      const clash = draft.standbySwapRequests.some(
        (existing) =>
          existing.status === 'pending' &&
          ((existing.requesterWeekStart === request.requesterWeekStart &&
            existing.requesterPosition === request.requesterPosition) ||
            (existing.counterpartWeekStart === request.counterpartWeekStart &&
              existing.counterpartPosition === request.counterpartPosition)),
      );
      if (clash) return;
      saved = { ...request, status: 'pending', decidedBy: null, decidedAt: null, decisionNote: '', cancelledAt: null };
      draft.standbySwapRequests = [...draft.standbySwapRequests, saved];
    });
    return Promise.resolve(saved);
  }

  private finish(id: string, outcome: (request: StandbySwapRequest) => StandbySwapRequest): StandbySwapRequest | null {
    let saved: StandbySwapRequest | null = null;
    this.context.commit((draft) => {
      const existing = draft.standbySwapRequests.find((request) => request.id === id);
      if (existing === undefined || existing.status !== 'pending') return;
      saved = outcome(existing);
      draft.standbySwapRequests = draft.standbySwapRequests.map((request) => (request === existing ? saved! : request));
    });
    return saved;
  }

  rejectSwapRequest(decision: StandbySwapDecision): Promise<StandbySwapRequest | null> {
    return Promise.resolve(
      this.finish(decision.id, (request) => {
        if (request.requesterId === decision.decidedBy) throw new Error('a swap is decided by somebody other than who asked');
        return { ...request, status: 'rejected', decidedBy: decision.decidedBy, decidedAt: decision.decidedAt, decisionNote: decision.decisionNote };
      }),
    );
  }

  cancelSwapRequest(id: string, at: IsoDateTime): Promise<StandbySwapRequest | null> {
    return Promise.resolve(this.finish(id, (request) => ({ ...request, status: 'cancelled', cancelledAt: at })));
  }

  approveSwapRequest(decision: StandbySwapDecision): Promise<StandbyApproval> {
    let result: StandbyApproval = { ok: false, reason: 'not_pending' };
    this.context.commit((draft) => {
      const request = draft.standbySwapRequests.find((candidate) => candidate.id === decision.id);
      if (request === undefined || request.status !== 'pending') return;
      if (request.requesterId === decision.decidedBy) throw new Error('a swap is decided by somebody other than who asked');
      const mine = draft.standbyWeeks.find((week) => week.weekStart === request.requesterWeekStart);
      const theirs = draft.standbyWeeks.find((week) => week.weekStart === request.counterpartWeekStart);
      if (
        mine === undefined ||
        theirs === undefined ||
        holder(mine, request.requesterPosition) !== request.requesterId ||
        holder(theirs, request.counterpartPosition) !== request.counterpartId
      ) {
        result = { ok: false, reason: 'assignment_changed' };
        return;
      }
      // Everything is checked before anything is written, so this commit is all or nothing.
      assertMayHold(draft, mine, request.requesterPosition, request.counterpartId);
      assertMayHold(draft, theirs, request.counterpartPosition, request.requesterId);
      const place = (week: StandbyWeek, position: StandbyPosition, userId: UserId): StandbyWeek => ({
        ...week,
        assignments: week.assignments.map((candidate) =>
          candidate.position === position
            ? { ...candidate, userId, assignedBy: decision.decidedBy, assignedAt: decision.decidedAt }
            : candidate,
        ),
      });
      const nextMine = place(mine, request.requesterPosition, request.counterpartId);
      const nextTheirs = place(theirs, request.counterpartPosition, request.requesterId);
      const approved: StandbySwapRequest = {
        ...request,
        status: 'approved',
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        decisionNote: decision.decisionNote,
      };
      draft.standbyWeeks = draft.standbyWeeks.map((week) =>
        week === mine ? nextMine : week === theirs ? nextTheirs : week,
      );
      draft.standbySwapRequests = draft.standbySwapRequests.map((candidate) =>
        candidate === request ? approved : candidate,
      );
      result = { ok: true, request: approved };
    });
    return Promise.resolve(result);
  }

  /* ---- STANDBY-DAY-1: day swaps ------------------------------------------- */

  listDayOverrides(from: IsoDate, to: IsoDate): Promise<readonly StandbyDayOverride[]> {
    return Promise.resolve(this.context.read().standbyDayOverrides.filter((o) => o.date >= from && o.date <= to));
  }

  listDaySwaps(): Promise<readonly StandbyDaySwap[]> {
    return Promise.resolve([...this.context.read().standbyDaySwaps].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)));
  }

  findDaySwap(id: string): Promise<StandbyDaySwap | null> {
    return Promise.resolve(this.context.read().standbyDaySwaps.find((swap) => swap.id === id) ?? null);
  }

  createDaySwap(swap: StandbyDaySwap): Promise<StandbyDaySwap | null> {
    let created: StandbyDaySwap | null = null;
    this.context.commit((draft) => {
      const slots = (candidate: StandbyDaySwap) =>
        candidate.pairs.flatMap((pair) => [`${pair.requesterDate}/${pair.requesterPosition}`, `${pair.recipientDate}/${pair.recipientPosition}`]);
      const claimed = new Set(draft.standbyDaySwaps.filter((other) => STANDBY_DAY_SWAP_ACTIVE.includes(other.status)).flatMap(slots));
      if (slots(swap).some((slot) => claimed.has(slot))) return;
      draft.standbyDaySwaps = [...draft.standbyDaySwaps, swap];
      created = swap;
    });
    return Promise.resolve(created);
  }

  private moveDaySwap(id: string, from: StandbyDaySwap['status'], change: (swap: StandbyDaySwap) => StandbyDaySwap): StandbyDaySwap | null {
    let changed: StandbyDaySwap | null = null;
    this.context.commit((draft) => {
      const swap = draft.standbyDaySwaps.find((candidate) => candidate.id === id);
      if (swap === undefined || swap.status !== from) return;
      const next = change(swap);
      draft.standbyDaySwaps = draft.standbyDaySwaps.map((candidate) => (candidate === swap ? next : candidate));
      changed = next;
    });
    return changed;
  }

  answerDaySwap(id: string, answer: { readonly approved: boolean; readonly at: IsoDateTime; readonly note: string }): Promise<StandbyDaySwap | null> {
    return Promise.resolve(
      this.moveDaySwap(id, 'awaiting_recipient', (swap) => ({
        ...swap,
        status: answer.approved ? 'awaiting_office' : 'denied',
        recipientDecidedAt: answer.at,
        recipientNote: answer.note,
      })),
    );
  }

  withdrawDaySwap(id: string, at: IsoDateTime): Promise<StandbyDaySwap | null> {
    return Promise.resolve(this.moveDaySwap(id, 'awaiting_recipient', (swap) => ({ ...swap, status: 'withdrawn', withdrawnAt: at })));
  }

  rejectDaySwap(decision: StandbyDaySwapDecision): Promise<StandbyDaySwap | null> {
    return Promise.resolve(
      this.moveDaySwap(decision.id, 'awaiting_office', (swap) => ({
        ...swap,
        status: 'rejected',
        officeDecidedBy: decision.by,
        officeDecidedAt: decision.at,
        officeNote: decision.note,
      })),
    );
  }

  approveDaySwap(decision: StandbyDaySwapDecision, moves: readonly StandbyDayMove[]): Promise<StandbyDayApproval> {
    let result: StandbyDayApproval = { ok: false, reason: 'not_awaiting_office' };
    this.context.commit((draft) => {
      const swap = draft.standbyDaySwaps.find((candidate) => candidate.id === decision.id);
      if (swap === undefined || swap.status !== 'awaiting_office') return;
      if (decision.by === swap.requesterId || decision.by === swap.recipientId) throw new Error('a day swap is approved by the Office, not by either person in it');
      // Every place is checked before anything is written: all or nothing.
      for (const move of moves) {
        if (standbyHolderOn(move.date, move.position, draft.standbyWeeks, draft.standbyDayOverrides) !== move.expectedUserId) {
          result = { ok: false, reason: 'assignment_changed' };
          return;
        }
        const user = draft.users.find((candidate) => candidate.id === move.userId);
        const eligibility = draft.standbyEligibility.find((record) => record.userId === move.userId);
        if (!mayStandIn(user, eligibility, standbyCategoryOf(move.position))) {
          throw new Error(`only an active technician or apprentice eligible for the ${move.position} place can stand in it`);
        }
      }
      const written: StandbyDayOverride[] = moves.map((move) => ({ date: move.date, position: move.position, userId: move.userId, swapId: swap.id, updatedAt: decision.at }));
      const overrides = [
        ...draft.standbyDayOverrides.filter((existing) => !moves.some((move) => move.date === existing.date && move.position === existing.position)),
        ...written,
      ];
      // Nobody in two places on one day, once the days are exchanged.
      for (const date of new Set(moves.map((move) => move.date))) {
        const holders = (['main', 'helper', 'apprentice_1', 'apprentice_2'] as const)
          .map((position) => standbyHolderOn(date, position, draft.standbyWeeks, overrides))
          .filter((id) => id !== null);
        if (new Set(holders).size !== holders.length) throw new Error(`somebody would hold two standby places on ${date}`);
      }
      const approved: StandbyDaySwap = { ...swap, status: 'approved', officeDecidedBy: decision.by, officeDecidedAt: decision.at, officeNote: decision.note };
      draft.standbyDayOverrides = overrides;
      draft.standbyDaySwaps = draft.standbyDaySwaps.map((candidate) => (candidate === swap ? approved : candidate));
      result = { ok: true, swap: approved };
    });
    return Promise.resolve(result);
  }
}
