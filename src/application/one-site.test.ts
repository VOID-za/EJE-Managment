import { beforeEach, describe, expect, it } from 'vitest';
import {
  asCustomerId,
  asSiteId,
  checkCoordinates,
  customerSiteState,
  siteMapUrl,
  type Contact,
  type Site,
} from '@/domain';
import {
  consolidateCustomerSites,
  createContact,
  createCustomer,
  createSite,
  updateContact,
  updateSite,
} from './customer-operations';
import { createJob } from './job-creation';
import { loadJobView } from './job-view';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * ONE SITE PER CUSTOMER (SITE-1), the deliberate consolidation of legacy
 * multi-site customers (SITE-2), the customer's location (SITE-3) and the
 * contact-site defect (CONTACT-SITE-1).
 *
 * Seeded facts: `cust-abc` was recorded with THREE sites before the rule —
 * Johannesburg, Pretoria and Germiston — each with a machine and a contact,
 * plus a head-office contact; every other customer has one site.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const refusal = async (work: Promise<unknown>): Promise<WorkflowError> => {
  const error = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(WorkflowError);
  return error as WorkflowError;
};
const codes = (error: WorkflowError) => error.violations.map((violation) => violation.code);

const NEW_SITE = {
  name: 'Boksburg',
  addressLine1: '14 Anvil Road',
  addressLine2: '',
  city: 'Boksburg',
  province: 'Gauteng',
  postalCode: '1459',
  accessNotes: '',
};

describe('SITE-1: a customer has one site', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a second site for a customer that already has one, on the server', async () => {
    const error = await refusal(createSite(harness.as(master), asCustomerId('cust-kruger'), NEW_SITE));
    expect(codes(error)).toEqual(['customer_has_site']);
    expect(await harness.repos.customers.listSites(asCustomerId('cust-kruger'))).toHaveLength(1);
  });

  it('refuses another site for a legacy customer too — legacy is never added to', async () => {
    const error = await refusal(createSite(harness.as(master), asCustomerId('cust-abc'), NEW_SITE));
    expect(codes(error)).toEqual(['customer_has_site']);
  });

  it('a new customer is created with exactly its one site, and keeps several contacts', async () => {
    const context = harness.as(coordinator);
    const created = await createCustomer(context, {
      name: 'Zenith Precision Works',
      accountNumber: 'ZEN001',
      registrationNumber: '',
      vatNumber: '',
      phone: '',
      email: '',
      industry: 'Machining',
      paymentTerms: '30 days',
      site: { ...NEW_SITE, name: 'Main works' },
      contact: { firstName: 'Ann', lastName: 'Botha', position: '', email: '', phone: '', isPrimary: true },
    });
    await createContact(context, created.customer.id, created.site.id, {
      firstName: 'Ben', lastName: 'Dube', position: '', email: '', phone: '', isPrimary: false,
    });
    await createContact(context, created.customer.id, null, {
      firstName: 'Cara', lastName: 'Naidoo', position: '', email: '', phone: '', isPrimary: false,
    });

    const sites = await harness.repos.customers.listSites(created.customer.id);
    expect(sites).toHaveLength(1);
    expect(customerSiteState(sites, created.customer.id).kind).toBe('single');
    expect(await harness.repos.customers.listContacts(created.customer.id)).toHaveLength(3);
  });

  it('a customer whose only site was archived may be given its site again', async () => {
    const kruger = asCustomerId('cust-kruger');
    const [site] = await harness.repos.customers.listSites(kruger);
    await harness.repos.customers.saveSite({ ...site!, archivedAt: '2026-10-01T08:00:00.000Z' });
    const added = await createSite(harness.as(master), kruger, NEW_SITE);
    expect(customerSiteState(await harness.repos.customers.listSites(kruger), kruger)).toEqual({
      kind: 'single',
      site: added,
    });
  });
});

