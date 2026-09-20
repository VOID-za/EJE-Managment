import { can, contactFullName, machineLabel, userFullName, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * Global search.
 *
 * Runs across jobs, customers, sites, machines, technicians and library
 * documents, returning typed, categorised results. In Phase 2 the same result
 * shape is produced by a PostgreSQL full-text query; the UI is unaffected.
 *
 * THE ACTOR DECIDES WHAT COMES BACK. This used to take no actor at all, which
 * made it the widest read in the system: one box that returned every user
 * account in the business, and every soft-deleted job, to anybody signed in.
 * Search is not a lesser read than a list screen — it is the same data reached
 * a different way — so it is scoped by the same capabilities, here, where the
 * query is, rather than by whichever page renders the results.
 *
 * What is scoped, and by which EXISTING capability:
 *
 *  - USER ACCOUNTS (`users.manageTechnicians`). People are administered by the
 *    office. A technician looking up a colleague's email address and job title
 *    through the search box is reading the staff register.
 *  - SOFT-DELETED JOBS (`jobs.viewAll`). A deleted job is not live work; the
 *    capability that means "see every job, not only your own" is what decides
 *    whether the archive of mistakes is part of that.
 *
 * What is deliberately NOT changed: which live jobs a technician may find.
 * Whether a technician may open a job they were not sent to is an open question
 * for EJE, and quietly answering it inside a search function is not the way to
 * settle it. Refusal detail is private regardless — search never matched on it
 * and still does not.
 */
export type SearchCategory =
  | 'job'
  | 'customer'
  | 'site'
  | 'machine'
  | 'technician'
  | 'document';

export interface SearchResult {
  readonly id: string;
  readonly category: SearchCategory;
  readonly title: string;
  readonly subtitle: string;
  readonly detail: string;
  readonly href: string;
  /** The field the term actually matched, shown so results never look arbitrary. */
  readonly matchedOn: string;
}

export const CATEGORY_LABELS: Record<SearchCategory, string> = {
  job: 'Jobs',
  customer: 'Customers',
  site: 'Sites',
  machine: 'Machines',
  technician: 'Technicians',
  document: 'Technical Library',
};

interface Candidate {
  readonly field: string;
  readonly value: string;
}

const firstMatch = (candidates: readonly Candidate[], needle: string): string | null => {
  for (const candidate of candidates) {
    if (candidate.value.toLowerCase().includes(needle)) return candidate.field;
  }
  return null;
};

export const runSearch = async (
  repos: RepositoryBundle,
  actor: Pick<User, 'id' | 'role'>,
  term: string,
): Promise<readonly SearchResult[]> => {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return [];

  // Both decided before the reads, so a missing check is a missing variable
  // rather than a filter somebody forgot to apply further down.
  const mayReadEveryJob = can(actor.role, 'jobs.viewAll');
  const mayReadStaffRegister = can(actor.role, 'users.manageTechnicians');

  const [jobs, customers, sites, contacts, machines, users, documents] = await Promise.all([
    // Deleted jobs answer "where did EJE-1065 go?", and the result below is
    // labelled so one can never be mistaken for live work — but only for the
    // office, which is who asks that question.
    repos.jobs.list({ includeDeleted: mayReadEveryJob }),
    repos.customers.list(),
    repos.customers.listSites(),
    repos.customers.listContacts(),
    repos.machines.list(),
    repos.users.list(),
    repos.documents.list(),
  ]);

  const results: SearchResult[] = [];

  for (const job of jobs) {
    const customer = customers.find((candidate) => candidate.id === job.customerId);
    const machine = machines.find((candidate) => candidate.id === job.machineId);
    const site = sites.find((candidate) => candidate.id === job.siteId);
    const technician = users.find((candidate) => candidate.id === job.primaryTechnicianId);

    const matched = firstMatch(
      [
        { field: 'Job number', value: job.jobNumber },
        { field: 'Order number', value: job.orderNumber },
        { field: 'Reference number', value: job.referenceNumber },
        { field: 'Fault description', value: job.faultDescription },
        { field: 'Customer', value: customer?.name ?? '' },
        { field: 'Machine serial number', value: machine?.serialNumber ?? '' },
        { field: 'Technician', value: technician === undefined ? '' : userFullName(technician) },
      ],
      needle,
    );

    if (matched !== null) {
      const inactive =
        job.deletedAt !== null
          ? 'Deleted'
          : job.status === 'cancelled'
            ? 'Cancelled'
            : null;

      results.push({
        id: job.id,
        category: 'job',
        // A job that has left the workflow says so in its title, so a search
        // result can never be mistaken for live work.
        title: inactive === null ? job.jobNumber : `${job.jobNumber} — ${inactive}`,
        subtitle: `${customer?.name ?? 'Unknown customer'} · ${site?.name ?? '—'}`,
        detail:
          job.faultDescription.length > 0 ? job.faultDescription : 'No fault description recorded.',
        href: `/jobs/${job.jobNumber}`,
        matchedOn: matched,
      });
    }
  }

  for (const customer of customers) {
    const customerContacts = contacts.filter((contact) => contact.customerId === customer.id);
    const matched = firstMatch(
      [
        { field: 'Customer name', value: customer.name },
        { field: 'Account number', value: customer.accountNumber },
        { field: 'VAT number', value: customer.vatNumber },
        { field: 'Registration number', value: customer.registrationNumber },
        {
          field: 'Contact',
          value: customerContacts.map((contact) => contactFullName(contact)).join(' '),
        },
      ],
      needle,
    );

    if (matched !== null) {
      results.push({
        id: customer.id,
        category: 'customer',
        title: customer.name,
        subtitle: `${customer.industry} · ${customer.accountNumber}`,
        detail: `${sites.filter((site) => site.customerId === customer.id).length} sites · ${machines.filter((machine) => machine.customerId === customer.id).length} machines`,
        href: `/customers/${customer.id}`,
        matchedOn: matched,
      });
    }
  }

  for (const site of sites) {
    const customer = customers.find((candidate) => candidate.id === site.customerId);
    const matched = firstMatch(
      [
        { field: 'Site name', value: site.name },
        { field: 'Address', value: `${site.addressLine1} ${site.addressLine2} ${site.city}` },
        { field: 'City', value: site.city },
      ],
      needle,
    );

    if (matched !== null) {
      results.push({
        id: site.id,
        category: 'site',
        title: `${customer?.name ?? 'Unknown'} — ${site.name}`,
        subtitle: `${site.city}, ${site.province}`,
        detail: site.addressLine1,
        href: `/customers/${site.customerId}`,
        matchedOn: matched,
      });
    }
  }

  for (const machine of machines) {
    const customer = customers.find((candidate) => candidate.id === machine.customerId);
    const matched = firstMatch(
      [
        { field: 'Serial number', value: machine.serialNumber },
        // The customer's own number is often the ONLY thing they quote on the
        // telephone — "STM2 is down" — so it has to be searchable.
        { field: 'Machine number', value: machine.machineNumber },
        { field: 'Model', value: machine.model },
        { field: 'Manufacturer', value: machine.manufacturer },
        { field: 'Machine type', value: machine.machineType },
        { field: 'Control system', value: machine.controlSystem },
      ],
      needle,
    );

    if (matched !== null) {
      results.push({
        id: machine.id,
        category: 'machine',
        title: machineLabel(machine),
        subtitle: machine.serialNumber,
        detail: `${customer?.name ?? 'Unknown customer'} · ${machine.machineType}`,
        href: `/machines/${machine.id}`,
        matchedOn: matched,
      });
    }
  }

  for (const user of users) {
    // The staff register, not a directory. See the header.
    if (!mayReadStaffRegister) break;
    const matched = firstMatch(
      [
        { field: 'Name', value: userFullName(user) },
        { field: 'Email', value: user.email },
        { field: 'Job title', value: user.jobTitle },
      ],
      needle,
    );

    if (matched !== null) {
      results.push({
        id: user.id,
        category: 'technician',
        title: userFullName(user),
        subtitle: user.jobTitle,
        detail: `${jobs.filter((job) => job.primaryTechnicianId === user.id).length} jobs assigned`,
        href: `/jobs?mine=0`,
        matchedOn: matched,
      });
    }
  }

  for (const document of documents) {
    const matched = firstMatch(
      [
        { field: 'Document name', value: document.name },
        { field: 'Description', value: document.description },
        { field: 'Machine model', value: document.machineModel },
        { field: 'Manufacturer', value: document.manufacturer },
        { field: 'Tag', value: document.tags.join(' ') },
      ],
      needle,
    );

    if (matched !== null) {
      results.push({
        id: document.id,
        category: 'document',
        title: document.name,
        subtitle: `${document.manufacturer} ${document.machineModel} · ${document.version}`,
        detail: document.description,
        href: '/library',
        matchedOn: matched,
      });
    }
  }

  return results;
};
