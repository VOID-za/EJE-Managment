import {
  TIMESHEET_CORRECTION_MAX_LINES,
  TIMESHEET_CORRECTION_REASON_LIMIT,
  TIMESHEET_MAX_HOURS_PER_DAY,
  TIMESHEET_PERIOD_COMMENT_LIMIT,
  asUserId,
  can,
  userFullName,
  type IsoDate,
  type IsoDateTime,
  type TimesheetCorrection,
  type TimesheetEntry,
  type TimesheetSubmissionSnapshot,
  type UserId,
} from '@/domain';
import { formatPeriod } from '@/lib/timesheet-dates';
import type { OperationContext } from './context';
import { audit, notify, notifyOffice } from './audit';
import { WorkflowError } from './errors';
import { isCalendarDate } from './attendance-operations';
import {
  correctionView,
  describeCorrectionChanges,
  normaliseTimesheetLine,
  versionInForce,
  type TimesheetCorrectionView,
  type TimesheetEntryInput,
} from './timesheets';

/**
 * CORRECTING A TIMESHEET ALREADY SENT TO THE OFFICE. TS-16 (29 October 2026).
 *
 * A sent timesheet is the record of what was sent, and stays exactly that: its
 * period and snapshot are never changed, here or by anything else (the
 * database refuses it). A mistake in it is put right by a CORRECTION — a
 * separate record, linked to that one period:
 *
 *   1. ASK. The technician whose timesheet it is — and only they — asks, with a
 *      REASON and the COMPLETE corrected version: every line of the period and
 *      its comment. Each line obeys exactly the rules of the timesheet itself
 *      (`normaliseTimesheetLine`), stays inside the period's own days, and no
 *      day exceeds 24 hours. The correction records the version it corrects
 *      (the version in force: the original, or the correction last accepted)
 *      beside the corrected one, so the record is a complete before and after.
 *      One correction may wait at a time per period; a retry, a double tap or
 *      a second tab cannot open two (and the database refuses it too).
 *   2. DECIDE. The office — a Master or a Coordinator (`timesheets.reviewCorrections`),
 *      never the person who asked — accepts it, or rejects it with a note. A
 *      decision is taken once and never reversed. An accepted correction
 *      becomes the version in force; a rejected one changes nothing.
 *
 * A correction has no dates of its own: it covers exactly its period's days,
 * so it cannot create a period, overlap one, or send a day twice. The From/To
 * rules — inclusive, at most 92 days, no future To, one send per period — are
 * the period's and are untouched.
 *
 * Everyone is told: the office when one is asked for, the technician when it
 * is decided — in-app, after the record is saved. Everything is audited.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

export interface TimesheetCorrectionInput {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly comment: string;
  /**
   * The COMPLETE corrected period: every line. A line that corrects one of the
   * version in force names it by `entryId` (its NT and old call-out count are
   * carried); a line without one is new.
   */
  readonly lines: readonly TimesheetEntryInput[];
}

/** The office's list of corrections waiting for a decision. */
export interface PendingTimesheetCorrection {
  readonly id: string;
  readonly technicianId: UserId;
  readonly technicianName: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly periodLabel: string;
  readonly sequence: number;
  readonly requestedAt: IsoDateTime;
  readonly reason: string;
}

const sameVersion = (
  a: Pick<TimesheetSubmissionSnapshot, 'comment' | 'entries'>,
  b: Pick<TimesheetSubmissionSnapshot, 'comment' | 'entries'>,
): boolean => describeCorrectionChanges(a, b).length === 0;

const findSentPeriod = async (context: OperationContext, technicianId: UserId, from: string, to: string) => {
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw refuse('That is not a date range.', 'invalid_date', 'Give both days as YYYY-MM-DD.');
  }
  const period = await context.repos.attendance.findPeriod(technicianId, from, to);
  if (period === null || period.submittedAt === null || period.snapshot === null) {
    throw refuse(
      `The timesheet for ${formatPeriod(from, to)} has not been sent to the office.`,
      'timesheet_not_sent',
      'Only a timesheet sent to the office is corrected this way. A draft is changed on the timesheet itself.',
    );
  }
  return period;
};

/**
 * ASK FOR A CORRECTION of one's own sent timesheet. Returns the correction,
 * pending the office's decision.
 */
