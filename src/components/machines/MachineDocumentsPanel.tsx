'use client';

import { useRef, useState } from 'react';
import {
  can,
  isFieldReadable,
  userFullName,
  type MachineDocument,
  type MachineDocumentAudience,
  type User,
} from '@/domain';
import { Badge, Button, Card, CardHeader, Icon, SimulatedBadge } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { machines as api } from '@/api/endpoints';
import { ApiRequestError } from '@/api/client';
import { useCurrentUser } from '@/providers/AppProvider';
import { formatDate, formatFileSize } from '@/lib/format';

/**
 * PAPER ABOUT ONE MACHINE. October mandate §4.
 *
 * The commissioning report, the compliance certificate, the laser-calibration
 * results for that serial number — not a photograph, which this machine
 * already had, and not a library document, which is filed by MODEL and
 * therefore answers for every machine of it.
 *
 * WHO SEES WHAT, and it mirrors the server rather than deciding anything: the
 * office sees every document and is offered the upload; a technician sees the
 * ones the office marked for the field, which is the list the server sent them
 * — this component never receives an office-only row to hide. A screen that
 * filters is a screen that already had the data.
 *
 * THE AUDIENCE IS CHOSEN AT UPLOAD, with the file, for the reason a
 * photograph's classification is (MEDIA-1): sending it afterwards would leave a
 * window in which a supplier's invoice was readable in the field.
 */
