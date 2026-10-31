import type { AbsenceReason, AttendanceRecord, AttendanceStatus } from '@/domain';

/**
 * ATTENDANCE SAVES ITSELF. ATT-AUTO-1 (the tester, 31 October 2026: "there is
 * no Save option … AUTOMATICALLY SAVE WHILE THE USER FILLS IN THE FORM").
 *
 * WHAT THERE WAS. Every Present tap was one request, sent at once, and while it
 * was in flight EVERY Present and Absent button on the page was disabled — so
 * a person going down a month tapped buttons that ignored them, and on a slow
 * connection most taps were silently lost. Nothing said whether a day had been
 * saved. A note typed in the office register was only sent if a status button
 * was pressed afterwards: typed and left, it was lost without a word.
 *
 * WHAT THIS IS. A queue of the changes not yet on the server, one per person
 * and day (a later change to the same day REPLACES the earlier one, so a burst
 * of taps is one request and never two conflicting ones):
 *
 *  - changes wait a moment before they are sent (`debounce`), longer for a
 *    note being typed, so a request is not sent on every key;
 *  - one request at a time, in the order the days were changed;
 *  - each says which record it was looking at (`expectedRecordedAt`), so a day
 *    somebody else recorded since is never overwritten — that day is reloaded
 *    and the person told (`attendance_changed`);
 *  - a failed connection keeps every change and retries (2 s, 5 s, 10 s, then
 *    every 30 s), and at once when the browser says it is back online;
 *  - a refusal (a submitted month, say) keeps that change, says why beside the
 *    status, and lets the person retry or undo it — nothing is dropped
 *    silently;
 *  - the queue is written to this device as it changes, so a reload or a
 *    closed tab gives it back, and leaving the page sends what is waiting with
 *    `keepalive` so the browser finishes the request.
 *
 * A change the server could not accept yet — Absent without a reason, a note
 * with no Present or Absent — is held, shown, and sent the moment it is
 * complete. Pure TypeScript, so every one of these paths is tested without a
 * browser (`attendance-autosave.test.ts`).
 */

export interface AttendanceAnswer {
  readonly status: AttendanceStatus | null;
  readonly absenceReason: AbsenceReason | null;
  readonly note: string;
}

export interface PendingChange extends AttendanceAnswer {
  readonly userId: string;
  readonly date: string;
  /** The `recordedAt` of the record the screen showed when this change began; null for none. */
  readonly base: string | null;
  /** Bumped by every change to this day, so a save that raced a newer change does not clear it. */
  readonly version: number;
  /** Why the server refused it; it is not sent again until changed or retried. */
  readonly refused?: string;
}

export type AutosaveState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting'; readonly count: number }
  | { readonly kind: 'saving'; readonly count: number }
  | { readonly kind: 'saved'; readonly at: string }
  | { readonly kind: 'incomplete'; readonly count: number }
  | { readonly kind: 'offline'; readonly count: number; readonly retryAt: string | null }
  | { readonly kind: 'failed'; readonly count: number; readonly message: string };

export interface SendInput {
  readonly userId: string;
  readonly date: string;
  readonly status: AttendanceStatus;
  readonly absenceReason: AbsenceReason | null;
  readonly note: string;
  readonly expectedRecordedAt: string | null;
}

/** What a failed send was: the connection, a newer record, or a refusal in words. */
export type SendFailure =
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'conflict'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

export interface AutosaverOptions {
  readonly send: (input: SendInput, options: { readonly keepalive: boolean }) => Promise<AttendanceRecord>;
  /** Turns whatever `send` threw into one of the three failures. */
  readonly classify: (cause: unknown) => SendFailure;
  /** Where this device keeps the queue; null keeps nothing. */
  readonly storageKey: string | null;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  readonly online?: () => boolean;
  readonly now?: () => string;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Called after every change of state; the screen re-renders from `snapshot()`. */
  readonly onChange: () => void;
  /** Called once a run of saves has finished with at least one saved: refresh what is on screen. */
  readonly onSaved: () => void;
  /** A day somebody else changed: what to tell the person. */
  readonly onConflict: (key: string, message: string) => void;
}

export const DEBOUNCE_MS = { choice: 400, note: 900 } as const;
export const RETRY_MS = [2000, 5000, 10000, 30000] as const;

export const autosaveKey = (userId: string, date: string): string => `${userId}:${date}`;

/** Whether the server can be sent this change yet. */
export const sendable = (change: AttendanceAnswer): boolean =>
  change.status === 'present' || (change.status === 'absent' && change.absenceReason !== null);

export class AttendanceAutosaver {
  private readonly pending = new Map<string, PendingChange>();
  /** Records saved during this visit: newer than the screen's data until it reloads. */
  private readonly saved = new Map<string, AttendanceRecord>();
  private timer: unknown = null;
  private retryTimer: unknown = null;
  private retries = 0;
  private inFlight = false;
  private again = false;
  private lastSavedAt: string | null = null;
  private offlineUntil: string | null = null;
  private offline = false;
  private disposed = false;

  constructor(private readonly options: AutosaverOptions) {
    for (const change of this.read()) this.pending.set(autosaveKey(change.userId, change.date), change);
    if (this.pending.size > 0) this.schedule(0);
  }

