'use client';

import { useState } from 'react';
import { can, userFullName, type Job, type User } from '@/domain';
import { addNote } from '@/application/job-operations';
import { Avatar, Badge, Button, Card, EmptyState, Icon, TextAreaField } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/cn';

export const JobNotesPanel = ({
  job,
  users,
  editable,
  onChanged,
}: {
  readonly job: Job;
  readonly users: readonly User[];
  readonly editable: boolean;
  readonly onChanged: () => void;
}) => {
  const user = useCurrentUser();
  const operation = useOperation();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);

  const canSeeInternal = can(user.role, 'jobs.viewAll');
  const visible = job.notes.filter((note) => !note.internal || canSeeInternal);

  const submit = async () => {
    if (body.trim().length === 0) return;
    const ok = await operation.run((context) => addNote(context, job, body.trim(), internal));
    if (ok) {
      setBody('');
      setInternal(false);
      onChanged();
    }
  };

  return (
    <div className="space-y-4">
      {editable && (
        <Card>
          <TextAreaField
            label="Add a note"
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="What should the next person to open this job know?"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            {canSeeInternal ? (
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-steel-700">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(event) => setInternal(event.target.checked)}
                  className="size-4.5 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
                />
                Internal note — never appears on the customer job card
              </label>
            ) : (
              <span className="text-xs text-steel-500">
                Notes are visible to the office and appear on the job card.
              </span>
            )}
            <Button
              onClick={submit}
              loading={operation.running}
              disabled={body.trim().length === 0}
            >
              Add note
            </Button>
          </div>
          {operation.error !== null && (
            <p role="alert" className="mt-2 text-sm text-signal-600">
              {operation.error}
            </p>
          )}
        </Card>
      )}

      {visible.length === 0 ? (
        <EmptyState
          title="No notes yet"
          description="Notes record decisions, customer instructions and anything the next technician needs to know."
          icon={<Icon name="note" />}
        />
      ) : (
        <ul className="space-y-3">
          {[...visible]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((note) => {
              const author = users.find((candidate) => candidate.id === note.authorId);
              return (
                <li key={note.id}>
                  <Card
                    className={cn(
                      note.internal && 'border-amber-eje-200 bg-amber-eje-50/50',
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <Avatar initials={author?.initials ?? '—'} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-steel-900">
                            {author === undefined ? 'Unknown user' : userFullName(author)}
                          </span>
                          <span className="text-xs text-steel-400">
                            {formatRelative(note.createdAt)}
                          </span>
                          {note.internal && (
                            <Badge tone="amber" size="sm">
                              Internal
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line text-steel-700">
                          {note.body}
                        </p>
                      </div>
                    </div>
                  </Card>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
};
