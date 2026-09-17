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

export const TODAY: IsoDate = dateOffset(0);

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
  kilometreRate: 1850,
  vatPercentage: 15,
  jobNumberPrefix: 'EJE-',
  nextJobSequence: 1060,
  quietHoursStart: '18:00',
  quietHoursEnd: '07:00',
};
