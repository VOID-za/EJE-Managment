import type {
  ChangeRequest,
  JobCorrection,
  UnsignedDeliveryAuthorisation,
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
  canSeeDraftJobs,
  withoutHiddenDrafts,
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
  summariesVisibleTo,
  toJobSummary,
  type JobSummary,
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
   * WHAT THE CUSTOMER HAS ASKED FOR ON THIS JOB, newest first. CUST-CR.
   *
   * Visible to whoever may see the job, which is the whole of what a
   * customer's request DOES to a job in progress: it is written down where the
   * person doing the work will read it, and it changes nothing by itself.
   */
  readonly customerRequests: readonly ChangeRequest[];
  /**
   * Every contact this customer has, archived ones included. CUST-CR.
   *
   * For recording WHICH of them asked for something on the job — often not the
   * person the paperwork goes to, which is `contact` above.
   */
  readonly customerContacts: readonly Contact[];
  /**
   * CORRECTIONS TO THIS JOB CARD, oldest first. BD-02, IMMUT-9.
   *
   * Composed here rather than fetched by the browser, for the reason the
   * customer's documents are: whether this viewer may see them is a server
   * fact. Empty for a job that has issued nothing, which is almost every job,
   * so the extra read costs nothing on the screens that do not show them.
   *
   * WITHOUT THE STORAGE KEY. The download route resolves it after deciding who
   * is asking, and a key is not a way in.
   */
  readonly corrections: readonly Omit<JobCorrection, 'documentStorageKey'>[];
  /**
   * The Master's authorisation to send an UNSIGNED job card. BD-06, AUD-4.
   *
   * Null on every job that was signed, and on an unsigned one nobody has
   * authorised — which is the state the panel exists to state plainly.
   */
  readonly unsignedDeliveryAuthorisation: UnsignedDeliveryAuthorisation | null;
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
  /*
   * A DRAFT, BEFORE ANYTHING ELSE. DRAFT-1.
   *
   * Found by the route test, which asked for a draft as a Coordinator and was
   * answered 200: the LIST reads had the rule and this one did not, because
   * `jobs.viewAll` short-circuits here too. The lesson is the pattern, not the
   * line — every one of these short-circuits is a place DRAFT-1 has to be
   * repeated, which is why `canSeeDraftJobs` exists as one named rule.
   *
   * `viewer === null` is a SERVER-SIDE read with no person in it (a document
   * render, a reconcile), and those see everything: there is no screen and
   * nobody to hide a draft from.
   */
  if (job.status === 'draft' && viewer !== null && !canSeeDraftJobs(viewer.role)) return null;

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

  /*
   * WHAT EJE HAVE SAID ABOUT THIS JOB CARD SINCE ISSUING IT. BD-02, BD-06.
   *
   * Only for a job that HAS issued one. A job still in the workflow cannot
   * have a correction and cannot have an unsigned-delivery authorisation, so
   * asking would be two reads per job screen for an answer that is always
   * empty.
   *
   * The corrections are visible to whoever may see the job at all, which is
   * already decided above: the technician who did the work is the person who
   * most needs to know it has been corrected.
   */
  const [corrections, unsignedDeliveryAuthorisation] =
    job.finalDocument === null
      ? ([[], null] as const)
      : await Promise.all([
          repos.jobs.listCorrections(job.id),
          job.signature === null
            ? repos.jobs.findUnsignedDeliveryAuthorisation(job.id)
            : Promise.resolve(null),
        ]);

  /*
   * WHAT THE CUSTOMER HAS ASKED FOR ON THIS JOB. CUST-CR, the job half.
   *
   * THIS IS THE WHOLE OF "what does it do to a job in progress": it is VISIBLE
   * to whoever is working the job, and it changes nothing. A request that the
   * office could see and the technician could not would be the office reading
   * "while you are here, look at the Y axis too" and the technician driving
   * away without it.
   *
   * Read for every job rather than only an issued one, unlike the corrections
   * above: a customer asks for something while the work is being done, which
   * is exactly when it matters.
   */
  const customerRequests = await repos.changeRequests.listForJob(job.id);

  return {
    job,
    customer,
    site,
    contact: contacts.find((candidate) => candidate.id === job.contactId) ?? null,
    /*
     * EVERY CONTACT THE CUSTOMER HAS. CUST-CR, the job half.
     *
     * The job's own recipient is `contact` above; this is the list the office
     * picks from when recording WHO telephoned, which is often not the person
     * the paperwork goes to. Archived ones included, because the person who
     * telephoned last month may have left since and the record must still
     * name them.
     */
    customerContacts: contacts,
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
    customerRequests,
    corrections: corrections.map(({ documentStorageKey: _key, ...rest }) => rest),
    unsignedDeliveryAuthorisation,
  };
};

/** Lightweight row used by every job list in the system. */
export interface JobListRow {
  /** A SUMMARY, not a job: a list row shows no part, no labour and no price. */
  readonly job: JobSummary;
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
  // DRAFT-1 FIRST, because the `jobs.viewAll` short-circuit below never reaches
  // `jobVisibilityFor` and a draft is not visible to the whole office.
  const jobs = withoutHiddenDrafts(actor, await repos.jobs.listSummaries());
  if (can(actor.role, 'jobs.viewAll')) return loadJobRows(repos, jobs, actor);

