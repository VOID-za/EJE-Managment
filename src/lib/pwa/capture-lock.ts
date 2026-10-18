/**
 * WHILE A CAPTURE IS IN PROGRESS, NOTHING ELSE MAY MOVE THE SCREEN. PWA-7, UX-1.
 *
 * WHY THIS EXISTS. The update bar is `sticky top-0` and appears the moment a
 * new build finishes installing — which is whenever it happens, not whenever
 * the technician is ready. Appearing pushes everything below it DOWN by its own
 * height. On a tablet that is a signature pad sliding out from under a stylus
 * mid-stroke, or a *Confirm signature* button moving under a thumb that is
 * already on its way to it. PWA-7 says a new version is never applied
 * mid-capture; it is just as true that the OFFER must not land mid-capture.
 *
 * WHAT IT IS. A counter, not a boolean: two captures can be on screen at once
 * (a photograph uploading while the write-up is being typed), and the first one
 * to finish must not unlock on behalf of the other. Each holder gets a release
 * function it may call once; a double release cannot take the count below zero.
 *
 * WHAT IT IS NOT. It is not a lock on the application, on navigation or on
 * saving anything. Nothing waits for it. The only thing it does is let a piece
 * of chrome that would reflow the page ask "is somebody in the middle of
 * something?" and keep quiet until they are not.
 *
 * It lives outside React because the thing that holds it and the thing that
 * reads it are in different trees — a component deep inside a job screen, and
 * the layout's own banner — and a provider wrapping both would exist only to
 * carry a number.
 */
let depth = 0;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

/**
 * Says a capture has started, and hands back the way to say it has finished.
 *
 * The release is idempotent: a component that unmounts after already releasing
 * — a signature confirmed, then the step left — must not decrement twice.
 */
export const beginCapture = (): (() => void) => {
  depth += 1;
  notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth = Math.max(0, depth - 1);
    notify();
  };
};

export const captureInProgress = (): boolean => depth > 0;

/** Always false on the server: it is a browser's state, not a document's. */
export const captureIdleOnServer = (): boolean => false;

export const subscribeToCapture = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** For tests, which must not inherit a count from the test before them. */
export const resetCaptureLock = (): void => {
  depth = 0;
  listeners.clear();
};
