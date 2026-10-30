/**
 * WHAT ON THIS PAGE IS TYPED AND NOT YET SAVED. REL-UPD-1 (30 October 2026).
 *
 * Update now reloads the page, and a reload loses what is only in the browser.
 * The screens that hold such work say so here, one line each through
 * `useUnsavedWork`, and the update bar asks before reloading over it — naming
 * what would be lost — instead of guessing from the DOM.
 *
 * It is also the page's `beforeunload` guard for the same work, so closing the
 * tab and updating are protected by one statement of the same fact.
 *
 * Module state, like `capture-lock.ts`: one page, one set of holders.
 */
const holders = new Map<number, string>();
const listeners = new Set<() => void>();
let nextId = 1;

const notify = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Say that `label` is unsaved; the returned function says it is not any more. */
export const holdUnsavedWork = (label: string): (() => void) => {
  const id = nextId;
  nextId += 1;
  holders.set(id, label);
  notify();
  return () => {
    if (!holders.delete(id)) return;
    notify();
  };
};

/** What would be lost by reloading now, in the words of the screens holding it. */
export const unsavedWork = (): readonly string[] => [...new Set(holders.values())];

export const hasUnsavedWork = (): boolean => holders.size > 0;

export const subscribeToUnsavedWork = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** For tests. */
export const resetUnsavedWork = (): void => {
  holders.clear();
  listeners.clear();
};
