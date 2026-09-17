import { asUserId, type TechnicianMessage } from '@/domain';
import { timeOffset } from './reference';

/**
 * Seeded technician messages.
 *
 * One waiting for a Master to act on — the exact case the feature exists for —
 * and one already handled, so the "availability recorded" outcome is visible
 * without having to perform it first.
 */
export const seedMessages: readonly TechnicianMessage[] = [
  {
    id: 'msg-lerato-appointment',
    senderId: asUserId('user-tech-lerato'),
    recipientId: null,
    body: "Morning. I've got a doctor's appointment this morning at 09:00. I should be back on the road by 11:00.",
    sentAt: timeOffset(0, 7, 5),
    // Already actioned: Elmarie recorded the appointment from this message.
    status: 'actioned',
    readBy: asUserId('user-master-elmarie'),
    readAt: timeOffset(0, 7, 8),
    availabilityRecordId: 'avail-lerato-appointment',
    actionedBy: asUserId('user-master-elmarie'),
    actionedAt: timeOffset(0, 7, 10),
  },
  {
    id: 'msg-deon-late',
    senderId: asUserId('user-tech-deon'),
    recipientId: null,
    body: 'The N1 is closed at Buccleuch after an accident. I am going to be about an hour late to the Midrand call. Do you want me to phone the customer?',
    sentAt: timeOffset(0, 6, 40),
    status: 'unread',
    readBy: null,
    readAt: null,
    availabilityRecordId: null,
    actionedBy: null,
    actionedAt: null,
  },
  {
    id: 'msg-francois-vehicle',
    senderId: asUserId('user-tech-francois'),
    recipientId: null,
    body: 'My bakkie is booked in for its major service on Friday afternoon. I will not be able to take an afternoon call that day.',
    sentAt: timeOffset(-3, 13, 50),
    status: 'actioned',
    readBy: asUserId('user-master-johan'),
    readAt: timeOffset(-3, 14, 0),
    availabilityRecordId: 'avail-francois-other',
    actionedBy: asUserId('user-master-johan'),
    actionedAt: timeOffset(-3, 14, 0),
  },
];
