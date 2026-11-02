import {
  ABSENCE_REASON_LABELS,
  ATTENDANCE_NOTE_LIMIT,
  ATTENDANCE_STATUSES,
  asUserId,
  isAbsenceReason,
  userFullName,
  type AbsenceReason,
  type AttendanceRecord,
  type AttendanceStatus,
  type IsoDate,
} from '@/domain';
import { businessToday } from '@/lib/business-time';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * ATTENDANCE. ATTEND-1, ATTEND-2; OWNERSHIP SINCE 1 NOVEMBER 2026 (ATT-OWN-1).
 *
 * Who was at work on a day: present or absent, one record per person per day.
 * EVERY PERSON RECORDS ONLY THEIR OWN DAYS — Technician, Coordinator and Master
 * alike. The office's Team register, where a Master or a Coordinator recorded
 * anybody's day, was withdrawn by the tester on 1 November 2026: nobody
 * creates, edits or submits another person's attendance, and that is refused
 * here, against the session, whatever the screen sends. The office READS
 * everybody's attendance (`attendance.viewAll`) on EJE Monthly Forms, and
 * exports it.
 *
 * A correction updates the day's record and the audit trail keeps what it said
 * before. Kept apart from planned leave and from jobs: neither is touched.
 */

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/** A real calendar date in YYYY-MM-DD, not merely the right shape. */
export const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/**
 * A day the register may hold: real, and not after today on EJE's clock. Who
 * was at work tomorrow is not yet a fact.
 */
export const assertRecordableDate = (date: string, today: IsoDate): void => {
  if (!isCalendarDate(date)) {
    throw refuse('That is not a date.', 'invalid_date', 'Give the day as YYYY-MM-DD.');
  }
  if (date > today) {
    throw refuse(
      'Attendance cannot be recorded for a day that has not happened.',
      'date_in_future',
      `Today is ${today}. Record the day on or after it happens.`,
    );
  }
};

/**
 * WHO MAY RECORD A DAY: THE PERSON THEMSELVES, AND NOBODY ELSE. ATT-OWN-1 (the
 * tester, 1 November 2026), replacing the office's right to record or correct
 * anybody's day (ATTEND-1, ATTEND-2). No role is exempt — a Master or a
 * Coordinator is refused another person's day exactly as a technician is. The
 * person is checked against the session, never taken on trust from the request.
 */
const assertMayRecordFor = (context: OperationContext, userId: string): void => {
  if (context.actor.id === userId) return;
  throw refuse(
    'You can only record your own attendance.',
    'not_permitted',
    'Each person records their own days. The office reads everybody’s on EJE Monthly Forms but cannot change them.',
  );
};

const statusLabel = (status: AttendanceStatus): string =>
  status === 'present' ? 'Present' : 'Absent';

const reasonLabel = (reason: AbsenceReason | null): string =>
  reason === null ? 'Not recorded' : ABSENCE_REASON_LABELS[reason];

export interface AttendanceInput {
  readonly userId: string;
  readonly date: string;
  readonly status: AttendanceStatus;
  /**
   * ATT-01. Required, and one of the four, when the day is absent; must be
   * absent (or null) when the day is present.
   */
  readonly absenceReason?: string | null | undefined;
  readonly note: string;
  /**
   * WHAT THE SCREEN BELIEVED THE DAY SAID, for a save made without anybody
   * pressing a button (ATT-AUTO-1, the tester, 31 October 2026): the
   * `recordedAt` of the record it was looking at, or null for "no record".
   * When given and the day has since been recorded by somebody else, the save
   * is refused (`attendance_changed`) instead of overwriting the newer answer
   * with the screen's stale one. Left out, a save behaves as it always has.
   */
  readonly expectedRecordedAt?: string | null | undefined;
}

/**
 * Records a person's day, or corrects it.
 *
 * Never a second row: the day's existing record is updated. An identical
 * answer changes nothing and writes nothing to the trail.
 */
