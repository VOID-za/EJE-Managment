'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, ConfirmDialog } from '@/components/ui';
import {
  captureIdleOnServer,
  captureInProgress,
  subscribeToCapture,
} from '@/lib/pwa/capture-lock';
import { hasUnsavedWork, unsavedWork } from '@/lib/pwa/unsaved-work';
import {
  VERSION_POLL_MS,
  WORKER_WAIT_MS,
  buildOfWorkerUrl,
  dismissRelease,
  forgetAttempt,
  isDismissed,
  isNewRelease,
  isKnownBuild,
  mayActivateQuietly,
  outcomeAfterReload,
  recordAttempt,
  serverBuildOf,
  workerUrl,
  type AttemptOutcome,
} from '@/lib/pwa/app-version';

/** The build this page was served from — stamped by `next.config.ts`, the same value as the page's meta tag. */
const PAGE_BUILD = process.env.EJE_BUILD_COMMIT ?? 'unknown';

/** A version check no more often than this, however many events ask for one. */
const MIN_CHECK_GAP_MS = 10 * 1000;

const session = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * The new worker for `build`, once it has installed and is waiting — or null
 * when there is nothing to wait for (already active, refused, or too slow).
 */
const waitForInstalled = (registration: ServiceWorkerRegistration, build: string, ms: number): Promise<ServiceWorker | null> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (worker: ServiceWorker | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(worker);
    };
    const timer = window.setTimeout(() => done(null), ms);
    const follow = (worker: ServiceWorker | null) => {
      if (worker === null || buildOfWorkerUrl(worker.scriptURL) !== build) return false;
      if (worker.state === 'installed') {
        done(worker);
        return true;
      }
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') done(worker);
        if (worker.state === 'redundant' || worker.state === 'activated') done(null);
      });
      return true;
    };
    if (follow(registration.waiting) || follow(registration.installing)) return;
    if (buildOfWorkerUrl(registration.active?.scriptURL) === build && registration.waiting === null) {
      done(null);
      return;
    }
    registration.addEventListener('updatefound', () => void follow(registration.installing));
  });

/**
 * REGISTERS THE WORKER, NOTICES EVERY NEW RELEASE, AND OFFERS THE UPDATE.
 * PWA-5, PWA-7; every release since 30 October 2026 (REL-UPD-1).
 *
 * HOW A NEW RELEASE IS NOTICED — automatically, for every release, with
 * nothing to remember at release time. See `app-version.ts`: the page knows
 * its own build, asks `/api/health` which build the server runs (on start, on
 * returning to the screen, when the connection comes back and every five
 * minutes on screen), and registers the worker under its build so the browser
 * installs a new worker for every release too. Either signal shows the bar.
 *
 * WHY THE UPDATE IS OFFERED AND NEVER TAKEN. A new build means new JavaScript
 * chunks. Swapping them under a technician half-way through a completion
 * write-up with the customer waiting is the failure PWA-7 forbids, so nothing
 * reloads until somebody taps Update now — once, and never on a timer, which
 * is also why no reload loop is possible.
 *
 * WHAT UPDATE NOW DOES. If the screen holds typed work that is not saved
 * (`useUnsavedWork`), it first says what would be lost and asks. Then it
 * installs the new release's worker, tells it to take over, and reloads when
 * it has; if the browser has no worker, or the worker is slow, it reloads
 * anyway — the HTML is never cached, so a reload always gets the release the
 * server runs. The page that comes back checks that it IS that release and
 * says so once ("EJE has been updated"), or says the update did not take
 * effect; it never retries by itself.
 *
 * AND THE OFFER WAITS FOR A CAPTURE. *Amended for the tablet usability pass.*
 * This bar is `sticky top-0` and APPEARING pushes everything below it down —
 * on a tablet that is the signature pad sliding out from under a stylus. So
 * while a capture holds the lock the bar renders nothing, and appears the
 * moment the capture is finished.
 *
 * BROWSERS WITHOUT SERVICE WORKERS still get the bar (the version check is a
 * plain request) and Update now is a reload; no error, no degraded screen.
 */
