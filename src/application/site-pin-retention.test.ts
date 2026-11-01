import { describe, expect, it } from 'vitest';
import { createCustomer, updateSite } from './customer-operations';
import { geocodeDueSitesInline, maintainSiteProviderContent, verifySiteLocation } from './site-geocoding';
import { buildHarness, seedUser, type Harness } from './test-harness';
import type { Clock, GeocodingService } from '@/services/ports';
import {
  siteLocationOf,
  siteNavigationTarget,
  type GeocodeAnswer,
  type IsoDateTime,
  type Site,
} from '@/domain';

/**
 * PIN RETENTION — the owner's decision (1 November 2026), made compliant with
 * the Google Maps Platform terms (Service Specific Terms §6.3.1: Geocoding API
 * latitude/longitude may be cached for at most 30 consecutive calendar days,
 * then deleted; place IDs are exempt). See docs/integrations-setup.md §4.6.
 *
 *  - office-entered pins are kept, and never replaced by a geocoding result;
 *  - a verified GOOGLE pin is refreshed by its place ID before day 30 and
 *    stays verified only if the place has not moved;
 *  - unverified pins are looked up again from the address;
 *  - Google's coordinates are deleted at day 30 whatever happens, and never
 *    written to the permanent audit trail or into a stored link;
 *  - an address change flags a verified pin for the office.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

class MovableClock implements Clock {
  constructor(private current: number) {}
  now(): IsoDateTime {
    return new Date(this.current).toISOString() as IsoDateTime;
  }
  advanceDays(days: number): void {
    this.current += days * 24 * 3600_000;
  }
}

/** Google, scripted: by address, and by place ID. Counts every question. */
const google = (point = { latitude: -26.2745, longitude: 28.198 }) => {
  const asked: string[] = [];
  const state = { point, placeOutcome: 'match' as GeocodeAnswer['outcome'] };
  const answer = (extra: Partial<GeocodeAnswer>): GeocodeAnswer => ({
    outcome: 'match',
    latitude: state.point.latitude,
    longitude: state.point.longitude,
    formattedAddress: '12 Tom Jones St, Benoni, 1501, South Africa',
    placeId: 'ChIJ-benoni-works',
    precision: 'ROOFTOP',
    provider: 'google',
    error: '',
    ...extra,
  });
  const service: GeocodingService = {
    configured: true,
    provider: 'google',
    region: 'za',
    dailyLimit: 500,
    geocode: (query) => {
      asked.push(`address:${query}`);
      return Promise.resolve(answer({}));
    },
    geocodePlace: (placeId) => {
      asked.push(`place:${placeId}`);
      return Promise.resolve(
        state.placeOutcome === 'match' ? answer({ placeId }) : answer({ outcome: state.placeOutcome, latitude: null, longitude: null, placeId: null }),
      );
    },
  };
  return { service, asked, state };
};

const SITE = {
  name: 'Benoni Works',
  addressLine1: '12 Tom Jones Street',
  addressLine2: '',
  city: 'Benoni',
  province: 'Gauteng',
  postalCode: '1501',
  accessNotes: '',
};

const setup = async (options: { configured?: boolean } = {}) => {
  const clock = new MovableClock(Date.parse('2026-11-01T08:00:00.000Z'));
  const geocoder = google();
  const harness: Harness = buildHarness({ clock, ...(options.configured === false ? {} : { geocoding: geocoder.service }) });
  const created = await createCustomer(harness.as(coordinator), {
    name: 'Benoni Castings (Pty) Ltd',
    accountNumber: '',
    registrationNumber: '',
    vatNumber: '',
    phone: '011 000 0000',
    email: '',
    industry: 'Foundry',
    paymentTerms: '30 days',
    site: SITE,
    contact: { firstName: 'Lindiwe', lastName: 'Khumalo', position: 'Engineer', email: 'lindiwe@benoni-castings.example', phone: '082 000 0000', isPrimary: true },
  });
  const read = async (): Promise<Site> => (await harness.repos.customers.findSiteById(created.site.id))!;
  /** The worker's minute: the 30-day maintenance, then whatever is due. */
  const tick = async () => {
    const context = { ...harness.as(master), deferDelivery: false };
    await maintainSiteProviderContent(context);
    await geocodeDueSitesInline(context);
  };
  return { harness, clock, geocoder, read, tick, siteId: created.site.id };
};

/** Google switched off (the key removed): the 30-day deletion must still happen. */
const switchOffGoogle = (harness: Harness): void => {
  (harness.services as { geocoding?: GeocodingService }).geocoding = undefined;
};

const auditText = async (harness: Harness): Promise<string> => JSON.stringify(await harness.repos.activity.list());

