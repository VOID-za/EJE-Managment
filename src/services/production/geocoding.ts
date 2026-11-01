import type { GeocodeAnswer } from '@/domain';
import type { GeocodingService } from '../ports';

/**
 * GOOGLE GEOCODING API — the site address turned into a pin. INT-MAP-1.
 *
 * A server-side call with a server-side key (GOOGLE_MAPS_GEOCODING_API_KEY).
 * The key never reaches a browser, a log or an error message: every message
 * this adapter produces is built from Google's status, never from the URL.
 *
 * Asked with the region bias and a country component (`components=country:ZA`
 * when the region is `za`), so "Main Road, Germiston" is not answered with a
 * Main Road in another country.
 *
 * How Google's answers are classified (Geocoding API, "Status codes"):
 *
 *   OK, one precise result          → match
 *   OK, several results, a partial
 *     match, or APPROXIMATE only     → ambiguous (a suggestion, never the pin)
 *   ZERO_RESULTS                     → not_found
 *   OVER_QUERY_LIMIT, UNKNOWN_ERROR,
 *     5xx, timeout, unreachable      → temporary_failure (retried, backing off)
 *   REQUEST_DENIED, INVALID_REQUEST,
 *     OVER_DAILY_LIMIT (billing or
 *     key problem), 4xx              → permanent_failure (the office is told)
 */

export interface GoogleGeocodingConfiguration {
  readonly apiKey: string;
  /** ccTLD region bias, default `za`. */
  readonly region: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Requests a day the application allows itself, default 500. */
  readonly dailyLimit: number;
}

export const readGoogleGeocodingConfiguration = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): GoogleGeocodingConfiguration | null => {
  const apiKey = (env.GOOGLE_MAPS_GEOCODING_API_KEY ?? '').trim();
  if (apiKey.length === 0) return null;
  const limit = Number((env.GOOGLE_GEOCODING_DAILY_LIMIT ?? '').trim());
  return {
    apiKey,
    region: ((env.GOOGLE_GEOCODING_REGION ?? '').trim() || 'za').toLowerCase(),
    baseUrl: ((env.GOOGLE_GEOCODING_BASE_URL ?? '').trim() || 'https://maps.googleapis.com').replace(/\/+$/u, ''),
    timeoutMs: 15_000,
    dailyLimit: Number.isInteger(limit) && limit > 0 && limit <= 100_000 ? limit : 500,
  };
};

interface GoogleResult {
  readonly formatted_address?: string;
  readonly place_id?: string;
  readonly partial_match?: boolean;
  readonly geometry?: {
    readonly location?: { readonly lat?: number; readonly lng?: number };
    readonly location_type?: string;
  };
}

interface GoogleResponse {
  readonly status?: string;
  readonly results?: readonly GoogleResult[];
}

const answer = (
  outcome: GeocodeAnswer['outcome'],
  error: string,
  extra: Partial<GeocodeAnswer> = {},
): GeocodeAnswer => ({
  outcome,
  latitude: null,
  longitude: null,
  formattedAddress: '',
  placeId: null,
  precision: null,
  provider: 'google',
  error,
  ...extra,
});

/** Turns Google's reply into an answer. Exported for the tests. */
export const classifyGoogleGeocode = (httpStatus: number, payload: GoogleResponse): GeocodeAnswer => {
  if (httpStatus >= 500) return answer('temporary_failure', `Google was unavailable (HTTP ${httpStatus}).`);
  if (httpStatus === 429) return answer('temporary_failure', 'Google asked for fewer requests.', { retryAfterSeconds: 60 });
  if (httpStatus >= 400) return answer('permanent_failure', `Google refused the request (HTTP ${httpStatus}).`);

  switch (payload.status) {
    case 'OK': {
      const results = payload.results ?? [];
      const first = results[0];
      const lat = first?.geometry?.location?.lat;
      const lng = first?.geometry?.location?.lng;
      if (first === undefined || typeof lat !== 'number' || typeof lng !== 'number') {
        return answer('not_found', 'Google answered without a location.');
      }
      const precision = first.geometry?.location_type ?? null;
      const details = {
        latitude: lat,
        longitude: lng,
        formattedAddress: first.formatted_address ?? '',
        placeId: first.place_id ?? null,
        precision,
      };
      if (results.length > 1) {
        return answer('ambiguous', `Google found ${results.length} possible places for this address. Check the pin.`, details);
      }
      if (first.partial_match === true) {
        return answer('ambiguous', 'Google matched only part of this address. Check the pin.', details);
      }
      if (precision === 'APPROXIMATE') {
        return answer('ambiguous', 'Google could only place this address approximately (for example, the suburb). Check the pin.', details);
      }
      return answer('match', '', details);
    }
    case 'ZERO_RESULTS':
      return answer('not_found', 'Google found no match for this address. Check the address, or set the pin by hand.');
    case 'OVER_QUERY_LIMIT':
      return answer('temporary_failure', 'Google’s request limit was reached. It will be tried again later.', { retryAfterSeconds: 3600 });
    case 'OVER_DAILY_LIMIT':
      return answer('permanent_failure', 'Google refused the request: the API key, billing or daily quota needs attention in Google Cloud.');
    case 'REQUEST_DENIED':
      return answer('permanent_failure', 'Google refused the API key. Check the key and its restrictions in Google Cloud.');
    case 'INVALID_REQUEST':
      return answer('permanent_failure', 'Google could not read this address. Check the address fields.');
    case 'UNKNOWN_ERROR':
      return answer('temporary_failure', 'Google had a temporary error. It will be tried again.');
    default:
      return answer('temporary_failure', 'Google gave an answer EJE did not recognise. It will be tried again.');
  }
};

