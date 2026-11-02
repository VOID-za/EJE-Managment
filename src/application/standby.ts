import { isFieldRole } from '@/domain';
import {
  STANDBY_POSITIONS,
  STANDBY_POSITION_LABELS,
  STANDBY_SWAP_KIND_LABELS,
  addStandbyDays,
  asUserId,
  can,
  isIsoDate,
  isMonday,
  isStandbyPosition,
  mayStandIn,
  standbyCategoryOf,
  standbyPlanningLimit,
  standbySwapKindOf,
  standbyWeekEnd,
  standbyWeekProblems,
  standbyWeekTiming,
  standbyWeeksOfYear,
  userFullName,
  type FieldChange,
  type IsoDate,
  type StandbyEligibility,
  type StandbyPosition,
  type StandbyProblem,
  type StandbySwapKind,
  type StandbySwapRequest,
  type StandbyWeek,
  type StandbyWeekStatus,
  type StandbyWeekTiming,
  type User,
  type UserId,
} from '@/domain';
import { businessDateOf } from '@/lib/business-time';
import type { OperationContext } from './context';
import { audit, notify, notifyOffice } from './audit';
import { WorkflowError } from './errors';

/**
 * THE STANDBY CALENDAR. STANDBY-1…8 (the owner, 2 November 2026).
 *
 * Every rule is here, on the server; the screens only offer what this allows.
 *
 *   READ (everybody, `standby.view`). A technician sees PUBLISHED weeks only;
 *     the office also sees drafts and the warnings on each week.
 *   ADMINISTER (the office, `standby.manage`). Who may stand in which place;
 *     generating a year's weeks (filling only EMPTY places of DRAFT weeks, from
 *     an order the office itself enters — nothing is invented, nothing that
 *     exists is overwritten, a published week is never touched); changing one
 *     place (a reason is required once a week is published, and a change to
 *     the week in progress is an EMERGENCY change); publishing.
 *   SWAP (a technician, `standby.requestSwap`). Offer ONE place they hold — the
 *     main place, or an apprentice place — in exchange for the same kind of
 *     place another eligible person holds in another week. Nothing changes
 *     until the office approves; approval re-checks everything and exchanges
 *     exactly those two places, all or nothing.
 *
 * A week that has ended is history: nothing here changes it. Every change is
 * audited; everyone affected by a published change is told in-app.
 */

export const STANDBY_REASON_LIMIT = 1000;
export const STANDBY_NOTE_LIMIT = 2000;

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

const todayOf = (context: OperationContext): IsoDate => {
  const now = context.services.clock.now();
  return businessDateOf(now) ?? now.slice(0, 10);
};

const assertManages = (context: OperationContext): void => {
  if (can(context.actor.role, 'standby.manage')) return;
  throw refuse(
    'Only the office can change the standby calendar.',
    'not_permitted',
    'A Senior Tech or the Office administers standby. A technician asks for a swap instead.',
  );
};

const assertViews = (context: OperationContext): void => {
  if (can(context.actor.role, 'standby.view')) return;
  throw refuse('You cannot view the standby calendar.', 'not_permitted', 'Standby is visible to staff only.');
};

const describeWeek = (weekStart: IsoDate): string => `week of ${weekStart}`;

/* ---- views ---------------------------------------------------------------- */

export interface StandbyPlaceView {
  readonly position: StandbyPosition;
  readonly label: string;
  readonly userId: UserId | null;
  readonly name: string | null;
}

export interface StandbyWeekView {
  readonly weekStart: IsoDate;
  readonly weekEnd: IsoDate;
  readonly status: StandbyWeekStatus;
  readonly timing: StandbyWeekTiming;
  readonly places: readonly StandbyPlaceView[];
  /** The office's warnings. Always empty for a technician. */
  readonly problems: readonly StandbyProblem[];
  /** Pending swap requests that involve a place in this week. */
  readonly pendingSwaps: number;
}

export interface StandbyPerson {
  readonly id: UserId;
  readonly name: string;
  readonly active: boolean;
  readonly main: boolean;
  readonly helper: boolean;
  readonly apprentice: boolean;
}

export interface StandbyMyPlace {
  readonly weekStart: IsoDate;
  readonly weekEnd: IsoDate;
  readonly position: StandbyPosition;
  readonly label: string;
  /** Null for a helper's place, which the swap workflow does not exchange. */
  readonly swapKind: StandbySwapKind | null;
}

export interface StandbyCalendar {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly today: IsoDate;
  readonly planningLimit: IsoDate;
  readonly weeks: readonly StandbyWeekView[];
  readonly people: readonly StandbyPerson[];
  /** The signed-in person's own published places from this week on. */
  readonly mine: readonly StandbyMyPlace[];
  readonly canManage: boolean;
  readonly canRequestSwap: boolean;
}

export interface StandbySwapView extends StandbySwapRequest {
  readonly requesterName: string;
  readonly counterpartName: string;
  readonly decidedByName: string | null;
  readonly kindLabel: string;
  /**
   * For a pending request: whether approving it would still work — both places
   * held by the people it names, both weeks published and not yet started.
   * False tells the office it can only be rejected.
   */
  readonly stillValid: boolean;
}

interface Directory {
  readonly users: ReadonlyMap<string, User>;
  readonly eligibility: ReadonlyMap<string, StandbyEligibility>;
}

const loadDirectory = async (context: OperationContext): Promise<Directory> => {
  const [users, eligibility] = await Promise.all([
    context.repos.users.list(),
    context.repos.standby.listEligibility(),
  ]);
  return {
    users: new Map(users.map((user) => [user.id as string, user])),
    eligibility: new Map(eligibility.map((record) => [record.userId as string, record])),
  };
};

const nameOf = (directory: Directory, id: UserId | null): string | null => {
  if (id === null) return null;
  const user = directory.users.get(id);
  return user === undefined ? 'Unknown person' : userFullName(user);
};

