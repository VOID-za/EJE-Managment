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
  isJobTechnician,
  redactRefusalsForViewer,
  technicianHistoryFrom,
  userFullName,
  type Job,
  type User,
} from '@/domain';
import * as jobs from '@/application/job-operations';
import * as corrections from '@/application/job-corrections';
import * as unsigned from '@/application/unsigned-delivery';
import { WorkflowError } from '@/application/errors';
import { createJob } from '@/application/job-creation';
import { forbidden, notFound } from '../errors';
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

/**
 * THE FIELD-LOCATION PROMPT IS FOR THE FIELD. CR-03, MASTER SCOPE §3.3.
 *
 * Two questions, both of them about this actor on THIS job: do they carry out
 * field work at all (`jobs.acceptField` — a Coordinator runs the office and
 * does not attend machines), and are they on the job's crew? Neither is asked
 * by the dialog that offers the prompt, because a dialog is not authorisation:
 * the route is reachable by anybody who can see the job, and the message is
 * sent under EJE's WhatsApp account at EJE's cost.
 *
 * A Master is refused for the same reason a Coordinator is. They have the
 * site address on the screen in front of them; what they do not have is a
 * reason for EJE to send themselves a navigation link from a technician's
 * acceptance prompt.
 */
const assertFieldTechnicianOnJob = (
  context: CommandContext,
  job: Job,
  what: string,
): void => {
  if (can(context.actor.role, 'jobs.acceptField') && isJobTechnician(context.actor, job)) return;
  throw forbidden(`You cannot ${what} ${job.jobNumber}.`, [
    {
      code: 'not_field_technician',
      message: can(context.actor.role, 'jobs.acceptField')
        ? 'Only a technician working on the job can ask for its site location.'
        : 'The site location is sent to the technician attending the machine, not to the office.',
    },
  ]);
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
  /*
   * THE DESTINATION IS NOT IN THE REQUEST, and `recipientMobile` is gone.
   *
   * It used to be an optional field on this body, which made this route a way
   * to send an EJE-branded WhatsApp template to any number somebody chose, at
   * EJE's cost and under EJE's name. No screen ever sent it. The message now
   * goes to the actor's own mobile, read from their account by the operation.
   */
  send_site_location: withInput(z.object({}).strict(), async (context, job) => {
    assertFieldTechnicianOnJob(context, job, 'ask for the site location of');

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
    });
  }),

  decline_site_location: simple(async (context, job) => {
    assertFieldTechnicianOnJob(context, job, 'decline the site location of');
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

  /*
   * `add_media` USED TO BE HERE, and it is deliberately gone. PWA-3.
   *
   * It took a file name, a caption and a size in a JSON body, recorded an
   * attachment row and stored nothing — so the job card listed photographs that
   * did not exist. A photograph now arrives as multipart bytes at
   * `POST /api/jobs/:jobId/media`, which sniffs them, stores them and only then
   * records the row. There is no JSON path to a photograph any more, because a
   * JSON path to a photograph is a path to a photograph that is not there.
   */

  /**
   * Reclassifying a photograph after it was taken. MEDIA-1.
   *
   * Its own action rather than a general media edit: this is the ONE thing about
   * a captured photograph that may change, and naming it means the authorisation
   * and the immutability rule are stated about that one thing instead of about
   * "editing media".
   */
  set_media_visibility: withInput(
    z
      .object({
        attachmentId: z.string().min(1).max(100),
        visibility: z.enum(['customer_facing', 'internal']),
      })
      .strict(),
    (context, job, input) =>
      jobs.setMediaVisibility(context.operation, job, input.attachmentId, input.visibility),
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

  /**
   * Putting a job on hold for a part. SPARE-2.
   *
   * `description` is what the field was called `reason` for; it is what somebody
   * has to order. `notes` and `photoId` are optional, and the REQUEST DATE is
   * deliberately not in this schema — it is stamped from the server's clock, so
   * a client cannot claim a job has been waiting since last month.
   */
  awaiting_spares: withInput(
    z
      .object({
        description: text(1000),
        notes: text(2000).optional(),
        photoId: z.string().min(1).max(100).nullable().optional(),
      })
      .strict(),
    (context, job, input) => jobs.moveToAwaitingSpares(context.operation, job, input),
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

  /**
   * One checklist answer. ONLINE, OR HELD ON A TABLET. OFF-CHK-1.
   *
   * The last three fields are the expectation a held capture carries — the
   * checklist instance it was answered on, and the answer it is replacing.
   * They are optional because an online screen has nothing to expect: see
   * `ChecklistExpectation`, which is where the rule is written. A tablet that
   * sends them gets a refusal rather than overwriting somebody else's answer
   * or being moved onto a different version of the document.
   */
  answer_checklist: withInput(
    z
      .object({
        itemId: z.string().min(1).max(100),
        choice: z.enum(['pass', 'fail', 'na']).nullable().optional(),
        yesNo: z.boolean().nullable().optional(),
        measurement: z.number().nullable().optional(),
        text: text(4000).optional(),
        notes: text(4000).optional(),
        templateId: z.string().min(1).max(100).optional(),
        templateVersion: z.string().min(1).max(40).optional(),
        expectedAnsweredAt: z.string().min(10).max(40).nullable().optional(),
      })
      .strict(),
    (
      context,
      job,
      { itemId, templateId, templateVersion, expectedAnsweredAt, ...answer },
    ) => {
      /*
       * AN ANSWER THAT TRAVELLED AS A CAPTURE MUST SAY WHAT IT WAS ANSWERING.
       * OFF-CHK-1, CR-02.
       *
       * The expectation is optional because a SCREEN has nothing to expect: the
       * runner writes one field at a time as the technician taps, and there is
       * no interval in which anybody could be overwritten. A CAPTURE is the
       * opposite — it may have been written minutes or hours before it reaches
       * the server — and optional meant the conflict rule could be got round by
       * omission: a capture that simply left the three fields out was applied
       * as though it were a tap made this second, silently replacing whatever
       * the office had answered while the tablet was away. An older build or a
       * queue row written before the fields existed does that by accident.
       *
       * THE RULE IS NARROW ON PURPOSE: it applies to the CAPTURE transport
       * (`X-EJE-Capture`, which only `sendCaptured` sends) and to nothing else.
       *
       * WHY HALF AN EXPECTATION IS NOT REFUSED ELSEWHERE. Dropping the stamp
       * while keeping the version looks like tampering and gains nothing: a
       * screen may answer with NO expectation at all, which is weaker still, so
       * the version check that remains is stricter than the baseline rather
       * than a way round it. The office's own resolution of a referred capture
       * does exactly this on purpose — it keeps the version check and replaces
       * the answer deliberately (BD-15) — and refusing that shape broke it,
       * which its own test caught.
       *
       * WHAT THIS DOES NOT CLAIM. A request with no expectation and no capture
       * header is treated as a tap, which is the established last-write-wins
       * rule for online answers. The server cannot tell a hand-made request
       * from a screen, and inventing a refusal there would break the runner
       * rather than protect anybody.
       *
       * Refused rather than defaulted: guessing `expectedAnsweredAt: null`
       * would turn every incomplete capture into "I believed nobody had
       * answered this", which is the overwrite this exists to prevent.
       */
      const held = context.capturedWrite === true;
      const partial =
        templateId === undefined || templateVersion === undefined || expectedAnsweredAt === undefined;
      if (held && partial) {
        throw new WorkflowError(
          `A held checklist answer for ${job.jobNumber} did not say what it was answering.`,
          [
            {
              code: 'checklist_expectation_required',
              message:
                'A capture must carry the checklist version it was answered against and the ' +
                'answer it is replacing, so it cannot overwrite one given since. Capture it ' +
                'again on this screen.',
            },
          ],
        );
      }

      return jobs.answerChecklistItem(context.operation, job, itemId, answer, {
        ...(templateId === undefined ? {} : { templateId }),
        ...(templateVersion === undefined ? {} : { templateVersion }),
        ...(expectedAnsweredAt === undefined ? {} : { expectedAnsweredAt }),
      });
    },
  ),

  /*
   * `add_checklist_photo` USED TO BE HERE, and it is gone for the same reason
   * `add_media` is. CHK-EVIDENCE-1.
   *
   * It took an item id and a file NAME, stored nothing, and recorded evidence
   * with a hard-coded size against a question that gates the checklist's
   * completion. Evidence now arrives as multipart bytes at
   * `POST /api/jobs/:jobId/checklist/:itemId/photo`.
   */

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

  /* -- correcting a job card EJE have already issued. BD-02, IMMUT-9. ----- */

  /**
   * A Master raises a correction. Nothing about the original changes.
   *
   * `areas` is validated as a non-empty set of strings here and parsed into
   * the domain's closed vocabulary by the operation — the schema's job is to
   * refuse a body that is the wrong SHAPE, and the operation's is to decide
   * what the values mean.
   */
  raise_correction: withInput(
    z
      .object({
        reason: text(2000),
        narrative: text(8000),
        areas: z.array(z.string().min(1).max(60)).min(1).max(12),
        acknowledgementRequired: z.boolean(),
      })
      .strict(),
    (context, job, input) =>
      corrections.raiseJobCorrection(context.operation, job, {
        reason: input.reason,
        narrative: input.narrative,
        areas: input.areas,
        acknowledgementRequired: input.acknowledgementRequired,
      }),
  ),

  /**
   * The office records that the customer acknowledged a correction.
   *
   * The correction id comes in the BODY rather than the path because this is a
   * job action, and the operation checks that the correction belongs to a job
   * this actor may see — a `loadVisibleJob` on the path has already decided
   * that much.
   */
  acknowledge_correction: withInput(
    z
      .object({
        correctionId: z.string().min(1).max(100),
        acknowledgedBy: text(200),
        method: text(200),
        note: z.string().max(2000).default(''),
      })
      .strict(),
    async (context, job, input) => {
      const correction = await context.repos.jobs.findCorrectionById(input.correctionId);
      // A correction on another job is NOT FOUND, never refused: refusing
      // would confirm that it exists somewhere else.
      if (correction === null || correction.jobId !== job.id) {
        throw notFound('That correction does not exist.');
      }
      return corrections.recordCorrectionAcknowledgement(context.operation, input.correctionId, {
        acknowledgedBy: input.acknowledgedBy,
        method: input.method,
        note: input.note,
      });
    },
  ),

  /* -- sending a job card the customer did not sign. BD-06, DELIV-7. ------ */

  /** A Master authorises it, with a reason, and it is sent. */
  authorise_unsigned_delivery: withInput(
    z.object({ reason: text(2000) }).strict(),
    (context, job, input) =>
      unsigned.authoriseUnsignedDelivery(context.operation, job, { reason: input.reason }),
  ),

  /** A retry of a failed send. No second authorisation; see the operation. */
  retry_unsigned_delivery: withInput(z.object({}).strict(), (context, job) =>
    unsigned.retryUnsignedDelivery(context.operation, job),
  ),

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
     * PRESENT, BUT NOT NECESSARILY FILLED IN. CR-13.
     *
     * It used to be `.min(1)` here as well as in the operation — a blank body
     * was a MALFORMED request answering 400, while the operation's refusal was
     * a business rule answering 422. That stopped being one rule when the job
     * types diverged: a field job still must say what the work is, and a parts
     * collection has no such field at all. A rule that is true of some job
     * types and not others belongs where the job type is known, so the length
     * is now checked once, in `createJob`, and the protocol only says this is
     * a string of sane length.
     */
    faultDescription: z.string().trim().max(8000),
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
