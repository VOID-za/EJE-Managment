import {
  ABSENCE_REASON_LABELS,
  ATTENDANCE_NOTE_LIMIT,
  ATTENDANCE_STATUSES,
  asUserId,
  availabilityTypeLabel,
  isAbsenceReason,
  can,
  userFullName,
  type AbsenceReason,
  type AttendanceRecord,
  type AttendanceStatus,
  type AvailabilityType,
  type IsoDate,
  type User,
  type UserId,
} from '@/domain';
import { businessToday } from '@/lib/business-time';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * THE ATTENDANCE REGISTER. ATTEND-1.
 *
 * Who was at work on a day: present or absent, one record per person per day,
 * recorded and corrected by the office (`attendance.manage`). A correction
 * updates the day's record and the audit trail keeps what it said before.
 *
 * Kept apart from planned leave and from jobs. The register SHOWS the leave
 * booked for a day beside each person, because that is what the office checks
 * against, but recording attendance never changes the leave record — and
 * neither of them touches a job.
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

const assertManages = (context: OperationContext): void => {
  if (can(context.actor.role, 'attendance.manage')) return;
  throw refuse(
    'Only the office records attendance.',
    'not_permitted',
    'A Master or a Coordinator records who was at work.',
  );
};

/**
 * WHO MAY RECORD A DAY. ATTEND-2, the owner's instruction of 27 October 2026:
 * attendance is entirely manual and each technician marks THEMSELVES present or
 * absent, daily or catching up later (payday). The office may still record or
 * correct anybody's day (`attendance.manage`). Nobody else may touch another
 * person's attendance — the person is checked against the session, never
 * taken on trust from the request.
 */
const assertMayRecordFor = (context: OperationContext, userId: string): void => {
  if (can(context.actor.role, 'attendance.manage')) return;
  if (context.actor.id === userId) return;
  throw refuse(
    'You can only record your own attendance.',
    'not_permitted',
    'Each person marks their own days; the office records or corrects anybody’s.',
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

export interface RegisterRow {
  readonly user: Pick<User, 'id' | 'firstName' | 'lastName' | 'role' | 'jobTitle'>;
  readonly record: AttendanceRecord | null;
  /** Who recorded it, by name — the register says who answered for the day. */
  readonly recordedByName: string | null;
  /** Planned leave booked over this day, for reference only. Never changed here. */
  readonly plannedLeave: readonly { readonly type: AvailabilityType; readonly label: string }[];
}

export interface AttendanceRegister {
  readonly date: IsoDate;
  readonly today: IsoDate;
  readonly rows: readonly RegisterRow[];
  readonly present: number;
  readonly absent: number;
  readonly unrecorded: number;
}

const ROLE_ORDER: Record<User['role'], number> = { technician: 0, coordinator: 1, master: 2 };

/** The register for one day: everybody on the system, and what is recorded for them. */
export const loadAttendanceRegister = async (
  context: OperationContext,
  date: string,
): Promise<AttendanceRegister> => {
  assertManages(context);
  const today = businessToday(new Date(context.services.clock.now()));
  if (!isCalendarDate(date)) {
    throw refuse('That is not a date.', 'invalid_date', 'Give the day as YYYY-MM-DD.');
  }
  const [users, records, availability] = await Promise.all([
    context.repos.users.list(),
    context.repos.attendance.listRecords(date, date),
    context.repos.availability.list(date, date),
  ]);
  const byId = new Map<UserId, User>(users.map((user) => [user.id, user]));
  const recorded = new Map(records.map((record) => [record.userId, record]));

  const rows: RegisterRow[] = users
    // Everybody on the system, plus anybody since disabled who has a record
    // for this day — history must still read.
    .filter((user) => user.active || recorded.has(user.id))
    .sort(
      (a, b) =>
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        a.firstName.localeCompare(b.firstName) ||
        a.lastName.localeCompare(b.lastName),
    )
    .map((user) => {
      const record = recorded.get(user.id) ?? null;
      const recorder = record === null ? undefined : byId.get(record.recordedBy);
      return {
        user: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          jobTitle: user.jobTitle,
        },
        record,
        recordedByName: recorder === undefined ? null : userFullName(recorder),
        plannedLeave: availability
          .filter(
            (entry) =>
              entry.userId === user.id &&
              entry.status === 'active' &&
              entry.startDate <= date &&
              entry.endDate >= date,
          )
          .map((entry) => ({ type: entry.type, label: availabilityTypeLabel(entry.type) })),
      };
    });

  return {
    date,
    today,
    rows,
    present: rows.filter((row) => row.record?.status === 'present').length,
    absent: rows.filter((row) => row.record?.status === 'absent').length,
    unrecorded: rows.filter((row) => row.record === null).length,
  };
};

/** The longest range one attendance export covers: a quarter, as a timesheet. */
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
  for (let at = Date.parse(`${last}T00:00:00Z`); at >= Date.parse(`${from}T00:00:00Z`); at -= 86_400_000) {
    const date = new Date(at).toISOString().slice(0, 10);
    days.push({ date, record: byDate.get(date) ?? null });
  }
  return { from, to: last, today, days, unrecorded: days.filter((day) => day.record === null).length };
};

