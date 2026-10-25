import type { IsoDate, IsoDateTime } from '../types/common';

/**
 * WHEN A TEST & REPAIR UNIT ARRIVED. "What is the Job?" — Date Received.
 *
 * Optional: null means nobody recorded it, and that is allowed. When it IS
 * recorded it has to be a real calendar day (the protocol's pattern accepts
 * `2026-02-31`) and not a day that has not happened yet — a unit cannot have
 * been handed over tomorrow.
 *
 * ONE DAY OF GRACE on "the future". The server's clock is UTC and EJE work in
 * South Africa, two hours ahead, so between midnight and 02:00 the office's
 * today is the server's tomorrow. Refusing the date somebody can see on the
 * wall would be the wrong answer; a date two days ahead is still refused.
 *
 * Pure, so the rule is the same wherever it is applied — creation and the
 * JOB-EDIT-1 correction both call it — and so it is testable without a clock.
 */
export const dateReceivedProblem = (
  value: IsoDate | null,
  now: IsoDateTime,
): string | null => {
  if (value === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return 'Use a calendar date, such as 2026-10-25.';
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return `${value} is not a real date.`;
  }
  const latest = new Date(now);
  latest.setUTCDate(latest.getUTCDate() + 1);
  if (value > latest.toISOString().slice(0, 10)) {
    return 'The date received cannot be in the future.';
  }
  return null;
};