  const participated = await repos.jobs.listParticipatedJobs(actor.id);
  const visible = summariesVisibleTo(actor, jobs, technicianHistoryFrom(participated));
  // Cancelled work is history for the office and clutter on a tablet. Applied
  // after the visibility rule, not instead of it.
  return loadJobRows(
    repos,
    visible.filter((job) => job.status !== 'cancelled'),
    actor,
  );
};

/**
 * The statuses the OPERATIONAL Jobs screen is for.
 *
 * Everything except the two terminal states. Closed work has its own screen and
 * cancelled work never happened; neither belongs in a list of what the business
 * is currently doing, and hydrating both to draw it was most of what the jobs
 * read spent its queries on.
 *
 * THIS NARROWS ONE SCREEN, NOT A RULE. A technician's access to the finished
 * work on a machine they have serviced is Decision 5's `machine_history`, it is
 * reached through Customers -> customer -> machine -> history, and it is
 * untouched here. That path was verified against the running application before
 * this filter was switched on: machine detail answers 200 to a technician, its
 * history carries the closed jobs, and those jobs open.
 */
export const ACTIVE_JOB_STATUSES = [
  'draft',
  'open',
  'in_progress',
  'awaiting_spares',
  'completion',
  'customer_signature',
  'review',
  'awaiting_delivery',
  'submitted',
] as const satisfies readonly Job['status'][];

/**
 * The operational Jobs screen: current work, as this person may read it.
 *
 * The same visibility rule as `loadJobList`, asked of a narrower set of rows —
 * and asked of the DATABASE, not of JavaScript afterwards.
 */
export const loadActiveJobList = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'id' | 'role'>,
): Promise<readonly JobListRow[]> => {
  // DRAFT-1, as in `loadJobList`.
  const jobs = withoutHiddenDrafts(
    actor,
    await repos.jobs.listSummaries({ statuses: ACTIVE_JOB_STATUSES }),
  );
  if (can(actor.role, 'jobs.viewAll')) return loadJobRows(repos, jobs, actor);

  const participated = await repos.jobs.listParticipatedJobs(actor.id);
  const visible = summariesVisibleTo(actor, jobs, technicianHistoryFrom(participated));
  return loadJobRows(repos, visible, actor);
};

export const loadJobRows = async (
  repos: RepositoryBundle,
  jobs: readonly JobSummary[],
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
    /*
     * NARROWED, then redacted.
     *
     * The narrowing is what keeps money out of a list: a summary has no parts,
     * no labour and no pricing snapshot, so there is nothing for
     * `withoutPrices` to remove and nothing to forget to remove. It is done at
     * RUNTIME and not only in the type, because a `Job` structurally satisfies
     * `JobSummary` — a caller handing one straight through would compile and
     * would ship every price to the browser inside a row that renders none of
     * them.
     *
     * The refusals survive the narrowing, because the office refusal queue and
     * the row badge both read them, so they are still redacted per viewer.
     * That is the one part of Decision 5 that narrowing cannot do for us.
     */
    const job = redactRefusalsForViewer(toJobSummary(stored), viewer);
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
  // DRAFT-1, before the short-circuit, as in the three reads above.
  const visible = withoutHiddenDrafts(actor, jobs);
  if (can(actor.role, 'jobs.viewAll')) return visible;

  const participated = await repos.jobs.listParticipatedJobs(actor.id);
  return visibleJobsFor(actor, visible, technicianHistoryFrom(participated));
};

/**
 * The summaries this viewer may see, for a screen that COUNTS jobs.
 *
 * The customer and machine registers show an open-job tally per row. They were
 * reading every job in the business as a complete aggregate — parts, labour,
 * media, signatures, pricing snapshots — to compare a status and a foreign key.
 * `loadVisibleJobs` is still the function for a caller that genuinely holds
 * full jobs; this is the one for a caller that only needs to count them.
 *
 * The visibility rule is identical: a technician's tally counts what a
 * technician may OPEN, so the register cannot tell them a customer has four
 * open jobs when the screen behind it lists one.
 */
export const loadVisibleSummaries = async (
  repos: RepositoryBundle,
  jobs: readonly JobSummary[],
  actor: Pick<User, 'id' | 'role'>,
): Promise<readonly JobSummary[]> => {
  // DRAFT-1. A tally that counted drafts would tell a Coordinator a customer
  // has four open jobs when the screen behind it lists three.
  const visible = withoutHiddenDrafts(actor, jobs);
  if (can(actor.role, 'jobs.viewAll')) return visible;

  const participated = await repos.jobs.listParticipatedJobs(actor.id);
  return summariesVisibleTo(actor, visible, technicianHistoryFrom(participated));
};

export const loadVisibleJobRows = async (
  repos: RepositoryBundle,
  jobs: readonly Job[],
  actor: Pick<User, 'id' | 'role'>,
): Promise<readonly JobListRow[]> =>
  loadJobRows(repos, await loadVisibleJobs(repos, jobs, actor), actor);
