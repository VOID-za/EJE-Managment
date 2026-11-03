import type { IsoDate, UserId } from '../types/common';
import { isFieldRole, type User, type UserRole } from '../types/user';
import {
  STANDBY_POSITIONS,
  type StandbyCategory,
  type StandbyEligibility,
  type StandbyPosition,
  type StandbySwapKind,
  type StandbyWeek,
  type StandbyDayOverride,
  type StandbyDaySwapStatus,
} from '../types/standby';

/**
 * Standby week arithmetic and rules. STANDBY-1, STANDBY-2.
 *
 * Pure, and in UTC calendar days, so a week never gains or loses a day across a
 * clock change and the server and a tablet agree on which Monday is which.
 */
const DAY = 86_400_000;

const toUtc = (date: IsoDate): number => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (at: number): IsoDate => new Date(at).toISOString().slice(0, 10);

export const isIsoDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(toUtc(value)) && fromUtc(toUtc(value)) === value;

export const addStandbyDays = (date: IsoDate, days: number): IsoDate => fromUtc(toUtc(date) + days * DAY);

/** 1 = Monday … 7 = Sunday. */
const isoWeekday = (date: IsoDate): number => {
  const day = new Date(toUtc(date)).getUTCDay();
  return day === 0 ? 7 : day;
};

export const isMonday = (date: IsoDate): boolean => isIsoDate(date) && isoWeekday(date) === 1;

/** The Monday of the week holding `date`. */
export const standbyWeekOf = (date: IsoDate): IsoDate => addStandbyDays(date, 1 - isoWeekday(date));

/** The Sunday a week starting on `weekStart` ends on. */
export const standbyWeekEnd = (weekStart: IsoDate): IsoDate => addStandbyDays(weekStart, 6);

/**
 * The weeks of a calendar year: every week whose MONDAY falls in it.
 *
 * So the week of Monday 28 December 2026 belongs to 2026 although it ends in
 * 2027, and no week belongs to two years. A year has 52 or 53 Mondays — 53 when
 * it starts on a Monday, or on a Sunday in a leap year.
 */
export const standbyWeeksOfYear = (year: number): readonly IsoDate[] => {
  const weeks: IsoDate[] = [];
  const first = `${String(year).padStart(4, '0')}-01-01`;
  let monday = isoWeekday(first) === 1 ? first : addStandbyDays(standbyWeekOf(first), 7);
  while (monday.startsWith(`${String(year).padStart(4, '0')}-`)) {
    weeks.push(monday);
    monday = addStandbyDays(monday, 7);
  }
  return weeks;
};

export type StandbyWeekTiming = 'past' | 'current' | 'future';

export const standbyWeekTiming = (weekStart: IsoDate, today: IsoDate): StandbyWeekTiming => {
  if (standbyWeekEnd(weekStart) < today) return 'past';
  if (weekStart > today) return 'future';
  return 'current';
};

/**
 * How far ahead the calendar may be planned: up to the end of NEXT calendar
 * year, so a whole year can always be planned in advance.
 */
export const standbyPlanningLimit = (today: IsoDate): IsoDate => `${Number(today.slice(0, 4)) + 1}-12-31`;

export const standbyCategoryOf = (position: StandbyPosition): StandbyCategory =>
  position === 'main' ? 'main' : position === 'helper' ? 'helper' : 'apprentice';

export const standbySwapKindOf = (position: StandbyPosition): StandbySwapKind | null =>
  position === 'main' ? 'main' : position === 'helper' ? null : 'apprentice';

export const STANDBY_POSITION_LABELS: Readonly<Record<StandbyPosition, string>> = {
  main: 'Main standby technician',
  helper: 'Helper technician',
  apprentice_1: 'Apprentice 1',
  apprentice_2: 'Apprentice 2',
};

export const STANDBY_SWAP_KIND_LABELS: Readonly<Record<StandbySwapKind, string>> = {
  main: 'Main standby technician',
  apprentice: 'Apprentice',
};

export const isStandbyPosition = (value: string): value is StandbyPosition =>
  (STANDBY_POSITIONS as readonly string[]).includes(value);

/** Whether this person's eligibility record allows the category. */
export const eligibleFor = (
  eligibility: StandbyEligibility | undefined,
  category: StandbyCategory,
): boolean => {
  if (eligibility === undefined) return false;
  return category === 'main' ? eligibility.main : category === 'helper' ? eligibility.helper : eligibility.apprentice;
};

/**
 * WHICH ACCOUNTS MAY BE PUT ON THE STANDBY ROSTER AT ALL. STANDBY-ELIG-2.
 *
 * A Technician or an Apprentice — and, since 3 November 2026 (the owner), a
 * Senior Tech, who stands in the MAIN and HELPER places only. Being allowed is
 * not being eligible: the Office still ticks each person's places, and nobody
 * is made eligible automatically. An Office account never stands by.
 */