export const recordAttendance = async (
  context: OperationContext,
  input: AttendanceInput,
): Promise<AttendanceRecord> => {
  assertMayRecordFor(context, input.userId);
  assertRecordableDate(input.date, businessToday(new Date(context.services.clock.now())));
  /*
   * A SUBMITTED MONTH STAYS EDITABLE. RESUBMIT-1 (the tester, 2 November 2026,
   * replacing ATT-LOCK-1): a person may change their own days after the month
   * was submitted and submit it again; the new submission replaces the old.
   * Nobody else may change them (ATT-OWN-1, above).
   */
  if (!ATTENDANCE_STATUSES.includes(input.status)) {
    throw refuse('That is not an attendance status.', 'invalid_status', 'Choose Present or Absent.');
  }
  /*
   * ATT-01. Checked here, whatever the screen sent: an absent day says why,
   * from exactly the four reasons; a present day carries no reason at all.
   * An absent day recorded BEFORE the reason existed keeps none until somebody
   * records that day again — and then a reason is required like any other.
   */
  const reasonGiven = input.absenceReason ?? null;
  let absenceReason: AbsenceReason | null = null;
  if (input.status === 'absent') {
    if (reasonGiven === null || reasonGiven === '') {
      throw refuse(
        'Choose why you were absent.',
        'absence_reason_required',
        'Leave, Sick Leave, Family Responsibility or IOD (Injury on Duty).',
      );
    }
    if (!isAbsenceReason(reasonGiven)) {
      throw refuse(
        'That is not an absence reason.',
        'invalid_absence_reason',
        'Choose Leave, Sick Leave, Family Responsibility or IOD (Injury on Duty).',
      );
    }
    absenceReason = reasonGiven;
  } else if (reasonGiven !== null && reasonGiven !== '') {
    throw refuse(
      'A present day has no absence reason.',
      'absence_reason_not_applicable',
      'Choose Absent to give a reason.',
    );
  }
  const note = input.note.trim();
  if (note.length > ATTENDANCE_NOTE_LIMIT) {
    throw refuse(
      'That note is too long.',
      'note_too_long',
      `Keep it to ${ATTENDANCE_NOTE_LIMIT} characters.`,
    );
  }

  const person = await context.repos.users.findById(asUserId(input.userId));
  if (person === null) {
    throw refuse('That person is not a user of the system.', 'unknown_user', 'Reload the register.');
  }
  if (!person.active) {
    throw refuse(
      `${userFullName(person)}'s account is disabled.`,
      'user_inactive',
      'Attendance is recorded for people who are currently on the system.',
    );
  }

  const existing = await context.repos.attendance.findRecord(person.id, input.date);
  if (
    existing !== null &&
    existing.status === input.status &&
    existing.absenceReason === absenceReason &&
    existing.note === note
  ) {
    return existing;
  }

  /*
   * A STALE SCREEN NEVER OVERWRITES A NEWER ANSWER (ATT-AUTO-1). Asked only
   * when the screen said what it expected, and only once the answer differs —
   * repeating what the day already says is never a conflict.
   */
  if (input.expectedRecordedAt !== undefined && (existing?.recordedAt ?? null) !== input.expectedRecordedAt) {
    throw refuse(
      `${userFullName(person)}'s attendance for ${input.date} was changed by somebody else.`,
      'attendance_changed',
      existing === null
        ? 'The day was cleared since you opened it. Reload and choose again.'
        : `It now says ${statusLabel(existing.status)}${existing.absenceReason === null ? '' : ` — ${reasonLabel(existing.absenceReason)}`}. The latest answer is shown; choose again if it is wrong.`,
    );
  }

  const now = context.services.clock.now();
  const saved = await context.repos.attendance.saveRecord({
    id: existing?.id ?? context.services.ids.next('att'),
    userId: person.id,
    date: input.date,
    status: input.status,
    absenceReason,
    note,
    recordedBy: context.actor.id,
    recordedAt: now,
  });

  const name = userFullName(person);
  if (existing === null) {
    await audit(context, {
      jobId: null,
      type: 'attendance_recorded',
      summary: `Attendance: ${name} ${statusLabel(saved.status).toLowerCase()} on ${saved.date}`,
      detail:
        `Recorded by ${userFullName(context.actor)}` +
        (saved.absenceReason === null ? '' : ` — reason: ${reasonLabel(saved.absenceReason)}`) +
        (note.length > 0 ? ` — "${note}".` : '.'),
    });
  } else {
    const changes = [
      ...(existing.status === saved.status
        ? []
        : [{ field: 'Attendance', from: statusLabel(existing.status), to: statusLabel(saved.status) }]),
      ...(existing.absenceReason === saved.absenceReason
        ? []
        : [{ field: 'Absence reason', from: reasonLabel(existing.absenceReason), to: reasonLabel(saved.absenceReason) }]),
      ...(existing.note === saved.note
        ? []
        : [{ field: 'Note', from: existing.note || '—', to: saved.note || '—' }]),
    ];
    await audit(context, {
      jobId: null,
      type: 'attendance_corrected',
      summary: `Attendance corrected: ${name} on ${saved.date}`,
      detail: `Corrected by ${userFullName(context.actor)}.`,
      changes,
    });
  }
  return saved;
};

/** One of the person's own days: recorded (present or absent), or not yet. ATTEND-2. */
export interface MyAttendanceDay {
  readonly date: IsoDate;
  readonly record: AttendanceRecord | null;
}

export interface MyAttendance {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly today: IsoDate;
  /** Newest first, every day in the range. */
  readonly days: readonly MyAttendanceDay[];
  readonly unrecorded: number;
}

/**
 * The signed-in person's OWN days, recorded or not. ATTEND-2.
 *
 * Nothing is inferred: a day nobody marked is shown as not recorded, whatever
 * jobs, logins or timesheet lines exist for it. Never another person's days.
 */
export const loadMyAttendance = async (
  context: OperationContext,
  from: string,
  to: string,
): Promise<MyAttendance> => {
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw refuse('That is not a date range.', 'invalid_date', 'Give both days as YYYY-MM-DD.');
  }
  if (from > to) {
    throw refuse('The range ends before it starts.', 'invalid_range', 'Choose a start on or before the end.');
  }
  const today = businessToday(new Date(context.services.clock.now()));
  const last = to > today ? today : to;
  const span = (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (span > ATTENDANCE_EXPORT_MAX_DAYS) {
    throw refuse('That range is too long.', 'range_too_long', `Choose at most ${ATTENDANCE_EXPORT_MAX_DAYS} days.`);
  }
  const records = from > last ? [] : await context.repos.attendance.listRecords(from, last, context.actor.id);
  const byDate = new Map(records.map((record) => [record.date, record]));
  const days: MyAttendanceDay[] = [];
  // ATT-ORDER-1 (the tester, 2 November 2026): oldest first, newest last — across months too.
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${last}T00:00:00Z`); at += 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    days.push({ date, record: byDate.get(date) ?? null });
  }
  return { from, to: last, today, days, unrecorded: days.filter((day) => day.record === null).length };
};

export const ATTENDANCE_EXPORT_MAX_DAYS = 92;


