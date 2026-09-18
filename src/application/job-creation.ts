import {
  asJobId,
  can,
  emptyCompletionReport,
  getJobTypeDefinition,
  roleLabel,
  userFullName,
  type ContactId,
  type CustomerId,
  type Job,
  type JobPriority,
  type JobTypeCode,
  type MachineId,
  type SiteId,
  type UserId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';
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
  readonly contactId: ContactId;
  readonly machineId: MachineId | null;
  readonly jobType: JobTypeCode;
  readonly priority: JobPriority;
  readonly scheduledDate: string | null;
  readonly scheduledEndDate: string | null;
  readonly orderNumber: string;
  readonly referenceNumber: string;
  readonly faultDescription: string;
  readonly primaryTechnicianId: UserId | null;
  readonly courierCollection: boolean;
}

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
  if (input.primaryTechnicianId !== null) {
    const technician = await context.repos.users.findById(input.primaryTechnicianId);
    if (technician === null || !technician.active) {
      throw new WorkflowError('That technician is not available to take jobs.', [
        { code: 'user_inactive', message: 'Choose a technician who is still working here.' },
      ]);
    }
    if (!can(technician.role, 'jobs.acceptField')) {
      throw new WorkflowError(`${userFullName(technician)} does not carry out field work.`, [
        {
          code: 'not_a_field_technician',
          message: `${roleLabel(technician.role)} accounts run the office. A job is assigned to the technician who will attend the machine.`,
        },
      ]);
    }
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

  const settings = await context.repos.settings.get();
  const jobNumber = `${settings.jobNumberPrefix}${settings.nextJobSequence}`;
  const now = context.services.clock.now();

  const job: Job = {
    id: asJobId(`job-${jobNumber.toLowerCase()}`),
    jobNumber,
    customerId: input.customerId,
    siteId: input.siteId,
    contactId: input.contactId,
    machineId: input.machineId,
    jobType: input.jobType,
    priority: input.priority,
    status: 'open',
    scheduledDate: input.scheduledDate,
    scheduledEndDate: definition.schedulesDateRange ? input.scheduledEndDate : null,
    orderNumber: input.orderNumber.trim(),
    referenceNumber: input.referenceNumber.trim(),
    faultDescription: input.faultDescription.trim(),
    attachments: [],
    primaryTechnicianId: input.primaryTechnicianId,
    additionalTechnicianIds: [],
    labour: [],
    travel: [],
    parts: [],
    photos: [],
    videos: [],
    notes: [],
    completionReport: emptyCompletionReport(),
    checklist: null,
    signature: null,
    awaitingSparesReason: '',
    // A call-out fee is a per-job commercial decision, applied on the job card.
    calloutApplied: false,
    courierCollection: input.jobType === 'parts' ? input.courierCollection : false,
    pricingSnapshot: null,
    finalDocument: null,
    delivery: null,
    cancellation: null,
    deletedAt: null,
    deletedBy: null,
    deletionReason: '',
    createdAt: now,
    createdBy: context.actor.id,
    acceptedAt: null,
    completedAt: null,
    submittedAt: null,
    closedAt: null,
  };

  const saved = await context.repos.jobs.save(job);
  await context.repos.settings.save({
    ...settings,
    nextJobSequence: settings.nextJobSequence + 1,
  });

  await audit(context, {
    jobId: saved.id,
    type: 'job_created',
    summary: 'Job created',
    detail: `${definition.label} job raised by ${userFullName(context.actor)}.`,
  });

  if (saved.primaryTechnicianId !== null) {
    const technician = await context.repos.users.findById(saved.primaryTechnicianId);
    await audit(context, {
      jobId: saved.id,
      type: 'job_assigned',
      summary: `Job assigned to ${technician === null ? 'a technician' : userFullName(technician)}`,
      detail: 'Assigned as primary technician when the job was raised.',
    });
  }

  return saved;
};