export const mayBeOnStandby = (role: UserRole): boolean => isFieldRole(role) || role === 'master';

export const standbyRoleAllows = (role: UserRole, category: StandbyCategory): boolean =>
  isFieldRole(role) || (role === 'master' && category !== 'apprentice');

/**
 * Whether this person may stand in this place at all: an ACTIVE account the
 * roster allows (`standbyRoleAllows`) whose eligibility record allows it.
 * Inactive people and office accounts never qualify, whatever their record says.
 */
export const mayStandIn = (
  user: Pick<User, 'role' | 'active'> | undefined,
  eligibility: StandbyEligibility | undefined,
  category: StandbyCategory,
): boolean => user !== undefined && user.active && standbyRoleAllows(user.role, category) && eligibleFor(eligibility, category);

export type StandbyProblemCode = 'missing' | 'duplicate_person' | 'not_eligible' | 'inactive';

export interface StandbyProblem {
  readonly code: StandbyProblemCode;
  readonly position: StandbyPosition;
  readonly message: string;
}

/**
 * What is wrong with a week: places not filled, the same person twice, and
 * people who are no longer active or no longer eligible for their place.
 * Shown to the office as warnings; publishing refuses everything except
 * `missing`, which it allows only when the office acknowledges it.
 */
export const standbyWeekProblems = (
  week: Pick<StandbyWeek, 'assignments'>,
  users: ReadonlyMap<string, Pick<User, 'role' | 'active' | 'firstName' | 'lastName'>>,
  eligibility: ReadonlyMap<string, StandbyEligibility>,
): readonly StandbyProblem[] => {
  const problems: StandbyProblem[] = [];
  const seen = new Map<string, StandbyPosition>();
  for (const position of STANDBY_POSITIONS) {
    const assignment = week.assignments.find((candidate) => candidate.position === position);
    const label = STANDBY_POSITION_LABELS[position];
    if (assignment === undefined || assignment.userId === null) {
      problems.push({ code: 'missing', position, message: `${label}: nobody assigned.` });
      continue;
    }
    const user = users.get(assignment.userId);
    const name = user === undefined ? 'An unknown person' : `${user.firstName} ${user.lastName}`;
    const earlier = seen.get(assignment.userId);
    if (earlier !== undefined) {
      problems.push({
        code: 'duplicate_person',
        position,
        message: `${label}: ${name} is already ${STANDBY_POSITION_LABELS[earlier]} this week.`,
      });
    }
    seen.set(assignment.userId, position);
    if (user === undefined || !user.active) {
      problems.push({ code: 'inactive', position, message: `${label}: ${name} is no longer active.` });
    } else if (!mayStandIn(user, eligibility.get(assignment.userId), standbyCategoryOf(position))) {
      problems.push({
        code: 'not_eligible',
        position,
        message: `${label}: ${name} is not eligible for this place.`,
      });
    }
  }
  return problems;
};

/**
 * WHO HOLDS A PLACE ON A DAY. STANDBY-DAY-1 (2 November 2026).
 *
 * The day's override when an approved day swap moved it; otherwise the place
 * of the PUBLISHED week holding that date. A draft week holds nobody for this
 * purpose — nobody is on standby from a schedule that is not published.
 */
export const standbyHolderOn = (
  date: IsoDate,
  position: StandbyPosition,
  weeks: readonly Pick<StandbyWeek, 'weekStart' | 'status' | 'assignments'>[],
  overrides: readonly Pick<StandbyDayOverride, 'date' | 'position' | 'userId'>[],
): UserId | null => {
  const override = overrides.find((candidate) => candidate.date === date && candidate.position === position);
  if (override !== undefined) return override.userId;
  const week = weeks.find((candidate) => candidate.weekStart === standbyWeekOf(date));
  if (week === undefined || week.status !== 'published') return null;
  return week.assignments.find((assignment) => assignment.position === position)?.userId ?? null;
};

/** The seven dates of a week, Monday first. */
export const standbyDaysOfWeek = (weekStart: IsoDate): readonly IsoDate[] =>
  [0, 1, 2, 3, 4, 5, 6].map((offset) => addStandbyDays(weekStart, offset));

export const STANDBY_DAY_SWAP_STATUS_LABELS: Readonly<Record<StandbyDaySwapStatus, string>> = {
  awaiting_recipient: 'Waiting for the other person',
  awaiting_office: 'Waiting for the Office',
  approved: 'Approved — the days were exchanged',
  denied: 'Declined by the other person',
  rejected: 'Rejected by the Office',
  withdrawn: 'Withdrawn',
};
