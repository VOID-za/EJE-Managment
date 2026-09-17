import { describe, expect, it } from 'vitest';
import { siteAddressLine, siteHasPinnedLocation, siteNavigationUrl } from './navigation';
import { asCustomerId, asSiteId } from '../types/common';
import type { Site } from '../types/customer';

const site = (overrides: Partial<Site> = {}): Site => ({
  id: asSiteId('site-1'),
  customerId: asCustomerId('cust-1'),
  name: 'Germiston',
  addressLine1: '3 Wadeville Boulevard',
  addressLine2: 'Wadeville Ext 4',
  city: 'Germiston',
  province: 'Gauteng',
  postalCode: '1428',
  accessNotes: '',
  latitude: -26.2745,
  longitude: 28.198,
  ...overrides,
});

describe('siteNavigationUrl', () => {
  it('navigates to the pinned coordinate when the site has one', () => {
    expect(siteNavigationUrl(site())).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=-26.2745%2C28.198',
    );
  });

  it('falls back to the postal address when the site is not pinned', () => {
    const url = siteNavigationUrl(site({ latitude: null, longitude: null }));
    expect(url).toContain('3%20Wadeville%20Boulevard');
    expect(url).toContain('Germiston');
    expect(url).toContain('1428');
  });

  it('escapes the destination so an address cannot break the link', () => {
    const url = siteNavigationUrl(
      site({ latitude: null, longitude: null, addressLine1: 'Unit 7 & 8, Steel/Park' }),
    );
    expect(url).toContain('%26');
    expect(url).toContain('%2F');
    expect(() => new URL(url)).not.toThrow();
  });

  it('produces a valid, parseable URL in both cases', () => {
    for (const candidate of [site(), site({ latitude: null, longitude: null })]) {
      const parsed = new URL(siteNavigationUrl(candidate));
      expect(parsed.hostname).toBe('www.google.com');
      expect(parsed.searchParams.get('destination')).not.toBeNull();
    }
  });
});

describe('site location helpers', () => {
  it('reports whether a site has been pinned', () => {
    expect(siteHasPinnedLocation(site())).toBe(true);
    expect(siteHasPinnedLocation(site({ latitude: null, longitude: null }))).toBe(false);
  });

  it('omits empty address parts rather than leaving double commas', () => {
    expect(siteAddressLine(site({ addressLine2: '' }))).toBe(
      '3 Wadeville Boulevard, Germiston, 1428',
    );
  });
});
