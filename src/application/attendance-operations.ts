import {
  ATTENDANCE_NOTE_LIMIT,
  ATTENDANCE_STATUSES,
  asUserId,
  availabilityTypeLabel,
  can,
  userFullName,
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

const statusLabel = (status: AttendanceStatus): string =>
  status === 'present' ? 'Present' : 'Absent';

export interface AttendanceInput {
  readonly userId: string;
  readonly date: string;
  readonly status: AttendanceStatus;
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
  assertManages(context);
  assertRecordableDate(input.date, businessToday(new Date(context.services.clock.now())));
  if (!ATTENDANCE_STATUSES.includes(input.status)) {
    throw refuse('That is not an attendance status.', 'invalid_status', 'Choose Present or Absent.');
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
  if (existing !== null && existing.status === input.status && existing.note === note) {
    return existing;
  }

  const now = context.services.clock.now();
  const saved = await context.repos.attendance.saveRecord({
    id: existing?.id ?? context.services.ids.next('att'),
    userId: person.id,
    date: input.date,
    status: input.status,
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
        `Recorded by ${userFullName(context.actor)}` + (note.length > 0 ? ` — "${note}".` : '.'),
    });
  } else {
    const changes = [
      ...(existing.status === saved.status
        ? []
        : [{ field: 'Attendance', from: statusLabel(existing.status), to: statusLabel(saved.status) }]),
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
