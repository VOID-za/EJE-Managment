import { asJobId, asUserId, type ChatMessage, type Conversation } from '@/domain';
import { minutesAgo, timeOffset } from './reference';

/**
 * Seeded conversations.
 *
 * Carried over from the one-way technician messages this replaced, so the
 * availability workflow still has its history: two requests the office already
 * actioned, and one still waiting. Plus a two-way thread about a job, which is
 * the case the chat exists for.
 */
const MASTERS = [
  asUserId('user-master-elmarie'),
  asUserId('user-master-johan'),
  asUserId('user-master-denise'),
];

export const seedConversations: readonly Conversation[] = [
  {
    id: 'conv-lerato-office',
    participantIds: [asUserId('user-tech-lerato'), ...MASTERS],
    jobId: null,
    jobNumber: null,
    createdBy: asUserId('user-tech-lerato'),
    createdAt: minutesAgo(48),
    lastMessageAt: minutesAgo(41),
  },
  {
    id: 'conv-deon-office',
    participantIds: [asUserId('user-tech-deon'), ...MASTERS],
    jobId: null,
    jobNumber: null,
    createdBy: asUserId('user-tech-deon'),
    createdAt: minutesAgo(73),
    lastMessageAt: minutesAgo(73),
  },
  {
    id: 'conv-francois-office',
    participantIds: [asUserId('user-tech-francois'), ...MASTERS],
    jobId: null,
    jobNumber: null,
    createdBy: asUserId('user-tech-francois'),
    createdAt: timeOffset(-3, 13, 50),
    lastMessageAt: timeOffset(-3, 14, 5),
  },
  // A two-way thread about a specific job: the case a one-way message board
  // could not serve at all.
  {
    id: 'conv-elmarie-sipho-1048',
    participantIds: [asUserId('user-master-elmarie'), asUserId('user-tech-sipho')],
    jobId: asJobId('job-eje-1048'),
    jobNumber: 'EJE-1048',
    createdBy: asUserId('user-master-elmarie'),
    createdAt: timeOffset(-1, 15, 20),
    lastMessageAt: timeOffset(-1, 15, 42),
  },
];

const message = (
  id: string,
  conversationId: string,
  senderId: string,
  body: string,
  sentAt: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  conversationId,
  senderId: asUserId(senderId),
  body,
  sentAt,
  readBy: [],
  availabilityRecordId: null,
  actionedBy: null,
  actionedAt: null,
  ...overrides,
});

export const seedChatMessages: readonly ChatMessage[] = [
  // Already actioned: Elmarie recorded the appointment from this message.
  message(
    'msg-lerato-appointment',
    'conv-lerato-office',
    'user-tech-lerato',
    "Morning. I've got a doctor's appointment this morning at 09:00. I should be back on the road by 11:00.",
    minutesAgo(48),
    {
      readBy: MASTERS,
      availabilityRecordId: 'avail-lerato-appointment',
      actionedBy: asUserId('user-master-elmarie'),
      actionedAt: minutesAgo(43),
    },
  ),
  message(
    'msg-elmarie-lerato-ack',
    'conv-lerato-office',
    'user-master-elmarie',
    'Thanks Lerato — recorded on the calendar. I have moved your 10:00 to the afternoon.',
    minutesAgo(41),
    { readBy: [asUserId('user-tech-lerato')] },
  ),

  // Unread and unactioned: the case the office still has to deal with.
  message(
    'msg-deon-late',
    'conv-deon-office',
    'user-tech-deon',
    'The N1 is closed at Buccleuch after an accident. I am going to be about an hour late to the Midrand call. Do you want me to phone the customer?',
    minutesAgo(73),
  ),

  message(
    'msg-francois-vehicle',
    'conv-francois-office',
    'user-tech-francois',
    'My bakkie is booked in for its major service on Friday afternoon. I will not be able to take an afternoon call that day.',
    timeOffset(-3, 13, 50),
    {
      readBy: MASTERS,
      availabilityRecordId: 'avail-francois-other',
      actionedBy: asUserId('user-master-johan'),
      actionedAt: timeOffset(-3, 14, 0),
    },
  ),
  message(
    'msg-johan-francois-ack',
    'conv-francois-office',
    'user-master-johan',
    'Noted, Friday afternoon is blocked out for you.',
    timeOffset(-3, 14, 5),
    { readBy: [asUserId('user-tech-francois')] },
  ),

  // The job-linked thread, read on both sides.
  message(
    'msg-elmarie-1048-serial',
    'conv-elmarie-sipho-1048',
    'user-master-elmarie',
    'Please confirm the serial number on the Leadwell before you close EJE-1048 — the one on the order does not match our register.',
    timeOffset(-1, 15, 20),
    { readBy: [asUserId('user-tech-sipho')] },
  ),
  message(
    'msg-sipho-1048-serial',
    'conv-elmarie-sipho-1048',
    'user-tech-sipho',
    'Confirmed, the plate reads LW-V40-70214. The order number was typed wrong.',
    timeOffset(-1, 15, 42),
    { readBy: [asUserId('user-master-elmarie')] },
  ),
];
