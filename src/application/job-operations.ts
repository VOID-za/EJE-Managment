import {
  can,
  asAttachmentId,
  asLineItemId,
  canTransition,
  deliveryStateLabel,
  emptyDelivery,
  checkReadyForSignature,
  checkSchedule,
  checkReadyForSubmission,
  emptyChecklistResponse,
  cancelJobRefusal,
  cancellationReasonLabel,
  deleteJobRefusal,
  describeAvailabilityConflict,
  findJobAvailabilityConflicts,
  getJobTypeDefinition,
  isAdministrativeCapture,
  isAfterSignature,
  isJobTechnician,
  workAttribution,
  transferJobRefusal,
  transferReasonLabel,
  canEditJob,
  labourRateLabel,
  siteAddressLine,
  siteNavigationUrl,
  pricingInputsFrom,
  roleLabel,
  signatureDeclarationFor,
  userFullName,
  type Attachment,
  type ChecklistResponse,
  type ChecklistTemplate,
  type CancellationReason,
  type Job,
  type JobCompletionReport,
  type JobStatus,
  type LabourRateType,
  type Machine,
  type Site,
  type PassFailNa,
  type PricingSnapshot,
  type TransferReason,
  type User,
  type DeliveryRecord,
  type UserId,
} from '@/domain';
import { formatHours, formatKilometres } from '@/lib/format';
import type { PdfVariant } from '@/services/ports';
import type { OperationContext } from './context';
import { audit, notify } from './audit';
import { storeFinalDocument } from './final-document';
import { loadJobView } from './job-view';
import { WorkflowError } from './errors';

/**
 * Application operations for the job lifecycle.
 *
 * Each operation:
 *   1. asks the domain whether the change is permitted,
 *   2. produces the next immutable Job value,
 *   3. persists it through the repository, and
 *   4. records an audit event (and any simulated outbound message).
 *
 * The UI never performs steps 1-4 itself.
 */

const assertEditable = (context: OperationContext, job: Job): void => {
  if (canEditJob(context.actor.role, job.status)) return;

  throw new WorkflowError(
    job.status === 'closed'
      ? `${job.jobNumber} is closed and can no longer be changed.`
      : `${job.jobNumber} is in Master review and can only be changed by a Master.`,
    [
      {
        code: 'job_locked',
        message:
          job.status === 'closed'
            ? 'Closed jobs are read-only.'
            : 'Only a Master can amend a job that is awaiting review.',
      },
    ],
  );
};

/**
 * Whether this person may capture work on THIS job.
 *
 * Two questions, not one. Capturing work at all is a capability
 * (`jobs.captureWork`). Capturing work on a job you are not on is a second one
 * (`jobs.captureAdministratively`), because that is the office writing up what
 * a technician telephoned in — a legitimate thing that a technician must not be
 * able to do to somebody else's job.
 *
 * Enforced here rather than by whichever screen happens to call in: hiding a
 * button is not authorisation.
 */
const assertCanCapture = (context: OperationContext, job: Job): void => {
  if (!can(context.actor.role, 'jobs.captureWork')) {
    throw new WorkflowError(`You cannot capture work on ${job.jobNumber}.`, [
      { code: 'not_permitted', message: 'Your role does not capture work on jobs.' },
    ]);
  }
  if (isJobTechnician(context.actor, job)) return;
  if (can(context.actor.role, 'jobs.captureAdministratively')) return;

  throw new WorkflowError(`${job.jobNumber} is not assigned to you.`, [
    {
      code: 'not_on_job',
      message: 'You can only capture work on a job you are working on.',
    },
  ]);
};

/**
 * The line-item fields that say whose work it is and who wrote it down.
 *
 * Every captured line carries both, so a job card can credit the technician who
 * attended while the audit trail still shows who sat at the keyboard.
 */
const captureAttribution = (
  context: OperationContext,
  job: Job,
): { readonly technicianId: UserId; readonly capturedBy: UserId } => ({
  technicianId: workAttribution(context.actor, job),
  capturedBy: context.actor.id,
});

/** Appended to an audit detail when the office captured somebody else's work. */
const administrativeNote = (context: OperationContext, job: Job): string =>
  isAdministrativeCapture(context.actor, job)
    ? ` Captured administratively by ${userFullName(context.actor)}; the work remains ${
        job.primaryTechnicianId === null ? 'unassigned' : 'the assigned technician\u2019s'
      }.`
    : '';

/**
 * Whether this person may put somebody on a job, and whether that somebody is
 * a field technician at all.
 *
 * Two separate refusals, both needed. Assigning work is the office's
 * (`jobs.assign`). And whoever is assigned has to be a person who goes out to
 * machines (`jobs.acceptField`) — otherwise a Coordinator could be named as
 * the technician on a breakdown, and the job card would print the office as
 * having attended a machine they never saw. She is deliberately barred from
 * ACCEPTING field work; being assigned to it by the back door has to be barred
 * for the same reason.
 *
 * The screens only ever offer technicians. That is convenience, not
 * authorisation: this is what actually refuses the request.
 */
const assertAssignable = async (
  context: OperationContext,
  job: Job,
  technicianId: UserId,
): Promise<void> => {
  if (!can(context.actor.role, 'jobs.assign')) {
    throw new WorkflowError(`${job.jobNumber} cannot be assigned by you.`, [
      { code: 'not_permitted', message: 'Assigning work to a technician is an office function.' },
    ]);
  }

  const target = await context.repos.users.findById(technicianId);
  if (target === null) {
    throw new WorkflowError('That account no longer exists.', [
      { code: 'unknown_user', message: 'Choose a technician who is still on the system.' },
    ]);
  }
  if (!target.active) {
    throw new WorkflowError(`${userFullName(target)} is disabled.`, [
      { code: 'user_inactive', message: 'A disabled account cannot be given work.' },
    ]);
  }
  if (!can(target.role, 'jobs.acceptField')) {
    throw new WorkflowError(`${userFullName(target)} does not carry out field work.`, [
      {
        code: 'not_a_field_technician',
        message: `${roleLabel(target.role)} accounts run the office. A job is assigned to the technician who will attend the machine.`,
      },
    ]);
  }
};

const transition = (job: Job, to: JobStatus): void => {
  if (!canTransition(job.status, to)) {
    throw new WorkflowError(
      `${job.jobNumber} cannot move from ${job.status} to ${to}.`,
      [{ code: 'illegal_transition', message: 'That step is not available from the current status.' }],
    );
  }
};

/**
 * Technician acceptance. Acceptance is what starts the job — there is no
 * separate Start action. The caller is responsible for confirming with the user
 * before calling this.
 */
/**
 * Whether this person may take on this job themselves.
 *
 * A parts collection happens at the counter, so the office processes it. Every
 * other job type is field work: somebody drives to a machine, and the person
 * recorded as having attended has to be the person who attended. A Coordinator
 * runs the office and is deliberately not given `jobs.acceptField`, so she
 * cannot take a breakdown as though she had gone out to it.
 */
