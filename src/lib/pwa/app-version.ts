/**
 * WHICH RELEASE IS RUNNING, WHICH IS DEPLOYED, AND THE UPDATE BETWEEN THEM.
 * PWA-7, amended 30 October 2026 (REL-UPD-1).
 *
 * THE DEFECT THIS REPLACES. The update bar appeared only when the bytes of
 * `/eje-sw.js` changed, and they changed only when somebody edited the file by
 * hand — so the release of 29 October showed it (the cache version was bumped)
 * and an ordinary release would have shown nothing: a tablet left open on the
 * old build kept running it with no word to anybody.
 *
 * NOW EVERY RELEASE IS A NEW VERSION, WITHOUT ANYBODY REMEMBERING:
 *
 *   - Every build carries its commit (`EJE_BUILD_COMMIT`, stamped by
 *     `next.config.ts`; the release script sets it to the commit it builds).
 *     The page has it in `<meta name="eje-build-commit">`; the server reports
 *     it at `/api/health`.
 *   - The worker is registered as `/eje-sw.js?build=<commit>`. A different
 *     script URL is a new worker to the browser, so every release installs
 *     one — whether or not the worker file itself changed.
 *   - A running page asks the server which build it serves: when it starts,
 *     when it comes back to the screen, when the connection returns, and every
 *     few minutes while it is shown. A different commit is a new release, and
 *     the bar says so with Update now.
 *
 * NOTHING HERE RELOADS BY ITSELF. Only a tap on Update now reloads, once, so
 * there is no path to a reload loop. What that tap was for is remembered for
 * the reload, so the page that comes back can say whether it is now the
 * release it was asked for — and say so once.
 *
 * Pure functions over strings and a `Storage`, so all of it is unit-tested
 * without a browser; `ServiceWorkerManager` wires it to one.
 */

/** How often a page that is on screen asks which build the server runs. */
export const VERSION_POLL_MS = 5 * 60 * 1000;

/** How long "Not now" holds the bar back for the same release. */
export const DISMISS_MS = 60 * 60 * 1000;

/** How long Update now waits for the new worker before reloading anyway. */
export const WORKER_WAIT_MS = 15 * 1000;

export const WORKER_PATH = '/eje-sw.js';

const ATTEMPT_KEY = 'eje-update-attempt';
const DISMISS_KEY = 'eje-update-dismissed';

/** A build that cannot say which commit it is (a tarball, no git) compares as nothing. */
export const isKnownBuild = (build: string | null | undefined): build is string =>
  typeof build === 'string' && build.length > 0 && build !== 'unknown';

/** The worker's URL for a build. Every release's differs, so every release installs a worker. */
export const workerUrl = (build: string): string =>
  isKnownBuild(build) ? `${WORKER_PATH}?build=${encodeURIComponent(build)}` : WORKER_PATH;

/** The build a worker was registered for, from its script URL; null for an older, unstamped worker. */
export const buildOfWorkerUrl = (scriptUrl: string | null | undefined): string | null => {
  if (typeof scriptUrl !== 'string' || scriptUrl.length === 0) return null;
  try {
    const build = new URL(scriptUrl, 'https://eje.invalid').searchParams.get('build');
    return isKnownBuild(build) ? build : null;
  } catch {
    return null;
  }
};

/** The server runs a different release from the one on screen. */
export const isNewRelease = (pageBuild: string | null | undefined, serverBuild: string | null | undefined): boolean =>
  isKnownBuild(pageBuild) && isKnownBuild(serverBuild) && pageBuild !== serverBuild;

/** The build `/api/health` reports, or null when it cannot be read (offline, a proxy page). */
export const serverBuildOf = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null;
  const build = (body as { build?: { commit?: unknown } }).build;
  const commit = build?.commit;
  return typeof commit === 'string' && isKnownBuild(commit) ? commit : null;
};

export interface UpdateAttempt {
  readonly from: string;
  readonly to: string;
  readonly at: number;
  /** How many times Update now was tapped for this same release without it taking effect. */
  readonly tries: number;
}

const readJson = <T>(storage: Storage | null, key: string): T | null => {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
};

const writeJson = (storage: Storage | null, key: string, value: unknown): void => {
  if (storage === null) return;
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage refused (private mode, full). The update still works; only the
    // "updated" confirmation after the reload is lost.
  }
};

/** Remember, for the page that comes back, what Update now was asked to do. */
export const recordAttempt = (storage: Storage | null, from: string, to: string, now: number): UpdateAttempt => {
  const previous = readJson<UpdateAttempt>(storage, ATTEMPT_KEY);
  const attempt: UpdateAttempt = { from, to, at: now, tries: previous !== null && previous.to === to ? previous.tries + 1 : 1 };
  writeJson(storage, ATTEMPT_KEY, attempt);
  return attempt;
};

export type AttemptOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'updated'; readonly from: string; readonly to: string }
  | { readonly kind: 'not-applied'; readonly to: string; readonly tries: number };

/**
 * After a reload: is this page the release Update now asked for?
 *
 * Read ONCE when the page starts. An "updated" answer is cleared as it is
 * read, so the confirmation is shown once and never again; a "not applied"
 * one is kept (with its count) so a second tap can say it is a second try.
 */
export const outcomeAfterReload = (storage: Storage | null, pageBuild: string): AttemptOutcome => {
  const attempt = readJson<UpdateAttempt>(storage, ATTEMPT_KEY);
  if (attempt === null) return { kind: 'none' };
  if (attempt.to === pageBuild) {
    writeJson(storage, ATTEMPT_KEY, null);
    writeJson(storage, DISMISS_KEY, null);
    return { kind: 'updated', from: attempt.from, to: attempt.to };
  }
  if (attempt.from === pageBuild) return { kind: 'not-applied', to: attempt.to, tries: attempt.tries };
  // Neither: the server moved on (or back) since. Nothing to say about it.
  writeJson(storage, ATTEMPT_KEY, null);
  return { kind: 'none' };
};

/** Clear a remembered attempt that no longer applies (the server went back to this build). */
export const forgetAttempt = (storage: Storage | null): void => writeJson(storage, ATTEMPT_KEY, null);

/** "Not now" for this release, for a while. A later release shows the bar again at once. */
export const dismissRelease = (storage: Storage | null, build: string, now: number): void =>
  writeJson(storage, DISMISS_KEY, { build, until: now + DISMISS_MS });

export const isDismissed = (storage: Storage | null, build: string, now: number): boolean => {
  const dismissed = readJson<{ build: string; until: number }>(storage, DISMISS_KEY);
  return dismissed !== null && dismissed.build === build && dismissed.until > now;
};

/**
 * A waiting worker that may be switched on without asking.
 *
 * When the page on screen is ALREADY the release the waiting worker belongs to
 * (the tablet opened the application after a release, and the old worker was
 * still in charge), activating it swaps nothing underneath anybody: the page's
 * chunks are already that release's. Anything else waits for Update now.
 */
export const mayActivateQuietly = (pageBuild: string, waitingScriptUrl: string | null | undefined): boolean =>
  isKnownBuild(pageBuild) && buildOfWorkerUrl(waitingScriptUrl) === pageBuild;
