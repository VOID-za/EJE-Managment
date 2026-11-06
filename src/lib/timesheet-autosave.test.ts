import { describe, expect, it } from 'vitest';
import type { TimesheetLineTyped } from '@/domain';
import type { SendFailure } from './attendance-autosave';
import { COMMENT_KEY, TimesheetAutosaver, type TimesheetAutosaverOptions, type TimesheetChange } from './timesheet-autosave';

/** PAYROLL-ONE-1: the Timesheets page's queue, driven by hand (timers, network, storage). */
const typed = (overtime: string): TimesheetLineTyped => ({
  pick: '', customerName: 'ABC', overtime, double: '0', callout: '0', internalKm: '0', customerKm: '0',
});

class NetworkDown extends Error {}
class Conflict extends Error {}
class Refused extends Error {}

const setup = (overrides: Partial<TimesheetAutosaverOptions> = {}, stored: Map<string, string> = new Map()) => {
  const timers: { run: () => void; ms: number }[] = [];
  const sent: { id: string; overtime: string; expected: string | null }[] = [];
  const removed: string[] = [];
  const comments: { comment: string; expected: string }[] = [];
  let revision = 0;
  let fail: Error | null = null;
  const events = { saved: 0, conflicts: [] as string[] };
  const saver = new TimesheetAutosaver({
    saveLine: async (input) => {
      if (fail !== null) throw fail;
      sent.push({ id: input.id, overtime: input.typed.overtime, expected: input.expectedRevision });
      revision += 1;
      return { id: input.id, revision: `r${revision}` };
    },
    removeLine: async (id) => {
      if (fail !== null) throw fail;
      removed.push(id);
    },
    saveComment: async (comment, expected) => {
      if (fail !== null) throw fail;
      comments.push({ comment, expected });
    },
    classify: (cause): SendFailure =>
      cause instanceof NetworkDown ? { kind: 'network', message: 'offline' } : cause instanceof Conflict ? { kind: 'conflict', message: 'newer' } : { kind: 'refused', message: (cause as Error).message },
    storageKey: 'k',
    storage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => void stored.set(key, value), removeItem: (key) => void stored.delete(key) },
    now: () => '2026-11-05T08:00:00.000Z',
    setTimer: (run, ms) => {
      timers.push({ run, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
    onChange: () => undefined,
    onSaved: () => {
      events.saved += 1;
    },
    onConflict: (_id, message) => events.conflicts.push(message),
    ...overrides,
  });
  /** Runs the latest timer and waits for the queue to drain. */
  const tick = async () => {
    const timer = timers.pop();
    timers.length = 0;
    timer?.run();
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };
  return { saver, sent, removed, comments, events, tick, stored, failWith: (error: Error | null) => { fail = error; }, timers };
};

describe('TimesheetAutosaver', () => {
  it('TS-DAY-1: remembers what each line saved this visit — the day block adds it up before the list reloads; a removal forgets it', async () => {
    const { saver, tick } = setup();
    expect(saver.savedLineOf('L1', null)).toBeNull();
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('2.5'), base: null });
    // Waiting: not saved yet, so nothing is remembered as saved.
    expect(saver.savedLineOf('L1', null)).toBeNull();
    await tick();
    // The list still shows the line as it was before (a new line: none) — this device's save is newer.
    expect(saver.savedLineOf('L1', null)).toEqual({ date: '2026-11-03', typed: typed('2.5') });
    // A day moved: the line saved on its new date; a list from before either save is still behind.
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-04', typed: typed('2.5'), base: null }, 0);
    await tick();
    expect(saver.savedLineOf('L1', null)?.date).toBe('2026-11-04');
    expect(saver.savedLineOf('L1', 'r1')?.date).toBe('2026-11-04');
    // The list caught up (r2), or shows a version made on another device (r9): the list wins.
    expect(saver.savedLineOf('L1', 'r2')).toBeNull();
    expect(saver.savedLineOf('L1', 'r9')).toBeNull();
    saver.change({ kind: 'remove', id: 'L1' });
    await tick();
    expect(saver.savedLineOf('L1', null)).toBeNull();
  });

  it('saves a burst of typing as ONE request, after the pause, naming the revision the screen began from', async () => {
    const { saver, sent, tick } = setup();
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('1'), base: 'r0' });
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('1.5'), base: 'r0' });
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('2'), base: 'r0' });
    expect(saver.state()).toEqual({ kind: 'waiting', count: 1 });
    await tick();
    expect(sent).toEqual([{ id: 'L1', overtime: '2', expected: 'r0' }]);
    expect(saver.state()).toEqual({ kind: 'saved', at: '2026-11-05T08:00:00.000Z' });
  });

  it('a later save names the revision the earlier save returned, so it is never refused as stale', async () => {
    const { saver, sent, tick } = setup();
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('1'), base: null });
    await tick();
    // The screen still holds its first revision (null); the saver knows better.
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('3'), base: null });
    await tick();
    expect(sent.map((save) => save.expected)).toEqual([null, 'r1']);
  });

  it('never says Saved before the server answered; a lost connection keeps the change and retries', async () => {
    const { saver, sent, tick, failWith, timers } = setup();
    failWith(new NetworkDown());
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('4'), base: 'r0' });
    await tick();
    expect(saver.state().kind).toBe('offline');
    expect(saver.unsavedCount).toBe(1);
    expect(timers.at(-1)?.ms).toBe(2000);
    failWith(null);
    await tick();
    expect(sent).toEqual([{ id: 'L1', overtime: '4', expected: 'r0' }]);
    expect(saver.state().kind).toBe('saved');
  });

  it('a refusal keeps the change, says why, and Retry sends it again', async () => {
    const { saver, sent, tick, failWith } = setup();
    failWith(new Refused('That line is part of your submitted timesheet.'));
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('4'), base: 'r0' });
    await tick();
    expect(saver.state()).toMatchObject({ kind: 'failed', message: 'That line is part of your submitted timesheet.' });
    expect(saver.pendingFor('L1')?.refused).toBeDefined();
    failWith(null);
    saver.retry();
    await tick();
    expect(sent).toHaveLength(1);
    expect(saver.unsavedCount).toBe(0);
  });

  it('a stale save is dropped and reported — the newer line wins and is reloaded', async () => {
    const { saver, events, tick, failWith } = setup();
    failWith(new Conflict());
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('9'), base: 'old' });
    await tick();
    expect(events.conflicts).toEqual(['newer']);
    expect(events.saved).toBe(1);
    expect(saver.unsavedCount).toBe(0);
  });

  it('a line added and removed before it was saved simply goes; a saved line is removed on the server', async () => {
    const { saver, removed, sent, tick } = setup();
    saver.change({ kind: 'line', id: 'NEW', date: '2026-11-03', typed: typed('0'), base: null });
    saver.change({ kind: 'remove', id: 'NEW' });
    expect(saver.unsavedCount).toBe(0);
    saver.change({ kind: 'remove', id: 'OLD' });
    await tick();
    expect(sent).toEqual([]);
    expect(removed).toEqual(['OLD']);
  });

  it('a line removed while its first save is on its way is removed on the server too — no empty draft is left behind', async () => {
    let release: () => void = () => undefined;
    const removed: string[] = [];
    const timers: { run: () => void }[] = [];
    const saver = new TimesheetAutosaver({
      saveLine: (input) => new Promise((resolve) => { release = () => resolve({ id: input.id, revision: 'r1' }); }),
      removeLine: async (id) => { removed.push(id); },
      saveComment: async () => undefined,
      classify: (): SendFailure => ({ kind: 'refused', message: 'x' }),
      storageKey: null,
      setTimer: (run) => { timers.push({ run }); return timers.length; },
      clearTimer: () => undefined,
      onChange: () => undefined,
      onSaved: () => undefined,
      onConflict: () => undefined,
    });
    saver.change({ kind: 'line', id: 'NEW', date: '2026-11-05', typed: { ...typed('0'), customerName: '' }, base: null }, 0);
    timers.pop()?.run();
    await Promise.resolve();
    // The first save is in flight; the person removes the line.
    saver.change({ kind: 'remove', id: 'NEW' });
    release();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(removed).toEqual(['NEW']);
    expect(saver.unsavedCount).toBe(0);
  });

  it('FOLLOW-UP (a): a refused first save does not stall the removal queued behind it — the removal is sent', async () => {
    let release: () => void = () => undefined;
    const removed: string[] = [];
    const timers: { run: () => void }[] = [];
    const saver = new TimesheetAutosaver({
      saveLine: () => new Promise((_resolve, reject) => { release = () => reject(new Refused('That day is in a submitted timesheet.')); }),
      removeLine: async (id) => { removed.push(id); },
      saveComment: async () => undefined,
      classify: (cause): SendFailure => ({ kind: 'refused', message: (cause as Error).message }),
      storageKey: null,
      setTimer: (run) => { timers.push({ run }); return timers.length; },
      clearTimer: () => undefined,
      onChange: () => undefined,
      onSaved: () => undefined,
      onConflict: () => undefined,
    });
    saver.change({ kind: 'line', id: 'NEW', date: '2026-11-05', typed: typed('1'), base: null }, 0);
    timers.pop()?.run();
    await Promise.resolve();
    saver.change({ kind: 'remove', id: 'NEW' });
    release();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(removed).toEqual(['NEW']);
    expect(saver.state().kind).not.toBe('failed');
    expect(saver.unsavedCount).toBe(0);
  });

  it('FOLLOW-UP (c): two lost answers in a row with typing between — the newest typing is sent, not dropped as a conflict', async () => {
    let server: { revision: string; typed: TimesheetLineTyped } = { revision: 'r0', typed: typed('1') };
    let drops = 2;
    const timers: { run: () => void }[] = [];
    const conflicts: string[] = [];
    const saver = new TimesheetAutosaver({
      saveLine: async (input) => {
        if (input.expectedRevision !== server.revision) throw new Conflict();
        // The FIRST send is saved; its answer, and the second send itself, are lost.
        if (drops === 2) server = { revision: 'r1', typed: input.typed };
        if (drops > 0) {
          drops -= 1;
          throw new NetworkDown();
        }
        server = { revision: `r-${input.typed.overtime}`, typed: input.typed };
        return { id: input.id, revision: server.revision };
      },
      removeLine: async () => undefined,
      saveComment: async () => undefined,
      classify: (cause): SendFailure => (cause instanceof NetworkDown ? { kind: 'network', message: 'offline' } : { kind: 'conflict', message: 'newer' }),
      current: async () => ({ revision: server.revision, date: '2026-11-03', typed: server.typed }),
      storageKey: null,
      setTimer: (run) => { timers.push({ run }); return timers.length; },
      clearTimer: () => undefined,
      onChange: () => undefined,
      onSaved: () => undefined,
      onConflict: (_id, message) => conflicts.push(message),
    });
    const tick = async () => {
      const timer = timers.pop();
      timers.length = 0;
      timer?.run();
      for (let index = 0; index < 30; index += 1) await Promise.resolve();
    };
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('2'), base: 'r0' });
    await tick();
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('3'), base: 'r0' });
    await tick();
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('4'), base: 'r0' });
    await tick();
    expect(conflicts).toEqual([]);
    expect(server.typed.overtime).toBe('4');
    expect(saver.unsavedCount).toBe(0);
  });

  it('a real conflict reports the LATEST typing that was not saved, and a v1.5.0 queue on the device still loads', async () => {
    const stored = new Map<string, string>([['k', JSON.stringify([{ kind: 'line', id: 'L9', date: '2026-11-03', typed: typed('7'), base: 'r0', version: 3, unsure: { date: '2026-11-03', typed: typed('6') } }])]]);
    const lost: TimesheetChange[] = [];
    const { tick } = setup({
      saveLine: async () => { throw new Conflict(); },
      current: async () => ({ revision: 'r5', date: '2026-11-03', typed: typed('5') }),
      onConflict: (_id, _message, change) => lost.push(change),
    }, stored);
    await tick();
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ kind: 'line', typed: { overtime: '7' } });
  });

  it('REVIEW #1: leaving the page mid-save — the next visit recognises its own work instead of calling it another device\'s', async () => {
    const stored = new Map<string, string>();
    let server: { revision: string; typed: TimesheetLineTyped } = { revision: 'r0', typed: typed('1') };
    let hold: (() => void) | null = null;
    const first = setup({
      // v1 reaches the server and commits, but this page never reads the answer (it is left).
      saveLine: (input) => new Promise((resolve) => {
        server = { revision: 'r1', typed: input.typed };
        hold = () => resolve({ id: input.id, revision: 'r1' });
      }),
    }, stored);
    first.saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('2'), base: 'r0' });
    await first.tick();
    first.saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('3'), base: 'r0' });
    first.saver.leave();
    first.saver.dispose();
    (hold as (() => void) | null)?.();
    const conflicts: string[] = [];
    const second = setup({
      saveLine: async (input) => {
        if (input.expectedRevision !== server.revision) throw new Conflict();
        server = { revision: 'r2', typed: input.typed };
        return { id: input.id, revision: 'r2' };
      },
      current: async () => ({ revision: server.revision, date: '2026-11-03', typed: server.typed }),
      onConflict: (_id, message) => conflicts.push(message),
    }, stored);
    await second.tick();
    expect(conflicts).toEqual([]);
    expect(server.typed.overtime).toBe('3');
  });

  it('REVIEW #3: a removal tapped while a save is out is still made when that save loses to a newer version', async () => {
    let release: () => void = () => undefined;
    const removed: string[] = [];
    const conflicts: string[] = [];
    const timers: { run: () => void }[] = [];
    const saver = new TimesheetAutosaver({
      saveLine: () => new Promise((_resolve, reject) => { release = () => reject(new Conflict()); }),
      removeLine: async (id) => { removed.push(id); },
      saveComment: async () => undefined,
      classify: (cause): SendFailure => (cause instanceof Conflict ? { kind: 'conflict', message: 'newer' } : { kind: 'refused', message: 'x' }),
      storageKey: null,
      setTimer: (run) => { timers.push({ run }); return timers.length; },
      clearTimer: () => undefined,
      onChange: () => undefined,
      onSaved: () => undefined,
      onConflict: (_id, message) => conflicts.push(message),
    });
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-05', typed: typed('2'), base: 'r0' }, 0);
    timers.pop()?.run();
    await Promise.resolve();
    saver.change({ kind: 'remove', id: 'L1' });
    release();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(removed).toEqual(['L1']);
    expect(conflicts).toEqual([]);
    expect(saver.unsavedCount).toBe(0);
  });

  it('saves the comment with what the screen last showed, so another tab is not overwritten', async () => {
    const { saver, comments, tick } = setup();
    saver.change({ kind: 'comment', comment: 'Bench days', base: '' });
    await tick();
    saver.change({ kind: 'comment', comment: 'Bench days.', base: '' });
    await tick();
    expect(comments).toEqual([{ comment: 'Bench days', expected: '' }, { comment: 'Bench days.', expected: 'Bench days' }]);
    expect(saver.pendingFor(COMMENT_KEY)).toBeNull();
  });

  it('a save whose answer was lost is recognised: the newer typing goes on from it instead of being dropped as stale', async () => {
    let server: { revision: string; typed: TimesheetLineTyped } = { revision: 'r0', typed: typed('1') };
    let dropAnswer = true;
    const timers: { run: () => void }[] = [];
    const conflicts: string[] = [];
    const sent: { overtime: string; expected: string | null }[] = [];
    const saver = new TimesheetAutosaver({
      saveLine: async (input) => {
        sent.push({ overtime: input.typed.overtime, expected: input.expectedRevision });
        if (input.expectedRevision !== server.revision) throw new Conflict();
        server = { revision: `r${sent.length}`, typed: input.typed };
        // Saved — and the answer lost on the way back.
        if (dropAnswer) {
          dropAnswer = false;
          throw new NetworkDown();
        }
        return { id: input.id, revision: server.revision };
      },
      removeLine: async () => undefined,
      saveComment: async () => undefined,
      classify: (cause): SendFailure => (cause instanceof NetworkDown ? { kind: 'network', message: 'offline' } : { kind: 'conflict', message: 'newer' }),
      current: async () => ({ revision: server.revision, date: '2026-11-03', typed: server.typed }),
      storageKey: null,
      setTimer: (run) => { timers.push({ run }); return timers.length; },
      clearTimer: () => undefined,
      onChange: () => undefined,
      onSaved: () => undefined,
      onConflict: (_id, message) => conflicts.push(message),
    });
    const tick = async () => {
      const timer = timers.pop();
      timers.length = 0;
      timer?.run();
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    };
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('2'), base: 'r0' });
    await tick();
    expect(saver.state().kind).toBe('offline');
    // More typing while the connection is down.
    saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('3'), base: 'r0' });
    await tick();
    expect(conflicts).toEqual([]);
    expect(server.typed.overtime).toBe('3');
    expect(saver.unsavedCount).toBe(0);
  });

  it('keeps the queue on the device: a reload gives it back and sends it', async () => {
    const stored = new Map<string, string>();
    const first = setup({}, stored);
    first.failWith(new NetworkDown());
    first.saver.change({ kind: 'line', id: 'L1', date: '2026-11-03', typed: typed('5'), base: 'r0' });
    await first.tick();
    first.saver.dispose();
    expect(stored.get('k')).toContain('"overtime":"5"');
    const second = setup({}, stored);
    expect(second.saver.unsavedCount).toBe(1);
    await second.tick();
    expect(second.sent).toEqual([{ id: 'L1', overtime: '5', expected: 'r0' }]);
    expect(stored.has('k')).toBe(false);
  });
});
