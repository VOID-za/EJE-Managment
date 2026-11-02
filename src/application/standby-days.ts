import {
  STANDBY_DAY_SWAP_ACTIVE,
  STANDBY_DAY_SWAP_STATUS_LABELS,
  STANDBY_POSITIONS,
  STANDBY_POSITION_LABELS,
  STANDBY_SWAP_KIND_LABELS,
  addStandbyDays,
  asUserId,
  can,
  isFieldRole,
  isIsoDate,
  mayStandIn,
  standbyCategoryOf,
  standbyDaysOfWeek,
  standbyHolderOn,
  standbySwapKindOf,
  standbyWeekEnd,
  standbyWeekOf,
  userFullName,
  type IsoDate,
  type StandbyDayOverride,
  type StandbyDayPair,
  type StandbyDaySwap,
  type StandbyDaySwapStatus,
  type StandbyEligibility,
  type StandbyPosition,
  type StandbySwapKind,
  type StandbyWeek,
  type User,
  type UserId,
} from '@/domain';
import { businessDateOf } from '@/lib/business-time';
import type { StandbyDayMove } from '@/data/repositories';
import type { OperationContext } from './context';
import { audit, notify, notifyOffice } from './audit';
import { WorkflowError } from './errors';

/**
 * DAY SWAPS ON THE STANDBY CALENDAR. STANDBY-DAY-1 (2 November 2026).
 *
 * A swap exchanges ONLY the chosen days. JC holds the main place on Saturday
 * 7 November and Ruan on Saturday 14 November: when the swap is approved, JC
 * and Ruan exchange those two Saturdays and nothing else — every other day of
 * both weeks, every helper place and every unrelated apprentice place stay as
 * they were. A request may hold several date pairs; all of them change, or
 * none.
 *
 * TWO STAGES, in this order and no other:
 *   1. the requester chooses the pairs and the person; that person is told;
 *   2. the person asked APPROVES or DENIES — a denial ends it, nothing changes;
 *   3. on their approval the Office is told; the Office APPROVES or REJECTS;
 *   4. only the Office's approval exchanges the days, all of them at once.
 * Each stage re-checks every day: still held by the person named, still in a
 * published week, not yet past, nobody in two places on one day afterwards,
 * both people still eligible. A stale request is refused, never half-applied.
 * Neither person decides for the other; neither decides the Office's stage. The
 * requester may withdraw it until the person asked has answered.
 *
 * Main swaps stay main, apprentice swaps stay apprentice (apprentice 1 and 2
 * are the same kind of place); a helper's place is not swapped. Pending swaps
 * change nothing on the calendar; every request and every decision is kept.
 */
export const DAY_SWAP_MAX_PAIRS = 14;
export const DAY_SWAP_REASON_LIMIT = 1000;
export const DAY_SWAP_NOTE_LIMIT = 2000;
/** How far ahead the swap form offers days. */
const OPTIONS_WEEKS = 26;

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

const todayOf = (context: OperationContext): IsoDate => {
  const now = context.services.clock.now();
  return businessDateOf(now) ?? now.slice(0, 10);
};

const dayLabel = (date: IsoDate): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const pairLabel = (pair: StandbyDayPair): string =>
  `${dayLabel(pair.requesterDate)} (${STANDBY_POSITION_LABELS[pair.requesterPosition]}) ⇄ ${dayLabel(pair.recipientDate)} (${STANDBY_POSITION_LABELS[pair.recipientPosition]})`;

interface World {
  readonly users: ReadonlyMap<string, User>;
  readonly eligibility: ReadonlyMap<string, StandbyEligibility>;
  readonly weeks: readonly StandbyWeek[];
  readonly overrides: readonly StandbyDayOverride[];
}

/** Everything the rules read, for the days of these pairs. */
const loadWorld = async (context: OperationContext, dates: readonly IsoDate[]): Promise<World> => {
  const sorted = [...dates].sort();
  const from = sorted[0] ?? todayOf(context);
  const to = sorted[sorted.length - 1] ?? from;
  const [users, eligibility, weeks, overrides] = await Promise.all([
    context.repos.users.list(),
    context.repos.standby.listEligibility(),
    context.repos.standby.listWeeks(standbyWeekOf(from), standbyWeekOf(to)),
    context.repos.standby.listDayOverrides(from, to),
  ]);
  return {
    users: new Map(users.map((user) => [user.id as string, user])),
    eligibility: new Map(eligibility.map((record) => [record.userId as string, record])),
    weeks,
    overrides,
  };
};

