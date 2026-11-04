'use client';

import { useState } from 'react';
import {
  can,
  invoiceNumberProblem,
  isAwaitingOfficeHandling,
  MAX_INVOICE_NUMBER_LENGTH,
  MAX_PO_NUMBER_LENGTH,
  poNumberProblem,
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
  const [poNumber, setPoNumber] = useState('');
  const [poError, setPoError] = useState<string | null>(null);
  const nameOf = (id: string) => {
    const user = users.find((candidate) => candidate.id === id);
    return user === undefined ? 'Unknown user' : userFullName(user);
  };

  // PO-FLOW-1: the job's own PO (its customer order number) or one typed here
  // sends it straight to Awaiting Invoice No; the server decides, from what is stored.
  const existingPo =
    job.purchaseOrder?.number ??
    (job.orderNumber.trim().length > 0 && poNumberProblem(job.orderNumber) === null ? job.orderNumber.trim() : null);
  const [handlingPo, setHandlingPo] = useState('');
  const handle = async (declineOrderNumber = false) => {
    const typed = declineOrderNumber ? '' : handlingPo.trim();
    if (typed.length > 0) {
      const problem = poNumberProblem(typed);
      setPoError(problem);
      if (problem !== null) return;
    }
    if (await operation.run(() => jobs.handleOffice(job.id, typed.length > 0 ? typed : undefined, declineOrderNumber))) {
      setHandlingPo('');
      onChanged();
    }
  };

  // INV-FLOW-1: Awaiting PO leaves only on a PO number.
  const savePo = async () => {
    const problem = poNumberProblem(poNumber);
    setPoError(problem);
    if (problem !== null) return;
    if (await operation.run(() => jobs.recordPo(job.id, poNumber))) {
      setPoNumber('');
      onChanged();
    }
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
      : job.status === 'awaiting_invoice_no'
        ? 'Awaiting Invoice No'
        : 'Invoiced';

  return (
    <Card className="mb-5" data-testid="office-lifecycle">
      <CardHeader
        title="Office handling and invoicing"
        description="After the technician submits, the office handles the job card, raises the invoice in Sage and records its number here: Handled → Awaiting Invoice No → Invoiced. A job with no PO number waits in Awaiting PO until it has one."
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
            label: 'PO number',
            value:
              job.purchaseOrder === null
                ? 'Not recorded'
                : `${job.purchaseOrder.number} (${nameOf(job.purchaseOrder.recordedBy)}, ${formatDateTime(job.purchaseOrder.recordedAt)})`,
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
        <div className="mt-4 flex flex-wrap items-end gap-3">
          {existingPo === null && (
            <div className="min-w-[14rem] flex-1">
              <TextField
                label="PO number (optional)"
                value={handlingPo}
                maxLength={MAX_PO_NUMBER_LENGTH}
                error={poError ?? undefined}
                hint="If the customer's PO is known now, enter it and the job goes straight to Awaiting Invoice No."
                onChange={(event) => {
                  setHandlingPo(event.target.value);
                  if (poError !== null) setPoError(null);
                }}
                data-testid="handling-po-number"
              />
            </div>
          )}
          <Button loading={operation.running} onClick={() => void handle()} data-testid="mark-handled">
            {existingPo !== null && job.purchaseOrder === null ? `Mark handled with PO ${existingPo}` : 'Mark handled'}
          </Button>
          {/* PO-FLOW-1: the order number is free text — "TBC" is not a PO, and a PO is never replaced. */}
          {existingPo !== null && job.purchaseOrder === null && (
            <Button
              variant="secondary"
              loading={operation.running}
              onClick={() => void handle(true)}
              data-testid="mark-handled-await-po"
            >
              Not the PO — wait for it
            </Button>
          )}
          <p className="basis-full text-sm text-steel-600" data-testid="handling-next-stage">
            {existingPo !== null
              ? `This job already has PO ${existingPo}, so it moves straight to Awaiting Invoice No and that PO is recorded for good. If "${existingPo}" is not the customer's PO, choose "Not the PO — wait for it".`
              : handlingPo.trim().length > 0
                ? 'With this PO number it moves straight to Awaiting Invoice No.'
                : 'With no PO number it moves to Awaiting PO.'}{' '}
            The signed job card, its document and its history are not changed.
          </p>
        </div>
      )}

      {office && job.status === 'awaiting_po' && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void savePo();
          }}
        >
          <div className="min-w-[14rem] flex-1">
            <TextField
              label="PO number"
              value={poNumber}
              maxLength={MAX_PO_NUMBER_LENGTH}
              error={poError ?? undefined}
              hint={
                job.orderNumber.trim().length > 0
                  ? `The customer's purchase order. The job's order number is "${job.orderNumber.trim()}" — type it here only if it is the PO. Saving moves the job to Awaiting Invoice No.`
                  : "The customer's purchase order. Saving it moves the job to Awaiting Invoice No."
              }
              onChange={(event) => {
                setPoNumber(event.target.value);
                if (poError !== null) setPoError(null);
              }}
              data-testid="po-number"
            />
          </div>
          <Button type="submit" loading={operation.running} data-testid="save-po-number">
            Save PO number
          </Button>
        </form>
      )}

      {office && job.status === 'awaiting_invoice_no' && (
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
