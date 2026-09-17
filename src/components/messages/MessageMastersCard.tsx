'use client';

import { useState } from 'react';
import { sendMessageToMasters } from '@/application/message-operations';
import { Button, Card, CardHeader, TextAreaField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';

/**
 * The technician's side of messaging.
 *
 * Deliberately one box and one button. The helper text does the important work:
 * it says plainly that sending this does not make you unavailable, because the
 * natural assumption is the opposite and acting on that assumption is how a
 * technician ends up double-booked.
 */
export const MessageMastersCard = ({ onSent }: { readonly onSent?: () => void }) => {
  const operation = useOperation();
  const [body, setBody] = useState('');
  const [sentAt, setSentAt] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const ok = await operation.run((context) => sendMessageToMasters(context, body));
    if (ok) {
      setBody('');
      setSentAt(new Date().toISOString());
      onSent?.();
    }
  };

  return (
    <Card>
      <CardHeader
        title="Message the office"
        description="Appointments, running late, a day off sick — anything the office needs to know about your availability."
      />

      {operation.error !== null && (
        <div className="mt-3">
          <RuleViolationNotice
            title="The message was not sent"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      )}

      {sentAt !== null && operation.error === null && (
        <p className="mt-3 rounded-[var(--radius-control)] border border-verdant-200 bg-verdant-50 px-3 py-2.5 text-sm text-verdant-700">
          Sent. A Master will pick it up and record anything that needs to go on the calendar.
        </p>
      )}

      <div className="mt-4">
        <TextAreaField
          label="Message"
          rows={3}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="e.g. Hi Christene. I've got a doctor's appointment today at 9am. I'll be back at 11am."
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md text-xs text-steel-500">
          This is a message, not a leave request form.{' '}
          <span className="font-semibold text-steel-700">
            Sending it does not mark you unavailable
          </span>{' '}
          — a Master decides what goes on the calendar.
        </p>
        <Button onClick={send} loading={operation.running} disabled={body.trim().length === 0}>
          Send message
        </Button>
      </div>
    </Card>
  );
};