const holder = (world: World, date: IsoDate, position: StandbyPosition): UserId | null =>
  standbyHolderOn(date, position, world.weeks, world.overrides);

const pairDates = (pairs: readonly StandbyDayPair[]): IsoDate[] => pairs.flatMap((pair) => [pair.requesterDate, pair.recipientDate]);

/** What exchanging these pairs would write: each day's place to the other person. */
const movesOf = (swap: Pick<StandbyDaySwap, 'pairs' | 'requesterId' | 'recipientId'>): StandbyDayMove[] =>
  swap.pairs.flatMap((pair) => [
    { date: pair.requesterDate, position: pair.requesterPosition, expectedUserId: swap.requesterId, userId: swap.recipientId },
    { date: pair.recipientDate, position: pair.recipientPosition, expectedUserId: swap.recipientId, userId: swap.requesterId },
  ]);

/**
 * Why these pairs cannot be exchanged as they stand, or null. Asked when the
 * request is made, when the person asked approves, and when the Office does.
 */
const daySwapProblem = (
  world: World,
  today: IsoDate,
  swap: Pick<StandbyDaySwap, 'kind' | 'pairs' | 'requesterId' | 'recipientId'>,
): { readonly code: string; readonly message: string } | null => {
  const requester = world.users.get(swap.requesterId);
  const recipient = world.users.get(swap.recipientId);
  const category = swap.kind === 'main' ? 'main' : 'apprentice';
  if (!mayStandIn(requester, world.eligibility.get(swap.requesterId), category)) {
    return { code: 'not_eligible', message: `${requester === undefined ? 'The requester' : userFullName(requester)} may not stand in a ${STANDBY_SWAP_KIND_LABELS[swap.kind].toLowerCase()} place.` };
  }
  if (!mayStandIn(recipient, world.eligibility.get(swap.recipientId), category)) {
    return { code: 'not_eligible', message: `${recipient === undefined ? 'That person' : userFullName(recipient)} may not stand in a ${STANDBY_SWAP_KIND_LABELS[swap.kind].toLowerCase()} place.` };
  }
  for (const pair of swap.pairs) {
    for (const [date, position, who, name] of [
      [pair.requesterDate, pair.requesterPosition, swap.requesterId, requester],
      [pair.recipientDate, pair.recipientPosition, swap.recipientId, recipient],
    ] as const) {
      if (date <= today) return { code: 'day_not_swappable', message: `${dayLabel(date)} has started or passed; only future days are swapped.` };
      const week = world.weeks.find((candidate) => candidate.weekStart === standbyWeekOf(date));
      if (week === undefined || week.status !== 'published') {
        return { code: 'day_not_swappable', message: `${dayLabel(date)} is not in a published standby week.` };
      }
      if (holder(world, date, position) !== who) {
        return {
          code: 'assignment_changed',
          message: `${name === undefined ? 'That person' : userFullName(name)} no longer holds the ${STANDBY_POSITION_LABELS[position]} place on ${dayLabel(date)}.`,
        };
      }
    }
  }
  // Nobody in two places on one day once every pair is exchanged.
  const moves = movesOf(swap);
  const after = [
    ...world.overrides.filter((existing) => !moves.some((move) => move.date === existing.date && move.position === existing.position)),
    ...moves.map((move) => ({ date: move.date, position: move.position, userId: move.userId, swapId: '', updatedAt: '' })),
  ];
  for (const date of new Set(moves.map((move) => move.date))) {
    const holders = STANDBY_POSITIONS.map((position) => standbyHolderOn(date, position, world.weeks, after)).filter((id) => id !== null);
    if (new Set(holders).size !== holders.length) {
      return { code: 'would_double_book', message: `That would put somebody in two standby places on ${dayLabel(date)}.` };
    }
  }
  return null;
};

/* ---- requesting ------------------------------------------------------------- */

export interface DaySwapInput {
  readonly recipientId: string;
  readonly kind: string;
  readonly pairs: readonly StandbyDayPair[];
  readonly reason?: string;
}

