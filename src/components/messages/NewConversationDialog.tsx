'use client';

import { useState } from 'react';
import { userFullName, type Job, type User } from '@/domain';
import { Button, Modal, SelectField, TextAreaField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { conversations } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * Start a conversation.
 *
 * A technician gets "the office" as the default recipient, because that is who
 * they actually need — whoever is at a desk, not one named Master. A Master
 * picks the technician. Disabled accounts are not offered: `permittedRecipients`
 * has already filtered them out, since a message nobody can sign in to read is
 * not a message.
 */
export const NewConversationDialog = ({
  recipients,
  jobs,
  onClose,
  onStarted,
}: {
  readonly recipients: readonly User[];
  readonly jobs: readonly Job[];
  readonly onClose: () => void;
  readonly onStarted: (conversationId: string) => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const isTechnician = currentUser.role !== 'master';

  const [recipientId, setRecipientId] = useState(isTechnician ? 'office' : '');
  const [jobId, setJobId] = useState('');
  const [body, setBody] = useState('');

  const linkable = jobs
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 40);

  const submit = async (): Promise<void> => {
    let startedId: string | null = null;
    const job = linkable.find((candidate) => candidate.id === jobId) ?? null;

    const ok = await operation.run(async () => {
      const result = await conversations.start({
        // Empty means "the office": the operation resolves it to every active
        // Master, so a technician never has to guess who is on duty.
        recipientIds: recipientId === 'office' || recipientId === '' ? [] : [recipientId],
        body,
        jobId: job === null ? null : job.id,
      });
      startedId = (result as { conversation: { id: string } }).conversation.id;
    });

    if (ok && startedId !== null) onStarted(startedId);
  };

  return (
    <Modal
      open
      title="New message"
      description={
        isTechnician
          ? 'Reaches every Master on duty.'
          : 'Goes to the technician you choose.'
      }
      onClose={onClose}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            loading={operation.running}
            disabled={body.trim().length === 0 || (!isTechnician && recipientId === '')}
          >
            Send message
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The message was not sent"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        <SelectField
          label="To"
          required
          value={recipientId}
          onChange={(event) => setRecipientId(event.target.value)}
          placeholder={isTechnician ? undefined : 'Choose a technician'}
          options={[
            ...(isTechnician ? [{ value: 'office', label: 'The office (all Masters)' }] : []),
            ...recipients.map((user) => ({
              value: user.id,
              label: `${userFullName(user)} — ${user.jobTitle}`,
            })),
          ]}
        />

        <SelectField
          label="About a job"
          value={jobId}
          onChange={(event) => setJobId(event.target.value)}
          placeholder="Not about a specific job"
          options={linkable.map((job) => ({
            value: job.id,
            label: `${job.jobNumber} — ${job.faultDescription.slice(0, 48) || 'No description'}`,
          }))}
          hint="Optional. A linked conversation can be opened straight from the job number."
        />

        <TextAreaField
          label="Message"
          required
          rows={4}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="e.g. Please confirm the machine serial number before you close this one."
        />
      </div>
    </Modal>
  );
};