describe('what is stored from Google at all', () => {
  it('keeps the coordinates and the place ID, but not the formatted address or the precision', async () => {
    const { read } = await setup();
    const site = await read();
    expect(siteLocationOf(site)).toMatchObject({ status: 'resolved', source: 'geocoded', placeId: 'ChIJ-benoni-works', formattedAddress: '', precision: null });
    expect([site.latitude, site.longitude]).toEqual([-26.2745, 28.198]);
  });

  it('never writes Google’s coordinates to the permanent audit trail', async () => {
    const { harness, read, siteId } = await setup();
    await verifySiteLocation(harness.as(master), siteId, { kind: 'current' });
    expect(siteLocationOf(await read()).status).toBe('verified');
    const trail = await auditText(harness);
    expect(trail).not.toContain('-26.2745');
    expect(trail).not.toContain('28.198');
    expect(trail).toContain('coordinates are not kept in the log');
  });

  it('links a technician to a Google pin by its PLACE, never by its coordinates', async () => {
    const { harness, read, siteId } = await setup();
    await verifySiteLocation(harness.as(master), siteId, { kind: 'current' });
    const target = siteNavigationTarget(await read());
    expect(target.kind).toBe('verified_pin');
    expect(target.url).toContain('destination_place_id=ChIJ-benoni-works');
    expect(target.url).not.toContain('-26.2745');
  });

  it('caches an answer without the wording either', async () => {
    const { harness } = await setup();
    const cached = await harness.repos.integrations.findGeocode('za|12 tom jones street benoni gauteng 1501 south africa', harness.services.clock.now());
    expect(cached).not.toBeNull();
    expect(cached?.result).toMatchObject({ formattedAddress: '', precision: null });
  });
});

describe('an office-verified pin entered by hand', () => {
  it('is kept indefinitely — the maintenance never touches it — and is linked by its coordinates', async () => {
    const { harness, clock, read, siteId, tick } = await setup();
    await verifySiteLocation(harness.as(master), siteId, { kind: 'manual', latitude: -26.19, longitude: 28.31 });
    clock.advanceDays(400);
    await tick();
    const site = await read();
    expect([site.latitude, site.longitude]).toEqual([-26.19, 28.31]);
    expect(siteLocationOf(site)).toMatchObject({ status: 'verified', source: 'manual', verifiedBy: master.id });
    expect(siteNavigationTarget(site).url).toContain('-26.19%2C28.31');
  });

  it('is never replaced by a geocoding result: a new match waits as a suggestion', async () => {
    const { harness, geocoder, read, siteId } = await setup();
    await verifySiteLocation(harness.as(master), siteId, { kind: 'manual', latitude: -26.19, longitude: 28.31 });
    geocoder.state.point = { latitude: -26.5, longitude: 28.5 };
    const moved = await updateSite(harness.as(coordinator), { ...(await read()), addressLine1: '40 Main Reef Road' });
    expect([moved.latitude, moved.longitude]).toEqual([-26.19, 28.31]);
    expect(siteLocationOf(moved)).toMatchObject({ status: 'stale', source: 'manual', suggestedLatitude: -26.5, suggestedLongitude: 28.5 });
    // The address change is flagged for the office, and the technician is not sent to the old pin.
    expect(siteNavigationTarget(moved).kind).toBe('address');
  });

  it('keeps its own coordinates when Google’s suggestion beside it is deleted at day 30', async () => {
    const { harness, clock, geocoder, read, siteId, tick } = await setup({});
    await verifySiteLocation(harness.as(master), siteId, { kind: 'manual', latitude: -26.19, longitude: 28.31 });
    geocoder.state.point = { latitude: -26.5, longitude: 28.5 };
    await updateSite(harness.as(coordinator), { ...(await read()), addressLine1: '40 Main Reef Road' });
    switchOffGoogle(harness); // Google switched off: the deletion still happens
    clock.advanceDays(31);
    await tick();
    const site = await read();
    expect([site.latitude, site.longitude]).toEqual([-26.19, 28.31]);
    expect(siteLocationOf(site)).toMatchObject({ status: 'stale', suggestedLatitude: null, suggestedLongitude: null });
  });
});