export const requestStandbyDaySwap = async (context: OperationContext, input: DaySwapInput): Promise<StandbyDaySwap> => {
  if (!can(context.actor.role, 'standby.requestSwap') || !isFieldRole(context.actor.role)) {
    throw refuse('Only a technician or an apprentice asks for a standby swap.', 'not_permitted', 'The office changes the calendar directly.');
  }
  const kind = input.kind as StandbySwapKind;
  if (kind !== 'main' && kind !== 'apprentice') throw refuse('That is not a kind of swap.', 'invalid_kind', 'Swap a main place or an apprentice place.');
  const reason = (input.reason ?? '').trim();
  if (reason.length > DAY_SWAP_REASON_LIMIT) throw refuse('That reason is too long.', 'reason_too_long', `At most ${DAY_SWAP_REASON_LIMIT} characters.`);
  if (input.recipientId === context.actor.id) throw refuse('You cannot swap with yourself.', 'same_person', 'Choose the other person.');
  if (input.pairs.length === 0) throw refuse('Choose at least one pair of days.', 'no_pairs', 'Add the day you give and the day you take.');
  if (input.pairs.length > DAY_SWAP_MAX_PAIRS) throw refuse('Too many days in one request.', 'too_many_pairs', `At most ${DAY_SWAP_MAX_PAIRS} pairs.`);
  const slots = new Set<string>();
  for (const pair of input.pairs) {
    if (!isIsoDate(pair.requesterDate) || !isIsoDate(pair.recipientDate)) throw refuse('That is not a date.', 'invalid_date', 'Give each day as YYYY-MM-DD.');
    for (const position of [pair.requesterPosition, pair.recipientPosition]) {
      if (!STANDBY_POSITIONS.includes(position) || standbySwapKindOf(position) !== kind) {
        throw refuse('Both days must be the same kind of place.', 'swap_kind_mismatch', `A ${STANDBY_SWAP_KIND_LABELS[kind].toLowerCase()} place is swapped only for another; a helper’s place is not swapped.`);
      }
    }
    if (pair.requesterDate === pair.recipientDate) throw refuse('A day is swapped for a different day.', 'same_day', 'Choose two different days.');
    for (const slot of [`${pair.requesterDate}/${pair.requesterPosition}`, `${pair.recipientDate}/${pair.recipientPosition}`]) {
      if (slots.has(slot)) throw refuse('The same day is in this request twice.', 'duplicate_day', 'Each day appears once.');
      slots.add(slot);
    }
  }
  const recipient = await context.repos.users.findById(asUserId(input.recipientId));
  if (recipient === null) throw refuse('That person does not exist.', 'user_not_found', 'Reload the list.');

  const swap: StandbyDaySwap = {
    id: context.services.ids.next('sdswap'),
    kind,
    requesterId: context.actor.id,
    recipientId: recipient.id,
    pairs: input.pairs.map((pair) => ({ ...pair })),
    reason,
    status: 'awaiting_recipient',
    requestedAt: context.services.clock.now(),
    recipientDecidedAt: null,
    recipientNote: '',
    officeDecidedBy: null,
    officeDecidedAt: null,
    officeNote: '',
    withdrawnAt: null,
  };
  const world = await loadWorld(context, pairDates(swap.pairs));
  for (const pair of swap.pairs) {
    if (holder(world, pair.requesterDate, pair.requesterPosition) !== context.actor.id) {
      throw refuse('That is not your standby day.', 'not_your_assignment', `You do not hold the ${STANDBY_POSITION_LABELS[pair.requesterPosition]} place on ${dayLabel(pair.requesterDate)}; you can offer only your own days.`);
    }
  }
  const problem = daySwapProblem(world, todayOf(context), swap);
  if (problem !== null) throw refuse('That swap cannot be asked for.', problem.code, problem.message);

  const created = await context.repos.standby.createDaySwap(swap);
  if (created === null) {
    throw refuse('One of those days is already in another swap.', 'swap_pending', 'Wait for that request to be decided or withdrawn.');
  }
  const asked = userFullName(context.actor);
  await audit(context, {
    jobId: null,
    type: 'standby_day_swap_requested',
    summary: `Standby day swap asked of ${userFullName(recipient)}`,
    detail: `${asked} asked ${userFullName(recipient)} to swap: ${created.pairs.map(pairLabel).join('; ')}.${reason.length > 0 ? ` Reason: ${reason}` : ''}`,
  });
  await notify(context, {
    recipientId: recipient.id,
    type: 'standby_day_swap_requested',
    title: `${asked} asked you to swap standby days`,
    body: `${created.pairs.map(pairLabel).join('; ')}. Approve or deny it on the standby calendar.`,
    link: '/standby?tab=requests',
  });
  return created;
};