export const ServiceWorkerManager = () => {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  // The release "Not now" was said to ('worker' for a waiting worker of an unstamped build).
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AttemptOutcome>({ kind: 'none' });
  const [confirming, setConfirming] = useState(false);
  const [updating, setUpdating] = useState(false);
  const lastCheck = useRef(0);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  const enabled = process.env.NODE_ENV === 'production' && typeof window !== 'undefined';

  /** Switch on a waiting worker that belongs to the release already on screen; otherwise offer it. */
  const consider = useCallback((worker: ServiceWorker | null) => {
    if (worker === null) return;
    if (mayActivateQuietly(PAGE_BUILD, worker.scriptURL) && !captureInProgress()) {
      worker.postMessage({ type: 'EJE_SKIP_WAITING' });
      return;
    }
    setWaiting(worker);
  }, []);

  const check = useCallback(async (force = false) => {
    const now = Date.now();
    if (!force && now - lastCheck.current < MIN_CHECK_GAP_MS) return;
    lastCheck.current = now;
    try {
      const response = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
      const build = serverBuildOf(await response.json());
      // A failed read (offline, mid-release restart) keeps what was known.
      if (build !== null) setServerBuild(build);
    } catch {
      // Offline. The next check will ask again.
    }
    registrationRef.current?.update().catch(() => undefined);
    // A "Not now" that has run out lets the bar back.
    setDismissed((current) => (current !== null && current !== 'worker' && !isDismissed(session(), current, now) ? null : current));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    // Read once, when the page starts: is this the release Update now asked for?
    const after = outcomeAfterReload(session(), PAGE_BUILD);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from sessionStorage when the page starts
    setOutcome(after);

    let cancelled = false;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register(workerUrl(PAGE_BUILD), { scope: '/', updateViaCache: 'none' })
        .then((registration) => {
          if (cancelled) return;
          registrationRef.current = registration;
          consider(registration.waiting);
          registration.addEventListener('updatefound', () => {
            const installing = registration.installing;
            if (installing === null) return;
            installing.addEventListener('statechange', () => {
              // `controller` is null on the very first install — that is this
              // page getting a worker for the first time, not an update.
              if (installing.state === 'installed' && navigator.serviceWorker.controller !== null) consider(installing);
            });
          });
        })
        .catch(() => {
          // A refused registration is not a fault the technician can act on;
          // the version check below still offers updates.
        });
    }

    void check(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const onOnline = () => void check();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void check(true);
    }, VERSION_POLL_MS);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(timer);
    };
  }, [enabled, check, consider]);

  // The server went back to this page's build (a rollback): an attempt to leave it no longer applies.
  useEffect(() => {
    if (serverBuild === PAGE_BUILD && outcome.kind === 'not-applied') {
      forgetAttempt(session());
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a notice the server's answer made obsolete
      setOutcome({ kind: 'none' });
    }
  }, [serverBuild, outcome.kind]);

  const waitingBuild = waiting === null ? null : buildOfWorkerUrl(waiting.scriptURL);
  const target = isNewRelease(PAGE_BUILD, serverBuild) ? serverBuild : waiting !== null && waitingBuild !== PAGE_BUILD ? waitingBuild : null;
  const offered = target !== null || (waiting !== null && waitingBuild === null);

  // "Not now", said on another page of this tab within the hour, still holds.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reading a dismissal kept in sessionStorage
    if (target !== null && isDismissed(session(), target, Date.now())) setDismissed(target);
  }, [target]);

  const update = useCallback(async () => {
    setConfirming(false);
    setUpdating(true);
    recordAttempt(session(), PAGE_BUILD, target ?? 'unknown', Date.now());
    let reloaded = false;
    const reload = () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    };
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller !== null) {
        let worker: ServiceWorker | null = waiting !== null && (target === null || waitingBuild === target) ? waiting : null;
        if (worker === null && isKnownBuild(target)) {
          const registration = await navigator.serviceWorker.register(workerUrl(target), { scope: '/', updateViaCache: 'none' });
          worker = await waitForInstalled(registration, target, WORKER_WAIT_MS);
        }
        if (worker !== null) {
          // The new worker takes control, and the reload picks up its release.
          navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
          worker.postMessage({ type: 'EJE_SKIP_WAITING' });
          window.setTimeout(reload, 5000);
          return;
        }
      }
    } catch {
      // Whatever the worker did, the reload below still gets the new release.
    }
    reload();
  }, [target, waiting, waitingBuild]);

  const askToUpdate = useCallback(() => {
    if (hasUnsavedWork()) setConfirming(true);
    else void update();
  }, [update]);

  const capturing = useSyncExternalStore(subscribeToCapture, captureInProgress, captureIdleOnServer);

  const notice =
    outcome.kind === 'updated' ? (
      <div
        role="status"
        className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b border-verdant-200 bg-verdant-50 px-4 py-2 text-sm text-verdant-700"
        data-testid="app-updated"
        data-build={PAGE_BUILD}
      >
        <p>
          <strong className="font-semibold">EJE has been updated.</strong> You are now on version{' '}
          <span className="font-mono">{PAGE_BUILD}</span>.
        </p>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOutcome({ kind: 'none' })}>
          OK
        </Button>
      </div>
    ) : null;

  const hidden = !offered || capturing || (dismissed !== null && dismissed === (target ?? 'worker'));
  if (hidden) return notice;

  return (
    <>
      <div
        role="alert"
        className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-3 border-b-2 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-600 dark:bg-amber-950/60 dark:text-amber-100"
        data-testid="app-update-available"
        data-current={PAGE_BUILD}
        data-target={target ?? ''}
      >
        <div className="min-w-0">
          <p className="text-base font-semibold">A new version of EJE is available.</p>
          <p>
            {target !== null ? (
              <>
                Version <span className="font-mono">{target}</span> is live; this screen is still version{' '}
                <span className="font-mono">{PAGE_BUILD}</span>.{' '}
              </>
            ) : null}
            Update now reloads EJE on the new version. Anything already saved is kept.
          </p>
          {outcome.kind === 'not-applied' && outcome.to === target && (
            <p className="mt-1 font-medium" data-testid="app-update-not-applied">
              The last update did not take effect{outcome.tries > 1 ? ` (tried ${outcome.tries} times)` : ''}. If this keeps
              happening, close EJE completely and open it again.
            </p>
          )}
        </div>
        <span className="flex shrink-0 gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              if (target !== null) dismissRelease(session(), target, Date.now());
              setDismissed(target ?? 'worker');
            }}
            data-testid="app-update-later"
          >
            Not now
          </Button>
          <Button type="button" loading={updating} onClick={askToUpdate} data-testid="app-update-now">
            Update now
          </Button>
        </span>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Update with unsaved work on this screen?"
        message={`Updating reloads EJE, and this is not saved yet: ${unsavedWork().join('; ')}. Save or finish it first, or update anyway and lose it.`}
        confirmLabel="Update anyway"
        busy={updating}
        onConfirm={() => void update()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
};
