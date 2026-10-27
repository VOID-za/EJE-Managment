'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { permittedRecipients } from '@/application/chat-operations';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { ConversationList } from '@/components/messages/ConversationList';
import { ConversationThread } from '@/components/messages/ConversationThread';
import { NewConversationDialog } from '@/components/messages/NewConversationDialog';
import { conversations as conversationsApi, reads } from '@/api/endpoints';
import { useQuery } from '@/hooks/useQuery';
import { useApp, useCurrentUser } from '@/providers/AppProvider';

/**
 * Messages.
 *
 * Deliberately NOT the Notifications page. A notification says the system did
 * something; a message is a person asking you something. Mixed together, the
 * one that needs a reply gets lost among the ones that do not.
 *
 * A Master writes to a technician, a technician writes to the office. Both
 * directions, one screen, and nothing here can change a job.
 */
const MessagesPageContent = () => {
  const currentUser = useCurrentUser();
  const params = useSearchParams();

  const [selected, setSelected] = useState<string | null>(params.get('conversation'));
  const [composing, setComposing] = useState(false);
  // NOTIF-AUDIT-1: invalidating re-counts the shell's Messages badge as well.
  const { invalidate } = useApp();
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const query = useQuery(`messages:${currentUser.id}:${selected ?? 'none'}`, () =>
    reads.messages(selected),
  );

  const data = query.data;
  // Memoised because the unread total derives from it; a fresh array identity
  // every render would recompute on every keystroke in the thread box.
  const summaries = useMemo(() => data?.summaries ?? [], [data]);

  // Default to the conversation named in the URL — a chat notification links
  // straight here — otherwise the most recent, so the screen is never blank
  // when there is something to read.
  // The server says which thread it sent; the URL wins where it names one.
  const activeId = selected ?? data?.selectedId ?? summaries[0]?.conversation.id ?? null;
  const active = summaries.find((summary) => summary.conversation.id === activeId) ?? null;

  // The thread comes back with the list: one read for the screen, and the
  // server refuses a conversation this actor is not in.
  const thread = useMemo(() => data?.thread ?? [], [data]);

  const unreadTotal = useMemo(
    () => summaries.reduce((total, summary) => total + summary.unread, 0),
    [summaries],
  );

  const refresh = useCallback(() => {
    query.refetch();
  }, [query]);

  // Opening a thread clears its unread messages. In an effect, never during
  // render: notifying the store while rendering is what produces React's
  // "cannot update a component while rendering a different one". The ref makes
  // it idempotent, so re-renders and refetches cannot write repeatedly.
  const markedRef = useRef<string | null>(null);
  const unreadHere = active?.unread ?? 0;

  useEffect(() => {
    if (active === null || unreadHere === 0) return;
    if (markedRef.current === active.conversation.id) return;
    markedRef.current = active.conversation.id;

    let cancelled = false;
    const conversation = active.conversation;
    void (async () => {
      try {
        await conversationsApi.markRead(conversation.id);
        if (!cancelled) invalidate();
      } catch {
        // Marking read is a convenience; failing it must never break the thread.
        markedRef.current = null;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [active, unreadHere, invalidate]);

  if (query.error !== null) {
    return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
  }

  return (
    <>
      <PageHeader
        title="Messages"
        breadcrumbs={[{ label: 'Messages' }]}
        description={
          currentUser.role === 'master'
            ? 'Conversations with technicians. System alerts live under Notifications.'
            : 'Conversations with the office. System alerts live under Notifications.'
        }
        meta={
          unreadTotal > 0 ? (
            <span className="text-sm font-semibold text-eje-700">
              {unreadTotal} unread {unreadTotal === 1 ? 'message' : 'messages'}
            </span>
          ) : undefined
        }
        actions={
          <Button
            leadingIcon={<Icon name="plus" className="size-4" />}
            onClick={() => setComposing(true)}
          >
            New message
          </Button>
        }
      />

      {query.loading && data === undefined ? (
        <LoadingPanel rows={4} label="Loading messages" />
      ) : (
        <Card padded={false} className="overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr]">
            <div className="border-b border-steel-100 lg:border-r lg:border-b-0">
              <ConversationList
                summaries={summaries}
                activeId={activeId}
                onSelect={(id) => {
                  markedRef.current = null;
                  setSelected(id);
                }}
              />
            </div>

            <div className="min-h-[28rem]">
              {active === null || data === null || data === undefined ? (
                <div className="p-6">
                  <EmptyState
                    title="Nothing selected"
                    description="Choose a conversation, or start a new one."
                    icon={<Icon name="note" />}
                  />
                </div>
              ) : (
                <>
                {/* CHAT-DELETE-1: off my own list, after a confirmation. */}
                <div className="flex flex-wrap items-center justify-end gap-2 border-b border-steel-100 px-4 py-2">
                  {deleteError !== null && (
                    <span role="alert" className="text-sm text-signal-600">
                      {deleteError}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    leadingIcon={<Icon name="trash" className="size-4" />}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleting(true);
                    }}
                    data-testid="delete-chat"
                  >
                    Delete chat
                  </Button>
                </div>
                <ConversationThread
                  conversation={active.conversation}
                  messages={thread}
                  users={data.users}
                  availability={data.availability}
                  onSent={refresh}
                  onAvailabilityRecorded={refresh}
                />
                </>
              )}
            </div>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={deleting && active !== null}
        title="Delete this chat?"
        message="It is removed from YOUR list only. The other people in the chat keep it, and EJE keep every message on record. If somebody writes in it again, it comes back to your list showing only the new messages."
        confirmLabel="Delete chat"
        busy={deleteBusy}
        onConfirm={async () => {
          if (active === null) return;
          setDeleteBusy(true);
          try {
            await conversationsApi.deleteForMe(active.conversation.id);
            setDeleting(false);
            markedRef.current = null;
            setSelected(null);
            invalidate();
          } catch (error) {
            setDeleting(false);
            setDeleteError(error instanceof Error ? error.message : 'The chat was not deleted.');
          } finally {
            setDeleteBusy(false);
          }
        }}
        onCancel={() => setDeleting(false)}
      />

      {composing && data !== null && data !== undefined && (
        <NewConversationDialog
          recipients={permittedRecipients(currentUser, data.users)}
          jobs={data.jobs}
          onClose={() => setComposing(false)}
          onStarted={(conversationId) => {
            setComposing(false);
            markedRef.current = null;
            setSelected(conversationId);
            refresh();
          }}
        />
      )}
    </>
  );
};

const MessagesPage = () => (
  <Suspense fallback={<LoadingPanel rows={4} label="Loading messages" />}>
    <MessagesPageContent />
  </Suspense>
);

export default MessagesPage;