/* ---- the person asked ------------------------------------------------------- */

export const answerStandbyDaySwap = async (
  context: OperationContext,
  id: string,
  input: { readonly approve: boolean; readonly note?: string },
): Promise<StandbyDaySwap> => {
  const swap = await context.repos.standby.findDaySwap(id);
  if (swap === null) throw refuse('That swap does not exist.', 'request_not_found', 'Reload the list.');
  if (swap.recipientId !== context.actor.id) {
    throw refuse('Only the person asked answers this swap.', 'not_recipient', 'Nobody answers a swap on somebody else’s behalf.');
  }
  if (swap.status !== 'awaiting_recipient') throw refuse('That swap has already been answered.', 'already_answered', STANDBY_DAY_SWAP_STATUS_LABELS[swap.status]);
  const note = (input.note ?? '').trim();
  if (note.length > DAY_SWAP_NOTE_LIMIT) throw refuse('That note is too long.', 'note_too_long', `At most ${DAY_SWAP_NOTE_LIMIT} characters.`);
  if (input.approve) {
    const problem = daySwapProblem(await loadWorld(context, pairDates(swap.pairs)), todayOf(context), swap);
    if (problem !== null) throw refuse('That swap can no longer be made.', problem.code, problem.message);
  }
  const answered = await context.repos.standby.answerDaySwap(id, { approved: input.approve, at: context.services.clock.now(), note });
  if (answered === null) throw refuse('That swap has already been answered.', 'already_answered', 'Reload the list.');
  const requester = await context.repos.users.findById(swap.requesterId);
  const me = userFullName(context.actor);
  await audit(context, {
    jobId: null,
    type: input.approve ? 'standby_day_swap_accepted' : 'standby_day_swap_denied',
    summary: input.approve ? 'Standby day swap approved by the person asked' : 'Standby day swap denied',
    detail: `${me} ${input.approve ? 'approved' : 'denied'} ${requester === null ? 'the' : `${userFullName(requester)}'s`} swap: ${swap.pairs.map(pairLabel).join('; ')}.${input.approve ? ' It now waits for the Office.' : ' Nothing on the calendar changed.'}${note.length > 0 ? ` Note: ${note}` : ''}`,
  });
  await notify(context, {
    recipientId: swap.requesterId,
    type: 'standby_day_swap_answered',
    title: input.approve ? `${me} approved your standby swap — now with the Office` : `${me} declined your standby swap`,
    body: `${swap.pairs.map(pairLabel).join('; ')}.${input.approve ? ' The days change only once the Office approves.' : ' Nothing on the calendar changed.'}`,
    link: '/standby?tab=requests',
  });
  if (input.approve) {
    await notifyOffice(context, {
      type: 'standby_day_swap_for_office',
      title: `Standby day swap to approve: ${requester === null ? 'a technician' : userFullName(requester)} and ${me}`,
      body: `${swap.pairs.map(pairLabel).join('; ')}. Both have agreed; approve or reject it.`,
      link: '/standby?tab=requests',
    });
  }
  return answered;
};

/* ---- the Office -------------------------------------------------------------- */

