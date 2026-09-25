import 'server-only';
import { z } from 'zod';
import {
  asContactId,
  asCustomerId,
  asJobId,
  asMachineId,
  asSiteId,
  asUserId,
  can,
  canSeeJob,
  getJobTypeDefinition,
  redactRefusalsForViewer,
  technicianHistoryFrom,
  userFullName,
  type Job,
  type User,
} from '@/domain';
import * as jobs from '@/application/job-operations';
import { createJob } from '@/application/job-creation';
import { notFound } from '../errors';
import { command, type CommandContext, type CommandRegistry, type ErasedCommand } from './types';

/**
 * Everything the API can do to a job.
 *
 * The pattern is the same in every entry and it is the point of the file:
 *
 *   load the job by id → check the actor may see it → hand the REAL record to
 *   the application operation → let the operation's own rules refuse or proceed
 *
 * The visibility check at the boundary decides whether the job exists as far as
 * this actor is concerned; the operation decides whether they may do this to
 * it. Neither is re-implemented here, and no route writes a repository.
 */

/**
 * The job, if this actor may see it at all.
 *
 * A job they may not see is NOT FOUND, never refused — refusing confirms it
 * exists. The record handed on is the real one, not a redacted copy: rules have
 * to be enforced against the truth, and `assertEditable` cannot reason about a
 * job whose prices have been blanked.
 */
export const loadVisibleJob = async (context: CommandContext, target: string): Promise<Job> => {
  // The URL may carry either the id or the number a person reads. Both resolve
  // to the same job, and neither is a secret — the visibility check below is
  // what decides whether this actor may know it exists.
  const job =
    (await context.repos.jobs.findById(asJobId(target))) ??
    (await context.repos.jobs.findByJobNumber(target));
  if (job === null) throw notFound('That job does not exist.');

  if (!can(context.actor.role, 'jobs.viewAll')) {
    const participated = await context.repos.jobs.listParticipatedJobs(context.actor.id);
    if (!canSeeJob(context.actor, job, technicianHistoryFrom(participated))) {
      throw notFound('That job does not exist.');
    }
  }
  return job;
};

/** What a job command answers with: the job, as this viewer may read it. */
const respond = (job: Job, viewer: User): Job => redactRefusalsForViewer(job, viewer);

/** A command that needs nothing but the job. */
const simple = (run: (context: CommandContext, job: Job) => Promise<Job>): ErasedCommand =>
  command({
    schema: z.object({}).strict(),
    async run(context, _input, target) {
      const job = await loadVisibleJob(context, target);
      return respond(await run(context, job), context.actor);
    },
  });

/** A command with a body. */
const withInput = <T>(
  schema: z.ZodType<T>,
  run: (context: CommandContext, job: Job, input: T) => Promise<unknown>,
): ErasedCommand =>
  command({
    schema,
    async run(context, input, target) {
      const job = await loadVisibleJob(context, target);
      const result = await run(context, job, input);
      // A `Job` comes back redacted for its reader; anything else — a removal
      // outcome, a delivery result — is already a plain answer.
      return result !== null && typeof result === 'object' && 'jobNumber' in result
        ? respond(result as Job, context.actor)
        : result;
    },
  });

const userId = z.string().uuid().or(z.string().min(1).max(100));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a calendar date.');
const text = (max: number) => z.string().max(max);

/** Resolves the technician a command names, so the operation gets their name too. */
const technician = async (context: CommandContext, id: string) => {
  const found = await context.repos.users.findById(asUserId(id));
  if (found === null) throw notFound('That technician does not exist.');
  return found;
};

/**
 * Who the customer's copy goes to.
 *
 * The contact named on the job, with the customer's name as the display
 * fallback when the contact record has gone. The ADDRESS has no fallback at
 * all — an empty one reaches `issueJobCard`, which refuses and says whose
 * address is missing, which is the problem the office actually has to fix.
 */
