import { describe, expect, it } from 'vitest';
import {
  GoogleGeocodingService,
  SimulatedGeocodingService,
  UnconfiguredGeocodingService,
  classifyGoogleGeocode,
  readGoogleGeocodingConfiguration,
} from './geocoding';

/**
 * INT-MAP-1: the Google Geocoding adapter, driven by injected HTTP answers —
 * the request it builds, how it reads every status Google documents, and that
 * the key never appears in anything it reports. Google's side of the wire is
 * not asserted here and cannot honestly be.
 */

const KEY = 'AIzaSy-test-key-that-must-never-leak';
const config = readGoogleGeocodingConfiguration({ GOOGLE_MAPS_GEOCODING_API_KEY: KEY })!;

const respond =
  (status: number, body: unknown, calls: string[] = []): typeof fetch =>
  ((url: string | URL | Request) => {
    calls.push(String(url));
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;

const result = (overrides: Record<string, unknown> = {}) => ({
  formatted_address: '3 Wadeville Blvd, Germiston, 1428, South Africa',
  place_id: 'ChIJ-test',
  geometry: { location: { lat: -26.2745, lng: 28.198 }, location_type: 'ROOFTOP' },
  ...overrides,
});

describe('configuration', () => {
  it('is absent without a key, and defaults the region, the cap and the endpoint', () => {
    expect(readGoogleGeocodingConfiguration({})).toBeNull();
    expect(config).toMatchObject({ region: 'za', dailyLimit: 500, baseUrl: 'https://maps.googleapis.com' });
    expect(readGoogleGeocodingConfiguration({ GOOGLE_MAPS_GEOCODING_API_KEY: KEY, GOOGLE_GEOCODING_DAILY_LIMIT: '50' })?.dailyLimit).toBe(50);
    expect(readGoogleGeocodingConfiguration({ GOOGLE_MAPS_GEOCODING_API_KEY: KEY, GOOGLE_GEOCODING_DAILY_LIMIT: 'lots' })?.dailyLimit).toBe(500);
  });
});

describe('the request', () => {
  it('asks the server-side Geocoding API, biased to South Africa and restricted to it', async () => {
    const calls: string[] = [];
    await new GoogleGeocodingService(config, respond(200, { status: 'OK', results: [result()] }, calls)).geocode('3 Wadeville Boulevard, Germiston, South Africa');
    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/geocode/json');
    expect(url.searchParams.get('address')).toBe('3 Wadeville Boulevard, Germiston, South Africa');
    expect(url.searchParams.get('region')).toBe('za');
    expect(url.searchParams.get('components')).toBe('country:ZA');
    expect(url.searchParams.get('key')).toBe(KEY);
  });

  it('asks nothing for an empty address', async () => {
    const calls: string[] = [];
    const answer = await new GoogleGeocodingService(config, respond(200, {}, calls)).geocode('  ');
    expect(answer.outcome).toBe('not_found');
    expect(calls).toHaveLength(0);
  });
});

describe('reading Google’s answer', () => {
  it('one precise result is a match', () => {
    expect(classifyGoogleGeocode(200, { status: 'OK', results: [result()] })).toMatchObject({
      outcome: 'match',
      latitude: -26.2745,
      longitude: 28.198,
      placeId: 'ChIJ-test',
      precision: 'ROOFTOP',
    });
  });

  it('several results, a partial match, or an approximate place are AMBIGUOUS — a suggestion, never the pin', () => {
    expect(classifyGoogleGeocode(200, { status: 'OK', results: [result(), result({ place_id: 'other' })] }).outcome).toBe('ambiguous');
    expect(classifyGoogleGeocode(200, { status: 'OK', results: [result({ partial_match: true })] }).outcome).toBe('ambiguous');
    expect(
      classifyGoogleGeocode(200, { status: 'OK', results: [result({ geometry: { location: { lat: -26, lng: 28 }, location_type: 'APPROXIMATE' } })] }).outcome,
    ).toBe('ambiguous');
  });

  it('accepts a rural or industrial centre point as a match, recording how precise it was', () => {
    const rural = classifyGoogleGeocode(200, { status: 'OK', results: [result({ geometry: { location: { lat: -29.1, lng: 26.2 }, location_type: 'GEOMETRIC_CENTER' } })] });
    expect(rural).toMatchObject({ outcome: 'match', precision: 'GEOMETRIC_CENTER' });
  });

  it.each([
    ['ZERO_RESULTS', 'not_found'],
    ['OVER_QUERY_LIMIT', 'temporary_failure'],
    ['UNKNOWN_ERROR', 'temporary_failure'],
    ['OVER_DAILY_LIMIT', 'permanent_failure'],
    ['REQUEST_DENIED', 'permanent_failure'],
    ['INVALID_REQUEST', 'permanent_failure'],
  ])('%s is %s', (status, outcome) => {
    expect(classifyGoogleGeocode(200, { status }).outcome).toBe(outcome);
  });

  it('a quota answer names a wait; an outage (5xx, 429) is temporary; a 4xx is permanent', () => {
    expect(classifyGoogleGeocode(200, { status: 'OVER_QUERY_LIMIT' }).retryAfterSeconds).toBe(3600);
    expect(classifyGoogleGeocode(503, {}).outcome).toBe('temporary_failure');
    expect(classifyGoogleGeocode(429, {}).outcome).toBe('temporary_failure');
    expect(classifyGoogleGeocode(403, {}).outcome).toBe('permanent_failure');
  });
});

describe('the key never leaks', () => {
  it('not when Google cannot be reached (an error that quotes the URL)', async () => {
    const failing = (() => Promise.reject(new Error(`getaddrinfo ENOTFOUND https://maps.googleapis.com/maps/api/geocode/json?key=${KEY}`))) as typeof fetch;
    const answer = await new GoogleGeocodingService(config, failing).geocode('3 Wadeville Boulevard');
    expect(answer.outcome).toBe('temporary_failure');
    expect(JSON.stringify(answer)).not.toContain(KEY);
  });

  it('not in any refusal', async () => {
    for (const status of ['REQUEST_DENIED', 'OVER_DAILY_LIMIT', 'INVALID_REQUEST']) {
      const answer = await new GoogleGeocodingService(config, respond(200, { status, error_message: `The key ${KEY} is not authorised` })).geocode('x street');
      expect(JSON.stringify(answer), status).not.toContain(KEY);
    }
  });

  it('a timeout is temporary, and says only that', async () => {
    const slow = (() => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))) as typeof fetch;
    expect(await new GoogleGeocodingService(config, slow).geocode('x street')).toMatchObject({ outcome: 'temporary_failure', error: 'Google did not answer in time.' });
  });
});

describe('the other two adapters', () => {
  it('unconfigured asks nothing and says automatic pins are not set up', async () => {
    const service = new UnconfiguredGeocodingService();
    expect(service.configured).toBe(false);
    expect((await service.geocode()).outcome).toBe('not_configured');
  });

  it('the demonstration’s is deterministic and labelled simulated', async () => {
    const service = new SimulatedGeocodingService();
    const first = await service.geocode('3 Wadeville Boulevard, Germiston');
    const second = await service.geocode('3 Wadeville Boulevard, Germiston');
    expect(first).toEqual(second);
    expect(first.provider).toBe('simulated');
    expect(first.formattedAddress).toMatch(/simulated/u);
    expect((await service.geocode('Nowhere Road')).outcome).toBe('not_found');
    expect((await service.geocode('Several Streets')).outcome).toBe('ambiguous');
  });
});