export const decideStandbyDaySwap = async (
  context: OperationContext,
  id: string,
  input: { readonly approve: boolean; readonly note?: string },
): Promise<StandbyDaySwap> => {
  if (!can(context.actor.role, 'standby.manage')) {
    throw refuse('Only the Office decides a standby swap.', 'not_permitted', 'A Senior Tech or the Office approves or rejects it.');
  }
  const swap = await context.repos.standby.findDaySwap(id);
  if (swap === null) throw refuse('That swap does not exist.', 'request_not_found', 'Reload the list.');
  if (swap.requesterId === context.actor.id || swap.recipientId === context.actor.id) {
    throw refuse('You are part of this swap.', 'own_request', 'Somebody else in the office decides it.');
  }
  if (swap.status !== 'awaiting_office') {
    throw refuse(
      swap.status === 'awaiting_recipient' ? 'The person asked has not answered yet.' : 'That swap has already been decided.',
      swap.status === 'awaiting_recipient' ? 'awaiting_recipient' : 'already_decided',
      STANDBY_DAY_SWAP_STATUS_LABELS[swap.status],
    );
  }
  const note = (input.note ?? '').trim();
  if (note.length > DAY_SWAP_NOTE_LIMIT) throw refuse('That note is too long.', 'note_too_long', `At most ${DAY_SWAP_NOTE_LIMIT} characters.`);
  const decision = { id, by: context.actor.id, at: context.services.clock.now(), note };
  let decided: StandbyDaySwap;
  if (input.approve) {
    const problem = daySwapProblem(await loadWorld(context, pairDates(swap.pairs)), todayOf(context), swap);
    if (problem !== null) throw refuse('That swap can no longer be made.', problem.code, `${problem.message} Reject it instead.`);
    const result = await context.repos.standby.approveDaySwap(decision, movesOf(swap));
    if (!result.ok) {
      throw result.reason === 'assignment_changed'
        ? refuse('A day in that swap has changed.', 'assignment_changed', 'Somebody else changed one of those days meanwhile. Reject it instead.')
        : refuse('That swap has already been decided.', 'already_decided', 'Reload the list.');
    }
    decided = result.swap;
  } else {
    const rejected = await context.repos.standby.rejectDaySwap(decision);
    if (rejected === null) throw refuse('That swap has already been decided.', 'already_decided', 'Reload the list.');
    decided = rejected;
  }
  const [requester, recipient] = await Promise.all([
    context.repos.users.findById(swap.requesterId),
    context.repos.users.findById(swap.recipientId),
  ]);
  const names = `${requester === null ? 'the requester' : userFullName(requester)} and ${recipient === null ? 'the person asked' : userFullName(recipient)}`;
  await audit(context, {
    jobId: null,
    type: input.approve ? 'standby_day_swap_approved' : 'standby_day_swap_rejected',
    summary: input.approve ? `Standby day swap approved: ${names}` : `Standby day swap rejected: ${names}`,
    detail: `${userFullName(context.actor)} ${input.approve ? 'approved' : 'rejected'} the swap between ${names}: ${swap.pairs.map(pairLabel).join('; ')}.${input.approve ? ' Only those days changed.' : ' Nothing on the calendar changed.'}${note.length > 0 ? ` Note: ${note}` : ''}`,
    changes: input.approve
      ? movesOf(swap).map((move) => ({
          field: `standby.${move.date}.${move.position}`,
          from: move.expectedUserId === swap.requesterId ? (requester === null ? move.expectedUserId : userFullName(requester)) : (recipient === null ? move.expectedUserId : userFullName(recipient)),
          to: move.userId === swap.requesterId ? (requester === null ? move.userId : userFullName(requester)) : (recipient === null ? move.userId : userFullName(recipient)),
        }))
      : undefined,
  });
  for (const person of [swap.requesterId, swap.recipientId]) {
    await notify(context, {
      recipientId: person,
      type: 'standby_day_swap_decided',
      title: input.approve ? 'The Office approved the standby swap' : 'The Office rejected the standby swap',
      body: `${swap.pairs.map(pairLabel).join('; ')}.${input.approve ? ' Only those days changed on the calendar.' : ' Nothing on the calendar changed.'}${note.length > 0 ? ` ${note}` : ''}`,
      link: '/standby?tab=requests',
    });
  }
  return decided;
};

