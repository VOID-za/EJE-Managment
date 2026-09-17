import type { IsoDate, IsoDateTime, UserId } from './common';

/**
 * Technician availability.
 *
 * Modelled as records of ABSENCE rather than a presence calendar: a technician
 * is available unless something says otherwise. That keeps the data small and
 * matches how leave is actually administered.
 */
export type LeaveType =
  | 'annual'
  | 'sick'
  | 'family_responsibility'
  | 'training'
  | 'unpaid'
  | 'public_holiday';

export type LeaveStatus = 'requested' | 'approved' | 'declined';

export interface LeaveRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly type: LeaveType;
  /** First day of absence. */
  readonly startDate: IsoDate;
  /** Last day of absence, INCLUSIVE. Equal to `startDate` for a single day. */
  readonly endDate: IsoDate;
  readonly notes: string;
  readonly status: LeaveStatus;
  readonly recordedAt: IsoDateTime;
  /** Null for a request that has not been actioned yet. */
  readonly approvedBy: UserId | null;
}

export const leaveTypeLabel = (type: LeaveType): string => {
  switch (type) {
    case 'annual':
      return 'Annual leave';
    case 'sick':
      return 'Sick leave';
    case 'family_responsibility':
      return 'Family responsibility';
    case 'training':
      return 'Training';
    case 'unpaid':
      return 'Unpaid leave';
    case 'public_holiday':
      return 'Public holiday';
  }
};

/** Short form, for a calendar chip where space is tight. */
export const leaveTypeShortLabel = (type: LeaveType): string => {
  switch (type) {
    case 'annual':
      return 'Leave';
    case 'sick':
      return 'Sick';
    case 'family_responsibility':
      return 'Family';
    case 'training':
      return 'Training';
    case 'unpaid':
      return 'Unpaid';
    case 'public_holiday':
      return 'Holiday';
  }
};

/** Leave that actually makes a technician unavailable. */
export const isBlockingLeave = (record: LeaveRecord): boolean => record.status === 'approved';
