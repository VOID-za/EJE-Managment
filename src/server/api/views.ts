import 'server-only';
import {
  asCustomerId,
  asMachineId,
  asUserId,
  can,
  isJobOpenWork,
  machineDisplayName,
  submissionCover,
  type Machine,
  type TemplateUsage,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import { businessToday } from '@/lib/business-time';
import { loadActivityFeed, loadJobActivity } from '@/application/activity-read';
import { loadCalendar } from '@/application/calendar';
import { loadClosedJobs, type ClosedJobFilters } from '@/application/closed-jobs';
import { loadConversations } from '@/application/chat-operations';
import {
  loadActiveJobList,
  loadJobList,
  loadJobRows,
  loadJobView,
  loadVisibleJobRows,
  loadVisibleSummaries,
} from '@/application/job-view';
import { runSearch } from '@/application/search';
import type { AppServices } from '@/application/context';
import { forbidden, notFound } from './errors';

/**
 * The read models the screens are served.
 *
 * ONE ENDPOINT PER SCREEN, composed here rather than by the browser making six
 * repository calls. That is not only fewer round trips: it is the only way the
 * composition can be actor-aware, because the ACTOR is a server fact. The
 * browser asks for "the customer overview" and is handed exactly what it may
 * see.
 *
 * Every function takes the actor and passes it to the existing application
 * reads, which already decide what comes back — `loadJobList`, `loadJobView`,
 * `runSearch`, `loadActivityFeed`, `loadClosedJobs`. Nothing here re-implements
 * a visibility rule, and nothing here filters after loading everything.
 */
export interface ViewContext {
  readonly repos: RepositoryBundle;
  readonly services: AppServices;
  readonly actor: User;
}

/**
 * A screen this role may not open. Refused server-side, not merely hidden.
 *
 * The capability named here must be the one the SCREEN needs, which is not
 * always the one its writes need: requiring `customers.manage` to READ the
 * customer register is how a technician ended up being offered a screen that
 * then refused them.
 */
const requireCapability = (
  actor: User,
  capability: Parameters<typeof can>[1],
  message: string,
): void => {
  if (!can(actor.role, capability)) {
    throw forbidden(message, [
      { code: 'not_permitted', message: 'Your role does not have access to this.' },
    ]);
  }
};

/** An office screen: not something a technician is meant to reach at all. */
const requireOffice = (actor: User, capability: Parameters<typeof can>[1], what: string): void => {
  requireCapability(actor, capability, `${what} is an office screen.`);
};

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The OPERATIONAL Jobs screen.
 *
 * Active work only. Closed work has its own screen and cancelled work never
 * happened; a technician still reaches the finished work on a machine they have
 * serviced through Customers -> customer -> machine -> history, which is where
 * Decision 5 puts it.
 *
 * The office tile that links to the archive still says how much is in there —
 * now a `count(*)`, where it used to hydrate every closed job in the business
 * and take `.length`. Office-only, because the tile is.
 */
export const jobsView = async ({ repos, actor }: ViewContext) => {
  const office = can(actor.role, 'jobs.viewAll');
  const [rows, closedCount] = await Promise.all([
    loadActiveJobList(repos, actor),
    office ? repos.jobs.count({ statuses: ['closed'] }) : Promise.resolve(0),
  ]);
  return { rows, closedCount };
};

/**
 * One job, everything its screen needs.
 *
 * Returns null — which the route turns into a 404 — when the actor may not read
 * it. `loadJobView` already gives the same answer for a job that does not
 * exist, which is the point: the two must be indistinguishable.
 */
export const jobView = async ({ repos, actor }: ViewContext, jobNumber: string) => {
  const view = await loadJobView(repos, jobNumber, actor);
  if (view === null) return null;

  const [users, activity, absences] = await Promise.all([
    repos.users.list(),
    loadJobActivity(repos, actor, view.job.id),
    // Only today's absences: the rule asks about today and nothing else, so
    // the screen must not read the whole register to answer it.
    repos.availability.list(businessToday(), businessToday()),
  ]);

  /*
   * WHO COULD SUBMIT THIS JOB CARD TODAY. MASTER SCOPE CR-08.
   *
   * Decided HERE, on the server, from the availability register and the user
   * records — never by the browser. The screen is told the answer and draws
   * it; the operation asks the same question again before it acts, so a
   * client that lied about it would change nothing.
   */
  const cover = submissionCover(view.job, users, absences, businessToday());

  return { view, users, activity, submissionCover: cover };
};

export const jobFormView = async ({ repos, actor }: ViewContext) => {
  requireOffice(actor, 'jobs.create', 'Raising a job');
  const [customers, sites, contacts, machines, users, settings] = await Promise.all([
    repos.customers.list(),
    repos.customers.listSites(),
    repos.customers.listContacts(),
    repos.machines.list(),
    repos.users.list(),
    repos.settings.get(),
  ]);
  return { customers, sites, contacts, machines, users, settings };
};

export const closedJobsView = (
  { repos, actor }: ViewContext,
  filters: ClosedJobFilters,
) => loadClosedJobs(repos, actor, filters);

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The technician's own day.
 *
 * `loadJobList` already applies DECISION 5, so "everything this technician may
 * see" is the pool plus their own work — which is exactly the two lists this
 * screen shows. It no longer reads every job in the business to find them.
 */
export const technicianDashboardView = async ({ repos, actor }: ViewContext) => {
  const [visible, notifications] = await Promise.all([
    loadJobList(repos, actor),
    repos.notifications.list(actor.id),
  ]);

  const mineRows = visible.filter(
    (row) =>
      row.job.primaryTechnicianId === actor.id ||
      row.job.additionalTechnicianIds.includes(actor.id),
  );
  return { mineRows, allRows: visible, notifications };
};

export const masterDashboardView = async ({ repos, actor }: ViewContext) => {
  const [rows, feed, notifications] = await Promise.all([
    loadJobList(repos, actor),
    loadActivityFeed(repos, actor),
    repos.notifications.list(actor.id),
  ]);
  return {
    rows,
    users: feed.users,
    activity: feed.events.slice(0, 8),
    notifications,
  };
};

/* -------------------------------------------------------------------------- */
/* Registers                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The customer register.
 *
 * READING it needs `customers.view`, which a technician holds; CHANGING it
 * needs `customers.manage`, which only the office holds. That split is the
 * rule the system has always stated — `customer-operations.ts` refuses an edit
 * with "Technicians can view customers and raise change requests, but not edit
 * them", and the sidebar has always offered this screen on `customers.view`.
 *
 * It was `customers.manage` here for one release, which is a narrower rule than
 * anybody asked for: it left the navigation offering technicians a screen the
 * read then refused.
 */
export const customersView = async ({ repos, actor }: ViewContext) => {
  requireCapability(actor, 'customers.view', 'The customer register is not available to your role.');
  const [customers, sites, machines, allJobs] = await Promise.all([
    repos.customers.list(),
    repos.customers.listSites(),
    repos.machines.list(),
    // Summaries: this screen compares a status and a foreign key, and used to
    // read every job in the business as a complete aggregate to do it.
    repos.jobs.listSummaries(),
  ]);

  /*
   * The open-job count is counted over what this actor may OPEN.
   *
   * Otherwise the register tells a technician a customer has four open jobs and
   * the screen behind it lists one — and the difference is itself a disclosure:
   * it says three jobs exist that they may not read. The office's count is
   * unchanged, because the office may read all four.
   */
  const jobs = await loadVisibleSummaries(repos, allJobs, actor);

  return customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    accountNumber: customer.accountNumber,
    industry: customer.industry,
    siteCount: sites.filter((site) => site.customerId === customer.id).length,
    machineCount: machines.filter((machine) => machine.customerId === customer.id).length,
    openJobs: jobs.filter((job) => job.customerId === customer.id && isJobOpenWork(job.status))
      .length,
    active: customer.active,
  }));
};

