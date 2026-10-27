import type { IsoDate, IsoDateTime, SystemSettings } from '@/domain';
import { BUSINESS_UTC_OFFSET_MINUTES, businessDateOf, businessToday } from '@/lib/business-time';

/**
 * Demo seed helpers.
 *
 * Seed dates are expressed relative to the day the demo is opened so dashboards
 * ("Today's Scheduled Jobs", "Overdue Jobs") always contain meaningful data,
 * whenever management happens to run the demonstration.
 */

/**
 * "TODAY" IS THE BUSINESS DAY, NOT THE RUNNER'S DAY. QA-5, a third time.
 *
 * These helpers read the day from `new Date().getDate()`, which is the LOCAL
 * date of whatever machine is running — UTC on the server and on CI. Everything
 * that then ASKS about the data reads dates in the business zone, through
 * `businessDateOf`. The two disagree between 22:00 and midnight UTC, which is
 * midnight to 02:00 in Johannesburg, and for those two hours every day:
 *
 *   - the seeded part-day appointment landed on YESTERDAY, so the calendar's
 *     day view showed nothing and the conflict panel had no window to name;
 *   - "Today's scheduled jobs" was a day out;
 *   - a technician recorded as on sick leave "today" was not, so an assignment
 *     the demonstration exists to refuse was allowed.
 *
 * A demonstration that is wrong for two hours every evening is wrong when
 * somebody opens it at half past midnight to look at it, and it is also a gate
 * that fails for two hours a day — which reads as a flake, and is how this was
 * found for the third time.
 *
 * So the day comes from `businessToday`, the arithmetic is done on its
 * components in UTC where no zone can leak in, and an hour given to
 * `timeOffset` is an hour on EJE's own clock.
 */
const businessComponents = (): readonly [number, number, number] => {
  const [year, month, day] = businessToday().split('-').map(Number);
  return [year ?? 1970, month ?? 1, day ?? 1];
};

export const toIsoDate = (date: Date): IsoDate =>
  businessDateOf(date.toISOString()) ?? '1970-01-01';

/** Calendar date offset from today, e.g. `dateOffset(-2)` is the day before yesterday. */
export const dateOffset = (days: number): IsoDate => {
  const [year, month, day] = businessComponents();
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10) as IsoDate;
};

/** Timestamp at a given hour ON EJE'S CLOCK, on a day offset from today. */
export const timeOffset = (days: number, hours: number, minutes = 0): IsoDateTime => {
  const [year, month, day] = businessComponents();
  const instant =
    Date.UTC(year, month - 1, day + days, hours, minutes) -
    BUSINESS_UTC_OFFSET_MINUTES * 60_000;
  return new Date(instant).toISOString();
};

/**
 * A moment `minutes` before now.
 *
 * For seeded data that has to be in the PAST whenever the demonstration is
 * opened. `timeOffset(0, 7, 12)` means "today at 07:12", which is two hours in
 * the future to anyone who starts the demo at five in the morning — and a
 * conversation whose last message is in the future sorts above one that has
 * just been sent, so the wrong thread opens.
 */
export const minutesAgo = (minutes: number): IsoDateTime => {
  const date = new Date();
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() - minutes);
  return date.toISOString();
};

export const TODAY: IsoDate = dateOffset(0);

/**
 * The next Monday on or after today, plus an optional offset.
 *
 * Multi-day service jobs are anchored to a Monday so they render as one
 * continuous bar in the calendar's month view rather than being split across a
 * week boundary — which is correct behaviour, but a poor first impression.
 */
export const nextMonday = (addDays = 0, weeksAhead = 0): IsoDate => {
  const [year, month, day] = businessComponents();
  const base = new Date(Date.UTC(year, month - 1, day));
  const daysUntilMonday = (8 - base.getUTCDay()) % 7 || 7;
  base.setUTCDate(base.getUTCDate() + daysUntilMonday + weeksAhead * 7 + addDays);
  return base.toISOString().slice(0, 10) as IsoDate;
};

export const seedSettings: SystemSettings = {
  companyName: 'EJE Industrial Electronics',
  companyRegistration: '2004/018273/07',
  companyVatNumber: '4180276351',
  companyPhone: '+27 11 555 0100',
  companyEmail: 'service@eje-demo.co.za',
  companyAddress: '14 Anvil Road, Isando, Kempton Park, 1600',
  labourRates: {
    normal: 95000,
    overtime: 142500,
    double: 190000,
  },
  calloutRate: 85000,
  // BENCH-1: the demonstration's test bench fee.
  testBenchFee: 45000,
  kilometreRate: 1850,
  vatPercentage: 15,
  jobNumberPrefix: 'EJE-',
  nextJobSequence: 1068,
  quietHoursStart: '18:00',
  quietHoursEnd: '07:00',
};
