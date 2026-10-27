import {
  asJobId,
  can,
  contactFullName,
  dateReceivedProblem,
  emptyCompletionReport,
  getJobTypeDefinition,
  machineDisplayName,
  roleLabel,
  userFullName,
  type Contact,
  type ContactId,
  type Customer,
  type CustomerId,
  type Job,
  emptyRepairItem,
  type JobPriority,
  type RepairItem,
  type JobTypeCode,
  type Machine,
  type MachineId,
  type Site,
  type SiteId,
  type SystemSettings,
  type UserId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
import {
  assignmentDetails,
  notifyAssignment,
  type AssignmentOccasion,
} from './assignment-notice';
import { WorkflowError } from './errors';

/**
 * Raising a job.
 *
 * This was being done by the New Job screen writing a Job straight into the
 * repository. That put the only authorisation check — "can this role create
 * jobs?" — in a component's render path, which is not authorisation at all: it
 * decides what to draw, not what the system will accept. It also meant the
 * technician on a new job was never validated, so the office could be named as
 * the technician on a breakdown.
 *
 * Both rules live here now, where every caller meets them, and where the
 * Phase 2 REST handler will meet them too.
 */
export interface NewJobInput {
  readonly customerId: CustomerId;
  readonly siteId: SiteId;
  readonly machineId: MachineId | null;
  readonly jobType: JobTypeCode;
  /**
   * How urgent, or null where the office has not graded it yet.
   *
   * Optional on the two types the owner named, and the form sends null rather
   * than a pre-selected value on those — see `JobTypeDefinition.
   * requiresPriority`.
   */
  readonly priority: JobPriority | null;
  readonly scheduledDate: string | null;
  readonly scheduledEndDate: string | null;
  readonly orderNumber: string;
  readonly referenceNumber: string;
  /**
   * What was booked in, where the job type takes one. Test & Repair §4.
   *
   * OPTIONAL ON THE INPUT, because the fields themselves are optional and the
   * job types that do not capture them have nothing to send. A caller that
   * omits it is not thereby saying something different from one that sends an
   * empty item — so there is no reason to make every call site spell it out.
   */
  readonly repairItem?: RepairItem;
  /** The customer's quote reference, where the job type takes one. */
  readonly quoteNumber?: string;
  /**
   * The day the unit arrived on the counter, where the job type books one in.
   * Optional, and cleared on a type that does not capture a repair item.
   */
  readonly dateReceived?: string | null;
  readonly faultDescription: string;
  /**
   * Who the customer's copy of the job card goes to.
   *
   * Chosen by the office when the job is raised, never picked for them: a
   * customer with four contacts has a reason for which one receives paperwork,
   * and defaulting to "the first one" puts a job card in the wrong inbox.
   * Validated against the customer's own contact list — see `resolveRegister`.
   */
  readonly contactId: ContactId;
  readonly primaryTechnicianId: UserId | null;
  /**
   * Technicians attending WITH the primary. Empty for most jobs.
   *
   * Held to the same eligibility rule as the primary, and refused outright
   * without one: assistants assist somebody.
   */
  readonly additionalTechnicianIds: readonly UserId[];
  readonly courierCollection: boolean;
  /** The customer's own delivery note reference. Optional, and often blank. */
  readonly deliveryNote: string;
}

/**
 * The next job number, from whoever can allocate one safely.
 *
 * A repository that offers `allocateJobNumber` does it atomically — a
 * PostgreSQL sequence — and has already consumed the value by the time this
 * returns, so nothing afterwards may write the counter back: a settings save
 * that moved the allocator would hand the same number out twice, or skip one.
 * That is what `atomic` says.
 *
 * The demonstration store has no concurrency to protect against and allocates
 * from its settings snapshot, so it still increments. Two Masters raising a job
 * in the same moment is a production problem, and production is where the
 * sequence is.
 */
const allocateJobNumber = async (
  context: OperationContext,
  settings: SystemSettings,
): Promise<{ readonly jobNumber: string; readonly atomic: boolean }> => {
  const repository = context.repos.jobs;
  if (repository.allocateJobNumber === undefined) {
    return { jobNumber: `${settings.jobNumberPrefix}${settings.nextJobSequence}`, atomic: false };
  }
  const allocated = await repository.allocateJobNumber();
  return { jobNumber: allocated.jobNumber, atomic: true };
};

/**
 * The customer, the site, the machine and the recipient — as the REGISTER has
 * them, not as the request describes them.
 *
 * WHY THIS EXISTS. Every one of these arrived as an id in a JSON body, and
 * until now nothing checked that they belonged together. A request could raise
 * a job against ABC Engineering at a Kruger site, on a machine standing at a
 * third customer, addressed to a fourth customer's contact — and the job card
 * that went out would carry that. Selecting from a dropdown is not a
 * constraint; the dropdown is drawn by the client.
 *
 * Each check returns the RESOLVED record, so the caller works from the
 * authoritative row rather than from what was sent.
 *
 * ARCHIVED SITES AND CONTACTS ARE STILL REFUSED. A withdrawn site resolves for
 * a historical job card that has to keep reading correctly, but a NEW job may
 * not be raised against one, so this reads the live register.
 */
interface ResolvedRegister {
  readonly customer: Customer;
  readonly site: Site;
  readonly contact: Contact;
  readonly machine: Machine | null;
}

/** Returns the error rather than throwing it, so `throw refuse(...)` narrows. */
const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

/** Exactly the four ids this reads, so a caller cannot pass a cast. DRAFT-1. */
type RegisterInput = Pick<NewJobInput, 'customerId' | 'siteId' | 'contactId' | 'machineId'>;

const resolveRegister = async (
  context: OperationContext,
  input: RegisterInput,
): Promise<ResolvedRegister> => {
  const customer = await context.repos.customers.findById(input.customerId);
  if (customer === null) {
    throw refuse('That customer is not on the register.', 'unknown_customer', 'Choose a customer from the register.');
  }
  if (!customer.active) {
    throw refuse(`${customer.name} is not an active account.`, 'customer_inactive',
      'Work cannot be raised against a withdrawn customer account.');
  }

  const site = await context.repos.customers.findSiteById(input.siteId);
  if (site === null || site.archivedAt !== null) {
    throw refuse('That site is not on the register.', 'unknown_site', 'Choose one of the customer’s sites.');
  }
  if (site.customerId !== customer.id) {
    // The case that matters: both ids are real, and they are not related.
    throw refuse(`${site.name} is not one of ${customer.name}’s sites.`, 'site_not_of_customer',
      'A job is raised at a site belonging to the customer it is raised against.');
  }

  const contact = await context.repos.customers.findContactById(input.contactId);
  if (contact === null || contact.archivedAt !== null) {
    throw refuse('That contact is not on the register.', 'unknown_contact',
      'Choose who at the customer receives the job card.');
  }
  if (contact.customerId !== customer.id) {
    throw refuse(`${contactFullName(contact)} is not one of ${customer.name}’s contacts.`,
      'contact_not_of_customer',
      'The customer’s copy goes to a contact at that customer, and nobody else.');
  }
  /*
   * A site contact must be at THIS site; a head-office contact (`siteId: null`)
   * covers every site the customer has, which is how EJE's smaller customers
   * are set up.
   */
  if (contact.siteId !== null && contact.siteId !== site.id) {
    throw refuse(`${contactFullName(contact)} is not a contact at ${site.name}.`, 'contact_not_of_site',
      'Choose a contact at that site, or the customer’s head office contact.');
  }

  if (input.machineId === null) return { customer, site, contact, machine: null };

  const machine = await context.repos.machines.findById(input.machineId);
  if (machine === null || machine.archivedAt !== null) {
    throw refuse('That machine is not on the register.', 'unknown_machine',
      'Choose a machine standing at the site.');
  }
  if (machine.customerId !== customer.id) {
    throw refuse(`${machineDisplayName(machine)} does not belong to ${customer.name}.`,
      'machine_not_of_customer',
      'A job is raised against a machine belonging to that customer.');
  }
  if (machine.siteId !== site.id) {
    throw refuse(`${machineDisplayName(machine)} does not stand at ${site.name}.`, 'machine_not_at_site',
      'Choose a machine at the site the technician is being sent to.');
  }

  return { customer, site, contact, machine };
};

/**
 * Everybody who will be on this job, checked before any of them is recorded.
 *
 * The primary and the additional technicians are held to the SAME rule, for the
 * same reason `assignPrimaryTechnician` holds a later assignment to it: a job
 * is done by somebody who attends machines. Checked as a set, so the refusal
 * happens before the job exists rather than leaving a job half-assigned.
 */
/** Exactly the five fields this reads. See `RegisterInput`. */
type TechnicianInput = Pick<
  NewJobInput,
  'jobType' | 'primaryTechnicianId' | 'additionalTechnicianIds' | 'scheduledDate' | 'scheduledEndDate'
>;

const resolveTechnicians = async (
  context: OperationContext,
  input: TechnicianInput,
): Promise<{ primaryId: UserId | null; additionalIds: readonly UserId[] }> => {
  const eligible = async (id: UserId): Promise<void> => {
    const person = await context.repos.users.findById(id);
    if (person === null || !person.active) {
      throw new WorkflowError('That technician is not available to take jobs.', [
        { code: 'user_inactive', message: 'Choose a technician who is still working here.' },
      ]);
    }
    if (!can(person.role, 'jobs.acceptField')) {
      throw new WorkflowError(`${userFullName(person)} does not carry out field work.`, [
        {
          code: 'not_a_field_technician',
          message: `${roleLabel(person.role)} accounts run the office. A job is assigned to the technician who will attend the machine.`,
        },
      ]);
    }
  };

  if (input.primaryTechnicianId !== null) await eligible(input.primaryTechnicianId);

  const additionalIds: UserId[] = [];
  for (const id of input.additionalTechnicianIds) {
    // Naming somebody twice, or naming the primary as their own assistant, is
    // a client mistake rather than a refusal worth stopping the office over.
    if (id === input.primaryTechnicianId || additionalIds.includes(id)) continue;
    await eligible(id);
    additionalIds.push(id);
  }

  if (input.primaryTechnicianId === null && additionalIds.length > 0) {
    throw new WorkflowError('A job cannot have assistants without a technician.', [
      {
        code: 'additional_without_primary',
        message: 'Assign the technician who will attend the machine before adding anybody with them.',
      },
    ]);
  }

  return { primaryId: input.primaryTechnicianId, additionalIds };
};

/**
 * WHAT THE WORK IS, WHERE THE JOB TYPE NEEDS IT SAID. Test & Repair §4.
 *
 * `requiresFaultDescription` rather than `!officeProcessed`: a TEST & REPAIR
 * unit is booked in at the counter before anybody has diagnosed it, and what
 * is recorded at that moment is the unit (`capturesRepairItem`). A breakdown,
 * an installation and a service each send a technician somewhere, and still
 * have to say what for.
 *
 * Exported so a details edit (JOB-EDIT-1) is held to THIS rule rather than a
 * copy of it: emptying a breakdown's description after it was raised is the
 * same refusal as raising it empty.
 */
export const assertFaultDescribed = (
  definition: ReturnType<typeof getJobTypeDefinition>,
  faultDescription: string,
): void => {
  if (definition.requiresFaultDescription && faultDescription.trim().length === 0) {
    throw new WorkflowError('A job needs to say what the work is.', [
      {
        code: 'fault_description_required',
        message:
          'Describe the fault or the work required. It is what the technician is sent out on, and it is printed on the customer’s job card.',
      },
    ]);
  }
};

/**
 * The two facts a job must carry before anybody can be sent to do it. DRAFT-1.
 *
 * Extracted so `createJob` and `releaseDraft` are held to the SAME rule rather
 * than to two copies of it. That matters more here than it usually does: the
 * whole of DRAFT-1 is "these may be blank for now", and the only thing that
 * makes that safe is that releasing re-asks the identical question.
 */
const assertReadyForWork = (
  definition: ReturnType<typeof getJobTypeDefinition>,
  job: {
    readonly faultDescription: string;
    readonly machineId: MachineId | null;
    readonly priority: JobPriority | null;
  },
): void => {
  assertFaultDescribed(definition, job.faultDescription);

  /*
   * A MACHINE, WHERE THE JOB TYPE NEEDS ONE. Create New Job §3A / §4.
   *
   * This used to read `definition.capturesLabourAndTravel` — "this type charges
   * hours, so it must be work on a machine" — which was an inference rather
   * than a rule, and the owner has separated the two. `requiresMachine` says it
   * directly, and it is false for a breakdown (called in before anybody knows
   * which machine) and for a test-and-repair unit (which may not be on the
   * register at all). An installation and a service still require one.
   *
   * Nothing is invented where it is optional: no machine is fabricated and the
   * job is not attached to an arbitrary one to fill the column.
   */
  if (definition.requiresMachine && job.machineId === null) {
    throw new WorkflowError('A machine is required for this job type.', [
      {
        code: 'machine_required',
        message: `A ${definition.label.toLowerCase()} job is work on a machine, so it has to say which.`,
      },
    ]);
  }

  /*
   * AND A PRIORITY, WHERE THE JOB TYPE NEEDS ONE. Create New Job §3B / §4.
   *
   * Required on an installation and a service, which are planned work the
   * office grades when it books them. Not required on a breakdown or a
   * test-and-repair job, where it stays null until somebody says — see
   * `Job.priority` for why null rather than a default.
   */
  if (definition.requiresPriority && job.priority === null) {
    throw new WorkflowError('A priority is required for this job type.', [
      {
        code: 'priority_required',
        message: `A ${definition.label.toLowerCase()} is planned work, so it has to say how urgent it is.`,
      },
    ]);
  }
};

/**
 * RAISING A JOB, OR DRAFTING ONE. DRAFT-1.
 *
 * `asDraft` changes exactly three things and nothing else:
 *
 *   1. the two checks in `assertReadyForWork` are not applied YET — the fault
 *      description and the machine may be blank, because they are what the
 *      technician or the customer still has to tell the office;
 *   2. the status is `draft` rather than `open` (or `completion`);
 *   3. nobody is NOTIFIED. A draft may name the technician the Master has in
 *      mind, and telling them about a job that may never be raised is worse
 *      than telling them late.
 *
 * WHAT IS NOT RELAXED: the customer, the site and the contact are resolved
 * against the register exactly as they always were, because a draft addressed
 * to nobody is not a draft of a job card — and the job number IS allocated,
 * because a draft is a job that was raised. Abandoning one cancels it, which is
 * the record a cancelled job already leaves. **That is the shipped
 * recommendation; see `docs/SCOPE.md` DRAFT-1 and issue #21 for the
 * alternative, which is a separate draft sequence.**
 */
export interface CreateJobOptions {
  readonly asDraft?: boolean;
}

export const createJob = async (
  context: OperationContext,
  input: NewJobInput,
  options: CreateJobOptions = {},
): Promise<Job> => {
  const asDraft = options.asDraft === true;
  if (asDraft && !can(context.actor.role, 'jobs.manageDrafts')) {
    throw new WorkflowError('A draft job card is a Master’s.', [
      {
        code: 'not_permitted',
        message:
          'Only a Master drafts a job. Raise it as an open job, or ask a Master to draft it.',
      },
    ]);
  }

  if (!can(context.actor.role, 'jobs.create')) {
    throw new WorkflowError('A job can only be raised by the office.', [
      {
        code: 'not_permitted',
        message: 'Ask the office to raise a job card for you.',
      },
    ]);
  }

  /*
   * AN OFFICE-PROCESSED JOB IS RAISED TO NOBODY. CR-12.
   *
   * Checked before the technicians are resolved, so a parts collection that
   * names one is refused rather than quietly stripped: a client sending a
   * technician on a collection is a client still driving the field-service
   * form, and it should be told.
   */
  const definition = getJobTypeDefinition(input.jobType);
  if (
    definition.officeProcessed &&
    (input.primaryTechnicianId !== null || input.additionalTechnicianIds.length > 0)
  ) {
    throw new WorkflowError(`A ${definition.label.toLowerCase()} collection has no technician.`, [
      {
        code: 'not_applicable_to_job_type',
        message:
          'A parts collection is handed over at the counter by the office. It is not assigned to anybody.',
      },
    ]);
  }

  // Assigning at creation is the same act as assigning afterwards, so it is
  // held to the same rule: work goes to somebody who attends machines.
  const { primaryId, additionalIds } = await resolveTechnicians(context, input);

  /*
   * The register, checked before anything is written.
   *
   * Deliberately before the job number is allocated: a refusal here must not
   * burn a number off the sequence, because EJE's job numbers are a continuous
   * commercial record and a gap in them is a question somebody has to answer.
   */
  const { customer, site, contact, machine } = await resolveRegister(context, input);

  /*
   * WHAT THE JOB IS ABOUT — ON THE JOB TYPES THAT HAVE SUCH A THING. CR-13.
   *
   * A field job is raised on a description: it is what the technician is sent
   * out on and it is printed on the customer's job card, so it is required and
   * always has been. A parts collection is not raised on anything of the sort —
   * the goods listed on it are the record — so it does not collect one and it
   * does not keep one a request happens to carry. The document omits the
   * section entirely rather than printing a heading over nothing.
   */
  const faultDescription = definition.officeProcessed ? '' : input.faultDescription.trim();

  /*
   * DRAFT-1. A DRAFT IS NOT HELD TO THESE TWO, AND NOTHING ELSE IS RELAXED.
   *
   * These are the facts the TECHNICIAN supplies the answer to — what the work
   * is, and which machine — and a Master drafting a job before the customer has
   * telephoned back does not have them yet. `releaseDraft` runs exactly this
   * function against the stored job, so a draft cannot become a real job
   * without satisfying them: the validation is DEFERRED, never weakened.
   */
  if (!asDraft) {
    assertReadyForWork(definition, {
      faultDescription,
      machineId: input.machineId,
      // A parts collection carries no priority at all, so the readiness check
      // is handed the value creation will actually write rather than the one
      // the request sent — see the `priority` field below.
      priority: definition.officeProcessed ? null : input.priority,
    });
  }

  /*
   * DATE RECEIVED: a real day, not in the future — when it is given at all.
   * Before the job number is allocated, for the same reason as the register
   * check above: a refusal must not burn a number off the sequence.
   */
  const dateReceived = definition.capturesRepairItem ? (input.dateReceived ?? null) : null;
  const dateProblem = dateReceivedProblem(dateReceived, context.services.clock.now());
  if (dateProblem !== null) {
    throw new WorkflowError('The date received is not a date that can be recorded.', [
      { code: 'date_received_invalid', message: dateProblem },
    ]);
  }

  const settings = await context.repos.settings.get();
  const allocated = await allocateJobNumber(context, settings);
  const now = context.services.clock.now();

  const job: Job = {
    id: asJobId(context.services.ids.next('job')),
    jobNumber: allocated.jobNumber,
    /*
     * The RESOLVED ids, not the submitted ones.
     *
     * They are the same values — `resolveRegister` looked them up — but taking
     * them off the register record is what makes that true rather than
     * assumed, and it is the shape the next reader should copy.
     */
    customerId: customer.id,
    siteId: site.id,
    contactId: contact.id,
    machineId: machine === null ? null : machine.id,
    jobType: input.jobType,
    /*
     * A COLLECTION IS NOT PRIORITISED OR SCHEDULED. CR-12.
     *
     * Both describe when a technician is sent somewhere. The counter serves
     * whoever is standing at it, so the job type's own default is recorded and
     * the date stays empty — whatever the request said. Forced here rather
     * than trusted from the client, because this is the rule and the form is
     * only its reflection.
     */
    /*
     * A PARTS COLLECTION HAS NO PRIORITY AT ALL, and now says so.
     *
     * It used to be written as the type's `defaultPriority` — "normal" — on a
     * job that has no urgency to express: `officeProcessed` turns the field off
     * entirely, because a collection is a counter transaction and not a visit
     * somebody is dispatched to. That default was invisible, and it put a
     * grading on the Jobs list for a job nobody could have graded.
     *
     * Null is the truthful value, and it is now a value the column can hold.
     */
    priority: definition.officeProcessed ? null : input.priority,
    /*
     * OFFICE-PROCESSED JOBS OPEN IN THEIR OWN CLOSE-OUT. CR-12.
     *
     * Not `open`, because the open pool is where field work waits to be
     * accepted and a collection is never accepted by anybody. `completion` is
     * the existing stage whose next legal move is the customer signature —
     * which is exactly what a collection does next — so the workflow needs no
     * new status and no new transition: the job is raised at the step the
     * person raising it is about to work through.
     *
     * `acceptedAt` stays null, deliberately. Nobody accepted it; saying
     * somebody did would put a fact in the record that never happened.
     */
    /*
     * DRAFT-1. A draft sits at `draft`, whose only moves are `open` and
     * `cancelled` — both already in the state machine, so no new transition
     * and no new terminal state were invented for this.
     */
    status: asDraft ? 'draft' : definition.officeProcessed ? 'completion' : 'open',
    scheduledDate: definition.officeProcessed ? null : input.scheduledDate,
    scheduledEndDate: definition.schedulesDateRange ? input.scheduledEndDate : null,
    orderNumber: input.orderNumber.trim(),
    referenceNumber: input.referenceNumber.trim(),
    /*
     * WHAT CAME IN FOR TEST AND REPAIR, AND THE CUSTOMER'S QUOTE NUMBER.
     * Test & Repair §4.
     *
     * Trimmed and kept as given. Offered only where the job type captures them
     * (`capturesRepairItem` / `capturesQuoteNumber`), and the server CLEARS
     * them on a type that does not — so a request that carries a quote number
     * on a parts collection does not quietly store one the screen will never
     * show. Nothing is required: a unit can be booked in while somebody is
     * still looking for the part number on the casting.
     */
    repairItem:
      definition.capturesRepairItem && input.repairItem !== undefined
        ? {
            partNumber: input.repairItem.partNumber.trim(),
            description: input.repairItem.description.trim(),
            quantity: input.repairItem.quantity,
          }
        : emptyRepairItem(),
    quoteNumber: definition.capturesQuoteNumber ? (input.quoteNumber ?? '').trim() : '',
    dateReceived,
    faultDescription,
    /*
     * A NEW JOB HAS NO ATTACHMENTS, and cannot be given one here.
     *
     * A document is bytes. This operation is handed none — a JSON creation
     * request carries no file — so recording an attachment at this point could
     * only ever be a row pointing at nothing, which is exactly the fiction that
     * durable storage exists to end. The office attaches documents to the job
     * once it exists, through `POST /api/jobs/:id/attachments`, which stores
     * the bytes before it records anything.
     */
    attachments: [],
    primaryTechnicianId: primaryId,
    additionalTechnicianIds: [...additionalIds],
    labour: [],
    travel: [],
    parts: [],
    additionalCharges: [],
    discount: null,
    photos: [],
    videos: [],
    notes: [],
    completionReport: emptyCompletionReport(),
    checklist: null,
    signature: null,
    signatureRefusals: [],
    sparesRequest: null,
    // A call-out fee is a per-job commercial decision, applied on the job card.
    calloutApplied: false,
    // BENCH-1: optional and unticked until somebody ticks it.
    testBenchApplied: false,
    // Offered on the job types whose work is collected from the counter; false
    // everywhere else, where nobody collects anything.
    /*
     * WHO IS COLLECTING IS ASKED AT THE COLLECTION STEP, NOT HERE. CR-12.
     *
     * FALSE AT CREATION ON EVERY JOB TYPE. Job completion §6.
     *
     * The owner asked that the collection answer not be available until the job
     * is finished, and this is the other half of that: not merely absent from
     * the form, but unwritable at creation whatever a request sends.
     *
     * The reasoning was already in this file for a parts collection and now
     * applies to a workshop repair too — who was EXPECTED and who TURNS UP are
     * not the same question. A customer who said they would collect sends a
     * driver often enough that an answer recorded days earlier is a guess, and
     * a wrong guess means a courier holding a document with the customer's
     * prices on it. `setCollectionMethod` records the answer at the collection,
     * and refuses before `completion`.
     */
    courierCollection: false,
    waybillNumber: '',
    deliveryNote: getJobTypeDefinition(input.jobType).capturesDeliveryNote
      ? input.deliveryNote.trim()
      : '',
    pricingSnapshot: null,
    finalDocument: null,
    delivery: null,
    cancellation: null,

    officeHandling: null,

    invoice: null,
    createdAt: now,
    createdBy: context.actor.id,
    acceptedAt: null,
    completedAt: null,
    submittedAt: null,
    closedAt: null,
  };

  const saved = await context.repos.jobs.save(job);
  if (!allocated.atomic) {
    await context.repos.settings.save({
      ...settings,
      nextJobSequence: settings.nextJobSequence + 1,
    });
  }

  await audit(context, {
    jobId: saved.id,
    type: 'job_created',
    summary: asDraft ? 'Draft job created' : 'Job created',
    detail: asDraft
      ? `${definition.label} job DRAFTED by ${userFullName(context.actor)}. It is not yet open, nobody has been assigned it, and no technician has been told.`
      : `${definition.label} job raised by ${userFullName(context.actor)}.`,
  });

  /*
   * Assigned, recorded, and — now — actually told.
   *
   * The audit event says the office gave somebody the work; `notifyAssignment`
   * is what reaches them. Both the primary and anybody attending with them get
   * one, because "you are on EJE-1103 tomorrow" is news to an assistant too.
   */
  /*
   * A DRAFT TELLS NOBODY. DRAFT-1.
   *
   * It may name the technician the Master has in mind — that is the point of
   * drafting — but "you are on EJE-1103 tomorrow" about a job that may never be
   * raised is worse than hearing it a day later. `releaseDraft` sends it.
   */
  if (!asDraft && saved.primaryTechnicianId !== null) {
    const details = await assignmentDetails(context, saved);

    const assigned: { id: UserId; occasion: AssignmentOccasion }[] = [
      { id: saved.primaryTechnicianId, occasion: 'primary' },
      ...saved.additionalTechnicianIds.map((id) => ({ id, occasion: 'additional' as const })),
    ];

    for (const { id, occasion } of assigned) {
      const technician = await context.repos.users.findById(id);
      if (technician === null) continue;

      await audit(context, {
        jobId: saved.id,
        type: occasion === 'primary' ? 'job_assigned' : 'technician_added',
        summary:
          occasion === 'primary'
            ? `Job assigned to ${userFullName(technician)}`
            : `${userFullName(technician)} added to the job`,
        detail:
          occasion === 'primary'
            ? 'Assigned as primary technician when the job was raised.'
            : 'Added as an additional technician when the job was raised.',
      });

      await notifyAssignment(context, saved, technician, occasion, details);
    }
  }

  return saved;
};

/**
 * A DRAFT BECOMES A JOB. DRAFT-1.
 *
 * The release is where every rule a draft was let off is asked again, against
 * the job as it now STANDS rather than against the request that drafted it:
 *
 *   - `assertReadyForWork` — the same function `createJob` uses, so there is
 *     one rule and not two copies of it;
 *   - the technicians named on the draft are re-validated, because somebody
 *     drafted weeks ago may have left, or may be on leave on the day;
 *   - the site and contact are re-read from the register, because a site
 *     withdrawn since the draft was written must not open a job.
 *
 * WHICH DAY'S RATES. None, and this is not a gap: a job carries no pricing
 * until the customer signs (COST-8 freezes the snapshot at signature), so there
 * is nothing captured at drafting for a rate change to invalidate. A released
 * draft prices exactly as a job raised that morning does. The question in issue
 * #21 — "the rates of the release day or the drafting day" — is answered by the
 * system EJE already have.
 *
 * NOTHING IS RE-ALLOCATED. The job number was taken when the draft was raised
 * and the job keeps it, so releasing does not move the commercial sequence.
 */
export const releaseDraft = async (context: OperationContext, job: Job): Promise<Job> => {
  if (!can(context.actor.role, 'jobs.manageDrafts')) {
    throw new WorkflowError('Releasing a draft is a Master’s.', [
      {
        code: 'not_permitted',
        message: 'Ask a Master to release it. Until then it is not a job anybody can work.',
      },
    ]);
  }

  if (job.status !== 'draft') {
    throw new WorkflowError(`${job.jobNumber} is not a draft.`, [
      {
        code: 'not_a_draft',
        message:
          'It has already been released, or it was never drafted. Reload the job and look again.',
      },
    ]);
  }

  const definition = getJobTypeDefinition(job.jobType);
  assertReadyForWork(definition, job);

  /*
   * THE REGISTER AND THE PEOPLE, RE-ASKED.
   *
   * A draft may have been written weeks ago. `resolveRegister` reads the LIVE
   * register, so a site withdrawn since then refuses the release — which is
   * right: a new job may not be raised against one, and this IS the moment the
   * job is raised. `resolveTechnicians` re-checks eligibility for the same
   * reason: the person the Master had in mind may have left.
   */
  const { customer, site, contact, machine } = await resolveRegister(context, {
    customerId: job.customerId,
    siteId: job.siteId,
    machineId: job.machineId,
    contactId: job.contactId,
  });

  const { primaryId, additionalIds } = await resolveTechnicians(context, {
    jobType: job.jobType,
    primaryTechnicianId: job.primaryTechnicianId,
    additionalTechnicianIds: job.additionalTechnicianIds,
    scheduledDate: job.scheduledDate,
    scheduledEndDate: job.scheduledEndDate,
  });

  const released = await context.repos.jobs.save({
    ...job,
    // The same rule `createJob` applies: an office-processed job opens in its
    // own close-out, everything else in the pool.
    status: definition.officeProcessed ? 'completion' : 'open',
    customerId: customer.id,
    siteId: site.id,
    contactId: contact.id,
    machineId: machine === null ? null : machine.id,
    primaryTechnicianId: primaryId,
    additionalTechnicianIds: [...additionalIds],
  });

  await audit(context, {
    jobId: released.id,
    type: 'job_created',
    summary: 'Draft released as a job',
    detail:
      `Released by ${userFullName(context.actor)}. ` +
      (definition.officeProcessed
        ? 'It is now in its close-out.'
        : primaryId === null
          ? 'It is now in the open pool for a technician to accept.'
          : 'It is now open and the technician has been told.'),
  });

  /*
   * AND NOW THE TECHNICIAN IS TOLD. The notification the draft deliberately
   * did not send — same shape as `createJob`, because it is the same event
   * happening at a different moment.
   */
  if (released.primaryTechnicianId !== null) {
    const details = await assignmentDetails(context, released);
    const assigned: { id: UserId; occasion: AssignmentOccasion }[] = [
      { id: released.primaryTechnicianId, occasion: 'primary' },
      ...released.additionalTechnicianIds.map((id) => ({ id, occasion: 'additional' as const })),
    ];

    for (const { id, occasion } of assigned) {
      const technician = await context.repos.users.findById(id);
      if (technician === null) continue;

      await audit(context, {
        jobId: released.id,
        type: occasion === 'primary' ? 'job_assigned' : 'technician_added',
        summary:
          occasion === 'primary'
            ? `Job assigned to ${userFullName(technician)}`
            : `${userFullName(technician)} added to the job`,
        detail:
          occasion === 'primary'
            ? 'Assigned as primary technician when the draft was released.'
            : 'Added as an additional technician when the draft was released.',
      });

      await notifyAssignment(context, released, technician, occasion, details);
    }
  }

  return released;
};