export class GoogleGeocodingService implements GeocodingService {
  readonly configured = true;
  readonly provider = 'google';

  constructor(
    private readonly config: GoogleGeocodingConfiguration,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get region(): string {
    return this.config.region;
  }

  get dailyLimit(): number {
    return this.config.dailyLimit;
  }

  async geocode(query: string): Promise<GeocodeAnswer> {
    if (query.trim().length === 0) return answer('not_found', 'There is no address to look up.');
    const params = new URLSearchParams({ address: query, region: this.config.region, key: this.config.apiKey });
    if (this.config.region === 'za') params.set('components', 'country:ZA');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/maps/api/geocode/json?${params.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      // Never the error's own message: it can quote the URL, and the URL has the key in it.
      return answer('temporary_failure', timedOut ? 'Google did not answer in time.' : 'Google could not be reached.');
    }
    const payload = (await response.json().catch(() => ({}))) as GoogleResponse;
    return classifyGoogleGeocode(response.status, payload);
  }
}

/** A deployment with no key. Asks nothing, pays nothing, and says so. */
export class UnconfiguredGeocodingService implements GeocodingService {
  readonly configured = false;
  readonly provider = 'none';
  readonly region = 'za';

  geocode(): Promise<GeocodeAnswer> {
    return Promise.resolve(
      answer('not_configured', 'Automatic pins are not set up on this system (GOOGLE_MAPS_GEOCODING_API_KEY is not set).', {
        provider: 'none',
      }),
    );
  }
}

/**
 * THE DEMONSTRATION'S GEOCODER. Never on a real deployment (see
 * `buildGeocoding`). Deterministic, so a demonstration and a test see the
 * same pin for the same address, and labelled `simulated` wherever it shows.
 * An address containing "nowhere" is not found; one containing "several" is
 * ambiguous; "outage" fails temporarily — so every path can be shown.
 */
export class SimulatedGeocodingService implements GeocodingService {
  readonly configured = true;
  readonly provider = 'simulated';
  readonly region = 'za';
  calls = 0;

  geocode(query: string): Promise<GeocodeAnswer> {
    this.calls += 1;
    const lower = query.toLowerCase();
    if (lower.includes('nowhere')) return Promise.resolve(answer('not_found', 'No match (simulated).', { provider: 'simulated' }));
    if (lower.includes('outage')) {
      return Promise.resolve(answer('temporary_failure', 'The geocoder is unavailable (simulated).', { provider: 'simulated' }));
    }
    let hash = 0;
    for (const char of lower) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    const latitude = -26.35 + (hash % 3000) / 10_000;
    const longitude = 27.9 + ((hash >>> 12) % 5000) / 10_000;
    const details = {
      latitude: Math.round(latitude * 1e6) / 1e6,
      longitude: Math.round(longitude * 1e6) / 1e6,
      formattedAddress: `${query} (simulated match)`,
      placeId: `simulated-${hash.toString(16)}`,
      precision: lower.includes('several') ? 'APPROXIMATE' : 'ROOFTOP',
      provider: 'simulated',
    };
    return Promise.resolve(
      lower.includes('several')
        ? answer('ambiguous', 'Several possible places (simulated). Check the pin.', details)
        : answer('match', '', details),
    );
  }
}
