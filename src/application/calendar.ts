import {
  availabilityTimeLabel,
  availabilityTypeLabel,
  isBlockingAvailability,
  isJobInactive,
  jobScheduleWindow,
  machineDisplayName,
  userFullName,
  type AvailabilityRecord,
  type AvailabilityStatus,
  type AvailabilityType,
  type IsoDate,
  type Job,
  type JobPriority,
  type JobStatus,
  type JobTypeCode,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import { can } from '@/domain';
import { loadVisibleJobs } from './job-view';

/**
 * Calendar data.
 *
 * Assembled here rather than in the calendar screen so the views stay pure
 * rendering, and so the same shape can later be served by a single API call. A
 * calendar entry is either scheduled work or a technician being unavailable —
 * those are the two things a planner needs to see together.
 */

export interface CalendarRange {
  /** Inclusive. */
  readonly from: IsoDate;
  /** Inclusive. */
  readonly to: IsoDate;
}

interface CalendarEntryBase {
  readonly id: string;
  /** Inclusive start and end, so a single-day entry has start === end. */
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly days: number;
  readonly title: string;
  readonly subtitle: string;
}

export interface JobCalendarEntry extends CalendarEntryBase {
  readonly kind: 'job';
  readonly jobNumber: string;
  readonly jobType: JobTypeCode;
  readonly status: JobStatus;
  readonly priority: JobPriority;
  readonly customerName: string;
  readonly siteName: string;
  readonly machineLabel: string;
  readonly technicianIds: readonly string[];
  readonly technicianNames: readonly string[];
  readonly technicianInitials: readonly string[];
}

export interface AvailabilityCalendarEntry extends CalendarEntryBase {
  readonly kind: 'availability';
  readonly availabilityType: AvailabilityType;
  readonly availabilityStatus: AvailabilityStatus;
  readonly userId: string;
  readonly userName: string;
  readonly userInitials: string;
  readonly blocking: boolean;
  readonly allDay: boolean;
  /** "09:00–11:00" or "All day". */
  readonly timeLabel: string;
  readonly description: string;
}

export type CalendarEntry = JobCalendarEntry | AvailabilityCalendarEntry;

export interface CalendarData {
  readonly entries: readonly CalendarEntry[];
  readonly technicians: readonly User[];
}

const overlapsRange = (start: IsoDate, end: IsoDate, range: CalendarRange): boolean =>
  start <= range.to && end >= range.from;

const daysInclusive = (start: IsoDate, end: IsoDate): number => {
  const from = Date.UTC(
    Number(start.slice(0, 4)),
    Number(start.slice(5, 7)) - 1,
    Number(start.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(end.slice(0, 4)),
    Number(end.slice(5, 7)) - 1,
    Number(end.slice(8, 10)),
  );
  return Math.round((to - from) / 86_400_000) + 1;
};

/** Scheduled jobs and technician absence for a date range. */
/**
 * Who is looking, and therefore how much of the calendar there is.
 *
 * MASTER SCOPE §3.3/§16 give the technician the calendar; DECISION 5 decides
 * which jobs are theirs to see. Passing the viewer in means the two rules meet
 * HERE, while the entries are being built, rather than a screen loading
 * everybody's work and hiding most of it.
 */
export const loadCalendar = async (
  repos: RepositoryBundle,
  range: CalendarRange,
  viewer: User,
): Promise<CalendarData> => {
  const office = can(viewer.role, 'jobs.viewAll');
  const [allJobs, customers, sites, machines, users, availability] = await Promise.all([
    repos.jobs.list(),
    repos.customers.list(),
    // Resolution: a scheduled job keeps naming its site and machine.
    repos.customers.listSites(undefined, { includeArchived: true }),
    repos.machines.list({ includeArchived: true }),
    repos.users.list(),
    repos.availability.list(range.from, range.to),
  ]);

  /*
   * The office plans, so it sees everything. The field sees its own work.
   *
   * `loadVisibleJobs` is the same DECISION 5 reader every other job list uses
   * — not a second opinion written for the calendar — so a technician's
   * calendar and their Jobs screen can never disagree about which jobs exist.
   */
  const jobs = await loadVisibleJobs(repos, allJobs, viewer);

  const jobEntries: JobCalendarEntry[] = [];

  for (const job of jobs) {
    // A cancelled or deleted job is not scheduled work any more, so it never
    // appears as an active calendar bar. Cancelled jobs stay searchable and in
    // job history; only the live schedule drops them.
    if (isJobInactive(job)) continue;

    const window = jobScheduleWindow(job);
    if (window === null) continue;
    if (!overlapsRange(window.start, window.end, range)) continue;

    const machine = machines.find((candidate) => candidate.id === job.machineId);
    const assigned = [job.primaryTechnicianId, ...job.additionalTechnicianIds].filter(
      (id): id is NonNullable<Job['primaryTechnicianId']> => id !== null,
    );
    const assignedUsers = assigned
      .map((id) => users.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is User => candidate !== undefined);

    const customerName =
      customers.find((candidate) => candidate.id === job.customerId)?.name ?? 'Unknown customer';
    const siteName = sites.find((candidate) => candidate.id === job.siteId)?.name ?? '';

    jobEntries.push({
      kind: 'job',
      id: `job-${job.id}`,
      start: window.start,
      end: window.end,
      days: window.days,
      title: `${job.jobNumber} · ${customerName}`,
      subtitle: machine === undefined ? siteName : `${siteName} · ${machineDisplayName(machine)}`,
      jobNumber: job.jobNumber,
      jobType: job.jobType,
      status: job.status,
      priority: job.priority,
      customerName,
      siteName,
      machineLabel: machine === undefined ? '—' : machineDisplayName(machine),
      technicianIds: assignedUsers.map((user) => user.id),
      technicianNames: assignedUsers.map((user) => userFullName(user)),
      technicianInitials: assignedUsers.map((user) => user.initials),
    });
  }

  /*
   * Another technician's sick leave is that person's business.
   *
   * §16 asks for a calendar a technician can work from — their bookings and
   * their own absences — not the staff absence register, which is what the
   * office plans from and `availability.manage` is the capability for.
   */
  const visibleAvailability = office
    ? availability
    : availability.filter((record) => record.userId === viewer.id);

  const availabilityEntries: AvailabilityCalendarEntry[] = visibleAvailability
    .filter((record) => overlapsRange(record.startDate, record.endDate, range))
    .map((record: AvailabilityRecord) => {
      const user = users.find((candidate) => candidate.id === record.userId);
      const timeLabel = availabilityTimeLabel(record);
      return {
        kind: 'availability' as const,
        id: `availability-${record.id}`,
        start: record.startDate,
        end: record.endDate,
        days: daysInclusive(record.startDate, record.endDate),
        title: user === undefined ? availabilityTypeLabel(record.type) : userFullName(user),
        // The time window belongs on the chip: "Appointment" alone does not tell
        // a planner whether the technician is gone for two hours or all day.
        subtitle: `${availabilityTypeLabel(record.type)} · ${timeLabel}`,
        availabilityType: record.type,
        availabilityStatus: record.status,
        userId: record.userId,
        userName: user === undefined ? 'Unknown' : userFullName(user),
        userInitials: user?.initials ?? '—',
        blocking: isBlockingAvailability(record),
        allDay: record.allDay,
        timeLabel,
        description: record.description,
      };
    });

  return {
    // Longest first, so multi-day bars take the upper lanes and short entries
    // slot in beneath them rather than fragmenting the row.
    entries: [...jobEntries, ...availabilityEntries].sort(
      (a, b) => b.days - a.days || a.start.localeCompare(b.start),
    ),
    technicians: users.filter((user) => user.role === 'technician' && user.active),
  };
};

/** Entries that touch a given day. */
export const entriesOn = (
  entries: readonly CalendarEntry[],
  date: IsoDate,
): readonly CalendarEntry[] => entries.filter((entry) => entry.start <= date && entry.end >= date);

/**
 * Technicians booked on two jobs at once on a given day.
 *
 * Surfaced rather than prevented: EJE routinely double-books deliberately, and
 * the planner needs to see it rather than be stopped by it.
 */
export interface ScheduleConflict {
  readonly date: IsoDate;
  readonly technicianId: string;
  readonly technicianName: string;
  readonly entries: readonly CalendarEntry[];
}

export const findConflicts = (
  entries: readonly CalendarEntry[],
  dates: readonly IsoDate[],
): readonly ScheduleConflict[] => {
  const conflicts: ScheduleConflict[] = [];

  for (const date of dates) {
    const onDay = entriesOn(entries, date);
    const byTechnician = new Map<string, { name: string; entries: CalendarEntry[] }>();

    for (const entry of onDay) {
      const assignments =
        entry.kind === 'job'
          ? entry.technicianIds.map((id, index) => ({
              id,
              name: entry.technicianNames[index] ?? 'Unknown',
            }))
          : entry.blocking
            ? [{ id: entry.userId, name: entry.userName }]
            : [];

      for (const assignment of assignments) {
        const bucket = byTechnician.get(assignment.id) ?? { name: assignment.name, entries: [] };
        bucket.entries.push(entry);
        byTechnician.set(assignment.id, bucket);
      }
    }

    for (const [technicianId, bucket] of byTechnician) {
      // Two jobs, or a job while officially unavailable, are both worth flagging.
      const jobCount = bucket.entries.filter((entry) => entry.kind === 'job').length;
      const unavailable = bucket.entries.some(
        (entry) => entry.kind === 'availability' && entry.blocking,
      );
      if (jobCount > 1 || (jobCount > 0 && unavailable)) {
        conflicts.push({
          date,
          technicianId,
          technicianName: bucket.name,
          entries: bucket.entries,
        });
      }
    }
  }

  return conflicts;
};
