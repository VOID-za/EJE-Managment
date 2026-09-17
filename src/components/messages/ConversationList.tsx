'use client';

import { userFullName } from '@/domain';
import { Avatar, Badge, EmptyState, Icon } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import type { ConversationSummary } from '@/application/chat-operations';
import { cn } from '@/lib/cn';

/**
 * The conversation list.
 *
 * A thread with several Masters is shown as "the office" rather than three
 * names, because that is what the technician actually wrote to and what they
 * expect to see in the list.
 */
export const conversationTitle = (summary: ConversationSummary): string => {
  if (summary.participants.length === 0) return 'Unknown';
  if (summary.participants.length === 1) return userFullName(summary.participants[0]!);
  const allMasters = summary.participants.every((user) => user.role === 'master');
  return allMasters
    ? `The office (${summary.participants.length} Masters)`
    : summary.participants.map((user) => user.firstName).join(', ');
};

export const ConversationList = ({
  summaries,
  activeId,
  onSelect,
}: {
  readonly summaries: readonly ConversationSummary[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
}) => {
  if (summaries.length === 0) {
    return (
      <EmptyState
        title="No conversations"
        description="Start one to ask a colleague something."
        icon={<Icon name="note" />}
      />
    );
  }

  return (
    <ul className="divide-y divide-steel-100">
      {summaries.map((summary) => {
        const active = summary.conversation.id === activeId;
        return (
          <li key={summary.conversation.id}>
            <button
              type="button"
              onClick={() => onSelect(summary.conversation.id)}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'flex w-full min-h-16 items-start gap-3 px-4 py-3 text-left transition-colors',
                active ? 'bg-eje-50' : 'hover:bg-steel-50',
              )}
            >
              <Avatar
                initials={
                  summary.participants.length === 1
                    ? (summary.participants[0]?.initials ?? '??')
                    : 'EJE'
                }
                size="md"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-steel-900">
                    {conversationTitle(summary)}
                  </span>
                  {summary.unread > 0 && (
                    <Badge tone="blue" size="sm">
                      {summary.unread}
                    </Badge>
                  )}
                </span>

                {summary.conversation.jobNumber !== null && (
                  <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-steel-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-steel-600">
                    {summary.conversation.jobNumber}
                  </span>
                )}

                <span
                  className={cn(
                    'mt-0.5 block truncate text-xs',
                    summary.unread > 0 ? 'font-medium text-steel-700' : 'text-steel-500',
                  )}
                >
                  {summary.lastMessage?.body ?? 'No messages yet'}
                </span>
                <span className="mt-0.5 block text-[11px] text-steel-400">
                  {formatRelative(summary.conversation.lastMessageAt)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
};