export const MachineDocumentsPanel = ({
  machineId,
  documents,
  users,
  onChanged,
}: {
  readonly machineId: string;
  /** Without the storage key, which the view strips before it leaves the server. */
  readonly documents: readonly Omit<MachineDocument, 'storageKey'>[];
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const office = can(currentUser.role, 'machines.manage');

  const input = useRef<HTMLInputElement | null>(null);
  const [caption, setCaption] = useState('');
  const [audience, setAudience] = useState<MachineDocumentAudience>('office_only');
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<{
    readonly message: string;
    readonly violations: readonly string[];
    readonly file: File;
  } | null>(null);

  const nameOf = (id: string): string => {
    const person = users.find((candidate) => candidate.id === id);
    return person === undefined ? 'Somebody no longer on the system' : userFullName(person);
  };

  const withdraw = async (documentId: string): Promise<void> => {
    await api.withdrawDocument(machineId, documentId);
    // Re-read rather than splice: what is on screen is what the server has.
    onChanged();
  };

  const send = async (file: File): Promise<void> => {
    setUploading(true);
    try {
      await api.attachDocument(machineId, file, { caption, audience });
      setFailure(null);
      setCaption('');
      if (input.current !== null) input.current.value = '';
      onChanged();
    } catch (cause) {
      setFailure({
        message:
          cause instanceof ApiRequestError
            ? cause.message
            : 'The document could not be sent to the EJE server.',
        violations:
          cause instanceof ApiRequestError
            ? cause.violations.map((violation) => violation.message)
            : [],
        // Kept, so a retry re-sends the same file.
        file,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Machine documents"
        description={
          office
            ? 'Reports, certificates and calibration results filed against this machine.'
            : 'The paperwork the office has made available for the field.'
        }
        action={
          <Badge tone="neutral">
            {documents.length === 0 ? 'None on file' : `${documents.length} on file`}
          </Badge>
        }
      />

      {documents.length === 0 ? (
        <p className="mt-4 text-sm text-steel-500" data-testid="machine-documents-empty">
          {office
            ? 'Nothing is filed against this machine yet.'
            : 'The office has not made any documents available for this machine.'}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-steel-100" data-testid="machine-documents">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex items-start justify-between gap-3 py-3"
              data-testid="machine-document-row"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 truncate text-sm font-medium text-steel-900">
                  <Icon name="document" className="size-4 shrink-0 text-steel-400" />
                  <span className="truncate">{document.fileName}</span>
                  <SimulatedBadge provenance={document.provenance} />
                </p>
                {document.caption.length > 0 && (
                  <p className="mt-0.5 truncate text-xs text-steel-600">{document.caption}</p>
                )}
                <p className="mt-0.5 text-[11px] text-steel-400">
                  {formatFileSize(document.sizeBytes)} · {nameOf(document.uploadedBy)} ·{' '}
                  {formatDate(document.uploadedAt)}
                </p>
                {/*
                  SHOWN TO THE OFFICE ONLY, and shown because the office is the
                  one who can get it wrong: a manual left office-only is a
                  technician telephoning from the machine.
                */}
                {office && (
                  <p className="mt-1" data-testid="machine-document-audience">
                    <Badge tone={isFieldReadable(document) ? 'green' : 'neutral'}>
                      {isFieldReadable(document) ? 'Readable in the field' : 'Office only'}
                    </Badge>
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <a
                  className="text-xs font-semibold text-eje-600 underline-offset-2 hover:underline"
                  href={api.documentUrl(machineId, document.id)}
                  download={document.fileName}
                  data-testid="machine-document-download"
                >
                  Download
                </a>
                {/*
                  WITHDRAWN, NOT DELETED — the register's own rule. The row and
                  the bytes stay, so a compliance certificate that was on file
                  when a machine was signed off still resolves afterwards.
                */}
                {office && (
                  <button
                    type="button"
                    className="text-xs font-semibold text-steel-500 underline-offset-2 hover:underline"
                    onClick={() => void withdraw(document.id)}
                    data-testid="machine-document-withdraw"
                  >
                    Withdraw
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {office && (
        <div className="mt-4 border-t border-steel-100 pt-3">
          <label
            className="text-xs font-semibold tracking-wide text-steel-500 uppercase"
            htmlFor="machine-document-caption"
          >
            What this document is
          </label>
          <input
            id="machine-document-caption"
            value={caption}
            maxLength={300}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Laser calibration, March 2026"
            className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
            data-testid="machine-document-caption"
          />

          <fieldset className="mt-3">
            <legend className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
              Who may read it
            </legend>
            <div className="mt-1 flex flex-wrap gap-2">
              {(
                [
                  ['field', 'The field — technicians too'],
                  ['office_only', 'The office only'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  key={value}
                  type="button"
                  size="sm"
                  variant={audience === value ? 'primary' : 'secondary'}
                  onClick={() => setAudience(value)}
                  data-testid={`machine-document-audience-${value}`}
                >
                  {label}
                </Button>
              ))}
            </div>
          </fieldset>

          {/*
            A HIDDEN INPUT BEHIND A REAL BUTTON. A bare `<input type="file">`
            renders about 20px tall, which the responsive gate refuses as a
            touch target — correctly, because the office uses this on a tablet.
          */}
          <input
            ref={input}
            type="file"
            className="hidden"
            data-testid="machine-document-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Cleared so choosing the SAME file again still fires.
              event.target.value = '';
              if (file !== undefined) void send(file);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            className="mt-3"
            loading={uploading}
            onClick={() => input.current?.click()}
            data-testid="machine-document-choose"
          >
            <Icon name="document" className="size-4" />
            Choose a document
          </Button>

          <p className="mt-2 text-[11px] leading-relaxed text-steel-400">
            The server checks the file itself rather than its name, and records the size and
            checksum of what it stored. A document nobody classifies stays office-only.
          </p>

          {uploading && (
            <p className="mt-2 text-xs text-steel-500" data-testid="machine-document-uploading">
              Sending…
            </p>
          )}

          {failure !== null && (
            <div className="mt-3">
              <RuleViolationNotice
                title="That document was not attached"
                message={failure.message}
                violations={failure.violations.map((message) => ({ code: 'upload', message }))}
              />
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                loading={uploading}
                onClick={() => void send(failure.file)}
                data-testid="machine-document-retry"
              >
                Try again with the same file
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};
