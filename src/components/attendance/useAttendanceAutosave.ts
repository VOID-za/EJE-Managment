'use client';

import { useEffect, useState } from 'react';
import { ApiRequestError } from '@/api/client';
import { attendance } from '@/api/endpoints';
import { useUnsavedWork } from '@/hooks/useUnsavedWork';
import { AttendanceAutosaver, type SendFailure } from '@/lib/attendance-autosave';
import { useApp, useCurrentUser } from '@/providers/AppProvider';

const classify = (cause: unknown): SendFailure => {
  if (cause instanceof ApiRequestError) {
    const detail = cause.violations.map((violation) => violation.message).join(' ');
    const message = `${cause.message}${detail.length > 0 ? ` ${detail}` : ''}`;
    if (cause.code === 'network') return { kind: 'network', message };
    if (cause.violations.some((violation) => violation.code === 'attendance_changed')) return { kind: 'conflict', message };
    return { kind: 'refused', message };
  }
  return { kind: 'refused', message: cause instanceof Error ? cause.message : 'The change could not be saved.' };
};

/**
 * ONE AUTOSAVING ATTENDANCE LIST. ATT-AUTO-1 — see `AttendanceAutosaver` for
 * every rule; this connects it to the page:
 *
 *  - the queue is this person's and this list's (`scope`), kept on the device;
 *  - a save refreshes what is on screen once a run of saves has finished;
 *  - the browser coming back online sends at once; the page being hidden (the
 *    tablet switched to another app) sends at once; the page being left sends
 *    what is waiting with `keepalive`;
 *  - while anything is unsaved, closing or reloading the tab warns first.
 *
 * Null until it starts in the browser — the server renders no autosaver.
 */
export const useAttendanceAutosave = (scope: 'mine' | 'register') => {
  const user = useCurrentUser();
  const { invalidate } = useApp();
  const [saver, setSaver] = useState<AttendanceAutosaver | null>(null);
  const [, setTick] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    const started = new AttendanceAutosaver({
      send: (input, options) => attendance.record(input, options),
      classify,
      storageKey: `eje:attendance-autosave:${scope}:${user.id}`,
      online: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
      onChange: () => setTick((tick) => tick + 1),
      onSaved: () => invalidate(),
      onConflict: (_key, message) => setConflict(message),
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the autosaver starts in the browser only, once per person and list.
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
      // Going elsewhere in the application: what is waiting is sent now, and stays on the device until seen saved.
      started.leave();
      started.dispose();
    };
  }, [scope, user.id, invalidate]);

  useUnsavedWork((saver?.unsavedCount ?? 0) > 0, 'attendance changes still being saved');

  return { saver, conflict, dismissConflict: () => setConflict(null) };
};
