import type { CustomerId } from '../types/common';
import type { Site } from '../types/customer';

/**
 * ONE SITE PER CUSTOMER. Owner decision, 26 October 2026 (SITE-1).
 *
 * A customer has one site: the address a technician is sent to. A customer
 * keeps as many CONTACTS as it needs. The register used to allow any number of
 * sites, so some customers were recorded with several before the rule existed;
 * those are LEGACY records and are never merged, archived or rewritten behind
 * anybody's back. The office consolidates one deliberately — choosing which
 * site is the customer's — and until it does, the screens say what they found.
 *
 * Archived sites do not count: they are history, kept so the jobs done there
 * still read correctly, and never offered again.
 */
export const activeSitesOf = (sites: readonly Site[], customerId: CustomerId): readonly Site[] =>
  sites.filter((site) => site.customerId === customerId && site.archivedAt === null);

export type CustomerSiteState =
  | { readonly kind: 'none' }
  | { readonly kind: 'single'; readonly site: Site }
  /** Recorded before SITE-1. The office chooses which one is the customer's. */
  | { readonly kind: 'legacy_multiple'; readonly sites: readonly Site[] };

export const customerSiteState = (
  sites: readonly Site[],
  customerId: CustomerId,
): CustomerSiteState => {
  const active = activeSitesOf(sites, customerId);
  if (active.length === 0) return { kind: 'none' };
  if (active.length === 1) return { kind: 'single', site: active[0]! };
  return { kind: 'legacy_multiple', sites: active };
};

/**
 * A pinned location, validated. SITE-3.
 *
 * Both or neither: half a coordinate is not a place. Bounded to the globe and
 * rounded to the six decimals the column holds (about 0.1 m), so what is saved
 * is what is read back. Never invented: a site with no pin keeps `null`, and
 * the map link then searches its address instead.
 */
export type CoordinateCheck =
  | { readonly ok: true; readonly latitude: number | null; readonly longitude: number | null }
  | { readonly ok: false; readonly code: string; readonly message: string };

const round6 = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

export const checkCoordinates = (
  latitude: number | null,
  longitude: number | null,
): CoordinateCheck => {
  if (latitude === null && longitude === null) return { ok: true, latitude: null, longitude: null };
  if (latitude === null || longitude === null) {
    return {
      ok: false,
      code: 'coordinates_incomplete',
      message: 'Give both the latitude and the longitude, or clear both.',
    };
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { ok: false, code: 'latitude_out_of_range', message: 'Latitude must be between -90 and 90.' };
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return {
      ok: false,
      code: 'longitude_out_of_range',
      message: 'Longitude must be between -180 and 180.',
    };
  }
  return { ok: true, latitude: round6(latitude), longitude: round6(longitude) };
};