export const acceptJobRefusal = (
  actor: Pick<User, 'role'>,
  job: Pick<Job, 'jobType'>,
): string | null => {
  if (job.jobType === 'parts') {
    return can(actor.role, 'jobs.processParts')
      ? null
      : 'You cannot process parts collections.';
  }
  return can(actor.role, 'jobs.acceptField')
    ? null
    : 'Field work is accepted by the technician attending the job. Assign a technician instead.';
};

export const acceptJob = async (context: OperationContext, job: Job): Promise<Job> => {
  const refusal = acceptJobRefusal(context.actor, job);
  if (refusal !== null) {
    throw new WorkflowError(`${job.jobNumber} cannot be accepted by you.`, [
      { code: 'not_field_technician', message: refusal },
    ]);
  }
  transition(job, 'in_progress');

  const now = context.services.clock.now();
  const next: Job = {
    ...job,
    status: 'in_progress',
    acceptedAt: now,
    primaryTechnicianId: job.primaryTechnicianId ?? context.actor.id,
  };

  const saved = await context.repos.jobs.save(next);
  await audit(context, {
    jobId: job.id,
    type: 'job_accepted',
    summary: 'Job accepted',
    detail: `Accepted by ${userFullName(context.actor)}. Acceptance moved the job to In Progress.`,
  });
  return saved;
};

export interface SiteLocationInput {
  readonly site: Site;
  /** Null for a job with no machine, such as a parts collection. */
  readonly machine: Machine | null;
  readonly customerName: string;
  /** Where to send it. Defaults to the acting technician's mobile number. */
  readonly recipientMobile?: string;
}

export interface SiteLocationResult {
  readonly sent: boolean;
  readonly navigationUrl: string;
  /** Set when the send was attempted and failed. The job is unaffected. */
  readonly failureReason: string | null;
}

/**
 * Builds the WhatsApp body for a site location.
 *
 * Kept short on purpose: every WhatsApp message costs money and interrupts a
 * technician who is usually already driving. Job number, customer, machine,
 * site and one link — nothing else.
 */
export const buildSiteLocationMessage = (input: SiteLocationInput, jobNumber: string): string =>
  [
    `${jobNumber} — ${input.customerName}`,
    input.machine === null ? null : `${input.machine.manufacturer} ${input.machine.model}`,
    `${input.site.name}: ${siteAddressLine(input.site)}`,
    siteNavigationUrl(input.site),
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

/**
 * Sends the site location to the technician, on request.
 *
 * Called AFTER acceptance has already succeeded and committed, never as part of
 * it. Any failure is swallowed into the result and recorded on the audit trail:
 * a job that has been accepted stays accepted whatever WhatsApp does.
 */
export const sendSiteLocation = async (
  context: OperationContext,
  job: Job,
  input: SiteLocationInput,
): Promise<SiteLocationResult> => {
  const navigationUrl = siteNavigationUrl(input.site);
  const recipient = input.recipientMobile ?? context.actor.mobile;

  try {
    await context.services.whatsapp.send({
      to: recipient,
      templateName: 'eje_site_location',
      parameters: [
        job.jobNumber,
        input.customerName,
        input.machine === null
          ? input.site.name
          : `${input.machine.manufacturer} ${input.machine.model}`,
        input.site.name,
        navigationUrl,
      ],
      preview: buildSiteLocationMessage(input, job.jobNumber),
    });

    await audit(context, {
      jobId: job.id,
      type: 'site_location_sent',
      summary: 'Site location requested via WhatsApp',
      detail: `${input.site.name} sent to ${userFullName(context.actor)} with a navigation link.`,
    });

    return { sent: true, navigationUrl, failureReason: null };
  } catch (cause: unknown) {
    const failureReason =
      cause instanceof Error ? cause.message : 'The message could not be queued.';

    // Deliberately not rethrown. The job is already accepted and must stay so.
    await audit(context, {
      jobId: job.id,
      type: 'site_location_failed',
      summary: 'Site location could not be sent',
      detail: `${failureReason} The job remains accepted and in progress.`,
    });

    return { sent: false, navigationUrl, failureReason };
  }
};

/** Records that the technician was offered the site location and declined it. */
export const declineSiteLocation = async (
  context: OperationContext,
  job: Job,
): Promise<void> => {
  await audit(context, {
    jobId: job.id,
    type: 'site_location_declined',
    summary: 'Site location not requested',
    detail: `${userFullName(context.actor)} declined the site location. No message was sent.`,
  });
};

/**
 * Refuses to put a technician on a job that clashes with their availability.
 *
 * Every path that can create an assignment goes through here — direct
 * assignment, an additional technician, a transfer, and rescheduling — so the
 * rule cannot be bypassed by using a different screen. The Calendar merely
 * shows what this already decided.
 */
export const assertTechnicianAvailable = async (
  context: OperationContext,
  job: Pick<Job, 'scheduledDate' | 'scheduledEndDate' | 'jobType'>,
  technicianId: UserId,
): Promise<void> => {
  const [records, technician] = await Promise.all([
    context.repos.availability.listForUser(technicianId),
    context.repos.users.findById(technicianId),
  ]);

  const conflicts = findJobAvailabilityConflicts(records, technicianId, job);
  if (conflicts.length === 0) return;

  const name = technician === null ? 'That technician' : userFullName(technician);
  throw new WorkflowError(
    'Technician unavailable',
    conflicts.map((conflict) => ({
      code: 'technician_unavailable',
      message: describeAvailabilityConflict(conflict, name),
    })),
  );
};

export const assignPrimaryTechnician = async (
  context: OperationContext,
  job: Job,
  technicianId: UserId,
  technicianName: string,
): Promise<Job> => {
  assertEditable(context, job);
  await assertAssignable(context, job, technicianId);
  await assertTechnicianAvailable(context, job, technicianId);
  const saved = await context.repos.jobs.save({ ...job, primaryTechnicianId: technicianId });
  await audit(context, {
    jobId: job.id,
    type: 'job_assigned',
    summary: `Job assigned to ${technicianName}`,
    detail: 'Assigned as primary technician.',
  });
  return saved;
};

export const addAdditionalTechnician = async (
  context: OperationContext,
  job: Job,
  technicianId: UserId,
  technicianName: string,
): Promise<Job> => {
  assertEditable(context, job);
  if (job.additionalTechnicianIds.includes(technicianId)) return job;
  await assertAssignable(context, job, technicianId);
  await assertTechnicianAvailable(context, job, technicianId);

  const saved = await context.repos.jobs.save({
    ...job,
    additionalTechnicianIds: [...job.additionalTechnicianIds, technicianId],
  });
  await audit(context, {
    jobId: job.id,
    type: 'technician_added',
    summary: `${technicianName} added to the job`,
    detail: 'Added as an additional technician.',
  });
  return saved;
};

export const removeAdditionalTechnician = async (
  context: OperationContext,
  job: Job,
  technicianId: UserId,
  technicianName: string,
): Promise<Job> => {
  assertEditable(context, job);
  const saved = await context.repos.jobs.save({
    ...job,
    additionalTechnicianIds: job.additionalTechnicianIds.filter((id) => id !== technicianId),
  });
  await audit(context, {
    jobId: job.id,
    type: 'technician_removed',
    summary: `${technicianName} removed from the job`,
    detail: 'Removed as an additional technician.',
  });
  return saved;
};

export interface LabourInput {
  readonly date: string;
  readonly rateType: LabourRateType;
  readonly hours: number;
  readonly description: string;
}

export const addLabour = async (
  context: OperationContext,
  job: Job,
  input: LabourInput,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  const entry = {
    id: asLineItemId(context.services.ids.next('lab')),
    ...captureAttribution(context, job),
    date: input.date,
    rateType: input.rateType,
    hours: input.hours,
    description: input.description,
    capturedAt: context.services.clock.now(),
  };

  const saved = await context.repos.jobs.save({ ...job, labour: [...job.labour, entry] });
  await audit(context, {
    jobId: job.id,
    type: 'labour_added',
    summary: `Labour captured: ${formatHours(input.hours)} ${labourRateLabel(input.rateType).toLowerCase()}`,
    detail:
      (input.description.length > 0 ? input.description : 'No description supplied.') +
      administrativeNote(context, job),
  });
  return saved;
};

export interface TravelInput {
  readonly date: string;
  readonly kilometres: number;
  readonly description: string;
}

export const addTravel = async (
  context: OperationContext,
  job: Job,
  input: TravelInput,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  const entry = {
    id: asLineItemId(context.services.ids.next('trv')),
    ...captureAttribution(context, job),
    date: input.date,
    kilometres: input.kilometres,
    description: input.description,
    capturedAt: context.services.clock.now(),
  };

  const saved = await context.repos.jobs.save({ ...job, travel: [...job.travel, entry] });
  await audit(context, {
    jobId: job.id,
    type: 'travel_added',
    summary: `Travel captured: ${formatKilometres(input.kilometres)}`,
    detail:
      (input.description.length > 0 ? input.description : 'No description supplied.') +
      administrativeNote(context, job),
  });
  return saved;
};

export interface PartInput {
  readonly partNumber: string;
  readonly description: string;
  readonly quantity: number;
  /** Unit price in cents. */
  readonly unitPrice: number;
}

export const addPart = async (
  context: OperationContext,
  job: Job,
  input: PartInput,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  const entry = {
    id: asLineItemId(context.services.ids.next('prt')),
    partNumber: input.partNumber,
    description: input.description,
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    capturedAt: context.services.clock.now(),
    capturedBy: context.actor.id,
  };

  const saved = await context.repos.jobs.save({ ...job, parts: [...job.parts, entry] });
  await audit(context, {
    jobId: job.id,
    type: 'part_added',
    summary: `Part captured: ${input.partNumber}`,
    detail: `${input.description}, quantity ${input.quantity}.` + administrativeNote(context, job),
  });
  return saved;
};

/**
 * Amends an existing labour line.
 *
 * The line keeps its id and its original `capturedAt`, so the audit trail and
 * the pricing snapshot are untouched: an amended line is still priced at the
 * rates frozen when the customer signed.
 */
export const updateLabour = async (
  context: OperationContext,
  job: Job,
  lineId: string,
  input: LabourInput,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);

  const existing = job.labour.find((entry) => entry.id === lineId);
  if (existing === undefined) {
    throw new WorkflowError('That labour line no longer exists on this job.');
  }

  const saved = await context.repos.jobs.save({
    ...job,
    labour: job.labour.map((entry) =>
      entry.id === lineId
        ? {
            ...entry,
            date: input.date,
            rateType: input.rateType,
            hours: input.hours,
            description: input.description,
          }
        : entry,
    ),
  });

  await audit(context, {
    jobId: job.id,
    type: 'labour_added',
    summary: `Labour amended: ${formatHours(input.hours)} ${labourRateLabel(input.rateType).toLowerCase()}`,
    detail: `Was ${formatHours(existing.hours)} ${labourRateLabel(existing.rateType).toLowerCase()}.`,
  });
  await recordPostSignatureChange(context, saved, 'A labour line was amended.');
  return saved;
};

