'use client';

import { useEffect } from 'react';
import { beginCapture } from '@/lib/pwa/capture-lock';

/**
 * Holds the capture lock while `active` is true. PWA-7.
 *
 * One line at each call site, so the components that know they are a capture
 * say so and nothing else has to guess from the DOM. See `capture-lock.ts` for
 * what the lock does and, more importantly, what it does not.
 */
export const useCaptureLock = (active: boolean): void => {
  useEffect(() => {
    if (!active) return;
    return beginCapture();
  }, [active]);
};
