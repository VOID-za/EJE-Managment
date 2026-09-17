'use client';

import { useState } from 'react';
import {
  JOB_TYPE_CODES,
  canEditInPlace,
  compareVersions,
  editInPlaceRefusal,
  jobTypeLabel,
  type ChecklistItem,
  type ChecklistResponseType,
  type ChecklistSection,
  type ChecklistTemplate,
  type JobTypeCode,
  type TemplateUsage,
} from '@/domain';
import {
  archiveTemplate,
  createTemplate,
  publishTemplate,
  saveTemplateDraft,
  startNewVersion,
} from '@/application/checklist-admin';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  Icon,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { AdminNotice } from './AdminNotice';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { useOperation } from '@/hooks/useOperation';
import { formatDate } from '@/lib/format';

/**
 * Checklist administration.
 *
 * The governing rule is visible on screen, not just enforced underneath: a
 * version a job has completed against is locked, and the Master is offered
 * "New version" instead of an edit that would rewrite a signed job card.
 */
const RESPONSE_TYPES: readonly { value: ChecklistResponseType; label: string }[] = [
  { value: 'pass_fail_na', label: 'Pass / Fail / N/A' },
  { value: 'measurement', label: 'Measurement' },
  { value: 'yes_no', label: 'Yes / No' },
  { value: 'text', label: 'Free text' },
];

const statusTone = (status: ChecklistTemplate['status']): 'green' | 'amber' | 'neutral' =>
  status === 'current' ? 'green' : status === 'draft' ? 'amber' : 'neutral';

const statusLabel = (status: ChecklistTemplate['status']): string =>
  status === 'current' ? 'Current' : status === 'draft' ? 'Draft' : 'Archived';

