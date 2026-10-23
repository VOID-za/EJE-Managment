'use client';

import { useRef, useState } from 'react';
import type { TechnicalDocument, TechnicalDocumentType } from '@/domain';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Icon,
  Modal,
  SelectField,
  TextAreaField,
  TextField,
  type Column,
} from '@/components/ui';
import { AdminNotice } from './AdminNotice';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { library } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { formatDate } from '@/lib/format';

/**
 * Technical library administration.
 *
 * Approving, revising and archiving. A revision never overwrites the document
 * it supersedes: the old record is archived and kept, so which revision a
 * technician worked from stays answerable after the fact.
 */
const DOCUMENT_TYPES: readonly { value: TechnicalDocumentType; label: string }[] = [
  { value: 'machine_manual', label: 'Machine manual' },
  { value: 'electrical_diagram', label: 'Electrical diagram' },
  { value: 'service_manual', label: 'Service manual' },
  { value: 'safety_procedure', label: 'Safety procedure' },
  { value: 'work_procedure', label: 'Work procedure' },
  { value: 'datasheet', label: 'Datasheet' },
];

type Editing =
  | { readonly mode: 'create' }
  | { readonly mode: 'edit'; readonly document: TechnicalDocument }
  | { readonly mode: 'revise'; readonly document: TechnicalDocument };