export const requestTimesheetCorrection = async (
  context: OperationContext,
  technicianId: string,
  input: TimesheetCorrectionInput,
): Promise<TimesheetCorrectionView> => {
  const id = asUserId(technicianId);
  // The owner is the session's own user, never a value in the request.
  if (context.actor.id !== id) {
    throw refuse(
      'You can only ask to correct your own timesheet.',
      'not_permitted',
      'The technician whose timesheet it is asks for its correction; the office decides.',
    );
  }
  const period = await findSentPeriod(context, id, input.from, input.to);
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw refuse('Say why the timesheet needs correcting.', 'correction_reason_required', 'The reason is part of the record.');
  }
  if (reason.length > TIMESHEET_CORRECTION_REASON_LIMIT) {
    throw refuse('That reason is too long.', 'correction_reason_too_long', `Keep it to ${TIMESHEET_CORRECTION_REASON_LIMIT} characters.`);
  }
  const comment = input.comment.trim();
  if (comment.length > TIMESHEET_PERIOD_COMMENT_LIMIT) {
    throw refuse('That comment is too long.', 'comment_too_long', `Keep it to ${TIMESHEET_PERIOD_COMMENT_LIMIT} characters.`);
  }
  if (!Array.isArray(input.lines) || input.lines.length > TIMESHEET_CORRECTION_MAX_LINES) {
    throw refuse('That correction has too many lines.', 'correction_too_many_lines', `At most ${TIMESHEET_CORRECTION_MAX_LINES}.`);
  }

  const corrections = await context.repos.attendance.listCorrections(period.id);
  if (corrections.some((correction) => correction.status === 'pending')) {
    throw refuse(
      'A correction of this timesheet is already waiting for the office.',
      'correction_pending',
      'The office decides it first; then another can be asked for if it is still needed.',
    );
  }
  const before = versionInForce(period, corrections).snapshot;
  const beforeLines = new Map(before.entries.map((entry) => [entry.id, entry]));
  const now = context.services.clock.now();

  const used = new Set<string>();
  const lines: TimesheetEntry[] = [];
  for (const line of input.lines) {
    if (!isCalendarDate(line.date) || line.date < period.from || line.date > period.to) {
      throw refuse(
        `A corrected line must fall inside ${formatPeriod(period.from, period.to)}.`,
        'correction_outside_period',
        'A correction covers exactly the days of the timesheet that was sent.',
      );
    }
    const corrects = line.entryId === undefined ? null : beforeLines.get(line.entryId) ?? null;
    if (line.entryId !== undefined && (corrects === null || used.has(line.entryId))) {
      throw refuse('That line is not on the timesheet being corrected.', 'entry_not_found', 'Reload the timesheet.');
    }
    if (corrects !== null) used.add(corrects.id);
    const values = await normaliseTimesheetLine(context, line, corrects);
    lines.push({
      ...values,
      id: corrects?.id ?? context.services.ids.next('tse'),
      userId: id,
      date: line.date,
      // An unchanged line keeps who wrote it and when; a changed or new one is the correction's.
      updatedBy: context.actor.id,
      updatedAt: corrects?.updatedAt ?? now,
    });
  }
  const byDay = new Map<string, number>();
  for (const line of lines) {
    byDay.set(line.date, (byDay.get(line.date) ?? 0) + line.normalHours + line.overtimeHours + line.doubleHours);
  }
  for (const [date, total] of byDay) {
    if (total > TIMESHEET_MAX_HOURS_PER_DAY + 1e-9) {
      throw refuse('That day would have more than 24 hours.', 'day_over_24_hours', `The lines for ${date} would add up to ${total} hours.`);
    }
  }
  // Lines carried over unchanged keep their original record exactly.
  const after: TimesheetSubmissionSnapshot = {
    technicianName: before.technicianName,
    from: period.from,
    to: period.to,
    comment,
    entries: lines
      .map((line) => {
        const original = beforeLines.get(line.id);
        return original !== undefined && describeCorrectionChanges({ comment: '', entries: [original] }, { comment: '', entries: [line] }).length === 0
          ? original
          : line;
      })
      .sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt)),
  };
  if (sameVersion(before, after)) {
    throw refuse('Nothing was changed.', 'correction_unchanged', 'Change a line or the comment, or cancel.');
  }

  const sequence = corrections.reduce((max, correction) => Math.max(max, correction.sequence), 0) + 1;
  const saved = await context.repos.attendance.createCorrection({
    id: context.services.ids.next('tsc'),
    periodId: period.id,
    userId: id,
    sequence,
    reason,
    before,
    after,
    requestedBy: context.actor.id,
    requestedAt: now,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: '',
  });
  if (saved === null) {
    throw refuse(
      'A correction of this timesheet is already waiting for the office.',
      'correction_pending',
      'The office decides it first; then another can be asked for if it is still needed.',
    );
  }
  const label = formatPeriod(period.from, period.to);
  const changes = describeCorrectionChanges(before, after);
  await audit(context, {
    jobId: null,
    type: 'timesheet_correction_requested',
    summary: `Timesheet correction ${sequence} asked for: ${userFullName(context.actor)}, ${label}`,
    detail: `Reason: ${reason}\n${changes.join('\n')}`,
    changes: changes.map((change) => ({ field: `Correction ${sequence}`, from: '', to: change })),
  });
  await notifyOffice(context, {
    type: 'timesheet_correction_requested',
    title: `${userFullName(context.actor)} asked to correct a sent timesheet`,
    body: `Period: ${label}\nReason: ${reason}\nOpen Timesheets to accept or reject it.`,
    link: '/timesheets',
  });
  return correctionView(context, saved);
};

