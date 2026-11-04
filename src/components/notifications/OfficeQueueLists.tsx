'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  invoiceNumberProblem,
  jobStatusLabel,
  jobTypeLabel,
  MAX_INVOICE_NUMBER_LENGTH,
  MAX_PO_NUMBER_LENGTH,
  poNumberProblem,
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
      className="inline-flex items-center font-semibold text-eje-700 underline-offset-2 hover:underline"
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
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="amber" size="sm">
            {jobStatusLabel(row.status)}
          </Badge>
          {/* PO-FLOW-1: say which PO handling records, and let the office refuse it. */}
          {row.poOnHandling !== null && (
            <Badge tone="blue" size="sm">
              PO {row.poOnHandling} on the job
            </Badge>
          )}
          <Button
            size="sm"
            loading={operation.running}
            onClick={async () => {
              if (await operation.run(() => jobs.handleOffice(row.jobId))) onChanged();
            }}
            data-testid={`queue-mark-handled-${row.jobNumber}`}
          >
            {row.poOnHandling !== null ? `Mark handled with PO ${row.poOnHandling}` : 'Mark handled'}
          </Button>
          {row.poOnHandling !== null && (
            <Button
              size="sm"
              variant="secondary"
              loading={operation.running}
              onClick={async () => {
                if (await operation.run(() => jobs.handleOffice(row.jobId, undefined, true))) onChanged();
              }}
              data-testid={`queue-mark-handled-await-po-${row.jobNumber}`}
            >
              Not the PO — wait for it
            </Button>
          )}
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

/**
 * THE TWO NUMBER STEPS. INV-FLOW-1 (2 November 2026): Awaiting PO takes the
 * PO number and moves the job to Awaiting Invoice No; Awaiting Invoice No
 * takes the invoice number and moves it to Invoiced. Neither number stands in
 * for the other, and the server refuses a skipped step whatever this sends.
 */
type NumberStep = 'po' | 'invoice';

const STEP = {
  po: {
    list: 'awaiting-po-list',
    row: 'awaiting-po',
    field: 'po-number',
    label: 'PO number',
    hint: "The customer's purchase order. Saving it moves the job to Awaiting Invoice No.",
    max: MAX_PO_NUMBER_LENGTH,
    problem: poNumberProblem,
    failed: 'The PO number was not saved',
    emptyTitle: 'Nothing is awaiting a PO',
    emptyText: 'A job card the office has marked handled appears here until its PO number is recorded.',
  },
  invoice: {
    list: 'awaiting-invoice-list',
    row: 'awaiting-invoice',
    field: 'invoice-number',
    label: 'Invoice No.',
    hint: 'From Sage. Saving it moves the job to Invoiced.',
    max: MAX_INVOICE_NUMBER_LENGTH,
    problem: invoiceNumberProblem,
    failed: 'The invoice number was not saved',
    emptyTitle: 'Nothing is awaiting an invoice number',
    emptyText: 'A job appears here once its PO number is recorded, until its invoice number is.',
  },
} as const;

const NumberStepList = ({
  step,
  rows,
  onChanged,
}: {
  readonly step: NumberStep;
  readonly rows: readonly OfficeQueueRow[];
  readonly onChanged: () => void;
}) =>
  rows.length === 0 ? (
    <EmptyState title={STEP[step].emptyTitle} description={STEP[step].emptyText} icon={<Icon name="document" />} />
  ) : (
    <ul className="space-y-3" data-testid={STEP[step].list}>
      {rows.map((row) => (
        <li key={row.jobId}>
          <NumberStepRow step={step} row={row} onChanged={onChanged} />
        </li>
      ))}
    </ul>
  );

/** Awaiting PO: each with its PO number field. */
export const AwaitingPoList = (props: { readonly rows: readonly OfficeQueueRow[]; readonly onChanged: () => void }) => (
  <NumberStepList step="po" {...props} />
);

/** Awaiting Invoice No: each with its PO shown and its Invoice No. field. */
export const AwaitingInvoiceList = (props: { readonly rows: readonly OfficeQueueRow[]; readonly onChanged: () => void }) => (
  <NumberStepList step="invoice" {...props} />
);

const NumberStepRow = ({
  step,
  row,
  onChanged,
}: {
  readonly step: NumberStep;
  readonly row: OfficeQueueRow;
  readonly onChanged: () => void;
}) => {
  const operation = useOperation();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const config = STEP[step];

  const save = async () => {
    // Without a number nothing is sent and the job stays where it is.
    const reason = config.problem(value);
    setProblem(reason);
    if (reason !== null) return;
    const sent = step === 'po' ? () => jobs.recordPo(row.jobId, value) : () => jobs.recordInvoice(row.jobId, value);
    if (await operation.run(sent)) onChanged();
  };

  return (
    <Card data-testid={`${config.row}-${row.jobNumber}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <JobHeading row={row} />
        <div className="text-right text-xs text-steel-500">
          {row.officeHandling !== null && <p>Handled {formatDateTime(row.officeHandling.handledAt)}</p>}
          {step === 'invoice' && row.purchaseOrder !== null && (
            <p className="mt-1">
              <Badge tone="blue" size="sm">Purchase Order:{row.purchaseOrder.number}</Badge>
            </p>
          )}
        </div>
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
            label={config.label}
            value={value}
            maxLength={config.max}
            error={problem ?? undefined}
            hint={config.hint}
            onChange={(event) => {
              setValue(event.target.value);
              if (problem !== null) setProblem(null);
            }}
            data-testid={`${config.field}-${row.jobNumber}`}
          />
        </div>
        <Button type="submit" loading={operation.running}>
          Save
        </Button>
      </form>
      {operation.error !== null && (
        <div className="mt-3">
          <RuleViolationNotice title={config.failed} message={operation.error} violations={operation.violations} />
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
                {row.purchaseOrder !== null && (
                  <Badge tone="blue" size="sm">Purchase Order:{row.purchaseOrder.number}</Badge>
                )}{' '}
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