const holderOf = (week: StandbyWeek | null, position: StandbyPosition): UserId | null =>
  week?.assignments.find((place) => place.position === position)?.userId ?? null;

const involves = (request: StandbySwapRequest, weekStart: IsoDate, position?: StandbyPosition): boolean =>
  (request.requesterWeekStart === weekStart && (position === undefined || request.requesterPosition === position)) ||
  (request.counterpartWeekStart === weekStart && (position === undefined || request.counterpartPosition === position));

const weekView = (
  week: StandbyWeek,
  directory: Directory,
  today: IsoDate,
  pending: readonly StandbySwapRequest[],
  office: boolean,
): StandbyWeekView => ({
  weekStart: week.weekStart,
  weekEnd: standbyWeekEnd(week.weekStart),
  status: week.status,
  timing: standbyWeekTiming(week.weekStart, today),
  places: STANDBY_POSITIONS.map((position) => {
    const userId = holderOf(week, position);
    return { position, label: STANDBY_POSITION_LABELS[position], userId, name: nameOf(directory, userId) };
  }),
  problems: office ? standbyWeekProblems(week, directory.users, directory.eligibility) : [],
  pendingSwaps: pending.filter((request) => involves(request, week.weekStart)).length,
});

/** The standby calendar between two dates (weeks whose Monday falls in it). */
export const loadStandbyCalendar = async (
  context: OperationContext,
  from: string,
  to: string,
): Promise<StandbyCalendar> => {
  assertViews(context);
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) {
    throw refuse('That is not a date range.', 'invalid_date', 'Give both days as YYYY-MM-DD, the second not before the first.');
  }
  if (Date.parse(to) - Date.parse(from) > 400 * 86_400_000) {
    throw refuse('That range is too long.', 'range_too_long', 'Ask for at most a year at a time.');
  }
  const office = can(context.actor.role, 'standby.manage');
  const today = todayOf(context);
  const directory = await loadDirectory(context);
  const [weeks, requests, upcoming] = await Promise.all([
    context.repos.standby.listWeeks(from, to),
    context.repos.standby.listSwapRequests(),
    context.repos.standby.listWeeks(addStandbyDays(today, -6), standbyPlanningLimit(today)),
  ]);
  const pending = requests.filter((request) => request.status === 'pending');
  const visible = weeks.filter((week) => office || week.status === 'published');

  const shown = new Set<string>();
  for (const week of visible) for (const place of week.assignments) if (place.userId !== null) shown.add(place.userId);
  const people: StandbyPerson[] = [...directory.users.values()]
    .filter((user) => {
      const record = directory.eligibility.get(user.id);
      const eligible = record !== undefined && (record.main || record.helper || record.apprentice);
      return shown.has(user.id) || (isFieldRole(user.role) && (office || (eligible && user.active)));
    })
    .map((user) => {
      const record = directory.eligibility.get(user.id);
      return {
        id: user.id,
        name: userFullName(user),
        active: user.active,
        main: record?.main ?? false,
        helper: record?.helper ?? false,
        apprentice: record?.apprentice ?? false,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const mine = upcoming
    .filter((week) => week.status === 'published' && standbyWeekTiming(week.weekStart, today) !== 'past')
    .flatMap((week) =>
      week.assignments
        .filter((place) => place.userId === context.actor.id)
        .map((place) => ({
          weekStart: week.weekStart,
          weekEnd: standbyWeekEnd(week.weekStart),
          position: place.position,
          label: STANDBY_POSITION_LABELS[place.position],
          swapKind: standbySwapKindOf(place.position),
        })),
    );

  return {
    from,
    to,
    today,
    planningLimit: standbyPlanningLimit(today),
    weeks: visible.map((week) => weekView(week, directory, today, pending, office)),
    people,
    mine,
    canManage: office,
    canRequestSwap: can(context.actor.role, 'standby.requestSwap'),
  };
};

/* ---- eligibility ------------------------------------------------------------ */

export interface StandbyEligibilityInput {
  readonly userId: string;
  readonly main: boolean;
  readonly helper: boolean;
  readonly apprentice: boolean;
}

const flagsLabel = (record: Pick<StandbyEligibility, 'main' | 'helper' | 'apprentice'> | undefined): string => {
  const flags = [
    record?.main === true ? 'main' : null,
    record?.helper === true ? 'helper' : null,
    record?.apprentice === true ? 'apprentice' : null,
  ].filter((flag) => flag !== null);
  return flags.length === 0 ? 'not on standby' : flags.join(', ');
};

/** Who may stand in which place. The office's record; nothing is inferred from the role. */
export const setStandbyEligibility = async (
  context: OperationContext,
  input: StandbyEligibilityInput,
): Promise<StandbyEligibility> => {
  assertManages(context);
  const user = await context.repos.users.findById(asUserId(input.userId));
  if (user === null) throw refuse('That person does not exist.', 'user_not_found', 'Reload the list.');
  const any = input.main || input.helper || input.apprentice;
  if (any && !isFieldRole(user.role)) {
    throw refuse(
      `${userFullName(user)} is not a technician.`,
      'not_technician',
      'Standby is field work: only a technician account can be put on the standby roster.',
    );
  }
  if (any && !user.active) {
    throw refuse(`${userFullName(user)} is not active.`, 'user_inactive', 'Only an active account can stand by.');
  }
  if (input.apprentice && (input.main || input.helper)) {
    throw refuse(
      'An apprentice is not also a standby technician.',
      'apprentice_apart',
      'Tick Apprentice on its own, or Main and/or Helper.',
    );
  }
  const before = (await context.repos.standby.listEligibility()).find((record) => record.userId === user.id);
  const saved = await context.repos.standby.saveEligibility({
    userId: user.id,
    main: input.main,
    helper: input.helper,
    apprentice: input.apprentice,
    updatedBy: context.actor.id,
    updatedAt: context.services.clock.now(),
  });
  await audit(context, {
    jobId: null,
    type: 'standby_eligibility_changed',
    summary: `Standby eligibility: ${userFullName(user)} — ${flagsLabel(saved)}`,
    detail: `Was ${flagsLabel(before)}. Now ${flagsLabel(saved)}. Changed by ${userFullName(context.actor)}.`,
    changes: [{ field: `standby.eligibility ${userFullName(user)}`, from: flagsLabel(before), to: flagsLabel(saved) }],
  });
  return saved;
};

/* ---- generating a year -------------------------------------------------------- */

export interface StandbyGenerateInput {
  readonly year: number;
  /**
   * Optional: for each place, an ORDER of people the office has chosen. Week n
   * of the year takes person n of the order (repeating). Nothing is assumed
   * when it is absent — the weeks are simply created empty.
   */
  readonly rotation?: Partial<Record<StandbyPosition, readonly string[]>>;
}

export interface StandbyGenerateResult {
  readonly year: number;
  readonly created: readonly IsoDate[];
  readonly placesFilled: number;
  /** Published or already-filled weeks and places, left exactly as they were. */
  readonly weeksLeftAlone: number;
  readonly skipped: readonly { readonly weekStart: IsoDate; readonly position: StandbyPosition; readonly reason: string }[];
}

const assertPlannableYear = (year: number, today: IsoDate): void => {
  const current = Number(today.slice(0, 4));
  if (!Number.isInteger(year) || year < current || year > current + 1) {
    throw refuse(
      `Standby can be planned for ${current} and ${current + 1}.`,
      'year_out_of_range',
      'A year that has passed is history, and planning reaches one full calendar year ahead.',
    );
  }
};

export const generateStandbyYear = async (
  context: OperationContext,
  input: StandbyGenerateInput,
): Promise<StandbyGenerateResult> => {
  assertManages(context);
  const today = todayOf(context);
  assertPlannableYear(input.year, today);
  const directory = await loadDirectory(context);

  // Every person in the office's order must be able to stand in that place.
  const rotation = new Map<StandbyPosition, readonly UserId[]>();
  const violations: { code: string; message: string }[] = [];
  for (const [key, ids] of Object.entries(input.rotation ?? {})) {
    if (!isStandbyPosition(key) || ids === undefined) continue;
    const order = ids.map((id) => asUserId(id));
    for (const id of order) {
      if (!mayStandIn(directory.users.get(id), directory.eligibility.get(id), standbyCategoryOf(key))) {
        violations.push({
          code: 'not_eligible',
          message: `${nameOf(directory, id) ?? id} cannot stand in the ${STANDBY_POSITION_LABELS[key]} place.`,
        });
      }
    }
    if (order.length > 0) rotation.set(key, order);
  }
  if (violations.length > 0) throw new WorkflowError('The order given for the year is not valid.', violations);

  const all = standbyWeeksOfYear(input.year);
  const existing = new Map(
    (await context.repos.standby.listWeeks(all[0]!, all[all.length - 1]!)).map((week) => [week.weekStart, week]),
  );
  const now = context.services.clock.now();
  const skipped: { weekStart: IsoDate; position: StandbyPosition; reason: string }[] = [];
  const proposalFor = (index: number, weekStart: IsoDate, current: StandbyWeek | null) => {
    const taken = new Set((current?.assignments ?? []).flatMap((place) => (place.userId === null ? [] : [place.userId])));
    const fills = new Map<StandbyPosition, UserId>();
    for (const position of STANDBY_POSITIONS) {
      const order = rotation.get(position);
      if (order === undefined || holderOf(current, position) !== null) continue;
      const candidate = order[index % order.length]!;
      if (taken.has(candidate)) {
        skipped.push({
          weekStart,
          position,
          reason: `${nameOf(directory, candidate)} already holds another place that week.`,
        });
        continue;
      }
      taken.add(candidate);
      fills.set(position, candidate);
    }
    return fills;
  };

  const fresh: StandbyWeek[] = [];
  const fillLater: { weekStart: IsoDate; position: StandbyPosition; userId: UserId }[] = [];
  let weeksLeftAlone = 0;
  all.forEach((weekStart, index) => {
    if (standbyWeekTiming(weekStart, today) === 'past') return;
    const current = existing.get(weekStart) ?? null;
    if (current !== null && current.status === 'published') {
      weeksLeftAlone += 1;
      return;
    }
    const fills = proposalFor(index, weekStart, current);
    if (current === null) {
      fresh.push({
        id: context.services.ids.next('sbw'),
        weekStart,
        status: 'draft',
        publishedBy: null,
        publishedAt: null,
        createdBy: context.actor.id,
        createdAt: now,
        assignments: STANDBY_POSITIONS.map((position) => {
          const userId = fills.get(position) ?? null;
          return { position, userId, assignedBy: userId === null ? null : context.actor.id, assignedAt: userId === null ? null : now };
        }),
      });
    } else {
      if (fills.size === 0) weeksLeftAlone += 1;
      for (const [position, userId] of fills) fillLater.push({ weekStart, position, userId });
    }
  });

  const created = await context.repos.standby.createWeeks(fresh);
  let placesFilled = fresh
    .filter((week) => created.includes(week.weekStart))
    .reduce((sum, week) => sum + week.assignments.filter((place) => place.userId !== null).length, 0);
  for (const fill of fillLater) {
    // Only an EMPTY place is filled: expected holder null. A place somebody
    // filled meanwhile stays theirs.
    const done = await context.repos.standby.setAssignment({
      weekStart: fill.weekStart,
      position: fill.position,
      expectedUserId: null,
      userId: fill.userId,
      assignedBy: context.actor.id,
      assignedAt: now,
    });
    if (done) placesFilled += 1;
    else skipped.push({ weekStart: fill.weekStart, position: fill.position, reason: 'The place was filled meanwhile.' });
  }

  await audit(context, {
    jobId: null,
    type: 'standby_schedule_generated',
    summary: `Standby ${input.year} generated: ${created.length} weeks added, ${placesFilled} places filled`,
    detail: [
      `Generated by ${userFullName(context.actor)} as DRAFT weeks; nothing is visible to technicians until published.`,
      rotation.size === 0
        ? 'No order was given: weeks were created empty.'
        : `Order given: ${[...rotation.entries()]
            .map(([position, order]) => `${STANDBY_POSITION_LABELS[position]}: ${order.map((id) => nameOf(directory, id)).join(' → ')}`)
            .join('; ')}.`,
      `${weeksLeftAlone} weeks left exactly as they were (published or already filled); past weeks are never touched.`,
      ...skipped.map((skip) => `Not filled — ${describeWeek(skip.weekStart)}, ${STANDBY_POSITION_LABELS[skip.position]}: ${skip.reason}`),
    ].join('\n'),
  });
  return { year: input.year, created, placesFilled, weeksLeftAlone, skipped };
};

/* ---- one place --------------------------------------------------------------- */

export interface StandbyAssignInput {
  readonly weekStart: string;
  readonly position: string;
  readonly userId: string | null;
  /** Who the screen showed in the place. The change is refused if that is no longer true. */
  readonly expectedUserId: string | null;
  readonly reason: string;
}

export interface StandbyAssignResult {
  readonly week: StandbyWeekView;
  readonly emergency: boolean;
  /** Pending swap requests that name this place: they can no longer be approved. */
  readonly stalePendingSwaps: number;
}

/** Fills, changes or empties one place. The office's manual (or emergency) change. */
export const assignStandby = async (
  context: OperationContext,
  input: StandbyAssignInput,
): Promise<StandbyAssignResult> => {
  assertManages(context);
  const today = todayOf(context);
  if (!isMonday(input.weekStart)) {
    throw refuse('A standby week starts on a Monday.', 'invalid_week', 'Choose the Monday the week starts on.');
  }
  if (!isStandbyPosition(input.position)) {
    throw refuse('That is not a standby place.', 'invalid_position', 'Main, helper, apprentice 1 or apprentice 2.');
  }
  const position = input.position;
  const timing = standbyWeekTiming(input.weekStart, today);
  if (timing === 'past') {
    throw refuse(
      `The ${describeWeek(input.weekStart)} has ended.`,
      'week_past',
      'A standby week that has ended is history and is not changed.',
    );
  }
  if (input.weekStart > standbyPlanningLimit(today)) {
    throw refuse('That week is too far ahead.', 'beyond_planning_limit', `Standby is planned up to ${standbyPlanningLimit(today)}.`);
  }
  const reason = input.reason.trim();
  if (reason.length > STANDBY_REASON_LIMIT) {
    throw refuse('That reason is too long.', 'reason_too_long', `Keep it to ${STANDBY_REASON_LIMIT} characters.`);
  }

  const directory = await loadDirectory(context);
  const expected = input.expectedUserId === null ? null : asUserId(input.expectedUserId);
  const next = input.userId === null ? null : asUserId(input.userId);
  // Checked before anything is written, a missing week included.
  if (next !== null && !mayStandIn(directory.users.get(next), directory.eligibility.get(next), standbyCategoryOf(position))) {
    throw refuse(
      `${nameOf(directory, next)} cannot stand in the ${STANDBY_POSITION_LABELS[position]} place.`,
      'not_eligible',
      'Only an active technician whose standby eligibility allows this place.',
    );
  }
  let week = await context.repos.standby.findWeek(input.weekStart);
  if (week === null) {
    await context.repos.standby.createWeeks([
      {
        id: context.services.ids.next('sbw'),
        weekStart: input.weekStart,
        status: 'draft',
        publishedBy: null,
        publishedAt: null,
        createdBy: context.actor.id,
        createdAt: context.services.clock.now(),
        assignments: STANDBY_POSITIONS.map((place) => ({ position: place, userId: null, assignedBy: null, assignedAt: null })),
      },
    ]);
    week = await context.repos.standby.findWeek(input.weekStart);
    if (week === null) throw refuse('The week could not be created.', 'week_missing', 'Reload and try again.');
  }
  const published = week.status === 'published';
  const emergency = published && timing === 'current';
  if (published && reason.length === 0) {
    throw refuse(
      'Say why this published week is being changed.',
      'reason_required',
      emergency
        ? 'This week is in progress: an emergency change needs its reason on the record.'
        : 'People already work to this week; the reason goes on the record and to them.',
    );
  }

  const current = holderOf(week, position);
  if (current !== expected) {
    throw refuse(
      'Somebody else changed this place while you were looking at it.',
      'assignment_changed',
      'Reload the week to see who holds the place now.',
    );
  }
  if (next === current) throw refuse('Nothing was changed.', 'unchanged', 'Choose a different person, or cancel.');
  if (next !== null) {
    const other = week.assignments.find((place) => place.position !== position && place.userId === next);
    if (other !== undefined) {
      throw refuse(
        `${nameOf(directory, next)} is already ${STANDBY_POSITION_LABELS[other.position]} that week.`,
        'duplicate_person',
        'A person holds at most one standby place in a week.',
      );
    }
  }

  const now = context.services.clock.now();
  const changed = await context.repos.standby.setAssignment({
    weekStart: week.weekStart,
    position,
    expectedUserId: current,
    userId: next,
    assignedBy: context.actor.id,
    assignedAt: now,
  });
  if (!changed) {
    throw refuse(
      'Somebody else changed this place while you were looking at it.',
      'assignment_changed',
      'Reload the week to see who holds the place now.',
    );
  }

  const label = STANDBY_POSITION_LABELS[position];
  const from = nameOf(directory, current) ?? 'nobody';
  const to = nameOf(directory, next) ?? 'nobody';
  const pending = (await context.repos.standby.listSwapRequests()).filter(
    (request) => request.status === 'pending' && involves(request, week.weekStart, position),
  );
  await audit(context, {
    jobId: null,
    type: emergency ? 'standby_emergency_change' : 'standby_assignment_changed',
    summary: `${emergency ? 'Emergency standby change' : 'Standby changed'}: ${describeWeek(week.weekStart)}, ${label} — ${from} → ${to}`,
    detail: [
      `${published ? 'Published' : 'Draft'} ${describeWeek(week.weekStart)} (to ${standbyWeekEnd(week.weekStart)}). ${label}: ${from} → ${to}. Changed by ${userFullName(context.actor)}.`,
      reason.length > 0 ? `Reason: ${reason}` : null,
      pending.length > 0 ? `${pending.length} pending swap request(s) named this place and can no longer be approved: ${pending.map((request) => request.id).join(', ')}.` : null,
    ]
      .filter((line) => line !== null)
      .join('\n'),
    changes: [{ field: `standby.${week.weekStart}.${position}`, from, to }],
  });

  if (published) {
    const body = `${label}, week ${week.weekStart} to ${standbyWeekEnd(week.weekStart)}: ${from} → ${to}.${reason.length > 0 ? `\nReason: ${reason}` : ''}`;
    for (const person of new Set([current, next])) {
      if (person === null || person === context.actor.id) continue;
      await notify(context, {
        recipientId: person,
        type: 'standby_assignment_changed',
        title: person === next ? `You are now on standby (${label})` : `You are no longer on standby (${label})`,
        body,
        link: `/standby?week=${week.weekStart}`,
      });
    }
  }

  const saved = (await context.repos.standby.findWeek(week.weekStart))!;
  const requests = (await context.repos.standby.listSwapRequests()).filter((request) => request.status === 'pending');
  return {
    week: weekView(saved, directory, today, requests, true),
    emergency,
    stalePendingSwaps: pending.length,
  };
};

/* ---- publishing ------------------------------------------------------------- */

export interface StandbyPublishInput {
  readonly year: number;
  /** Publish even though some weeks have empty places. Never overrides any other problem. */
  readonly acknowledgeIncomplete: boolean;
}

export interface StandbyPublishResult {
  readonly published: readonly IsoDate[];
  readonly incomplete: readonly IsoDate[];
}

/** Publishes the year's draft weeks that have not ended. One-way. */
export const publishStandbyYear = async (
  context: OperationContext,
  input: StandbyPublishInput,
): Promise<StandbyPublishResult> => {
  assertManages(context);
  const today = todayOf(context);
  assertPlannableYear(input.year, today);
  const all = standbyWeeksOfYear(input.year);
  const directory = await loadDirectory(context);
  const drafts = (await context.repos.standby.listWeeks(all[0]!, all[all.length - 1]!)).filter(
    (week) => week.status === 'draft' && standbyWeekTiming(week.weekStart, today) !== 'past',
  );
  if (drafts.length === 0) {
    throw refuse(`There is nothing to publish for ${input.year}.`, 'nothing_to_publish', 'Every week of the year is already published, or none has been generated.');
  }
  const blocking = drafts.flatMap((week) =>
    standbyWeekProblems(week, directory.users, directory.eligibility)
      .filter((problem) => problem.code !== 'missing')
      .map((problem) => ({ code: problem.code, message: `${describeWeek(week.weekStart)} — ${problem.message}` })),
  );
  if (blocking.length > 0) {
    throw new WorkflowError('Some weeks have to be corrected before they can be published.', blocking);
  }
  const incomplete = drafts
    .filter((week) => week.assignments.some((place) => place.userId === null))
    .map((week) => week.weekStart);
  if (incomplete.length > 0 && !input.acknowledgeIncomplete) {
    throw new WorkflowError(
      `${incomplete.length} week(s) still have empty places.`,
      incomplete.map((weekStart) => ({ code: 'incomplete_week', message: `${describeWeek(weekStart)} has an empty place.` })),
    );
  }
  const published = await context.repos.standby.publishWeeks(
    drafts.map((week) => week.weekStart),
    context.actor.id,
    context.services.clock.now(),
  );
  await audit(context, {
    jobId: null,
    type: 'standby_schedule_published',
    summary: `Standby ${input.year} published: ${published.length} weeks`,
    detail: `Published by ${userFullName(context.actor)}: ${published[0] ?? ''} to ${published[published.length - 1] ?? ''}.${
      incomplete.length > 0 ? ` Published with empty places, acknowledged: ${incomplete.join(', ')}.` : ''
    }`,
  });
  return { published, incomplete };
};

/* ---- swap requests ------------------------------------------------------------ */

export interface StandbySwapInput {
  readonly kind: string;
  readonly weekStart: string;
  readonly counterpartId: string;
  readonly counterpartWeekStart: string;
  readonly reason: string;
}

const swappable = (week: StandbyWeek | null, today: IsoDate): week is StandbyWeek =>
  week !== null && week.status === 'published' && standbyWeekTiming(week.weekStart, today) === 'future';

const placeOfKind = (week: StandbyWeek, userId: UserId, kind: StandbySwapKind) =>
  week.assignments.find((place) => place.userId === userId && standbySwapKindOf(place.position) === kind);

/**
 * Everything a swap needs to be true, checked when it is asked for and again
 * when it is approved. Returns the two places, or throws saying what is wrong.
 */
const checkSwap = (
  directory: Directory,
  today: IsoDate,
  requesterId: UserId,
  kind: StandbySwapKind,
  mine: StandbyWeek | null,
  counterpartId: UserId,
  theirs: StandbyWeek | null,
  expected?: { readonly requesterPosition: StandbyPosition; readonly counterpartPosition: StandbyPosition },
): { readonly requesterPosition: StandbyPosition; readonly counterpartPosition: StandbyPosition } => {
  if (!swappable(mine, today) || !swappable(theirs, today)) {
    throw refuse(
      'Only published weeks that have not started can be swapped.',
      'week_not_swappable',
      'A week in progress or already ended is changed by the office only.',
    );
  }
  const myPlace = placeOfKind(mine, requesterId, kind);
  const theirPlace = placeOfKind(theirs, counterpartId, kind);
  if (myPlace === undefined || (expected !== undefined && myPlace.position !== expected.requesterPosition)) {
    throw refuse(
      `The requester no longer holds the ${STANDBY_SWAP_KIND_LABELS[kind]} place in the ${describeWeek(mine.weekStart)}.`,
      'assignment_changed',
      'The calendar changed after the request was made.',
    );
  }
  if (theirPlace === undefined || (expected !== undefined && theirPlace.position !== expected.counterpartPosition)) {
    throw refuse(
      `${nameOf(directory, counterpartId)} does not hold the ${STANDBY_SWAP_KIND_LABELS[kind]} place in the ${describeWeek(theirs.weekStart)}.`,
      expected === undefined ? 'counterpart_not_assigned' : 'assignment_changed',
      'A swap exchanges two places that two people actually hold.',
    );
  }
  const category = kind === 'main' ? 'main' : 'apprentice';
  for (const id of [requesterId, counterpartId]) {
    if (!mayStandIn(directory.users.get(id), directory.eligibility.get(id), category)) {
      throw refuse(
        `${nameOf(directory, id)} is not eligible for the ${STANDBY_SWAP_KIND_LABELS[kind]} place.`,
        'not_eligible',
        'Both people must be active and eligible for the place being exchanged.',
      );
    }
  }
  if (theirs.assignments.some((place) => place.userId === requesterId) || mine.assignments.some((place) => place.userId === counterpartId)) {
    throw refuse(
      'That swap would put somebody in two places in one week.',
      'would_double_book',
      'Each person already holds a place in the other week.',
    );
  }
  return { requesterPosition: myPlace.position, counterpartPosition: theirPlace.position };
};

const swapView = (request: StandbySwapRequest, directory: Directory, valid: boolean): StandbySwapView => ({
  ...request,
  requesterName: nameOf(directory, request.requesterId) ?? '',
  counterpartName: nameOf(directory, request.counterpartId) ?? '',
  decidedByName: nameOf(directory, request.decidedBy),
  kindLabel: STANDBY_SWAP_KIND_LABELS[request.kind],
  stillValid: valid,
});

const describeSwap = (request: StandbySwapRequest, directory: Directory): string =>
  `${nameOf(directory, request.requesterId)} (${STANDBY_POSITION_LABELS[request.requesterPosition]}, ${describeWeek(request.requesterWeekStart)}) ⇄ ${nameOf(directory, request.counterpartId)} (${STANDBY_POSITION_LABELS[request.counterpartPosition]}, ${describeWeek(request.counterpartWeekStart)})`;

/** A technician asks to exchange one of their own places. Pending until the office decides. */
export const requestStandbySwap = async (
  context: OperationContext,
  input: StandbySwapInput,
): Promise<StandbySwapView> => {
  if (!can(context.actor.role, 'standby.requestSwap')) {
    throw refuse(
      'Only a technician on standby can ask for a swap.',
      'not_permitted',
      'The office changes the calendar directly.',
    );
  }
  if (input.kind !== 'main' && input.kind !== 'apprentice') {
    throw refuse('That is not a kind of swap.', 'invalid_kind', 'A main standby technician swap or an apprentice swap.');
  }
  const kind: StandbySwapKind = input.kind;
  if (!isMonday(input.weekStart) || !isMonday(input.counterpartWeekStart)) {
    throw refuse('A standby week starts on a Monday.', 'invalid_week', 'Choose the weeks from the calendar.');
  }
  if (input.weekStart === input.counterpartWeekStart) {
    throw refuse('Choose a different week.', 'same_week', 'A swap exchanges places in two different weeks.');
  }
  const counterpartId = asUserId(input.counterpartId);
  if (counterpartId === context.actor.id) {
    throw refuse('Choose somebody else.', 'same_person', 'A swap is between two people.');
  }
  const reason = input.reason.trim();
  if (reason.length > STANDBY_REASON_LIMIT) {
    throw refuse('That reason is too long.', 'reason_too_long', `Keep it to ${STANDBY_REASON_LIMIT} characters.`);
  }
  const today = todayOf(context);
  const directory = await loadDirectory(context);
  const [mine, theirs] = await Promise.all([
    context.repos.standby.findWeek(input.weekStart),
    context.repos.standby.findWeek(input.counterpartWeekStart),
  ]);

  // The requester must actually hold a place of this kind in their week.
  if (mine !== null && placeOfKind(mine, context.actor.id, kind) === undefined) {
    const held = mine.assignments.find((place) => place.userId === context.actor.id);
    if (held === undefined || (mine.status !== 'published' && !can(context.actor.role, 'standby.manage'))) {
      throw refuse(
        `You are not on standby in the ${describeWeek(input.weekStart)}.`,
        'not_your_assignment',
        'You can only offer a place you hold yourself.',
      );
    }
    throw refuse(
      held.position === 'helper'
        ? 'A helper technician\'s place is not swapped this way.'
        : `You are ${STANDBY_POSITION_LABELS[held.position]} that week, not in a ${STANDBY_SWAP_KIND_LABELS[kind]} place.`,
      held.position === 'helper' ? 'helper_not_swappable' : 'swap_kind_mismatch',
      held.position === 'helper'
        ? 'Ask the office to change the helper place.'
        : 'A main technician swaps with a main technician, an apprentice with an apprentice.',
    );
  }
  if (mine !== null && mine.status !== 'published') {
    throw refuse(`You are not on standby in the ${describeWeek(input.weekStart)}.`, 'not_your_assignment', 'You can only offer a place you hold yourself.');
  }
  const places = checkSwap(directory, today, context.actor.id, kind, mine, counterpartId, theirs);

  const all = await context.repos.standby.listSwapRequests();
  const clash = all.some(
    (request) =>
      request.status === 'pending' &&
      (involves(request, input.weekStart, places.requesterPosition) ||
        involves(request, input.counterpartWeekStart, places.counterpartPosition)),
  );
  const request: StandbySwapRequest = {
    id: context.services.ids.next('sbs'),
    kind,
    requesterId: context.actor.id,
    requesterWeekStart: input.weekStart,
    requesterPosition: places.requesterPosition,
    counterpartId,
    counterpartWeekStart: input.counterpartWeekStart,
    counterpartPosition: places.counterpartPosition,
    reason,
    status: 'pending',
    requestedAt: context.services.clock.now(),
    decidedBy: null,
    decidedAt: null,
    decisionNote: '',
    cancelledAt: null,
  };
  const saved = clash ? null : await context.repos.standby.createSwapRequest(request);
  if (saved === null) {
    throw refuse(
      'One of these places is already in a swap request waiting for the office.',
      'swap_pending',
      'The office decides that request first.',
    );
  }
  const summary = describeSwap(saved, directory);
  await audit(context, {
    jobId: null,
    type: 'standby_swap_requested',
    summary: `Standby swap asked for (${STANDBY_SWAP_KIND_LABELS[kind]}): ${summary}`,
    detail: `Request ${saved.id}. ${summary}.${reason.length > 0 ? `\nReason: ${reason}` : ''}\nNothing changes until the office approves it.`,
  });
  await notifyOffice(context, {
    type: 'standby_swap_requested',
    title: `${userFullName(context.actor)} asked to swap a standby week`,
    body: `${summary}.${reason.length > 0 ? `\nReason: ${reason}` : ''}\nOpen the Standby Calendar to approve or reject it.`,
    link: '/standby?tab=requests',
  });
  return swapView(saved, directory, true);
};

export interface StandbyDecisionInput {
  readonly decision: 'approve' | 'reject';
  readonly note?: string;
}

/** The office approves (exchanging the two places, all or nothing) or rejects. Once. */
export const decideStandbySwap = async (
  context: OperationContext,
  requestId: string,
  input: StandbyDecisionInput,
): Promise<StandbySwapView> => {
  assertManages(context);
  const request = await context.repos.standby.findSwapRequest(requestId);
  if (request === null) throw refuse('That swap request does not exist.', 'request_not_found', 'Reload the list.');
  if (request.requesterId === context.actor.id) {
    throw refuse('You cannot decide your own swap request.', 'own_request', 'Somebody else in the office decides it.');
  }
  if (request.status !== 'pending') {
    throw refuse(`This swap request was already ${request.status}.`, 'already_decided', 'A decision is taken once.');
  }
  const note = (input.note ?? '').trim();
  if (note.length > STANDBY_NOTE_LIMIT) {
    throw refuse('That note is too long.', 'note_too_long', `Keep it to ${STANDBY_NOTE_LIMIT} characters.`);
  }
  const directory = await loadDirectory(context);
  const summary = describeSwap(request, directory);
  const decision = { id: request.id, decidedBy: context.actor.id, decidedAt: context.services.clock.now(), decisionNote: note };

  if (input.decision === 'reject') {
    const rejected = await context.repos.standby.rejectSwapRequest(decision);
    if (rejected === null) throw refuse('This swap request was already decided.', 'already_decided', 'A decision is taken once.');
    await audit(context, {
      jobId: null,
      type: 'standby_swap_rejected',
      summary: `Standby swap rejected: ${summary}`,
      detail: `Request ${request.id}, rejected by ${userFullName(context.actor)}. The calendar is unchanged.${note.length > 0 ? `\nNote: ${note}` : ''}`,
    });
    await notify(context, {
      recipientId: request.requesterId,
      type: 'standby_swap_decided',
      title: 'Your standby swap was rejected',
      body: `${summary}.${note.length > 0 ? `\nNote: ${note}` : ''}\nYour standby weeks are unchanged.`,
      link: '/standby?tab=requests',
    });
    return swapView(rejected, directory, false);
  }

  // RE-CHECK EVERYTHING against the calendar as it stands now.
  const today = todayOf(context);
  const [mine, theirs] = await Promise.all([
    context.repos.standby.findWeek(request.requesterWeekStart),
    context.repos.standby.findWeek(request.counterpartWeekStart),
  ]);
  checkSwap(directory, today, request.requesterId, request.kind, mine, request.counterpartId, theirs, request);
  const result = await context.repos.standby.approveSwapRequest(decision);
  if (!result.ok) {
    throw result.reason === 'not_pending'
      ? refuse('This swap request was already decided.', 'already_decided', 'A decision is taken once.')
      : refuse('The calendar changed after the request was made.', 'assignment_changed', 'Nothing was changed. Reject the request, or ask for a new one.');
  }
  const changes: FieldChange[] = [
    {
      field: `standby.${request.requesterWeekStart}.${request.requesterPosition}`,
      from: nameOf(directory, request.requesterId),
      to: nameOf(directory, request.counterpartId),
    },
    {
      field: `standby.${request.counterpartWeekStart}.${request.counterpartPosition}`,
      from: nameOf(directory, request.counterpartId),
      to: nameOf(directory, request.requesterId),
    },
  ];
  await audit(context, {
    jobId: null,
    type: 'standby_swap_approved',
    summary: `Standby swap approved: ${summary}`,
    detail: `Request ${request.id}, approved by ${userFullName(context.actor)}. Only these two places were exchanged; every other place in both weeks is unchanged.${note.length > 0 ? `\nNote: ${note}` : ''}`,
    changes,
  });
  for (const person of [request.requesterId, request.counterpartId]) {
    await notify(context, {
      recipientId: person,
      type: 'standby_swap_decided',
      title: 'A standby swap was approved',
      body: `${summary}.\n${nameOf(directory, request.counterpartId)} now stands by in the ${describeWeek(request.requesterWeekStart)}; ${nameOf(directory, request.requesterId)} in the ${describeWeek(request.counterpartWeekStart)}.${note.length > 0 ? `\nNote: ${note}` : ''}`,
      link: '/standby?tab=requests',
    });
  }
  return swapView(result.request, directory, false);
};

/** The requester withdraws their own request while it is still pending. */
export const cancelStandbySwap = async (context: OperationContext, requestId: string): Promise<StandbySwapView> => {
  assertViews(context);
  const request = await context.repos.standby.findSwapRequest(requestId);
  if (request === null) throw refuse('That swap request does not exist.', 'request_not_found', 'Reload the list.');
  if (request.requesterId !== context.actor.id) {
    throw refuse('Only the person who asked can withdraw a swap request.', 'not_permitted', 'The office rejects it instead.');
  }
  const cancelled = await context.repos.standby.cancelSwapRequest(request.id, context.services.clock.now());
  if (cancelled === null) {
    throw refuse(`This swap request was already ${request.status}.`, 'already_decided', 'Only a pending request can be withdrawn.');
  }
  const directory = await loadDirectory(context);
  await audit(context, {
    jobId: null,
    type: 'standby_swap_cancelled',
    summary: `Standby swap withdrawn: ${describeSwap(request, directory)}`,
    detail: `Request ${request.id}, withdrawn by ${userFullName(context.actor)}. The calendar is unchanged.`,
  });
  return swapView(cancelled, directory, false);
};

/** Swap requests: every one for the office; for anybody else, those they are part of. */
export const listStandbySwaps = async (
  context: OperationContext,
  status?: string,
): Promise<readonly StandbySwapView[]> => {
  assertViews(context);
  const office = can(context.actor.role, 'standby.manage');
  const wanted = (['pending', 'approved', 'rejected', 'cancelled'] as const).find((candidate) => candidate === status);
  const directory = await loadDirectory(context);
  const today = todayOf(context);
  const requests = (await context.repos.standby.listSwapRequests()).filter(
    (request) =>
      (office || request.requesterId === context.actor.id || request.counterpartId === context.actor.id) &&
      (wanted === undefined || request.status === wanted),
  );
  const weeks = new Map<IsoDate, StandbyWeek | null>();
  const weekOf = async (monday: IsoDate) => {
    if (!weeks.has(monday)) weeks.set(monday, await context.repos.standby.findWeek(monday));
    return weeks.get(monday)!;
  };
  const views: StandbySwapView[] = [];
  for (const request of requests) {
    let valid = false;
    if (request.status === 'pending') {
      try {
        checkSwap(directory, today, request.requesterId, request.kind, await weekOf(request.requesterWeekStart), request.counterpartId, await weekOf(request.counterpartWeekStart), request);
        valid = true;
      } catch {
        valid = false;
      }
    }
    views.push(swapView(request, directory, valid));
  }
  return views;
};

/** What the signed-in technician may offer, and what they may ask for in exchange. */
export interface StandbySwapOptions {
  readonly mine: readonly { readonly weekStart: IsoDate; readonly position: StandbyPosition; readonly kind: StandbySwapKind }[];
  readonly candidates: readonly {
    readonly weekStart: IsoDate;
    readonly position: StandbyPosition;
    readonly kind: StandbySwapKind;
    readonly userId: UserId;
    readonly name: string;
  }[];
}

export const loadStandbySwapOptions = async (context: OperationContext): Promise<StandbySwapOptions> => {
  assertViews(context);
  if (!can(context.actor.role, 'standby.requestSwap')) return { mine: [], candidates: [] };
  const today = todayOf(context);
  const directory = await loadDirectory(context);
  const weeks = (await context.repos.standby.listWeeks(addStandbyDays(today, 1), standbyPlanningLimit(today))).filter(
    (week) => swappable(week, today),
  );
  const pending = (await context.repos.standby.listSwapRequests()).filter((request) => request.status === 'pending');
  const free = (week: StandbyWeek, position: StandbyPosition) => !pending.some((request) => involves(request, week.weekStart, position));
  const me = context.actor.id;
  const mine = weeks.flatMap((week) =>
    week.assignments.flatMap((place) => {
      const kind = standbySwapKindOf(place.position);
      return place.userId === me && kind !== null && free(week, place.position)
        ? [{ weekStart: week.weekStart, position: place.position, kind }]
        : [];
    }),
  );
  const myKinds = new Set(mine.map((place) => place.kind));
  const candidates = weeks.flatMap((week) =>
    week.assignments.flatMap((place) => {
      const kind = standbySwapKindOf(place.position);
      if (place.userId === null || place.userId === me || kind === null || !myKinds.has(kind)) return [];
      if (!free(week, place.position)) return [];
      const category = kind === 'main' ? 'main' : 'apprentice';
      if (!mayStandIn(directory.users.get(place.userId), directory.eligibility.get(place.userId), category)) return [];
      return [{ weekStart: week.weekStart, position: place.position, kind, userId: place.userId, name: nameOf(directory, place.userId) ?? '' }];
    }),
  );
  return { mine, candidates };
};

