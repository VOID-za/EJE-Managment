import { describe, expect, it } from 'vitest';
import {
  GEOCODE_MAX_ATTEMPTS,
  geocodeCacheKey,
  locationAfterGeocode,
  locationAfterSave,
  locationAfterVerify,
  siteGeocodeQuery,
  siteLocationOf,
  siteNavigationTarget,
  type GeocodeAnswer,
} from './location';
import { asCustomerId, asSiteId } from '../types/common';
import type { Site } from '../types/customer';

/**
 * INT-MAP-1..3: when a site is geocoded, what a geocoder's answer does to it,
 * and which pin a technician is sent to.
 */

const NOW = '2026-11-01T08:00:00.000Z';

const site = (overrides: Partial<Site> = {}): Site => ({
  id: asSiteId('site-1'),
  customerId: asCustomerId('cust-1'),
  name: 'Wadeville Plant',
  addressLine1: '3 Wadeville Boulevard',
  addressLine2: '',
  city: 'Germiston',
  province: 'Gauteng',
  postalCode: '1428',
  accessNotes: '',
  latitude: null,
  longitude: null,
  archivedAt: null,
  ...overrides,
});

const answer = (overrides: Partial<GeocodeAnswer> = {}): GeocodeAnswer => ({
  outcome: 'match',
  latitude: -26.2745123,
  longitude: 28.1980456,
  formattedAddress: '3 Wadeville Blvd, Wadeville, Germiston, 1428, South Africa',
  placeId: 'place-1',
  precision: 'ROOFTOP',
  provider: 'google',
  error: '',
  ...overrides,
});

/** A new site, queued and answered. */
const geocoded = (result: GeocodeAnswer = answer()): Site => {
  const queued = locationAfterSave(null, site(), 'user-1', NOW);
  return locationAfterGeocode(queued, siteLocationOf(queued).query, result, NOW)!;
};

describe('when a site is geocoded', () => {
  it('queues a new site with an address, asking for the office’s words plus the country', () => {
    const queued = locationAfterSave(null, site(), 'user-1', NOW);
    expect(siteLocationOf(queued).status).toBe('pending');
    expect(siteLocationOf(queued).nextAttemptAt).toBe(NOW);
    expect(siteLocationOf(queued).query).toBe('3 Wadeville Boulevard, Germiston, Gauteng, 1428, South Africa');
  });

  it('does NOT geocode an unchanged address again (an edit of the access notes, say)', () => {
    const found = geocoded();
    const edited = locationAfterSave(found, { ...found, accessNotes: 'Gate 3' }, 'user-1', NOW);
    expect(siteLocationOf(edited)).toEqual(siteLocationOf(found));
    expect(siteLocationOf(edited).nextAttemptAt).toBeNull();
  });

  it('treats a change of case or spacing as the same address for the cache', () => {
    expect(geocodeCacheKey('3 Wadeville  Boulevard, Germiston', 'za')).toBe(geocodeCacheKey('3 wadeville boulevard,germiston', 'ZA'));
  });

  it('re-geocodes a changed address, dropping the automatic pin that belonged to the old one', () => {
    const found = geocoded();
    const moved = locationAfterSave(found, { ...found, addressLine1: '9 Steel Road' }, 'user-1', NOW);
    expect(siteLocationOf(moved).status).toBe('pending');
    expect(moved.latitude).toBeNull();
    expect(siteLocationOf(moved).query).toContain('9 Steel Road');
  });

  it('KEEPS a verified pin when the address changes, marks it stale, and asks again for a suggestion', () => {
    const verified = locationAfterVerify(geocoded(), { kind: 'current' }, 'user-1', NOW);
    const moved = locationAfterSave(verified, { ...verified, addressLine1: '9 Steel Road' }, 'user-1', NOW);
    expect(siteLocationOf(moved).status).toBe('stale');
    expect(moved.latitude).toBe(verified.latitude);
    expect(siteLocationOf(moved).nextAttemptAt).toBe(NOW);
  });

  it('makes coordinates the office typed its verified, manual pin', () => {
    const typed = locationAfterSave(site(), { ...site(), latitude: -26.1, longitude: 28.2 }, 'user-9', NOW);
    expect(siteLocationOf(typed)).toMatchObject({ status: 'verified', source: 'manual', verifiedBy: 'user-9', nextAttemptAt: null });
  });

  it('reads a site from before the automatic pin: coordinates were the office’s own', () => {
    expect(siteLocationOf(site({ latitude: -26.1, longitude: 28.2 })).status).toBe('verified');
    expect(siteLocationOf(site()).status).toBe('not_requested');
  });
});

