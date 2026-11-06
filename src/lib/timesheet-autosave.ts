import type { TimesheetLineTyped } from '@/domain';
import type { AutosaveState, SendFailure } from './attendance-autosave';
import { RETRY_MS } from './attendance-autosave';

/**
 * TIMESHEET LINES SAVE THEMSELVES. PAYROLL-ONE-1 (the owner, 5 November 2026:
 * "There must be no Submit Timesheet button on this page. All changes must
 * save automatically").
 *
 * The same queue as Attendance's (`AttendanceAutosaver`, ATT-AUTO-1), for the
 * three things the Timesheets page changes — a line as typed, a line removed,
 * and the sheet's comment:
 *
 *  - one change waiting per line (a later keystroke REPLACES the earlier
 *    change, so a burst of typing is one request, never two racing ones);
 *  - a pause before sending (`DEBOUNCE_MS`), so a request is not sent per key;
 *  - one request at a time, in the order the lines were changed;
 *  - each save names the REVISION of the line the screen began from, and the
 *    server refuses a save from an older one (`timesheet_line_changed`): the
 *    newer line is reloaded and the person told, never overwritten;
 *  - EVERY change is sent — a line that is not complete is kept by the server
 *    as a draft, so nothing waits on this device for being incomplete;
 *  - a failed connection keeps every change and retries (2 s, 5 s, 10 s, then
 *    every 30 s), and at once when the browser is back online;
 *  - a refusal keeps the change, says why, and offers Retry;
 *  - the queue is kept on this device as it changes, so a reload or a closed
 *    tab gives it back; leaving the page sends what is waiting (`keepalive`);
 *  - "Saved" only ever means the server answered that it has it.
 *
 * Pure TypeScript, tested without a browser (`timesheet-autosave.test.ts`).
 */

export const COMMENT_KEY = '__comment__';

const sameTyped = (a: TimesheetLineTyped, b: TimesheetLineTyped): boolean =>
  (Object.keys(a) as (keyof TimesheetLineTyped)[]).every((key) => String(a[key]).trim() === String(b[key]).trim());
export const TIMESHEET_DEBOUNCE_MS = 800;
/** The possibly-saved sends remembered per line after lost answers. */
const UNSURE_KEPT = 8;

export type TimesheetChange =
  | {
      readonly kind: 'line';
      readonly id: string;
      readonly date: string | null;
      readonly typed: TimesheetLineTyped;
      /** The revision this run of changes began from; null for a line added on this screen. */
      readonly base: string | null;
      readonly version: number;
      readonly refused?: string;
      /**
       * Sent when the connection dropped: each may have been saved, so the revision named may be old.
       * EVERY such send since the last confirmed save — two lost answers in a row leave the server
       * holding the first while the second is the latest sent.
       */
      readonly unsure?: readonly { readonly date: string | null; readonly typed: TimesheetLineTyped }[];
    }
  | { readonly kind: 'remove'; readonly id: string; readonly version: number; readonly refused?: string }
  | { readonly kind: 'comment'; readonly id: typeof COMMENT_KEY; readonly comment: string; readonly base: string; readonly version: number; readonly refused?: string; readonly unsure?: readonly string[] };

/** What a save of a line answered: the revision the next save must name. */
export interface SavedLine {
  readonly id: string;
  readonly revision: string;
}

