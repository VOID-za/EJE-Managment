import { describe, expect, it } from 'vitest';
import { describeCacheStatus, formatRefreshedAt, type CacheStatusInput } from './cache-state';

/**
 * WHAT A TECHNICIAN IS TOLD ABOUT THE LIST IN FRONT OF THEM. PWA-6, OFF-8.
 *
 * The failure this guards against does not look like a failure: a job list
 * that renders perfectly and happens to be four days old. The technician
 * trusts it either way and drives to a job that was cancelled on Monday. So
 * every state below is asserted on three things — what it says, whether it
 * admits to being stale, and whether it may show cached records at all.
 */
const input = (overrides: Partial<CacheStatusInput> = {}): CacheStatusInput => ({
  online: true,
  refreshing: false,
  signedIn: true,
  lastRefreshedAt: '2026-10-17T09:14:03.000Z',
  lastRefreshFailed: false,
  hasCachedCopy: true,
  ...overrides,
});

describe('being signed out', () => {
  it('beats every other state and shows nothing', () => {
    // A tablet is handed between shifts. Whoever is holding it now is not
    // necessarily whose jobs are cached on it.
    const status = describeCacheStatus(
      input({ signedIn: false, online: false, lastRefreshFailed: true }),
    );
    expect(status.kind).toBe('signed_out');
    expect(status.showsCachedData).toBe(false);
    expect(status.stale).toBe(true);
  });
});

describe('with a working connection', () => {
  it('says it is up to date, and says when', () => {
    const status = describeCacheStatus(input());
    expect(status.kind).toBe('online_current');
    expect(status.stale).toBe(false);
    expect(status.showsCachedData).toBe(true);
    expect(status.detail).toContain(formatRefreshedAt('2026-10-17T09:14:03.000Z'));
  });

  it('does not claim to be current while a refresh is still in flight', () => {
    const status = describeCacheStatus(input({ refreshing: true }));
    expect(status.kind).toBe('online_refreshing');
    expect(status.stale).toBe(true);
  });

  it('is not stale on a first load, because there is no older copy to mistake', () => {
    const status = describeCacheStatus(
      input({ refreshing: true, lastRefreshedAt: null, hasCachedCopy: false }),
    );
    expect(status.stale).toBe(false);
  });
});

describe('when the server could not be reached', () => {
  /*
   * THE CASE `navigator.onLine` GETS WRONG, and the reason the failure of a
   * real request outranks it: a tablet on a plant's WiFi with no route out,
   * and a captive portal, both report online.
   */
  it('believes the failed request over the browser’s claim to be online', () => {
    const status = describeCacheStatus(input({ online: true, lastRefreshFailed: true }));
    expect(status.kind).toBe('refresh_failed');
    expect(status.stale).toBe(true);
    expect(status.showsCachedData).toBe(true);
    expect(status.detail).toContain('may be out of date');
  });

  it('says there is nothing, rather than showing an empty list', () => {
    // An empty list reads as "no jobs today", which is a different fact and
    // the one that would send a technician home.
    const status = describeCacheStatus(
      input({ lastRefreshFailed: true, hasCachedCopy: false, lastRefreshedAt: null }),
    );
    expect(status.kind).toBe('offline_empty');
    expect(status.showsCachedData).toBe(false);
    expect(status.detail).toContain('no cached copy');
  });
});

describe('offline', () => {
  it('shows the cached copy and timestamps it', () => {
    const status = describeCacheStatus(input({ online: false }));
    expect(status.kind).toBe('offline_cached');
    expect(status.title).toBe('Offline');
    expect(status.stale).toBe(true);
    expect(status.detail).toContain(formatRefreshedAt('2026-10-17T09:14:03.000Z'));
  });

  it('admits to a cold cache', () => {
    const status = describeCacheStatus(
      input({ online: false, hasCachedCopy: false, lastRefreshedAt: null }),
    );
    expect(status.kind).toBe('offline_empty');
    expect(status.showsCachedData).toBe(false);
  });
});

describe('the timestamp', () => {
  it('reads as a time and a day', () => {
    // Formatted in the viewer's own zone, so the assertion is on the shape
    // rather than on a literal that a timezone would break. QA-5.
    expect(formatRefreshedAt('2026-10-17T09:14:03.000Z')).toMatch(
      /^\d{2}:\d{2}\son\s\d{1,2}\s\w{3}$/u,
    );
  });

  it('says "never" rather than inventing a date', () => {
    expect(formatRefreshedAt(null)).toBe('never');
    expect(formatRefreshedAt('not a date at all')).toBe('never');
  });
});