describe('what an answer does', () => {
  it('a confident match sets the pin, rounded to the column, unverified', () => {
    const found = geocoded();
    expect(found.latitude).toBe(-26.274512);
    expect(found.longitude).toBe(28.198046);
    expect(siteLocationOf(found)).toMatchObject({ status: 'resolved', source: 'geocoded', placeId: 'place-1', nextAttemptAt: null });
    // The office's address is untouched. Rule 5: the provider's wording and
    // precision are not stored (only coordinates for 30 days, and the place ID).
    expect(found.addressLine1).toBe('3 Wadeville Boulevard');
    expect(siteLocationOf(found)).toMatchObject({ formattedAddress: '', precision: null });
  });

  it('an ambiguous answer is only a SUGGESTION — the pin is not set from it', () => {
    const unsure = geocoded(answer({ outcome: 'ambiguous', precision: 'APPROXIMATE' }));
    expect(unsure.latitude).toBeNull();
    expect(siteLocationOf(unsure)).toMatchObject({ status: 'ambiguous', suggestedLatitude: -26.274512 });
  });

  it('no match leaves no pin and says so', () => {
    const none = geocoded(answer({ outcome: 'not_found', latitude: null, longitude: null, formattedAddress: '' }));
    expect(none.latitude).toBeNull();
    expect(siteLocationOf(none).status).toBe('not_found');
    expect(siteLocationOf(none).error.length).toBeGreaterThan(0);
  });

  it('a temporary failure backs off, and gives up after the last attempt', () => {
    let current = locationAfterSave(null, site(), 'user-1', NOW);
    const query = siteLocationOf(current).query;
    for (let attempt = 1; attempt < GEOCODE_MAX_ATTEMPTS; attempt += 1) {
      current = locationAfterGeocode(current, query, answer({ outcome: 'temporary_failure', latitude: null, longitude: null, error: 'down' }), NOW)!;
      expect(siteLocationOf(current).status).toBe('pending');
      expect(Date.parse(siteLocationOf(current).nextAttemptAt!)).toBeGreaterThan(Date.parse(NOW));
    }
    current = locationAfterGeocode(current, query, answer({ outcome: 'temporary_failure', latitude: null, longitude: null, error: 'down' }), NOW)!;
    expect(siteLocationOf(current)).toMatchObject({ status: 'failed', nextAttemptAt: null, attempts: GEOCODE_MAX_ATTEMPTS });
  });

  it('honours a quota’s wait when it is longer than the back-off', () => {
    const queued = locationAfterSave(null, site(), 'user-1', NOW);
    const waited = locationAfterGeocode(queued, siteLocationOf(queued).query, answer({ outcome: 'temporary_failure', latitude: null, longitude: null, retryAfterSeconds: 3600 }), NOW)!;
    expect(Date.parse(siteLocationOf(waited).nextAttemptAt!) - Date.parse(NOW)).toBe(3600_000);
  });

  it('a permanent failure (a refused key) stops at once', () => {
    const refused = geocoded(answer({ outcome: 'permanent_failure', latitude: null, longitude: null, error: 'Google refused the API key.' }));
    expect(siteLocationOf(refused)).toMatchObject({ status: 'failed', nextAttemptAt: null });
  });

  it('no geocoder configured is said plainly, and nothing waits', () => {
    const none = geocoded(answer({ outcome: 'not_configured', latitude: null, longitude: null, provider: 'none' }));
    expect(siteLocationOf(none)).toMatchObject({ status: 'not_configured', nextAttemptAt: null });
  });

  it('NEVER overwrites a verified pin: a new match waits beside it as a suggestion', () => {
    const verified = locationAfterVerify(geocoded(), { kind: 'manual', latitude: -26.3, longitude: 28.25 }, 'user-1', NOW);
    const moved = locationAfterSave(verified, { ...verified, addressLine1: '9 Steel Road' }, 'user-1', NOW);
    const after = locationAfterGeocode(moved, siteLocationOf(moved).query, answer({ latitude: -26.9, longitude: 28.9 }), NOW)!;
    expect(after.latitude).toBe(-26.3);
    expect(after.longitude).toBe(28.25);
    expect(siteLocationOf(after)).toMatchObject({ status: 'stale', suggestedLatitude: -26.9, suggestedLongitude: 28.9 });
  });

  it('ignores an answer for an address the site no longer has', () => {
    const queued = locationAfterSave(null, site(), 'user-1', NOW);
    const oldQuery = siteLocationOf(queued).query;
    const moved = locationAfterSave(queued, { ...queued, addressLine1: '9 Steel Road' }, 'user-1', NOW);
    expect(locationAfterGeocode(moved, oldQuery, answer(), NOW)).toBeNull();
  });
});

