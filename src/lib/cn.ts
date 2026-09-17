/**
 * Minimal class-name joiner.
 *
 * The demo deliberately avoids `clsx`/`tailwind-merge`: the component API keeps
 * variants in lookup tables rather than concatenating conflicting utilities, so
 * merge semantics are not needed.
 */
export type ClassValue = string | false | null | undefined;

export const cn = (...values: ClassValue[]): string =>
  values.filter((value): value is string => typeof value === 'string' && value.length > 0).join(' ');
