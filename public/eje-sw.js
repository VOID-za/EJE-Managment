/*
 * EJE JOB CARD MANAGEMENT — SERVICE WORKER. PWA-5, PWA-7, CR-09 Phase 3.
 *
 * THE RULES THIS FILE OBEYS ARE WRITTEN DOWN IN `src/lib/pwa/shell.ts`, and
 * `shell.test.ts` reads this file to prove the two still agree. A service
 * worker cannot import from the bundle, so the values are repeated here
 * literally rather than shared — and the test is what stops that becoming a
 * lie.
 *
 * WHAT IT CACHES: the build's own static chunks, the icons, the manifest and
 * the offline page. That is the whole list.
 *
 * WHAT IT NEVER CACHES, AND WHY THE CHECK IS FIRST: anything under `/api/`,
 * any method other than GET, anything cross-origin, and any HTML document.
 * The Cache API is readable by any script on this origin and it outlives a
 * sign-out, so a cached job card is a customer's document left on a shared
 * tablet. What a technician reads offline lives in IndexedDB instead, scoped
 * to one signed-in user and cleared when they leave.
 *
 * WHAT IT IS NOT: there is no mutation queue here, no Background Sync
 * registration, no replay and no conflict handling. Capturing work offline is
 * Phase 4 and may not be built until that phase is scoped — a worker that
 * quietly retried a POST would be exactly the silent overwrite CR-02 forbids.
 */

// v2 (29 October 2026): the icons changed to the application's own EJE mark.
//
// 30 October 2026 (REL-UPD-1): this file is now registered as
// `/eje-sw.js?build=<commit>`, so every release installs a new worker without
// this file changing. These lines are also the one change that lets a tablet
// still running the release before that (which registered plain `/eje-sw.js`)
// notice this release: its browser sees new bytes here.
const CACHE_VERSION = 'v3';
const SHELL_CACHE = `eje-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `eje-assets-${CACHE_VERSION}`;
const CACHE_PREFIX = 'eje-';
const OFFLINE_PATH = '/offline';

const PRECACHE_PATHS = [OFFLINE_PATH, '/icons/icon-192.png', '/icons/icon-512.png', '/vendor/pdfjs-4.10.38/pdf.min.mjs', '/vendor/pdfjs-4.10.38/pdf.worker.min.mjs'];
const CACHEABLE_PREFIXES = ['/_next/static/', '/icons/', '/vendor/pdfjs-4.10.38/'];
const CACHEABLE_PATHS = [OFFLINE_PATH, '/manifest.webmanifest'];
const NEVER_CACHE_PREFIXES = ['/api/', '/eje-sw.js'];

const isCacheablePath = (pathname) => {
  if (NEVER_CACHE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  if (CACHEABLE_PATHS.includes(pathname)) return true;
  return CACHEABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
};

const staticAssetUrls = (html) => {
  // Anchored on the attribute's quotes, so a match is a whole URL and not a
  // substring of one — see `shell.ts`, which this mirrors.
  const found = Array.from(
    html.matchAll(/["'(](\/_next\/static\/[A-Za-z0-9._/-]+\.(?:js|css))["')]/g),
    (match) => match[1] || '',
  );
  return Array.from(new Set(found)).filter((path) => isCacheablePath(path));
};

/*
 * INSTALL — fetch the few fixed things, and WAIT.
 *
 * No `skipWaiting()` here. A new worker that took over immediately would swap
 * the application's chunks underneath a technician who is part-way through
 * capturing a job card. It waits until every tab is closed, or until the page
 * asks for it — see the message handler below, which is what the update
 * prompt calls once the technician says now is a good moment. PWA-7.
 */
const precacheShell = async () => {
  const shell = await caches.open(SHELL_CACHE);
  // `reload` so an install never re-stores whatever the HTTP cache happens to
  // be holding from a previous build.
  await shell.addAll(PRECACHE_PATHS.map((path) => new Request(path, { cache: 'reload' })));

  /*
   * AND THE OFFLINE PAGE'S OWN CHUNKS, or the page renders as an empty frame.
   *
   * Its script URLs carry this build's hash, so they are read out of the HTML
   * that was just stored rather than listed here. Each one is fetched on its
   * own and a failure is tolerated: a missing chunk is a degraded offline page,
   * while a rejected install is NO service worker at all.
   */
  const stored = await shell.match(OFFLINE_PATH);
  if (stored === undefined) return;
  const assets = staticAssetUrls(await stored.text());
  const assetCache = await caches.open(ASSET_CACHE);
  await Promise.all(
    assets.map((path) =>
      assetCache.add(new Request(path, { cache: 'reload' })).catch(() => undefined),
    ),
  );
};

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
});

/* ACTIVATE — take every cache of ours from an older version away. */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX))
            .filter((name) => name !== SHELL_CACHE && name !== ASSET_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET, only this origin. A POST is a write and a write needs the
  // server; there is nothing here that could honestly answer one.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  /*
   * A DOCUMENT IS NEVER CACHED, AND NEVER SERVED FROM A CACHE.
   *
   * Every page of this application is rendered for one signed-in person and
   * carries their customer's data. The network answers it or the offline page
   * does — which says plainly that it is the offline page rather than
   * pretending to be the job.
   */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_PATH).then(
          (cached) =>
            cached ??
            new Response('Offline, and this device has no cached copy of the application.', {
              status: 503,
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            }),
        ),
      ),
    );
    return;
  }

  if (!isCacheablePath(url.pathname)) return;

  /*
   * Cache-first, for content-hashed files only.
   *
   * `/_next/static/…` URLs change whenever their bytes change, so a hit is
   * always the right bytes and never a stale version of them.
   */
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached !== undefined) return cached;
      return fetch(request).then((response) => {
        // Only a clean, complete, same-origin response is worth keeping. An
        // opaque or partial response cached here would be indistinguishable
        // from the real thing later.
        if (!response.ok || response.type !== 'basic') return response;
        const copy = response.clone();
        caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
        return response;
      });
    }),
  );
});

/*
 * The page asking for the waiting worker to take over. PWA-7.
 *
 * The only message this worker accepts, and it is sent by the update prompt
 * after the technician chooses to reload — never on a timer and never while a
 * capture is in flight.
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'EJE_SKIP_WAITING') self.skipWaiting();
});
