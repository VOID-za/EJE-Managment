import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosaver, type AutosaveStatus } from './autosave';

/**
 * What autosave must never do: lose what somebody typed, or write once per
 * keystroke. Everything below is one of those two rules from a different angle.
 */

const settle = async (): Promise<void> => {
  // Two turns: the save promise resolves on one, the loop's next iteration
  // runs on the next.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const build = (initial = '') => {
    const writes: string[] = [];
    const statuses: AutosaveStatus[] = [];
    let fail: string | null = null;
    const saver = createAutosaver(initial, {
      delayMs: 1_000,
      maxWaitMs: 4_000,
      now: () => '2026-09-25T08:00:00.000Z',
      onStatus: (status) => statuses.push(status),
      save: async (value) => {
        if (fail !== null) throw new Error(fail);
        writes.push(value);
      },
    });
    return {
      saver,
      writes,
      statuses,
      breakSaving: (message: string) => {
        fail = message;
      },
      fixSaving: () => {
        fail = null;
      },
    };
  };

  it('writes nothing until the typing stops', async () => {
    const { saver, writes } = build();

    for (const text of ['R', 'Re', 'Rep', 'Repl', 'Repla']) saver.change(text);
    await vi.advanceTimersByTimeAsync(900);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    await settle();
    expect(writes).toEqual(['Repla']);
  });

  it('is one write for a burst of keystrokes, not one per key', async () => {
    const { saver, writes } = build();

    for (let index = 1; index <= 40; index += 1) saver.change('x'.repeat(index));
    await vi.advanceTimersByTimeAsync(1_100);
    await settle();

    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe('x'.repeat(40));
  });

  it('saves anyway when somebody never stops typing', async () => {
    const { saver, writes } = build();

    // A keystroke every 400ms for six seconds: the 1s debounce never elapses,
    // so without the ceiling nothing would be written at all.
    for (let tick = 0; tick < 15; tick += 1) {
      saver.change(`word ${tick}`);
      await vi.advanceTimersByTimeAsync(400);
    }
    await settle();

    expect(writes.length).toBeGreaterThan(0);
  });

  it('keeps the text when the save fails, and writes it on the next attempt', async () => {
    const context = build();
    const { saver, writes, statuses } = context;

    context.breakSaving('Network unreachable');
    saver.change('Replaced the spindle drive.');
    await vi.advanceTimersByTimeAsync(1_100);
    await settle();

    expect(writes).toEqual([]);
    expect(statuses.at(-1)).toEqual({
      kind: 'failed',
      message: 'Network unreachable',
    });
    // THE WORK IS STILL THERE. This is the whole point of the case.
    expect(saver.dirty()).toBe(true);

    context.fixSaving();
    await saver.flush();
    await settle();
    expect(writes).toEqual(['Replaced the spindle drive.']);
    expect(saver.dirty()).toBe(false);
  });

  it('never runs two writes at once, and the last value wins', async () => {
    const writes: string[] = [];
    let running = 0;
    let peak = 0;
    const saver = createAutosaver('', {
      delayMs: 10,
      save: async (value) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 50));
        writes.push(value);
        running -= 1;
      },
    });

    saver.change('first');
    await vi.advanceTimersByTimeAsync(15);
    // Typed WHILE the first write is still in flight.
    saver.change('second');
    await vi.advanceTimersByTimeAsync(200);
    await settle();
    await vi.advanceTimersByTimeAsync(200);

    expect(peak).toBe(1);
    expect(writes.at(-1)).toBe('second');
    expect(saver.saved()).toBe('second');
  });

  it('writes nothing when the text is typed back to what was saved', async () => {
    const { saver, writes } = build('Original');

    saver.change('Original edited');
    saver.change('Original');
    await vi.advanceTimersByTimeAsync(2_000);
    await settle();

    expect(writes).toEqual([]);
    expect(saver.dirty()).toBe(false);
    expect(saver.status()).toEqual({ kind: 'clean' });
  });

  it('flush writes immediately, without waiting out the delay', async () => {
    const { saver, writes } = build();

    saver.change('Half a sentence');
    await saver.flush();
    await settle();

    expect(writes).toEqual(['Half a sentence']);
    expect(saver.dirty()).toBe(false);
  });

  it('flush on a clean saver writes nothing', async () => {
    const { saver, writes } = build('Already saved');
    await saver.flush();
    expect(writes).toEqual([]);
  });

  it('cancel discards the held edit and writes nothing', async () => {
    const { saver, writes } = build('Original');

    saver.change('Something the technician then discarded');
    saver.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();

    expect(writes).toEqual([]);
    expect(saver.saved()).toBe('Original');
    expect(saver.status()).toEqual({ kind: 'clean' });
  });

  it('reports pending, then saving, then saved', async () => {
    const { saver, statuses } = build();

    saver.change('Work performed');
    expect(statuses.at(-1)).toEqual({ kind: 'pending' });

    await vi.advanceTimersByTimeAsync(1_100);
    expect(statuses.some((status) => status.kind === 'saving')).toBe(true);

    await settle();
    expect(statuses.at(-1)).toEqual({ kind: 'saved', at: '2026-09-25T08:00:00.000Z' });
  });

  it('compares with the caller’s own equality, so a record can be a value', async () => {
    const writes: Record<string, string>[] = [];
    const saver = createAutosaver(
      { workPerformed: 'Done' },
      {
        delayMs: 10,
        equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
        save: async (value) => {
          writes.push(value);
        },
      },
    );

    // A DIFFERENT OBJECT holding the same fields is not a change: without the
    // caller's equality, every re-render would queue a write.
    saver.change({ workPerformed: 'Done' });
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(writes).toEqual([]);

    saver.change({ workPerformed: 'Done, and tested.' });
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(writes).toEqual([{ workPerformed: 'Done, and tested.' }]);
  });
});
