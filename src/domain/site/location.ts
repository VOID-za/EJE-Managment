import type { IsoDateTime } from '../types/common';
import type { Site, SiteGeocode, SiteLocationStatus } from '../types/customer';

/**
 * THE AUTOMATIC SITE PIN. INT-MAP-1..3 (the owner, 1 November 2026: "EJE must
 * automatically generate the Google Maps site pin using the customer's saved
 * address").
 *
 * Pure rules, no provider. The geocoder itself is a service port
 * (`GeocodingService`); this file decides WHEN to ask it, what to do with its
 * answer, and which pin a technician may be sent to. Four rules carry it:
 *
 *  1. An address is geocoded when it is written or CHANGED — never when a job
 *     is opened, and never again for an unchanged address.
 *  2. The office's address is never replaced by the provider's wording; the
 *     provider's formatted address is kept beside it.
 *  3. A pin the office verified (or entered by hand) is never replaced by a
 *     geocoding result. A new result waits as a suggestion.
 *  4. A pin that is not trusted is not used silently: the technician gets an
 *     address search instead, labelled as unverified.
 */

/** How many times a temporary geocoding failure is retried before giving up. */
export const GEOCODE_MAX_ATTEMPTS = 5;

/** Minutes to wait before attempt n+1 (index n-1) after a temporary failure. */
const GEOCODE_BACKOFF_MINUTES = [1, 5, 30, 180, 720] as const;

const EMPTY_GEOCODE: SiteGeocode = {
  status: 'not_requested',
  source: null,
  verifiedAt: null,
  verifiedBy: null,
  query: '',
  formattedAddress: '',
  placeId: null,
  precision: null,
  provider: null,
  geocodedAt: null,
  error: '',
  attempts: 0,
  nextAttemptAt: null,
  suggestedLatitude: null,
  suggestedLongitude: null,
};

const hasPin = (site: Pick<Site, 'latitude' | 'longitude'>): boolean =>
  site.latitude !== null && site.longitude !== null;

/**
 * The site's pin state, whether or not it was ever written. A site from before
 * migration 0042 with coordinates had them entered by the office: that is the
 * office's own, verified pin (the migration says the same in the database).
 */
export const siteLocationOf = (site: Site): SiteGeocode =>
  site.geocode ??
  (hasPin(site)
    ? { ...EMPTY_GEOCODE, status: 'verified', source: 'manual' }
    : { ...EMPTY_GEOCODE, query: siteGeocodeQuery(site) });

/**
 * The address as the geocoder is asked for it: one line, in the office's own
 * words, with the country added. The province is included (an industrial
 * "Main Road" exists in every one of them).
 */
export const siteGeocodeQuery = (site: Pick<Site, 'addressLine1' | 'addressLine2' | 'city' | 'province' | 'postalCode'>): string => {
  const parts = [site.addressLine1, site.addressLine2, site.city, site.province, site.postalCode]
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? '' : [...parts, 'South Africa'].join(', ');
};

/** The cache key for an address: case and spacing do not make a new address. */
export const geocodeCacheKey = (query: string, region: string): string =>
  `${region.toLowerCase()}|${query.toLowerCase().replace(/[\s,]+/g, ' ').trim()}`;

/**
 * May a technician be navigated to the pin itself? Verified, or one confident
 * automatic match. Ambiguous, stale and failed are not — see rule 4.
 */
export const sitePinTrusted = (site: Site): boolean => {
  if (!hasPin(site)) return false;
  const status = siteLocationOf(site).status;
  return status === 'verified' || status === 'resolved';
};

export type SiteNavigationKind = 'verified_pin' | 'automatic_pin' | 'address';

export interface SiteNavigationTarget {
  readonly kind: SiteNavigationKind;
  /** A Google Maps directions link: coordinates when trusted, else the address. */
  readonly url: string;
  /** What the technician is told about how far to trust it. */
  readonly note: string;
}

const directions = (destination: string): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;

const addressLine = (site: Site): string =>
  [site.addressLine1, site.addressLine2, site.city, site.postalCode]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');

export const siteNavigationTarget = (site: Site): SiteNavigationTarget => {
  if (sitePinTrusted(site)) {
    const verified = siteLocationOf(site).status === 'verified';
    return {
      kind: verified ? 'verified_pin' : 'automatic_pin',
      url: directions(`${site.latitude},${site.longitude}`),
      note: verified
        ? 'Navigates to the site pin the office checked.'
        : 'Navigates to the pin found from the site address. The office has not checked it yet.',
    };
  }
  return {
    kind: 'address',
    url: directions(addressLine(site)),
    note: 'Not a verified pin: Google Maps searches for the site address.',
  };
};

const STATUS_LABEL: Record<SiteLocationStatus, string> = {
  not_requested: 'Not pinned',
  pending: 'Finding the pin…',
  resolved: 'Pin found — not yet checked',
  ambiguous: 'Several possible matches — check the pin',
  not_found: 'Address not found — set the pin by hand',
  failed: 'Pin could not be found',
  not_configured: 'Automatic pins are not set up',
  verified: 'Pin verified',
  stale: 'Address changed — re-check the pin',
};