const resolveRecipient = async (
  context: CommandContext,
  job: Job,
): Promise<{ email: string; displayName: string }> => {
  const [contact, customer] = await Promise.all([
    context.repos.customers.findContactById(job.contactId),
    context.repos.customers.findById(job.customerId),
  ]);
  return {
    email: contact?.email.trim() ?? '',
    displayName:
      contact === null || contact === undefined
        ? (customer?.name ?? 'the customer')
        : `${contact.firstName} ${contact.lastName}`,
  };
};

/** The template a job's checklist is answered against, resolved from the job. */
const checklistTemplate = async (context: CommandContext, job: Job) => {
  const template =
    job.checklist === null
      ? await context.repos.checklistTemplates.findForJobType(job.jobType)
      : await context.repos.checklistTemplates.findByVersion(
          job.checklist.templateId,
          job.checklist.templateVersion,
        );
  if (template === null) throw notFound('That checklist is no longer held.');
  return template;
};

export const JOB_COMMANDS: CommandRegistry = {
  accept: simple((context, job) => jobs.acceptJob(context.operation, job)),

  /**
   * The site-location offer.
   *
   * The site, the machine and the customer name are resolved HERE from the job
   * rather than sent by the client. They are facts about the job; letting a
   * request supply them would let it send a technician to an address of its
   * choosing under EJE's name.
   */
  send_site_location: withInput(
    z.object({ recipientMobile: text(40).optional() }).strict(),
    async (context, job, input) => {
      const [site, machine, customer] = await Promise.all([
        context.repos.customers.findSiteById(job.siteId),
        job.machineId === null
          ? Promise.resolve(null)
          : context.repos.machines.findById(job.machineId),
        context.repos.customers.findById(job.customerId),
      ]);
      if (site === null || customer === null) throw notFound('That job does not exist.');

      return jobs.sendSiteLocation(context.operation, job, {
        site,
        machine,
        customerName: customer.name,
        ...(input.recipientMobile === undefined ? {} : { recipientMobile: input.recipientMobile }),
      });
    },
  ),

  decline_site_location: simple(async (context, job) => {
    await jobs.declineSiteLocation(context.operation, job);
    return job;
  }),

  assign_primary: withInput(
    z.object({ technicianId: userId }).strict(),
    async (context, job, input) => {
      const person = await technician(context, input.technicianId);
      return jobs.assignPrimaryTechnician(
        context.operation,
        job,
        person.id,
        userFullName(person),
      );
    },
  ),

  add_technician: withInput(
    z.object({ technicianId: userId }).strict(),
    async (context, job, input) => {
      const person = await technician(context, input.technicianId);
      return jobs.addAdditionalTechnician(context.operation, job, person.id, userFullName(person));
    },
  ),

  remove_technician: withInput(
    z.object({ technicianId: userId }).strict(),
    async (context, job, input) => {
      const person = await technician(context, input.technicianId);
      return jobs.removeAdditionalTechnician(
        context.operation,
        job,
        person.id,
        userFullName(person),
      );
    },
  ),

  add_labour: withInput(
    z
      .object({
        date: isoDate,
        rateType: z.enum(['normal', 'overtime', 'double']),
        hours: z.number().positive().max(24),
        description: text(500),
      })
      .strict(),
    (context, job, input) => jobs.addLabour(context.operation, job, input),
  ),

  update_labour: withInput(
    z
      .object({
        lineId: z.string().min(1).max(100),
        date: isoDate,
        rateType: z.enum(['normal', 'overtime', 'double']),
        hours: z.number().positive().max(24),
        description: text(500),
      })
      .strict(),
    (context, job, { lineId, ...input }) =>
      jobs.updateLabour(context.operation, job, lineId, input),
  ),

  add_travel: withInput(
    z
      .object({
        date: isoDate,
        kilometres: z.number().positive().max(10_000),
        description: text(500),
      })
      .strict(),
    (context, job, input) => jobs.addTravel(context.operation, job, input),
  ),

  update_travel: withInput(
    z
      .object({
        lineId: z.string().min(1).max(100),
        date: isoDate,
        kilometres: z.number().positive().max(10_000),
        description: text(500),
      })
      .strict(),
    (context, job, { lineId, ...input }) =>
      jobs.updateTravel(context.operation, job, lineId, input),
  ),

  add_part: withInput(
    z
      .object({
        partNumber: text(120),
        description: text(500),
        quantity: z.number().int().positive().max(10_000),
        // Cents, as an integer. A price with a fraction of a cent on it is a
        // bug somewhere upstream, and the job card has to add up exactly.
        unitPrice: z.number().int().nonnegative().max(1_000_000_000),
      })
      .strict(),
    (context, job, input) => jobs.addPart(context.operation, job, input),
  ),

  update_part: withInput(
    z
      .object({
        lineId: z.string().min(1).max(100),
        partNumber: text(120),
        description: text(500),
        quantity: z.number().int().positive().max(10_000),
        unitPrice: z.number().int().nonnegative().max(1_000_000_000),
      })
      .strict(),
    (context, job, { lineId, ...input }) => jobs.updatePart(context.operation, job, lineId, input),
  ),

  remove_line: withInput(
    z
      .object({
        kind: z.enum(['labour', 'travel', 'part']),
        lineId: z.string().min(1).max(100),
      })
      .strict(),
    (context, job, input) =>
      jobs.removeLineItem(context.operation, job, input.kind, input.lineId),
  ),

  set_callout: withInput(
    z.object({ applied: z.boolean() }).strict(),
    (context, job, input) => jobs.setCalloutApplied(context.operation, job, input.applied),
  ),

  add_note: withInput(
    z.object({ body: z.string().min(1).max(4000), internal: z.boolean() }).strict(),
    (context, job, input) => jobs.addNote(context.operation, job, input.body, input.internal),
  ),

  /**
   * Attaching media.
   *
   * METADATA ONLY. No bytes cross this endpoint: production file storage is its
   * own phase, and a JSON body is the wrong place for a photograph. The record
   * carries the name, the caption and the size in exactly the shape the future
   * uploader will produce.
   */
  add_media: withInput(
    z
      .object({
        kind: z.enum(['photo', 'video']),
        fileName: text(260),
        caption: text(500),
        sizeBytes: z.number().int().nonnegative().max(2_000_000_000),
      })
      .strict(),
    (context, job, input) => jobs.addMedia(context.operation, job, input),
  ),

  remove_media: withInput(
    z
      .object({
        kind: z.enum(['photo', 'video']),
        attachmentId: z.string().min(1).max(100),
      })
      .strict(),
    (context, job, input) =>
      jobs.removeMedia(context.operation, job, input.kind, input.attachmentId),
  ),

  awaiting_spares: withInput(
    z.object({ reason: z.string().min(1).max(1000) }).strict(),
    (context, job, input) => jobs.moveToAwaitingSpares(context.operation, job, input.reason),
  ),

  return_to_progress: simple((context, job) => jobs.returnToInProgress(context.operation, job)),
  start_completion: simple((context, job) => jobs.startCompletion(context.operation, job)),

  save_report: withInput(
    z
      .object({
        faultFindings: text(8000),
        diagnosis: text(8000),
        workPerformed: text(8000),
        recommendations: text(8000),
        generalNotes: text(8000),
      })
      .strict(),
    (context, job, input) => jobs.saveCompletionReport(context.operation, job, input),
  ),

  start_checklist: simple(async (context, job) =>
    jobs.startChecklist(context.operation, job, await checklistTemplate(context, job)),
  ),

  answer_checklist: withInput(
    z
      .object({
        itemId: z.string().min(1).max(100),
        choice: z.enum(['pass', 'fail', 'na']).nullable().optional(),
        yesNo: z.boolean().nullable().optional(),
        measurement: z.number().nullable().optional(),
        text: text(4000).optional(),
        notes: text(4000).optional(),
      })
      .strict(),
    (context, job, { itemId, ...answer }) =>
      jobs.answerChecklistItem(context.operation, job, itemId, answer),
  ),

  add_checklist_photo: withInput(
    z.object({ itemId: z.string().min(1).max(100), fileName: text(260) }).strict(),
    (context, job, input) =>
      jobs.addChecklistPhoto(context.operation, job, input.itemId, input.fileName),
  ),

  complete_checklist: simple(async (context, job) =>
    jobs.completeChecklist(context.operation, job, await checklistTemplate(context, job)),
  ),

  set_collection: withInput(
    z.object({ courier: z.boolean(), waybillNumber: text(120) }).strict(),
    (context, job, input) => jobs.setCollectionMethod(context.operation, job, input),
  ),

  start_signature: simple((context, job) => jobs.startSignature(context.operation, job)),

  capture_signature: withInput(
    z
      .object({
        customerName: z.string().min(1).max(120),
        customerSurname: z.string().min(1).max(120),
        // The signature is a stroke path, not an image. Generous but bounded:
        // a signature that needs more than this is not a signature.
        strokeData: z.string().min(1).max(200_000),
      })
      .strict(),
    (context, job, input) => jobs.captureSignature(context.operation, job, input),
  ),

  record_refusal: withInput(
    z.object({ reason: z.string().min(1).max(2000) }).strict(),
    (context, job, input) => jobs.recordSignatureRefusal(context.operation, job, input),
  ),

  resolve_refusal: withInput(
    z.object({ note: text(2000) }).strict(),
    (context, job, input) => jobs.resolveSignatureRefusal(context.operation, job, input.note),
  ),

  return_for_signature: withInput(
    z.object({ note: text(2000) }).strict(),
    (context, job, input) => jobs.returnToCustomerSignature(context.operation, job, input.note),
  ),

  /**
   * The document descriptor for the preview header.
   *
   * Returns what was generated rather than the job: the screen needs the file
   * name and the page count, and the job is unchanged by producing a preview.
   */
  generate_document: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const job = await loadVisibleJob(context, target);
      return jobs.generateJobCardDocument(context.operation, job);
    },
  }),

  /**
   * Issuing the customer's copy.
   *
   * The ADDRESS IS RESOLVED FROM THE JOB'S CONTACT, here, and never sent by the
   * client. DECISION 4 says the job card goes to the named contact and that
   * there is no fallback; a request that could name its own recipient would be
   * a way to have EJE email a customer's signed job card to anybody.
   */
  issue: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const job = await loadVisibleJob(context, target);
      const recipient = await resolveRecipient(context, job);
      return jobs.issueJobCard(
        context.operation,
        job,
        recipient.email,
        recipient.displayName,
      );
    },
  }),

  confirm_delivery: simple((context, job) => jobs.confirmJobCardDelivery(context.operation, job)),

  /**
   * The CR-08 rescue: the office submits a signed job card whose technician
   * cannot. Authorised entirely in the operation, which reads the availability
   * register itself — the browser sends nothing but the job.
   */
  take_over_submission: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const job = await loadVisibleJob(context, target);
      const recipient = await resolveRecipient(context, job);
      return jobs.takeOverSubmission(
        context.operation,
        job,
        recipient.email,
        recipient.displayName,
      );
    },
  }),

  retry_delivery: command({
    schema: z.object({}).strict(),
    async run(context, _input: Record<string, never>, target) {
      const job = await loadVisibleJob(context, target);
      const recipient = await resolveRecipient(context, job);
      return jobs.retryJobCardDelivery(context.operation, job, recipient.displayName);
    },
  }),

  transfer_to_open: withInput(
    z
      .object({
        reason: z.enum([
          'unable_to_attend',
          'sick_or_unavailable',
          'vehicle_problem',
          'scheduling_conflict',
          'requires_another_technician',
          'customer_requested',
          'other',
        ]),
        description: text(2000),
      })
      .strict(),
    (context, job, input) => jobs.returnJobToOpen(context.operation, job, input),
  ),

  transfer_to_technician: withInput(
    z
      .object({
        technicianId: userId,
        reason: z.enum([
          'unable_to_attend',
          'sick_or_unavailable',
          'vehicle_problem',
          'scheduling_conflict',
          'requires_another_technician',
          'customer_requested',
          'other',
        ]),
        description: text(2000),
      })
      .strict(),
    (context, job, { technicianId, ...input }) =>
      jobs.transferJobToTechnician(context.operation, job, asUserId(technicianId), input),
  ),

  cancel: withInput(
    z
      .object({
        reason: z.enum([
          'customer_resolved',
          'customer_cancelled',
          'duplicate',
          'no_longer_required',
          'customer_unavailable',
          'other',
        ]),
        description: text(2000),
      })
      .strict(),
    (context, job, input) => jobs.cancelJob(context.operation, job, input),
  ),

  /**
   * Permanent deletion.
   *
   * THERE IS NO ENDPOINT THAT READS A DELETED JOB, and this one answers with
   * nothing but an acknowledgement — there is no record left to return. The
   * audit event outlives it; `deleteJob` writes that before it destroys
   * anything.
   */
  delete: withInput(
    z.object({ reason: z.string().min(1).max(2000) }).strict(),
    async (context, job, input) => {
      await jobs.deleteJob(context.operation, job, input.reason);
      return { deleted: true };
    },
  ),

  reschedule: withInput(
    z
      .object({
        scheduledDate: isoDate.nullable(),
        scheduledEndDate: isoDate.nullable(),
      })
      .strict(),
    (context, job, input) =>
      jobs.rescheduleJob(context.operation, job, input.scheduledDate, input.scheduledEndDate),
  ),
};

