import {
  can,
  editableDetailFields,
  getJobTypeDefinition,
  JOB_DETAIL_LABELS,
  jobDetailValues,
  userFullName,
  type Job,
  type JobDetailField,
  type JobDetailValues,
} from '@/domain';
import type { OperationContext } from './context';
import { audit, changesBetween } from './audit';
import { WorkflowError } from './errors';
import { assertFaultDescribed } from './job-creation';
import { assertEditable } from './job-operations';

/**
 * CORRECTING A JOB'S RECORDED DETAILS. JOB-EDIT-1 (#72).
 *
 * Built to the documented default the owner adopted on 23 October 2026, and
 * deliberately inventing no rule of its own — every decision below is one the
 * system had already made somewhere else:
 *
 *   WHO        the office (`jobs.editDetails`: Master and Coordinator).
 *   WHEN       while the job is editable — `assertEditable`, the same check
 *              every capture passes through. So never after the customer has
 *              signed, and never where `canEditJob` already closes the job to
 *              this role. After signature the remedy is IMMUT-9's correction
 *              with its own addendum; this operation is not a way round it.
 *   WHAT       the fields this job type carries (`editableDetailFields`) and
 *              nothing else. A field the type does not carry is REFUSED, not
 *              quietly dropped: creation clears one because a form switching
 *              job type sends what it had, but an edit has no such excuse, and
 *              discarding a change somebody asked for would be a silent lie.
 *   VALID      exactly as creation validates: trimmed, the same lengths (the
 *              command's schema), and the same fault-description rule
 *              (`assertFaultDescribed`) — deferred on a draft, as DRAFT-1 defers
 *              it at creation, and re-asked when the draft is released.
 *   RECORDED   every moved field as a `details.<field>` from/to pair on a
 *              `job_details_edited` event (AUDIT-2). An edit that moves nothing
 *              records nothing and saves nothing.
 *   STALE      every changed field carries the value the editor last saw, and
 *              the edit is refused if the job no longer says that — so two
 *              people correcting the same job cannot silently overwrite each
 *              other. The same principle as a checklist answer carrying the
 *              answer it replaces (OFF-CHK-1); underneath it, the job row's
 *              version still refuses a concurrent write (`VersionLedger`).
 */
export interface JobDetailEdit {
  /** The fields being changed, and what to. */
  readonly changes: Partial<JobDetailValues>;
  /** For each changed field, what the editor read before changing it. */
  readonly expected: Partial<JobDetailValues>;
}

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/** Trimmed text, or the quantity as given. Creation trims the same fields. */
const normalise = <F extends JobDetailField>(
  field: F,
  value: JobDetailValues[F],
): JobDetailValues[F] =>
  (typeof value === 'string' ? value.trim() : value) as JobDetailValues[F];

const shown = (value: string | number | null): string =>
  value === null || value === '' ? 'nothing' : `“${value}”`;

export const editJobDetails = async (
  context: OperationContext,
  job: Job,
  edit: JobDetailEdit,
): Promise<Job> => {
  if (!can(context.actor.role, 'jobs.editDetails')) {
    throw refuse(
      'Only the office can change a job’s details.',
      'not_permitted',
      'A Master or a Coordinator corrects the order number, references and fault description. If one is wrong, raise a change request.',
    );
  }

  // Signature first, then the role's own status rule — the same refusal, in
  // the same words, that every other change to this job would get.
  assertEditable(context, job);

  const definition = getJobTypeDefinition(job.jobType);
  const carried = editableDetailFields(job.jobType);
  const fields = (Object.keys(edit.changes) as JobDetailField[]).filter(
    (field) => edit.changes[field] !== undefined,
  );

  for (const field of fields) {
    if (!carried.includes(field)) {
      throw refuse(
        `A ${definition.label.toLowerCase()} job does not record a ${JOB_DETAIL_LABELS[field].toLowerCase()}.`,
        'not_applicable_to_job_type',
        `${JOB_DETAIL_LABELS[field]} is only kept on the job types that capture it, so there is nothing here to change.`,
      );
    }
  }

  const current = jobDetailValues(job);

  /*
   * THE EDITOR'S COPY MUST STILL BE TRUE. Checked field by field, and only for
   * the fields being changed: somebody correcting the order number is not
   * refused because a colleague fixed the fault description in the meantime.
   */
  for (const field of fields) {
    const expected = edit.expected[field];
    if (expected === undefined || normalise(field, expected) !== current[field]) {
      throw refuse(
        `${JOB_DETAIL_LABELS[field]} was changed by somebody else after you opened it.`,
        'job_details_changed',
        `It now reads ${shown(current[field])}. Reload the job, check the current details and make your change again.`,
      );
    }
  }

  const next: JobDetailValues = { ...current };
  for (const field of fields) {
    (next as Record<JobDetailField, string | number | null>)[field] = normalise(
      field,
      edit.changes[field] as JobDetailValues[typeof field],
    );
  }

  const quantity = next.repairQuantity;
  if (quantity !== null && (!Number.isInteger(quantity) || quantity <= 0)) {
    throw refuse(
      'The quantity booked in must be a whole number.',
      'invalid_quantity',
      'Enter how many units came in, or leave it blank if nobody has counted them yet.',
    );
  }

  // A draft may still say nothing about the work — DRAFT-1 defers exactly this
  // check, and `releaseDraft` asks it again before anybody is sent.
  if (job.status !== 'draft') assertFaultDescribed(definition, next.faultDescription);

  const moved = fields.filter((field) => next[field] !== current[field]);
  if (moved.length === 0) return job;

  const before: Record<string, string | number | null> = {};
  const after: Record<string, string | number | null> = {};
  for (const field of moved) {
    before[field] = current[field];
    after[field] = next[field];
  }

  const saved = await context.repos.jobs.save({
    ...job,
    orderNumber: next.orderNumber,
    referenceNumber: next.referenceNumber,
    deliveryNote: next.deliveryNote,
    quoteNumber: next.quoteNumber,
    faultDescription: next.faultDescription,
    repairItem: {
      partNumber: next.repairPartNumber,
      description: next.repairDescription,
      quantity: next.repairQuantity,
    },
  });

  await audit(context, {
    jobId: saved.id,
    type: 'job_details_edited',
    summary: 'Job details edited',
    detail: `${userFullName(context.actor)} changed the ${moved
      .map((field) => JOB_DETAIL_LABELS[field].toLowerCase())
      .join(', ')}.`,
    changes: changesBetween('details', before, after),
  });

  return saved;
};
