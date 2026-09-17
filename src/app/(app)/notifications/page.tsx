'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { can, type AppNotification, type NotificationChannel, type NotificationType } from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Icon,
  LoadingPanel,
  Tabs,
  type IconName,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { MasterInbox } from '@/components/messages/MasterInbox';
import { MessageMastersCard } from '@/components/messages/MessageMastersCard';
import { MyMessagesCard } from '@/components/messages/MyMessagesCard';
import { useQuery } from '@/hooks/useQuery';
import { useApp, useCurrentUser } from '@/providers/AppProvider';
import { formatDateTime, formatRelative } from '@/lib/format';
import { cn } from '@/lib/cn';

const TYPE_ICONS: Record<NotificationType, IconName> = {
  job_assigned: 'jobs',
  job_transferred: 'user',
  customer_change_request: 'customers',
  machine_approval_request: 'machines',
  document_approval_request: 'library',
  job_submitted: 'document',
  technician_message: 'note',
};

const TYPE_LABELS: Record<NotificationType, string> = {
  job_assigned: 'New job assigned',
  job_transferred: 'Job transferred',
  customer_change_request: 'Customer change request',
  machine_approval_request: 'Machine approval request',
  document_approval_request: 'Document approval request',
  job_submitted: 'Job submitted',
  technician_message: 'Message from a technician',
};

const CHANNEL_ICONS: Record<NotificationChannel, IconName> = {
  in_app: 'bell',
  whatsapp: 'whatsapp',
  email: 'mail',
};

const REQUIRES_ACTION: readonly NotificationType[] = [
  'customer_change_request',
  'machine_approval_request',
  'document_approval_request',
];

type TabId = 'inbox' | 'messages' | 'handled' | 'outbox';

