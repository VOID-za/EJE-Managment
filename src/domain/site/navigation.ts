import type { Site } from '../types/customer';

/**
 * Navigation links for a site.
 *
 * This is a deep link, not an integration: building a Google Maps URL needs no
 * API key, no SDK and no account, so nothing here has to be mocked now or
 * swapped later. If EJE ever wants embedded maps or geocoding, that WOULD be an
 * integration and would sit behind a service port like the others.
 *
 * A pinned coordinate is preferred over the postal address because industrial
 * estates routinely geocode to the wrong gate.
 */
export const siteHasPinnedLocation = (site: Site): boolean =>
  site.latitude !== null && site.longitude !== null;

/** One-line address, used in messages and as the geocoding fallback. */
export const siteAddressLine = (site: Site): string =>
  [site.addressLine1, site.addressLine2, site.city, site.postalCode]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(', ');

/**
 * A turn-by-turn navigation link, opening in whichever maps app the technician
 * has installed. Uses the documented, stable Google Maps URL format.
 */
export const siteNavigationUrl = (site: Site): string => {
  const destination = siteHasPinnedLocation(site)
    ? `${site.latitude},${site.longitude}`
    : siteAddressLine(site);

  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
};