export const updateTravel = async (
  context: OperationContext,
  job: Job,
  lineId: string,
  input: TravelInput,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);

  const existing = job.travel.find((entry) => entry.id === lineId);
  if (existing === undefined) {
    throw new WorkflowError('That travel line no longer exists on this job.');
  }

  const saved = await context.repos.jobs.save({
    ...job,
    travel: job.travel.map((entry) =>
      entry.id === lineId
        ? {
            ...entry,
            date: input.date,
            kilometres: input.kilometres,
            description: input.description,
          }
        : entry,
    ),
  });

  await audit(context, {
    jobId: job.id,
    type: 'travel_added',
    summary: `Travel amended: ${formatKilometres(input.kilometres)}`,
    detail: `Was ${formatKilometres(existing.kilometres)}.`,
  });
  await recordPostSignatureChange(context, saved, 'A travel line was amended.');
  return saved;
};

export const updatePart = async (
  context: OperationContext,
  job: Job,
  lineId: string,
  input: PartInput,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);

  const existing = job.parts.find((entry) => entry.id === lineId);
  if (existing === undefined) {
    throw new WorkflowError('That part line no longer exists on this job.');
  }

  const saved = await context.repos.jobs.save({
    ...job,
    parts: job.parts.map((entry) =>
      entry.id === lineId
        ? {
            ...entry,
            partNumber: input.partNumber,
            description: input.description,
            quantity: input.quantity,
            unitPrice: input.unitPrice,
          }
        : entry,
    ),
  });

  await audit(context, {
    jobId: job.id,
    type: 'part_added',
    summary: `Part amended: ${input.partNumber}`,
    detail: `Was ${existing.partNumber} x${existing.quantity}, now x${input.quantity}.`,
  });
  await recordPostSignatureChange(context, saved, 'A parts line was amended.');
  return saved;
};

export type LineItemKind = 'labour' | 'travel' | 'part';

/** Line removal is always confirmed by the caller before reaching this point. */
export const removeLineItem = async (
  context: OperationContext,
  job: Job,
  kind: LineItemKind,
  lineId: string,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  const next: Job =
    kind === 'labour'
      ? { ...job, labour: job.labour.filter((entry) => entry.id !== lineId) }
      : kind === 'travel'
        ? { ...job, travel: job.travel.filter((entry) => entry.id !== lineId) }
        : { ...job, parts: job.parts.filter((entry) => entry.id !== lineId) };

  return context.repos.jobs.save(next);
};