describe('SITE-2: a legacy customer is consolidated only by the office’s choice', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });
  const abc = asCustomerId('cust-abc');

  it('nothing consolidates on its own: the seeded legacy customer still has three sites', async () => {
    const state = customerSiteState(await harness.repos.customers.listSites(abc), abc);
    expect(state.kind).toBe('legacy_multiple');
  });

  it('keeps the chosen site; moves machines (recorded) and contacts; archives the rest; leaves every job alone', async () => {
    const jobsBefore = (await harness.repos.jobs.list())
      .filter((job) => job.customerId === abc)
      .map((job) => ({ number: job.jobNumber, siteId: job.siteId }));
    expect(jobsBefore.some((job) => job.siteId !== 'site-abc-jhb')).toBe(true);

    const result = await consolidateCustomerSites(harness.as(master), abc, asSiteId('site-abc-jhb'));
    expect(result).toMatchObject({ archivedSites: 2, movedMachines: 2, movedContacts: 2 });

    // One active site, and the other two kept — archived, never deleted.
    const active = await harness.repos.customers.listSites(abc);
    expect(active.map((site) => site.id)).toEqual(['site-abc-jhb']);
    const all = await harness.repos.customers.listSites(abc, { includeArchived: true });
    expect(all.map((site) => site.id).sort()).toEqual(['site-abc-ger', 'site-abc-jhb', 'site-abc-pta']);

    // Machines moved, each with a movement saying where it came from.
    for (const [id, from] of [['machine-abc-st20', 'site-abc-pta'], ['machine-abc-mcv760', 'site-abc-ger']] as const) {
      const machine = await harness.repos.machines.findById(id as never);
      expect(machine?.siteId).toBe('site-abc-jhb');
      const [movement] = await harness.repos.machines.listMovements(id as never);
      expect(movement).toMatchObject({ fromSiteId: from, toSiteId: 'site-abc-jhb' });
      expect(movement!.note).toContain('consolidated to one site');
    }

    // Contacts kept and moved; the head-office contact untouched.
    const contacts = await harness.repos.customers.listContacts(abc);
    expect(contacts).toHaveLength(4);
    expect(contacts.find((contact) => contact.id === 'contact-abc-pta')?.siteId).toBe('site-abc-jhb');
    expect(contacts.find((contact) => contact.id === 'contact-abc-head')?.siteId).toBeNull();

    // EVERY JOB KEEPS THE SITE IT WAS DONE AT, and still reads its name.
    const jobsAfter = (await harness.repos.jobs.list())
      .filter((job) => job.customerId === abc)
      .map((job) => ({ number: job.jobNumber, siteId: job.siteId }));
    expect(jobsAfter).toEqual(jobsBefore);
    const atPretoria = jobsBefore.find((job) => job.siteId === 'site-abc-pta');
    if (atPretoria !== undefined) {
      const view = await loadJobView(harness.repos, atPretoria.number);
      expect(view?.site.name).toBe('Pretoria');
    }

    // And the trail says what happened.
    const trail = (await harness.repos.activity.list()).map((event) => event.summary);
    expect(trail).toContain('Customer consolidated to one site: ABC Engineering (Pty) Ltd');
  });

  it('refuses a site of another customer, a second consolidation, and a technician', async () => {
    expect(codes(await refusal(
      consolidateCustomerSites(harness.as(master), abc, asSiteId('site-kruger-main')),
    ))).toEqual(['site_not_of_customer']);

    await consolidateCustomerSites(harness.as(master), abc, asSiteId('site-abc-pta'));
    expect(codes(await refusal(
      consolidateCustomerSites(harness.as(master), abc, asSiteId('site-abc-pta')),
    ))).toEqual(['already_single_site']);

    const fresh = buildHarness();
    expect(codes(await refusal(
      consolidateCustomerSites(fresh.as(technician), abc, asSiteId('site-abc-jhb')),
    ))).toEqual(['not_permitted']);
  });
});

describe('CONTACT-SITE-1: changing a contact’s site is saved, and checked', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });
  const contact = async (id: string): Promise<Contact> =>
    (await harness.repos.customers.findContactById(id as never))!;

  it('moves a contact to another of its customer’s sites, and to head office', async () => {
    const pta = await contact('contact-abc-pta');
    await updateContact(harness.as(coordinator), { ...pta, siteId: asSiteId('site-abc-ger') });
    expect((await contact('contact-abc-pta')).siteId).toBe('site-abc-ger');

    await updateContact(harness.as(coordinator), { ...(await contact('contact-abc-pta')), siteId: null });
    expect((await contact('contact-abc-pta')).siteId).toBeNull();

    const changes = (await harness.repos.activity.list())
      .filter((event) => event.type === 'contact_updated')
      .flatMap((event) => event.changes ?? []);
    expect(changes).toContainEqual({ field: 'Site', from: 'Pretoria', to: 'Germiston' });
    expect(changes).toContainEqual({ field: 'Site', from: 'Germiston', to: 'Head office' });
  });

  it('refuses another customer’s site, on edit and on add', async () => {
    const pta = await contact('contact-abc-pta');
    expect(codes(await refusal(
      updateContact(harness.as(master), { ...pta, siteId: asSiteId('site-kruger-main') }),
    ))).toEqual(['site_not_of_customer']);
    expect((await contact('contact-abc-pta')).siteId).toBe('site-abc-pta');

    expect(codes(await refusal(
      createContact(harness.as(master), asCustomerId('cust-abc'), asSiteId('site-kruger-main'), {
        firstName: 'X', lastName: 'Y', position: '', email: '', phone: '', isPrimary: false,
      }),
    ))).toEqual(['site_not_of_customer']);
  });

  it('cannot move a contact to another customer by editing it', async () => {
    const pta = await contact('contact-abc-pta');
    await updateContact(harness.as(master), {
      ...pta,
      customerId: asCustomerId('cust-kruger'),
      siteId: null,
    });
    expect((await contact('contact-abc-pta')).customerId).toBe('cust-abc');
  });
});

