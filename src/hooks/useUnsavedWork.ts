'use client';

import { useEffect } from 'react';
import { holdUnsavedWork } from '@/lib/pwa/unsaved-work';

/**
 * While `dirty`, this screen has typed work that only the browser holds.
 * REL-UPD-1.
 *
 * Two protections from one line: the browser warns before the tab is closed
 * or reloaded (`beforeunload`), and the update bar names `label` and asks
 * before Update now reloads over it. See `unsaved-work.ts`.
 */
export const useUnsavedWork = (dirty: boolean, label: string): void => {
  useEffect(() => {
    if (!dirty) return;
    const release = holdUnsavedWork(label);
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      release();
    };
  }, [dirty, label]);
};
