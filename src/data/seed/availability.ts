import { asUserId, type AvailabilityRecord } from '@/domain';
import { dateOffset, timeOffset } from './reference';

/**
 * Seeded technician availability.
 *
 * Spread around today so the calendar always has something to show, and chosen
 * to cover every shape the system has to handle: a part day, a full day, and a
 * multi-day block — plus history, so a technician profile is not empty.
 *
 * Every record is authored by a Master, because that is the only way one can
 * exist: a technician's message asks the office to record something, it never
 * records itself.
 */
const record = (
  id: string,
  userId: string,
  type: AvailabilityRecord['type'],
  startDate: string,
  endDate: string,
  overrides: Partial<AvailabilityRecord> = {},
): AvailabilityRecord => ({
  id,
  userId: asUserId(userId),
  type,
  startDate,
  endDate,
  allDay: true,
  startTime: null,
  endTime: null,
  description: '',
  status: 'active',
  createdBy: asUserId('user-master-elmarie'),
  createdAt: timeOffset(-10, 9),
  cancelledBy: null,
  cancelledAt: null,
  ...overrides,
});

export const seedAvailability: readonly AvailabilityRecord[] = [
  // Part day: the shape a doctor's appointment takes, and the one that proves
  // a technician can be unavailable without being away all day.
  record('avail-lerato-appointment', 'user-tech-lerato', 'appointment', dateOffset(0), dateOffset(0), {
    allDay: false,
    startTime: '09:00',
    endTime: '11:00',
    description: 'Doctor\'s appointment. Back on the road by 11:00.',
    createdAt: timeOffset(0, 7, 10),
  }),

  // Full day, today: blocks anything scheduled today.
  record('avail-thabo-sick', 'user-tech-thabo', 'sick_leave', dateOffset(-1), dateOffset(1), {
    description: 'Medical certificate received.',
    createdAt: timeOffset(-1, 6, 40),
  }),

  // Multi-day block.
  record('avail-riaan-annual', 'user-tech-riaan', 'annual_leave', dateOffset(4), dateOffset(11), {
    description: 'December shutdown carried over from last year.',
    createdBy: asUserId('user-master-johan'),
    createdAt: timeOffset(-40, 9),
  }),

  record('avail-naledi-training', 'user-tech-naledi', 'training', dateOffset(2), dateOffset(3), {
    description: 'Siemens 840D advanced diagnostics course.',
    createdBy: asUserId('user-master-johan'),
    createdAt: timeOffset(-25, 11),
  }),

  record('avail-deon-personal', 'user-tech-deon', 'personal_leave', dateOffset(6), dateOffset(6), {
    createdAt: timeOffset(-5, 15),
  }),

  record('avail-andre-annual', 'user-tech-andre', 'annual_leave', dateOffset(9), dateOffset(10), {
    createdBy: asUserId('user-master-johan'),
    createdAt: timeOffset(-12, 10),
  }),

  // "Other" always carries a description — the type says nothing on its own.
  record('avail-francois-other', 'user-tech-francois', 'other', dateOffset(3), dateOffset(3), {
    allDay: false,
    startTime: '13:00',
    endTime: '17:00',
    description: 'Vehicle in for its major service.',
    createdBy: asUserId('user-master-johan'),
    createdAt: timeOffset(-3, 14),
  }),

  // History, so a technician profile has a past as well as a future.
  record('avail-sipho-annual-past', 'user-tech-sipho', 'annual_leave', dateOffset(-18), dateOffset(-14), {
    createdBy: asUserId('user-master-johan'),
    createdAt: timeOffset(-45, 9),
  }),

  record('avail-francois-sick-past', 'user-tech-francois', 'sick_leave', dateOffset(-7), dateOffset(-7), {
    createdAt: timeOffset(-7, 7),
  }),

  // Cancelled: kept on file, and no longer blocking.
  record('avail-deon-cancelled', 'user-tech-deon', 'annual_leave', dateOffset(13), dateOffset(14), {
    description: 'Cancelled — the customer moved the installation forward.',
    status: 'cancelled',
    createdAt: timeOffset(-20, 10),
    cancelledBy: asUserId('user-master-elmarie'),
    cancelledAt: timeOffset(-2, 11),
  }),
];