/**
 * Raising a job.
 *
 * Not in the registry above, because it has no job to load — it is a POST to
 * the collection rather than an action on a member.
 */
export const createJobSchema = z
  .object({
    customerId: z.string().min(1).max(100),
    siteId: z.string().min(1).max(100),
    contactId: z.string().min(1).max(100),
    machineId: z.string().min(1).max(100).nullable(),
    jobType: z.enum(['breakdown', 'installation', 'service', 'parts', 'test_and_repair']),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
    scheduledDate: isoDate.nullable(),
    scheduledEndDate: isoDate.nullable(),
    orderNumber: text(120),
    referenceNumber: text(120),
    /*
     * Required here as well as in the operation.
     *
     * Not duplication for its own sake: a blank body is a MALFORMED request and
     * answers 400, while the operation's refusal is a business rule and answers
     * 422 with a violation the screen renders. Both are true, and a client that
     * omits the field entirely should be told so in the terms of the protocol.
     */
    faultDescription: z.string().trim().min(1).max(8000),
    primaryTechnicianId: userId.nullable(),
    /** Assistants. Bounded because a van holds a crew, not a department. */
    additionalTechnicianIds: z.array(userId).max(8).default([]),
    courierCollection: z.boolean(),
    deliveryNote: text(120),
    /*
     * NO ATTACHMENTS HERE, deliberately.
     *
     * A document is bytes, and this request carries none. Accepting a list of
     * file names would record attachments pointing at nothing — which is the
     * fiction durable storage exists to end. The office raises the job and then
     * attaches to it through `POST /api/jobs/:id/attachments`, which stores the
     * bytes before it records the row. A client that still sends `attachments`
     * is refused by `.strict()` rather than quietly ignored.
     */
  })
  .strict();

export type CreateJobInput = z.infer<typeof createJobSchema>;

export const runCreateJob = async (
  context: CommandContext,
  input: CreateJobInput,
): Promise<Job> => {
  // Proves the code is one the business actually has, before anything is built.
  getJobTypeDefinition(input.jobType);

  const created = await createJob(context.operation, {
    ...input,
    customerId: asCustomerId(input.customerId),
    siteId: asSiteId(input.siteId),
    contactId: asContactId(input.contactId),
    machineId: input.machineId === null ? null : asMachineId(input.machineId),
    primaryTechnicianId:
      input.primaryTechnicianId === null ? null : asUserId(input.primaryTechnicianId),
    additionalTechnicianIds: input.additionalTechnicianIds.map(asUserId),
  });
  return respond(created, context.actor);
};