const NotificationsPageContent = () => {
  const user = useCurrentUser();
  const { repositories, outbox } = useApp();
  const params = useSearchParams();
  const [tab, setTab] = useState<TabId>((params.get('tab') as TabId | null) ?? 'inbox');

  const query = useQuery(`notifications:${user.id}`, (repos) => repos.notifications.list(user.id));

  // Messages are a separate stream from notifications: a notification says
  // something happened, a message is a person asking the office for something.
  const messagesQuery = useQuery('notifications:messages', async (repos) => {
    const [messages, users, availability] = await Promise.all([
      repos.messages.list(),
      repos.users.list(),
      repos.availability.list(),
    ]);
    return { messages, users, availability };
  });
  const jobsQuery = useQuery('notifications:jobNumbers', async (repos) => {
    const jobs = await repos.jobs.list();
    return new Map(jobs.map((job) => [job.id as string, job.jobNumber]));
  });

  if (query.error !== null) {
    return <ErrorState message={query.error} onRetry={query.refetch} />;
  }

  const notifications = query.data ?? [];
  const inbox = notifications.filter((notification) => notification.handledAt === null);
  const handled = notifications.filter((notification) => notification.handledAt !== null);
  const unread = notifications.filter((notification) => notification.readAt === null);

  const visible = tab === 'inbox' ? inbox : handled;
  const isMaster = can(user.role, 'admin.access');
  const messageData = messagesQuery.data;
  const openMessages =
    messageData === null || messageData === undefined
      ? []
      : messageData.messages.filter((message) => message.status !== 'actioned');

  return (
    <>
      <PageHeader
        title="Notifications"
        breadcrumbs={[{ label: 'Notifications' }]}
        description="Job assignments, transfers and approval requests, plus everything the system would have sent."
        actions={
          unread.length > 0 && (
            <Button
              variant="secondary"
              onClick={async () => {
                await repositories.notifications.markAllRead(user.id);
                query.refetch();
              }}
            >
              Mark all as read
            </Button>
          )
        }
      />

      <Tabs
        tabs={[
          {
            id: 'inbox',
            label: 'Inbox',
            badge:
              unread.length > 0 ? (
                <Badge tone="red" size="sm">
                  {unread.length}
                </Badge>
              ) : undefined,
          },
          {
            id: 'messages',
            label: isMaster ? 'Messages' : 'Message the office',
            badge:
              isMaster && openMessages.length > 0 ? (
                <Badge tone="amber" size="sm">
                  {openMessages.length}
                </Badge>
              ) : undefined,
          },
          { id: 'handled', label: 'Handled' },
          {
            id: 'outbox',
            label: 'Simulated Outbox',
            badge: (
              <Badge tone="amber" size="sm">
                {outbox.length}
              </Badge>
            ),
          },
        ]}
        activeId={tab}
        onChange={(id) => setTab(id as TabId)}
        className="mb-5"
      />

      {tab === 'messages' ? (
        isMaster ? (
          messagesQuery.loading || messageData === null || messageData === undefined ? (
            <LoadingPanel rows={3} label="Loading messages" />
          ) : (
            <MasterInbox
              messages={messageData.messages}
              users={messageData.users}
              availability={messageData.availability}
              onChanged={messagesQuery.refetch}
            />
          )
        ) : (
          <div className="space-y-4">
            <MessageMastersCard onSent={messagesQuery.refetch} />
            <MyMessagesCard
              messages={(messageData?.messages ?? []).filter(
                (message) => message.senderId === user.id,
              )}
              availability={messageData?.availability ?? []}
            />
          </div>
        )
      ) : tab === 'outbox' ? (
        <OutboxPanel />
      ) : query.loading ? (
        <LoadingPanel rows={4} label="Loading notifications" />
      ) : visible.length === 0 ? (
        <EmptyState
          title={tab === 'inbox' ? 'Nothing needs your attention' : 'Nothing handled yet'}
          description={
            tab === 'inbox'
              ? 'New job assignments and approval requests will appear here.'
              : 'Notifications you action will be filed here.'
          }
          icon={<Icon name="bell" />}
        />
      ) : (
        <ul className="space-y-3">
          {visible.map((notification) => (
            <li key={notification.id}>
              <NotificationRow
                notification={notification}
                jobNumber={
                  notification.jobId === null
                    ? null
                    : (jobsQuery.data?.get(notification.jobId) ?? null)
                }
                onRead={async () => {
                  await repositories.notifications.markRead(notification.id);
                  query.refetch();
                }}
                onHandled={async () => {
                  await repositories.notifications.markHandled(notification.id);
                  query.refetch();
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
};

const NotificationRow = ({
  notification,
  jobNumber,
  onRead,
  onHandled,
}: {
  readonly notification: AppNotification;
  readonly jobNumber: string | null;
  readonly onRead: () => void;
  readonly onHandled: () => void;
}) => {
  const unread = notification.readAt === null;
  const actionable = REQUIRES_ACTION.includes(notification.type);

  return (
    <Card className={cn(unread && 'border-eje-200 bg-eje-50/40')}>
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)]',
            unread ? 'bg-eje-100 text-eje-700' : 'bg-steel-100 text-steel-500',
          )}
        >
          <Icon name={TYPE_ICONS[notification.type]} className="size-5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-steel-900">{notification.title}</p>
            {unread && (
              <Badge tone="blue" size="sm" dot>
                Unread
              </Badge>
            )}
            {notification.handledAt !== null && (
              <Badge tone="green" size="sm">
                Handled
              </Badge>
            )}
          </div>

          <p className="mt-1 text-sm leading-relaxed text-steel-600">{notification.body}</p>

          <div className="mt-2.5 flex flex-wrap items-center gap-3 text-xs text-steel-400">
            <span>{TYPE_LABELS[notification.type]}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={notification.createdAt} title={formatDateTime(notification.createdAt)}>
              {formatRelative(notification.createdAt)}
            </time>
            <span aria-hidden="true">·</span>
            <span className="flex items-center gap-1.5">
              Delivered via
              {notification.channels.map((channel) => (
                <span
                  key={channel}
                  className="inline-flex items-center gap-1 rounded-full bg-steel-100 px-2 py-0.5 text-[11px] font-medium text-steel-600"
                  title={
                    channel === 'in_app'
                      ? 'In-app notification'
                      : `${channel} delivery is simulated in this demonstration`
                  }
                >
                  <Icon name={CHANNEL_ICONS[channel]} className="size-3" />
                  {channel === 'in_app' ? 'In app' : channel === 'whatsapp' ? 'WhatsApp' : 'Email'}
                  {channel !== 'in_app' && <span className="text-amber-eje-600">(simulated)</span>}
                </span>
              ))}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {jobNumber !== null && (
              <Link href={`/jobs/${jobNumber}`}>
                <Button size="sm" variant="secondary">
                  Open {jobNumber}
                </Button>
              </Link>
            )}
            {unread && (
              <Button size="sm" variant="ghost" onClick={onRead}>
                Mark as read
              </Button>
            )}
            {actionable && notification.handledAt === null && (
              <Button size="sm" onClick={onHandled}>
                Mark as handled
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
};

/**
 * The Simulated Outbox.
 *
 * Shows exactly what the production system would transmit over email and
 * WhatsApp. Nothing here left the browser.
 */
const OutboxPanel = () => {
  const { outbox } = useApp();

  return (
    <div className="space-y-4">
      <Card className="border-amber-eje-200 bg-amber-eje-50">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-eje-500 text-white">
            <Icon name="warning" className="size-5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-amber-eje-700">
              Nothing in this list was sent
            </p>
            <p className="mt-1 text-sm text-steel-700">
              Email and WhatsApp are represented by service interfaces in this demonstration. When a
              job card is submitted, the message that production would transmit is recorded here
              instead. Connecting Microsoft 365 and the WhatsApp Business Platform in Phase 2
              replaces the adapter behind these interfaces — no business logic changes.
            </p>
          </div>
        </div>
      </Card>

      {outbox.length === 0 ? (
        <EmptyState
          title="The outbox is empty"
          description="Submit a job card and the email that would be sent to the customer will be recorded here."
          icon={<Icon name="mail" />}
        />
      ) : (
        <ul className="space-y-3">
          {outbox.map((entry) => (
            <li key={entry.id}>
              <Card>
                <CardHeader
                  title={entry.subject}
                  description={`To: ${entry.to}`}
                  action={
                    <div className="flex items-center gap-2">
                      <Badge tone={entry.channel === 'email' ? 'blue' : 'green'} size="sm">
                        <Icon
                          name={entry.channel === 'email' ? 'mail' : 'whatsapp'}
                          className="size-3"
                        />
                        {entry.channel === 'email' ? 'Email' : 'WhatsApp'}
                      </Badge>
                      <Badge tone="amber" size="sm">
                        Simulated
                      </Badge>
                    </div>
                  }
                />
                <pre className="mt-4 overflow-x-auto rounded-[var(--radius-control)] bg-steel-50 p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-steel-700">
                  {entry.body}
                </pre>
                {entry.attachments.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold text-steel-500">Attachments:</span>
                    {entry.attachments.map((attachment) => (
                      <Badge key={attachment} tone="outline" size="sm">
                        <Icon name="document" className="size-3" />
                        {attachment}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="mt-3 text-xs text-steel-400">
                  Recorded {formatDateTime(entry.createdAt)}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const NotificationsPage = () => (
  <Suspense fallback={<LoadingPanel rows={4} label="Loading notifications" />}>
    <NotificationsPageContent />
  </Suspense>
);

export default NotificationsPage;
