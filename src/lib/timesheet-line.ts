import {
  TIMESHEET_MAX_CALLOUT_CENTS,
  TIMESHEET_MAX_HOURS_PER_DAY,
  TIMESHEET_MAX_KM_PER_LINE,
  type TimesheetEntry,
  type TimesheetLineTyped,
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
  // TS-PAPER: any hours to two decimals (what is stored); no quarter-hour rule.
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) return `${label}: two decimals at most, for example 1.5.`;
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

  // TS-PAPER: a customer is never required — Workshop, a customer, or neither.
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

/**
 * A LINE AS TYPED, AND WHAT IT STILL NEEDS. PAYROLL-ONE-1 (the owner,
 * 5 November 2026): every line saves itself as it is typed; a line that is not
 * complete yet is KEPT ON THE SERVER as a draft — never thrown away, never
 * silently cut — shown with what it needs, and the forms cannot be submitted
 * while one is in their dates.
 *
 * A line is complete when it has a date, every number is one the server
 * stores (the field rules above), and it says something: a customer, Workshop,
 * or a value above zero. An EMPTY line — no customer, not Workshop, every
 * value zero — is the line just added and not filled in yet; it is a draft
 * until it is filled in or removed. (A customer with zero hours is a recorded
 * day with no hours, as it has always been; TS-PAPER's "a customer is never
 * required" stands.) The server adds the two rules only it can check: the
 * customer is in the register, and the day's lines stay within 24 hours.
 */
export type TimesheetLineField = TimesheetDraftField | 'date' | 'line';

export interface TimesheetLineProblem {
  readonly field: TimesheetLineField;
  readonly message: string;
}

export const emptyTimesheetLineTyped = (): TimesheetLineTyped => ({
  pick: '',
  customerName: '',
  overtime: '0',
  double: '0',
  callout: '0',
  internalKm: '0',
  customerKm: '0',
});

/** What the screen shows for a stored line. Pure. */
export const typedOfEntry = (entry: TimesheetEntry): TimesheetLineTyped => ({
  pick: entry.workshop ? WORKSHOP_PICK : entry.customerId ?? '',
  customerName: entry.workshop ? '' : entry.customerName,
  overtime: String(entry.overtimeHours),
  double: String(entry.doubleHours),
  callout: (entry.calloutAmount / 100).toFixed(2),
  internalKm: String(entry.internalKm),
  customerKm: String(entry.customerKm),
});

/** Two typed lines that say the same thing (blank and 0 are the same number; 450 and 450.00 the same amount). */
export const sameTypedLine = (a: TimesheetLineTyped, b: TimesheetLineTyped): boolean => {
  const number = (x: string, y: string) => {
    const left = parseTyped(x);
    const right = parseTyped(y);
    return Number.isNaN(left) || Number.isNaN(right) ? x.trim() === y.trim() : left === right;
  };
  return (
    a.pick === b.pick && a.customerName.trim() === b.customerName.trim() &&
    number(a.overtime, b.overtime) && number(a.double, b.double) && number(a.callout, b.callout) &&
    number(a.internalKm, b.internalKm) && number(a.customerKm, b.customerKm)
  );
};

/** Every problem of a typed line that the browser can see. Pure; the server asks the same, and more. */
export const timesheetLineProblems = (date: string | null, typed: TimesheetLineTyped): readonly TimesheetLineProblem[] => {
  const problems: TimesheetLineProblem[] = [];
  if (date === null || date === '' || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    problems.push({ field: 'date', message: 'Date: choose the day of this line.' });
  }
  const fields = timesheetDraftProblems({ ...emptyTimesheetDraft(date ?? ''), ...typed, calloutShared: false });
  for (const [field, message] of Object.entries(fields) as [TimesheetDraftField, string][]) problems.push({ field, message });
  const customerSaid = typed.pick === WORKSHOP_PICK || typed.pick.length > 0 || typed.customerName.trim().length > 0;
  const valueSaid = [typed.overtime, typed.double, typed.callout, typed.internalKm, typed.customerKm].some((value) => parseTyped(value) > 0);
  if (!customerSaid && !valueSaid && problems.length === 0) {
    problems.push({ field: 'line', message: 'Empty line: choose the customer or Workshop and enter what you worked, or remove the line.' });
  }
  if (typed.customerName.trim().length > 200) problems.push({ field: 'customer', message: 'Customer: keep the name to 200 characters.' });
  return problems;
};
