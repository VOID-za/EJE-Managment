import { describe, expect, it } from 'vitest';
import type { TimesheetLineTyped } from '@/domain';
import type { SendFailure } from './attendance-autosave';
import { COMMENT_KEY, TimesheetAutosaver, type TimesheetAutosaverOptions } from './timesheet-autosave';

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

  it('saves the comment with what the screen last showed, so another tab is not overwritten', async () => {
    const { saver, comments, tick } = setup();
    saver.change({ kind: 'comment', comment: 'Bench days', base: '' });
    await tick();
    saver.change({ kind: 'comment', comment: 'Bench days.', base: '' });
    await tick();
    expect(comments).toEqual([{ comment: 'Bench days', expected: '' }, { comment: 'Bench days.', expected: 'Bench days' }]);
    expect(saver.pendingFor(COMMENT_KEY)).toBeNull();
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