export const ATTENDANCE_EXPORT_MAX_DAYS = 92;

export interface AttendanceExportRow {
  readonly date: IsoDate;
  readonly person: string;
  readonly role: string;
  readonly status: AttendanceStatus;
  /** ATT-01: the reason's label, blank for present and for an absent day from before. */
  readonly absenceReason: string;
  readonly note: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly plannedLeave: string;
}

/**
 * THE REGISTER AS A SPREADSHEET, for a date range. ATTEND-1, reporting.
 *
 * One row per RECORDED person-day — what was recorded, by whom and when, and
 * any planned leave booked over that day beside it for reference. A day nobody
 * recorded is not invented as "absent": it is simply not in the file, which is
 * the truth about it. The office's, like the register itself.
 */
export const loadAttendanceExport = async (
  context: OperationContext,
  from: string,
  to: string,
): Promise<readonly AttendanceExportRow[]> => {
  assertManages(context);
  if (!isCalendarDate(from) || !isCalendarDate(to)) {
    throw refuse('That is not a date range.', 'invalid_date', 'Give both days as YYYY-MM-DD.');
  }
  if (from > to) {
    throw refuse('The range ends before it starts.', 'invalid_range', 'Choose a start on or before the end.');
  }
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > ATTENDANCE_EXPORT_MAX_DAYS) {
    throw refuse(
      'That range is too long for one export.',
      'range_too_long',
      `An attendance export covers at most ${ATTENDANCE_EXPORT_MAX_DAYS} days.`,
    );
  }
  const [users, records, availability] = await Promise.all([
    context.repos.users.list(),
    context.repos.attendance.listRecords(from, to),
    context.repos.availability.list(from, to),
  ]);
  const byId = new Map<UserId, User>(users.map((user) => [user.id, user]));
  return records.map((record) => {
    const person = byId.get(record.userId);
    const recorder = byId.get(record.recordedBy);
    return {
      date: record.date,
      person: person === undefined ? 'Unknown person' : userFullName(person),
      role: person === undefined ? '' : person.jobTitle || person.role,
      status: record.status,
      absenceReason: record.absenceReason === null ? '' : ABSENCE_REASON_LABELS[record.absenceReason],
      note: record.note,
      recordedBy: recorder === undefined ? '' : userFullName(recorder),
      recordedAt: record.recordedAt,
      plannedLeave: availability
        .filter(
          (entry) =>
            entry.userId === record.userId &&
            entry.status === 'active' &&
            entry.startDate <= record.date &&
            entry.endDate >= record.date,
        )
        .map((entry) => availabilityTypeLabel(entry.type))
        .join('; '),
    };
  });
};
