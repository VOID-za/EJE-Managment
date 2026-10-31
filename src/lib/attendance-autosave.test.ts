import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttendanceRecord } from '@/domain';
import {
  AttendanceAutosaver,
  DEBOUNCE_MS,
  RETRY_MS,
  autosaveKey,
  type SendFailure,
  type SendInput,
} from './attendance-autosave';

/*
 * ATT-AUTO-1 (the tester, 31 October 2026). Attendance saves itself while it
 * is filled in — every path the tester asked about, without a browser: a slow
 * connection, a failed request, a refusal, a newer record, a reload, leaving
 * the page, and many quick taps.
 */
const SIPHO = 'user-tech-sipho';
let clock = 0;
let stamp = 0;

interface Call {
  readonly input: SendInput;
  readonly keepalive: boolean;
  resolve: (record: AttendanceRecord) => void;
  reject: (cause: unknown) => void;
}

const record = (input: SendInput): AttendanceRecord =>
  ({
    id: `att-${input.date}`,
    userId: input.userId,
    date: input.date,
    status: input.status,
    absenceReason: input.absenceReason,
    note: input.note,
    recordedBy: input.userId,
    recordedAt: `2026-10-31T08:00:00.${String((stamp += 1)).padStart(3, '0')}Z`,
  }) as AttendanceRecord;

const build = (options: { storage?: Map<string, string>; online?: () => boolean } = {}) => {
  const calls: Call[] = [];
  const conflicts: string[] = [];
  let saves = 0;
  const store = options.storage;
  const saver = new AttendanceAutosaver({
    send: (input, { keepalive }) =>
      new Promise<AttendanceRecord>((resolve, reject) => {
        calls.push({ input, keepalive, resolve, reject });
      }),
    classify: (cause) => cause as SendFailure,
    storageKey: store === undefined ? null : 'eje:attendance-autosave:me',
    storage: store === undefined ? null : {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    },
    online: options.online ?? (() => true),
    now: () => new Date(Date.UTC(2026, 9, 31, 8, 0, 0) + clock).toISOString(),
    onChange: () => undefined,
    onSaved: () => void (saves += 1),
    onConflict: (key, message) => void conflicts.push(`${key}: ${message}`),
  });
  return { saver, calls, conflicts, saves: () => saves };
};

