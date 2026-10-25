'use client';

import { useState } from 'react';
import {
  can,
  invoiceNumberProblem,
  isAwaitingOfficeHandling,
  MAX_INVOICE_NUMBER_LENGTH,
  userFullName,
  type Job,
  type User,
} from '@/domain';
import { Badge, Button, Card, CardHeader, DefinitionGrid, TextField } from '@/components/ui';
import { RuleViolationNotice } from '@/components/jobs/RuleViolationNotice';
import { formatDateTime } from '@/lib/format';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { useCurrentUser } from '@/providers/AppProvider';

/**
 * THE OFFICE LIFECYCLE ON THE JOB. Issue #73, Batch 1.
 *
 *   Office Handling --[Mark handled]--> Awaiting PO --[Invoice No + Save]--> Invoiced
 *
 * Shown on every submitted job. The actions are the office's
 * (`jobs.officeHandling`); everybody else who may see the job reads where it
 * is. The server is what enforces both — a hidden button is not authorisation.
 *
 * EJE raise the invoice in Sage, by hand. This records the number; it does not
 * talk to Sage, and says so.
 */
export const OfficeLifecyclePanel = ({
  job,
  users,
  onChanged,
}: {
  readonly job: Job;
  readonly users: readonly User[];
  readonly onChanged: () => void;
}) => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const office = can(currentUser.role, 'jobs.officeHandling');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const nameOf = (id: string) => {
    const user = users.find((candidate) => candidate.id === id);
    return user === undefined ? 'Unknown user' : userFullName(user);
  };

  const handle = async () => {
    if (await operation.run(() => jobs.handleOffice(job.id))) onChanged();
  };

  const saveInvoice = async () => {
    // The server says the same; saying it here keeps a blank save from even
    // leaving the tablet. Either way the job stays Awaiting PO.
    const problem = invoiceNumberProblem(invoiceNumber);
    setInvoiceError(problem);
    if (problem !== null) return;
    if (await operation.run(() => jobs.recordInvoice(job.id, invoiceNumber))) {
      setInvoiceNumber('');
      onChanged();
    }
  };

  const stage = isAwaitingOfficeHandling(job.status)
    ? 'Office Handling'
    : job.status === 'awaiting_po'
      ? 'Awaiting PO'
      : 'Invoiced';

  return (
    <Card className="mb-5" data-testid="office-lifecycle">
      <CardHeader
        title="Office handling and invoicing"
        description="After the technician submits, the office handles the job card, raises the invoice in Sage and records its number here."
        action={
          <Badge tone={job.status === 'invoiced' ? 'green' : 'amber'} size="sm">
            {stage}
          </Badge>
        }
      />

      {operation.error !== null && (
        <div className="mt-4">
          <RuleViolationNotice
            title="That could not be saved"
            message={operation.error}
            violations={operation.violations}
          />
        </div>
      )}

      <DefinitionGrid
        className="mt-4"
        columns={3}
        items={[
          {
            label: 'Handled',
            value:
              job.officeHandling === null
                ? 'Not yet'
                : `${nameOf(job.officeHandling.handledBy)}, ${formatDateTime(job.officeHandling.handledAt)}`,
          },
          {
            label: 'Invoice No.',
            value: job.invoice === null ? 'Not recorded' : job.invoice.number,
          },
          {
            label: 'Invoiced',
            value:
              job.invoice === null
                ? 'Not yet'
                : `${nameOf(job.invoice.recordedBy)}, ${formatDateTime(job.invoice.recordedAt)}`,
          },
        ]}
      />

      {office && isAwaitingOfficeHandling(job.status) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button loading={operation.running} onClick={() => void handle()} data-testid="mark-handled">
            Mark handled
          </Button>
          <p className="text-sm text-steel-600">
            Moves the job to Awaiting PO. The signed job card, its document and its history are not changed.
          </p>
        </div>
      )}

      {office && job.status === 'awaiting_po' && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void saveInvoice();
          }}
        >
          <div className="min-w-[14rem] flex-1">
            <TextField
              label="Invoice No."
              value={invoiceNumber}
              maxLength={MAX_INVOICE_NUMBER_LENGTH}
              error={invoiceError ?? undefined}
              hint="The number of the invoice raised in Sage. Saving it moves the job to Invoiced."
              onChange={(event) => {
                setInvoiceNumber(event.target.value);
                if (invoiceError !== null) setInvoiceError(null);
              }}
              data-testid="invoice-number"
            />
          </div>
          <Button type="submit" loading={operation.running} data-testid="save-invoice-number">
            Save invoice number
          </Button>
        </form>
      )}
    </Card>
  );
};
