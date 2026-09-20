'use client';

import { jobs } from '@/api/endpoints';
import { useState } from 'react';
import { userFullName, type Job, type User } from '@/domain';
import { Avatar, Badge, Button, Card, EmptyState, Icon, TextAreaField } from '@/components/ui';
import { useOperation } from '@/hooks/useOperation';
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
  const operation = useOperation();
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);

  // Internal notes are visible to all EJE staff — this is an internal system.
  // What "internal" controls is whether the note reaches the CUSTOMER document.
  const visible = job.notes;

  const submit = async () => {
    if (body.trim().length === 0) return;
    const ok = await operation.run(() => jobs.addNote(job.id, body.trim(), internal));
    if (ok) {
      setBody('');
      setInternal(false);
      onChanged();
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-[var(--radius-control)] border border-eje-200 bg-eje-50 px-4 py-3 text-sm text-eje-800">
        <span className="font-semibold">Notes are the job&rsquo;s running record</span> — calls,
        access problems, customer requests, anything that happened along the way. The formal
        technical write-up (fault findings, diagnosis, work performed, recommendations) belongs on
        the <span className="font-semibold">Completion</span> tab.
      </div>

      {editable && (
        <Card>
          <TextAreaField
            label="Add a note"
            rows={3}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="e.g. Spoke to the customer about machine availability — return visit agreed for Friday."
            hint="A running record of what happened on this job. The formal technical write-up belongs on the Completion tab."
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <fieldset className="flex flex-wrap items-center gap-2">
              <legend className="sr-only">Who can see this note</legend>
              {(
                [
                  {
                    value: false,
                    label: 'Customer-facing',
                    hint: 'Appears on the customer job card',
                  },
                  {
                    value: true,
                    label: 'Internal only',
                    hint: 'Never leaves EJE',
                  },
                ] as const
              ).map((option) => (
                <label
                  key={option.label}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-2 rounded-[var(--radius-control)] border px-3 text-sm font-medium transition-colors',
                    internal === option.value
                      ? 'border-eje-500 bg-eje-50 text-eje-800'
                      : 'border-steel-300 text-steel-600 hover:border-steel-400',
                  )}
                >
                  <input
                    type="radio"
                    name="note-visibility"
                    checked={internal === option.value}
                    onChange={() => setInternal(option.value)}
                    className="size-4 border-steel-300 text-eje-600 focus:ring-eje-500"
                  />
                  <span>
                    {option.label}
                    <span className="ml-1.5 text-xs font-normal text-steel-500">
                      {option.hint}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
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
                          <Badge tone={note.internal ? 'amber' : 'green'} size="sm">
                            {note.internal ? 'Internal only' : 'On the job card'}
                          </Badge>
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
