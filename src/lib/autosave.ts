/**
 * Autosave, as a thing that can be reasoned about on its own.
 *
 * A technician filling in a completion write-up on a tablet in a workshop
 * should not have to remember to press Save, and should not lose a paragraph
 * because the job was handed over, the screen locked or the browser was closed.
 * But a write on every keystroke is a write per character — dozens of round
 * trips for one sentence, and, once this works offline, dozens of queued
 * mutations to reconcile for one field.
 *
 * So: edits are held briefly and written once the typing stops, with a ceiling
 * so continuous typing still reaches the server, and never two saves at once.
 *
 * IT IS DELIBERATELY NOT A REACT HOOK. The rules here — when to write, what to
 * do when a save is already running, what happens to an edit made while one is
 * in flight, what a failure leaves behind — are the whole of the behaviour, and
 * they are testable in isolation only if they do not need a DOM to exist. The
 * hook around it is then thin enough to read at a glance.
 */

export type AutosaveStatus =
  /** Nothing outstanding: what the server holds is what was typed. */
  | { readonly kind: 'clean' }
  /** Edits are held, waiting for the typing to stop. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'saved'; readonly at: string }
  /** The write was refused or failed. The edit is KEPT, not discarded. */
  | { readonly kind: 'failed'; readonly message: string };

export interface AutosaveOptions<T> {
  /** Writes the value. Rejecting means the save failed. */
  save(value: T): Promise<unknown>;
  /** Told about every status change, in order. */
  onStatus?(status: AutosaveStatus): void;
  /** How long the typing must stop for. */
  readonly delayMs?: number;
  /**
   * The longest an edit may be held while somebody keeps typing.
   *
   * Without it, a technician writing a long paragraph without a pause of
   * `delayMs` would have nothing saved at all until they stopped — which is
   * exactly the case the whole thing exists for.
   */
  readonly maxWaitMs?: number;
  /** Whether two values are the same write. Defaults to `Object.is`. */
  equal?(a: T, b: T): boolean;
  /** The clock, for the "saved at" stamp. */
  now?(): string;
}

export interface Autosaver<T> {
  /** A new value was typed. Schedules a save unless it is already saved. */
  change(value: T): void;
  /** Write whatever is held, now. Resolves once nothing is outstanding. */
  flush(): Promise<void>;
  /** Throw away what is held and forget it was ever typed. */
  cancel(): void;
  /** What the server is known to hold. */
  saved(): T;
  status(): AutosaveStatus;
  /** Whether anything typed has yet to reach the server. */
  dirty(): boolean;
}

const CLEAN: AutosaveStatus = { kind: 'clean' };

export const createAutosaver = <T,>(
  initial: T,
  options: AutosaveOptions<T>,
): Autosaver<T> => {
  const delayMs = options.delayMs ?? 1_200;
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const same = options.equal ?? ((a: T, b: T) => Object.is(a, b));
  const now = options.now ?? (() => new Date().toISOString());

  let saved = initial;
  /** What is typed but not yet written. Null means nothing outstanding. */
  let pending: { value: T } | null = null;
  let firstPendingAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let current: AutosaveStatus = CLEAN;

  const announce = (next: AutosaveStatus): void => {
    current = next;
    options.onStatus?.(next);
  };

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (): void => {
    clearTimer();
    const waited = firstPendingAt === null ? 0 : Date.now() - firstPendingAt;
    // The ceiling wins: somebody still typing is not a reason to hold an edit
    // for ever.
    const wait = Math.max(0, Math.min(delayMs, maxWaitMs - waited));
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, wait);
  };

  /**
   * One write at a time, always of the LATEST value.
   *
   * An edit made while a save is in flight is not dropped and does not start a
   * second concurrent write — the two would race and the older one could land
   * last. It is written straight after, in the same chain.
   */
  const write = async (): Promise<void> => {
    if (inFlight !== null) return inFlight;
    if (pending === null) return;

    const run = async (): Promise<void> => {
      while (pending !== null) {
        const attempt = pending.value;
        clearTimer();
        announce({ kind: 'saving' });
        try {
          await options.save(attempt);
        } catch (error) {
          /*
           * THE EDIT SURVIVES A FAILURE.
           *
           * `pending` is left exactly as it is, so the text is still on screen
           * and still queued: the next keystroke, the next flush or an explicit
           * retry writes it. Clearing it here would lose the technician's work
           * to a dropped connection, which is the one thing this must never do.
           */
          announce({
            kind: 'failed',
            message:
              error instanceof Error ? error.message : 'The write-up could not be saved.',
          });
          return;
        }
        saved = attempt;
        // Written while that save was in flight: same value, so nothing is
        // outstanding any more.
        if (pending !== null && same(pending.value, attempt)) {
          pending = null;
          firstPendingAt = null;
        }
        announce(pending === null ? { kind: 'saved', at: now() } : { kind: 'pending' });
      }
    };

    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    change(value: T): void {
      if (same(value, saved)) {
        // Typed back to what the server holds — including an undo. There is
        // nothing to write, so the held edit and its timer go.
        pending = null;
        firstPendingAt = null;
        clearTimer();
        if (current.kind === 'pending' || current.kind === 'failed') announce(CLEAN);
        return;
      }
      pending = { value };
      firstPendingAt ??= Date.now();
      if (current.kind !== 'saving') announce({ kind: 'pending' });
      schedule();
    },
    async flush(): Promise<void> {
      clearTimer();
      await write();
      // A value typed during that write is written by the same loop; awaiting
      // the chain again is how a caller knows it has settled.
      if (inFlight !== null) await inFlight;
    },
    cancel(): void {
      clearTimer();
      pending = null;
      firstPendingAt = null;
      announce(CLEAN);
    },
    saved: () => saved,
    status: () => current,
    dirty: () => pending !== null,
  };
};