describe('SITE-3: the site’s location', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });
  const site = async (): Promise<Site> =>
    (await harness.repos.customers.findSiteById(asSiteId('site-midrand-main')))!;

  it('pins a valid coordinate, rounded to six decimals, and audits the change', async () => {
    const before = await site();
    await updateSite(harness.as(coordinator), { ...before, latitude: -25.99712345, longitude: 28.1265 });
    const after = await site();
    expect([after.latitude, after.longitude]).toEqual([-25.997123, 28.1265]);
    const event = (await harness.repos.activity.list()).find((entry) => entry.type === 'site_updated');
    expect(event?.changes).toEqual([
      { field: 'Location', from: before.latitude === null ? 'Not pinned' : `${before.latitude}, ${before.longitude}`, to: '-25.997123, 28.1265' },
    ]);
  });

  it('refuses half a coordinate and one off the globe; clearing both is allowed', async () => {
    const before = await site();
    expect(codes(await refusal(updateSite(harness.as(master), { ...before, latitude: -26, longitude: null }))))
      .toEqual(['coordinates_incomplete']);
    expect(codes(await refusal(updateSite(harness.as(master), { ...before, latitude: -126, longitude: 28 }))))
      .toEqual(['latitude_out_of_range']);
    expect(codes(await refusal(updateSite(harness.as(master), { ...before, latitude: -26, longitude: 228 }))))
      .toEqual(['longitude_out_of_range']);
    await updateSite(harness.as(master), { ...before, latitude: null, longitude: null });
    expect((await site()).latitude).toBeNull();
  });

  it('an edit cannot move the site to another customer or un-archive it', async () => {
    const before = await site();
    await updateSite(harness.as(master), { ...before, customerId: asCustomerId('cust-abc') });
    expect((await site()).customerId).toBe('cust-midrand');
  });

  it('a technician cannot change it', async () => {
    expect(codes(await refusal(updateSite(harness.as(technician), { ...(await site()), latitude: 1, longitude: 1 }))))
      .toEqual(['not_permitted']);
  });

  it('the map link uses the pin when there is one, and the address otherwise — never an invented point', () => {
    const base = {
      id: asSiteId('s'), customerId: asCustomerId('c'), name: 'Main', addressLine1: '5 Gemini Road',
      addressLine2: '', city: 'Midrand', province: 'Gauteng', postalCode: '1685', accessNotes: '',
      archivedAt: null,
    };
    expect(siteMapUrl({ ...base, latitude: -25.99, longitude: 28.12 }))
      .toBe('https://www.google.com/maps/search/?api=1&query=-25.99%2C28.12');
    expect(siteMapUrl({ ...base, latitude: null, longitude: null }))
      .toBe('https://www.google.com/maps/search/?api=1&query=5%20Gemini%20Road%2C%20Midrand%2C%201685');
    expect(checkCoordinates(Number.NaN, 1).ok).toBe(false);
  });
});

describe('SITE-1 on a new job: the customer’s site, validated on the server', () => {
  it('a job is raised at the customer’s one site, and refused at another customer’s', async () => {
    const harness = buildHarness();
    const input = {
      customerId: asCustomerId('cust-midrand'),
      siteId: asSiteId('site-midrand-main'),
      contactId: 'contact-midrand-main' as never,
      machineId: null,
      jobType: 'breakdown' as const,
      priority: 'normal' as const,
      scheduledDate: null,
      scheduledEndDate: null,
      additionalTechnicianIds: [],
      orderNumber: '',
      referenceNumber: '',
      faultDescription: 'Light curtain faulting.',
      primaryTechnicianId: null,
      courierCollection: false,
    };
    const job = await createJob(harness.as(master), input as never);
    expect(job.siteId).toBe('site-midrand-main');

    expect(codes(await refusal(
      createJob(harness.as(master), { ...input, siteId: asSiteId('site-kruger-main') } as never),
    ))).toEqual(['site_not_of_customer']);
  });
});
