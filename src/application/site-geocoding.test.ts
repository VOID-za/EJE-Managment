import { beforeEach, describe, expect, it } from 'vitest';
import { createCustomer, updateSite } from './customer-operations';
import { createJob, type NewJobInput } from './job-creation';
import { assignPrimaryTechnician } from './job-operations';
import { requeueUnpinnedSites, verifySiteLocation, geocodeDueSitesInline, listSitesNeedingAttention } from './site-geocoding';
import { buildHarness, seedUser, type Harness } from './test-harness';
import type { GeocodingService } from '@/services/ports';
import { siteLocationOf, siteNavigationTarget, type GeocodeAnswer, type Site } from '@/domain';

/**
 * INT-MAP-1..3, end to end on the application: a site's pin is found from its
 * saved address when the address is written or changed — never otherwise —
 * answered from the cache for the same address, never paid for past the daily
 * cap, never replacing a pin the office verified, and the job's technician is
 * sent to the JOB'S site.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

/** A geocoder that answers from a script and counts the questions. */
const scripted = (answers: Record<string, Partial<GeocodeAnswer>> = {}, limit = 500) => {
  const asked: string[] = [];
  const service: GeocodingService = {
    configured: true,
    provider: 'google',
    region: 'za',
    dailyLimit: limit,
    geocode: (query) => {
      asked.push(query);
      const key = Object.keys(answers).find((fragment) => query.includes(fragment));
      return Promise.resolve({
        outcome: 'match',
        latitude: -26.2745,
        longitude: 28.198,
        formattedAddress: `${query} (Google)`,
        placeId: 'place-1',
        precision: 'ROOFTOP',
        provider: 'google',
        error: '',
        ...(key === undefined ? {} : answers[key]),
      });
    },
  };
  return { service, asked };
};

const NEW_SITE = {
  name: 'Benoni Works',
  addressLine1: '12 Tom Jones Street',
  addressLine2: '',
  city: 'Benoni',
  province: 'Gauteng',
  postalCode: '1501',
  accessNotes: '',
};

const newCustomer = (harness: Harness, site = NEW_SITE, name = 'Benoni Castings (Pty) Ltd') =>
  createCustomer(harness.as(coordinator), {
    name,
    accountNumber: '',
    registrationNumber: '',
    vatNumber: '',
    phone: '011 000 0000',
    email: '',
    industry: 'Foundry',
    paymentTerms: '30 days',
    site,
    contact: { firstName: 'Lindiwe', lastName: 'Khumalo', position: 'Engineer', email: 'lindiwe@benoni-castings.example', phone: '082 000 0000', isPrimary: true },
  });

describe('Workflow A — a new customer and site', () => {
  it('geocodes the site automatically, the office verifies it, and a job there carries those coordinates to the technician', async () => {
    const { service, asked } = scripted();
    const harness = buildHarness({ geocoding: service });

    const created = await newCustomer(harness);
    expect(asked).toEqual(['12 Tom Jones Street, Benoni, Gauteng, 1501, South Africa']);
    const found = (await harness.repos.customers.findSiteById(created.site.id))!;
    expect(siteLocationOf(found)).toMatchObject({ status: 'resolved', source: 'geocoded', provider: 'google', placeId: 'place-1' });
    expect([found.latitude, found.longitude]).toEqual([-26.2745, 28.198]);
    // The office's address is untouched.
    expect(found.addressLine1).toBe('12 Tom Jones Street');

    const verified = await verifySiteLocation(harness.as(master), found.id, { kind: 'current' });
    expect(siteLocationOf(verified)).toMatchObject({ status: 'verified', verifiedBy: master.id });

    const job = await createJob(harness.as(master), {
      customerId: created.customer.id,
      siteId: created.site.id,
      contactId: created.contact!.id,
      machineId: null,
      jobType: 'breakdown',
      priority: 'normal',
      scheduledDate: null,
      scheduledEndDate: null,
      orderNumber: '',
      referenceNumber: '',
      faultDescription: 'Furnace controller fault.',
      primaryTechnicianId: null,
      additionalTechnicianIds: [],
      courierCollection: false,
      deliveryNote: '',
      attachments: [],
    } as unknown as NewJobInput);
    await assignPrimaryTechnician(harness.as(master), job, technician.id, 'Sipho');
    const jobSite = (await harness.repos.customers.findSiteById(job.siteId))!;
    const target = siteNavigationTarget(jobSite);
    expect(target.kind).toBe('verified_pin');
    expect(target.url).toContain('-26.2745%2C28.198');
    expect(asked).toHaveLength(1); // opening, assigning and navigating asked nothing
  });
});

