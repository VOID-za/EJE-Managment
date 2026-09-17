'use client';

import {
  summariseAvailability,
  type AvailabilityRecord,
  type TechnicianMessage,
} from '@/domain';
import { Badge, Card, CardHeader, Icon } from '@/components/ui';
import { formatDateTime } from '@/lib/format';

/**
 * A technician's own sent messages.
 *
 * Its job is to close the loop: the technician can see whether the office has
 * recorded anything, rather than wondering whether the message landed.
 */
export const MyMessagesCard = ({
  messages,
  availability,
}: {
  readonly messages: readonly TechnicianMessage[];
  readonly availability: readonly AvailabilityRecord[];
}) => (
  <Card>
    <CardHeader title="Your messages" description="What you have sent, and what came of it." />
    {messages.length === 0 ? (
      <p className="mt-3 text-sm text-steel-500 italic">You have not sent any messages.</p>
    ) : (
      <ul className="mt-3 divide-y divide-steel-100">
        {messages.map((message) => {
          const linked = availability.find(
            (record) => record.id === message.availabilityRecordId,
          );
          return (
            <li key={message.id} className="py-3">
              <p className="text-sm text-steel-800">{message.body}</p>
              <p className="mt-1 text-xs text-steel-400">{formatDateTime(message.sentAt)}</p>
              {linked === undefined ? (
                <Badge tone="neutral" size="sm" className="mt-2">
                  {message.status === 'unread' ? 'Not read yet' : 'Read — nothing recorded'}
                </Badge>
              ) : (
                <p className="mt-2 text-xs text-verdant-700">
                  <Icon name="check" className="mr-1 inline size-3" />
                  Availability recorded — {summariseAvailability(linked)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    )}
  </Card>
);