export const ChecklistAdminPanel = ({
  templates,
  usage,
  onChanged,
}: {
  readonly templates: readonly ChecklistTemplate[];
  readonly usage: readonly TemplateUsage[];
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ChecklistTemplate | null>(null);
  const [archiving, setArchiving] = useState<ChecklistTemplate | null>(null);

  const ordered = [...templates].sort(
    (a, b) => a.name.localeCompare(b.name) || compareVersions(b.version, a.version),
  );

  return (
    <div className="space-y-5">
      <AdminNotice
        tone="amber"
        title="A used checklist version is never rewritten"
        body="A completed checklist records the version it was answered against, and the job card is rendered from that stored version. Once a job has completed against a version its wording is locked: publish a new version instead. Retiring a checklist archives it rather than deleting it, so signed job cards keep rendering."
      />

      {operation.error !== null && (
        <RuleViolationNotice
          title="That change was not made"
          message={operation.error}
          violations={operation.violations}
        />
      )}

      <div className="flex justify-end">
        <Button leadingIcon={<Icon name="plus" className="size-4" />} onClick={() => setCreating(true)}>
          New checklist
        </Button>
      </div>

      {ordered.map((template) => {
        const locked = !canEditInPlace(template, usage);
        return (
          <Card key={`${template.id}-${template.version}`}>
            <CardHeader
              title={template.name}
              description={template.description}
              action={
                <div className="flex items-center gap-2">
                  <Badge tone="outline" size="sm">
                    v{template.version}
                  </Badge>
                  <Badge tone={statusTone(template.status)} size="sm" dot>
                    {statusLabel(template.status)}
                  </Badge>
                </div>
              }
            />

            <ul className="mt-4 divide-y divide-steel-100">
              {template.sections.length === 0 ? (
                <li className="py-2.5 text-sm text-steel-500 italic">
                  No sections yet. Add one before this checklist can be issued.
                </li>
              ) : (
                template.sections.map((section, index) => (
                  <li key={section.id} className="flex items-center gap-3 py-2.5">
                    <span className="tabular flex size-6 items-center justify-center rounded-full bg-steel-100 text-xs font-bold text-steel-600">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-steel-800">
                      {section.title}
                    </span>
                    <span className="tabular text-xs text-steel-400">
                      {section.items.length} items
                    </span>
                  </li>
                ))
              )}
            </ul>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-steel-100 pt-3 text-xs text-steel-500">
              <span>
                Mandatory for:{' '}
                <span className="font-semibold text-steel-700">
                  {JOB_TYPE_CODES.includes(template.jobTypeCode as JobTypeCode)
                    ? jobTypeLabel(template.jobTypeCode as JobTypeCode)
                    : template.jobTypeCode}
                </span>
              </span>
              <span>Last updated {formatDate(template.updatedAt)}</span>
            </div>
            <p className="mt-2 text-xs text-amber-eje-700">Source: {template.sourceDocument}</p>

            {locked && (
              <p className="mt-3 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2 text-xs text-steel-600">
                {editInPlaceRefusal(template, usage)}
              </p>
            )}

            <div className="mt-4 flex flex-wrap gap-2 border-t border-steel-100 pt-3">
              <Button
                size="sm"
                variant="secondary"
                disabled={locked}
                onClick={() => setEditing(template)}
              >
                Edit items
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={operation.running}
                onClick={async () => {
                  const ok = await operation.run((context) => startNewVersion(context, template));
                  if (ok) onChanged();
                }}
              >
                New version
              </Button>
              {template.status !== 'current' && (
                <Button
                  size="sm"
                  loading={operation.running}
                  disabled={template.sections.length === 0}
                  onClick={async () => {
                    const ok = await operation.run((context) => publishTemplate(context, template));
                    if (ok) onChanged();
                  }}
                >
                  Issue to new jobs
                </Button>
              )}
              {template.status !== 'archived' && (
                <Button size="sm" variant="ghost" onClick={() => setArchiving(template)}>
                  Archive
                </Button>
              )}
            </div>
          </Card>
        );
      })}

      {creating && (
        <NewChecklistDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            onChanged();
          }}
        />
      )}

      {editing !== null && (
        <ChecklistEditor
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        open={archiving !== null}
        title="Archive this checklist version?"
        message={
          archiving === null
            ? ''
            : `${archiving.name} v${archiving.version} will no longer be issued to new jobs. It is NOT deleted: jobs already completed against it keep rendering this exact version.`
        }
        confirmLabel="Archive version"
        busy={operation.running}
        onConfirm={async () => {
          if (archiving === null) return;
          const ok = await operation.run((context) => archiveTemplate(context, archiving));
          setArchiving(null);
          if (ok) onChanged();
        }}
        onCancel={() => setArchiving(null)}
      />
    </div>
  );
};

const NewChecklistDialog = ({
  onClose,
  onCreated,
}: {
  readonly onClose: () => void;
  readonly onCreated: () => void;
}) => {
  const operation = useOperation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [jobTypeCode, setJobTypeCode] = useState<string>('service');
  const [sourceDocument, setSourceDocument] = useState('');

  return (
    <Modal
      open
      title="New checklist"
      description="Created as a draft. It is not issued to jobs until you publish it."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Cancel
          </Button>
          <Button
            loading={operation.running}
            onClick={async () => {
              const ok = await operation.run((context) =>
                createTemplate(context, { name, description, jobTypeCode, sourceDocument }),
              );
              if (ok) onCreated();
            }}
          >
            Create draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The checklist could not be created"
            message={operation.error}
            violations={operation.violations}
          />
        )}
        <TextField
          label="Checklist name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextAreaField
          label="Description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <SelectField
          label="Mandatory for job type"
          value={jobTypeCode}
          onChange={(event) => setJobTypeCode(event.target.value)}
          options={JOB_TYPE_CODES.map((code) => ({ value: code, label: jobTypeLabel(code) }))}
        />
        <TextField
          label="Source document"
          value={sourceDocument}
          onChange={(event) => setSourceDocument(event.target.value)}
          hint="Where the approved wording comes from, recorded so its provenance is answerable."
        />
      </div>
    </Modal>
  );
};

let sequence = 0;
const localId = (prefix: string): string => {
  sequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
};

/**
 * Section and item editor.
 *
 * Works on a local draft and saves explicitly, so a half-made change is never
 * written; reordering is by move-up/move-down rather than drag, which works on
 * a tablet without a pointer.
 */
