'use client';

import { conversations } from '@/api/endpoints';
import { useState } from 'react';
import Link from 'next/link';
import {
  isMessageRead,
  summariseAvailability,
  userFullName,
  type AvailabilityRecord,
  type ChatMessage,
  type Conversation,
  type User,
} from '@/domain';
import { Avatar, Badge, Button, Icon, TextAreaField } from '@/components/ui';
import { AvailabilityDialog } from '@/components/availability/AvailabilityDialog';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * One conversation.
 *
 * Deliberately plain: a list of messages and a box. What it must NOT do is act
 * on the job or on anyone's availability by itself — a Master who wants to
 * record an absence a technician mentioned presses "Mark unavailable" here, and
 * that is an explicit act which links the resulting record back to the message.
 */
export const ConversationThread = ({
  conversation,
  messages,
  users,
  availability,
  onSent,
  onAvailabilityRecorded,
}: {
  readonly conversation: Conversation;
  readonly messages: readonly ChatMessage[];
  readonly users: readonly User[];
  readonly availability: readonly AvailabilityRecord[];
  readonly onSent: () => void;
  readonly onAvailabilityRecorded: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const [body, setBody] = useState('');
  const [recordingFor, setRecordingFor] = useState<{
    message: ChatMessage;
    technician: User;
  } | null>(null);

  const isMaster = currentUser.role === 'master';
  const named = (id: string): User | undefined => users.find((user) => user.id === id);

  const send = async (): Promise<void> => {
    const ok = await operation.run(() => conversations.send(conversation.id, body));
    if (ok) {
      setBody('');
      onSent();
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-steel-100 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-steel-900">
            {conversation.participantIds
              .filter((id) => id !== currentUser.id)
              .map((id) => named(id)?.firstName ?? 'Unknown')
              .join(', ')}
          </p>
          <p className="text-xs text-steel-500">
            {conversation.participantIds.length - 1 === 1 ? 'Direct message' : 'With the office'}
          </p>
        </div>
        {conversation.jobNumber !== null && (
          <Link href={`/jobs/${conversation.jobNumber}`}>
            <Button size="sm" variant="secondary" leadingIcon={<Icon name="jobs" className="size-4" />}>
              {conversation.jobNumber}
            </Button>
          </Link>
        )}
      </div>

      <ul className="eje-scrollbar flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <li className="text-sm text-steel-400 italic">No messages yet.</li>
        )}
        {messages.map((message) => {
          const mine = message.senderId === currentUser.id;
          const sender = named(message.senderId);
          const linked = availability.find(
            (record) => record.id === message.availabilityRecordId,
          );

          return (
            <li key={message.id} className={cn('flex gap-2.5', mine && 'flex-row-reverse')}>
              <Avatar initials={sender?.initials ?? '??'} size="sm" />
              <div className={cn('min-w-0 max-w-[80%]', mine && 'text-right')}>
                <p className="text-[11px] text-steel-400">
                  {sender === undefined ? 'Unknown' : userFullName(sender)} ·{' '}
                  {formatDateTime(message.sentAt)}
                  {!mine && !isMessageRead(message, currentUser.id) && ' · new'}
                </p>
                <p
                  className={cn(
                    'mt-1 inline-block rounded-[var(--radius-control)] px-3 py-2 text-sm leading-relaxed',
                    mine
                      ? 'bg-eje-600 text-white'
                      : 'bg-steel-100 text-steel-800',
                  )}
                >
                  {message.body}
                </p>

                {linked !== undefined && (
                  <p className="mt-1.5 text-[11px] text-verdant-700">
                    <Icon name="check" className="mr-1 inline size-3" />
                    Availability recorded — {summariseAvailability(linked)}
                  </p>
                )}

                {/* A Master can turn a technician's message into an official
                    availability record. Never automatic: the office decides. */}
                {isMaster &&
                  !mine &&
                  message.availabilityRecordId === null &&
                  named(message.senderId)?.role === 'technician' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1"
                      onClick={() =>
                        setRecordingFor({
                          message,
                          technician: named(message.senderId)!,
                        })
                      }
                    >
                      Mark unavailable
                    </Button>
                  )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-steel-100 px-4 py-3">
        {operation.error !== null && (
          <div className="mb-3">
            <RuleViolationNotice
              title="The message was not sent"
              message={operation.error}
              violations={operation.violations}
            />
          </div>
        )}

        <TextAreaField
          label="Message"
          rows={2}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Type a message…"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-steel-500">
            A message reaches the person. It does not change the job or anyone&rsquo;s
            availability.
          </p>
          <Button onClick={send} loading={operation.running} disabled={body.trim().length === 0}>
            Send
          </Button>
        </div>
      </div>

      {recordingFor !== null && (
        <AvailabilityDialog
          technician={recordingFor.technician}
          fromMessage={recordingFor.message}
          onClose={() => setRecordingFor(null)}
          onSaved={() => {
            setRecordingFor(null);
            onAvailabilityRecorded();
          }}
        />
      )}
    </div>
  );
};

/** Unread badge for the sidebar and the page header. */
export const UnreadBadge = ({ count }: { readonly count: number }) =>
  count === 0 ? null : (
    <Badge tone="blue" size="sm">
      {count}
    </Badge>
  );
