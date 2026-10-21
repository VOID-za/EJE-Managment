'use client';

import { useRef, useState } from 'react';
import { userFullName, type CustomerDocument, type User } from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Icon,
  SimulatedBadge,
} from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { customers as api } from '@/api/endpoints';
import { ApiRequestError } from '@/api/client';
import { formatDate, formatFileSize } from '@/lib/format';
import { DOCUMENT_ACCEPT_ATTRIBUTE, DOCUMENT_TYPES_SENTENCE } from '@/lib/upload-limits';

/**
 * THE CUSTOMER'S FILED PAPERWORK. October mandate §4.
 *
 * The service agreement, the credit application, the site induction
 * certificate, the written purchase-order authority — documents that belong to
 * the customer rather than to any one job, and which had nowhere to live.
 *
 * THE OFFICE'S PANEL. It is rendered only where the viewer holds
 * `customers.manage`, and the server refuses the routes to anybody else
 * regardless — the screen is not the permission.
 *
 * WHAT IT WILL NOT DO. It will not claim an upload succeeded that did not: the
 * list is re-read from the server after every upload, so what is on screen is
 * what the server has rather than what this component hoped. A failure keeps
 * the chosen file so *Try again* re-sends THAT file instead of asking somebody
 * to find it again.
 */
export const CustomerDocumentsPanel = ({
  customerId,
  documents,
  users,
  onChanged,
}: {
  readonly customerId: string;
  /**
   * WITHOUT THE STORAGE KEY, which the view strips before it leaves the
   * server. A screen has no use for one and the download route takes an id;
   * typing it out of the prop is what makes that impossible to forget.
   */
  readonly documents: readonly Omit<CustomerDocument, 'storageKey'>[];
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const input = useRef<HTMLInputElement | null>(null);
  const [caption, setCaption] = useState('');
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
    await api.withdrawDocument(customerId, documentId);
    // Re-read rather than splice: what is on screen is what the server has.
    onChanged();
  };

  const send = async (file: File): Promise<void> => {
    setUploading(true);
    try {
      await api.attachDocument(customerId, file, caption);
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
        title="Customer documents"
        description="Agreements, authorities and certificates filed against this customer."
        action={
          <Badge tone="neutral">
            {documents.length === 0 ? 'None on file' : `${documents.length} on file`}
          </Badge>
        }
      />

      {documents.length === 0 ? (
        <p className="mt-4 text-sm text-steel-500" data-testid="customer-documents-empty">
          Nothing is filed against this customer yet.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-steel-100" data-testid="customer-documents">
          {documents.map((document) => (
            <li
              key={document.id}
              className="flex items-start justify-between gap-3 py-3"
              data-testid="customer-document-row"
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
              </div>
              {/*
                A real download, through the authorised route. The link is not
                a storage key and cannot be turned into one.
              */}
              <div className="flex shrink-0 items-center gap-3">
                <a
                  className="text-xs font-semibold text-eje-600 underline-offset-2 hover:underline"
                  href={api.documentUrl(customerId, document.id)}
                  download={document.fileName}
                  data-testid="customer-document-download"
                >
                  Download
                </a>
                {/*
                  WITHDRAWN, NOT DELETED — the register's own rule. The row and
                  the bytes stay, so an audit can still resolve what was on
                  file when a decision was taken; this only takes it off the
                  screen. There is no delete, deliberately.
                */}
                <button
                  type="button"
                  className="text-xs font-semibold text-steel-500 underline-offset-2 hover:underline"
                  onClick={() => void withdraw(document.id)}
                  data-testid="customer-document-withdraw"
                >
                  Withdraw
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-steel-100 pt-3">
        <label
          className="text-xs font-semibold tracking-wide text-steel-500 uppercase"
          htmlFor="customer-document-caption"
        >
          What this document is
        </label>
        <input
          id="customer-document-caption"
          value={caption}
          maxLength={300}
          onChange={(event) => setCaption(event.target.value)}
          placeholder="Signed service agreement, 2026"
          className="mt-1 h-11 w-full rounded-[var(--radius-control)] border border-steel-300 bg-surface px-3 text-sm placeholder:text-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none"
          data-testid="customer-document-caption"
        />

        {/*
          A HIDDEN INPUT BEHIND A REAL BUTTON, and not for looks.
          A bare `<input type="file">` renders about 20px tall, which the
          responsive gate refuses as a touch target — correctly: the office
          uses this on a tablet. The pattern is `PhotoCaptureButtons`'s, so the
          three upload surfaces behave the same way on the device that matters.
        */}
        <input
          ref={input}
          type="file"
          accept={DOCUMENT_ACCEPT_ATTRIBUTE}
          className="hidden"
          data-testid="customer-document-file"
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
          data-testid="customer-document-choose"
        >
          <Icon name="document" className="size-4" />
          Choose a document
        </Button>

        <p className="mt-2 text-[11px] leading-relaxed text-steel-400">
          {DOCUMENT_TYPES_SENTENCE} The server checks the file itself rather than its name, and
          records the size and checksum of what it stored.
        </p>

        {uploading && (
          <p className="mt-2 text-xs text-steel-500" data-testid="customer-document-uploading">
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
              data-testid="customer-document-retry"
            >
              Try again with the same file
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
};
