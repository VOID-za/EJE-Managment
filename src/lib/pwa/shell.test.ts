import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_CACHE,
  staticAssetUrls,
  CACHEABLE_PATHS,
  CACHEABLE_PREFIXES,
  CACHE_PREFIX,
  CACHE_VERSION,
  NEVER_CACHE_PREFIXES,
  OFFLINE_PATH,
  PRECACHE_PATHS,
  SHELL_CACHE,
  isCacheablePath,
  staleCaches,
} from './shell';

/**
 * WHAT THE TABLET IS ALLOWED TO KEEP IN THE CACHE API. PWA-5.
 *
 * A caching mistake here is not a performance regression, it is a customer's
 * job card left on a shared tablet: the Cache API is readable by any script on
 * this origin and it outlives a sign-out. So the denylist is tested first and
 * tested hardest, with the real paths this application serves.
 */
const serviceWorkerSource = readFileSync(
  join(process.cwd(), 'public', 'eje-sw.js'),
  'utf8',
);

describe('what may be cached', () => {
  it('keeps the build’s own content-hashed chunks', () => {
    expect(isCacheablePath('/_next/static/chunks/main-8f1c2d.js')).toBe(true);
    expect(isCacheablePath('/_next/static/css/a1b2c3.css')).toBe(true);
  });

  it('keeps the installed application’s own furniture', () => {
    expect(isCacheablePath('/icons/icon-192.png')).toBe(true);
    expect(isCacheablePath('/manifest.webmanifest')).toBe(true);
    expect(isCacheablePath(OFFLINE_PATH)).toBe(true);
  });

  /* -- the refusals, which are the point ----------------------------------- */

  it('NEVER caches an authenticated API read', () => {
    expect(isCacheablePath('/api/jobs')).toBe(false);
    expect(isCacheablePath('/api/jobs/EJE-1042')).toBe(false);
    expect(isCacheablePath('/api/auth/me')).toBe(false);
    expect(isCacheablePath('/api/auth/sign_in')).toBe(false);
  });

  it('NEVER caches a document, a signature, a PDF or a photograph', () => {
    expect(isCacheablePath('/api/jobs/job-1/attachments/att-1')).toBe(false);
    expect(isCacheablePath('/api/jobs/job-1/media/att-1')).toBe(false);
    expect(isCacheablePath('/api/jobs/EJE-1042/final_document')).toBe(false);
  });

  it('NEVER caches an application page, because every page is somebody’s data', () => {
    expect(isCacheablePath('/jobs')).toBe(false);
    expect(isCacheablePath('/jobs/EJE-1042')).toBe(false);
    expect(isCacheablePath('/')).toBe(false);
    expect(isCacheablePath('/sign-in')).toBe(false);
  });

  it('NEVER caches the worker itself, so a stale worker cannot serve itself', () => {
    expect(isCacheablePath('/eje-sw.js')).toBe(false);
  });

  it('refuses a path that merely looks cacheable', () => {
    // The prefix is anchored: a route of our own that starts with the same
    // letters is not static.
    expect(isCacheablePath('/_next/image?url=%2Fapi%2Fjobs')).toBe(false);
    expect(isCacheablePath('/iconsmith/logo.png')).toBe(false);
  });

  it('puts the denylist first, so an overlap cannot be cached by accident', () => {
    // A hypothetical `/api/icons/…` matches no allowlist entry today; the
    // ordering is what keeps that true if one is ever added.
    expect(isCacheablePath('/api/icons/icon-192.png')).toBe(false);
  });
});