describe('when the geocoder is asked, and when it is not', () => {
  let harness: Harness;
  let asked: string[];
  let site: Site;
  beforeEach(async () => {
    const geocoder = scripted();
    asked = geocoder.asked;
    harness = buildHarness({ geocoding: geocoder.service });
    site = (await newCustomer(harness)).site;
    site = (await harness.repos.customers.findSiteById(site.id))!;
  });

  it('not for an unchanged address', async () => {
    await updateSite(harness.as(coordinator), { ...site, accessNotes: 'Gate 3, ask for security' });
    expect(asked).toHaveLength(1);
  });

  it('again when the address changes', async () => {
    const moved = await updateSite(harness.as(coordinator), { ...site, addressLine1: '40 Main Reef Road' });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain('40 Main Reef Road');
    expect(siteLocationOf(moved).query).toContain('40 Main Reef Road');
  });

  it('from the cache for the same address at another customer', async () => {
    await newCustomer(harness, { ...NEW_SITE, name: 'Other' }, 'Another Customer');
    expect(asked).toHaveLength(1);
    const events = (await harness.repos.activity.list()).filter((event) => event.type === 'site_location_geocoded');
    expect(events.some((event) => /from the cache/u.test(event.detail))).toBe(true);
  });

  it('a VERIFIED pin is kept when the address changes; the new match waits as a suggestion; the technician is not sent to a stale pin', async () => {
    const verified = await verifySiteLocation(harness.as(master), site.id, { kind: 'manual', latitude: -26.19, longitude: 28.31 });
    await updateSite(harness.as(coordinator), { ...verified, addressLine1: '40 Main Reef Road' });
    const after = (await harness.repos.customers.findSiteById(site.id))!;
    expect([after.latitude, after.longitude]).toEqual([-26.19, 28.31]);
    expect(siteLocationOf(after)).toMatchObject({ status: 'stale', suggestedLatitude: -26.2745 });
    expect(siteNavigationTarget(after).kind).toBe('address');

    const accepted = await verifySiteLocation(harness.as(coordinator), site.id, { kind: 'suggested' });
    expect([accepted.latitude, accepted.longitude]).toEqual([-26.2745, 28.198]);
    expect(siteLocationOf(accepted).status).toBe('verified');
  });

  it('manual coordinates typed in the site dialog are the verified pin', async () => {
    const typed = await updateSite(harness.as(coordinator), { ...site, latitude: -26.5, longitude: 28.5 });
    expect(siteLocationOf(typed)).toMatchObject({ status: 'verified', source: 'manual' });
  });

  it('refuses nonsense coordinates and a technician', async () => {
    await expect(verifySiteLocation(harness.as(master), site.id, { kind: 'manual', latitude: 120, longitude: 28 })).rejects.toThrow(/not valid/u);
    await expect(verifySiteLocation(harness.as(technician), site.id, { kind: 'current' })).rejects.toThrow(/Only the office/u);
  });
});

