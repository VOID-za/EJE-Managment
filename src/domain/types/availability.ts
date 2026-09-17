import type { IsoDate, IsoDateTime, UserId } from './common';

/**
 * Technician availability.
 *
 * Modelled as records of UNAVAILABILITY rather than a presence calendar: a
 * technician is available unless something says otherwise. That keeps the data
 * small and matches how the office actually administers it.
 *
 * A record is authoritative: only a Master creates one. A technician telling
 * the office they have an appointment is a MESSAGE (see `types/message.ts`),
 * not an availability record — the office decides what goes on the calendar.
 */
export type AvailabilityType =
  | 'appointment'
  | 'sick_leave'
  | 'annual_leave'
  | 'personal_leave'
  | 'training'
  | 'other';

export const AVAILABILITY_TYPES: readonly AvailabilityType[] = [
  'appointment',
  'sick_leave',
  'annual_leave',
  'personal_leave',
  'training',
  'other',
];

/** A cancelled record stays on file; it simply stops blocking. */
export type AvailabilityStatus = 'active' | 'cancelled';

/** Wall-clock time of day, `HH:MM`. */
export type IsoTime = string;

export interface AvailabilityRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly type: AvailabilityType;
  /** First day of the absence. */
  readonly startDate: IsoDate;
  /** Last day of the absence, INCLUSIVE. Equal to `startDate` for one day. */
  readonly endDate: IsoDate;
  /**
   * Whole days rather than a time window. A multi-day absence is always
   * all-day; only a single-day absence can carry a time window.
   */
  readonly allDay: boolean;
  /** Null when `allDay`. */
  readonly startTime: IsoTime | null;
  /** Null when `allDay`. */
  readonly endTime: IsoTime | null;
  readonly description: string;
  readonly status: AvailabilityStatus;
  /** The Master who put this on the calendar. */
  readonly createdBy: UserId;
  readonly createdAt: IsoDateTime;
  readonly cancelledBy: UserId | null;
  readonly cancelledAt: IsoDateTime | null;
}

export const availabilityTypeLabel = (type: AvailabilityType): string => {
  switch (type) {
    case 'appointment':
      return 'Appointment';
    case 'sick_leave':
      return 'Sick leave';
    case 'annual_leave':
      return 'Annual leave';
    case 'personal_leave':
      return 'Personal leave';
    case 'training':
      return 'Training';
    case 'other':
      return 'Other';
  }
};

/** Short form, for a calendar chip where space is tight. */
export const availabilityTypeShortLabel = (type: AvailabilityType): string => {
  switch (type) {
    case 'appointment':
      return 'Appt';
    case 'sick_leave':
      return 'Sick';
    case 'annual_leave':
      return 'Leave';
    case 'personal_leave':
      return 'Personal';
    case 'training':
      return 'Training';
    case 'other':
      return 'Other';
  }
};

/** A record that actually makes the technician unavailable. */
export const isBlockingAvailability = (record: AvailabilityRecord): boolean =>
  record.status === 'active';

/** "09:00–11:00" for a part day, "All day" otherwise. */
export const availabilityTimeLabel = (record: AvailabilityRecord): string =>
  record.allDay || record.startTime === null || record.endTime === null
    ? 'All day'
    : `${record.startTime}–${record.endTime}`;

export const isMultiDayAvailability = (record: AvailabilityRecord): boolean =>
  record.endDate > record.startDate;
