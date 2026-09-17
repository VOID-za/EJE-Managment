import { contactFullName, machineDisplayName, userFullName } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * Global search.
 *
 * Runs across jobs, customers, sites, machines, technicians and library
 * documents, returning typed, categorised results. In Phase 2 the same result
 * shape is produced by a PostgreSQL full-text query; the UI is unaffected.
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
  term: string,
): Promise<readonly SearchResult[]> => {
  const needle = term.trim().toLowerCase();
  if (needle.length === 0) return [];

  const [jobs, customers, sites, contacts, machines, users, documents] = await Promise.all([
    repos.jobs.list(),
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
      results.push({
        id: job.id,
        category: 'job',
        title: job.jobNumber,
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
        { field: 'Email', value: customer.email },
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
        title: machineDisplayName(machine),
        subtitle: machine.serialNumber,
        detail: `${customer?.name ?? 'Unknown customer'} · ${machine.machineType}`,
        href: `/machines/${machine.id}`,
        matchedOn: matched,
      });
    }
  }

  for (const user of users) {
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