export const withdrawStandbyDaySwap = async (context: OperationContext, id: string): Promise<StandbyDaySwap> => {
  const swap = await context.repos.standby.findDaySwap(id);
  if (swap === null) throw refuse('That swap does not exist.', 'request_not_found', 'Reload the list.');
  if (swap.requesterId !== context.actor.id) throw refuse('Only the person who asked withdraws a swap.', 'not_your_request', 'It is theirs to withdraw.');
  if (swap.status !== 'awaiting_recipient') {
    throw refuse('That swap can no longer be withdrawn.', 'not_withdrawable', `${STANDBY_DAY_SWAP_STATUS_LABELS[swap.status]}. A swap is withdrawn only before the person asked answers.`);
  }
  const withdrawn = await context.repos.standby.withdrawDaySwap(id, context.services.clock.now());
  if (withdrawn === null) throw refuse('That swap can no longer be withdrawn.', 'not_withdrawable', 'Reload the list.');
  await audit(context, {
    jobId: null,
    type: 'standby_day_swap_withdrawn',
    summary: 'Standby day swap withdrawn',
    detail: `${userFullName(context.actor)} withdrew the swap: ${swap.pairs.map(pairLabel).join('; ')}. Nothing on the calendar changed.`,
  });
  return withdrawn;
};

/* ---- reading ------------------------------------------------------------------ */

export interface DaySwapView extends StandbyDaySwap {
  readonly requesterName: string;
  readonly recipientName: string;
  readonly officeDecidedByName: string | null;
  readonly kindLabel: string;
  readonly statusLabel: string;
  readonly pairLabels: readonly string[];
  /** Whether it could still be made as it stands (active swaps only). */
  readonly stillValid: boolean;
  readonly canAnswer: boolean;
  readonly canDecide: boolean;
  readonly canWithdraw: boolean;
}

/** Day swaps: every one for the Office; only one's own for anybody else. Newest first. */
export const listStandbyDaySwaps = async (context: OperationContext): Promise<readonly DaySwapView[]> => {
  if (!can(context.actor.role, 'standby.view')) throw refuse('You cannot view the standby calendar.', 'not_permitted', 'Standby is visible to staff only.');
  const office = can(context.actor.role, 'standby.manage');
  const all = await context.repos.standby.listDaySwaps();
  const visible = all.filter((swap) => office || swap.requesterId === context.actor.id || swap.recipientId === context.actor.id);
  const active = visible.filter((swap) => STANDBY_DAY_SWAP_ACTIVE.includes(swap.status));
  const world = await loadWorld(context, active.flatMap((swap) => pairDates(swap.pairs)));
  const today = todayOf(context);
  const name = (id: UserId | null): string => {
    if (id === null) return '';
    const user = world.users.get(id);
    return user === undefined ? 'Unknown person' : userFullName(user);
  };
  return visible.map((swap) => {
    const live = STANDBY_DAY_SWAP_ACTIVE.includes(swap.status);
    const stillValid = live && daySwapProblem(world, today, swap) === null;
    return {
      ...swap,
      requesterName: name(swap.requesterId),
      recipientName: name(swap.recipientId),
      officeDecidedByName: swap.officeDecidedBy === null ? null : name(swap.officeDecidedBy),
      kindLabel: STANDBY_SWAP_KIND_LABELS[swap.kind],
      statusLabel: STANDBY_DAY_SWAP_STATUS_LABELS[swap.status],
      pairLabels: swap.pairs.map(pairLabel),
      stillValid,
      canAnswer: swap.status === 'awaiting_recipient' && swap.recipientId === context.actor.id,
      canDecide: swap.status === 'awaiting_office' && office && swap.requesterId !== context.actor.id && swap.recipientId !== context.actor.id,
      canWithdraw: swap.status === 'awaiting_recipient' && swap.requesterId === context.actor.id,
    };
  });
};

export interface StandbyDayOption {
  readonly date: IsoDate;
  readonly position: StandbyPosition;
  readonly label: string;
  readonly kind: StandbySwapKind;
}

export interface StandbyDayOptions {
  readonly mine: readonly StandbyDayOption[];
  readonly people: readonly { readonly userId: UserId; readonly name: string; readonly days: readonly StandbyDayOption[] }[];
}

/**
 * What the swap form offers: my own future standby days of a swappable kind,
 * and every other eligible person's days of the same kinds — none already in
 * an active swap.
 */