/**
 * One customer: their sites, their contacts, their machines and their work.
 *
 * `customers.view`, as above. What a technician is handed is NOT the office's
 * copy of this screen: `loadVisibleJobRows` applies DECISION 5 to the job list,
 * so another technician's live job on this customer is not in it and anything
 * reached through machine history arrives with its prices removed. The register
 * itself — who the customer is, where their sites are, what machines stand on
 * them — is the same for everybody, which is the point of a technician being
 * able to read it before driving out.
 */
export const customerView = async ({ repos, actor }: ViewContext, customerId: string) => {
  requireCapability(actor, 'customers.view', 'That customer record is not available to your role.');
  const id = asCustomerId(customerId);
  const customer = await repos.customers.findById(id);
  if (customer === null) return null;

  const [sites, contacts, machines, jobs, users] = await Promise.all([
    repos.customers.listSites(id),
    repos.customers.listContacts(id),
    repos.machines.list(),
    repos.jobs.list({ customerId: id }),
    repos.users.list(),
  ]);

  return {
    customer,
    sites,
    contacts,
    machines: machines.filter((machine: Machine) => machine.customerId === id),
    jobRows: await loadVisibleJobRows(repos, jobs, actor),
    users,
  };
};

export const machinesView = async ({ repos, actor }: ViewContext) => {
  requireOffice(actor, 'machines.manage', 'The machine register');
  const [machines, customers, sites, jobs] = await Promise.all([
    repos.machines.list(),
    repos.customers.list(),
    repos.customers.listSites(),
    // As in `customersView`: a tally needs a status, not an aggregate.
    repos.jobs.listSummaries(),
  ]);

  return machines.map((machine) => ({
    id: machine.id,
    label: machineDisplayName(machine),
    serialNumber: machine.serialNumber,
    machineNumber: machine.machineNumber,
    machineType: machine.machineType,
    manufacturer: machine.manufacturer,
    customerName:
      customers.find((customer) => customer.id === machine.customerId)?.name ?? 'Unknown',
    siteName: sites.find((site) => site.id === machine.siteId)?.name ?? '—',
    year: machine.year,
    installationDate: machine.installationDate,
    openJobs: jobs.filter((job) => job.machineId === machine.id && isJobOpenWork(job.status))
      .length,
  }));
};

