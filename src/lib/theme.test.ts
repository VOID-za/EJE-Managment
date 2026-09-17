import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  readStoredPreference,
  resolveTheme,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
} from './theme';

/**
 * Theme preference logic.
 *
 * The rules that matter for the demonstration: light is the default even on a
 * machine set to dark, a stored choice wins, and anything unreadable falls back
 * to light rather than throwing.
 */

const withWindow = (impl: {
  storage?: Partial<Storage>;
  prefersDark?: boolean;
}) => {
  const store = new Map<string, string>();
  const fake = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      ...impl.storage,
    },
    matchMedia: (query: string) => ({
      matches: query.includes('dark') && impl.prefersDark === true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  };
  vi.stubGlobal('window', fake);
  return store;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('default preference', () => {
  it('is light', () => {
    expect(DEFAULT_THEME).toBe('light');
  });

  it('is light even when the device prefers dark', () => {
    withWindow({ prefersDark: true });
    expect(readStoredPreference()).toBe('light');
  });

  it('falls back to light when the stored value is not a known preference', () => {
    const store = withWindow({});
    store.set(THEME_STORAGE_KEY, 'chartreuse');
    expect(readStoredPreference()).toBe('light');
  });

  it('falls back to light when storage throws', () => {
    withWindow({
      storage: {
        getItem: () => {
          throw new Error('storage disabled');
        },
      },
    });
    expect(readStoredPreference()).toBe('light');
  });
});

describe('stored preference wins', () => {
  it('reads back a stored dark preference', () => {
    const store = withWindow({});
    store.set(THEME_STORAGE_KEY, 'dark');
    expect(readStoredPreference()).toBe('dark');
  });

  it('reads back a stored system preference', () => {
    const store = withWindow({});
    store.set(THEME_STORAGE_KEY, 'system');
    expect(readStoredPreference()).toBe('system');
  });
});

describe('resolveTheme', () => {
  it('passes explicit choices straight through', () => {
    withWindow({ prefersDark: true });
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('follows the device only when the choice is "system"', () => {
    withWindow({ prefersDark: true });
    expect(resolveTheme('system')).toBe('dark');

    vi.unstubAllGlobals();
    withWindow({ prefersDark: false });
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('boot script', () => {
  it('references the same storage key the store writes to', () => {
    expect(THEME_BOOT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  it('sets the attribute the stylesheet keys off', () => {
    expect(THEME_BOOT_SCRIPT).toContain('documentElement.dataset.theme');
  });

  it('cannot leave the page unthemed if it throws', () => {
    expect(THEME_BOOT_SCRIPT).toContain('catch');
    expect(THEME_BOOT_SCRIPT).toContain("'light'");
  });

  it('applies a stored dark preference when executed', () => {
    const element = { dataset: {} as Record<string, string> };
    const context = {
      localStorage: { getItem: () => 'dark' },
      document: { documentElement: element },
      matchMedia: () => ({ matches: false }),
    };

    // Execute the real script text against a stand-in document.
    new Function(
      'localStorage',
      'document',
      'window',
      THEME_BOOT_SCRIPT,
    )(context.localStorage, context.document, context);

    expect(element.dataset.theme).toBe('dark');
  });

  it('applies light when nothing is stored', () => {
    const element = { dataset: {} as Record<string, string> };
    const context = {
      localStorage: { getItem: () => null },
      document: { documentElement: element },
      matchMedia: () => ({ matches: true }),
    };

    new Function(
      'localStorage',
      'document',
      'window',
      THEME_BOOT_SCRIPT,
    )(context.localStorage, context.document, context);

    // The device prefers dark, but the demonstration default is light.
    expect(element.dataset.theme).toBe('light');
  });
});