const ChecklistEditor = ({
  template,
  onClose,
  onSaved,
}: {
  readonly template: ChecklistTemplate;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const [sections, setSections] = useState<readonly ChecklistSection[]>(template.sections);

  const updateSection = (id: string, patch: Partial<ChecklistSection>): void =>
    setSections((current) =>
      current.map((section) => (section.id === id ? { ...section, ...patch } : section)),
    );

  const updateItem = (sectionId: string, itemId: string, patch: Partial<ChecklistItem>): void =>
    setSections((current) =>
      current.map((section) =>
        section.id !== sectionId
          ? section
          : {
              ...section,
              items: section.items.map((item) =>
                item.id === itemId ? { ...item, ...patch } : item,
              ),
            },
      ),
    );

  const moveItem = (sectionId: string, index: number, delta: number): void =>
    setSections((current) =>
      current.map((section) => {
        if (section.id !== sectionId) return section;
        const target = index + delta;
        if (target < 0 || target >= section.items.length) return section;
        const items = [...section.items];
        const [moved] = items.splice(index, 1);
        if (moved === undefined) return section;
        items.splice(target, 0, moved);
        return { ...section, items };
      }),
    );

  const addSection = (): void =>
    setSections((current) => [
      ...current,
      { id: localId('sec'), title: 'New section', description: '', items: [] },
    ]);

  const addItem = (sectionId: string): void =>
    setSections((current) =>
      current.map((section) =>
        section.id !== sectionId
          ? section
          : {
              ...section,
              items: [
                ...section.items,
                {
                  id: localId('item'),
                  text: '',
                  helpText: '',
                  responseType: 'pass_fail_na',
                  required: true,
                  photoRequired: false,
                  unit: null,
                  expectedRange: null,
                },
              ],
            },
      ),
    );

  const removeItem = (sectionId: string, itemId: string): void =>
    setSections((current) =>
      current.map((section) =>
        section.id !== sectionId
          ? section
          : { ...section, items: section.items.filter((item) => item.id !== itemId) },
      ),
    );

  const removeSection = (sectionId: string): void =>
    setSections((current) => current.filter((section) => section.id !== sectionId));

  return (
    <Modal
      open
      title={`${template.name} — v${template.version}`}
      description="Sections and items. Changes are saved onto this version only when you press Save."
      onClose={onClose}
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Cancel
          </Button>
          <Button
            loading={operation.running}
            onClick={async () => {
              const ok = await operation.run((context) =>
                saveTemplateDraft(context, { ...template, sections }),
              );
              if (ok) onSaved();
            }}
          >
            Save checklist
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The checklist could not be saved"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        {sections.map((section) => (
          <Card key={section.id} padded={false}>
            <div className="flex flex-wrap items-end gap-3 border-b border-steel-100 px-4 py-3">
              <TextField
                label="Section title"
                value={section.title}
                onChange={(event) => updateSection(section.id, { title: event.target.value })}
                containerClassName="min-w-[14rem] flex-1"
              />
              <Button size="sm" variant="ghost" onClick={() => removeSection(section.id)}>
                Remove section
              </Button>
            </div>

            <ul className="divide-y divide-steel-100">
              {section.items.map((item, index) => (
                <li key={item.id} className="space-y-3 px-4 py-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <TextField
                      label={`Item ${index + 1}`}
                      value={item.text}
                      onChange={(event) =>
                        updateItem(section.id, item.id, { text: event.target.value })
                      }
                      containerClassName="min-w-[16rem] flex-1"
                    />
                    <SelectField
                      label="Response"
                      value={item.responseType}
                      onChange={(event) =>
                        updateItem(section.id, item.id, {
                          responseType: event.target.value as ChecklistResponseType,
                        })
                      }
                      options={RESPONSE_TYPES.map((type) => ({
                        value: type.value,
                        label: type.label,
                      }))}
                      containerClassName="w-48"
                    />
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move item ${index + 1} up`}
                        onClick={() => moveItem(section.id, index, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move item ${index + 1} down`}
                        onClick={() => moveItem(section.id, index, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeItem(section.id, item.id)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>

                  {item.responseType === 'measurement' && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <TextField
                        label="Unit"
                        value={item.unit ?? ''}
                        onChange={(event) =>
                          updateItem(section.id, item.id, {
                            unit: event.target.value.length === 0 ? null : event.target.value,
                          })
                        }
                        placeholder="mm, bar, °C"
                      />
                      <TextField
                        label="Minimum"
                        type="number"
                        value={item.expectedRange === null ? '' : `${item.expectedRange.min}`}
                        onChange={(event) =>
                          updateItem(section.id, item.id, {
                            expectedRange: {
                              min: Number(event.target.value),
                              max: item.expectedRange?.max ?? 0,
                            },
                          })
                        }
                      />
                      <TextField
                        label="Maximum"
                        type="number"
                        value={item.expectedRange === null ? '' : `${item.expectedRange.max}`}
                        onChange={(event) =>
                          updateItem(section.id, item.id, {
                            expectedRange: {
                              min: item.expectedRange?.min ?? 0,
                              max: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </div>
                  )}

                  <div className="flex flex-wrap gap-5">
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-steel-700">
                      <input
                        type="checkbox"
                        checked={item.required}
                        onChange={(event) =>
                          updateItem(section.id, item.id, { required: event.target.checked })
                        }
                        className="size-4 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
                      />
                      Required
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-steel-700">
                      <input
                        type="checkbox"
                        checked={item.photoRequired}
                        onChange={(event) =>
                          updateItem(section.id, item.id, { photoRequired: event.target.checked })
                        }
                        className="size-4 rounded border-steel-300 text-eje-600 focus:ring-eje-500"
                      />
                      Photo required
                    </label>
                  </div>
                </li>
              ))}
            </ul>

            <div className="border-t border-steel-100 px-4 py-3">
              <Button size="sm" variant="secondary" onClick={() => addItem(section.id)}>
                Add item
              </Button>
            </div>
          </Card>
        ))}

        <Button variant="secondary" onClick={addSection}>
          Add section
        </Button>
      </div>
    </Modal>
  );
};