  /** A change to one day. `base` is the record the screen was showing (null for none). */
  change(userId: string, date: string, answer: AttendanceAnswer, base: string | null, kind: keyof typeof DEBOUNCE_MS = 'choice'): void {
    const key = autosaveKey(userId, date);
    const previous = this.pending.get(key);
    this.pending.set(key, {
      ...answer,
      userId,
      date,
      // The record this run of changes began from — or the one this visit saved since.
      base: previous !== undefined ? previous.base : this.saved.has(key) ? this.saved.get(key)!.recordedAt : base,
      version: (previous?.version ?? 0) + 1,
    });
    this.write();
    this.options.onChange();
    this.schedule(DEBOUNCE_MS[kind]);
  }

  /** Undoes a change not yet saved: the day goes back to what the server holds. */
  discard(key: string): void {
    if (!this.pending.delete(key)) return;
    this.write();
    this.options.onChange();
  }

  /** Tries everything waiting again now, refused changes included. */
  retry(): void {
    for (const [key, change] of this.pending) {
      if (change.refused !== undefined) {
        const { refused: _refused, ...rest } = change;
        this.pending.set(key, rest);
      }
    }
    this.retries = 0;
    this.offline = false;
    this.options.onChange();
    this.schedule(0);
  }

  /** The connection is back: send at once. */
  online(): void {
    if (this.offline) this.retry();
  }

  /**
   * The page is being left. Whatever can be sent is sent with `keepalive`, so
   * the browser finishes it after the page is gone; the queue stays on this
   * device until a later visit sees it saved.
   */
  leave(): void {
    for (const change of this.pending.values()) {
      if (!sendable(change) || change.refused !== undefined) continue;
      void this.options.send(this.inputOf(change), { keepalive: true }).catch(() => undefined);
    }
  }

  /** Sends what is waiting now, without the pause. */
  flushNow(): void {
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    this.clear('timer');
    this.clear('retryTimer');
  }

  /** What the screen shows for a day: the change not yet saved, else the record saved this visit. */
  answerFor(userId: string, date: string): (AttendanceAnswer & { readonly unsaved: boolean; readonly refused?: string; readonly recordedAt?: string }) | null {
    const key = autosaveKey(userId, date);
    const change = this.pending.get(key);
    if (change !== undefined) return { ...change, unsaved: true, ...(change.refused === undefined ? {} : { refused: change.refused }) };
    const record = this.saved.get(key);
    return record === undefined
      ? null
      : { status: record.status, absenceReason: record.absenceReason, note: record.note, unsaved: false, recordedAt: record.recordedAt };
  }

  /** Changes not yet saved — for the warning before the page is left. */
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
    if (changes.some(sendable)) return { kind: 'waiting', count };
    if (count > 0) return { kind: 'incomplete', count };
    return this.lastSavedAt === null ? { kind: 'idle' } : { kind: 'saved', at: this.lastSavedAt };
  }

  private inputOf(change: PendingChange): SendInput {
    return {
      userId: change.userId,
      date: change.date,
      status: change.status!,
      absenceReason: change.status === 'absent' ? change.absenceReason : null,
      note: change.note,
      expectedRecordedAt: change.base,
    };
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

  private async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (!(this.options.online?.() ?? true) && [...this.pending.values()].some(sendable)) {
      this.goOffline();
      return;
    }
    this.inFlight = true;
    this.options.onChange();
    let savedAny = false;
    try {
      for (;;) {
        const next = [...this.pending.values()].find((change) => sendable(change) && change.refused === undefined);
        if (next === undefined) break;
        const key = autosaveKey(next.userId, next.date);
        try {
          const record = await this.options.send(this.inputOf(next), { keepalive: false });
          if (this.disposed) return;
          this.saved.set(key, record);
          savedAny = true;
          this.lastSavedAt = (this.options.now ?? (() => new Date().toISOString()))();
          this.offline = false;
          this.retries = 0;
          const current = this.pending.get(key);
          if (current?.version === next.version) this.pending.delete(key);
          // A newer change raced this save: it is sent next, from the record just saved.
          else if (current !== undefined) this.pending.set(key, { ...current, base: record.recordedAt });
          this.write();
        } catch (cause: unknown) {
          if (this.disposed) return;
          const failure = this.options.classify(cause);
          if (failure.kind === 'network') {
            this.goOffline();
            break;
          }
          if (failure.kind === 'conflict') {
            // The newer answer wins; the screen reloads it and says so.
            this.pending.delete(key);
            this.saved.delete(key);
            this.write();
            this.options.onConflict(key, failure.message);
            savedAny = true;
            continue;
          }
          const current = this.pending.get(key);
          if (current !== undefined) this.pending.set(key, { ...current, refused: failure.message });
          this.write();
        }
      }
    } finally {
      this.inFlight = false;
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

  private read(): PendingChange[] {
    try {
      const raw = this.storage()?.getItem(this.options.storageKey!) ?? null;
      if (raw === null) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is PendingChange =>
          typeof item === 'object' && item !== null &&
          typeof (item as PendingChange).userId === 'string' && typeof (item as PendingChange).date === 'string' &&
          typeof (item as PendingChange).note === 'string' && typeof (item as PendingChange).version === 'number',
      );
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