/**
 * THE OFFICE'S DECISION: accept, or reject with a note. Once; never by the
 * person who asked. Recorded only while the correction is still pending, so a
 * second decision — a retry, another tab, the other office user — is refused.
 */
export const decideTimesheetCorrection = async (
  context: OperationContext,
  technicianId: string,
  correctionId: string,
  input: { readonly decision: 'accept' | 'reject'; readonly note?: string | undefined },
): Promise<TimesheetCorrectionView> => {
  if (!can(context.actor.role, 'timesheets.reviewCorrections')) {
    throw refuse(
      'Only the office decides a timesheet correction.',
      'not_permitted',
      'A Master or a Coordinator accepts or rejects it.',
    );
  }
  if (input.decision !== 'accept' && input.decision !== 'reject') {
    throw refuse('Accept or reject the correction.', 'invalid_decision', 'The decision is accept or reject.');
  }
  const id = asUserId(technicianId);
  const correction = await context.repos.attendance.findCorrection(correctionId);
  if (correction === null || correction.userId !== id) {
    throw refuse('That correction does not exist.', 'correction_not_found', 'Reload the timesheet.');
  }
  if (correction.requestedBy === context.actor.id) {
    throw refuse(
      'You cannot decide a correction you asked for.',
      'correction_own_request',
      'Somebody else in the office decides it.',
    );
  }
  const note = (input.note ?? '').trim();
  if (note.length > TIMESHEET_CORRECTION_REASON_LIMIT) {
    throw refuse('That note is too long.', 'decision_note_too_long', `Keep it to ${TIMESHEET_CORRECTION_REASON_LIMIT} characters.`);
  }
  if (input.decision === 'reject' && note.length === 0) {
    throw refuse('Say why the correction is rejected.', 'rejection_note_required', 'The technician is told why.');
  }
  const decided = correction.status === 'pending'
    ? await context.repos.attendance.decideCorrection({
        id: correction.id,
        status: input.decision === 'accept' ? 'accepted' : 'rejected',
        decidedBy: context.actor.id,
        decidedAt: context.services.clock.now(),
        decisionNote: note,
      })
    : null;
  if (decided === null) {
    throw refuse(
      'This correction has already been decided.',
      'correction_decided',
      'A decision is taken once. Reload the timesheet to see it.',
    );
  }
  const technician = await context.repos.users.findById(id);
  const name = technician === null ? 'the technician' : userFullName(technician);
  const label = formatPeriod(correction.after.from, correction.after.to);
  const accepted = decided.status === 'accepted';
  await audit(context, {
    jobId: null,
    type: accepted ? 'timesheet_correction_accepted' : 'timesheet_correction_rejected',
    summary: `Timesheet correction ${decided.sequence} ${accepted ? 'accepted' : 'rejected'}: ${name}, ${label}`,
    detail: `${accepted ? 'Accepted' : 'Rejected'} by ${userFullName(context.actor)}.${note.length > 0 ? ` Note: ${note}` : ''}${accepted ? ' It is now the version in force; the original submission is kept unchanged.' : ' The version in force is unchanged.'}`,
    changes: [{ field: `Correction ${decided.sequence}`, from: 'Pending', to: accepted ? 'Accepted' : 'Rejected' }],
  });
  await notify(context, {
    recipientId: id,
    type: 'timesheet_correction_decided',
    title: `Your timesheet correction was ${accepted ? 'accepted' : 'rejected'}`,
    body: `Period: ${label}\nCorrection ${decided.sequence}, ${accepted ? 'accepted' : 'rejected'} by ${userFullName(context.actor)}.${note.length > 0 ? `\nNote: ${note}` : ''}`,
    link: '/timesheets',
  });
  return correctionView(context, decided);
};

/** Every correction waiting for the office. The office only. */
export const listPendingTimesheetCorrections = async (
  context: OperationContext,
): Promise<readonly PendingTimesheetCorrection[]> => {
  if (!can(context.actor.role, 'timesheets.reviewCorrections')) return [];
  const pending: readonly TimesheetCorrection[] = await context.repos.attendance.listPendingCorrections();
  return Promise.all(
    pending.map(async (correction) => {
      const technician = await context.repos.users.findById(correction.userId);
      return {
        id: correction.id,
        technicianId: correction.userId,
        technicianName: technician === null ? correction.after.technicianName : userFullName(technician),
        from: correction.after.from,
        to: correction.after.to,
        periodLabel: formatPeriod(correction.after.from, correction.after.to),
        sequence: correction.sequence,
        requestedAt: correction.requestedAt,
        reason: correction.reason,
      };
    }),
  );
};