/** Lets the saver's promise chain run after a call settles. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
});
afterEach(() => vi.useRealTimers());

describe('saving as the form is filled in', () => {
  it('saves a tap after a short pause — no Save button — and says when', async () => {
    const { saver, calls } = build();
    saver.change(SIPHO, '2026-10-01', { status: 'present', absenceReason: null, note: '' }, null);
    expect(saver.state().kind).toBe('waiting');
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ date: '2026-10-01', status: 'present', expectedRecordedAt: null });
    expect(saver.state().kind).toBe('saving');
    calls[0]!.resolve(record(calls[0]!.input));
    await settle();
    expect(saver.state()).toEqual({ kind: 'saved', at: '2026-10-31T08:00:00.000Z' });
    expect(saver.unsavedCount).toBe(0);
  });

  it('a burst of taps on one day is ONE request with the last answer', async () => {
    const { saver, calls } = build();
    saver.change(SIPHO, '2026-10-02', { status: 'present', absenceReason: null, note: '' }, null);
    saver.change(SIPHO, '2026-10-02', { status: 'absent', absenceReason: null, note: '' }, null);
    saver.change(SIPHO, '2026-10-02', { status: 'absent', absenceReason: 'sick_leave', note: '' }, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ status: 'absent', absenceReason: 'sick_leave' });
  });

  it('many days tapped quickly are all kept and sent, one at a time, none lost', async () => {
    const { saver, calls } = build();
    for (let day = 1; day <= 20; day += 1) {
      saver.change(SIPHO, `2026-10-${String(day).padStart(2, '0')}`, { status: 'present', absenceReason: null, note: '' }, null);
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    for (let sent = 0; sent < 20; sent += 1) {
      expect(calls).toHaveLength(sent + 1);
      calls[sent]!.resolve(record(calls[sent]!.input));
      await settle();
    }
    expect(new Set(calls.map((call) => call.input.date)).size).toBe(20);
    expect(saver.state().kind).toBe('saved');
  });

  it('waits longer while a note is typed, so it is not a request per key', async () => {
    const { saver, calls } = build();
    for (const typed of ['P', 'Ph', 'Pho', 'Phoned in']) {
      saver.change(SIPHO, '2026-10-03', { status: 'present', absenceReason: null, note: typed }, null, 'note');
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.note);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.note).toBe('Phoned in');
  });

  it('holds Absent until a reason is chosen, and a note until Present or Absent is', async () => {
    const { saver, calls } = build();
    saver.change(SIPHO, '2026-10-04', { status: 'absent', absenceReason: null, note: '' }, null);
    saver.change(SIPHO, '2026-10-05', { status: null, absenceReason: null, note: 'Late' }, null, 'note');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.note);
    expect(calls).toHaveLength(0);
    expect(saver.state()).toEqual({ kind: 'incomplete', count: 2 });
    saver.change(SIPHO, '2026-10-04', { status: 'absent', absenceReason: 'leave', note: '' }, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    expect(calls.map((call) => call.input.date)).toEqual(['2026-10-04']);
  });

  it('a change made while its day is still saving is sent next, from the record just saved', async () => {
    const { saver, calls } = build();
    saver.change(SIPHO, '2026-10-06', { status: 'present', absenceReason: null, note: '' }, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    saver.change(SIPHO, '2026-10-06', { status: 'absent', absenceReason: 'leave', note: '' }, null);
    const first = record(calls[0]!.input);
    calls[0]!.resolve(first);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toMatchObject({ status: 'absent', expectedRecordedAt: first.recordedAt });
  });
});

describe('when saving fails', () => {
  it('a dropped connection keeps the change, retries with a back-off, and saves when it returns', async () => {
    const { saver, calls } = build();
    saver.change(SIPHO, '2026-10-07', { status: 'present', absenceReason: null, note: '' }, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    calls[0]!.reject({ kind: 'network', message: 'No connection' });
    await settle();
    expect(saver.state()).toMatchObject({ kind: 'offline', count: 1 });
    expect(saver.answerFor(SIPHO, '2026-10-07')).toMatchObject({ status: 'present', unsaved: true });
    await vi.advanceTimersByTimeAsync(RETRY_MS[0]);
    expect(calls).toHaveLength(2);
    calls[1]!.reject({ kind: 'network', message: 'No connection' });
    await settle();
    await vi.advanceTimersByTimeAsync(RETRY_MS[1] - 1);
    expect(calls).toHaveLength(2);
    saver.online();
    await settle();
    expect(calls).toHaveLength(3);
    calls[2]!.resolve(record(calls[2]!.input));
    await settle();
    expect(saver.state().kind).toBe('saved');
  });

  it('does not even try while the browser says it is offline', async () => {
    let online = false;
    const { saver, calls } = build({ online: () => online });
    saver.change(SIPHO, '2026-10-08', { status: 'present', absenceReason: null, note: '' }, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    expect(calls).toHaveLength(0);
    expect(saver.state().kind).toBe('offline');
    online = true;
    saver.online();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('a refusal is kept and said, other days still save, and Retry or Undo resolve it', async () => {
    const { saver, calls } = build();
    saver.change(SIPHO, '2026-09-30', { status: 'present', absenceReason: null, note: '' }, null);
    saver.change(SIPHO, '2026-10-09', { status: 'present', absenceReason: null, note: '' }, null);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    calls[0]!.reject({ kind: 'refused', message: 'This month has been submitted to the office.' });
    await settle();
    calls[1]!.resolve(record(calls[1]!.input));
    await settle();
    expect(saver.state()).toEqual({ kind: 'failed', count: 1, message: 'This month has been submitted to the office.' });
    expect(saver.answerFor(SIPHO, '2026-09-30')).toMatchObject({ refused: 'This month has been submitted to the office.' });
    saver.retry();
    await settle();
    expect(calls).toHaveLength(3);
    calls[2]!.reject({ kind: 'refused', message: 'Still submitted.' });
    await settle();
    saver.discard(autosaveKey(SIPHO, '2026-09-30'));
    expect(saver.unsavedCount).toBe(0);
    expect(saver.answerFor(SIPHO, '2026-09-30')).toBeNull();
  });

  it('a day somebody else recorded since is never overwritten: the change is dropped and the person told', async () => {
    const { saver, calls, conflicts, saves } = build();
    saver.change(SIPHO, '2026-10-10', { status: 'present', absenceReason: null, note: '' }, '2026-10-10T07:00:00.000Z');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS.choice);
    expect(calls[0]!.input.expectedRecordedAt).toBe('2026-10-10T07:00:00.000Z');
    calls[0]!.reject({ kind: 'conflict', message: 'It now says Absent — Leave.' });
    await settle();
    expect(conflicts).toEqual([`${SIPHO}:2026-10-10: It now says Absent — Leave.`]);
    expect(saver.unsavedCount).toBe(0);
    expect(saves()).toBe(1);
  });
});

describe('reloading and leaving the page', () => {
  it('keeps the queue on this device and sends it after a reload', async () => {
    const storage = new Map<string, string>();
    const first = build({ storage });
    first.saver.change(SIPHO, '2026-10-12', { status: 'absent', absenceReason: 'leave', note: '' }, null);
    first.saver.dispose();
    expect(storage.size).toBe(1);

    const second = build({ storage });
    expect(second.saver.answerFor(SIPHO, '2026-10-12')).toMatchObject({ status: 'absent', unsaved: true });
    await settle();
    expect(second.calls).toHaveLength(1);
    second.calls[0]!.resolve(record(second.calls[0]!.input));
    await settle();
    expect(storage.size).toBe(0);
  });

  it('leaving sends what is waiting with keepalive, skipping what cannot be sent', () => {
    const { saver, calls } = build();
    saver.change(SIPHO, '2026-10-13', { status: 'present', absenceReason: null, note: '' }, null);
    saver.change(SIPHO, '2026-10-14', { status: 'absent', absenceReason: null, note: '' }, null);
    saver.leave();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ keepalive: true, input: { date: '2026-10-13' } });
  });
});