describe('the office verifies', () => {
  it('the current pin, the suggestion, or typed coordinates — each becomes the verified pin', () => {
    const found = geocoded();
    expect(siteLocationOf(locationAfterVerify(found, { kind: 'current' }, 'u', NOW)).status).toBe('verified');
    const unsure = geocoded(answer({ outcome: 'ambiguous' }));
    const taken = locationAfterVerify(unsure, { kind: 'suggested' }, 'u', NOW);
    expect(taken.latitude).toBe(-26.274512);
    expect(siteLocationOf(taken)).toMatchObject({ status: 'verified', suggestedLatitude: null });
    const typed = locationAfterVerify(found, { kind: 'manual', latitude: -26.5, longitude: 28.5 }, 'u', NOW);
    expect(siteLocationOf(typed)).toMatchObject({ status: 'verified', source: 'manual' });
  });
});

describe('where the technician is sent', () => {
  it('to the verified Google pin by its PLACE, never by coordinates a stored link would outlive (rule 5)', () => {
    const target = siteNavigationTarget(locationAfterVerify(geocoded(), { kind: 'current' }, 'u', NOW));
    expect(target.kind).toBe('verified_pin');
    expect(target.url).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=3%20Wadeville%20Boulevard%2C%20Germiston%2C%201428&destination_place_id=place-1',
    );
  });

  it('to a pin the office entered by hand, by its coordinates', () => {
    const target = siteNavigationTarget(locationAfterVerify(geocoded(), { kind: 'manual', latitude: -26.5, longitude: 28.5 }, 'u', NOW));
    expect(target.kind).toBe('verified_pin');
    expect(target.url).toBe('https://www.google.com/maps/dir/?api=1&destination=-26.5%2C28.5');
  });

  it('to a confident automatic pin, saying the office has not checked it', () => {
    const target = siteNavigationTarget(geocoded());
    expect(target.kind).toBe('automatic_pin');
    expect(target.note).toMatch(/not checked/u);
  });

  it('to an ADDRESS SEARCH, labelled unverified, when the pin is unsure, stale or missing', () => {
    const unsure = geocoded(answer({ outcome: 'ambiguous' }));
    const verified = locationAfterVerify(geocoded(), { kind: 'current' }, 'u', NOW);
    const stale = locationAfterSave(verified, { ...verified, addressLine1: '9 Steel Road' }, 'u', NOW);
    for (const candidate of [unsure, stale, site()]) {
      const target = siteNavigationTarget(candidate);
      expect(target.kind).toBe('address');
      expect(target.note).toMatch(/Not a verified pin/u);
      expect(new URL(target.url).searchParams.get('destination')).toContain('Germiston');
    }
  });

  it('builds the address query from the site, never from a customer’s billing address', () => {
    expect(siteGeocodeQuery(site({ addressLine2: 'Unit 4' }))).toBe('3 Wadeville Boulevard, Unit 4, Germiston, Gauteng, 1428, South Africa');
  });
});