export interface TimesheetAutosaverOptions {
  readonly saveLine: (
    input: { readonly id: string; readonly date: string | null; readonly typed: TimesheetLineTyped; readonly expectedRevision: string | null },
    options: { readonly keepalive: boolean },
  ) => Promise<SavedLine>;
  readonly removeLine: (id: string, options: { readonly keepalive: boolean }) => Promise<unknown>;
  readonly saveComment: (comment: string, expected: string, options: { readonly keepalive: boolean }) => Promise<unknown>;
  readonly classify: (cause: unknown) => SendFailure;
  readonly storageKey: string | null;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  readonly online?: () => boolean;
  readonly now?: () => string;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly onChange: () => void;
  /** A run of saves finished with at least one saved: reload what is on screen. */
  readonly onSaved: () => void;
  /** A change refused because the server has a newer one (or the line was removed): the change itself is given, so the person can be told what was not saved. */
  readonly onConflict: (id: string, message: string, lost: TimesheetChange) => void;
  /**
   * What the server holds now — asked only when a save refused as stale had been sent before
   * on a connection that dropped: if the server holds exactly what was sent then, the save had
   * gone through and its answer was lost, and the newer typing is sent on from it.
   */
  readonly current?: (id: string) => Promise<{ readonly revision: string; readonly date?: string | null; readonly typed?: TimesheetLineTyped; readonly comment?: string } | null>;
}

type ChangeInput =
  | { readonly kind: 'line'; readonly id: string; readonly date: string | null; readonly typed: TimesheetLineTyped; readonly base: string | null }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'comment'; readonly comment: string; readonly base: string };

export class TimesheetAutosaver {
  private readonly pending = new Map<string, TimesheetChange>();
  /** Revisions saved during this visit: newer than the screen's data until it reloads. */
  private readonly revisions = new Map<string, string>();
  /** What each line saved this visit said, until the list on screen catches up (TS-DAY-1: the day adds it up at once). */
  private readonly savedLines = new Map<string, { readonly date: string | null; readonly typed: TimesheetLineTyped; readonly revision: string; readonly behind: readonly (string | null)[] }>();
  private savedComment: string | null = null;
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private retries = 0;
  private inFlight = false;
  /** The change being sent right now: it may reach the server whatever happens to it here. */
  private sending: string | null = null;
  private sendingChange: TimesheetChange | null = null;
  private again = false;
  private lastSavedAt: string | null = null;
  private offlineUntil: string | null = null;
  private offline = false;
  private disposed = false;

  constructor(private readonly options: TimesheetAutosaverOptions) {
    for (const change of this.read()) this.pending.set(change.id, change);
    if (this.pending.size > 0) this.schedule(0);
  }

  /** A change to a line, a removal, or the comment. */
  change(input: ChangeInput, debounce: number = TIMESHEET_DEBOUNCE_MS): void {
    const id = input.kind === 'comment' ? COMMENT_KEY : input.id;
    const previous = this.pending.get(id);
    const version = (previous?.version ?? 0) + 1;
    let next: TimesheetChange;
    if (input.kind === 'line') {
      const base = previous?.kind === 'line' ? previous.base : this.revisions.get(id) ?? input.base;
      // A save that may have gone through before the connection dropped stays remembered while more is typed.
      const unsure = previous?.kind === 'line' ? previous.unsure : undefined;
      next = { kind: 'line', id, date: input.date, typed: input.typed, base, version, ...(unsure === undefined ? {} : { unsure }) };
    } else if (input.kind === 'remove') {
      // A line added here and never saved simply goes: there is nothing on the server to remove.
      if (previous?.kind === 'line' && previous.base === null && !this.revisions.has(id) && this.sending !== id && previous.unsure === undefined) {
        this.pending.delete(id);
        this.write();
        this.options.onChange();
        return;
      }
      next = { kind: 'remove', id, version };
    } else {
      const base = previous?.kind === 'comment' ? previous.base : this.savedComment ?? input.base;
      const unsure = previous?.kind === 'comment' ? previous.unsure : undefined;
      next = { kind: 'comment', id: COMMENT_KEY, comment: input.comment, base, version, ...(unsure === undefined ? {} : { unsure }) };
    }
    this.pending.set(id, next);
    this.write();
    this.options.onChange();
    this.schedule(input.kind === 'remove' ? 0 : debounce);
  }

  /** Undoes a change not yet saved. */
  discard(id: string): void {
    if (!this.pending.delete(id)) return;
    this.write();
    this.options.onChange();
  }

