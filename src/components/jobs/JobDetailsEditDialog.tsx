'use client';

import { useState } from 'react';
import {
  editableDetailFields,
  JOB_DETAIL_LABELS,
  jobDetailValues,
  type Job,
  type JobDetailField,
  type JobDetailValues,
} from '@/domain';
import { Button, Modal, TextAreaField, TextField } from '@/components/ui';
import { RuleViolationNotice } from './RuleViolationNotice';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';

/**
 * CORRECTING A JOB'S RECORDED DETAILS. JOB-EDIT-1 (#72).
 *
 * Offered only to somebody who may (`jobs.editDetails`) on a job that is still
 * editable — the caller decides that from the same two rules the server
 * enforces, and the server enforces them regardless.
 *
 * WHAT IT SENDS: the fields that actually changed, each with the value this
 * dialog read when it opened. The server refuses the edit if the job no longer
 * says that — somebody else corrected it in the meantime — and the refusal
 * names the field and what it now reads.
 *
 * Fields this job type does not carry are not offered at all
 * (`editableDetailFields`), which is the same list the server checks against.
 */
type FormValues = Record<JobDetailField, string>;

const toForm = (values: JobDetailValues): FormValues => ({
  orderNumber: values.orderNumber,
  referenceNumber: values.referenceNumber,
  deliveryNote: values.deliveryNote,
  quoteNumber: values.quoteNumber,
  faultDescription: values.faultDescription,
  repairPartNumber: values.repairPartNumber,
  repairDescription: values.repairDescription,
  repairQuantity: values.repairQuantity === null ? '' : String(values.repairQuantity),
});

/** The form's value as the job would hold it: trimmed text, a quantity or null. */
const fromForm = (field: JobDetailField, value: string): string | number | null => {
  const text = value.trim();
  if (field !== 'repairQuantity') return text;
  return text.length === 0 ? null : Number(text);
};

const MAX_LENGTH: Readonly<Record<JobDetailField, number | undefined>> = {
  orderNumber: 120,
  referenceNumber: 120,
  deliveryNote: 120,
  quoteNumber: 120,
  faultDescription: 8000,
  repairPartNumber: 120,
  repairDescription: 500,
  repairQuantity: undefined,
};

export const JobDetailsEditDialog = ({
  job,
  open,
  onClose,
  onSaved,
}: {
  readonly job: Job;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) => {
  const operation = useOperation();
  const fields = editableDetailFields(job.jobType);
  /*
   * What the job said when the dialog opened: the edit's "expected" values.
   * The caller MOUNTS this only while it is open, so every opening reads the
   * job afresh and a second edit starts from what the first one saved.
   */
  const [original] = useState<JobDetailValues>(() => jobDetailValues(job));
  const [form, setForm] = useState<FormValues>(() => toForm(original));

  /*
   * A QUANTITY THAT IS NOT A WHOLE NUMBER IS STOPPED HERE, not sent. `Number`
   * turns "abc" into NaN, and JSON turns NaN into null — so without this, a
   * typing slip would arrive at the server as "clear the quantity" and be
   * applied. The server refuses fractions and zero itself; this is about the
   * value that would otherwise never reach it as what was typed.
   */
  const quantityText = form.repairQuantity.trim();
  const quantityError =
    quantityText.length > 0 && !/^[1-9]\d*$/u.test(quantityText)
      ? 'Enter a whole number of units, or leave it blank.'
      : undefined;

  const changed = fields.filter((field) => fromForm(field, form[field]) !== original[field]);

  const close = () => {
    operation.clearError();
    onClose();
  };

  const save = async () => {
    if (quantityError !== undefined) return;
    if (changed.length === 0) {
      close();
      return;
    }
    const changes: Record<string, string | number | null> = {};
    const expected: Record<string, string | number | null> = {};
    for (const field of changed) {
      changes[field] = fromForm(field, form[field]);
      expected[field] = original[field];
    }
    const ok = await operation.run(() =>
      jobs.editDetails(
        job.id,
        changes as Partial<JobDetailValues>,
        expected as Partial<JobDetailValues>,
      ),
    );
    if (ok) {
      onSaved();
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      size="lg"
      title="Edit job details"
      description="Corrections are recorded on the activity trail with what each field said before. Once the customer has signed, the details can no longer be edited — raise a correction instead."
      onClose={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button
            loading={operation.running}
            disabled={changed.length === 0 || quantityError !== undefined}
            onClick={save}
            data-testid="save-job-details"
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="job-details-form">
        {operation.error !== null && (
          <RuleViolationNotice
            title="The details were not changed"
            message={operation.error}
            violations={operation.violations}
          />
        )}
        {fields.map((field) =>
          field === 'faultDescription' ? (
            <TextAreaField
              key={field}
              label={JOB_DETAIL_LABELS[field]}
              value={form[field]}
              maxLength={MAX_LENGTH[field]}
              rows={5}
              data-testid={`job-detail-${field}`}
              onChange={(event) => setForm({ ...form, [field]: event.target.value })}
            />
          ) : (
            <TextField
              key={field}
              label={JOB_DETAIL_LABELS[field]}
              value={form[field]}
              maxLength={MAX_LENGTH[field]}
              inputMode={field === 'repairQuantity' ? 'numeric' : undefined}
              hint={field === 'repairQuantity' ? 'A whole number, or blank if nobody has counted.' : undefined}
              error={field === 'repairQuantity' ? quantityError : undefined}
              data-testid={`job-detail-${field}`}
              onChange={(event) => setForm({ ...form, [field]: event.target.value })}
            />
          ),
        )}
      </div>
    </Modal>
  );
};
