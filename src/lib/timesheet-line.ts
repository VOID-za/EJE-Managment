import {
  TIMESHEET_MAX_CALLOUT_CENTS,
  TIMESHEET_MAX_HOURS_PER_DAY,
  TIMESHEET_MAX_KM_PER_LINE,
  type TimesheetEntry,
} from '@/domain';

/**
 * A TIMESHEET LINE BEING TYPED. TST-TS-2 (the tester, 31 October 2026).
 *
 * Strings, exactly as the technician typed them, so nothing they typed is
 * rewritten under their fingers. Kept out of the page so the form that holds
 * one can live in its own component: typing then re-renders the form alone,
 * not the month of lines around it (see `TimesheetLineForm`).
 */
export interface TimesheetDraft {
  readonly entryId?: string;
  /**
   * The day the form was OPENED on, and where it stays while it is open.
   *
   * THE 30 OCTOBER 2026 FREEZE. The form used to be drawn under whichever day
   * equalled `date` — the value being TYPED — so one keystroke in Date that
   * matched no day removed the form from the page. Drawn under `anchor`, it
   * never moves while it is open; the typed date is validated where it is
   * typed (`lineDateProblem`) and the line lands on its date when saved.
   */
  readonly anchor: string;
  readonly date: string;
  /** A customer id, `WORKSHOP_PICK`, or '' for a typed name. */
  readonly pick: string;
  readonly customerName: string;
  readonly overtime: string;
  readonly double: string;
  /** Rand, as typed ("450" or "450.00"). */
  readonly callout: string;
  readonly calloutShared: boolean;
  readonly internalKm: string;
  readonly customerKm: string;
  /** An older line's NT and call-out count, carried back unchanged (TS-07/08). */
  readonly keepNormal?: number;
  readonly keepCallouts?: number;
}

/** The customer picker's value for Workshop: not a customer id, never sent as one. */
export const WORKSHOP_PICK = '__workshop__';

export const emptyTimesheetDraft = (date: string): TimesheetDraft => ({
  anchor: date,
  date,
  pick: '',
  customerName: '',
  overtime: '0',
  double: '0',
  callout: '0',
  calloutShared: false,
  internalKm: '0',
  customerKm: '0',
});

export const timesheetDraftOf = (entry: TimesheetEntry): TimesheetDraft => ({
  entryId: entry.id,
  anchor: entry.date,
  date: entry.date,
  pick: entry.workshop ? WORKSHOP_PICK : entry.customerId ?? '',
  customerName: entry.workshop ? '' : entry.customerName,
  overtime: String(entry.overtimeHours),
  double: String(entry.doubleHours),
  callout: (entry.calloutAmount / 100).toFixed(2),
  calloutShared: entry.calloutShared,
  internalKm: String(entry.internalKm),
  customerKm: String(entry.customerKm),
  keepNormal: entry.normalHours,
  keepCallouts: entry.callouts,
});

/** A typed number, with a comma accepted as the decimal mark. Blank is 0. NaN when it is not a number. */
export const parseTyped = (value: string): number => {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed.length === 0) return 0;
  return /^\d*\.?\d*$/u.test(trimmed) && trimmed !== '.' ? Number.parseFloat(trimmed) : Number.NaN;
};

/** Rand as typed, to whole cents. NaN stays NaN so the line is refused. */
export const randToCents = (value: string): number => Math.round(parseTyped(value) * 100);

export type TimesheetDraftField = 'customer' | 'overtime' | 'double' | 'callout' | 'internalKm' | 'customerKm';

const hoursProblem = (label: string, typed: string): string | null => {
  const value = parseTyped(typed);
  if (!Number.isFinite(value) || value < 0 || value > TIMESHEET_MAX_HOURS_PER_DAY) return `${label}: enter hours from 0 to 24.`;
  if (Math.abs(value * 4 - Math.round(value * 4)) > 1e-9) return `${label}: use quarter hours (0.25 = 15 minutes).`;
  return null;
};

const kmProblem = (label: string, typed: string): string | null => {
  const value = parseTyped(typed);
  if (!Number.isFinite(value) || value < 0 || value > TIMESHEET_MAX_KM_PER_LINE) return `${label}: enter kilometres from 0 to ${TIMESHEET_MAX_KM_PER_LINE}.`;
  if (Math.abs(value * 10 - Math.round(value * 10)) > 1e-9) return `${label}: one decimal at most, for example 12.5.`;
  return null;
};

