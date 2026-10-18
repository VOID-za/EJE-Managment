import { beforeEach, describe, expect, it } from 'vitest';
import {
  beginCapture,
  captureIdleOnServer,
  captureInProgress,
  resetCaptureLock,
  subscribeToCapture,
} from './capture-lock';

/**
 * THE LOCK THAT KEEPS THE UPDATE BAR OFF A CAPTURE. PWA-7.
 *
 * The defect it exists for: the update bar is `sticky top-0`, so appearing
 * pushes the screen below it down — the signature pad slides out from under a
 * stylus mid-stroke, or *Confirm signature* moves under a thumb on its way to
 * it. The bar reads this during render, so what these tests hold is the
 * arithmetic that decides whether it draws at all.
 */
describe('the capture lock', () => {
  beforeEach(() => {
    resetCaptureLock();
  });

  it('is idle until something holds it', () => {
    expect(captureInProgress()).toBe(false);
  });

  it('is held while a capture is on screen, and released after', () => {
    const release = beginCapture();
    expect(captureInProgress()).toBe(true);
    release();
    expect(captureInProgress()).toBe(false);
  });

  /*
   * A COUNTER AND NOT A BOOLEAN, which is the whole reason this is not two
   * lines inside the banner. A photograph uploading while the write-up is
   * being typed is two captures, and the first to finish must not unlock on
   * behalf of the other.
   */
  it('stays held while any one of several captures is still going', () => {
    const photo = beginCapture();
    const writeUp = beginCapture();

    photo();
    expect(captureInProgress()).toBe(true);

    writeUp();
    expect(captureInProgress()).toBe(false);
  });

  it('cannot be released twice, so a remount cannot unlock somebody else', () => {
    const first = beginCapture();
    const second = beginCapture();

    first();
    first();
    first();
    expect(captureInProgress()).toBe(true);

    second();
    expect(captureInProgress()).toBe(false);
  });

  it('tells its listeners both ways, so the banner never renders a stale frame', () => {
    const seen: boolean[] = [];
    const stop = subscribeToCapture(() => seen.push(captureInProgress()));

    const release = beginCapture();
    release();
    stop();

    expect(seen).toEqual([true, false]);

    // And a listener that has stopped hears nothing more.
    beginCapture();
    expect(seen).toEqual([true, false]);
  });

  it('answers "idle" for a server render, which has no capture to be in', () => {
    beginCapture();
    expect(captureIdleOnServer()).toBe(false);
  });
});
