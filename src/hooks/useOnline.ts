'use client';

import { useSyncExternalStore } from 'react';

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

const read = (): boolean => window.navigator.onLine;

/*
 * Server-rendered as online, because the document reached the browser — the
 * network was there when it was fetched. The real value is read on hydration
 * and whenever it changes.
 */
const readOnServer = (): boolean => true;

/**
 * WHETHER THIS DEVICE THINKS IT HAS A NETWORK. PWA-6.
 *
 * A subscription rather than an effect, so the value is read during render and
 * cannot lag a render behind the event.
 *
 * WHAT IT IS NOT: proof of anything. `navigator.onLine` reports the network
 * interface, so a tablet associated with a plant's WiFi that has no route out
 * answers true, and a captive portal answers true. It is a useful hint for
 * wording and a useless basis for a decision — which is why
 * `describeCacheStatus` weighs the outcome of a real request above it.
 */
export const useOnline = (): boolean => useSyncExternalStore(subscribe, read, readOnServer);