/**
 * Applies or removes the fixed call-out fee on a job. Whether a call-out is
 * charged is a commercial decision per job, so it is explicit rather than
 * inferred from the job type.
 */
export const setCalloutApplied = async (
  context: OperationContext,
  job: Job,
  applied: boolean,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  if (job.calloutApplied === applied) return job;
  return context.repos.jobs.save({ ...job, calloutApplied: applied });
};

export const addNote = async (
  context: OperationContext,
  job: Job,
  body: string,
  internal: boolean,
): Promise<Job> => {
  assertEditable(context, job);
  const note = {
    id: context.services.ids.next('note'),
    body,
    authorId: context.actor.id,
    createdAt: context.services.clock.now(),
    internal,
  };

  const saved = await context.repos.jobs.save({ ...job, notes: [...job.notes, note] });
  await audit(context, {
    jobId: job.id,
    type: 'note_added',
    summary: internal ? 'Internal note added' : 'Note added',
    detail: body,
  });
  return saved;
};

export interface MediaInput {
  readonly kind: 'photo' | 'video';
  readonly fileName: string;
  readonly caption: string;
  readonly sizeBytes: number;
}

/**
 * Attaches media to a job.
 *
 * DEMO BEHAVIOUR: no file is uploaded. The storage service allocates a key and
 * the UI renders a placeholder tile. The production adapter uploads to object
 * storage and returns the same `Attachment` shape.
 */
export const addMedia = async (
  context: OperationContext,
  job: Job,
  input: MediaInput,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  const stored = await context.services.storage.put(input.fileName, 'image/jpeg', null);

  const attachment: Attachment = {
    id: asAttachmentId(context.services.ids.next('att')),
    kind: input.kind,
    fileName: input.fileName,
    caption: input.caption,
    storageKey: stored.storageKey,
    uploadedAt: context.services.clock.now(),
    uploadedBy: context.actor.id,
    sizeBytes: input.sizeBytes,
  };

  const next: Job =
    input.kind === 'photo'
      ? { ...job, photos: [...job.photos, attachment] }
      : { ...job, videos: [...job.videos, attachment] };

  const saved = await context.repos.jobs.save(next);
  await audit(context, {
    jobId: job.id,
    type: 'photo_uploaded',
    summary: input.kind === 'photo' ? 'Photo uploaded' : 'Video uploaded',
    detail: input.caption.length > 0 ? input.caption : input.fileName,
  });
  return saved;
};

export const moveToAwaitingSpares = async (
  context: OperationContext,
  job: Job,
  reason: string,
): Promise<Job> => {
  assertCanCapture(context, job);
  transition(job, 'awaiting_spares');

  const saved = await context.repos.jobs.save({
    ...job,
    status: 'awaiting_spares',
    awaitingSparesReason: reason,
  });
  await audit(context, {
    jobId: job.id,
    type: 'moved_to_awaiting_spares',
    summary: 'Job moved to Awaiting Spares',
    detail: reason,
  });
  return saved;
};

export const returnToInProgress = async (context: OperationContext, job: Job): Promise<Job> => {
  assertCanCapture(context, job);
  transition(job, 'in_progress');

  const saved = await context.repos.jobs.save({
    ...job,
    status: 'in_progress',
    awaitingSparesReason: '',
  });
  await audit(context, {
    jobId: job.id,
    type: 'returned_to_in_progress',
    summary: 'Job returned to In Progress',
    detail: 'Spares received or the job resumed on site.',
  });
  return saved;
};

export const startCompletion = async (context: OperationContext, job: Job): Promise<Job> => {
  assertCanCapture(context, job);
  transition(job, 'completion');

  const saved = await context.repos.jobs.save({ ...job, status: 'completion' });
  await audit(context, {
    jobId: job.id,
    type: 'completion_started',
    summary: 'Job moved to Completion',
    detail: 'Technician started the completion write-up.',
  });
  return saved;
};

export const saveCompletionReport = async (
  context: OperationContext,
  job: Job,
  report: JobCompletionReport,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);

  const changed = (Object.keys(report) as (keyof JobCompletionReport)[]).filter(
    (field) => report[field] !== job.completionReport[field],
  );
  const saved = await context.repos.jobs.save({ ...job, completionReport: report });

  /*
   * Recorded, because this is the narrative the customer signs for.
   *
   * It was previously saved silently, so the most consequential text on a job
   * card — what was found and what was done — could change with nothing to show
   * who changed it. Writes that alter nothing are not events, so an autosave
   * that re-sends the same text does not fill the trail with noise.
   */
  if (changed.length > 0) {
    await audit(context, {
      jobId: job.id,
      type: 'completion_report_saved',
      summary: 'Completion write-up saved',
      detail: `Updated: ${changed.join(', ')}.` + administrativeNote(context, job),
    });
  }
  return saved;
};

/** Creates an empty checklist instance bound to the current template version. */
export const startChecklist = async (
  context: OperationContext,
  job: Job,
  template: ChecklistTemplate,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  if (job.checklist !== null) return job;

  const responses = template.sections.flatMap((section) =>
    section.items.map((item) => emptyChecklistResponse(item.id)),
  );

  return context.repos.jobs.save({
    ...job,
    checklist: {
      templateId: template.id,
      templateVersion: template.version,
      responses,
      completedAt: null,
      completedBy: null,
    },
  });
};

export interface ChecklistAnswer {
  readonly choice?: PassFailNa | null;
  readonly yesNo?: boolean | null;
  readonly measurement?: number | null;
  readonly text?: string;
  readonly notes?: string;
  readonly photos?: readonly Attachment[];
}

export const answerChecklistItem = async (
  context: OperationContext,
  job: Job,
  itemId: string,
  answer: ChecklistAnswer,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  if (job.checklist === null) {
    throw new WorkflowError('The checklist has not been started for this job.');
  }

  const now = context.services.clock.now();
  const existing = job.checklist.responses.find((response) => response.itemId === itemId);
  const base: ChecklistResponse = existing ?? emptyChecklistResponse(itemId);

  const updated: ChecklistResponse = {
    ...base,
    choice: answer.choice !== undefined ? answer.choice : base.choice,
    yesNo: answer.yesNo !== undefined ? answer.yesNo : base.yesNo,
    measurement: answer.measurement !== undefined ? answer.measurement : base.measurement,
    text: answer.text !== undefined ? answer.text : base.text,
    notes: answer.notes !== undefined ? answer.notes : base.notes,
    photos: answer.photos !== undefined ? answer.photos : base.photos,
    answeredAt: now,
    answeredBy: context.actor.id,
  };

  const responses =
    existing === undefined
      ? [...job.checklist.responses, updated]
      : job.checklist.responses.map((response) =>
          response.itemId === itemId ? updated : response,
        );

  return context.repos.jobs.save({
    ...job,
    checklist: { ...job.checklist, responses, completedAt: null, completedBy: null },
  });
};