export const siteLocationLabel = (status: SiteLocationStatus): string => STATUS_LABEL[status];

/** Needs somebody in the office to look at it. */
export const siteLocationNeedsAttention = (status: SiteLocationStatus): boolean =>
  status === 'ambiguous' || status === 'not_found' || status === 'failed' || status === 'stale' || status === 'resolved';

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The office saved the site. Decides what becomes of the pin.
 *
 * `previous` is null for a new site. The coordinates in `next` are what the
 * office sent: different from before means they set (or cleared) the pin by
 * hand, which is verified by definition — they are the person who knows.
 */
export const locationAfterSave = (
  previous: Site | null,
  next: Site,
  actorId: string,
  now: IsoDateTime,
): Site => {
  const before = previous === null ? null : siteLocationOf(previous);
  const query = siteGeocodeQuery(next);
  const coordinatesChanged =
    previous === null
      ? hasPin(next)
      : previous.latitude !== next.latitude || previous.longitude !== next.longitude;

  if (coordinatesChanged && hasPin(next)) {
    return {
      ...next,
      geocode: {
        ...(before ?? EMPTY_GEOCODE),
        status: 'verified',
        source: 'manual',
        verifiedAt: now,
        verifiedBy: actorId,
        query,
        error: '',
        attempts: 0,
        nextAttemptAt: null,
        suggestedLatitude: null,
        suggestedLongitude: null,
      },
    };
  }

  const queue = (geocode: SiteGeocode): SiteGeocode =>
    query.length === 0
      ? { ...geocode, status: geocode.status === 'stale' ? 'stale' : 'not_requested', query, nextAttemptAt: null, attempts: 0 }
      : { ...geocode, query, error: '', attempts: 0, nextAttemptAt: now };

  if (coordinatesChanged) {
    // The office cleared the pin: find it again from the address.
    return {
      ...next,
      geocode: queue({ ...EMPTY_GEOCODE, status: 'pending' }),
    };
  }

  if (previous !== null && siteGeocodeQuery(previous) === query) {
    // Rule 1: an unchanged address is not geocoded again. A site from before
    // the automatic pin keeps no geocode record at all, and keeps reading as it did.
    return { ...next, geocode: previous.geocode };
  }

  if (before !== null && before.status === 'verified' && hasPin(next)) {
    // Rule 3. The verified pin stays; it is no longer trusted for the new address.
    return {
      ...next,
      geocode: queue({ ...before, status: 'stale', suggestedLatitude: null, suggestedLongitude: null }),
    };
  }

  if (before !== null && before.status === 'stale' && hasPin(next)) {
    return { ...next, geocode: queue({ ...before, suggestedLatitude: null, suggestedLongitude: null }) };
  }

  // A new address, or one whose automatic pin belonged to the old address.
  return {
    ...next,
    latitude: null,
    longitude: null,
    geocode: queue({ ...EMPTY_GEOCODE, status: 'pending' }),
  };
};

/** What a geocoder answered. See `GeocodingService` in `services/ports.ts`. */
export type GeocodeOutcome =
  | 'match'
  | 'ambiguous'
  | 'not_found'
  | 'temporary_failure'
  | 'permanent_failure'
  | 'not_configured';

export interface GeocodeAnswer {
  readonly outcome: GeocodeOutcome;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly formattedAddress: string;
  readonly placeId: string | null;
  readonly precision: string | null;
  readonly provider: string;
  /** Plain words for the office. Never a key, a URL or a credential. */
  readonly error: string;
  /** A provider that names a wait (a quota) gets it. */
  readonly retryAfterSeconds?: number | null;
}

const roundCoordinate = (value: number): number => Math.round(value * 1e6) / 1e6;

const later = (now: IsoDateTime, minutes: number): IsoDateTime =>
  new Date(Date.parse(now) + minutes * 60_000).toISOString() as IsoDateTime;

/**
 * Applies a geocoder's answer to the site — or does nothing, when the address
 * changed while the question was out (the answer is for an address that is no
 * longer the site's).
 */
