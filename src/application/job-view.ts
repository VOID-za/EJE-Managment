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
import { getJobTypeDefinition } from '@/domain';
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
  readonly machine: Machine;
  readonly primaryTechnician: User | null;
  readonly additionalTechnicians: readonly User[];
  readonly settings: SystemSettings;
  /** The checklist template for this job type, when one is mandated. */
  readonly checklistTemplate: ChecklistTemplate | null;
}

export const loadJobView = async (
  repos: RepositoryBundle,
  jobNumber: string,
): Promise<JobView | null> => {
  const job = await repos.jobs.findByJobNumber(jobNumber);
  if (job === null) return null;

  const [customer, machine, settings, sites, contacts, users] = await Promise.all([
    repos.customers.findById(job.customerId),
    repos.machines.findById(job.machineId),
    repos.settings.get(),
    repos.customers.listSites(job.customerId),
    repos.customers.listContacts(job.customerId),
    repos.users.list(),
  ]);

  const site = sites.find((candidate) => candidate.id === job.siteId);
  if (customer === null || machine === null || site === undefined) return null;

  const definition = getJobTypeDefinition(job.jobType);
  const checklistTemplate = definition.checklistRequired
    ? await repos.checklistTemplates.findForJobType(job.jobType)
    : null;

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
    checklistTemplate,
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
): Promise<readonly JobListRow[]> => {
  const [customers, sites, machines, users] = await Promise.all([
    repos.customers.list(),
    repos.customers.listSites(),
    repos.machines.list(),
    repos.users.list(),
  ]);

  return jobs.map((job) => {
    const machine = machines.find((candidate) => candidate.id === job.machineId);
    const technician = users.find((candidate) => candidate.id === job.primaryTechnicianId);

    return {
      job,
      customerName:
        customers.find((candidate) => candidate.id === job.customerId)?.name ?? 'Unknown customer',
      siteName: sites.find((candidate) => candidate.id === job.siteId)?.name ?? '—',
      machineLabel:
        machine === undefined ? '—' : `${machine.manufacturer} ${machine.model}`,
      machineSerial: machine?.serialNumber ?? '—',
      technicianName:
        technician === undefined ? 'Unassigned' : `${technician.firstName} ${technician.lastName}`,
      technicianInitials: technician?.initials ?? '—',
    };
  });
};