describe('the chunks the offline page needs with it', () => {
  /*
   * A cached document whose JavaScript is not cached renders as an empty
   * frame, which reads as a broken application rather than as a tablet with no
   * signal. The URLs carry a build hash, so they are read off the page.
   */
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/_next/static/css/4ac1f2.css"/>
    </head><body><script src="/_next/static/chunks/main-app-77bd.js"></script>
    <script src="/_next/static/chunks/app/offline/page-19ab.js"></script>
    <script src="/_next/static/chunks/main-app-77bd.js"></script>
    </body></html>`;

  it('finds the page’s own stylesheet and chunks, once each', () => {
    expect(staticAssetUrls(html)).toEqual([
      '/_next/static/css/4ac1f2.css',
      '/_next/static/chunks/main-app-77bd.js',
      '/_next/static/chunks/app/offline/page-19ab.js',
    ]);
  });

  it('takes nothing that is not a script or a stylesheet under /_next/static/', () => {
    const noisy = `<img src="/uploads/photo.jpg"><script src="/api/jobs"></script>
      <a href="/jobs/EJE-1042">job</a><script src="/_next/static/chunks/x.js.map"></script>`;
    expect(staticAssetUrls(noisy)).toEqual([]);
  });

  it('cannot be used to get round the denylist', () => {
    // Even if a document somehow referenced one, the allowlist is applied to
    // every match before it is fetched.
    expect(staticAssetUrls('<script src="/api/_next/static/chunks/x.js"></script>')).toEqual([]);
  });

  it('finds nothing in a page with no assets, rather than failing', () => {
    expect(staticAssetUrls('<html></html>')).toEqual([]);
  });
});

describe('clearing out an older version', () => {
  it('deletes our own stale caches and nothing else', () => {
    const names = [
      SHELL_CACHE,
      ASSET_CACHE,
      'eje-shell-v0',
      'eje-assets-v0',
      'workbox-precache',
      'some-other-app',
    ];
    expect(staleCaches(names)).toEqual(['eje-shell-v0', 'eje-assets-v0']);
  });

  it('leaves the current version alone', () => {
    expect(staleCaches([SHELL_CACHE, ASSET_CACHE])).toEqual([]);
  });

  it('names every cache with the one prefix the sweep looks for', () => {
    expect(SHELL_CACHE.startsWith(CACHE_PREFIX)).toBe(true);
    expect(ASSET_CACHE.startsWith(CACHE_PREFIX)).toBe(true);
  });
});

/**
 * THE DRIFT TEST.
 *
 * `public/eje-sw.js` is a static file and cannot import the module above, so it
 * repeats these values literally. That is a duplication with a real failure
 * mode — somebody tightens the rule in TypeScript, the worker keeps the old
 * one, and the tightening never reaches a single tablet. This reads the worker
 * and holds it to the module.
 */
describe('the worker and the rules it is supposed to obey', () => {
  it('uses the same cache names and version', () => {
    expect(serviceWorkerSource).toContain(`const CACHE_VERSION = '${CACHE_VERSION}'`);
    expect(serviceWorkerSource).toContain('const SHELL_CACHE = `eje-shell-${CACHE_VERSION}`');
    expect(serviceWorkerSource).toContain('const ASSET_CACHE = `eje-assets-${CACHE_VERSION}`');
    expect(serviceWorkerSource).toContain(`const CACHE_PREFIX = '${CACHE_PREFIX}'`);
  });

  it('carries the same allowlist and the same denylist', () => {
    const literal = (values: readonly string[]) =>
      `[${values.map((value) => `'${value}'`).join(', ')}]`;

    expect(serviceWorkerSource).toContain(`const CACHEABLE_PREFIXES = ${literal(CACHEABLE_PREFIXES)}`);
    expect(serviceWorkerSource).toContain(
      `const NEVER_CACHE_PREFIXES = ${literal(NEVER_CACHE_PREFIXES)}`,
    );
    // The offline path appears by its constant in both lists.
    expect(serviceWorkerSource).toContain(`const OFFLINE_PATH = '${OFFLINE_PATH}'`);
    expect(CACHEABLE_PATHS).toContain(OFFLINE_PATH);
    expect(serviceWorkerSource).toContain(
      `const CACHEABLE_PATHS = [OFFLINE_PATH, '/manifest.webmanifest']`,
    );
    expect(serviceWorkerSource).toContain(
      `const PRECACHE_PATHS = [OFFLINE_PATH, ${PRECACHE_PATHS.slice(1)
        .map((path) => `'${path}'`)
        .join(', ')}]`,
    );
  });

  it('answers only GET, and only this origin', () => {
    expect(serviceWorkerSource).toContain("if (request.method !== 'GET') return;");
    expect(serviceWorkerSource).toContain('if (url.origin !== self.location.origin) return;');
  });

  it('checks the denylist before anything else in the fetch handler', () => {
    const fetchHandler = serviceWorkerSource.slice(
      serviceWorkerSource.indexOf("addEventListener('fetch'"),
    );
    const denied = fetchHandler.indexOf('NEVER_CACHE_PREFIXES');
    const cacheable = fetchHandler.indexOf('isCacheablePath(url.pathname)');
    expect(denied).toBeGreaterThan(-1);
    expect(denied).toBeLessThan(cacheable);
  });

  it('warms the offline page’s own chunks, by the same rule', () => {
    expect(serviceWorkerSource).toContain('const staticAssetUrls = (html) => {');
    expect(serviceWorkerSource).toContain('.filter((path) => isCacheablePath(path))');
    expect(serviceWorkerSource).toContain('staticAssetUrls(await stored.text())');
  });

  it('serves a failed navigation the offline page and never a cached document', () => {
    expect(serviceWorkerSource).toContain("request.mode === 'navigate'");
    expect(serviceWorkerSource).toContain('caches.match(OFFLINE_PATH)');
  });

  /*
   * PHASE 3 HAS NO MUTATION QUEUE, and this is the test that keeps it that way.
   * A background sync registration or a stored POST would be the silent
   * overwrite CR-02 forbids, arriving by the back door rather than by a scoped
   * decision. Phase 4 may add one; it may not appear here quietly first.
   */
  it('registers no background sync and queues no write', () => {
    expect(serviceWorkerSource).not.toContain("addEventListener('sync'");
    expect(serviceWorkerSource).not.toContain("addEventListener('periodicsync'");
    expect(serviceWorkerSource).not.toContain('SyncManager');
    expect(serviceWorkerSource).not.toMatch(/method:\s*'POST'/u);
    expect(serviceWorkerSource).not.toContain('indexedDB');
  });

  it('does not take over mid-capture: no unconditional skipWaiting', () => {
    // The only `skipWaiting()` is inside the message handler the update prompt
    // calls once the technician has said now is a good moment. PWA-7.
    const occurrences = serviceWorkerSource.match(/self\.skipWaiting\(\)/gu) ?? [];
    expect(occurrences).toHaveLength(1);
    const handler = serviceWorkerSource.slice(
      serviceWorkerSource.indexOf("addEventListener('message'"),
    );
    expect(handler).toContain('skipWaiting()');
    expect(handler).toContain('EJE_SKIP_WAITING');
  });
});
