import { asUserId, type LeaveRecord } from '@/domain';
import { dateOffset, timeOffset } from './reference';

/**
 * Seeded technician availability.
 *
 * Spread around today so the calendar always has something to show: leave in
 * progress now, leave coming up, a public holiday everyone is off for, and a
 * request still waiting on a Master.
 */
export const seedLeave: readonly LeaveRecord[] = [
  {
    id: 'leave-riaan-annual',
    userId: asUserId('user-tech-riaan'),
    type: 'annual',
    startDate: dateOffset(4),
    endDate: dateOffset(11),
    notes: 'December shutdown carried over from last year.',
    status: 'approved',
    recordedAt: timeOffset(-40, 9),
    approvedBy: asUserId('user-master-johan'),
  },
  {
    id: 'leave-thabo-sick',
    userId: asUserId('user-tech-thabo'),
    type: 'sick',
    startDate: dateOffset(-1),
    endDate: dateOffset(1),
    notes: 'Medical certificate received.',
    status: 'approved',
    recordedAt: timeOffset(-1, 6, 40),
    approvedBy: asUserId('user-master-elmarie'),
  },
  {
    id: 'leave-naledi-training',
    userId: asUserId('user-tech-naledi'),
    type: 'training',
    startDate: dateOffset(2),
    endDate: dateOffset(3),
    notes: 'Siemens 840D advanced diagnostics course.',
    status: 'approved',
    recordedAt: timeOffset(-25, 11),
    approvedBy: asUserId('user-master-johan'),
  },
  {
    id: 'leave-deon-family',
    userId: asUserId('user-tech-deon'),
    type: 'family_responsibility',
    startDate: dateOffset(6),
    endDate: dateOffset(6),
    notes: '',
    status: 'approved',
    recordedAt: timeOffset(-5, 15),
    approvedBy: asUserId('user-master-elmarie'),
  },
  {
    id: 'leave-lerato-annual-request',
    userId: asUserId('user-tech-lerato'),
    type: 'annual',
    startDate: dateOffset(16),
    endDate: dateOffset(20),
    notes: 'Family holiday. Awaiting approval.',
    status: 'requested',
    recordedAt: timeOffset(-2, 17, 30),
    approvedBy: null,
  },
  {
    id: 'leave-andre-annual',
    userId: asUserId('user-tech-andre'),
    type: 'annual',
    startDate: dateOffset(9),
    endDate: dateOffset(10),
    notes: '',
    status: 'approved',
    recordedAt: timeOffset(-12, 10),
    approvedBy: asUserId('user-master-johan'),
  },
  {
    id: 'leave-sipho-annual-past',
    userId: asUserId('user-tech-sipho'),
    type: 'annual',
    startDate: dateOffset(-18),
    endDate: dateOffset(-14),
    notes: '',
    status: 'approved',
    recordedAt: timeOffset(-45, 9),
    approvedBy: asUserId('user-master-johan'),
  },
  {
    id: 'leave-francois-sick',
    userId: asUserId('user-tech-francois'),
    type: 'sick',
    startDate: dateOffset(-7),
    endDate: dateOffset(-7),
    notes: '',
    status: 'approved',
    recordedAt: timeOffset(-7, 7),
    approvedBy: asUserId('user-master-elmarie'),
  },
];
