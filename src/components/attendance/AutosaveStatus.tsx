'use client';

import { Button, Icon } from '@/components/ui';
import type { AutosaveState } from '@/lib/attendance-autosave';
import { formatDateTime } from '@/lib/format';

const plural = (count: number) => `${count} change${count === 1 ? '' : 's'}`;

/**
 * WHETHER ATTENDANCE IS SAVED, ALWAYS IN VIEW. ATT-AUTO-1.
 *
 * There is no Save button to press, so this line has to answer the question a
 * Save button answers: is what I chose on the server? Saving…, All changes
 * saved with the time of the last save, kept on this device while offline,
 * or why a change was refused — with Retry. It stays in view under the top bar
 * while a long month is scrolled, and is announced to screen readers.
 */
export const AutosaveStatus = ({
  state,
  onRetry,
  conflict,
  onDismissConflict,
}: {
  readonly state: AutosaveState;
  readonly onRetry: () => void;
  readonly conflict: string | null;
  readonly onDismissConflict: () => void;
}) => {
  const tone =
    state.kind === 'failed' || state.kind === 'offline'
      ? 'border-signal-200 bg-signal-50 text-signal-700'
      : state.kind === 'incomplete'
        ? 'border-amber-eje-200 bg-amber-eje-50 text-amber-eje-700'
        : state.kind === 'saved'
          ? 'border-verdant-200 bg-verdant-50 text-verdant-700'
          : 'border-steel-200 bg-surface text-steel-700';
  const text =
    state.kind === 'idle'
      ? 'Changes save automatically as you choose — there is no Save button to press.'
      : state.kind === 'waiting'
        ? `Saving shortly — ${plural(state.count)} waiting…`
        : state.kind === 'saving'
          ? `Saving ${plural(state.count)}…`
          : state.kind === 'saved'
            ? `All changes saved. Last saved ${formatDateTime(state.at)}.`
            : state.kind === 'incomplete'
              ? `Not saved yet: ${plural(state.count)} still need a reason for Absent, or Present or Absent for a note.`
              : state.kind === 'offline'
                ? `No connection — ${plural(state.count)} kept on this device, not yet saved. They save by themselves when the connection is back${state.retryAt === null ? '' : ` (next try ${formatDateTime(state.retryAt)})`}.`
                : `Save failed — ${state.message} Your change is kept: retry it, or undo it on its day.`;
  return (
    <div className="sticky top-16 z-20 mb-3" data-testid="autosave-status" data-state={state.kind}>
      <div role="status" aria-live="polite" className={`flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-sm shadow-sm ${tone}`}>
        <Icon
          name={state.kind === 'saved' ? 'check' : state.kind === 'failed' || state.kind === 'offline' ? 'warning' : 'clock'}
          className={`size-4 shrink-0 ${state.kind === 'saving' ? 'animate-pulse' : ''}`}
        />
        <span className="min-w-0 flex-1">{text}</span>
        {(state.kind === 'failed' || state.kind === 'offline') && (
          <Button size="sm" variant="secondary" onClick={onRetry} data-testid="autosave-retry">
            Retry now
          </Button>
        )}
      </div>
      {conflict !== null && (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3 py-2 text-sm text-amber-eje-700" data-testid="autosave-conflict">
          <span className="min-w-0 flex-1">Somebody else changed a day you were changing, so theirs is kept and shown: {conflict}</span>
          <Button size="sm" variant="ghost" onClick={onDismissConflict}>
            OK
          </Button>
        </div>
      )}
    </div>
  );
};