export const addChecklistPhoto = async (
  context: OperationContext,
  job: Job,
  itemId: string,
  fileName: string,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  if (job.checklist === null) {
    throw new WorkflowError('The checklist has not been started for this job.');
  }

  const stored = await context.services.storage.put(fileName, 'image/jpeg', null);
  const attachment: Attachment = {
    id: asAttachmentId(context.services.ids.next('att')),
    kind: 'photo',
    fileName,
    caption: 'Checklist evidence',
    storageKey: stored.storageKey,
    uploadedAt: context.services.clock.now(),
    uploadedBy: context.actor.id,
    sizeBytes: 1_650_000,
  };

  const existing = job.checklist.responses.find((response) => response.itemId === itemId);
  const base = existing ?? emptyChecklistResponse(itemId);
  const updated: ChecklistResponse = { ...base, photos: [...base.photos, attachment] };

  const responses =
    existing === undefined
      ? [...job.checklist.responses, updated]
      : job.checklist.responses.map((response) =>
          response.itemId === itemId ? updated : response,
        );

  return context.repos.jobs.save({
    ...job,
    checklist: { ...job.checklist, responses },
  });
};

export const completeChecklist = async (
  context: OperationContext,
  job: Job,
  template: ChecklistTemplate,
): Promise<Job> => {
  assertEditable(context, job);
  assertCanCapture(context, job);
  if (job.checklist === null) {
    throw new WorkflowError('The checklist has not been started for this job.');
  }

  const saved = await context.repos.jobs.save({
    ...job,
    checklist: {
      ...job.checklist,
      completedAt: context.services.clock.now(),
      completedBy: context.actor.id,
    },
  });
  await audit(context, {
    jobId: job.id,
    type: 'checklist_completed',
    summary: 'Checklist completed',
    detail: `${template.name} (${template.version}) completed by ${userFullName(context.actor)}.`,
  });
  return saved;
};

export interface SignatureInput {
  readonly customerName: string;
  readonly customerSurname: string;
  readonly strokeData: string;
}

export const captureSignature = async (
  context: OperationContext,
  job: Job,
  input: SignatureInput,
): Promise<Job> => {
  assertCanCapture(context, job);
  const readiness = checkReadyForSignature(job);
  if (!readiness.allowed) {
    throw new WorkflowError(
      `${job.jobNumber} is not ready for customer signature.`,
      readiness.violations,
    );
  }
  if (job.status !== 'customer_signature') {
    transition(job, 'customer_signature');
  }

  const now = context.services.clock.now();

  // The customer is signing for a figure, so that figure is frozen here. From
  // this point the job prices at its snapshot and a later rate change cannot
  // reach it. An existing snapshot is never overwritten.
  const settings = await context.repos.settings.get();
  const snapshot: PricingSnapshot = job.pricingSnapshot ?? {
    ...pricingInputsFrom(settings),
    capturedAt: now,
    reason: 'customer_signature',
  };

  const saved = await context.repos.jobs.save({
    ...job,
    status: 'review',
    completedAt: job.completedAt ?? now,
    pricingSnapshot: snapshot,
    signature: {
      customerName: input.customerName,
      customerSurname: input.customerSurname,
      strokeData: input.strokeData,
      signedAt: now,
      // Wording comes from the job type: a parts collection acknowledges
      // receipt of goods, not that work was completed.
      declaration: signatureDeclarationFor(job.jobType),
    },
  });

  await audit(context, {
    jobId: job.id,
    type: 'customer_signed',
    summary:
      job.jobType === 'parts'
        ? 'Collector signed for the parts'
        : 'Customer signed the job card',
    detail: `Signed by ${input.customerName} ${input.customerSurname}. Rates frozen at signature.`,
  });
  return saved;
};

/** Moves a job from Completion into the signature step. */
export const startSignature = async (context: OperationContext, job: Job): Promise<Job> => {
  assertCanCapture(context, job);
  const readiness = checkReadyForSignature(job);
  if (!readiness.allowed) {
    throw new WorkflowError(
      `${job.jobNumber} is not ready for customer signature.`,
      readiness.violations,
    );
  }
  transition(job, 'customer_signature');
  return context.repos.jobs.save({ ...job, status: 'customer_signature' });
};

/**
 * The customer-facing document for this job type.
 *
 * A parts collection produces a collection note, not a job card — a different
 * document with a different layout and, for a courier, different content. The
 * choice is made from the job type in one place so no caller can generate the
 * wrong one.
 */
const generateCustomerDocument = (
  context: OperationContext,
  job: Job,
  variant: PdfVariant = 'preview',
) =>
  job.jobType === 'parts'
    ? context.services.pdf.generatePartsNote(job, variant)
    : context.services.pdf.generateJobCard(job, variant);

export const generateJobCardDocument = async (context: OperationContext, job: Job) => {
  const generated = await generateCustomerDocument(context, job);
  await audit(context, {
    jobId: job.id,
    type: 'pdf_generated',
    summary: 'Job card document generated',
    detail: `${generated.fileName} (${generated.pageCount} pages)${generated.simulated ? ' — simulated in demo mode.' : '.'}`,
  });
  return generated;
};

export const recordPostSignatureChange = async (
  context: OperationContext,
  job: Job,
  description: string,
): Promise<void> => {
  if (!isAfterSignature(job.status)) return;

  await audit(context, {
    jobId: job.id,
    type: 'master_amended_after_signature',
    summary: 'Job amended after customer signature',
    detail: `${description} Changed by ${userFullName(context.actor)} during Master review. Rates remain those frozen at signature.`,
  });
};

export interface SubmitResult {
  readonly job: Job;
  readonly documentFileName: string;
  readonly emailedTo: string;
  /**
   * What the provider said about the customer's copy.
   *
   * Callers must report from this rather than from the call having returned.
   * `deliveryMessage` turns it into the words shown on screen.
   */
  readonly delivery: DeliveryRecord;
}

/**
 * Master submission: finalise, issue and close.
 *
 * This is the ONLY point at which the customer is emailed and the final job card
 * document is produced. Everything before it is internal.
 *
 * DEMO BEHAVIOUR: the email is recorded in the simulated outbox, never sent.
 */
