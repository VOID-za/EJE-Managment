'use client';

import { useState } from 'react';
import { userFullName, type Customer, type CustomerNote, type User } from '@/domain';
import { Button, Card, CardHeader, TextAreaField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { customers as api } from '@/api/endpoints';
import { ApiRequestError } from '@/api/client';
import { formatRelative } from '@/lib/format';
import { CUSTOMER_NOTE_LIMIT } from '@/application/customer-operations';

/**
 * ACCOUNT NOTES, AND THEY CAN NOW ACTUALLY BE WRITTEN. Customers §2.
 *
 * What was here before rendered `customer.notes` and offered no way to add one.
 * The notes existed in the schema, were persisted by the repository and were
 * populated by the demonstration seed — so the screen looked finished while the
 * office had no way to record the one thing this card is for.
 *
 * WHO MAY WRITE: whoever holds `customers.manage`, which is a Master or a
 * Coordinator. The parent decides whether to pass `canManage`, and the server
 * decides again — the screen is not the permission.
 *
 * AN EDIT SAYS IT IS AN EDIT. The original author and the original date stay
 * on the note, because they are facts about who said something and when, and
 * an edit does not change either. A corrected note carries "edited by …"
 * underneath instead of quietly showing new words under somebody else's name.
 * The previous wording is on the audit trail.
 */
export const CustomerNotesPanel = ({
  customer,
  users,
  canManage,
  onChanged,
}: {
  readonly customer: Customer;
  readonly users: readonly User[];
  readonly canManage: boolean;
  readonly onChanged: () => void;
}) => {
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly violations: readonly string[];
  } | null>(null);

  const nameOf = (userId: string | null): string => {
    if (userId === null || userId.length === 0) return 'Unknown';
    const found = users.find((candidate) => candidate.id === userId);
    return found === undefined ? 'Unknown' : userFullName(found);
  };

  /*
   * THE SERVER'S OWN WORDS, when it refuses.
   *
   * `ApiRequestError` carries the operation's violations — "a note cannot be
   * emptied", "a note is limited to 2000 characters" — and those are the
   * sentences worth showing. Anything else is reported plainly rather than as
   * a stack.
   */
  const save = async (run: () => Promise<unknown>, after: () => void): Promise<void> => {
    setSaving(true);
    setFailure(null);
    try {
      await run();
      after();
      onChanged();
    } catch (cause) {
      setFailure(
        cause instanceof ApiRequestError
          ? { message: cause.message, violations: cause.violations.map((v) => v.message) }
          : {
              message: 'That note could not be saved.',
              violations: ['The server could not be reached. Try again.'],
            },
      );
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (note: CustomerNote): void => {
    setEditingId(note.id);
    setEditDraft(note.body);
    setFailure(null);
  };

  return (
    <Card>
      <CardHeader
        title="Account notes"
        description="Standing instructions for this account. Visible to the office and to technicians."
      />

      {failure !== null && (
        <div className="mt-4">
          <RuleViolationNotice
            title="That note was not saved"
            message={failure.message}
            violations={failure.violations.map((message) => ({ code: 'note', message }))}
          />
        </div>
      )}

      {customer.notes.length === 0 ? (
        <p className="mt-4 text-sm text-steel-500">No notes recorded.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {[...customer.notes]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((note) => (
              <li
                key={note.id}
                className="rounded-[var(--radius-control)] border border-steel-200 p-3"
                data-testid="customer-note"
              >
                {editingId === note.id ? (
                  <div className="space-y-2">
                    <TextAreaField
                      label="Edit note"
                      value={editDraft}
                      rows={3}
                      maxLength={CUSTOMER_NOTE_LIMIT}
                      onChange={(event) => setEditDraft(event.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={saving || editDraft.trim().length === 0}
                        onClick={() =>
                          void save(
                            () => api.editNote(customer.id, note.id, editDraft),
                            () => {
                              setEditingId(null);
                              setEditDraft('');
                            },
                          )
                        }
                      >
                        {saving ? 'Saving…' : 'Save note'}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={saving}
                        onClick={() => {
                          setEditingId(null);
                          setEditDraft('');
                          setFailure(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="text-sm leading-relaxed whitespace-pre-line text-steel-700">
                      {note.body}
                    </p>
                    <p className="mt-2 text-xs text-steel-400">
                      {nameOf(note.authorId)} · {formatRelative(note.createdAt)}
                      {note.editedAt !== null && (
                        <>
                          {' · '}
                          <span data-testid="note-edited">
                            edited by {nameOf(note.editedBy)} {formatRelative(note.editedAt)}
                          </span>
                        </>
                      )}
                    </p>
                    {canManage && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="mt-2"
                        disabled={saving}
                        onClick={() => startEdit(note)}
                      >
                        Edit
                      </Button>
                    )}
                  </>
                )}
              </li>
            ))}
        </ul>
      )}

      {canManage && editingId === null && (
        <div className="mt-5 border-t border-steel-200 pt-4">
          <TextAreaField
            label="Add a note"
            value={draft}
            rows={3}
            maxLength={CUSTOMER_NOTE_LIMIT}
            hint="Standing instructions, not a job note. A contract belongs under Documents."
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            className="mt-2"
            disabled={saving || draft.trim().length === 0}
            onClick={() =>
              void save(
                () => api.addNote(customer.id, draft),
                () => setDraft(''),
              )
            }
          >
            {saving ? 'Saving…' : 'Add note'}
          </Button>
        </div>
      )}
    </Card>
  );
};
