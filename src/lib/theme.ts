/**
 * Theme preference.
 *
 * Deliberately a tiny external store rather than a dependency or React state:
 * the document's `data-theme` attribute has to be correct before React hydrates,
 * otherwise the page flashes light before switching. The inline boot script in
 * the root layout sets the attribute; this store keeps it in sync afterwards and
 * lets React subscribe through `useSyncExternalStore`.
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'eje.demo.theme.v1';

/** Light is the demonstration default, including when nothing is stored. */
export const DEFAULT_THEME: ThemePreference = 'light';

const isPreference = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system';

export const readStoredPreference = (): ThemePreference => {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
};

export const systemPrefersDark = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

export const resolveTheme = (preference: ThemePreference): ResolvedTheme =>
  preference === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : preference;

export const applyTheme = (resolved: ResolvedTheme): void => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolved;
};

/**
 * Runs before first paint, inlined into the document head.
 *
 * Kept as a single compact expression with its own try/catch: if anything here
 * throws, the page must still render in the default light theme rather than
 * fail to boot.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var k=${JSON.stringify(
  THEME_STORAGE_KEY,
)};var p=localStorage.getItem(k);if(p!=='light'&&p!=='dark'&&p!=='system'){p=${JSON.stringify(
  DEFAULT_THEME,
)};}var r=p==='system'?(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):p;document.documentElement.dataset.theme=r;}catch(e){document.documentElement.dataset.theme='light';}})();`;

type Listener = () => void;

class ThemeStore {
  private preference: ThemePreference = DEFAULT_THEME;
  private loaded = false;
  private readonly listeners = new Set<Listener>();
  private mediaQuery: MediaQueryList | null = null;

  getPreference = (): ThemePreference => {
    if (!this.loaded) {
      this.loaded = true;
      this.preference = readStoredPreference();
      this.watchSystem();
    }
    return this.preference;
  };

  /** The server always renders the default, so hydration cannot mismatch. */
  getServerPreference = (): ThemePreference => DEFAULT_THEME;

  set = (preference: ThemePreference): void => {
    this.loaded = true;
    this.preference = preference;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Persistence is a convenience; the choice still applies for this session.
    }
    this.watchSystem();
    applyTheme(resolveTheme(preference));
    this.emit();
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Follow the OS only while the user has explicitly chosen "system". */
  private watchSystem(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;

    if (this.mediaQuery === null) {
      this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this.mediaQuery.addEventListener('change', () => {
        if (this.preference !== 'system') return;
        applyTheme(resolveTheme('system'));
        this.emit();
      });
    }
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

export const themeStore = new ThemeStore();