  retry(): void {
    for (const [id, change] of this.pending) {
      if (change.refused !== undefined) {
        const { refused: _refused, ...rest } = change;
        this.pending.set(id, rest as TimesheetChange);
      }
    }
    this.retries = 0;
    this.offline = false;
    this.options.onChange();
    this.schedule(0);
  }

  online(): void {
    if (this.offline) this.retry();
  }

  /** The page is being left: what is waiting is sent with `keepalive`; the queue stays on the device until seen saved. */
  leave(): void {
    /*
     * Whatever is sent now with keepalive — and the save still in flight, whose
     * answer this page will never read — may be saved. Each is remembered as
     * possibly saved, on the device, so the next visit recognises its own work
     * instead of taking it for another device's (the recovery in `flush`).
     */
    for (const [id, change] of this.pending) {
      if (change.refused !== undefined) continue;
      const inFlight = this.sendingChange?.id === id ? this.sendingChange : null;
      if (change.kind === 'line') {
        const sent = [...(inFlight?.kind === 'line' ? [{ date: inFlight.date, typed: inFlight.typed }] : []), { date: change.date, typed: change.typed }];
        this.pending.set(id, { ...change, unsure: [...(change.unsure ?? []), ...sent].slice(-UNSURE_KEPT) });
      } else if (change.kind === 'comment') {
        const sent = [...(inFlight?.kind === 'comment' ? [inFlight.comment] : []), change.comment];
        this.pending.set(id, { ...change, unsure: [...(change.unsure ?? []), ...sent].slice(-UNSURE_KEPT) });
      }
    }
    this.write();
    for (const change of this.pending.values()) {
      if (change.refused !== undefined) continue;
      if (change.kind === 'line') {
        void this.options
          .saveLine({ id: change.id, date: change.date, typed: change.typed, expectedRevision: change.base }, { keepalive: true })
          .catch(() => undefined);
      } else if (change.kind === 'comment') {
        void this.options.saveComment(change.comment, change.base, { keepalive: true }).catch(() => undefined);
      } else {
        // A removal tapped just before leaving goes too (asked again, it changes nothing).
        void this.options.removeLine(change.id, { keepalive: true }).catch(() => undefined);
      }
    }
  }

  flushNow(): void {
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    this.clear('timer');
    this.clear('retryTimer');
  }

  /** The change not yet saved for a line (or the comment), if any. */
  pendingFor(id: string): TimesheetChange | null {
    return this.pending.get(id) ?? null;
  }

  /** Lines added on this device and not (known to be) on the server yet — after a reload too. */
  newLines(): readonly Extract<TimesheetChange, { kind: 'line' }>[] {
    return [...this.pending.values()].filter(
      (change): change is Extract<TimesheetChange, { kind: 'line' }> => change.kind === 'line' && change.base === null && !this.revisions.has(change.id),
    );
  }

  /** Every change the server refused, still waiting here to be fixed, retried or discarded. */
  refusedChanges(): readonly TimesheetChange[] {
    return [...this.pending.values()].filter((change) => change.refused !== undefined);
  }

  /** The revision saved this visit for a line, newer than the screen's data. */
  revisionOf(id: string): string | null {
    return this.revisions.get(id) ?? null;
  }

  /**
   * The date and values last saved for a line from this device this visit, while the list on screen still shows
   * a version this device saved over (`listRevision`). Null once the list has caught up — or when the list shows
   * a version made somewhere else (another device moved or changed the line): the list is then newer, not this.
   */
  savedLineOf(id: string, listRevision: string | null): { readonly date: string | null; readonly typed: TimesheetLineTyped } | null {
    const saved = this.savedLines.get(id);
    if (saved === undefined || this.revisions.get(id) !== saved.revision || !saved.behind.includes(listRevision)) return null;
    return { date: saved.date, typed: saved.typed };
  }

  get unsavedCount(): number {
    return this.pending.size;
  }