export const loadStandbyDayOptions = async (context: OperationContext): Promise<StandbyDayOptions> => {
  if (!can(context.actor.role, 'standby.requestSwap')) return { mine: [], people: [] };
  const today = todayOf(context);
  const from = addStandbyDays(today, 1);
  const to = addStandbyDays(standbyWeekOf(today), OPTIONS_WEEKS * 7 - 1);
  const [users, eligibility, weeks, overrides, swaps] = await Promise.all([
    context.repos.users.list(),
    context.repos.standby.listEligibility(),
    context.repos.standby.listWeeks(standbyWeekOf(from), standbyWeekOf(to)),
    context.repos.standby.listDayOverrides(from, to),
    context.repos.standby.listDaySwaps(),
  ]);
  const claimed = new Set(
    swaps
      .filter((swap) => STANDBY_DAY_SWAP_ACTIVE.includes(swap.status))
      .flatMap((swap) => swap.pairs.flatMap((pair) => [`${pair.requesterDate}/${pair.requesterPosition}`, `${pair.recipientDate}/${pair.recipientPosition}`])),
  );
  const held = new Map<string, StandbyDayOption[]>();
  for (const week of weeks.filter((candidate) => candidate.status === 'published')) {
    for (const date of standbyDaysOfWeek(week.weekStart)) {
      if (date < from || date > to) continue;
      for (const position of STANDBY_POSITIONS) {
        const kind = standbySwapKindOf(position);
        if (kind === null || claimed.has(`${date}/${position}`)) continue;
        const who = standbyHolderOn(date, position, weeks, overrides);
        if (who === null) continue;
        const list = held.get(who) ?? [];
        list.push({ date, position, label: `${dayLabel(date)} — ${STANDBY_POSITION_LABELS[position]}`, kind });
        held.set(who, list);
      }
    }
  }
  const mine = held.get(context.actor.id) ?? [];
  const kinds = new Set(mine.map((option) => option.kind));
  const eligibilityOf = new Map(eligibility.map((record) => [record.userId as string, record]));
  const people = users
    .filter((user) => user.id !== context.actor.id)
    .map((user) => ({
      userId: user.id,
      name: userFullName(user),
      days: (held.get(user.id) ?? []).filter(
        (option) => kinds.has(option.kind) && mayStandIn(user, eligibilityOf.get(user.id), standbyCategoryOf(option.position)),
      ),
    }))
    .filter((person) => person.days.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { mine, people };
};

/* ---- the Overview's block ----------------------------------------------------- */

export interface CurrentStandbyWeek {
  readonly weekStart: IsoDate;
  readonly weekEnd: IsoDate;
  /** False when this week has no PUBLISHED schedule — nothing is shown from a draft. */
  readonly published: boolean;
  readonly places: readonly { readonly position: StandbyPosition; readonly label: string; readonly name: string | null }[];
  /** Days this week whose place an approved day swap moved. */
  readonly dayChanges: readonly { readonly date: IsoDate; readonly label: string; readonly position: StandbyPosition; readonly name: string }[];
}

/**
 * THE CURRENT WEEK'S STANDBY, FOR THE OVERVIEW. STANDBY-DASH-1 (2 November
 * 2026). From the published schedule only — a draft is never shown, to anyone,
 * here — with the days an approved day swap moved. No separate data source.
 */
export const loadCurrentStandbyWeek = async (context: OperationContext): Promise<CurrentStandbyWeek> => {
  if (!can(context.actor.role, 'standby.view')) throw refuse('You cannot view the standby calendar.', 'not_permitted', 'Standby is visible to staff only.');
  const weekStart = standbyWeekOf(todayOf(context));
  const weekEnd = standbyWeekEnd(weekStart);
  const [week, overrides, users] = await Promise.all([
    context.repos.standby.findWeek(weekStart),
    context.repos.standby.listDayOverrides(weekStart, weekEnd),
    context.repos.users.list(),
  ]);
  const published = week !== null && week.status === 'published';
  const name = (id: UserId | null): string | null => {
    if (id === null) return null;
    const user = users.find((candidate) => candidate.id === id);
    return user === undefined ? 'Unknown person' : userFullName(user);
  };
  return {
    weekStart,
    weekEnd,
    published,
    places: STANDBY_POSITIONS.map((position) => ({
      position,
      label: STANDBY_POSITION_LABELS[position],
      name: published ? name(week.assignments.find((place) => place.position === position)?.userId ?? null) : null,
    })),
    dayChanges: published
      ? overrides.map((override) => ({
          date: override.date,
          label: dayLabel(override.date),
          position: override.position,
          name: name(override.userId) ?? 'Unknown person',
        }))
      : [],
  };
};

export type { StandbyDaySwapStatus };
