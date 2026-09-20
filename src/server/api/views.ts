import 'server-only';
import {
  asCustomerId,
  asMachineId,
  asUserId,
  can,
  isJobOpenWork,
  machineDisplayName,
  type Machine,
  type TemplateUsage,
  type User,
} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import { loadActivityFeed, loadJobActivity } from '@/application/activity-read';
import { loadCalendar } from '@/application/calendar';
import { loadClosedJobs, type ClosedJobFilters } from '@/application/closed-jobs';
import { loadConversations } from '@/application/chat-operations';
import { loadJobList, loadJobRows, loadJobView } from '@/application/job-view';
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

/** An office screen. Refused server-side, not merely hidden in the sidebar. */
const requireOffice = (actor: User, capability: Parameters<typeof can>[1], what: string): void => {
  if (!can(actor.role, capability)) {
    throw forbidden(`${what} is an office screen.`, [
      { code: 'not_permitted', message: 'Your role does not have access to this.' },
    ]);
  }
};

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

export const jobsView = async ({ repos, actor }: ViewContext) => ({
  rows: await loadJobList(repos, actor),
});

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

  const [users, activity] = await Promise.all([
    repos.users.list(),
    loadJobActivity(repos, actor, view.job.id),
  ]);
  return { view, users, activity };
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

export const customersView = async ({ repos, actor }: ViewContext) => {
  requireOffice(actor, 'customers.manage', 'The customer register');
  const [customers, sites, machines, jobs] = await Promise.all([
    repos.customers.list(),
    repos.customers.listSites(),
    repos.machines.list(),
    repos.jobs.list(),
  ]);

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

export const customerView = async ({ repos, actor }: ViewContext, customerId: string) => {
  requireOffice(actor, 'customers.manage', 'The customer record');
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
    jobRows: await loadJobRows(repos, jobs, actor),
    users,
  };
};

export const machinesView = async ({ repos, actor }: ViewContext) => {
  requireOffice(actor, 'machines.manage', 'The machine register');
  const [machines, customers, sites, jobs] = await Promise.all([
    repos.machines.list(),
    repos.customers.list(),
    repos.customers.listSites(),
    repos.jobs.list(),
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
 * The job list is `loadJobRows` WITH the actor, so a technician reaching a
 * machine they have worked sees its finished history with the prices suppressed
 * — DECISION 5 — rather than the office's view of it.
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
    jobRows: await loadJobRows(repos, jobs, actor),
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

export const calendarView = ({ repos, actor }: ViewContext, from: string, to: string) => {
  requireOffice(actor, 'availability.manage', 'The calendar');
  return loadCalendar(repos, { from, to });
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