/**
 * Issues the job card: generate, store, send, and close ONLY on delivery.
 *
 * This replaces the old two-step hand-over. A technician who has finished the
 * work and taken the customer's signature submits the job card themselves;
 * there is no Master Review in between, because the office was not adding
 * anything to a job it had not attended.
 *
 * The sequence matters, and each step has to have actually happened before the
 * next one is allowed to:
 *
 *   1. Freeze the pricing.
 *   2. Render the final document and WRITE IT TO STORAGE. If storing fails the
 *      job is not issued, because a job card nobody can produce again is not a
 *      job card.
 *   3. Move the job to `awaiting_delivery` and record the document on it. From
 *      here the job is read-only: the customer's copy exists.
 *   4. Hand the mail to the provider and record what the provider SAID.
 *   5. Close only if the provider confirmed delivery.
 *
 * Step 5 will normally not close the job, and that is the point. An accepted
 * send is not a delivered mail — see `DeliveryState`. The job waits in
 * `awaiting_delivery` until a delivery confirmation arrives, and
 * `confirmJobCardDelivery` closes it then.
 */
export const issueJobCard = async (
  context: OperationContext,
  job: Job,
  customerEmail: string,
  customerDisplayName: string,
): Promise<SubmitResult> => {
  if (job.status !== 'review' && job.status !== 'submitted') {
    throw new WorkflowError(`${job.jobNumber} is not ready to be issued.`, [
      {
        code: 'not_ready_to_issue',
        message: 'The work must be completed and the customer signature captured first.',
      },
    ]);
  }
  if (!can(context.actor.role, 'jobs.submit')) {
    throw new WorkflowError(`${job.jobNumber} cannot be issued by you.`, [
      { code: 'not_permitted', message: 'You cannot issue job cards.' },
    ]);
  }

  const readiness = checkReadyForSubmission(job);
  if (!readiness.allowed) {
    throw new WorkflowError(`${job.jobNumber} cannot be issued yet.`, readiness.violations);
  }

  /*
   * Refused BEFORE anything is generated or stored.
   *
   * A job card issued to nowhere cannot be delivered and cannot be retried —
   * the recipient is frozen onto the document — so the job would be locked
   * read-only awaiting a delivery that could never arrive. Checking here, while
   * the job is still editable, means the office adds the contact's address and
   * issues normally.
   */
  if (customerEmail.trim().length === 0) {
    throw new WorkflowError(`${job.jobNumber} has nobody to send the job card to.`, [
      {
        code: 'recipient_required',
        message:
          'No email address is recorded for the contact on this job. Capture one on the customer’s contact, then issue the job card.',
      },
    ]);
  }

  transition(job, 'awaiting_delivery');

  const now = context.services.clock.now();
  const settings = await context.repos.settings.get();
  const snapshot: PricingSnapshot = job.pricingSnapshot ?? {
    ...pricingInputsFrom(settings),
    capturedAt: now,
    reason: 'submission',
  };
  const finalJob: Job = { ...job, pricingSnapshot: snapshot };

  // Produced ONCE, here, and written to storage before the job moves on.
  const document = await generateCustomerDocument(context, finalJob, 'final');
  const view = await loadJobView(context.repos, job.jobNumber);
  if (view === null) {
    throw new WorkflowError(`${job.jobNumber} could not be read for issue.`, []);
  }
  const pageCount = await storeFinalDocument(
    context,
    finalJob,
    {
      storageKey: document.storageKey,
      fileName: document.fileName,
      generatedAt: document.generatedAt,
    },
    {
      job: finalJob,
      customer: view.customer,
      site: view.site,
      contact: view.contact,
      machine: view.machine,
      settings: view.settings,
      checklistTemplate: view.checklistTemplate,
      users: view.users,
    },
  );

  // Requested is not stored. Prove the bytes are readable before issuing.
  const stored = await context.services.storage.getDocument(document.storageKey);
  if (stored === null || stored.bytes.byteLength === 0) {
    throw new WorkflowError(`${job.jobNumber} could not be issued.`, [
      {
        code: 'document_not_stored',
        message: 'The final job card could not be stored, so it was not sent. Try again.',
      },
    ]);
  }

  await audit(context, {
    jobId: job.id,
    type: 'pdf_generated',
    summary: 'Final job card document generated',
    detail: `${document.fileName} (${pageCount} pages)${document.simulated ? ' — simulated in demo mode.' : '.'}`,
  });

  const issued = await context.repos.jobs.save({
    ...finalJob,
    status: 'awaiting_delivery',
    submittedAt: job.submittedAt ?? now,
    completedAt: job.completedAt ?? now,
    finalDocument: {
      fileName: document.fileName,
      storageKey: document.storageKey,
      pageCount,
      generatedAt: document.generatedAt,
      generatedBy: context.actor.id,
      simulated: document.simulated,
      issuedTo: customerEmail,
    },
    delivery: emptyDelivery(customerEmail, now),
  });

  await audit(context, {
    jobId: job.id,
    type: 'job_submitted',
    summary: 'Job card submitted and issued',
    detail: `Submitted by ${userFullName(context.actor)}. The signed job card was generated and sent to ${customerEmail}.`,
  });

  return sendFinalDocument(context, issued, customerDisplayName);
};

/** The subject and body of a customer's copy. One place, so retries match. */
const finalDocumentMail = (job: Job, customerDisplayName: string) => ({
  subject:
    job.jobType === 'parts'
      ? `${job.jobNumber} — ${job.courierCollection ? 'Delivery Note' : 'Parts Collection Note'}`
      : `${job.jobNumber} — Signed Job Card — ${getJobTypeDefinition(job.jobType).label}`,
  body:
    `Good day ${customerDisplayName},\n\n` +
    (job.jobType === 'parts'
      ? `Please find attached the signed collection note for ${job.jobNumber}.\n\n`
      : `Please find attached the signed job card for ${job.jobNumber}.\n\n`) +
    `Kind regards\nEJE Industrial Electronics`,
});

/**
 * Sends the STORED final document and records what the provider said.
 *
 * Used by the first issue and by every retry, so a retry re-sends the document
 * that was issued rather than making a new one — the customer must never
 * receive two different job cards for the same job.
 */
