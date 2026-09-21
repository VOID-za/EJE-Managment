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
  can,
  getJobTypeDefinition,
  jobVisibilityFor,
  machineLabel as machineLabelFor,
  redactRefusalsForViewer,
  showsPricesAt,
  technicianHistoryFrom,
  visibleJobsFor,
  withoutPrices,
  type JobVisibility,
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
 * Why this viewer may read this job, or null when they may not.
 *
 * A null viewer is an operation reading the record rather than a person reading
 * a screen, and gets the whole truth: the workflow rules are enforced against
 * what is actually stored, never against a redacted copy of it.
 *
 * The participation history is fetched only for someone the rule can actually
 * turn away, so the office's read stays one query.
 */
const resolveVisibility = async (
  repos: RepositoryBundle,
  job: Job,
  viewer: Pick<User, 'id' | 'role'> | null,
): Promise<JobVisibility | null> => {
  if (viewer === null) return 'office';
  if (can(viewer.role, 'jobs.viewAll')) return 'office';
  const participated = await repos.jobs.listParticipatedJobs(viewer.id);
  return jobVisibilityFor(viewer, job, technicianHistoryFrom(participated));
};

/**
 * Loads a job for a PERSON to read.
 *
 * `viewer` is what makes this different from reading the record. Two rules run
 * here, both of them at the READ rather than on a screen, because in the next
 * phase this function is the API handler and there is no screen in the request
 * path:
 *
 *  - DECISION 5. A job this viewer may not see comes back as NULL — the same
 *    answer a job number that does not exist gives, which is the only answer
 *    that does not confirm the job exists. A job reached through machine
 *    history comes back with its prices removed rather than hidden.
 *  - The refusal rule. A technician who may not read another technician's
 *    signature refusal is handed a job with no refusals on it, so there is
 *    nothing for a screen — or a hand-typed URL — to render.
 *
 * Omitting the viewer reads the whole record, which is what the operations
 * themselves need: rules have to be enforced against the truth.
 */
export const loadJobView = async (
  repos: RepositoryBundle,
  jobNumber: string,
  viewer: Pick<User, 'id' | 'role'> | null = null,
): Promise<JobView | null> => {
  const stored = await repos.jobs.findByJobNumber(jobNumber);
  if (stored === null) return null;

  const visibility = await resolveVisibility(repos, stored, viewer);
  if (visibility === null) return null;

  const job = redactRefusalsForViewer(
    showsPricesAt(visibility) ? stored : withoutPrices(stored),
    viewer,
  );

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

/**
 * The job list, as this person may read it.
 *
 * The rule it carries is the one the Jobs screen already applied and is
 * unchanged: a technician is not shown cancelled work — it is history for the
 * office and clutter on a tablet — while a role with `jobs.viewAll` sees it and
 * can filter to it. What has changed is WHERE that rule runs. It used to be a
 * `.filter()` in the screen, over a list that had already loaded every job in
 * the business; now the read decides, which is what will still hold when this
 * function is an API handler and there is no screen in the request path.
 *
 * DECISION 5 now also decides WHICH jobs a technician is shown: the open pool,
 * their own assignments, the work they have ever participated in, and the
 * finished history of machines they have worked on. That was an open question
 * when this function was written and it deliberately left it alone; EJE have
 * settled it, so the read applies it. Refusals are private either way —
 * `loadJobRows` redacts them per viewer.
 */
export const loadJobList = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'id' | 'role'>,
): Promise<readonly JobListRow[]> => {
  const jobs = await repos.jobs.list();
  if (can(actor.role, 'jobs.viewAll')) return loadJobRows(repos, jobs, actor);

  const participated = await repos.jobs.listParticipatedJobs(actor.id);
  const visible = visibleJobsFor(actor, jobs, technicianHistoryFrom(participated));
  // Cancelled work is history for the office and clutter on a tablet. Applied
  // after the visibility rule, not instead of it.
  return loadJobRows(
    repos,
    visible.filter((job) => job.status !== 'cancelled'),
    actor,
  );
};

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

/**
 * The jobs hanging off ONE record — a customer, a machine — as this viewer may
 * read them.
 *
 * WHY THIS IS NOT `loadJobRows`. That function resolves names and redacts
 * refusals; it does NOT decide who may see a job, because its callers hand it a
 * list that has already been decided. `loadJobList` decides for the Jobs
 * screen. A record screen has to decide too, and passing `repos.jobs.list({
 * customerId })` straight into `loadJobRows` handed a technician every job on
 * that customer — another technician's live work included, with the prices on
 * it.
 *
 * DECISION 5, through `visibleJobsFor`, which filters and suppresses prices in
 * one call so a caller cannot apply half the rule. The office is unaffected:
 * `jobs.viewAll` returns everything, in full, exactly as before.
 *
 * Cancelled work is deliberately NOT dropped here, unlike `loadJobList`: on the
 * Jobs screen it is clutter on a tablet, but on a machine's history "we were
 * called out and the job was cancelled" is part of what happened to it.
 */
export const loadVisibleJobs = async (
  repos: RepositoryBundle,
  jobs: readonly Job[],
  actor: Pick<User, 'id' | 'role'>,
): Promise<readonly Job[]> => {
  if (can(actor.role, 'jobs.viewAll')) return jobs;

  const participated = await repos.jobs.listParticipatedJobs(actor.id);
  return visibleJobsFor(actor, jobs, technicianHistoryFrom(participated));
};

export const loadVisibleJobRows = async (
  repos: RepositoryBundle,
  jobs: readonly Job[],
  actor: Pick<User, 'id' | 'role'>,
): Promise<readonly JobListRow[]> =>
  loadJobRows(repos, await loadVisibleJobs(repos, jobs, actor), actor);
