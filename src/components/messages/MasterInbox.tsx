'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  summariseAvailability,
  userFullName,
  type AvailabilityRecord,
  type TechnicianMessage,
  type User,
} from '@/domain';
import { markMessageRead } from '@/application/message-operations';
import { Avatar, Badge, Button, Card, EmptyState, Icon } from '@/components/ui';
import { AvailabilityDialog } from '@/components/availability/AvailabilityDialog';
import { useOperation } from '@/hooks/useOperation';
import { formatDateTime } from '@/lib/format';

/**
 * The Master's side of messaging.
 *
 * Each message offers exactly the two things a Master wants: open the
 * technician, or record the availability the message is asking about. Once
 * recorded, the message shows what was done instead of staying an open loop.
 */
export const MasterInbox = ({
  messages,
  users,
  availability,
  onChanged,
}: {
  readonly messages: readonly TechnicianMessage[];
  readonly users: readonly User[];
  readonly availability: readonly AvailabilityRecord[];
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [recordingFor, setRecordingFor] = useState<{
    message: TechnicianMessage;
    technician: User;
  } | null>(null);

  if (messages.length === 0) {
    return (
      <EmptyState
        title="No messages"
        description="Technicians' messages about their availability arrive here."
        icon={<Icon name="note" />}
      />
    );
  }

  return (
    <div className="space-y-3">
      {operation.error !== null && (
        <p role="alert" className="text-sm font-medium text-signal-600">
          {operation.error}
        </p>
      )}

      {messages.map((message) => {
        const sender = users.find((user) => user.id === message.senderId);
        const linked = availability.find(
          (record) => record.id === message.availabilityRecordId,
        );

        return (
          <Card
            key={message.id}
            className={message.status === 'unread' ? 'border-eje-300 bg-eje-50/40' : undefined}
          >
            <div className="flex flex-wrap items-start gap-3">
              <Avatar initials={sender?.initials ?? '??'} size="md" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-steel-900">
                  {sender === undefined ? 'Unknown technician' : userFullName(sender)}
                  <span className="text-xs font-normal text-steel-400">
                    {formatDateTime(message.sentAt)}
                  </span>
                  {message.status === 'unread' && (
                    <Badge tone="blue" size="sm" dot>
                      New
                    </Badge>
                  )}
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-steel-800">{message.body}</p>

                {linked !== undefined ? (
                  <p className="mt-2.5 rounded-[var(--radius-control)] border border-verdant-200 bg-verdant-50 px-3 py-2 text-xs text-verdant-700">
                    <Icon name="check" className="mr-1 inline size-3" />
                    Availability recorded — {summariseAvailability(linked)}
                    {message.actionedBy !== null &&
                      ` · by ${
                        users.find((user) => user.id === message.actionedBy)?.firstName ??
                        'a Master'
                      }`}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-steel-500">
                    This message has not changed anyone&rsquo;s availability. Record it below if it
                    needs to go on the calendar.
                  </p>
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-steel-100 pt-3">
              {message.status === 'unread' && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={operation.running}
                  onClick={async () => {
                    const ok = await operation.run((context) =>
                      markMessageRead(context, message),
                    );
                    if (ok) onChanged();
                  }}
                >
                  Mark read
                </Button>
              )}
              {sender !== undefined && (
                <Link href={`/technicians/${sender.id}`}>
                  <Button size="sm" variant="secondary">
                    Open {sender.firstName}&rsquo;s profile
                  </Button>
                </Link>
              )}
              {sender !== undefined && linked === undefined && (
                <Button
                  size="sm"
                  onClick={() => setRecordingFor({ message, technician: sender })}
                >
                  Mark unavailable
                </Button>
              )}
            </div>
          </Card>
        );
      })}

      {recordingFor !== null && (
        <AvailabilityDialog
          technician={recordingFor.technician}
          fromMessage={recordingFor.message}
          onClose={() => setRecordingFor(null)}
          onSaved={() => {
            setRecordingFor(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
};
