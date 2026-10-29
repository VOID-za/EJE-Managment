import { DOCUMENT_NAME_LIMIT, type User } from '@/domain';

/**
 * MONTHS AND FILE NAMES FOR THE MONTHLY PAYROLL FORMS. PAY-03 (29 October 2026).
 *
 * The owner's examples, exactly:
 *
 *   JC TIMESHEET OCT.pdf      JC ATTEN OCTOBER.pdf
 *   RUAN TIMESHEET OCT.pdf    RUAN ATTEN OCTOBER.pdf
 *
 * The technician's NAME ON DOCUMENTS (set by the office; the first name,
 * upper-case, until it is), the document, and the month — abbreviated for the
 * timesheet, in full for the attendance. Upper-case, characters no file system
 * accepts removed, spaces collapsed: the same inputs always give the same name.
 * Pure; calendar arithmetic in UTC so no time zone moves a month.
 */

export const MONTHS_FULL = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
] as const;
export const MONTHS_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export const isPayrollMonth = (value: string): boolean => MONTH_PATTERN.test(value);

const parts = (month: string): { year: number; index: number } => {
  const match = MONTH_PATTERN.exec(month);
  if (match === null) throw new Error(`not a month: ${month}`);
  return { year: Number(match[1]), index: Number(match[2]) - 1 };
};

/** The month's first and last day: 2024-02 → 2024-02-01 … 2024-02-29. */
export const monthBounds = (month: string): { readonly from: string; readonly to: string } => {
  const { year, index } = parts(month);
  const last = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/** "October 2026". */
export const monthTitle = (month: string): string => {
  const { year, index } = parts(month);
  const name = MONTHS_FULL[index]!;
  return `${name.charAt(0)}${name.slice(1).toLowerCase()} ${year}`;
};

/** The month a calendar day falls in. */
export const monthOfDate = (date: string): string => date.slice(0, 7);

/** The month before. */
export const previousMonth = (month: string): string => {
  const { year, index } = parts(month);
  return index === 0 ? `${year - 1}-12` : `${year}-${String(index).padStart(2, '0')}`;
};

/** True when a From/To period is exactly one calendar month. */
export const periodIsMonth = (from: string, to: string): boolean => {
  if (from.slice(0, 7) !== to.slice(0, 7) || !isPayrollMonth(from.slice(0, 7))) return false;
  const bounds = monthBounds(from.slice(0, 7));
  return bounds.from === from && bounds.to === to;
};

/** Characters no common file system accepts, and control characters. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/gu;

/** A name made safe and deterministic for a file: upper-case, legal, single-spaced. */
export const sanitiseDocumentName = (value: string): string =>
  value.replace(ILLEGAL, ' ').replace(/\s+/gu, ' ').trim().toUpperCase().slice(0, DOCUMENT_NAME_LIMIT).trim();

/**
 * The technician's name on documents: the office's choice, else the first name,
 * else the initials — never empty, never another person's hard-coded name.
 */
export const documentNameOf = (user: Pick<User, 'firstName' | 'initials'> & { readonly documentName?: string | null }): string => {
  for (const candidate of [user.documentName ?? '', user.firstName, user.initials, 'TECHNICIAN']) {
    const clean = sanitiseDocumentName(candidate);
    if (clean.length > 0) return clean;
  }
  return 'TECHNICIAN';
};

/** "JC TIMESHEET OCT.pdf". */
export const timesheetMonthFileName = (documentName: string, month: string): string =>
  `${sanitiseDocumentName(documentName)} TIMESHEET ${MONTHS_SHORT[parts(month).index]}.pdf`;

/** "JC ATTEN OCTOBER.pdf". */
export const attendanceMonthFileName = (documentName: string, month: string): string =>
  `${sanitiseDocumentName(documentName)} ATTEN ${MONTHS_FULL[parts(month).index]}.pdf`;

/**
 * A timesheet for a period that is NOT a whole month keeps the same style with
 * its two days: "JC TIMESHEET 3 OCT-12 OCT.pdf"; a whole month is the monthly name.
 */
export const timesheetPeriodFileName = (documentName: string, from: string, to: string): string => {
  if (periodIsMonth(from, to)) return timesheetMonthFileName(documentName, from.slice(0, 7));
  const day = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS_SHORT[Number(date.slice(5, 7)) - 1]}`;
  const year = from.slice(0, 4) === to.slice(0, 4) ? '' : ` ${to.slice(0, 4)}`;
  return `${sanitiseDocumentName(documentName)} TIMESHEET ${day(from)}-${day(to)}${year}.pdf`;
};

/** A package attachment sent again after a correction keeps the name, marked CORRECTED. */
export const correctedFileName = (fileName: string): string => fileName.replace(/\.pdf$/u, ' CORRECTED.pdf');
