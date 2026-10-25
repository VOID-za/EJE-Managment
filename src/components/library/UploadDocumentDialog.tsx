'use client';

import { useState } from 'react';
import { asDocumentId, can, type TechnicalDocumentType } from '@/domain';
import { Button, Modal, SelectField, TextAreaField, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { library, type LibraryUploadResult } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';
import { describeSearchability } from '@/application/library-ocr';
import { formatNumber } from '@/lib/format';

const DOCUMENT_TYPES: readonly { value: TechnicalDocumentType; label: string }[] = [
  { value: 'machine_manual', label: 'Machine manual' },
  { value: 'electrical_diagram', label: 'Electrical diagram' },
  { value: 'service_manual', label: 'Service manual' },
  { value: 'safety_procedure', label: 'Safety procedure' },
  { value: 'work_procedure', label: 'Work procedure' },
  { value: 'datasheet', label: 'Datasheet' },
];

/**
 * Technician upload — WITH THE FILE. MASTER SCOPE LIB-5.
 *
 * A technician who has a manual the office does not can submit it, but it does
 * not become official reference material until a Master approves it — that is
 * `addDocument`'s decision, made from the actor's role, not this dialog's.
 *
 * IT USED TO UPLOAD NOTHING. The dialog asked somebody to TYPE a file name,
 * sent a page count of twelve whatever the document was, and the record it
 * created pointed at a storage key with no bytes behind it. So the library held
 * descriptions of manuals rather than manuals, nothing could be downloaded on
 * site, and there was nothing to search inside. The file is now chosen,
 * uploaded, stored and read: the file name and the page count come from the
 * file, and the answer says whether the text in it could be indexed.
 */
export const UploadDocumentDialog = ({
  open,
  onClose,
  onUploaded,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUploaded: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const goesLiveImmediately = can(currentUser.role, 'library.manage');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [documentType, setDocumentType] = useState<TechnicalDocumentType>('machine_manual');
  const [manufacturer, setManufacturer] = useState('');
  const [machineModel, setMachineModel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  /*
   * WHAT HAPPENED TO THE TEXT, shown before the dialog closes.
   *
   * A scanned manual uploads perfectly well and cannot be searched, and the
   * person who just uploaded it is the only one in a position to do something
   * about that — find a text-based copy, or tell the office. So the outcome is
   * reported here rather than left in the audit trail.
   */
  const [outcome, setOutcome] = useState<LibraryUploadResult | null>(null);

  const submit = async (): Promise<void> => {
    if (file === null) return;
    const chosen = file;
    const result = await operation.runFor(() =>
      library.upload(chosen, {
        name,
        description,
        documentType,
        manufacturer,
        machineModel,
        version: '1.0',
        tags: '',
      }),
    );
    if (result === null) return;
    setOutcome(result);
    // The library behind the dialog is refreshed, and the dialog STAYS OPEN:
    // the outcome — whether the document can be searched — is the one thing
    // only the person who just uploaded it can act on.
    onUploaded();
    setName('');
    setDescription('');
    setManufacturer('');
    setMachineModel('');
    setFile(null);
  };

  return (
    <Modal
      open={open}
      title="Upload a document"
      description={
        goesLiveImmediately
          ? 'Published to the library immediately.'
          : 'Submitted to the office. It becomes official reference material once a Master approves it.'
      }
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={operation.running}>
            {outcome === null ? 'Cancel' : 'Close'}
          </Button>
          <Button onClick={submit} loading={operation.running} disabled={file === null}>
            {goesLiveImmediately ? 'Publish document' : 'Submit for approval'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The document could not be submitted"
            message={operation.error}
            violations={operation.violations}
          />
        )}

        {outcome !== null && (
          <div
            className="rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-4 py-3 text-sm text-steel-700"
            data-testid="library-upload-outcome"
          >
            <p className="font-semibold text-steel-900">
              {outcome.document.name} — {outcome.document.pageCount}{' '}
              {outcome.document.pageCount === 1 ? 'page' : 'pages'} stored
            </p>
            {/*
              THE SAME WORDS THE LIBRARY LIST USES. LIB-TEXT-1 (#70).

              This used to test `state === 'indexed'` and call everything else
              "Not searchable" — so a manual indexed on 1 498 of its 1 500
              pages, with two scanned diagrams, was reported to the person who
              had just uploaded it as unsearchable. `describeSearchability` is
              the one place that turns an index into a sentence, N of M
              included, and the list already reads it.
            */}
            {(() => {
              const said = describeSearchability(
                {
                  documentId: asDocumentId(outcome.document.id),
                  state: outcome.index.state,
                  source: outcome.index.source,
                  extractedAt: '',
                  characters: outcome.index.characters,
                  pages: outcome.index.pages,
                  pagesIndexed: outcome.index.pagesIndexed,
                  truncated: outcome.index.truncated,
                  unreadableStreams: 0,
                  failureReason: outcome.index.failureReason,
                },
                null,
              );
              return said.searchable ? (
                <p data-testid="library-upload-searchable">
                  <span className="font-semibold">{said.label}.</span>{' '}
                  {formatNumber(outcome.index.characters, 0)} characters were read out of it.{' '}
                  {outcome.index.state === 'indexed' ? '' : outcome.index.failureReason}
                </p>
              ) : (
                <p data-testid="library-upload-not-searchable">
                  <span className="font-semibold">{said.label}.</span> {said.detail}
                </p>
              );
            })()}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Document name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            containerClassName="sm:col-span-2"
          />
          <TextAreaField
            label="What is it, and when would a technician need it?"
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            containerClassName="sm:col-span-2"
          />
          <SelectField
            label="Document type"
            value={documentType}
            onChange={(event) => setDocumentType(event.target.value as TechnicalDocumentType)}
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
          {/*
            THE FILE ITSELF. The name and the page count are read from it, not
            typed: a library whose records describe files nobody uploaded cannot
            be downloaded on site or searched at all.
          */}
          <div className="sm:col-span-2">
            <label
              htmlFor="library-upload-file"
              className="mb-1.5 block text-sm font-semibold text-steel-700"
            >
              The document <span className="text-signal-600">*</span>
            </label>
            <input
              id="library-upload-file"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                setOutcome(null);
                setFile(event.target.files?.[0] ?? null);
              }}
              className="block w-full min-h-11 rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 py-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-steel-100 file:px-3 file:py-1.5 file:text-sm file:font-semibold"
            />
            <p className="mt-1.5 text-xs text-steel-500">
              A PDF. A text-based PDF can be searched by its contents; a scanned one is stored and
              the library says it is not searchable.
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
};