export const locationAfterGeocode = (
  site: Site,
  query: string,
  answer: GeocodeAnswer,
  now: IsoDateTime,
): Site | null => {
  const current = siteLocationOf(site);
  if (current.query !== query || current.nextAttemptAt === null) return null;

  const recorded: SiteGeocode = {
    ...current,
    provider: answer.provider,
    geocodedAt: now,
    error: answer.error,
  };
  // Rule 3: a verified pin (or one verified before the address changed) is kept.
  const keepsVerifiedPin = (current.status === 'stale' || current.status === 'verified') && hasPin(site);
  const kept = current.status;
  const point =
    answer.latitude === null || answer.longitude === null
      ? null
      : { latitude: roundCoordinate(answer.latitude), longitude: roundCoordinate(answer.longitude) };

  switch (answer.outcome) {
    case 'match':
    case 'ambiguous': {
      const details = {
        formattedAddress: answer.formattedAddress,
        placeId: answer.placeId,
        precision: answer.precision,
        attempts: 0,
        nextAttemptAt: null,
      };
      if (keepsVerifiedPin) {
        return {
          ...site,
          geocode: {
            ...recorded,
            ...details,
            status: kept,
            suggestedLatitude: point?.latitude ?? null,
            suggestedLongitude: point?.longitude ?? null,
          },
        };
      }
      if (answer.outcome === 'match' && point !== null) {
        return {
          ...site,
          latitude: point.latitude,
          longitude: point.longitude,
          geocode: {
            ...recorded,
            ...details,
            status: 'resolved',
            source: 'geocoded',
            verifiedAt: null,
            verifiedBy: null,
            suggestedLatitude: null,
            suggestedLongitude: null,
          },
        };
      }
      return {
        ...site,
        latitude: null,
        longitude: null,
        geocode: {
          ...recorded,
          ...details,
          status: 'ambiguous',
          source: null,
          suggestedLatitude: point?.latitude ?? null,
          suggestedLongitude: point?.longitude ?? null,
        },
      };
    }
    case 'not_found':
      return {
        ...site,
        geocode: {
          ...recorded,
          status: keepsVerifiedPin ? kept : 'not_found',
          formattedAddress: '',
          placeId: null,
          precision: null,
          attempts: 0,
          nextAttemptAt: null,
          error: answer.error.length > 0 ? answer.error : 'Google found no match for this address.',
        },
      };
    case 'not_configured':
      return {
        ...site,
        geocode: {
          ...recorded,
          status: keepsVerifiedPin ? kept : 'not_configured',
          attempts: 0,
          nextAttemptAt: null,
        },
      };
    case 'permanent_failure':
      return {
        ...site,
        geocode: { ...recorded, status: keepsVerifiedPin ? kept : 'failed', attempts: current.attempts + 1, nextAttemptAt: null },
      };
    case 'temporary_failure': {
      const attempts = current.attempts + 1;
      if (attempts >= GEOCODE_MAX_ATTEMPTS) {
        return {
          ...site,
          geocode: { ...recorded, status: keepsVerifiedPin ? kept : 'failed', attempts, nextAttemptAt: null },
        };
      }
      const waitMinutes = Math.max(
        GEOCODE_BACKOFF_MINUTES[attempts - 1] ?? 720,
        Math.ceil((answer.retryAfterSeconds ?? 0) / 60),
      );
      return {
        ...site,
        geocode: { ...recorded, status: keepsVerifiedPin ? kept : 'pending', attempts, nextAttemptAt: later(now, waitMinutes) },
      };
    }
  }
};

/**
 * The office checked the pin: the current one, the suggestion, or coordinates
 * they typed. Whatever they choose becomes THE pin, verified by them.
 */
export const locationAfterVerify = (
  site: Site,
  choice: { readonly kind: 'current' } | { readonly kind: 'suggested' } | { readonly kind: 'manual'; readonly latitude: number; readonly longitude: number },
  actorId: string,
  now: IsoDateTime,
): Site => {
  const current = siteLocationOf(site);
  const point =
    choice.kind === 'manual'
      ? { latitude: roundCoordinate(choice.latitude), longitude: roundCoordinate(choice.longitude) }
      : choice.kind === 'suggested'
        ? current.suggestedLatitude === null || current.suggestedLongitude === null
          ? null
          : { latitude: current.suggestedLatitude, longitude: current.suggestedLongitude }
        : site.latitude === null || site.longitude === null
          ? null
          : { latitude: site.latitude, longitude: site.longitude };
  if (point === null) return site;
  return {
    ...site,
    latitude: point.latitude,
    longitude: point.longitude,
    geocode: {
      ...current,
      status: 'verified',
      source: choice.kind === 'manual' ? 'manual' : choice.kind === 'current' ? (current.source ?? 'manual') : 'geocoded',
      verifiedAt: now,
      verifiedBy: actorId,
      query: siteGeocodeQuery(site),
      error: '',
      attempts: 0,
      nextAttemptAt: null,
      suggestedLatitude: null,
      suggestedLongitude: null,
    },
  };
};

/** The office asks for the pin to be looked up again (e.g. after setup). */
export const locationAfterRequeue = (site: Site, now: IsoDateTime): Site => {
  const current = siteLocationOf(site);
  const query = siteGeocodeQuery(site);
  if (query.length === 0) return site;
  return {
    ...site,
    geocode: {
      ...current,
      status: current.status === 'verified' || current.status === 'stale' ? current.status : 'pending',
      query,
      error: '',
      attempts: 0,
      nextAttemptAt: now,
    },
  };
};
