import {
  asAttachmentId,
  asJobId,
  can,
  contactFullName,
  emptyCompletionReport,
  getJobTypeDefinition,
  machineDisplayName,
  roleLabel,
  userFullName,
  type Attachment,
  type Contact,
  type ContactId,
  type Customer,
  type CustomerId,
  type Job,
  type JobPriority,
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
  readonly priority: JobPriority;
  readonly scheduledDate: string | null;
  readonly scheduledEndDate: string | null;
  readonly orderNumber: string;
  readonly referenceNumber: string;
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
  /** Documents the office attaches when raising the job. See `storeAttachments`. */
  readonly attachments: readonly NewJobAttachment[];
}

export interface NewJobAttachment {
  readonly fileName: string;
  readonly contentType: string;
  readonly caption: string;
  readonly sizeBytes: number;
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

const resolveRegister = async (
  context: OperationContext,
  input: NewJobInput,
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
const resolveTechnicians = async (
  context: OperationContext,
  input: NewJobInput,
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
 * Documents the office attaches when raising the job.
 *
 * Goes through the storage PORT, which is the only way anything in this system
 * reaches a file. What that port does today is the honest part: the simulated
 * adapter records the file's name, size and a storage key against the job and
 * KEEPS NO BYTES — see `SimulatedStorageService.put`. So the job carries a
 * truthful record of what the office attached, and the document itself is
 * retrievable only once real object storage is configured behind the same
 * interface. Nothing here pretends otherwise, and no screen offers a download
 * that would fail.
 */
const storeAttachments = async (
  context: OperationContext,
  input: NewJobInput,
): Promise<readonly Attachment[]> => {
  const now = context.services.clock.now();
  const stored: Attachment[] = [];

  for (const file of input.attachments) {
    const put = await context.services.storage.put(file.fileName, file.contentType, null);
    stored.push({
      id: asAttachmentId(context.services.ids.next('att')),
      kind: 'document',
      fileName: file.fileName,
      caption: file.caption.trim(),
      storageKey: put.storageKey,
      uploadedAt: now,
      uploadedBy: context.actor.id,
      sizeBytes: file.sizeBytes,
    });
  }
  return stored;
};

export const createJob = async (
  context: OperationContext,
  input: NewJobInput,
): Promise<Job> => {
  if (!can(context.actor.role, 'jobs.create')) {
    throw new WorkflowError('A job can only be raised by the office.', [
      {
        code: 'not_permitted',
        message: 'Ask the office to raise a job card for you.',
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

  const faultDescription = input.faultDescription.trim();
  if (faultDescription.length === 0) {
    throw new WorkflowError('A job needs to say what the work is.', [
      {
        code: 'fault_description_required',
        message:
          'Describe the fault or the work required. It is what the technician is sent out on, and it is printed on the customer’s job card.',
      },
    ]);
  }

  const definition = getJobTypeDefinition(input.jobType);
  if (definition.capturesLabourAndTravel && input.machineId === null) {
    throw new WorkflowError('A machine is required for this job type.', [
      {
        code: 'machine_required',
        message: `A ${definition.label.toLowerCase()} job is work on a machine, so it has to say which.`,
      },
    ]);
  }

  const attachments = await storeAttachments(context, input);

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
    priority: input.priority,
    status: 'open',
    scheduledDate: input.scheduledDate,
    scheduledEndDate: definition.schedulesDateRange ? input.scheduledEndDate : null,
    orderNumber: input.orderNumber.trim(),
    referenceNumber: input.referenceNumber.trim(),
    faultDescription,
    attachments,
    primaryTechnicianId: primaryId,
    additionalTechnicianIds: [...additionalIds],
    labour: [],
    travel: [],
    parts: [],
    photos: [],
    videos: [],
    notes: [],
    completionReport: emptyCompletionReport(),
    checklist: null,
    signature: null,
    signatureRefusals: [],
    awaitingSparesReason: '',
    // A call-out fee is a per-job commercial decision, applied on the job card.
    calloutApplied: false,
    // Offered on the job types whose work is collected from the counter; false
    // everywhere else, where nobody collects anything.
    courierCollection: getJobTypeDefinition(input.jobType).collectedOnCompletion
      ? input.courierCollection
      : false,
    waybillNumber: '',
    deliveryNote: getJobTypeDefinition(input.jobType).capturesDeliveryNote
      ? input.deliveryNote.trim()
      : '',
    pricingSnapshot: null,
    finalDocument: null,
    delivery: null,
    cancellation: null,
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
    summary: 'Job created',
    detail: `${definition.label} job raised by ${userFullName(context.actor)}.`,
  });

  /*
   * Assigned, recorded, and — now — actually told.
   *
   * The audit event says the office gave somebody the work; `notifyAssignment`
   * is what reaches them. Both the primary and anybody attending with them get
   * one, because "you are on EJE-1103 tomorrow" is news to an assistant too.
   */
  if (saved.primaryTechnicianId !== null) {
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
