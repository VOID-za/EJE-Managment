/**
 * WHAT THE SERVICE WORKER MAY AND MAY NOT KEEP. PWA-5, CR-09 Phase 3.
 *
 * The rules live here, in TypeScript that `npm test` can reach, because a
 * caching mistake in this application is a data-protection incident rather
 * than a performance regression. `public/eje-sw.js` is a plain static file —
 * a service worker cannot import a module from the bundle — so it carries the
 * same values literally, and `shell.test.ts` reads that file and refuses to
 * let the two drift apart.
 *
 * THE RULE, AND IT IS A DENYLIST FIRST.
 *
 * Nothing authenticated is ever written to the Cache API. Not an API response,
 * not a job page, not a signature, not a PDF, not a photograph, not a login.
 * The Cache API is readable by any script that runs on this origin and it
 * survives sign-out; a job card sitting in it is a customer's document left on
 * a shared tablet. What a technician reads offline comes from the IndexedDB
 * cache instead, which is scoped to one user and cleared when they sign out.
 *
 * So the only things kept are files that are identical for every user and
 * carry nothing about anybody:
 *
 *   - `/_next/static/…` — the build's own JavaScript and CSS. Content-hashed
 *     by Next, so a given URL's bytes never change and a cached chunk can
 *     never be the WRONG chunk. This is what makes the shell render without a
 *     network round trip.
 *   - `/icons/…` and the manifest — the installed application's own furniture.
 *   - `/offline` — a page with no server data in it at all, which is why it is
 *     safe to keep and why it is what a failed navigation gets.
 *
 * STALE CHUNKS, which is the failure that makes people distrust PWAs: HTML is
 * NEVER cached, so a browser with a connection always fetches the current
 * document, and that document asks for the chunk hashes of the current build.
 * Old hashes are only ever requested by old documents. The version below is
 * bumped when these rules change, and everything from an older version is
 * deleted on activation.
 */

/**
 * Bumped when the rules or the shell change — NOT on every deploy.
 *
 * Deploys are handled by the hashing described above. This exists so that a
 * change to what is cached cannot leave a browser serving yesterday's policy.
 */
// v2 (29 October 2026): the icons changed to the application's own EJE mark (PWA-1).
export const CACHE_VERSION = 'v2';

export const SHELL_CACHE = `eje-shell-${CACHE_VERSION}`;
export const ASSET_CACHE = `eje-assets-${CACHE_VERSION}`;

/** Every cache this application has ever owned is named like this. */
export const CACHE_PREFIX = 'eje-';

/** The page a failed navigation gets. Static, and holds nobody's data. */
export const OFFLINE_PATH = '/offline';

/**
 * Fetched and stored when the worker installs.
 *
 * Deliberately tiny. The build's chunks cannot be named here — their hashes
 * are decided at build time and this is a static file — so they are cached as
 * they are first used instead, which also means a device only keeps the parts
 * of the application it has actually opened.
 */
export const PRECACHE_PATHS: readonly string[] = [
  OFFLINE_PATH,
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/** Prefixes whose GET responses may be stored. Nothing else qualifies. */
export const CACHEABLE_PREFIXES: readonly string[] = ['/_next/static/', '/icons/'];

/** Exact paths that may be stored, beyond the prefixes above. */
export const CACHEABLE_PATHS: readonly string[] = [OFFLINE_PATH, '/manifest.webmanifest'];

/**
 * Prefixes that must NEVER reach a cache, whatever else matches.
 *
 * `/api/` covers every authenticated read and every write, including the
 * session endpoints and the attachment downloads. The worker file itself is
 * excluded so a stale worker can never serve itself.
 */
export const NEVER_CACHE_PREFIXES: readonly string[] = ['/api/', '/eje-sw.js'];

/** Whether a same-origin GET path may be written to the Cache API. */
export const isCacheablePath = (pathname: string): boolean => {
  if (NEVER_CACHE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  if (CACHEABLE_PATHS.includes(pathname)) return true;
  return CACHEABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
};

/**
 * THE CHUNKS THE OFFLINE PAGE ITSELF NEEDS. PWA-5.
 *
 * Precaching `/offline` alone is not enough, and the failure is a nasty one: a
 * cached document whose JavaScript is not cached renders as an empty frame,
 * which looks exactly like a broken application rather than a tablet with no
 * signal. Next names those files with a build hash, so a static worker cannot
 * list them — it reads them out of the page it has just fetched instead.
 *
 * Narrow on purpose: `/_next/static/…` only, and only `.js` and `.css`. A
 * source map or anything else that happens to appear in the markup is not
 * fetched, and the result is passed through `isCacheablePath` so this can
 * never become a way around the denylist.
 */
export const staticAssetUrls = (html: string): readonly string[] => {
  /*
   * Anchored on the quotes around the attribute, which is what makes this a
   * list of whole URLs rather than of substrings. Unanchored, the same pattern
   * finds `/_next/static/chunks/x.js` inside `/api/_next/static/chunks/x.js`
   * and inside `x.js.map` — a path that is not the one in the document.
   */
  const found = Array.from(
    html.matchAll(/["'(](\/_next\/static\/[A-Za-z0-9._/-]+\.(?:js|css))["')]/gu),
    (match) => match[1] ?? '',
  );
  return Array.from(new Set(found)).filter((path) => isCacheablePath(path));
};

/** Caches belonging to this application, from any version. */
export const isOwnCache = (name: string): boolean => name.startsWith(CACHE_PREFIX);

/** The caches this version uses. Everything else of ours is deleted. */
export const isCurrentCache = (name: string): boolean =>
  name === SHELL_CACHE || name === ASSET_CACHE;

/** Which of our caches are stale and should go at activation. */
export const staleCaches = (names: readonly string[]): readonly string[] =>
  names.filter((name) => isOwnCache(name) && !isCurrentCache(name));
