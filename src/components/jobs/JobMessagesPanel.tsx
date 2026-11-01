'use client';

import { useState } from 'react';
import { customerEmailStateLabel, type CustomerEmail, type Job, type OutboxMessage } from '@/domain';
import { Badge, Button, Card, CardHeader, LoadingPanel, type BadgeTone } from '@/components/ui';
import { RuleViolationNotice } from './RuleViolationNotice';
import { jobs as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { formatDateTime } from '@/lib/format';

/**
 * A JOB'S EMAIL HISTORY AND WHATSAPP MESSAGES. INT-EMAIL-4, INT-WA-2. For the
 * office.
 *
 * Exactly what was written for the customer — recipient, sender, subject, the
 * actual message, the attachment, the template and version — with its status
 * and every failure. "Sent" means Microsoft 365 accepted it; nothing here
 * claims the customer received it. A sent email cannot be changed. Retry is
 * offered only once an email has stopped, and an attempt whose outcome is
 * uncertain asks the office to check Sent Items first.
 */

const EMAIL_TONE: Record<CustomerEmail['state'], BadgeTone> = {
  queued: 'blue',
  sending: 'blue',
  sent: 'green',
  failed: 'red',
  attention: 'red',
};

const whatsappLabel = (message: OutboxMessage): { label: string; tone: BadgeTone } => {
  if (message.deliveryStatus === 'failed' || message.state === 'failed') return { label: 'Failed', tone: 'red' };
  if (message.deliveryStatus === 'read') return { label: 'Read', tone: 'green' };
  if (message.deliveryStatus === 'delivered') return { label: 'Delivered', tone: 'green' };
  if (message.state === 'sent') return { label: 'Accepted by Meta', tone: 'blue' };
  return { label: 'Waiting to send', tone: 'neutral' };
};

const PURPOSE: Record<string, string> = {
  assignment: 'Assignment notice',
  transfer: 'Transfer notice',
  site_location: 'Site location',
  test: 'Test message',
};

export const JobMessagesPanel = ({ job, onChanged }: { readonly job: Job; readonly onChanged: () => void }) => {
  const query = useQuery(`job:messages:${job.id}:${job.delivery?.updatedAt ?? ''}`, () => api.messages(job.id));
  const operation = useOperation();
  const [confirmNotSent, setConfirmNotSent] = useState(false);

  if (query.loading || query.data === null || query.data === undefined) {
    return query.error !== null ? null : <LoadingPanel rows={2} label="Loading messages" />;
  }
  const { emails, whatsapp } = query.data;
  if (emails.length === 0 && whatsapp.length === 0 && job.finalDocument === null) return null;

  const current = emails.filter((email) => email.attachment?.storageKey === job.finalDocument?.storageKey);
  const latest = current[0] ?? null;
  const retryable =
    job.finalDocument !== null &&
    (latest === null || latest.state === 'failed' || latest.state === 'attention' || (latest.state === 'queued' && latest.attempts > 0));
  const uncertain = latest?.failureKind === 'uncertain';

  const retry = async () => {
    const ok = await operation.run(() => api.retryDelivery(job.id, { confirmNotSent: uncertain ? confirmNotSent : undefined }));
    if (ok) {
      setConfirmNotSent(false);
      query.refetch();
      onChanged();
    }
  };
  const retryWhatsApp = async (messageId: string) => {
    if (await operation.run(() => api.retryWhatsApp(job.id, messageId))) query.refetch();
  };

  return (
    <Card className="mb-5" data-testid="job-messages">
      <CardHeader
        title="Customer emails and WhatsApp messages"
        description="Exactly what EJE sent, and what the providers said. Sent means accepted by Microsoft 365 or Meta, not read."
      />
      {operation.error !== null && <RuleViolationNotice title="That was not done" message={operation.error} violations={operation.violations} />}

      {job.finalDocument !== null && (
        <section className="mt-4" data-testid="job-email-history">
          <h3 className="text-sm font-semibold text-ink">Signed job card emails</h3>
          {emails.length === 0 ? (
            <p className="mt-2 text-sm text-steel-600">
              None recorded. Job cards issued before the automatic email existed were sent directly; their delivery is shown above.
            </p>
          ) : (
            <ol className="mt-2 space-y-3">
              {emails.map((email) => (
                <li key={email.id} className="rounded-md border border-steel-200 p-3" data-testid="job-email">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-words text-sm font-semibold text-ink">{email.subject.length > 0 ? email.subject : '(not composed)'}</span>
                    <Badge tone={EMAIL_TONE[email.state]}>{customerEmailStateLabel(email.state)}</Badge>
                  </div>
                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-steel-600 sm:grid-cols-2">
                    <div className="break-words"><dt className="inline font-medium text-steel-700">To: </dt><dd className="inline" data-testid="job-email-recipient">{email.recipient || 'no valid address'}</dd></div>
                    {email.cc.length > 0 && <div className="break-words"><dt className="inline font-medium text-steel-700">CC: </dt><dd className="inline">{email.cc.join(', ')}</dd></div>}
                    <div className="break-words"><dt className="inline font-medium text-steel-700">From: </dt><dd className="inline">{email.sender || '—'}</dd></div>
                    <div className="break-words"><dt className="inline font-medium text-steel-700">Attachment: </dt><dd className="inline" data-testid="job-email-attachment">{email.attachment?.fileName ?? 'none'}</dd></div>
                    <div className="break-words"><dt className="inline font-medium text-steel-700">Template: </dt><dd className="inline" data-testid="job-email-template">{email.templateName.length > 0 ? `${email.templateName}, version ${email.templateVersion}` : '—'}</dd></div>
                    <div><dt className="inline font-medium text-steel-700">Written: </dt><dd className="inline">{formatDateTime(email.createdAt)}</dd></div>
                    <div><dt className="inline font-medium text-steel-700">Sent: </dt><dd className="inline">{email.sentAt === null ? '—' : formatDateTime(email.sentAt)}</dd></div>
                    <div><dt className="inline font-medium text-steel-700">Attempts: </dt><dd className="inline">{email.attempts}</dd></div>
                    {email.nextAttemptAt !== null && email.state === 'queued' && (
                      <div><dt className="inline font-medium text-steel-700">Next attempt: </dt><dd className="inline">{formatDateTime(email.nextAttemptAt)}</dd></div>
                    )}
                  </dl>
                  {email.failureReason.length > 0 && (
                    <p className="mt-2 break-words text-sm text-signal-700" data-testid="job-email-failure">{email.failureReason}</p>
                  )}
                  {email.body.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-semibold text-eje-700">The message as sent</summary>
                      <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm text-steel-700" data-testid="job-email-body">{email.body}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
          {retryable && (
            <div className="mt-3 space-y-2">
              {uncertain && (
                <label className="flex min-h-11 items-start gap-2 text-sm text-steel-700">
                  <input type="checkbox" className="mt-1 size-5" checked={confirmNotSent} data-testid="job-email-confirm-not-sent" onChange={(event) => setConfirmNotSent(event.target.checked)} />
                  I checked the sending mailbox’s Sent Items and this email is not there.
                </label>
              )}
              <Button
                size="sm"
                data-testid="job-email-retry"
                disabled={uncertain && !confirmNotSent}
                loading={operation.running}
                onClick={() => void retry()}
              >
                {latest !== null && latest.state === 'queued' ? 'Retry now' : 'Retry the email'}
              </Button>
            </div>
          )}
        </section>
      )}

      {whatsapp.length > 0 && (
        <section className="mt-5" data-testid="job-whatsapp-history">
          <h3 className="text-sm font-semibold text-ink">WhatsApp</h3>
          <ul className="mt-2 divide-y divide-steel-100">
            {whatsapp.map((message) => {
              const status = whatsappLabel(message);
              const failed = status.label === 'Failed';
              return (
                <li key={message.id} className="py-2 text-sm" data-testid="job-whatsapp">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-ink">{PURPOSE[message.purpose ?? ''] ?? message.template}</span>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  <p className="break-words text-xs text-steel-600">
                    {formatDateTime(message.createdAt)} · template {message.template} · attempts {message.attempts}
                    {message.providerError !== undefined && message.providerError.length > 0 ? ` · ${message.providerError}` : ''}
                    {message.failureReason.length > 0 ? ` · ${message.failureReason}` : ''}
                  </p>
                  {failed && (
                    <Button size="sm" variant="secondary" className="mt-1" data-testid="job-whatsapp-retry" loading={operation.running} onClick={() => void retryWhatsApp(message.id)}>
                      Retry
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </Card>
  );
};