const sendFinalDocument = async (
  context: OperationContext,
  job: Job,
  customerDisplayName: string,
): Promise<SubmitResult> => {
  const document = job.finalDocument;
  if (document === null) {
    throw new WorkflowError(`${job.jobNumber} has no final job card to send.`, []);
  }

  const now = context.services.clock.now();
  const attempts = (job.delivery?.attempts ?? 0) + 1;
  const mail = finalDocumentMail(job, customerDisplayName);

  const sending = await context.repos.jobs.save({
    ...job,
    delivery: {
      ...emptyDelivery(document.issuedTo, now),
      state: 'sending',
      attempts,
    },
  });

  let receipt;
  try {
    receipt = await context.services.email.send({
      to: [document.issuedTo],
      subject: mail.subject,
      body: mail.body,
      attachments: [{ fileName: document.fileName, storageKey: document.storageKey }],
    });
  } catch (error) {
    receipt = {
      messageId: '',
      state: 'failed' as const,
      failureReason: error instanceof Error ? error.message : 'The provider could not be reached.',
      entry: null,
    };
  }

  const delivery: DeliveryRecord = {
    messageId: receipt.messageId,
    state: receipt.state,
    to: document.issuedTo,
    acceptedAt: receipt.state === 'failed' ? null : now,
    confirmedAt: receipt.state === 'delivered' ? now : null,
    updatedAt: now,
    attempts,
    failureReason: receipt.failureReason,
  };

  await audit(context, {
    jobId: job.id,
    type: 'delivery_state_changed',
    summary: `Customer copy ${deliveryStateLabel(delivery.state).toLowerCase()}`,
    detail:
      delivery.state === 'failed'
        ? `Attempt ${attempts} to ${document.issuedTo} failed: ${delivery.failureReason}`
        : `Attempt ${attempts}: the provider accepted ${document.fileName} for ${document.issuedTo}. Delivery is ${deliveryStateLabel(delivery.state).toLowerCase()}.`,
  });

  // Delivered, and only delivered, closes the job.
  const saved =
    delivery.state === 'delivered'
      ? await closeOnDelivery(context, { ...sending, delivery }, now)
      : await context.repos.jobs.save({ ...sending, delivery });

  return {
    job: saved,
    documentFileName: document.fileName,
    emailedTo: document.issuedTo,
    delivery,
  };
};

/** Closes a job whose customer copy has been confirmed delivered. */
const closeOnDelivery = async (
  context: OperationContext,
  job: Job,
  now: string,
): Promise<Job> => {
  const closed = await context.repos.jobs.save({ ...job, status: 'closed', closedAt: now });
  await audit(context, {
    jobId: job.id,
    type: 'job_closed',
    summary: 'Job closed on confirmed delivery',
    detail: `The customer's copy was confirmed delivered to ${job.delivery?.to ?? 'the customer'}, so ${job.jobNumber} is closed.`,
  });
  return closed;
};

/**
 * Asks the provider what became of the customer's copy, and closes on delivery.
 *
 * Called when a screen showing an awaiting-delivery job is opened or refreshed.
 * It reads the provider's state — it never assumes one.
 */
export const confirmJobCardDelivery = async (
  context: OperationContext,
  job: Job,
): Promise<Job> => {
  if (job.status !== 'awaiting_delivery' || job.delivery === null) return job;
  if (job.delivery.messageId.length === 0) return job;

  const receipt = await context.services.email.deliveryState(job.delivery.messageId);
  if (receipt === null || receipt.state === job.delivery.state) return job;

  const now = context.services.clock.now();
  const delivery: DeliveryRecord = {
    ...job.delivery,
    state: receipt.state,
    failureReason: receipt.failureReason,
    confirmedAt: receipt.state === 'delivered' ? now : null,
    updatedAt: now,
  };

  if (receipt.state === 'delivered') {
    return closeOnDelivery(context, { ...job, delivery }, now);
  }

  if (receipt.state === 'failed') {
    await audit(context, {
      jobId: job.id,
      type: 'delivery_state_changed',
      summary: 'Customer copy could not be delivered',
      detail: `${delivery.to} rejected the job card: ${delivery.failureReason} The job stays open.`,
    });
  }
  return context.repos.jobs.save({ ...job, delivery });
};

/**
 * Sends the customer's copy again after a failure, using the stored document.
 *
 * The signature and the job card are not re-captured or re-rendered: a retry is
 * a delivery problem, not a paperwork problem.
 */
export const retryJobCardDelivery = async (
  context: OperationContext,
  job: Job,
  customerDisplayName: string,
): Promise<SubmitResult> => {
  if (job.status !== 'awaiting_delivery') {
    throw new WorkflowError(`${job.jobNumber} is not awaiting delivery.`, []);
  }
  if (!can(context.actor.role, 'jobs.submit')) {
    throw new WorkflowError(`${job.jobNumber} cannot be re-sent by you.`, [
      { code: 'not_permitted', message: 'You cannot issue job cards.' },
    ]);
  }
  return sendFinalDocument(context, job, customerDisplayName);
};

/**
 * Historical Master Review issue.
 *
 * Kept because jobs that entered Master Review before the workflow changed are
 * still sitting there and have to be able to move on. It runs the same issue
 * path, so those jobs get the same document, the same delivery handshake and
 * the same closing rule as everything else.
 */
export const submitJobCard = (
  context: OperationContext,
  job: Job,
  customerEmail: string,
  customerDisplayName: string,
): Promise<SubmitResult> => issueJobCard(context, job, customerEmail, customerDisplayName);

/* -------------------------------------------------------------------------- */
/* Transfer                                                                   */
/* -------------------------------------------------------------------------- */

export interface TransferInput {
  readonly reason: TransferReason;
  readonly description: string;
}

const assertTransferReason = (input: TransferInput): void => {
  if (input.reason === 'other' && input.description.trim().length === 0) {
    throw new WorkflowError('A description is required when the reason is Other.', [
      {
        code: 'description_required',
        message: 'Say what the reason is, so the office knows what happened.',
      },
    ]);
  }
};

const assertTransferable = (context: OperationContext, job: Job): void => {
  const refusal = transferJobRefusal(context.actor, job);
  if (refusal === null) return;
  throw new WorkflowError(refusal, [{ code: 'transfer_not_permitted', message: refusal }]);
};

const transferDetail = (input: TransferInput): string =>
  input.description.trim().length > 0
    ? `${transferReasonLabel(input.reason)}. ${input.description.trim()}`
    : `${transferReasonLabel(input.reason)}.`;

/**
 * Hands a job back to the Open pool.
 *
 * Everything captured so far stays on the job — labour, travel, parts, photos,
 * notes, checklist progress and the whole activity trail. The next technician
 * picks up where this one stopped rather than starting again, which is the
 * entire reason this is a status change and not a new job.
 */
export const returnJobToOpen = async (
  context: OperationContext,
  job: Job,
  input: TransferInput,
): Promise<Job> => {
  assertTransferable(context, job);
  assertTransferReason(input);

  const previousTechnician = job.primaryTechnicianId;
  const previousName =
    previousTechnician === null
      ? 'The technician'
      : userFullName((await context.repos.users.findById(previousTechnician)) ?? context.actor);

  transition(job, 'open');

  const saved = await context.repos.jobs.save({
    ...job,
    status: 'open',
    primaryTechnicianId: null,
    // Acceptance is cleared because the job genuinely is unaccepted again; the
    // work already captured against it is untouched.
    acceptedAt: null,
  });

  await audit(context, {
    jobId: job.id,
    type: 'job_transferred_to_open',
    summary: `${previousName} transferred ${job.jobNumber} to Open Jobs`,
    detail: `${transferDetail(input)} All work already recorded remains on the job. The scheduled date is unchanged.`,
  });

  return saved;
};

