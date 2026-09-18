import type { IsoDate, IsoDateTime, SystemSettings } from '@/domain';

/**
 * Demo seed helpers.
 *
 * Seed dates are expressed relative to the day the demo is opened so dashboards
 * ("Today's Scheduled Jobs", "Overdue Jobs") always contain meaningful data,
 * whenever management happens to run the demonstration.
 */

const startOfToday = (): Date => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

export const toIsoDate = (date: Date): IsoDate => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/** Calendar date offset from today, e.g. `dateOffset(-2)` is the day before yesterday. */
export const dateOffset = (days: number): IsoDate => {
  const date = startOfToday();
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
};

/** Timestamp at a given hour on a day offset from today. */
export const timeOffset = (days: number, hours: number, minutes = 0): IsoDateTime => {
  const date = startOfToday();
  date.setDate(date.getDate() + days);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
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
  const date = startOfToday();
  const daysUntilMonday = (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + daysUntilMonday + weeksAhead * 7 + addDays);
  return toIsoDate(date);
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
  kilometreRate: 1850,
  vatPercentage: 15,
  jobNumberPrefix: 'EJE-',
  nextJobSequence: 1068,
  quietHoursStart: '18:00',
  quietHoursEnd: '07:00',
};
