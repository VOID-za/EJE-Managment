import type { IsoDate, IsoDateTime, UserId } from './common';

/**
 * THE STANDBY CALENDAR. STANDBY-1…8 (2 November 2026).
 *
 * Each standby week has exactly four places: one main standby technician, one
 * helper technician and two apprentices. A week is identified by its MONDAY —
 * Monday to Sunday, the same week the job calendar plans in.
 *
 * WHO MAY STAND IN WHICH PLACE IS A RECORD THE OFFICE KEEPS, not a guess from
 * the role. Every field worker is a `technician` account, the four apprentices
 * included, so the role cannot say who is an apprentice or who may lead a
 * standby week. `StandbyEligibility` says it, per person, and the server
 * checks it on every write.
 */
export type StandbyPosition = 'main' | 'helper' | 'apprentice_1' | 'apprentice_2';

export const STANDBY_POSITIONS: readonly StandbyPosition[] = [
  'main',
  'helper',
  'apprentice_1',
  'apprentice_2',
];

/** What a place asks of the person in it. Both apprentice places ask the same. */
export type StandbyCategory = 'main' | 'helper' | 'apprentice';

/** The two kinds of swap the workflow allows. A helper's place is not swapped this way. */
export type StandbySwapKind = 'main' | 'apprentice';

export interface StandbyEligibility {
  readonly userId: UserId;
  readonly main: boolean;
  readonly helper: boolean;
  readonly apprentice: boolean;
  readonly updatedBy: UserId | null;
  readonly updatedAt: IsoDateTime;
}

export interface StandbyAssignment {
  readonly position: StandbyPosition;
  /** Null: the place is not filled yet. */
  readonly userId: UserId | null;
  readonly assignedBy: UserId | null;
  readonly assignedAt: IsoDateTime | null;
}

/**
 * Draft weeks are the office's working copy and only the office sees them.
 * Published weeks are the calendar everyone works to. Publishing is one-way.
 */
export type StandbyWeekStatus = 'draft' | 'published';

export interface StandbyWeek {
  readonly id: string;
  /** Always a Monday. */
  readonly weekStart: IsoDate;
  readonly status: StandbyWeekStatus;
  readonly publishedBy: UserId | null;
  readonly publishedAt: IsoDateTime | null;
  readonly createdBy: UserId | null;
  readonly createdAt: IsoDateTime;
  /** Always all four places, in `STANDBY_POSITIONS` order; an empty one has a null user. */
  readonly assignments: readonly StandbyAssignment[];
}

export type StandbySwapStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/**
 * A request to exchange ONE place between two people in two weeks.
 *
 * It names both sides exactly — who, which week, which place — so approval can
 * check that each place is still held by the person the request says, and
 * exchange those two places and nothing else. Once decided or cancelled it is
 * history and never changes (the database refuses it too).
 */
export interface StandbySwapRequest {
  readonly id: string;
  readonly kind: StandbySwapKind;
  readonly requesterId: UserId;
  readonly requesterWeekStart: IsoDate;
  readonly requesterPosition: StandbyPosition;
  readonly counterpartId: UserId;
  readonly counterpartWeekStart: IsoDate;
  readonly counterpartPosition: StandbyPosition;
  readonly reason: string;
  readonly status: StandbySwapStatus;
  readonly requestedAt: IsoDateTime;
  readonly decidedBy: UserId | null;
  readonly decidedAt: IsoDateTime | null;
  readonly decisionNote: string;
  readonly cancelledAt: IsoDateTime | null;
}

/**
 * ONE DAY'S PLACE HELD BY SOMEBODY OTHER THAN THE WEEK'S ASSIGNEE.
 * STANDBY-DAY-1 (2 November 2026).
 *
 * The weekly schedule is unchanged: a week still has its four places. A day
 * swap, once the Office approves it, writes one of these for each day it moved
 * — so on that DATE that PLACE is held by `userId`, and every other day of
 * the week, and every other place, is exactly as the week says. Only an
 * approved day swap writes one; it is never deleted.
 */
export interface StandbyDayOverride {
  readonly date: IsoDate;
  readonly position: StandbyPosition;
  readonly userId: UserId;
  /** The approved day swap that moved it. */
  readonly swapId: string;
  readonly updatedAt: IsoDateTime;
}

/**
 * A DAY SWAP'S STAGES. STANDBY-DAY-1. The person asked approves or denies
 * first; only then does the Office approve or reject; only the Office's
 * approval changes the calendar. Withdrawn: by the requester, before the
 * person asked has answered.
 */
export type StandbyDaySwapStatus = 'awaiting_recipient' | 'awaiting_office' | 'approved' | 'denied' | 'rejected' | 'withdrawn';

export const STANDBY_DAY_SWAP_ACTIVE: readonly StandbyDaySwapStatus[] = ['awaiting_recipient', 'awaiting_office'];

/**
 * One exchange of days: the requester gives their `requesterPosition` on
 * `requesterDate` to the recipient, and takes the recipient's
 * `recipientPosition` on `recipientDate`. Both places are of the swap's kind.
 */
export interface StandbyDayPair {
  readonly requesterDate: IsoDate;
  readonly requesterPosition: StandbyPosition;
  readonly recipientDate: IsoDate;
  readonly recipientPosition: StandbyPosition;
}

export interface StandbyDaySwap {
  readonly id: string;
  readonly kind: StandbySwapKind;
  readonly requesterId: UserId;
  readonly recipientId: UserId;
  /** One or more pairs; all of them change, or none. */
  readonly pairs: readonly StandbyDayPair[];
  readonly reason: string;
  readonly status: StandbyDaySwapStatus;
  readonly requestedAt: IsoDateTime;
  readonly recipientDecidedAt: IsoDateTime | null;
  readonly recipientNote: string;
  readonly officeDecidedBy: UserId | null;
  readonly officeDecidedAt: IsoDateTime | null;
  readonly officeNote: string;
  readonly withdrawnAt: IsoDateTime | null;
}
