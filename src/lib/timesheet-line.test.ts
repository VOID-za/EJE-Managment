import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSHOP_PICK,
  emptyTimesheetDraft,
  keepTimesheetDraft,
  keptTimesheetDraft,
  parseTyped,
  randToCents,
  timesheetDraftKey,
  timesheetDraftProblems,
} from './timesheet-line';

/*
 * TST-TS-2 (the tester, 31 October 2026). A line's problems are said beside
 * the field, before it is sent, with the SERVER'S rules — so pressing Save line
 * a few days down the page never appears to do nothing.
 */
const line = (over: Partial<ReturnType<typeof emptyTimesheetDraft>> = {}) => ({ ...emptyTimesheetDraft('2026-10-12'), ...over });

describe('typed numbers', () => {
  it('reads a comma as the decimal mark and a blank as nothing', () => {
    expect(parseTyped('1,5')).toBe(1.5);
    expect(parseTyped(' 2.25 ')).toBe(2.25);
    expect(parseTyped('')).toBe(0);
  });

  it('never turns a typing slip into a number', () => {
    expect(parseTyped('1.5h')).toBeNaN();
    expect(parseTyped('.')).toBeNaN();
    expect(parseTyped('-1')).toBeNaN();
    expect(randToCents('450.5')).toBe(45050);
  });
});

describe('what is wrong with a line', () => {
  it('accepts an empty line of zeros, and a Workshop line with hours', () => {
    expect(timesheetDraftProblems(line())).toEqual({});
    expect(timesheetDraftProblems(line({ pick: WORKSHOP_PICK, overtime: '2' }))).toEqual({});
  });

  it('asks for the customer when there are hours, a call-out or kilometres — the server’s own words', () => {
    expect(timesheetDraftProblems(line({ overtime: '2' })).customer).toBe('Say which customer the work was for, or choose Workshop.');
    expect(timesheetDraftProblems(line({ callout: '450' })).customer).toBeDefined();
    expect(timesheetDraftProblems(line({ customerKm: '12' })).customer).toBeDefined();
    expect(timesheetDraftProblems(line({ overtime: '2', customerName: 'Sasol' }))).toEqual({});
    expect(timesheetDraftProblems(line({ overtime: '2', pick: 'customer-id' }))).toEqual({});
  });

  it('holds hours to quarter hours from 0 to 24', () => {
    expect(timesheetDraftProblems(line({ pick: WORKSHOP_PICK, overtime: '1.3' })).overtime).toMatch(/quarter hours/u);
    expect(timesheetDraftProblems(line({ pick: WORKSHOP_PICK, double: '25' })).double).toMatch(/0 to 24/u);
    expect(timesheetDraftProblems(line({ pick: WORKSHOP_PICK, overtime: 'abc' })).overtime).toBeDefined();
  });

  it('holds kilometres to one decimal and the call-out to rand and cents', () => {
    expect(timesheetDraftProblems(line({ pick: WORKSHOP_PICK, internalKm: '12.55' })).internalKm).toMatch(/one decimal/u);
    expect(timesheetDraftProblems(line({ pick: WORKSHOP_PICK, callout: '450.123' })).callout).toMatch(/two decimals/u);
    expect(timesheetDraftProblems(line({ pick: WORKSHOP_PICK, calloutShared: true })).callout).toMatch(/shared call-out/u);
  });
});

describe('an open line kept on this device', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is kept as it is typed, given back, and gone once saved or cancelled', () => {
    const key = timesheetDraftKey('me', 'me');
    keepTimesheetDraft(key, line({ overtime: '1.5', customerName: 'Kruger' }), () => '2026-10-31T08:00:00.000Z');
    expect(keptTimesheetDraft(key)).toEqual({ draft: line({ overtime: '1.5', customerName: 'Kruger' }), keptAt: '2026-10-31T08:00:00.000Z' });
    keepTimesheetDraft(key, null);
    expect(keptTimesheetDraft(key)).toBeNull();
  });

  it('ignores anything that is not a kept line, and never throws when storage is refused', () => {
    store.set('bad', '{"draft":{"anchor":1}}');
    expect(keptTimesheetDraft('bad')).toBeNull();
    store.set('worse', 'not json');
    expect(keptTimesheetDraft('worse')).toBeNull();
    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined } });
    expect(() => keepTimesheetDraft('k', line())).not.toThrow();
    expect(keptTimesheetDraft('k')).toBeNull();
  });
});
