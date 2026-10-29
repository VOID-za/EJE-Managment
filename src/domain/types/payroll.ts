import type { AbsenceReason, AttendanceStatus } from './attendance';
import type { IsoDate, IsoDateTime, UserId } from './common';

/**
 * MONTHLY PAYROLL FORMS AND THE FINANCE PACKAGE. PAY-01 … PAY-08 (29 October 2026).
 *
 * Each technician sends the office ONE monthly submission: the timesheet for
 * exactly that calendar month (a timesheet period like any other — the From/To
 * rules, the lock and the corrections all apply) together with the month's
 * attendance, frozen as it stood. The office then sends Finance ONE email for
 * the month carrying both PDFs of every technician it selected.
 */

/** "2026-10". */
export type PayrollMonth = string;

/** One day of the attendance as it stood when the month was sent. */
export interface AttendanceSnapshotDay {
  readonly date: IsoDate;
  readonly status: AttendanceStatus | null;
  readonly absenceReason: AbsenceReason | null;
  readonly note: string;
}

export interface AttendanceSnapshot {
  readonly technicianName: string;
  readonly month: PayrollMonth;
  readonly days: readonly AttendanceSnapshotDay[];
}

export interface MonthlySubmission {
  readonly id: string;
  readonly userId: UserId;
  readonly month: PayrollMonth;
  /** The sent timesheet period covering exactly the month. */
  readonly timesheetPeriodId: string;
  readonly attendance: AttendanceSnapshot;
  readonly submittedAt: IsoDateTime;
  readonly submittedBy: UserId;
}

export type PayrollDocumentKind = 'timesheet' | 'attendance';

/** One attachment of a Finance package, exactly as it was stored and sent. */
export interface FinancePackageAttachment {
  readonly technicianId: UserId;
  readonly technicianName: string;
  readonly kind: PayrollDocumentKind;
  readonly fileName: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
  /** "Original submission", "Correction 1, accepted …", "Corrected by the office after submission". */
  readonly versionLabel: string;
  /** True when this technician's month was already in a SENT package and is sent again because it was corrected. */
  readonly correctedResend: boolean;
}

export type FinancePackageStatus = 'prepared' | 'sending' | 'sent' | 'failed' | 'discarded';

export interface FinancePackage {
  readonly id: string;
  readonly month: PayrollMonth;
  readonly status: FinancePackageStatus;
  readonly recipient: string;
  readonly attachments: readonly FinancePackageAttachment[];
  readonly totalBytes: number;
  readonly preparedBy: UserId;
  readonly preparedAt: IsoDateTime;
  readonly sentBy: UserId | null;
  readonly sendStartedAt: IsoDateTime | null;
  readonly sentAt: IsoDateTime | null;
  readonly providerMessageId: string | null;
  readonly providerState: string | null;
  readonly failureReason: string;
  readonly failureKind: string | null;
  readonly attempts: number;
}

/**
 * The most the attachments of ONE Finance email may weigh: Microsoft 365's
 * limit on a message's attachments (the Graph adapter's MAX_ATTACHMENT_BYTES —
 * a test holds the two equal). A package over it is refused before anything is
 * sent; it is never split into several emails.
 */
export const FINANCE_PACKAGE_MAX_BYTES = 3 * 1024 * 1024;

/** A technician's name on documents: at most this long. */
export const DOCUMENT_NAME_LIMIT = 30;
