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
 *  5. WHAT A GEOCODER RETURNED IS NOT EJE'S TO KEEP. The Google Maps Platform
 *     Service Specific Terms, §6.3.1 (Geocoding API): latitude and longitude
 *     "for up to 30 consecutive calendar days, after which Customer must
 *     delete" them; the place ID is exempt and may be stored indefinitely.
 *     So: coordinates the OFFICE entered are the office's own and are kept;
 *     coordinates from the geocoder (a pin, or a suggestion) are refreshed
 *     from 27 days and deleted at 30 — a verified one by its place ID, and only
 *     kept verified when the place has not moved. The formatted address and
 *     the precision are not stored at all. Links to a geocoded pin name the
 *     place ID, never the coordinates, so no message or audit entry keeps them.
 *     The decision and the sources: docs/integrations-setup.md §4.6.
 */

/** Days the geocoder's coordinates may be held (the terms' 30 calendar days). */
export const PROVIDER_COORDINATE_RETENTION_DAYS = 30;

/** Days after which they are looked up again, leaving three days for failures. */
export const PROVIDER_REFRESH_AFTER_DAYS = 27;

/** A refreshed verified place may move this far and still be the office's pin. */
export const PIN_REFRESH_TOLERANCE_METRES = 30;

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

const DAY_MS = 24 * 3600_000;

const daysAfter = (at: IsoDateTime, days: number): IsoDateTime =>
  new Date(Date.parse(at) + days * DAY_MS).toISOString() as IsoDateTime;

/**
 * The Google place a geocoded pin stands for (rule 5). Only Google's: the
 * demonstration's simulated geocoder invents ids no map would recognise.
 */
export const sitePlaceReference = (site: Site): string | null => {
  const geocode = siteLocationOf(site);
  return geocode.source === 'geocoded' && geocode.provider === 'google' && geocode.placeId !== null && geocode.placeId.length > 0
    ? geocode.placeId
    : null;
};

/** Does the site hold anything the geocoder returned, other than the place ID? */
export const siteHoldsProviderContent = (site: Site): boolean => {
  const geocode = siteLocationOf(site);
  return (
    (geocode.source === 'geocoded' && hasPin(site)) ||
    geocode.suggestedLatitude !== null ||
    geocode.suggestedLongitude !== null ||
    geocode.formattedAddress.length > 0 ||
    geocode.precision !== null
  );
};

/** When the geocoder's coordinates on this site must be gone, or null. */
export const siteProviderContentExpiresAt = (site: Site): IsoDateTime | null => {
  const geocodedAt = siteLocationOf(site).geocodedAt;
  return siteHoldsProviderContent(site) && geocodedAt !== null ? daysAfter(geocodedAt, PROVIDER_COORDINATE_RETENTION_DAYS) : null;
};

/** Held long enough to be looked up again (27 days). */
export const siteDueForProviderRefresh = (site: Site, now: IsoDateTime): boolean => {
  const geocodedAt = siteLocationOf(site).geocodedAt;
  return siteHoldsProviderContent(site) && (geocodedAt === null || daysAfter(geocodedAt, PROVIDER_REFRESH_AFTER_DAYS) <= now);
};

/** Held as long as the terms allow (30 days): must be deleted now. */
export const siteProviderContentExpired = (site: Site, now: IsoDateTime): boolean => {
  const expires = siteProviderContentExpiresAt(site);
  return siteHoldsProviderContent(site) && (expires === null || expires <= now);
};

/**
 * A refresh that keeps a VERIFIED geocoded pin: asked by its place ID, and
 * judged by `locationAfterRefresh` — not a fresh address look-up whose
 * answer would only be a suggestion.
 */
export const siteNeedsPinRefresh = (site: Site, now: IsoDateTime): boolean => {
  const geocode = siteLocationOf(site);
  return (
    geocode.source === 'geocoded' &&
    hasPin(site) &&
    (geocode.status === 'verified' || geocode.status === 'stale') &&
    (siteDueForProviderRefresh(site, now) || geocode.placeId === null)
  );
};

/**
 * May a technician be navigated to the pin itself? Verified, or one confident
 * automatic match. Ambiguous, stale and failed are not — see rule 4. A
 * verified Google place whose coordinates were deleted (rule 5) still is: the
 * link names the place.
 */