/**
 * One machine and its history.
 *
 * Deliberately not gated on `machines.manage`: the machine REGISTER is an
 * office screen, but one machine's history is what DECISION 5 exists to give a
 * technician before they drive out to it.
 *
 * The job list therefore goes through `loadVisibleJobRows`, which filters by
 * visibility and suppresses prices in one call. It used to be `loadJobRows`,
 * which does neither — so this screen handed any technician every job on any
 * machine, with the commercial figures on them. The rule was documented here
 * and not applied.
 */
export const machineView = async ({ repos, actor }: ViewContext, machineId: string) => {
  const id = asMachineId(machineId);
  const machine = await repos.machines.findById(id);
  if (machine === null) return null;

  const [customer, sites, jobs] = await Promise.all([
    repos.customers.findById(machine.customerId),
    // Includes a withdrawn site: this machine may be archived itself, and it
    // still has to say where it stood.
    repos.customers.listSites(machine.customerId, { includeArchived: true }),
    repos.jobs.list({ machineId: id }),
  ]);

  return {
    machine,
    customer,
    site: sites.find((candidate) => candidate.id === machine.siteId) ?? null,
    jobRows: await loadVisibleJobRows(repos, jobs, actor),
  };
};

export const technicianView = async ({ repos, actor }: ViewContext, userId: string) => {
  const id = asUserId(userId);
  /*
   * Your own page, or the office's view of somebody else's.
   *
   * A technician may read their own record — it is where their availability and
   * their own jobs are — and nobody else's, because it carries another person's
   * calendar and the messages they sent.
   */
  if (id !== actor.id) requireOffice(actor, 'users.manageTechnicians', 'A technician record');

  const technician = await repos.users.findById(id);
  if (technician === null) return null;

  const [records, jobs, messages, users] = await Promise.all([
    repos.availability.listForUser(id),
    repos.jobs.list({ technicianId: id }),
    repos.chat.listConversations(id).then(async (conversations) => {
      const threads = await Promise.all(
        conversations.map((conversation) => repos.chat.listMessages(conversation.id)),
      );
      return threads.flat().filter((message) => message.senderId === id);
    }),
    repos.users.list(),
  ]);

  return { technician, records, jobRows: await loadJobRows(repos, jobs, actor), messages, users };
};

/* -------------------------------------------------------------------------- */
/* Everything else a screen asks for                                          */
/* -------------------------------------------------------------------------- */

export const adminView = async ({ repos, actor }: ViewContext) => {
  requireOffice(actor, 'admin.access', 'Administration');
  const [users, settings, templates, documents, customers, machines, jobs] = await Promise.all([
    repos.users.list(),
    repos.settings.get(),
    repos.checklistTemplates.list(),
    repos.documents.list(),
    repos.customers.list(),
    repos.machines.list(),
    repos.jobs.list(),
  ]);

  // Which template versions jobs have actually completed against. This is what
  // makes a version immutable, so it is read here rather than guessed at.
  const usage: readonly TemplateUsage[] = jobs
    .map((job) => job.checklist)
    .filter((checklist) => checklist !== null)
    .map((checklist) => ({
      templateId: checklist.templateId,
      templateVersion: checklist.templateVersion,
    }));

  return { users, settings, templates, documents, customers, machines, usage };
};