  state(): AutosaveState {
    const changes = [...this.pending.values()];
    const count = changes.length;
    if (this.inFlight) return { kind: 'saving', count };
    const refused = changes.find((change) => change.refused !== undefined);
    if (refused !== undefined) return { kind: 'failed', count, message: refused.refused! };
    if (this.offline && count > 0) return { kind: 'offline', count, retryAt: this.offlineUntil };
    if (count > 0) return { kind: 'waiting', count };
    return this.lastSavedAt === null ? { kind: 'idle' } : { kind: 'saved', at: this.lastSavedAt };
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    this.clear('timer');
    this.timer = (this.options.setTimer ?? ((run, wait) => setTimeout(run, wait)))(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  private clear(which: 'timer' | 'retryTimer'): void {
    if (this[which] === null) return;
    (this.options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this[which]);
    this[which] = null;
  }

  private async send(change: TimesheetChange): Promise<void> {
    if (change.kind === 'line') {
      const saved = await this.options.saveLine(
        { id: change.id, date: change.date, typed: change.typed, expectedRevision: change.base },
        { keepalive: false },
      );
      this.revisions.set(change.id, saved.revision);
      // The versions this save replaced, one after another from this device: the list may still show any of them.
      const before = this.savedLines.get(change.id);
      const behind = before !== undefined && before.revision === change.base ? [...before.behind, change.base] : [change.base];
      this.savedLines.set(change.id, { date: change.date, typed: change.typed, revision: saved.revision, behind });
    } else if (change.kind === 'remove') {
      await this.options.removeLine(change.id, { keepalive: false });
      this.revisions.delete(change.id);
      this.savedLines.delete(change.id);
    } else {
      await this.options.saveComment(change.comment, change.base, { keepalive: false });
      this.savedComment = change.comment;
    }
  }

  private async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (!(this.options.online?.() ?? true) && this.pending.size > 0) {
      this.goOffline();
      return;
    }
    this.inFlight = true;
    this.options.onChange();
    let savedAny = false;
    try {
      for (;;) {
        const next = [...this.pending.values()].find((change) => change.refused === undefined);
        if (next === undefined) break;
        try {
          this.sending = next.id;
          this.sendingChange = next;
          await this.send(next);
          if (this.disposed) return;
          savedAny = true;
          this.lastSavedAt = (this.options.now ?? (() => new Date().toISOString()))();
          this.offline = false;
          this.retries = 0;
          const current = this.pending.get(next.id);
          if (current?.version === next.version) this.pending.delete(next.id);
          // A newer change raced this save: it goes next, from what was just saved.
          else if (current?.kind === 'line') this.pending.set(next.id, { ...current, base: this.revisions.get(next.id) ?? current.base });
          else if (current?.kind === 'comment' && next.kind === 'comment') this.pending.set(next.id, { ...current, base: next.comment });
          this.write();
        } catch (cause: unknown) {
          if (this.disposed) return;
          const failure = this.options.classify(cause);
          if (failure.kind === 'network') {
            // It may have been saved before the connection dropped: remembered, so a stale refusal can be told from a real one.
            const current = this.pending.get(next.id);
            if (current?.kind === 'line' && next.kind === 'line') {
              this.pending.set(next.id, { ...current, unsure: [...(current.unsure ?? []), { date: next.date, typed: next.typed }].slice(-UNSURE_KEPT) });
            } else if (current?.kind === 'comment' && next.kind === 'comment') {
              this.pending.set(next.id, { ...current, unsure: [...(current.unsure ?? []), next.comment].slice(-UNSURE_KEPT) });
            }
            this.write();
            this.goOffline();
            break;
          }
          if (failure.kind === 'conflict' && (next.kind === 'line' || next.kind === 'comment') && next.unsure !== undefined && this.options.current !== undefined) {
            const held = await this.options.current(next.id).catch(() => null);
            const ours =
              held !== null &&
              (next.kind === 'line'
                ? held.typed !== undefined && next.unsure.some((sent) => sameTyped(held.typed!, sent.typed) && (held.date ?? null) === sent.date)
                : next.unsure.some((sent) => held.comment === sent));
            const current = this.pending.get(next.id);
            if (ours && current !== undefined && (current.kind === 'line' || current.kind === 'comment')) {
              // Our own lost save: the newer typing goes on from it.
              const { unsure: _unsure, ...rest } = current;
              this.pending.set(next.id, { ...rest, base: rest.kind === 'line' ? held.revision : held.comment ?? rest.base } as TimesheetChange);
              this.revisions.set(next.id, held.revision);
              this.write();
              continue;
            }
          }
          if (failure.kind === 'conflict' && this.pending.get(next.id)?.kind === 'remove' && this.pending.get(next.id)?.version !== next.version) {
            // The save lost to a newer version, but the person has since removed the line: the removal goes on.
            this.revisions.delete(next.id);
            continue;
          }
          if (failure.kind === 'conflict') {
            // The newer version wins; the screen reloads it and says so — and what was typed here, which was not saved.
            const lost = this.pending.get(next.id) ?? next;
            this.pending.delete(next.id);
            this.revisions.delete(next.id);
            if (next.kind === 'comment') this.savedComment = null;
            this.write();
            this.options.onConflict(next.id, failure.message, lost);
            savedAny = true;
            continue;
          }
          const current = this.pending.get(next.id);
          // A newer change (more typing, or the line's removal) queued behind it is not what was refused: it is sent as it is.
          if (current !== undefined && current.version === next.version) this.pending.set(next.id, { ...current, refused: failure.message } as TimesheetChange);
          this.write();
        }
      }
    } finally {
      this.inFlight = false;
      this.sending = null;
      this.sendingChange = null;
    }
    if (savedAny) this.options.onSaved();
    this.options.onChange();
    if (this.again) {
      this.again = false;
      this.schedule(0);
    }
  }

  private goOffline(): void {
    this.offline = true;
    const wait = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)]!;
    this.retries += 1;
    const now = Date.parse((this.options.now ?? (() => new Date().toISOString()))());
    this.offlineUntil = Number.isFinite(now) ? new Date(now + wait).toISOString() : null;
    this.clear('retryTimer');
    this.retryTimer = (this.options.setTimer ?? ((run, ms) => setTimeout(run, ms)))(() => {
      this.retryTimer = null;
      void this.flush();
    }, wait);
    this.options.onChange();
  }

  private storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
    if (this.options.storageKey === null) return null;
    if (this.options.storage !== undefined) return this.options.storage;
    try {
      return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
      return null;
    }
  }

  private read(): TimesheetChange[] {
    try {
      const raw = this.storage()?.getItem(this.options.storageKey!) ?? null;
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is TimesheetChange => {
        if (typeof item !== 'object' || item === null) return false;
        const change = item as TimesheetChange;
        if (typeof change.id !== 'string' || typeof change.version !== 'number') return false;
        if (change.kind === 'line') return typeof change.typed === 'object' && change.typed !== null && typeof change.typed.overtime === 'string';
        if (change.kind === 'comment') return typeof change.comment === 'string' && typeof change.base === 'string';
        return change.kind === 'remove';
      }).map((change) => {
        // A queue kept by v1.5.0 held ONE possibly-saved send; it is the list's only member now.
        const unsure = (change as { unsure?: unknown }).unsure;
        return unsure === undefined || Array.isArray(unsure) ? change : ({ ...change, unsure: [unsure] } as unknown as TimesheetChange);
      });
    } catch {
      return [];
    }
  }

  private write(): void {
    try {
      const storage = this.storage();
      if (storage === null) return;
      if (this.pending.size === 0) storage.removeItem(this.options.storageKey!);
      else storage.setItem(this.options.storageKey!, JSON.stringify([...this.pending.values()]));
    } catch {
      // Storage unavailable: the queue lives in this page only, and the page still warns before it is left.
    }
  }
}
