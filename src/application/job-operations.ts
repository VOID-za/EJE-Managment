import {
  asAttachmentId,
  asLineItemId,
  canTransition,
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
  isAfterSignature,
  transferJobRefusal,
  transferReasonLabel,
  canEditJob,
  labourRateLabel,
  siteAddressLine,
  siteNavigationUrl,
  pricingInputsFrom,
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
  type UserId,
} from '@/domain';
import { formatHours, formatKilometres } from '@/lib/format';
import type { OperationContext } from './context';
import { audit, notify } from './audit';
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
export const acceptJob = async (context: OperationContext, job: Job): Promise<Job> => {
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
  const entry = {
    id: asLineItemId(context.services.ids.next('lab')),
    technicianId: context.actor.id,
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
    detail: input.description.length > 0 ? input.description : 'No description supplied.',
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
  const entry = {
    id: asLineItemId(context.services.ids.next('trv')),
    technicianId: context.actor.id,
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
    detail: input.description.length > 0 ? input.description : 'No description supplied.',
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
  const entry = {
    id: asLineItemId(context.services.ids.next('prt')),
    partNumber: input.partNumber,
    description: input.description,
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    capturedAt: context.services.clock.now(),
  };

  const saved = await context.repos.jobs.save({ ...job, parts: [...job.parts, entry] });
  await audit(context, {
    jobId: job.id,
    type: 'part_added',
    summary: `Part captured: ${input.partNumber}`,
    detail: `${input.description}, quantity ${input.quantity}.`,
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
  return context.repos.jobs.save({ ...job, completionReport: report });
};

/** Creates an empty checklist instance bound to the current template version. */
export const startChecklist = async (
  context: OperationContext,
  job: Job,
  template: ChecklistTemplate,
): Promise<Job> => {
  assertEditable(context, job);
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
const generateCustomerDocument = (context: OperationContext, job: Job) =>
  job.jobType === 'parts'
    ? context.services.pdf.generatePartsNote(job)
    : context.services.pdf.generateJobCard(job);

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

/**
 * Submits and closes the job.
 *
 * DEMO BEHAVIOUR: the customer email is recorded in the simulated outbox. No
 * message is transmitted.
 */
/**
 * Technician hand-over: submit the signed job card for Master review.
 *
 * Deliberately does NOT email the customer and does NOT finalise the customer
 * document. The office reviews and corrects the job card first; the customer
 * only ever sees what a Master has approved.
 */
export const submitForMasterReview = async (
  context: OperationContext,
  job: Job,
): Promise<Job> => {
  const readiness = checkReadyForSubmission(job);
  if (!readiness.allowed) {
    throw new WorkflowError(
      `${job.jobNumber} cannot be submitted for review yet.`,
      readiness.violations,
    );
  }
  transition(job, 'submitted');

  const now = context.services.clock.now();

  // Backstop only: signature should already have frozen the rates.
  const settings = await context.repos.settings.get();
  const snapshot: PricingSnapshot = job.pricingSnapshot ?? {
    ...pricingInputsFrom(settings),
    capturedAt: now,
    reason: 'submission',
  };

  const saved = await context.repos.jobs.save({
    ...job,
    status: 'submitted',
    pricingSnapshot: snapshot,
    submittedAt: now,
    completedAt: job.completedAt ?? now,
  });

  await audit(context, {
    jobId: job.id,
    type: 'job_submitted',
    summary: 'Submitted for Master review',
    detail: `${userFullName(context.actor)} handed the signed job card to the office. The customer has not been emailed.`,
  });

  return saved;
};

/**
 * Records that a Master changed the job after the customer signed.
 *
 * The rates are frozen by the pricing snapshot, so a correction is priced at
 * exactly what the customer saw — but the TOTAL can still move if a Master adds
 * or removes work. That is a real commercial event, so it is written to the
 * trail rather than happening quietly.
 */
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
}

/**
 * Master submission: finalise, issue and close.
 *
 * This is the ONLY point at which the customer is emailed and the final job card
 * document is produced. Everything before it is internal.
 *
 * DEMO BEHAVIOUR: the email is recorded in the simulated outbox, never sent.
 */
export const submitJobCard = async (
  context: OperationContext,
  job: Job,
  customerEmail: string,
  customerDisplayName: string,
): Promise<SubmitResult> => {
  if (job.status !== 'submitted') {
    throw new WorkflowError(
      `${job.jobNumber} must be in Master review before it can be issued to the customer.`,
      [
        {
          code: 'not_in_master_review',
          message: 'Only a job submitted by a technician can be issued.',
        },
      ],
    );
  }

  const readiness = checkReadyForSubmission(job);
  if (!readiness.allowed) {
    throw new WorkflowError(`${job.jobNumber} cannot be issued yet.`, readiness.violations);
  }
  transition(job, 'closed');

  const now = context.services.clock.now();
  const settings = await context.repos.settings.get();
  const snapshot: PricingSnapshot = job.pricingSnapshot ?? {
    ...pricingInputsFrom(settings),
    capturedAt: now,
    reason: 'submission',
  };

  const finalJob: Job = { ...job, pricingSnapshot: snapshot };

  // The final document is generated here, from the job as the Master approved it.
  const document = await generateCustomerDocument(context, finalJob);

  const closed = await context.repos.jobs.save({
    ...finalJob,
    status: 'closed',
    closedAt: now,
    submittedAt: job.submittedAt ?? now,
    completedAt: job.completedAt ?? now,
  });

  await audit(context, {
    jobId: job.id,
    type: 'pdf_generated',
    summary: 'Final job card document generated',
    detail: `${document.fileName} (${document.pageCount} pages)${document.simulated ? ' — simulated in demo mode.' : '.'}`,
  });

  await context.services.email.send({
    to: [customerEmail],
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
    attachments: [{ fileName: document.fileName, storageKey: document.storageKey }],
  });

  await audit(context, {
    jobId: job.id,
    type: 'job_closed',
    summary: 'Job card issued and closed',
    detail: `Approved by ${userFullName(context.actor)} and queued for delivery to ${customerEmail}.`,
  });

  return {
    job: closed,
    documentFileName: document.fileName,
    emailedTo: customerEmail,
  };
};

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