export const libraryView = async ({ repos, actor }: ViewContext) => {
  const [documents, favourites, recent] = await Promise.all([
    repos.documents.list(),
    repos.documents.listFavourites(actor.id),
    repos.documents.listRecentlyViewed(actor.id),
  ]);
  return { documents, favourites, recent };
};

export const activityView = ({ repos, actor }: ViewContext) => loadActivityFeed(repos, actor);

export const searchView = ({ repos, actor }: ViewContext, term: string) =>
  runSearch(repos, actor, term);

/**
 * The calendar. MASTER SCOPE §3.3, §16, §24-CAL.
 *
 * "Technicians MUST be able to view the Calendar." It was gated on
 * `availability.manage` — the capability for WRITING the leave register — so
 * the one role that most needs to know when it is booked was refused, and the
 * sidebar hid the item to match. Reading the schedule and deciding who is on
 * leave are different acts and now have different capabilities.
 *
 * WHAT A TECHNICIAN SEES IS NARROWER THAN WHAT THE OFFICE SEES, and it has to
 * be. The office plans, so it sees every job and everybody's absence. A
 * technician sees the jobs DECISION 5 already lets them read and THEIR OWN
 * availability — because another technician's sick leave is that person's
 * business, and §16 asks for a calendar the technician can work from, not a
 * staff absence register. `loadCalendar` takes the viewer and applies it while
 * building, rather than a screen filtering afterwards.
 */
export const calendarView = ({ repos, actor }: ViewContext, from: string, to: string) => {
  requireCapability(actor, 'calendar.view', 'The calendar is not available to your role.');
  return loadCalendar(repos, { from, to }, actor);
};

/**
 * The notification bell, and the job numbers its links need.
 *
 * The numbers come from the jobs this actor may see. A notification about a job
 * they may no longer read shows its title and goes nowhere, which is correct:
 * the notification happened to them, the job is not theirs.
 */
export const notificationsView = async ({ repos, actor }: ViewContext) => {
  const [notifications, rows] = await Promise.all([
    repos.notifications.list(actor.id),
    loadJobList(repos, actor),
  ]);
  return {
    notifications,
    jobNumbers: rows.map((row) => [row.job.id as string, row.job.jobNumber] as const),
  };
};

export const messagesView = async (context: ViewContext, conversationId: string | null) => {
  const { repos, services, actor } = context;
  const [summaries, users, availability, rows] = await Promise.all([
    loadConversations({ repos, services, actor }),
    repos.users.list(),
    repos.availability.list(),
    // The jobs a new conversation may be ABOUT: this actor's own, so a
    // technician cannot start a thread naming a job they may not read.
    loadJobList(repos, actor),
  ]);

  /*
   * A thread is only served to somebody in it.
   *
   * `loadConversations` returns this actor's threads; asking for a conversation
   * id that is not among them is answered as not found rather than as refused,
   * for the same reason a job is.
   */
  if (
    conversationId !== null &&
    !summaries.some((summary) => summary.conversation.id === conversationId)
  ) {
    throw notFound('That conversation does not exist.');
  }

  /*
   * WHICH THREAD IS OPEN IS DECIDED HERE, not on the screen.
   *
   * The screen opens the most recent conversation when the URL names none, so
   * the server has to send THAT thread — otherwise the list shows a
   * conversation selected and the pane beside it shows nothing. The id it chose
   * comes back with it, so the two cannot disagree.
   */
  const selectedId = conversationId ?? summaries[0]?.conversation.id ?? null;
  const thread =
    selectedId === null ? [] : await repos.chat.listMessages(selectedId);

  return {
    summaries,
    users,
    availability,
    thread,
    selectedId,
    jobs: rows.map((row) => row.job),
  };
};

export const shellView = async ({ repos, actor }: ViewContext) => {
  const [notifications, messages] = await Promise.all([
    repos.notifications.list(actor.id),
    repos.chat.listMessagesFor(actor.id),
  ]);
  return {
    unreadNotifications: notifications.filter((entry) => entry.readAt === null).length,
    unreadMessages: messages.filter(
      (message) => message.senderId !== actor.id && !message.readBy.includes(actor.id),
    ).length,
  };
};