/**
 * Hands a job to a named technician.
 *
 * Refused when the receiving technician is unavailable for the job's scheduled
 * period — passing a job to someone who cannot attend it solves nothing.
 */
export const transferJobToTechnician = async (
  context: OperationContext,
  job: Job,
  technicianId: UserId,
  input: TransferInput,
): Promise<Job> => {
  assertTransferable(context, job);
  assertTransferReason(input);

  if (technicianId === job.primaryTechnicianId) {
    throw new WorkflowError('That technician already has this job.', [
      { code: 'same_technician', message: 'Choose a different technician.' },
    ]);
  }

  const receiving = await context.repos.users.findById(technicianId);
  if (receiving === null || !receiving.active) {
    throw new WorkflowError('That technician is not available to take jobs.', [
      { code: 'user_inactive', message: 'The account is disabled.' },
    ]);
  }
  // A transfer hands the field work on, so the receiver has to be someone who
  // does field work — the same rule as an assignment.
  if (!can(receiving.role, 'jobs.acceptField')) {
    throw new WorkflowError(`${userFullName(receiving)} does not carry out field work.`, [
      {
        code: 'not_a_field_technician',
        message: `${roleLabel(receiving.role)} accounts run the office. Transfer the job to the technician who will attend the machine.`,
      },
    ]);
  }

  await assertTechnicianAvailable(context, job, technicianId);

  const previousName =
    job.primaryTechnicianId === null
      ? 'The office'
      : userFullName((await context.repos.users.findById(job.primaryTechnicianId)) ?? context.actor);

  const saved = await context.repos.jobs.save({
    ...job,
    primaryTechnicianId: technicianId,
    // The receiving technician is now responsible; they no longer appear as an
    // additional hand on their own job.
    additionalTechnicianIds: job.additionalTechnicianIds.filter((id) => id !== technicianId),
  });

  await audit(context, {
    jobId: job.id,
    type: 'job_transferred_to_technician',
    summary: `${previousName} transferred ${job.jobNumber} to ${userFullName(receiving)}`,
    detail: `${transferDetail(input)} All existing job work remains available to ${receiving.firstName}.`,
  });

  await notify(context, {
    recipientId: technicianId,
    type: 'job_transferred',
    title: `${job.jobNumber} transferred to you`,
    body: `${previousName} has handed you ${job.jobNumber}. Reason: ${transferReasonLabel(input.reason)}.`,
    jobId: job.id,
  });

  return saved;
};

/* -------------------------------------------------------------------------- */
/* Cancel and delete                                                          */
/* -------------------------------------------------------------------------- */

export interface CancellationInput {
  readonly reason: CancellationReason;
  readonly description: string;
}

/**
 * Cancels a legitimate job that will not happen.
 *
 * The job keeps everything it recorded and stays searchable; it simply leaves
 * the active workflow. This is the honest counterpart to deletion: the request
 * was real, the work will not happen, and six months from now the office can
 * still answer why.
 */
export const cancelJob = async (
  context: OperationContext,
  job: Job,
  input: CancellationInput,
): Promise<Job> => {
  const refusal = cancelJobRefusal(context.actor.role, job.status);
  if (refusal !== null) {
    throw new WorkflowError(refusal, [{ code: 'cancel_not_permitted', message: refusal }]);
  }
  if (input.reason === 'other' && input.description.trim().length === 0) {
    throw new WorkflowError('A description is required when the reason is Other.', [
      { code: 'description_required', message: 'Say why the job is being cancelled.' },
    ]);
  }

  transition(job, 'cancelled');
  const now = context.services.clock.now();

  const saved = await context.repos.jobs.save({
    ...job,
    status: 'cancelled',
    cancellation: {
      reason: input.reason,
      description: input.description.trim(),
      cancelledBy: context.actor.id,
      cancelledAt: now,
    },
  });

  await audit(context, {
    jobId: job.id,
    type: 'job_cancelled',
    summary: `${job.jobNumber} cancelled`,
    detail: `${cancellationReasonLabel(input.reason)}.${
      input.description.trim().length > 0 ? ` ${input.description.trim()}` : ''
    } Cancelled by ${userFullName(context.actor)}. The job keeps its record and stays searchable.`,
  });

  return saved;
};

/**
 * Soft-deletes a job created by mistake.
 *
 * Soft, not hard: the record and its audit trail survive, so "where did
 * EJE-1065 go?" has an answer. Refused once a technician has accepted the job —
 * at that point there is real work attached and cancelling is the right action.
 */
export const deleteJob = async (
  context: OperationContext,
  job: Job,
  reason: string,
): Promise<Job> => {
  const refusal = deleteJobRefusal(context.actor.role, job);
  if (refusal !== null) {
    throw new WorkflowError(refusal, [{ code: 'delete_not_permitted', message: refusal }]);
  }

  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new WorkflowError('A reason is required.', [
      { code: 'reason_required', message: 'Say why this job should not exist.' },
    ]);
  }

  const saved = await context.repos.jobs.save({
    ...job,
    deletedAt: context.services.clock.now(),
    deletedBy: context.actor.id,
    deletionReason: trimmed,
  });

  await audit(context, {
    jobId: job.id,
    type: 'job_deleted',
    summary: `${job.jobNumber} deleted`,
    detail: `${trimmed} Deleted by ${userFullName(context.actor)}. The record and this trail are retained.`,
  });

  return saved;
};

/**
 * Changes a job's scheduled dates.
 *
 * Re-checks every assigned technician against their availability, because
 * moving a job is just as capable of creating a clash as moving a person.
 */
export const rescheduleJob = async (
  context: OperationContext,
  job: Job,
  scheduledDate: string | null,
  scheduledEndDate: string | null,
): Promise<Job> => {
  assertEditable(context, job);

  const next: Job = { ...job, scheduledDate, scheduledEndDate };
  const violations = checkSchedule(job.jobType, scheduledDate, scheduledEndDate);
  if (violations.length > 0) {
    throw new WorkflowError(`${job.jobNumber} cannot be scheduled that way.`, violations);
  }

  const assigned = [next.primaryTechnicianId, ...next.additionalTechnicianIds].filter(
    (id): id is UserId => id !== null,
  );
  for (const technicianId of assigned) {
    await assertTechnicianAvailable(context, next, technicianId);
  }

  const saved = await context.repos.jobs.save(next);
  await audit(context, {
    jobId: job.id,
    type: 'job_assigned',
    summary: `${job.jobNumber} rescheduled`,
    detail:
      scheduledDate === null
        ? 'The scheduled date was cleared.'
        : `Now scheduled for ${scheduledDate}${
            scheduledEndDate === null || scheduledEndDate === scheduledDate
              ? ''
              : ` to ${scheduledEndDate}`
          }.`,
  });
  return saved;
};
