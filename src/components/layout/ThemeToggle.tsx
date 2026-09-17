'use client';

import { useSyncExternalStore } from 'react';
import { cn } from '@/lib/cn';
import { resolveTheme, themeStore, type ThemePreference } from '@/lib/theme';

/** Reads the current preference, correct on the server and after hydration. */
export const useThemePreference = (): ThemePreference =>
  useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getPreference,
    themeStore.getServerPreference,
  );

const OPTIONS: readonly {
  value: ThemePreference;
  label: string;
  icon: 'sun' | 'moon' | 'display';
}[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'system', label: 'System', icon: 'display' },
];

/**
 * Three-state theme control.
 *
 * Light is the demonstration default. "System" is offered but never assumed, so
 * a machine set to dark does not change how the demo opens.
 */
export const ThemeToggle = ({
  variant = 'chrome',
  className,
}: {
  readonly variant?: 'chrome' | 'surface';
  readonly className?: string;
}) => {
  const preference = useThemePreference();

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full p-0.5',
        variant === 'chrome' ? 'bg-white/8' : 'bg-steel-100 ring-1 ring-steel-200 ring-inset',
        className,
      )}
    >
      {OPTIONS.map((option) => {
        const active = preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${option.label} theme`}
            title={`${option.label} theme`}
            onClick={() => themeStore.set(option.value)}
            className={cn(
              'flex size-8 items-center justify-center rounded-full transition-colors',
              active
                ? variant === 'chrome'
                  ? 'bg-action text-white'
                  : 'bg-surface text-steel-900 shadow-sm'
                : variant === 'chrome'
                  ? 'text-chrome-dim hover:text-chrome-muted'
                  : 'text-steel-500 hover:text-steel-800',
            )}
          >
            <ThemeIcon name={option.icon} />
          </button>
        );
      })}
    </div>
  );
};

/** Single-button variant for the top bar: flips between light and dark. */
export const ThemeToggleButton = ({ className }: { readonly className?: string }) => {
  const preference = useThemePreference();
  const resolved = resolveTheme(preference);
  const next = resolved === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={() => themeStore.set(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={cn(
        'rounded-[var(--radius-control)] p-2.5 text-steel-600 transition-colors hover:bg-steel-100',
        className,
      )}
    >
      <ThemeIcon name={resolved === 'dark' ? 'moon' : 'sun'} />
    </button>
  );
};

const ThemeIcon = ({ name }: { readonly name: 'sun' | 'moon' | 'display' }) => {
  if (name === 'moon') {
    return (
      <svg
        viewBox="0 0 24 24"
        className="size-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
      </svg>
    );
  }

  if (name === 'display') {
    return (
      <svg
        viewBox="0 0 24 24"
        className="size-[18px]"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8m-4-4v4" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
};