export const sitePinTrusted = (site: Site): boolean => {
  if (!hasPin(site) && sitePlaceReference(site) === null) return false;
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

const directions = (destination: string, placeId: string | null = null): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}` +
  (placeId === null ? '' : `&destination_place_id=${encodeURIComponent(placeId)}`);

const addressLine = (site: Site): string =>
  [site.addressLine1, site.addressLine2, site.city, site.postalCode]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');

export const siteNavigationTarget = (site: Site): SiteNavigationTarget => {
  if (sitePinTrusted(site)) {
    const verified = siteLocationOf(site).status === 'verified';
    // Rule 5: a geocoded pin is linked by its Google place, never by coordinates
    // the link (kept in a message) would outlive.
    const place = sitePlaceReference(site);
    return {
      kind: verified ? 'verified_pin' : 'automatic_pin',
      url: place === null ? directions(`${site.latitude},${site.longitude}`) : directions(addressLine(site) || site.name, place),
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
  stale: 'Re-check the pin',
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
  /**
   * When the provider gave this answer: earlier than now when it came from the
   * cache. The 30 days of rule 5 run from here, not from when it was applied.
   */
  readonly obtainedAt?: IsoDateTime | null;
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

  const obtained = answer.obtainedAt ?? now;
  const recorded: SiteGeocode = {
    ...current,
    provider: answer.provider,
    // Rule 5: an answer with nothing in it does not restart the clock on what is held.
    geocodedAt: siteHoldsProviderContent(site) ? current.geocodedAt : now,
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
        // Rule 5: neither is stored; the office checks a pin on the map.
        formattedAddress: '',
        placeId: answer.placeId,
        precision: null,
        attempts: 0,
        nextAttemptAt: null,
      };
      if (keepsVerifiedPin) {
        // The kept pin, when it came from the geocoder, is older than the
        // suggestion: one date covers both, so it is the older one.
        const heldSince =
          current.source === 'geocoded' && current.geocodedAt !== null && current.geocodedAt < obtained ? current.geocodedAt : obtained;
        return {
          ...site,
          geocode: {
            ...recorded,
            ...details,
            placeId: current.source === 'geocoded' ? current.placeId : answer.placeId,
            geocodedAt: heldSince,
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
            geocodedAt: obtained,
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
          geocodedAt: obtained,
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
          // A verified geocoded pin keeps the place it stands for.
          placeId: keepsVerifiedPin && current.source === 'geocoded' ? current.placeId : null,
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
  const source = choice.kind === 'manual' ? 'manual' : choice.kind === 'current' ? (current.source ?? 'manual') : 'geocoded';
  // A suggestion held beside a verified GEOCODED pin was stored without its
  // place (the pin kept its own): it is confirmed by address straight away,
  // and until then a technician gets the address search (rule 5).
  const placeUnknown = choice.kind === 'suggested' && current.source === 'geocoded' && hasPin(site);
  return {
    ...site,
    latitude: point.latitude,
    longitude: point.longitude,
    geocode: {
      ...current,
      status: 'verified',
      source,
      verifiedAt: now,
      verifiedBy: actorId,
      query: siteGeocodeQuery(site),
      placeId: placeUnknown ? null : current.placeId,
      error: '',
      attempts: 0,
      nextAttemptAt: placeUnknown ? now : null,
      suggestedLatitude: null,
      suggestedLongitude: null,
    },
  };
};

/** Great-circle distance in metres. */
export const metresBetween = (
  a: { readonly latitude: number; readonly longitude: number },
  b: { readonly latitude: number; readonly longitude: number },
): number => {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

/**
 * Rule 5, for a VERIFIED geocoded pin whose coordinates are due: the answer to
 * asking Google for the same place again. The office verified a PLACE; if
 * Google still puts it where it was (within 30 m), the fresh coordinates
 * replace the old ones and it stays verified. If it moved, or is gone, the
 * office decides: the pin is no longer trusted and the new point is only a
 * suggestion. A failed look-up changes nothing — the 30-day deletion
 * (`locationAfterExpiry`) still happens on time.
 */
export const locationAfterRefresh = (site: Site, answer: GeocodeAnswer, now: IsoDateTime): Site => {
  const current = siteLocationOf(site);
  const obtained = answer.obtainedAt ?? now;
  const settled = { attempts: 0, nextAttemptAt: null, formattedAddress: '', precision: null } as const;
  const point =
    answer.latitude === null || answer.longitude === null
      ? null
      : { latitude: roundCoordinate(answer.latitude), longitude: roundCoordinate(answer.longitude) };
  if ((answer.outcome === 'match' || answer.outcome === 'ambiguous') && point !== null && hasPin(site)) {
    const moved = metresBetween({ latitude: site.latitude as number, longitude: site.longitude as number }, point);
    if (moved <= PIN_REFRESH_TOLERANCE_METRES) {
      return {
        ...site,
        latitude: point.latitude,
        longitude: point.longitude,
        geocode: {
          ...current,
          ...settled,
          placeId: answer.placeId ?? current.placeId,
          provider: answer.provider,
          geocodedAt: obtained,
          error: '',
          // A pin kept through an address change: the new address is looked up
          // next, so its suggestion is a fresh one too.
          nextAttemptAt: current.status === 'stale' && siteGeocodeQuery(site).length > 0 ? now : null,
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
        ...current,
        ...settled,
        status: 'stale',
        provider: answer.provider,
        geocodedAt: obtained,
        suggestedLatitude: point.latitude,
        suggestedLongitude: point.longitude,
        error: `Google now places this site ${Math.round(moved)} m from the pin the office verified. Check the suggested pin, or set it by hand.`,
      },
    };
  }
  if (answer.outcome === 'not_found') {
    return {
      ...site,
      geocode: {
        ...current,
        status: 'stale',
        attempts: GEOCODE_MAX_ATTEMPTS,
        nextAttemptAt: null,
        error: 'Google no longer finds the place the office verified. Check the pin, or set it by hand.',
      },
    };
  }
  if (answer.outcome === 'temporary_failure') {
    const attempts = current.attempts + 1;
    const wait = Math.max(GEOCODE_BACKOFF_MINUTES[attempts - 1] ?? 720, Math.ceil((answer.retryAfterSeconds ?? 0) / 60));
    return {
      ...site,
      geocode: {
        ...current,
        attempts,
        nextAttemptAt: attempts >= GEOCODE_MAX_ATTEMPTS ? null : later(now, wait),
        error: answer.error,
      },
    };
  }
  // Not configured, or refused: nothing to ask again until the deletion is due.
  return { ...site, geocode: { ...current, attempts: GEOCODE_MAX_ATTEMPTS, nextAttemptAt: null, error: answer.error } };
};

/**
 * Rule 5, on the day: the geocoder's coordinates (pin and suggestion), its
 * wording and its precision are deleted. What is the office's stays — its
 * address, its own coordinates, who verified what and when, and the place ID
 * (which the terms let EJE keep): a verified Google place is still navigated
 * to by that place. An UNVERIFIED pin is looked up again from the address.
 * Null when there is nothing to delete.
 */
export const locationAfterExpiry = (site: Site, now: IsoDateTime): Site | null => {
  if (!siteProviderContentExpired(site, now)) return null;
  const current = siteLocationOf(site);
  const geocodedPin = current.source === 'geocoded' && hasPin(site);
  const unverified = current.status === 'resolved' || current.status === 'ambiguous';
  const query = siteGeocodeQuery(site);
  const recheck = unverified && query.length > 0;
  return {
    ...site,
    latitude: geocodedPin ? null : site.latitude,
    longitude: geocodedPin ? null : site.longitude,
    geocode: {
      ...current,
      status: recheck ? 'pending' : unverified ? 'not_requested' : current.status,
      source: geocodedPin && unverified ? null : current.source,
      query: recheck ? query : current.query,
      formattedAddress: '',
      precision: null,
      suggestedLatitude: null,
      suggestedLongitude: null,
      attempts: 0,
      nextAttemptAt: recheck ? now : current.nextAttemptAt,
      error: geocodedPin
        ? `Google’s coordinates were deleted after ${PROVIDER_COORDINATE_RETENTION_DAYS} days, as the Google Maps Platform terms require.` +
          (unverified ? ' The address is being looked up again.' : ' The verified place is kept and used for navigation.')
        : current.error,
    },
  };
};

/** For the office: how long this site's coordinates are kept, and why. */
export const siteLocationRetention = (site: Site): string => {
  const geocode = siteLocationOf(site);
  const expires = siteProviderContentExpiresAt(site);
  const by = expires === null ? '' : expires.slice(0, 10);
  const whose = geocode.provider === 'google' ? 'Google’s' : 'The geocoder’s';
  if (geocode.source === 'manual' && hasPin(site)) {
    return expires === null ? 'Entered by the office: kept.' : `Entered by the office: kept. ${whose} suggestion is deleted by ${by}.`;
  }
  if (geocode.source === 'geocoded' && hasPin(site) && expires !== null) {
    return `${whose} coordinates: refreshed or deleted by ${by} (Google’s terms allow ${PROVIDER_COORDINATE_RETENTION_DAYS} days). The place ID is kept.`;
  }
  if (geocode.source === 'geocoded' && geocode.status === 'verified' && sitePlaceReference(site) !== null) {
    return 'Verified Google place: navigation uses the place; its coordinates are refreshed when Google is set up.';
  }
  return expires === null ? '' : `${whose} suggestion is deleted by ${by}.`;
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