describe('a verified pin from Google', () => {
  it('is refreshed by its place ID from day 27, and stays verified when the place has not moved', async () => {
    const { harness, clock, geocoder, read, siteId, tick } = await setup();
    await verifySiteLocation(harness.as(master), siteId, { kind: 'current' });
    geocoder.state.point = { latitude: -26.27451, longitude: 28.19801 }; // ~1 m
    clock.advanceDays(26);
    await tick();
    expect(geocoder.asked.filter((q) => q.startsWith('place:'))).toHaveLength(0);
    clock.advanceDays(1.5);
    await tick();
    expect(geocoder.asked).toContain('place:ChIJ-benoni-works');
    const site = await read();
    expect(siteLocationOf(site)).toMatchObject({ status: 'verified', source: 'geocoded', verifiedBy: master.id, placeId: 'ChIJ-benoni-works' });
    expect([site.latitude, site.longitude]).toEqual([-26.27451, 28.19801]);
    expect(siteLocationOf(site).geocodedAt).toBe(clock.now());
    // Renewed: well past the first 30 days, still there.
    clock.advanceDays(10);
    await tick();
    expect((await read()).latitude).toBe(-26.27451);
  });

  it('is NOT silently replaced when Google now puts the place elsewhere: the office reviews it', async () => {
    const { harness, clock, geocoder, read, siteId, tick } = await setup();
    await verifySiteLocation(harness.as(master), siteId, { kind: 'current' });
    geocoder.state.point = { latitude: -26.2845, longitude: 28.198 }; // ~1.1 km
    clock.advanceDays(28);
    await tick();
    const site = await read();
    expect(siteLocationOf(site).status).toBe('stale');
    expect([site.latitude, site.longitude]).toEqual([null, null]);
    expect(siteLocationOf(site)).toMatchObject({ suggestedLatitude: -26.2845, suggestedLongitude: 28.198, verifiedBy: master.id });
    expect(siteLocationOf(site).error).toMatch(/\d+ m from the pin the office verified/);
    expect(siteNavigationTarget(site).kind).toBe('address');
  });

  it('loses its coordinates at day 30 when it could not be refreshed — but keeps the verified place for navigation', async () => {
    const { harness, clock, read, siteId, tick } = await setup();
    await verifySiteLocation(harness.as(master), siteId, { kind: 'current' });
    switchOffGoogle(harness); // the key was removed
    clock.advanceDays(30);
    await tick();
    const site = await read();
    expect([site.latitude, site.longitude]).toEqual([null, null]);
    expect(siteLocationOf(site)).toMatchObject({ status: 'verified', source: 'geocoded', placeId: 'ChIJ-benoni-works', verifiedBy: master.id });
    expect(siteLocationOf(site).error).toContain('deleted after 30 days');
    const target = siteNavigationTarget(site);
    expect(target.kind).toBe('verified_pin');
    expect(target.url).toContain('destination_place_id=ChIJ-benoni-works');
    expect(await auditText(harness)).toContain('deleted after 30 days');
  });

  it('a place Google no longer knows goes to the office, and is not asked about again', async () => {
    const { harness, clock, geocoder, read, siteId, tick } = await setup();
    await verifySiteLocation(harness.as(master), siteId, { kind: 'current' });
    geocoder.state.placeOutcome = 'not_found';
    clock.advanceDays(28);
    await tick();
    await tick();
    expect(geocoder.asked.filter((q) => q.startsWith('place:'))).toHaveLength(1);
    expect(siteLocationOf(await read()).status).toBe('stale');
  });
});

describe('an unverified pin from Google', () => {
  it('is looked up again from the address before day 30, and the new answer is used', async () => {
    const { clock, geocoder, read, tick } = await setup();
    geocoder.state.point = { latitude: -26.3, longitude: 28.2 };
    clock.advanceDays(28);
    await tick();
    expect(geocoder.asked.filter((q) => q.startsWith('address:'))).toHaveLength(2);
    const site = await read();
    expect(siteLocationOf(site)).toMatchObject({ status: 'resolved', source: 'geocoded' });
    expect([site.latitude, site.longitude]).toEqual([-26.3, 28.2]);
  });

  it('is deleted at day 30 when the look-up cannot happen, and waits for the address to be looked up', async () => {
    const { harness, clock, read, tick } = await setup();
    switchOffGoogle(harness);
    clock.advanceDays(31);
    await tick();
    const site = await read();
    expect([site.latitude, site.longitude]).toEqual([null, null]);
    expect(siteLocationOf(site).status).toBe('not_configured');
    expect(siteNavigationTarget(site).kind).toBe('address');
  });

  it('an answer from the cache does not restart the 30 days', async () => {
    const { harness, clock, read } = await setup();
    clock.advanceDays(20);
    // A second customer at the same address, answered from the cache.
    const second = await createCustomer(harness.as(coordinator), {
      name: 'Benoni Two (Pty) Ltd',
      accountNumber: '',
      registrationNumber: '',
      vatNumber: '',
      phone: '011 000 0001',
      email: '',
      industry: 'Foundry',
      paymentTerms: '30 days',
      site: SITE,
      contact: { firstName: 'A', lastName: 'B', position: '', email: 'ab@benoni-two.example', phone: '082 000 0001', isPrimary: true },
    });
    const first = await read();
    const cachedSite = (await harness.repos.customers.findSiteById(second.site.id))!;
    expect(siteLocationOf(cachedSite).geocodedAt).toBe(siteLocationOf(first).geocodedAt);
  });

  it('the cache itself is emptied at day 30', async () => {
    const { harness, clock, tick } = await setup({});
    switchOffGoogle(harness);
    clock.advanceDays(30);
    await tick();
    const left = await harness.repos.integrations.findGeocode('za|12 tom jones street benoni gauteng 1501 south africa', '2000-01-01T00:00:00.000Z' as IsoDateTime);
    expect(left).toBeNull();
  });
});
