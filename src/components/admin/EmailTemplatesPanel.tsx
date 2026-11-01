'use client';

import { useRef, useState } from 'react';
import { getJobTypeDefinition, type EmailTemplateWithVersion, type JobTypeCode } from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  LoadingPanel,
  Modal,
  QueryFailure,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { AdminNotice } from './AdminNotice';
import { emailTemplates as api } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useQuery } from '@/hooks/useQuery';
import { formatDateTime } from '@/lib/format';

/**
 * ADMINISTRATION → EMAIL TEMPLATES. INT-EMAIL-1/2.
 *
 * The office's shared templates for the email that goes to the customer with
 * the signed job card. One default per job type is the one that is sent; a
 * job type with none is NOT emailed (its job cards are flagged for the office)
 * and the coverage list says so in red. Every save is a new version, and an
 * email already sent keeps the words of the version it was written from.
 */

const jobTypeLabel = (jobType: string): string => getJobTypeDefinition(jobType as JobTypeCode).label;

interface EditorState {
  readonly mode: 'create' | 'edit';
  readonly template: EmailTemplateWithVersion | null;
}

export const EmailTemplatesPanel = () => {
  const query = useQuery('admin:email-templates', () => api.list());
  const operation = useOperation();
  const [editor, setEditor] = useState<EditorState | null>(null);

  if (query.error !== null) return <QueryFailure code={query.errorCode} message={query.error} onRetry={query.refetch} />;
  const data = query.data;
  if (query.loading || data === null || data === undefined) return <LoadingPanel rows={4} label="Loading email templates" />;

  const byId = new Map(data.templates.map((template) => [template.id, template]));
  const setState = async (id: string, op: 'activate' | 'make_default' | 'deactivate') => {
    if (await operation.run(() => api.setState(id, op))) query.refetch();
  };
  const restore = async (event: string, jobType: string) => {
    if (await operation.run(() => api.restore(event, jobType))) query.refetch();
  };

  return (
    <div className="space-y-5" data-testid="email-templates-panel">
      <AdminNotice
        title="Customer email templates"
        body="The signed job card is emailed to the customer automatically, from the sending mailbox, with the default template for its job type and the signed PDF attached. Both the Master and the Coordinator manage these templates. Every save is a new version; emails already sent keep exactly what they said."
      />

      {operation.error !== null && (
        <RuleViolationNotice title="That change was not made" message={operation.error} violations={operation.violations} />
      )}

      <Card>
        <CardHeader
          title="Which template each job type is sent with"
          description="A job type with no default is not emailed: its signed job cards are flagged for the office instead."
        />
        <ul className="mt-3 divide-y divide-steel-100">
          {data.coverage.map((row) => {
            const template = row.defaultTemplateId === null ? null : byId.get(row.defaultTemplateId) ?? null;
            return (
              <li
                key={`${row.event}:${row.jobType}`}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid={`email-coverage-${row.jobType}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">{jobTypeLabel(row.jobType)}</p>
                  <p className="text-sm text-steel-600">
                    {template === null ? 'No default template — NOT emailed' : `${template.name} · version ${template.currentVersion}`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {template === null ? <Badge tone="red">Not emailed</Badge> : <Badge tone="green">Emailed automatically</Badge>}
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid={`email-restore-${row.jobType}`}
                    loading={operation.running}
                    onClick={() => void restore(row.event, row.jobType)}
                  >
                    Restore system default
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <CardHeader
          title="Templates"
          description="Inactive templates are never sent. Make one the default to use it."
          action={
            <Button size="sm" data-testid="email-template-new" onClick={() => setEditor({ mode: 'create', template: null })}>
              New template
            </Button>
          }
        />
        <ul className="mt-3 divide-y divide-steel-100">
          {data.templates.map((template) => (
            <li key={template.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid="email-template-row">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-ink">{template.name}</p>
                <p className="text-xs text-steel-600">
                  {jobTypeLabel(template.jobType)} · version {template.currentVersion} · saved {formatDateTime(template.updatedAt)}
                </p>
                <p className="mt-1 break-words text-xs text-steel-500">{template.current.subject}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {template.isDefault && <Badge tone="green">Default</Badge>}
                <Badge tone={template.active ? 'blue' : 'neutral'}>{template.active ? 'Active' : 'Inactive'}</Badge>
                <Button size="sm" variant="secondary" data-testid="email-template-edit" onClick={() => setEditor({ mode: 'edit', template })}>
                  Edit
                </Button>
                {!template.isDefault && (
                  <Button size="sm" variant="secondary" data-testid="email-template-make-default" onClick={() => void setState(template.id, 'make_default')}>
                    Make default
                  </Button>
                )}
                {template.active ? (
                  <Button size="sm" variant="ghost" data-testid="email-template-deactivate" onClick={() => void setState(template.id, 'deactivate')}>
                    Deactivate
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" data-testid="email-template-activate" onClick={() => void setState(template.id, 'activate')}>
                    Activate
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {editor !== null && (
        <TemplateEditor
          state={editor}
          placeholders={data.placeholders}
          jobTypes={data.events[0]?.jobTypes ?? []}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            query.refetch();
          }}
        />
      )}
    </div>
  );
};

const TemplateEditor = ({
  state,
  placeholders,
  jobTypes,
  onClose,
  onSaved,
}: {
  readonly state: EditorState;
  readonly placeholders: readonly { key: string; label: string; source: string }[];
  readonly jobTypes: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const template = state.template;
  const operation = useOperation();
  const preview = useOperation();
  const [jobType, setJobType] = useState<string>(template?.jobType ?? jobTypes[0] ?? 'breakdown');
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [subject, setSubject] = useState(template?.current.subject ?? '{{job_number}} — {{document_title}}');
  const [body, setBody] = useState(template?.current.body ?? 'Good day {{customer_name}},\n\n\n\nKind regards\nEJE Industrial Electronics');
  const [changeNote, setChangeNote] = useState('');
  const [rendered, setRendered] = useState<{ subject: string; body: string; problems: readonly { message: string }[] } | null>(null);
  // Where the cursor was last, in which field: placeholders go there.
  const cursor = useRef<{ field: 'subject' | 'body'; start: number; end: number }>({ field: 'body', start: -1, end: -1 });
  const remember = (field: 'subject' | 'body', element: { selectionStart: number | null; selectionEnd: number | null }) => {
    cursor.current = { field, start: element.selectionStart ?? -1, end: element.selectionEnd ?? -1 };
  };
  const versions = useQuery(`admin:email-template:${template?.id ?? 'new'}`, () =>
    template === null ? Promise.resolve(null) : api.get(template.id),
  );

  const insert = (key: string) => {
    const token = `{{${key}}}`;
    const { field, start, end } = cursor.current;
    const text = field === 'subject' ? subject : body;
    const at = start < 0 || start > text.length ? text.length : start;
    const until = end < at || end > text.length ? at : end;
    const next = text.slice(0, at) + token + text.slice(until);
    if (field === 'subject') setSubject(next);
    else setBody(next);
    cursor.current = { field, start: at + token.length, end: at + token.length };
    setRendered(null);
  };

  const showPreview = async () => {
    const result = await preview.runFor(() => api.preview({ name, subject, body }));
    if (result !== null) setRendered(result);
  };

  const save = async () => {
    const ok =
      state.mode === 'create'
        ? await operation.run(() => api.create({ event: 'signed_job_card', jobType, name, description, subject, body }))
        : await operation.run(() =>
            api.save(template!.id, { name, description, subject, body, changeNote, expectedVersion: template!.currentVersion }),
          );
    if (ok) onSaved();
  };

  return (
    <Modal
      open
      size="xl"
      title={state.mode === 'create' ? 'New email template' : `Edit “${template?.name ?? ''}”`}
      description={
        state.mode === 'create'
          ? 'Saved inactive. Preview it, then make it the default for its job type to use it.'
          : `Saving makes version ${(template?.currentVersion ?? 0) + 1}.${template?.isDefault ? ' This is the default: emails written from now on use the new version.' : ''}`
      }
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="secondary" data-testid="email-template-preview" loading={preview.running} onClick={() => void showPreview()}>
            Preview
          </Button>
          <Button data-testid="email-template-save" loading={operation.running} onClick={() => void save()}>
            Save
          </Button>
        </div>
      }
    >
      <div className="space-y-4" data-testid="email-template-editor">
        {operation.error !== null && (
          <RuleViolationNotice title="The template was not saved" message={operation.error} violations={operation.violations} />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Name" value={name} maxLength={120} data-testid="email-template-name" onChange={(event) => setName(event.target.value)} />
          {state.mode === 'create' ? (
            <SelectField
              label="Job type"
              value={jobType}
              data-testid="email-template-job-type"
              options={jobTypes.map((value) => ({ value, label: jobTypeLabel(value) }))}
              onChange={(event) => setJobType(event.target.value)}
            />
          ) : (
            <TextField label="Job type" value={jobTypeLabel(template?.jobType ?? '')} readOnly />
          )}
        </div>
        <TextField label="Description (for the office)" value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} />
        <TextField
          label="Subject line"
          value={subject}
          maxLength={300}
          data-testid="email-template-subject"
          onSelect={(event) => remember('subject', event.currentTarget)}
          onFocus={(event) => remember('subject', event.currentTarget)}
          onChange={(event) => {
            setSubject(event.target.value);
            setRendered(null);
          }}
        />
        <TextAreaField
          label="Message"
          rows={12}
          value={body}
          data-testid="email-template-body"
          hint="Plain text. A line whose placeholders are all empty for a job is left out."
          onSelect={(event) => remember('body', event.currentTarget)}
          onFocus={(event) => remember('body', event.currentTarget)}
          onChange={(event) => {
            setBody(event.target.value);
            setRendered(null);
          }}
        />
        <div>
          <p className="text-sm font-semibold text-ink">Insert a placeholder</p>
          <p className="text-xs text-steel-600">Goes where the cursor is, in the subject or the message.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {placeholders.map((placeholder) => (
              <button
                key={placeholder.key}
                type="button"
                title={placeholder.source}
                data-testid={`email-placeholder-${placeholder.key}`}
                className="min-h-11 rounded-md border border-steel-200 bg-surface px-3 text-xs font-medium text-steel-700 hover:bg-steel-50"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert(placeholder.key)}
              >
                {`{{${placeholder.key}}}`}
              </button>
            ))}
          </div>
        </div>
        {state.mode === 'edit' && (
          <TextField label="What changed (optional)" value={changeNote} maxLength={300} onChange={(event) => setChangeNote(event.target.value)} />
        )}
        {preview.error !== null && <RuleViolationNotice title="Preview failed" message={preview.error} violations={preview.violations} />}
        {rendered !== null && (
          <div className="rounded-md border border-steel-200 bg-steel-50 p-3" data-testid="email-template-preview-panel">
            {rendered.problems.length > 0 ? (
              <ul className="list-disc pl-5 text-sm text-signal-700" data-testid="email-template-problems">
                {rendered.problems.map((problem) => (
                  <li key={problem.message}>{problem.message}</li>
                ))}
              </ul>
            ) : (
              <>
                <p className="text-xs font-semibold uppercase text-steel-500">Preview with sample values — nothing is sent</p>
                <p className="mt-1 break-words text-sm font-semibold text-ink" data-testid="email-template-preview-subject">
                  {rendered.subject}
                </p>
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm text-steel-700" data-testid="email-template-preview-body">
                  {rendered.body}
                </pre>
              </>
            )}
          </div>
        )}
        {versions.data !== null && versions.data !== undefined && versions.data.versions.length > 0 && (
          <details className="rounded-md border border-steel-200 p-3" data-testid="email-template-versions">
            <summary className="cursor-pointer text-sm font-semibold text-ink">Versions ({versions.data.versions.length})</summary>
            <ul className="mt-2 space-y-2">
              {versions.data.versions.map((version) => (
                <li key={version.id} className="text-xs text-steel-600">
                  <span className="font-semibold text-ink">Version {version.version}</span> · {formatDateTime(version.createdAt)}
                  {version.changeNote.length > 0 ? ` · ${version.changeNote}` : ''}
                  <p className="break-words text-steel-500">{version.subject}</p>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </Modal>
  );
};
