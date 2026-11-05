'use client';

import { useEffect, useState } from 'react';
import { ApiRequestError } from '@/api/client';
import { timesheets } from '@/api/endpoints';
import { useUnsavedWork } from '@/hooks/useUnsavedWork';
import type { SendFailure } from '@/lib/attendance-autosave';
import { TimesheetAutosaver, type TimesheetChange } from '@/lib/timesheet-autosave';
import { useApp } from '@/providers/AppProvider';

const CONFLICTS = new Set(['timesheet_line_changed', 'timesheet_comment_changed', 'timesheet_line_removed']);

const classify = (cause: unknown): SendFailure => {
  if (cause instanceof ApiRequestError) {
    const detail = cause.violations.map((violation) => violation.message).join(' ');
    const message = `${cause.message}${detail.length > 0 ? ` ${detail}` : ''}`;
    if (cause.code === 'network') return { kind: 'network', message };
    if (cause.violations.some((violation) => CONFLICTS.has(violation.code))) return { kind: 'conflict', message };
    return { kind: 'refused', message };
  }
  return { kind: 'refused', message: cause instanceof Error ? cause.message : 'The change could not be saved.' };
};

/** What was typed here and not saved, said in the person's own values. */
const notSaved = (lost: TimesheetChange): string =>
  lost.kind === 'line'
    ? `Not saved from this screen: ${lost.date ?? 'no date'}, ${lost.typed.pick === '__workshop__' ? 'Workshop' : lost.typed.customerName.trim() || 'no customer'}, OT ${lost.typed.overtime}, D/T ${lost.typed.double}, call-out R${lost.typed.callout}, Int Km ${lost.typed.internalKm}, Cust Km ${lost.typed.customerKm}.`
    : lost.kind === 'comment'
      ? `Not saved from this screen: the comment “${lost.comment.slice(0, 200)}”.`
      : '';

/**
 * ONE PERSON'S AUTOSAVING TIMESHEET (PAYROLL-ONE-1) — see `TimesheetAutosaver`
 * for every rule. Connected to the page as Attendance's is: the queue kept on
 * this device for this person, a save refreshing the screen, the browser
 * coming back online or the tab being hidden sending at once, leaving the page
 * sending what is waiting, and a warning before the tab is closed while
 * anything is unsaved. Null until it starts in the browser.
 */
export const useTimesheetAutosave = (personId: string | null, onSaved: () => void) => {
  const { invalidate } = useApp();
  const [saver, setSaver] = useState<TimesheetAutosaver | null>(null);
  const [, setTick] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    if (personId === null) return;
    const started = new TimesheetAutosaver({
      saveLine: async (input, options) => {
        const { line } = await timesheets.saveLine(personId, input, options);
        return { id: line.id, revision: line.revision };
      },
      removeLine: (id, options) => timesheets.removeLine(personId, id, options),
      saveComment: (comment, expected, options) => timesheets.saveWorkingComment(personId, comment, expected, options),
      classify,
      storageKey: `eje:timesheet-autosave:${personId}`,
      online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
      onChange: () => setTick((tick) => tick + 1),
      onSaved: () => {
        invalidate();
        onSaved();
      },
      onConflict: (_id, message, lost) => setConflict(`${message} ${notSaved(lost)}`),
      current: async (id) => {
        if (id === '__comment__') {
          const sheet = await timesheets.working(personId);
          return { revision: sheet.comment, comment: sheet.comment };
        }
        const line = (await timesheets.lines(personId)).find((candidate) => candidate.id === id);
        return line === undefined ? null : { revision: line.revision, date: line.date, typed: line.typed };
      },
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the autosaver starts in the browser only, once per person.
    setSaver(started);
    const online = () => started.online();
    const hidden = () => {
      if (document.visibilityState === 'hidden') started.flushNow();
    };
    const leave = () => started.leave();
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leave);
      started.leave();
      started.dispose();
    };
    // `onSaved` is a refetch, stable for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, invalidate]);

  useUnsavedWork((saver?.unsavedCount ?? 0) > 0, 'timesheet changes still being saved');

  return { saver, conflict, dismissConflict: () => setConflict(null) };
};