/**
 * WHAT IS WRONG WITH A LINE, FIELD BY FIELD, BEFORE IT IS SENT.
 *
 * The SERVER's rules (`normaliseTimesheetLine`), asked again in the browser so
 * the answer appears beside the field being typed in. Before this, a refusal
 * was printed in the period card at the top of the page — off screen whenever
 * the line was a few days down — and pressing Save line appeared to do
 * nothing (found by the 31 October 2026 reproduction). The server still asks
 * every one of these questions itself; this only says it sooner.
 */
export const timesheetDraftProblems = (draft: TimesheetDraft): Partial<Record<TimesheetDraftField, string>> => {
  const problems: Partial<Record<TimesheetDraftField, string>> = {};
  const overtime = hoursProblem('OT', draft.overtime);
  if (overtime !== null) problems.overtime = overtime;
  const double = hoursProblem('D/T', draft.double);
  if (double !== null) problems.double = double;
  const cents = randToCents(draft.callout);
  if (!Number.isFinite(cents) || cents < 0 || cents > TIMESHEET_MAX_CALLOUT_CENTS) {
    problems.callout = 'Callout: enter an amount in rand, for example 450 or 450.00.';
  } else if (Math.abs(parseTyped(draft.callout) * 100 - cents) > 1e-6) {
    problems.callout = 'Callout: rand and cents only (two decimals).';
  } else if (draft.calloutShared && cents === 0) {
    problems.callout = 'A shared call-out needs your share of the amount, or untick Shared.';
  }
  const internalKm = kmProblem('Int Km', draft.internalKm);
  if (internalKm !== null) problems.internalKm = internalKm;
  const customerKm = kmProblem('Cust Km', draft.customerKm);
  if (customerKm !== null) problems.customerKm = customerKm;

  const workshop = draft.pick === WORKSHOP_PICK;
  const named = draft.customerName.trim().length > 0 || (draft.pick.length > 0 && !workshop);
  const anything =
    (draft.keepNormal ?? 0) + (draft.keepCallouts ?? 0) +
    [draft.overtime, draft.double, draft.internalKm, draft.customerKm].reduce((total, typed) => total + (parseTyped(typed) || 0), 0) +
    (Number.isFinite(cents) ? cents : 0) > 0;
  if (anything && !workshop && !named) problems.customer = 'Say which customer the work was for, or choose Workshop.';
  return problems;
};

/**
 * AN OPEN LINE SURVIVES THE TAB BEING RELOADED OR CLOSED. TST-TS-2.
 *
 * Android drops a background tab when the tablet is short of memory, and an
 * update reload can happen mid-line. The open line is written to this device's
 * storage as it is typed and offered back when the timesheet opens again;
 * saving or cancelling the line removes it. Storage that is unavailable
 * (private mode, blocked site data) simply means nothing is kept — the page
 * works exactly as it did, and still warns before the tab is closed.
 */
export const timesheetDraftKey = (viewerId: string, personId: string): string => `eje:timesheet-line:${viewerId}:${personId}`;

export interface KeptTimesheetDraft {
  readonly draft: TimesheetDraft;
  readonly keptAt: string;
}

export const keepTimesheetDraft = (key: string, draft: TimesheetDraft | null, now: () => string = () => new Date().toISOString()): void => {
  try {
    if (draft === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify({ draft, keptAt: now() } satisfies KeptTimesheetDraft));
  } catch {
    // Storage unavailable: nothing is kept, and the page is unchanged.
  }
};

export const keptTimesheetDraft = (key: string): KeptTimesheetDraft | null => {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<KeptTimesheetDraft>;
    const draft = parsed.draft;
    if (
      draft === undefined || typeof draft !== 'object' || typeof draft.anchor !== 'string' || typeof draft.date !== 'string' ||
      typeof draft.overtime !== 'string' || typeof draft.customerName !== 'string' || typeof parsed.keptAt !== 'string'
    ) {
      return null;
    }
    return { draft, keptAt: parsed.keptAt };
  } catch {
    return null;
  }
};
