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

export interface MonthlySubmission extends Partial<MonthlySubmissionReplacement> {
  readonly id: string;
  readonly userId: UserId;
  readonly month: PayrollMonth;
  /**
   * The sent timesheet period covering exactly the month. Null for a month
   * submitted as attendance only — a Coordinator's (TS-ROLE-1, migration 0043).
   */
  readonly timesheetPeriodId: string | null;
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

/**
 * A MONTHLY SUBMISSION'S REPLACEMENT. PAYROLL-ONE-1 (migration 0052): a month
 * submitted before payroll forms were submitted for a From–To period is kept
 * as it was; a payroll submission covering every day of it replaces it, once.
 */
export interface MonthlySubmissionReplacement {
  readonly supersededAt: IsoDateTime | null;
  readonly supersededBy: UserId | null;
  readonly supersededBySubmission: string | null;
}

/** The attendance of a From–To period as it stood when it was submitted. */
export interface AttendancePeriodSnapshot {
  readonly technicianName: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly days: readonly AttendanceSnapshotDay[];
}

/** A PDF stored when the forms were submitted: exactly what went, under the name it went with. */
export interface PayrollSubmissionDocument {
  readonly kind: PayrollDocumentKind;
  readonly fileName: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly pageCount: number;
}

/**
 * A PERSON'S PAYROLL FORMS, SUBMITTED TOGETHER. PAYROLL-ONE-1 (the owner,
 * 5 November 2026), migration 0052.
 *
 * One submission from My Monthly Forms for one From–To period: the timesheet
 * (the sent timesheet period for exactly those dates) and the attendance,
 * frozen as they stood, with the file names they went under and the PDFs
 * stored at that moment. `timesheetRequired` false is an attendance-only
 * submission of a person who keeps no timesheet — recorded as such, never an
 * empty timesheet. The FINANCE MONTH is the month of To. Never changed; a
 * later submission covering every one of its days replaces it, and it is kept.
 */
export interface PayrollSubmission extends MonthlySubmissionReplacement {
  readonly id: string;
  readonly userId: UserId;
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** "2026-11" for 24 Oct – 25 Nov 2026. */
  readonly financeMonth: PayrollMonth;
  readonly timesheetRequired: boolean;
  readonly timesheetPeriodId: string | null;
  readonly attendance: AttendancePeriodSnapshot;
  /** The names the documents were submitted under. The timesheet's is '' when none was required. */
  readonly fileNames: { readonly timesheet: string; readonly attendance: string };
  readonly documents: readonly PayrollSubmissionDocument[];
  readonly submittedAt: IsoDateTime;
  readonly submittedBy: UserId;
}

/** The name a person gave one of their WORKING payroll PDFs. */
export interface PayrollDocumentName {
  readonly userId: UserId;
  readonly kind: PayrollDocumentKind;
  readonly fileName: string;
  readonly updatedBy: UserId;
  readonly updatedAt: IsoDateTime;
}

/** The longest From–To period one payroll submission covers: a year (the database's check). */
export const PAYROLL_PERIOD_MAX_DAYS = 366;
