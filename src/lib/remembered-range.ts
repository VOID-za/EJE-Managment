/**
 * THE LAST FROM/TO A PERSON CHOSE ON A PAGE. FILTER-MEM-1 (the tester,
 * 2 November 2026): "Remember the last-used From and To filters when the user
 * leaves the page and returns" — on Attendance and on Timesheets.
 *
 * Per page AND per person, in this browser only: a tablet two technicians
 * share must not open one of them on the other's dates. A convenience, never a
 * record: storage that is unavailable (a private window, a full quota) simply
 * means the page opens on its defaults, and a stored value that is not a valid
 * range, or is longer than the page allows, is ignored.
 */
export interface DateRange {
  readonly from: string;
  readonly to: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

const keyOf = (page: string, userId: string): string => `eje.range.${page}.${userId}`;

const spanDays = (range: DateRange): number =>
  (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1;

/** Whether a value is a usable range: two real days, in order, at most `maxDays` long. */
export const isUsableRange = (value: unknown, maxDays: number): value is DateRange => {
  if (typeof value !== 'object' || value === null) return false;
  const { from, to } = value as Record<string, unknown>;
  if (typeof from !== 'string' || typeof to !== 'string' || !DAY.test(from) || !DAY.test(to)) return false;
  // A real calendar day: 2026-02-30 parses (to 2 March), so it must read back unchanged.
  const real = (day: string) => { const at = Date.parse(`${day}T00:00:00Z`); return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === day; };
  if (!real(from) || !real(to)) return false;
  return from <= to && spanDays({ from, to }) <= maxDays;
};

export const readRememberedRange = (page: string, userId: string, maxDays: number): DateRange | null => {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(keyOf(page, userId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isUsableRange(parsed, maxDays) ? { from: parsed.from, to: parsed.to } : null;
  } catch {
    return null;
  }
};

export const rememberRange = (page: string, userId: string, range: DateRange): void => {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(keyOf(page, userId), JSON.stringify({ from: range.from, to: range.to }));
  } catch {
    // Not remembered; the page still works on what was chosen.
  }
};
