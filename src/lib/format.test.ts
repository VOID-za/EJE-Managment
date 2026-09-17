import { describe, expect, it } from 'vitest';
import { formatCurrency, formatDate, formatDateTime, formatNumber } from './format';

/**
 * These assertions exist because money and dates are printed on a signed
 * customer document. Formatting must not vary between the server render, the
 * browser render, or the ICU data of whatever runtime happens to be in use.
 */
const NBSP = ' ';

describe('formatCurrency', () => {
  it('formats whole amounts with a grouped thousands separator', () => {
    expect(formatCurrency(190000)).toBe(`R${NBSP}1${NBSP}900,00`);
  });

  it('formats amounts below one rand', () => {
    expect(formatCurrency(5)).toBe(`R${NBSP}0,05`);
    expect(formatCurrency(0)).toBe(`R${NBSP}0,00`);
  });

  it('groups millions correctly', () => {
    expect(formatCurrency(123456789)).toBe(`R${NBSP}1${NBSP}234${NBSP}567,89`);
  });

  it('formats negative amounts with a leading sign', () => {
    expect(formatCurrency(-25050)).toBe(`-R${NBSP}250,50`);
  });
});

describe('formatNumber', () => {
  it('drops trailing zeroes from quantities', () => {
    expect(formatNumber(3, 2)).toBe('3');
    expect(formatNumber(3.5, 2)).toBe('3,5');
    expect(formatNumber(3.25, 2)).toBe('3,25');
  });

  it('groups large quantities', () => {
    expect(formatNumber(12345.5, 1)).toBe(`12${NBSP}345,5`);
  });
});

describe('date formatting', () => {
  it('formats a calendar date deterministically', () => {
    expect(formatDate('2026-09-07')).toBe('07 Sep 2026');
  });

  it('returns an em dash for missing values', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime(null)).toBe('—');
  });
});
