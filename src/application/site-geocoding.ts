import {
  can,
  geocodeCacheKey,
  locationAfterGeocode,
  locationAfterRequeue,
  locationAfterVerify,
  siteLocationLabel,
  siteLocationNeedsAttention,
  siteLocationOf,
  userFullName,
  type GeocodeAnswer,
  type IsoDateTime,
  type Site,
  type SiteId,
} from '@/domain';
import type { GeocodingService } from '@/services/ports';
import type { AppServices, OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';

/**
 * THE AUTOMATIC SITE PIN, APPLIED. INT-MAP-1..3. The rules are in
 * `domain/site/location.ts`; this file runs them against the store and the
 * geocoder.
 *
 * NO TRANSACTION IS HELD ACROSS A CALL TO GOOGLE. One site is three steps:
 * `prepareSiteGeocode` (in a transaction: the cache, and the daily cap),
 * the call itself (`answerFor`, outside any transaction), and
 * `applySiteGeocode` (in a transaction, and only if the site still has the
 * address that was asked about). The demonstration and the tests run the
 * three in one context (`geocodeDueSitesInline`).
 *
 * WHAT IT COSTS. A site is geocoded when its address is written or changed —
 * never when a job is opened. The same address is answered from the cache
 * for 30 days (the Google Maps Platform terms allow coordinates to be cached
 * for 30 days), and the application stops itself at a daily cap
 * (GOOGLE_GEOCODING_DAILY_LIMIT, default 500) before Google's own quota.
 */

export const GEOCODING_SERVICE_NAME = 'google_geocoding';
const CACHE_DAYS = 30;
const BATCH = 5;
/** A claimed site is not taken again by another worker for this long. */
const LEASE_MINUTES = 10;

const refuse = (message: string, code: string, detail: string): WorkflowError =>
  new WorkflowError(message, [{ code, message: detail }]);

const assertOffice = (context: OperationContext): void => {
  if (!can(context.actor.role, 'customers.manage')) {
    throw refuse('Only the office manages site pins.', 'not_permitted', 'A Master or a Coordinator verifies and corrects site pins.');
  }
};

const geocoderOf = (services: AppServices): GeocodingService | null =>
  services.geocoding === undefined || !services.geocoding.configured ? null : services.geocoding;

const plus = (now: IsoDateTime, minutes: number): IsoDateTime =>
  new Date(Date.parse(now) + minutes * 60_000).toISOString() as IsoDateTime;

const NOT_CONFIGURED: GeocodeAnswer = {
  outcome: 'not_configured',
  latitude: null,
  longitude: null,
  formattedAddress: '',
  placeId: null,
  precision: null,
  provider: 'none',
  error: 'Automatic pins are not set up on this system (GOOGLE_MAPS_GEOCODING_API_KEY is not set).',
};

/** Sites due, each leased so a second worker does not ask Google twice. */
export const claimDueSites = async (context: OperationContext, limit = BATCH): Promise<readonly Site[]> => {
  const now = context.services.clock.now();
  const due = await context.repos.customers.listSitesDueForGeocode(now, limit);
  const claimed: Site[] = [];
  for (const site of due) {
    const geocode = siteLocationOf(site);
    const leased: Site = { ...site, geocode: { ...geocode, nextAttemptAt: plus(now, LEASE_MINUTES) } };
    if (await context.repos.customers.saveSiteLocation(leased, geocode.query)) claimed.push(leased);
  }
  return claimed;
};

export type GeocodePlan =
  | { readonly kind: 'answered'; readonly answer: GeocodeAnswer; readonly fromCache: boolean }
  | { readonly kind: 'ask'; readonly query: string };

/** The cache, then the daily cap, then — only then — Google. */
export const prepareSiteGeocode = async (context: OperationContext, site: Site): Promise<GeocodePlan> => {
  const geocoder = geocoderOf(context.services);
  if (geocoder === null) return { kind: 'answered', answer: NOT_CONFIGURED, fromCache: false };
  const query = siteLocationOf(site).query;
  const now = context.services.clock.now();
  const cached = await context.repos.integrations.findGeocode(geocodeCacheKey(query, geocoder.region), now);
  if (cached !== null) return { kind: 'answered', answer: cached.result as unknown as GeocodeAnswer, fromCache: true };

  const day = now.slice(0, 10);
  const used = await context.repos.integrations.countRequest(day, GEOCODING_SERVICE_NAME);
  const limit = geocoder.dailyLimit ?? 500;
  if (used > limit) {
    const tomorrow = Date.parse(`${day}T00:00:00.000Z`) + 24 * 3600_000;
    return {
      kind: 'answered',
      fromCache: false,
      answer: {
        ...NOT_CONFIGURED,
        outcome: 'temporary_failure',
        provider: geocoder.provider,
        error: `EJE's daily limit of ${limit} address look-ups was reached; this one waits until tomorrow.`,
        retryAfterSeconds: Math.max(60, Math.ceil((tomorrow - Date.parse(now)) / 1000)),
      },
    };
  }
  return { kind: 'ask', query };
};

/** The call to the provider, outside any transaction. Never throws. */
export const answerFor = async (services: AppServices, query: string): Promise<GeocodeAnswer> => {
  const geocoder = geocoderOf(services);
  if (geocoder === null) return NOT_CONFIGURED;
  try {
    return await geocoder.geocode(query);
  } catch {
    return { ...NOT_CONFIGURED, outcome: 'temporary_failure', provider: geocoder.provider, error: 'The geocoder could not be reached.' };
  }
};

/** Applies an answer — if the site still has the address it answers for. */
export const applySiteGeocode = async (
  context: OperationContext,
  siteId: SiteId,
  query: string,
  answer: GeocodeAnswer,
  fromCache: boolean,
): Promise<Site | null> => {
  const now = context.services.clock.now();
  const geocoder = geocoderOf(context.services);
  if (!fromCache && geocoder !== null && (answer.outcome === 'match' || answer.outcome === 'ambiguous' || answer.outcome === 'not_found')) {
    await context.repos.integrations.saveGeocode({
      queryKey: geocodeCacheKey(query, geocoder.region),
      provider: answer.provider,
      outcome: answer.outcome,
      result: { ...answer },
      createdAt: now,
      expiresAt: plus(now, CACHE_DAYS * 24 * 60),
    });
  }
  const site = await context.repos.customers.findSiteById(siteId);
  if (site === null) return null;
  const next = locationAfterGeocode(site, query, answer, now);
  if (next === null) return null; // the address changed while the question was out
  if (!(await context.repos.customers.saveSiteLocation(next, query))) return null;

  const before = siteLocationOf(site);
  const after = siteLocationOf(next);
  if (after.status !== before.status || after.suggestedLatitude !== before.suggestedLatitude || next.latitude !== site.latitude) {
    await audit(context, {
      jobId: null,
      type: 'site_location_geocoded',
      summary: `Site pin: ${next.name} — ${siteLocationLabel(after.status)}`,
      detail:
        (answer.outcome === 'match' || answer.outcome === 'ambiguous'
          ? `${answer.provider === 'simulated' ? 'The demonstration geocoder (simulated)' : 'Google'} matched “${query}” to “${answer.formattedAddress}” (${answer.precision ?? 'precision not given'})${fromCache ? ', from the cache' : ''}. `
          : '') +
        (after.status === 'resolved'
          ? 'The pin is set and is used for navigation; the office has not checked it yet.'
          : after.status === 'verified' || after.status === 'stale'
            ? 'The office’s verified pin was kept; the new match is offered as a suggestion.'
            : after.error),
      changes:
        next.latitude === site.latitude && next.longitude === site.longitude
          ? []
          : [
              {
                field: 'Location',
                from: site.latitude === null ? 'Not pinned' : `${site.latitude}, ${site.longitude}`,
                to: next.latitude === null ? 'Not pinned' : `${next.latitude}, ${next.longitude}`,
              },
            ],
    });
  }
  return next;
};

/** All three steps in one context: the demonstration's and the tests' way. */
export const geocodeDueSitesInline = async (context: OperationContext, limit = BATCH): Promise<number> => {
  const claimed = await claimDueSites(context, limit);
  for (const site of claimed) {
    const query = siteLocationOf(site).query;
    const plan = await prepareSiteGeocode(context, site);
    const answer = plan.kind === 'answered' ? plan.answer : await answerFor(context.services, plan.query);
    await applySiteGeocode(context, site.id, query, answer, plan.kind === 'answered' && plan.fromCache);
  }
  return claimed.length;
};

/** After a site is saved: outside the API, look its pin up now. */
export const geocodeAfterSave = async (context: OperationContext, site: Site): Promise<Site> => {
  if (context.deferDelivery === true || siteLocationOf(site).nextAttemptAt === null) return site;
  await geocodeDueSitesInline(context);
  return (await context.repos.customers.findSiteById(site.id)) ?? site;
};

/* -------------------------------------------------------------------------- */
/* The office                                                                 */
/* -------------------------------------------------------------------------- */

export type PinChoice =
  | { readonly kind: 'current' }
  | { readonly kind: 'suggested' }
  | { readonly kind: 'manual'; readonly latitude: number; readonly longitude: number };

/** The office checks the pin, takes the suggestion, or types the coordinates. */
export const verifySiteLocation = async (context: OperationContext, siteId: SiteId, choice: PinChoice): Promise<Site> => {
  assertOffice(context);
  const site = await context.repos.customers.findSiteById(siteId);
  if (site === null) throw refuse('That site does not exist.', 'unknown_site', 'Reload the customer.');
  if (choice.kind === 'manual') {
    const valid =
      Number.isFinite(choice.latitude) &&
      Number.isFinite(choice.longitude) &&
      Math.abs(choice.latitude) <= 90 &&
      Math.abs(choice.longitude) <= 180 &&
      !(choice.latitude === 0 && choice.longitude === 0);
    if (!valid) throw refuse('Those coordinates are not valid.', 'invalid_location', 'Latitude is between -90 and 90 and longitude between -180 and 180 (South Africa is about -22 to -35, 16 to 33).');
  }
  const before = siteLocationOf(site);
  if (choice.kind === 'suggested' && (before.suggestedLatitude === null || before.suggestedLongitude === null)) {
    throw refuse('There is no suggested pin to use.', 'no_suggestion', 'Find the pin again, or type the coordinates.');
  }
  if (choice.kind === 'current' && (site.latitude === null || site.longitude === null)) {
    throw refuse('This site has no pin to verify.', 'no_pin', 'Use the suggestion, or type the coordinates.');
  }
  const now = context.services.clock.now();
  const next = locationAfterVerify(site, choice, context.actor.id, now);
  await context.repos.customers.saveSiteLocation(next, before.query);
  // The query was re-read from the address by the verify; record it as well.
  const saved = (await context.repos.customers.findSiteById(siteId)) ?? next;
  if (siteLocationOf(saved).query !== siteLocationOf(next).query) {
    await context.repos.customers.saveSiteLocation(next, siteLocationOf(saved).query);
  }
  await audit(context, {
    jobId: null,
    type: 'site_location_verified',
    summary: `Site pin verified: ${site.name}`,
    detail: `${userFullName(context.actor)} ${choice.kind === 'manual' ? 'set the pin by hand' : choice.kind === 'suggested' ? 'accepted the suggested pin' : 'checked the pin'} for ${site.name}. It is now the verified pin and is never replaced automatically.`,
    changes: [
      {
        field: 'Location',
        from: site.latitude === null ? 'Not pinned' : `${site.latitude}, ${site.longitude} (${siteLocationLabel(before.status)})`,
        to: `${next.latitude}, ${next.longitude} (verified)`,
      },
    ],
  });
  return (await context.repos.customers.findSiteById(siteId)) ?? next;
};

/** Look a site's pin up again: after setup, or after a failure was fixed. */
export const requeueSiteGeocode = async (context: OperationContext, siteId: SiteId): Promise<Site> => {
  assertOffice(context);
  const site = await context.repos.customers.findSiteById(siteId);
  if (site === null) throw refuse('That site does not exist.', 'unknown_site', 'Reload the customer.');
  const before = siteLocationOf(site);
  const next = locationAfterRequeue(site, context.services.clock.now());
  if (siteLocationOf(next).query.length === 0) throw refuse('This site has no address to look up.', 'no_address', 'Enter the address first.');
  await context.repos.customers.saveSiteLocation(next, before.query);
  if (before.query !== siteLocationOf(next).query) await context.repos.customers.saveSiteLocation(next, siteLocationOf(next).query);
  return geocodeAfterSave(context, (await context.repos.customers.findSiteById(siteId)) ?? next);
};

/**
 * Every live site whose pin needs somebody — for Administration. Sites with
 * no pin yet (`not_requested`) are included: they predate automatic pins.
 */
export const listSitesNeedingAttention = async (
  context: OperationContext,
): Promise<readonly { readonly site: Site; readonly customerName: string }[]> => {
  assertOffice(context);
  const [sites, customers] = await Promise.all([context.repos.customers.listSites(), context.repos.customers.list()]);
  return sites
    .filter((site) => site.archivedAt === null)
    .filter((site) => {
      const status = siteLocationOf(site).status;
      return siteLocationNeedsAttention(status) || status === 'not_requested' || status === 'not_configured' || status === 'pending';
    })
    .map((site) => ({ site, customerName: customers.find((customer) => customer.id === site.customerId)?.name ?? '' }));
};

/**
 * Asks for pins for sites that have none (up to `limit` at a time, so one
 * press cannot spend a month's free requests). Verified pins are never touched.
 */
export const requeueUnpinnedSites = async (context: OperationContext, limit = 25): Promise<number> => {
  assertOffice(context);
  const sites = await context.repos.customers.listSites();
  const now = context.services.clock.now();
  let queued = 0;
  for (const site of sites) {
    if (queued >= limit) break;
    if (site.archivedAt !== null) continue;
    const before = siteLocationOf(site);
    if (!['not_requested', 'not_configured', 'failed'].includes(before.status)) continue;
    const next = locationAfterRequeue(site, now);
    const query = siteLocationOf(next).query;
    if (query.length === 0) continue;
    // A site that predates 0042 in the demonstration has no record yet; write it.
    const ok =
      (await context.repos.customers.saveSiteLocation(next, before.query)) ||
      (await context.repos.customers.saveSiteLocation(next, query));
    if (ok) queued += 1;
  }
  if (queued > 0 && context.deferDelivery !== true) await geocodeDueSitesInline(context, queued);
  return queued;
};