describe('when the geocoder is unsure, finds nothing, is down, or is not set up', () => {
  it('several matches: a suggestion, no pin, and the address search for the technician', async () => {
    const harness = buildHarness({ geocoding: scripted({ 'Tom Jones': { outcome: 'ambiguous', precision: 'APPROXIMATE' } }).service });
    const { site } = await newCustomer(harness);
    const stored = (await harness.repos.customers.findSiteById(site.id))!;
    expect(stored.latitude).toBeNull();
    expect(siteLocationOf(stored).status).toBe('ambiguous');
    expect(siteNavigationTarget(stored).kind).toBe('address');
    expect((await listSitesNeedingAttention(harness.as(master))).map((entry) => entry.site.id)).toContain(site.id);
  });

  it('no match: says so, and the technician gets the address search', async () => {
    const harness = buildHarness({ geocoding: scripted({ 'Tom Jones': { outcome: 'not_found', latitude: null, longitude: null } }).service });
    const { site } = await newCustomer(harness);
    const stored = (await harness.repos.customers.findSiteById(site.id))!;
    expect(siteLocationOf(stored).status).toBe('not_found');
    expect(siteNavigationTarget(stored).note).toMatch(/Not a verified pin/u);
  });

  it('an outage: retried later, and the site save itself is unaffected', async () => {
    const geocoder = scripted({ 'Tom Jones': { outcome: 'temporary_failure', latitude: null, longitude: null, error: 'Google was unavailable (HTTP 503).' } });
    const harness = buildHarness({ geocoding: geocoder.service });
    const { site } = await newCustomer(harness);
    const stored = (await harness.repos.customers.findSiteById(site.id))!;
    expect(stored.name).toBe('Benoni Works');
    expect(siteLocationOf(stored)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(Date.parse(siteLocationOf(stored).nextAttemptAt!)).toBeGreaterThan(Date.now());
  });

  it('the daily cap: the request over it is not sent to Google, and waits for tomorrow', async () => {
    const geocoder = scripted({}, 1);
    const harness = buildHarness({ geocoding: geocoder.service });
    await newCustomer(harness);
    const second = await newCustomer(harness, { ...NEW_SITE, name: 'B', addressLine1: '99 Other Street' }, 'Second Customer');
    expect(geocoder.asked).toHaveLength(1);
    const stored = (await harness.repos.customers.findSiteById(second.site.id))!;
    expect(siteLocationOf(stored).status).toBe('pending');
    expect(siteLocationOf(stored).error).toMatch(/daily limit/u);
  });

  it('not set up: nothing is asked or paid for, and the site says automatic pins are not set up', async () => {
    const harness = buildHarness();
    const { site } = await newCustomer(harness);
    const stored = (await harness.repos.customers.findSiteById(site.id))!;
    expect(siteLocationOf(stored).status).toBe('not_configured');
    expect(stored.latitude).toBeNull();
  });
});

describe('sites from before the automatic pin', () => {
  it('keep the pins the office entered, and an explicit request finds pins for the rest — never touching a verified one', async () => {
    const geocoder = scripted();
    const harness = buildHarness({ geocoding: geocoder.service });
    const before = await harness.repos.customers.listSites();
    const pinned = before.filter((site) => site.latitude !== null);
    for (const site of pinned) expect(siteLocationOf(site).status).toBe('verified');

    // A site recorded before the automatic pin, with no pin: as a pre-0042 row reads.
    const legacy: Site = { ...before[0]!, id: 'site-legacy-unpinned' as Site['id'], name: 'Old depot', latitude: null, longitude: null, geocode: undefined };
    await harness.repos.customers.saveSite(legacy);
    expect(siteLocationOf(legacy).status).toBe('not_requested');

    const queued = await requeueUnpinnedSites(harness.as(master), 3);
    expect(queued).toBeGreaterThan(0);
    expect(geocoder.asked.length).toBe(queued);
    const found = (await harness.repos.customers.findSiteById(legacy.id))!;
    expect(siteLocationOf(found).status).toBe('resolved');
    for (const site of pinned) {
      const after = (await harness.repos.customers.findSiteById(site.id))!;
      expect([after.latitude, after.longitude]).toEqual([site.latitude, site.longitude]);
    }
    // Nothing more is due.
    expect(await geocodeDueSitesInline(harness.as(master))).toBe(0);
  });
});
