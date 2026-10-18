import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSending,
  markSending,
  onPendingWorkChanged,
  resetSending,
  sendingIds,
} from './pending-work';

/**
 * WHICH CAPTURE IS BEING SENT RIGHT NOW. OFF-8, OFF-QUEUE-4.
 *
 * The defect it exists for: a technician with a dozen captures queued saw one
 * spinner on a *Send* button, and on a bad link that reads as nothing
 * happening. Each row now says "Sending…" for itself.
 *
 * The property that matters most is the one about CRASHES. This state is held
 * in memory on purpose: a `sending` written into IndexedDB would survive the
 * tablet being killed mid-request, and the next launch would show a row as
 * sending with nothing sending it — a lie only a person could clear. These
 * tests hold the arithmetic; the store's own tests hold the durable states.
 */
describe('the in-flight marker', () => {
  beforeEach(() => {
    resetSending();
  });

  it('starts empty', () => {
    expect(sendingIds()).toEqual([]);
  });

  it('names the captures whose request is open, and forgets them after', () => {
    markSending('row-1');
    markSending('row-2');
    expect([...sendingIds()].sort()).toEqual(['row-1', 'row-2']);

    clearSending('row-1');
    expect(sendingIds()).toEqual(['row-2']);

    clearSending('row-2');
    expect(sendingIds()).toEqual([]);
  });

  it('tells the screens, so a row cannot show a stale spinner', () => {
    let told = 0;
    const stop = onPendingWorkChanged(() => {
      told += 1;
    });

    markSending('row-1');
    clearSending('row-1');
    expect(told).toBe(2);

    // A second clear of the same row changes nothing, so it announces nothing.
    clearSending('row-1');
    expect(told).toBe(2);
    stop();
  });

  it('is cleared wholesale, which is what a sign-out needs', () => {
    markSending('row-1');
    markSending('row-2');
    resetSending();
    expect(sendingIds()).toEqual([]);
  });
});