export const LibraryAdminPanel = ({
  documents,
  onChanged,
}: {
  readonly documents: readonly TechnicalDocument[];
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [archiving, setArchiving] = useState<TechnicalDocument | null>(null);

  const pending = documents.filter((document) => document.status === 'pending_approval');

  const columns: Column<TechnicalDocument>[] = [
    {
      key: 'name',
      header: 'Document',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-steel-900">{row.name}</p>
          <p className="truncate text-xs text-steel-500">
            {row.manufacturer} · {row.machineModel}
          </p>
        </div>
      ),
    },
    { key: 'version', header: 'Version', render: (row) => row.version },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge
          tone={
            row.status === 'current' ? 'green' : row.status === 'archived' ? 'neutral' : 'amber'
          }
          size="sm"
          dot
        >
          {row.status === 'current'
            ? 'Current'
            : row.status === 'archived'
              ? 'Archived'
              : 'Pending approval'}
        </Badge>
      ),
    },
    {
      key: 'uploaded',
      header: 'Uploaded',
      secondary: true,
      render: (row) => <span className="tabular">{formatDate(row.uploadedAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (row) => (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {row.status === 'pending_approval' && (
            <Button
              size="sm"
              loading={operation.running}
              onClick={async () => {
                const ok = await operation.run(() => library.approve(row.id));
                if (ok) onChanged();
              }}
            >
              Approve
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing({ mode: 'edit', document: row })}
          >
            Edit
          </Button>
          {row.status !== 'archived' && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing({ mode: 'revise', document: row })}
              >
                New revision
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setArchiving(row)}>
                Archive
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <AdminNotice
        title="Document control"
        body="Masters approve technician uploads, publish revisions and archive superseded documents. A revision archives the document it replaces rather than overwriting it, so which revision a technician worked from stays answerable."
      />

      {operation.error !== null && (
        <RuleViolationNotice
          title="That change was not made"
          message={operation.error}
          violations={operation.violations}
        />
      )}

      {pending.length > 0 && (
        <Card className="border-amber-eje-200 bg-amber-eje-50">
          <p className="text-sm font-semibold text-amber-eje-700">
            {pending.length} {pending.length === 1 ? 'document is' : 'documents are'} waiting for
            approval. Technicians do not see them until they are approved.
          </p>
        </Card>
      )}

      <div className="flex justify-end">
        <Button
          leadingIcon={<Icon name="plus" className="size-4" />}
          onClick={() => setEditing({ mode: 'create' })}
        >
          Add document
        </Button>
      </div>

      <DataTable columns={columns} rows={documents} rowKey={(row) => row.id} />

      {editing !== null && (
        <DocumentDialog
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}

      <ConfirmDialog
        open={archiving !== null}
        title="Archive this document?"
        message={
          archiving === null
            ? ''
            : `${archiving.name} v${archiving.version} will be withdrawn from the library so a superseded document cannot be followed by accident. It is retained, not deleted.`
        }
        confirmLabel="Archive document"
        busy={operation.running}
        onConfirm={async () => {
          if (archiving === null) return;
          const ok = await operation.run(() => library.archive(archiving.id));
          setArchiving(null);
          if (ok) onChanged();
        }}
        onCancel={() => setArchiving(null)}
      />
    </div>
  );
};

const DocumentDialog = ({
  editing,
  onClose,
  onSaved,
}: {
  readonly editing: Editing;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const existing = editing.mode === 'create' ? null : editing.document;
  const revising = editing.mode === 'revise';

  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [documentType, setDocumentType] = useState<TechnicalDocumentType>(
    existing?.documentType ?? 'machine_manual',
  );
  const [manufacturer, setManufacturer] = useState(existing?.manufacturer ?? '');
  const [machineModel, setMachineModel] = useState(existing?.machineModel ?? '');
  const [version, setVersion] = useState(revising ? '' : (existing?.version ?? '1.0'));
  const [fileName, setFileName] = useState(revising ? '' : (existing?.fileName ?? ''));
  const [pageCount, setPageCount] = useState(`${existing?.pageCount ?? 12}`);
  const [tags, setTags] = useState((existing?.tags ?? []).join(', '));
  /**
   * The PDF of a new revision, where one is being published. LIB-REV-1.
   *
   * `addVersion` records a revision and no bytes, which produced a `current`
   * revision nobody could download or search — and the download route's own
   * refusal told the office to upload the PDF with no way to do it. Choosing a
   * file here sends it through `uploadVersion` instead, which stores, measures
   * and indexes it exactly as the first upload does. Choosing none keeps the
   * metadata-only path, which EJE's existing records use.
   */
  const [revisionFile, setRevisionFile] = useState<File | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);

  const title =
    editing.mode === 'create'
      ? 'Add document'
      : revising
        ? `New revision of ${existing?.name ?? ''}`
        : `Edit ${existing?.name ?? ''}`;

  const submit = async (): Promise<void> => {
    const ok = await operation.run(() => {
      const pages = Number.parseInt(pageCount, 10) || 1;
      const tagList = tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0);

      if (editing.mode === 'create') {
        return library.create({
          name,
          description,
          documentType,
          manufacturer,
          machineModel,
          version,
          fileName,
          pageCount: pages,
          tags: tagList,
        });
      }
      if (revising) {
        // WITH THE FILE where one was chosen, which stores, measures and
        // indexes it; without, the metadata-only revision as before.
        return revisionFile === null
          ? library.addVersion(editing.document.id, {
              version,
              fileName,
              pageCount: pages,
              description,
            })
          : library.uploadVersion(editing.document.id, revisionFile, { version, description });
      }
      return library.update(editing.document.id, {
        name: name.trim(),
        description: description.trim(),
        documentType,
        manufacturer: manufacturer.trim(),
        machineModel: machineModel.trim(),
        version: editing.document.version,
        tags: tagList,
      });
    });
    if (ok) onSaved();
  };

  return (
    <Modal
      open
      title={title}
      description={
        revising
          ? 'The revision becomes current and the version it replaces is archived, not deleted.'
          : editing.mode === 'create'
            ? 'Demo note: no file is stored. The record is created exactly as the production uploader will create it.'
            : undefined
      }
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            Cancel
          </Button>
          <Button onClick={submit} loading={operation.running}>
            {editing.mode === 'create'
              ? 'Add document'
              : revising
                ? 'Publish revision'
                : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The document could not be saved"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {!revising && (
            <TextField
              label="Document name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              containerClassName="sm:col-span-2"
            />
          )}
          <TextAreaField
            label="Description"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            containerClassName="sm:col-span-2"
          />
          {!revising && (
            <>
              <SelectField
                label="Document type"
                value={documentType}
                onChange={(event) =>
                  setDocumentType(event.target.value as TechnicalDocumentType)
                }
                options={DOCUMENT_TYPES.map((type) => ({ value: type.value, label: type.label }))}
              />
              <TextField
                label="Manufacturer"
                value={manufacturer}
                onChange={(event) => setManufacturer(event.target.value)}
              />
              <TextField
                label="Machine model"
                value={machineModel}
                onChange={(event) => setMachineModel(event.target.value)}
              />
              <TextField
                label="Tags"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                hint="Comma separated, used by search."
              />
            </>
          )}
          {editing.mode !== 'edit' && (
            <>
              <TextField
                label="Version"
                required
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                hint={
                  revising && existing !== null
                    ? `Must differ from v${existing.version}, which cannot be overwritten.`
                    : undefined
                }
              />
              <TextField
                label="Page count"
                type="number"
                value={pageCount}
                onChange={(event) => setPageCount(event.target.value)}
              />
              <TextField
                label="File name"
                value={fileName}
                onChange={(event) => setFileName(event.target.value)}
                placeholder="leadwell-v40-manual-rev-b.pdf"
                containerClassName="sm:col-span-2"
                hint={
                  revising && revisionFile !== null
                    ? 'Taken from the chosen file.'
                    : revising
                      ? 'Only needed when no file is attached below.'
                      : undefined
                }
                disabled={revising && revisionFile !== null}
              />
              {revising && (
                <div className="sm:col-span-2">
                  <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                    The revision’s PDF
                  </p>
                  {/*
                    A HIDDEN INPUT BEHIND A REAL BUTTON — a bare file input
                    renders about 20px tall, which the responsive gate refuses
                    as a touch target. The same pattern the document panels use.
                  */}
                  <input
                    ref={filePicker}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    data-testid="library-revision-file"
                    onChange={(event) => {
                      const chosen = event.target.files?.[0] ?? null;
                      // Cleared so choosing the SAME file again still fires.
                      event.target.value = '';
                      setRevisionFile(chosen);
                      if (chosen !== null) setFileName(chosen.name);
                    }}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => filePicker.current?.click()}
                      data-testid="library-revision-choose"
                    >
                      <Icon name="document" className="size-4" />
                      {revisionFile === null ? 'Choose the PDF' : 'Choose a different PDF'}
                    </Button>
                    {revisionFile !== null && (
                      <span className="text-xs text-steel-600" data-testid="library-revision-chosen">
                        {revisionFile.name}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-steel-400">
                    {revisionFile === null
                      ? 'Without a PDF the revision is recorded as metadata only — it cannot be downloaded or searched.'
                      : 'The file is stored, measured and indexed; the page count comes from the file itself.'}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
};
