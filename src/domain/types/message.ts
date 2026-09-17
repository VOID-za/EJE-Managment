import type { IsoDateTime, UserId } from './common';

/**
 * Technician → Master messages.
 *
 * Deliberately not a chat application. It exists for one job: a technician
 * telling the office something about their availability — an appointment, a
 * late arrival, a day off sick — without being able to put it on the calendar
 * themselves.
 *
 * That separation is the point. A message is a REQUEST for the office's
 * attention; the official availability record is the office's decision. Sending
 * a message never makes anyone unavailable. When a Master acts on one, the
 * resulting record is linked back here so the thread shows what was done.
 */
export type MessageStatus = 'unread' | 'read' | 'actioned';

export interface TechnicianMessage {
  readonly id: string;
  readonly senderId: UserId;
  /**
   * Null means "the Masters" collectively, which is how a technician sends it:
   * they are telling the office, not one person.
   */
  readonly recipientId: UserId | null;
  readonly body: string;
  readonly sentAt: IsoDateTime;
  readonly status: MessageStatus;
  readonly readBy: UserId | null;
  readonly readAt: IsoDateTime | null;
  /** The availability record a Master created in response, when they did. */
  readonly availabilityRecordId: string | null;
  readonly actionedBy: UserId | null;
  readonly actionedAt: IsoDateTime | null;
}

export const isMessageHandled = (message: TechnicianMessage): boolean =>
  message.status === 'actioned';
