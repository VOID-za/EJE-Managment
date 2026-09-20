import type {
  ChecklistTemplate,
  Contact,
  Customer,
  Job,
  Machine,
  Site,
  SystemSettings,
  User,
} from '@/domain';
import {
  getJobTypeDefinition,
  machineLabel as machineLabelFor,
  redactRefusalsForViewer,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * Resolved view of a job with every related record the UI needs.
 *
 * Assembling this in one place keeps screens free of ad-hoc lookups and mirrors
 * the shape the production API will return for `GET /jobs/:jobNumber`.
 */
export interface JobView {
  readonly job: Job;
  readonly customer: Customer;
  readonly site: Site;
  readonly contact: Contact | null;
  /** Null for a parts collection, which is not against a machine. */
  readonly machine: Machine | null;
  readonly primaryTechnician: User | null;
  readonly additionalTechnicians: readonly User[];
  readonly settings: SystemSettings;
  /** Everyone who could be named on this job, for resolving note and entry authors. */
  readonly users: readonly User[];
  /**
   * The checklist template this job is rendered against.
   *
   * For a job that already carries a completed or in-progress checklist this is
   * the exact version recorded on the instance, NOT the current template — a
   * historical job card must show the wording the customer saw. For a job with
   * no checklist yet it is the current template for the job type.
   */
  readonly checklistTemplate: ChecklistTemplate | null;
  /**
   * Set when the job records a checklist version that is no longer held. The UI
   * must say so rather than quietly rendering today's wording.
   */
  readonly checklistVersionMissing: boolean;
}

/**
 * Loads a job for a PERSON to read.
 *
 * `viewer` is what makes this different from reading the record: a technician
 * who may not see another technician's signature refusal is handed a job with
 * no refusals on it, so there is nothing for a screen — or a hand-typed URL —
 * to render. Omitting the viewer reads the whole record, which is what the
 * operations themselves need: rules have to be enforced against the truth.
 */
export const loadJobView = async (
  repos: RepositoryBundle,
  jobNumber: string,
  viewer: Pick<User, 'id' | 'role'> | null = null,
): Promise<JobView | null> => {
  const stored = await repos.jobs.findByJobNumber(jobNumber);
  if (stored === null) return null;
  const job = redactRefusalsForViewer(stored, viewer);

  const [customer, machine, settings, sites, contacts, users] = await Promise.all([
    repos.customers.findById(job.customerId),
    job.machineId === null ? Promise.resolve(null) : repos.machines.findById(job.machineId),
    repos.settings.get(),
    // Resolution, not selection: a job must still resolve the site and contact
    // it was carried out for even after that record has been withdrawn from the
    // register, or a closed job card would stop rendering.
    repos.customers.listSites(job.customerId, { includeArchived: true }),
    repos.customers.listContacts(job.customerId, { includeArchived: true }),
    repos.users.list(),
  ]);

  const site = sites.find((candidate) => candidate.id === job.siteId);
  // A missing machine is only a failure when the job is supposed to have one.
  if (customer === null || site === undefined) return null;
  if (job.machineId !== null && machine === null) return null;

  const definition = getJobTypeDefinition(job.jobType);

  // Resolve by the version stored on the instance when the job has one, so that
  // an old job card is never re-rendered against a newer revision of the wording.
  const historical =
    job.checklist === null
      ? null
      : await repos.checklistTemplates.findByVersion(
          job.checklist.templateId,
          job.checklist.templateVersion,
        );

  const checklistTemplate =
    job.checklist !== null
      ? historical
      : definition.checklistRequired
        ? await repos.checklistTemplates.findForJobType(job.jobType)
        : null;

  const checklistVersionMissing = job.checklist !== null && historical === null;

  return {
    job,
    customer,
    site,
    contact: contacts.find((candidate) => candidate.id === job.contactId) ?? null,
    machine,
    primaryTechnician:
      users.find((candidate) => candidate.id === job.primaryTechnicianId) ?? null,
    additionalTechnicians: users.filter((candidate) =>
      job.additionalTechnicianIds.includes(candidate.id),
    ),
    settings,
    users,
    checklistTemplate,
    checklistVersionMissing,
  };
};

/** Lightweight row used by every job list in the system. */
export interface JobListRow {
  readonly job: Job;
  readonly customerName: string;
  readonly siteName: string;
  readonly machineLabel: string;
  readonly machineSerial: string;
  readonly technicianName: string;
  readonly technicianInitials: string;
}

export const loadJobRows = async (
  repos: RepositoryBundle,
  jobs: readonly Job[],
  viewer: Pick<User, 'id' | 'role'> | null = null,
): Promise<readonly JobListRow[]> => {
  const [customers, sites, machines, users] = await Promise.all([
    repos.customers.list(),
    // See `loadJobView`: rows resolve archived records too.
    repos.customers.listSites(undefined, { includeArchived: true }),
    repos.machines.list({ includeArchived: true }),
    repos.users.list(),
  ]);

  return jobs.map((stored) => {
    // Redacted per row, so a refusal cannot reach a list a technician may read.
    const job = redactRefusalsForViewer(stored, viewer);
    const machine =
      job.machineId === null
        ? undefined
        : machines.find((candidate) => candidate.id === job.machineId);
    const technician = users.find((candidate) => candidate.id === job.primaryTechnicianId);

    return {
      job,
      customerName:
        customers.find((candidate) => candidate.id === job.customerId)?.name ?? 'Unknown customer',
      siteName: sites.find((candidate) => candidate.id === job.siteId)?.name ?? '—',
      machineLabel: machine === undefined ? '—' : machineLabelFor(machine),
      machineSerial: machine?.serialNumber ?? '—',
      technicianName:
        technician === undefined ? 'Unassigned' : `${technician.firstName} ${technician.lastName}`,
      technicianInitials: technician?.initials ?? '—',
    };
  });
};
