'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui';

/**
 * REGISTERS THE WORKER, AND OFFERS THE UPDATE. PWA-5, PWA-7.
 *
 * WHY THE UPDATE IS OFFERED AND NEVER TAKEN. A new build means new JavaScript
 * chunks. Activating a waiting worker and reloading swaps them underneath
 * whoever is using the application — and the person using this application is
 * a technician who may be half-way through a completion write-up with the
 * customer waiting. PWA-7 says a new version is applied "without the tablet
 * being reinstalled, and never mid-capture", so the worker installs quietly,
 * waits, and this bar asks. Nothing reloads until somebody taps.
 *
 * WHY IT IS SAFE TO WAIT. The waiting worker changes nothing: the running one
 * keeps serving the build the page already has, and its cached chunks match
 * that build because Next content-hashes them. A technician can finish the job
 * card and update between jobs.
 *
 * BROWSERS WITHOUT SERVICE WORKERS get nothing at all — no error, no bar, no
 * degraded screen. The application is online-first and works exactly as it did
 * before any of this existed; the worker is an addition, not a dependency.
 */
export const ServiceWorkerManager = () => {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    // A worker is a production concern: in development the chunks change on
    // every save and a cache between the two is only ever in the way.
    if (process.env.NODE_ENV !== 'production') return;

    let cancelled = false;

    const watch = (registration: ServiceWorkerRegistration) => {
      if (cancelled) return;
      if (registration.waiting !== null) setWaiting(registration.waiting);

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing;
        if (installing === null) return;
        installing.addEventListener('statechange', () => {
          // `controller` is null on the very first install — that is this page
          // getting a worker for the first time, not an update to offer.
          if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) {
            setWaiting(installing);
          }
        });
      });
    };

    navigator.serviceWorker
      .register('/eje-sw.js', { scope: '/', updateViaCache: 'none' })
      .then(watch)
      .catch(() => {
        // A refused registration is not a fault the technician can act on, and
        // the application works without it. It is left silent on purpose.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const update = useCallback(() => {
    waiting?.postMessage({ type: 'EJE_SKIP_WAITING' });
    // The new worker takes control, and the reload picks up its chunks.
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    });
  }, [waiting]);

  if (waiting === null || dismissed) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <p className="min-w-0">
        <strong className="font-semibold">A new version of EJE is ready.</strong> It will be used
        the next time the application starts — finish what you are capturing first.
      </p>
      <span className="flex shrink-0 gap-2">
        <Button type="button" variant="secondary" onClick={() => setDismissed(true)}>
          Not now
        </Button>
        <Button type="button" onClick={update}>
          Update now
        </Button>
      </span>
    </div>
  );
};
