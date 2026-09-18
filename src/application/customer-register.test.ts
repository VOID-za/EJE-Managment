import { beforeEach, describe, expect, it } from 'vitest';
import {
  createContact,
  createSite,
  removeContact,
  removeSite,
  updateContact,
  updateCustomer,
  updateSite,
} from './customer-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { loadJobView } from './job-view';
import { asCustomerId, asSiteId, contactFullName, type Contact, type Site } from '@/domain';

/**
 * The customer register: contacts, sites and the company itself.
 *
 * What is being proved here is not that a form saves. It is that a removal
 * never destroys the history that refers to the record — the job cards EJE has
 * already handed to customers have to keep reading correctly for ever.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const ABC = asCustomerId('cust-abc');

const findContact = async (harness: Harness, id: string): Promise<Contact | null> =>
  (await harness.repos.customers.listContacts(undefined, { includeArchived: true })).find(
    (contact) => contact.id === id,
  ) ?? null;

const findSite = async (harness: Harness, id: string): Promise<Site | null> =>
  (await harness.repos.customers.listSites(undefined, { includeArchived: true })).find(
    (site) => site.id === id,
  ) ?? null;

describe('contacts', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is added with the role the office actually typed', async () => {
    const contact = await createContact(harness.as(master), ABC, null, {
      firstName: 'Thandi',
      lastName: 'Ngwenya',
      position: 'Maintenance Manager',
      email: 'thandi@abc-engineering-demo.co.za',
      phone: '+27 82 555 0999',
      isPrimary: false,
    });

    expect(contactFullName(contact)).toBe('Thandi Ngwenya');
    expect(contact.position).toBe('Maintenance Manager');
    expect(contact.archivedAt).toBeNull();

    const listed = await harness.repos.customers.listContacts(ABC);
    expect(listed.map((candidate) => candidate.id)).toContain(contact.id);
  });

  it('is edited in place, keeping its identity', async () => {
    const contact = await createContact(harness.as(master), ABC, null, {
      firstName: 'Thandi',
      lastName: 'Ngwenya',
      position: 'Purchasing',
      email: '',
      phone: '',
      isPrimary: false,
    });

    const edited = await updateContact(harness.as(coordinator), {
      ...contact,
      position: 'Finance',
      phone: '+27 11 555 0100',
    });

    expect(edited.id).toBe(contact.id);
    expect(edited.position).toBe('Finance');
    expect((await findContact(harness, contact.id))?.phone).toBe('+27 11 555 0100');
  });

  it('is deleted outright when no job has ever named them', async () => {
    const contact = await createContact(harness.as(master), ABC, null, {
      firstName: 'Once',
      lastName: 'Only',
      position: '',
      email: '',
      phone: '',
      isPrimary: false,
    });

    const result = await removeContact(harness.as(master), contact);

    expect(result.outcome).toBe('deleted');
    expect(await findContact(harness, contact.id)).toBeNull();
  });

  it('is archived, not deleted, when a job names them — and that job still reads', async () => {
    // EJE-1044 is a seeded closed job. Its contact is on its job card.
    const job = await harness.repos.jobs.findByJobNumber('EJE-1044');
    expect(job).not.toBeNull();
    const contact = await harness.repos.customers.findContactById(job!.contactId);
    expect(contact).not.toBeNull();

    const result = await removeContact(harness.as(master), contact!);
    expect(result.outcome).toBe('archived');

    // Gone from the register the office picks from…
    const live = await harness.repos.customers.listContacts(job!.customerId);
    expect(live.map((candidate) => candidate.id)).not.toContain(contact!.id);

    // …but the job still resolves the person who signed for the work.
    const stored = await findContact(harness, contact!.id);
    expect(stored?.archivedAt).not.toBeNull();
    const view = await loadJobView(harness.repos, 'EJE-1044');
    expect(view).not.toBeNull();
    expect(view!.contact?.id).toBe(contact!.id);
  });

  it('is refused to a technician', async () => {
    const contact = (await harness.repos.customers.listContacts(ABC))[0]!;
    await expect(removeContact(harness.as(technician), contact)).rejects.toBeInstanceOf(
      WorkflowError,
    );
    await expect(
      updateContact(harness.as(technician), { ...contact, position: 'Owner' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('sites', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is added and edited by the office', async () => {
    const site = await createSite(harness.as(coordinator), ABC, {
      name: 'Boksburg',
      addressLine1: '14 Anvil Road',
      addressLine2: '',
      city: 'Boksburg',
      province: 'Gauteng',
      postalCode: '1459',
      accessNotes: 'Report to the weighbridge.',
    });

    expect(site.archivedAt).toBeNull();

    const edited = await updateSite(harness.as(coordinator), {
      ...site,
      accessNotes: 'Report to the weighbridge. Hard hat required.',
    });
    expect(edited.accessNotes).toContain('Hard hat');
  });

  it('refuses to remove a site that still has machines on it', async () => {
    const site = await harness.repos.customers.findSiteById(asSiteId('site-abc-jhb'));
    expect(site).not.toBeNull();

    await expect(removeSite(harness.as(master), site!)).rejects.toThrow(/machines/i);
    // Nothing was removed on the way to refusing.
    expect(await findSite(harness, site!.id)).not.toBeNull();
  });

  it('deletes an empty site nothing refers to, and its contacts with it', async () => {
    const site = await createSite(harness.as(master), ABC, {
      name: 'Temporary',
      addressLine1: '1 Nowhere Street',
      addressLine2: '',
      city: 'Springs',
      province: 'Gauteng',
      postalCode: '1559',
      accessNotes: '',
    });
    const contact = await createContact(harness.as(master), ABC, site.id, {
      firstName: 'Site',
      lastName: 'Contact',
      position: 'Operations',
      email: '',
      phone: '',
      isPrimary: false,
    });

    const result = await removeSite(harness.as(master), site);

    expect(result.outcome).toBe('deleted');
    expect(await findSite(harness, site.id)).toBeNull();
    expect(await findContact(harness, contact.id)).toBeNull();
  });

  it('archives a site that has job history, and that job still reads', async () => {
    const job = await harness.repos.jobs.findByJobNumber('EJE-1044');
    const site = await harness.repos.customers.findSiteById(job!.siteId);
    expect(site).not.toBeNull();

    // Clear the machines standing at it; the refusal above is a separate rule.
    const machines = await harness.repos.machines.list();
    for (const machine of machines.filter((candidate) => candidate.siteId === site!.id)) {
      await harness.repos.machines.save({ ...machine, siteId: asSiteId('site-abc-pta') });
    }

    const result = await removeSite(harness.as(master), site!);
    expect(result.outcome).toBe('archived');

    const live = await harness.repos.customers.listSites(job!.customerId);
    expect(live.map((candidate) => candidate.id)).not.toContain(site!.id);

    const view = await loadJobView(harness.repos, 'EJE-1044');
    expect(view).not.toBeNull();
    expect(view!.site.id).toBe(site!.id);
  });

  it('is refused to a technician', async () => {
    const site = (await harness.repos.customers.listSites(ABC))[0]!;
    await expect(removeSite(harness.as(technician), site)).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('company details', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('keeps an office address that is separate from any site', async () => {
    const customer = await harness.repos.customers.findById(ABC);
    expect(customer).not.toBeNull();

    const saved = await updateCustomer(harness.as(coordinator), {
      ...customer!,
      officeAddress: {
        line1: '400 Corporate Park',
        line2: 'Block C',
        city: 'Sandton',
        province: 'Gauteng',
        postalCode: '2196',
      },
    });

    expect(saved.officeAddress.city).toBe('Sandton');
    // The sites are untouched: an office is not a site.
    const sites = await harness.repos.customers.listSites(ABC);
    expect(sites.every((site) => site.city !== 'Sandton')).toBe(true);
  });

  it('is refused to a technician', async () => {
    const customer = await harness.repos.customers.findById(ABC);
    await expect(
      updateCustomer(harness.as(technician), { ...customer!, name: 'Renamed' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});
