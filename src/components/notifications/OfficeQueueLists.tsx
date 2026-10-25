'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  invoiceNumberProblem,
  jobStatusLabel,
  jobTypeLabel,
  MAX_INVOICE_NUMBER_LENGTH,
} from '@/domain';
import type { OfficeQueueRow } from '@/application/office-lifecycle';
import { Badge, Button, Card, EmptyState, Icon, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { formatDateTime } from '@/lib/format';

/**
 * THE OFFICE LIFECYCLE, AS LISTS. Issue #73, Batch 1.
 *
 * Read from the jobs' persisted status, not from notifications: a job is in a
 * list because of where it IS, so it cannot drift out of one because somebody
 * filed a notice. The actions call the same operations as the job's own office
 * panel, and the server enforces them.
 */

const JobHeading = ({ row }: { readonly row: OfficeQueueRow }) => (
  <div className="min-w-0">
    <Link
      href={`/jobs/${row.jobNumber}`}
      className="font-semibold text-eje-700 underline-offset-2 hover:underline"
    >
      {row.jobNumber}
    </Link>
    <span className="ml-2 text-sm text-steel-700">{row.customerName}</span>
    <p className="mt-0.5 text-xs text-steel-500">
      {jobTypeLabel(row.jobType)}
      {row.submittedAt === null ? '' : ` · submitted ${formatDateTime(row.submittedAt)}`}
    </p>
  </div>
);

/** Inbox: submitted job cards waiting for the office. */
export const OfficeHandlingList = ({
  rows,
  onChanged,
}: {
  readonly rows: readonly OfficeQueueRow[];
  readonly onChanged: () => void;
}) => (
  <section className="mb-6" data-testid="office-handling-list">
    <h2 className="mb-2 text-sm font-semibold tracking-wide text-steel-600 uppercase">
      Office handling — {rows.length} {rows.length === 1 ? 'job card' : 'job cards'}
    </h2>
    {rows.length === 0 ? (
      <p className="text-sm text-steel-500">No submitted job card is waiting for the office.</p>
    ) : (
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.jobId}>
            <HandlingRow row={row} onChanged={onChanged} />
          </li>
        ))}
      </ul>
    )}
  </section>
);

const HandlingRow = ({
  row,
  onChanged,
}: {
  readonly row: OfficeQueueRow;
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  return (
    <Card data-testid={`office-handling-${row.jobNumber}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <JobHeading row={row} />
        <div className="flex items-center gap-2">
          <Badge tone="amber" size="sm">
            {jobStatusLabel(row.status)}
          </Badge>
          <Button
            size="sm"
            loading={operation.running}
            onClick={async () => {
              if (await operation.run(() => jobs.handleOffice(row.jobId))) onChanged();
            }}
          >
            Mark handled
          </Button>
        </div>
      </div>
      {operation.error !== null && (
        <div className="mt-3">
          <RuleViolationNotice
            title="It was not marked handled"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      )}
    </Card>
  );
};

/** Awaiting PO: each with its Invoice No. field. */
export const AwaitingPoList = ({
  rows,
  onChanged,
}: {
  readonly rows: readonly OfficeQueueRow[];
  readonly onChanged: () => void;
}) =>
  rows.length === 0 ? (
    <EmptyState
      title="Nothing is awaiting a PO"
      description="A job card the office has marked handled appears here until its invoice number is recorded."
      icon={<Icon name="document" />}
    />
  ) : (
    <ul className="space-y-3" data-testid="awaiting-po-list">
      {rows.map((row) => (
        <li key={row.jobId}>
          <AwaitingPoRow row={row} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );

const AwaitingPoRow = ({
  row,
  onChanged,
}: {
  readonly row: OfficeQueueRow;
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    // Without a number nothing is sent and the job stays Awaiting PO.
    const reason = invoiceNumberProblem(invoiceNumber);
    setProblem(reason);
    if (reason !== null) return;
    if (await operation.run(() => jobs.recordInvoice(row.jobId, invoiceNumber))) onChanged();
  };

  return (
    <Card data-testid={`awaiting-po-${row.jobNumber}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <JobHeading row={row} />
        {row.officeHandling !== null && (
          <span className="text-xs text-steel-500">
            Handled {formatDateTime(row.officeHandling.handledAt)}
          </span>
        )}
      </div>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="min-w-[12rem] flex-1">
          <TextField
            label="Invoice No."
            value={invoiceNumber}
            maxLength={MAX_INVOICE_NUMBER_LENGTH}
            error={problem ?? undefined}
            hint="From Sage. Saving it moves the job to Invoiced."
            onChange={(event) => {
              setInvoiceNumber(event.target.value);
              if (problem !== null) setProblem(null);
            }}
            data-testid={`invoice-number-${row.jobNumber}`}
          />
        </div>
        <Button type="submit" loading={operation.running}>
          Save
        </Button>
      </form>
      {operation.error !== null && (
        <div className="mt-3">
          <RuleViolationNotice
            title="The invoice number was not saved"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      )}
    </Card>
  );
};

/** Invoiced: finished, most recent first. */
export const InvoicedList = ({ rows }: { readonly rows: readonly OfficeQueueRow[] }) =>
  rows.length === 0 ? (
    <EmptyState
      title="Nothing invoiced yet"
      description="A job moves here when its invoice number is recorded."
      icon={<Icon name="document" />}
    />
  ) : (
    <ul className="space-y-3" data-testid="invoiced-list">
      {rows.map((row) => (
        <li key={row.jobId}>
          <Card data-testid={`invoiced-${row.jobNumber}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <JobHeading row={row} />
              <div className="text-right">
                <Badge tone="green" size="sm">
                  Invoice {row.invoice?.number ?? '—'}
                </Badge>
                {row.invoice !== null && (
                  <p className="mt-1 text-xs text-steel-500">
                    {formatDateTime(row.invoice.recordedAt)}
                  </p>
                )}
              </div>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
