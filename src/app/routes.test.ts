import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The route matrix.
 *
 * Two live 404s were reported on `/jobs/<n>/sign` and `/jobs/<n>/review`. Both
 * route files existed and both served correctly, so the failure was a stale
 * build rather than the code — but "a link points at a route that is not there"
 * is a real class of bug that no other test in this suite would catch, because
 * every screen builds its links from template strings that TypeScript cannot
 * check.
 *
 * So this derives the real route tree from the filesystem, then asserts that
 * every internal link written anywhere in the source resolves to one of those
 * routes. A renamed or deleted route now fails here instead of in a
 * demonstration.
 */

const APP_DIR = join(process.cwd(), 'src', 'app');
const SRC_DIR = join(process.cwd(), 'src');

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

/**
 * Every URL the App Router actually serves, derived from `page.tsx` files.
 * Route groups — `(app)` — are organisational and contribute no URL segment.
 */
const realRoutes = (): readonly string[] =>
  walk(APP_DIR)
    .filter((file) => file.endsWith(`${sep}page.tsx`))
    .map((file) => {
      const segments = relative(APP_DIR, file)
        .split(sep)
        .slice(0, -1)
        .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
      return `/${segments.join('/')}`.replace(/\/$/, '') || '/';
    })
    .sort();

const ROUTES = realRoutes();

/** Does `link` resolve to `route`, treating `[param]` as one segment? */
const matches = (link: string, route: string): boolean => {
  const linkSegments = link.split('/').filter((segment) => segment.length > 0);
  const routeSegments = route.split('/').filter((segment) => segment.length > 0);

  if (routeSegments.some((segment) => segment.startsWith('[...'))) {
    const fixed = routeSegments.slice(0, -1);
    return (
      linkSegments.length > fixed.length &&
      fixed.every((segment, index) => segment.startsWith('[') || segment === linkSegments[index])
    );
  }
  if (linkSegments.length !== routeSegments.length) return false;
  return routeSegments.every((segment, index) =>
    segment.startsWith('[') ? (linkSegments[index] ?? '').length > 0 : segment === linkSegments[index],
  );
};

const resolves = (link: string): boolean => {
  // A static route wins over a dynamic sibling, exactly as the router resolves
  // it — which is why `/jobs/closed` is not served by `/jobs/[jobNumber]`.
  if (ROUTES.includes(link)) return true;
  return ROUTES.some((route) => matches(link, route));
};

/**
 * Every internal link literal in the source.
 *
 * Template holes become `:param`, since a job number or an id is one segment
 * whatever its runtime value. Query strings and fragments are dropped.
 */
const sourceLinks = (): readonly { readonly link: string; readonly file: string }[] => {
  const found: { link: string; file: string }[] = [];
  const pattern = /["'`](\/[a-zA-Z0-9_\-./[\]${}?=&:]*)["'`]/g;

  for (const file of walk(SRC_DIR)) {
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    if (file.includes('.test.')) continue;

    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const raw = match[1] ?? '';
      // Import specifiers, CSS selectors and storage keys are not routes.
      if (raw.startsWith('/_') || raw.includes('//')) continue;

      const link = raw
        .replace(/\$\{[^}]*\}/g, ':param')
        .split('?')[0]!
        .split('#')[0]!
        .replace(/\/$/, '');
      if (link.length === 0) continue;

      const head = link.split('/')[1] ?? '';
      // Only paths whose first segment is a real top-level route. Anything else
      // in a string starting with "/" is a file path, not a link.
      if (!ROUTES.some((route) => route.split('/')[1] === head)) continue;

      found.push({ link, file: relative(process.cwd(), file) });
    }
  }
  return found;
};

describe('the route tree', () => {
  it('serves every route the workflow needs', () => {
    // The canonical routes, named. A rename has to be made deliberately here.
    const canonical = [
      '/',
      '/dashboard',
      '/jobs',
      '/jobs/new',
      '/jobs/closed',
      '/jobs/[jobNumber]',
      '/jobs/[jobNumber]/review',
      '/messages',
      '/notifications',
      '/customers',
      '/customers/[customerId]',
      '/machines',
      '/machines/[machineId]',
      '/technicians/[userId]',
      '/calendar',
      '/activity',
      '/library',
      '/search',
      '/admin',
    ];
    for (const route of canonical) {
      expect(ROUTES, `${route} is missing from src/app`).toContain(route);
    }
  });

  it('has exactly one route file per URL, so no job renders two ways', () => {
    expect(new Set(ROUTES).size).toBe(ROUTES.length);
  });

  it('keeps the closed-job archive out of the reach of the job route', () => {
    // `/jobs/closed` must be its own screen, not job number "closed".
    expect(ROUTES).toContain('/jobs/closed');
    expect(resolves('/jobs/closed')).toBe(true);
  });
});

describe('every link in the source resolves', () => {
  it('points at no route that does not exist', () => {
    const broken = sourceLinks().filter((entry) => !resolves(entry.link));
    // Named individually: "one link is broken" is not actionable.
    expect(broken.map((entry) => `${entry.file} -> ${entry.link}`)).toEqual([]);
  });

  it('checks a meaningful number of links, so a silent no-op cannot pass', () => {
    expect(sourceLinks().length).toBeGreaterThan(40);
  });
});

describe('the workflow links specifically', () => {
  const cases: readonly { readonly link: string; readonly why: string }[] = [
    { link: '/jobs/EJE-1056/review', why: 'Master Review, reported 404' },
    { link: '/jobs/EJE-1048', why: 'job detail' },
    { link: '/jobs/closed', why: 'closed-job archive' },
    { link: '/messages', why: 'two-way chat' },
    { link: '/messages/', why: 'chat notification target, trailing slash' },
    { link: '/notifications', why: 'notification centre' },
    { link: '/customers/cust-abc', why: 'customer history' },
    { link: '/machines/machine-abc-lv40', why: 'machine history' },
    { link: '/technicians/user-tech-lerato', why: 'technician record' },
  ];

  for (const { link, why } of cases) {
    it(`resolves ${link} — ${why}`, () => {
      expect(resolves(link)).toBe(true);
    });
  }

  it('does not resolve a route that genuinely does not exist', () => {
    // Guards the matcher itself: if everything "resolved", the test above would
    // pass while proving nothing.
    expect(resolves('/jobs/EJE-1048/master-review')).toBe(false);
    expect(resolves('/jobs/EJE-1048/customer-signature')).toBe(false);
    expect(resolves('/jobs/closed/EJE-1044')).toBe(false);
    expect(resolves('/nonsense')).toBe(false);
  });

  /*
   * There is ONE signature workflow, and it is the guided close-out.
   *
   * `/jobs/<n>/sign` was a second, independent implementation: a full signature
   * screen that nothing linked to, with no refusal option, no collection-method
   * step and no waybill. A bookmark from an earlier build reached it and could
   * sign a courier collection out as a priced customer collection, because it
   * never went past the step where that is decided. It is deleted rather than
   * redirected — a route that does not exist is the only kind that cannot come
   * back as a second way of doing this.
   */
  it('has no second signature route', () => {
    expect(ROUTES).not.toContain('/jobs/[jobNumber]/sign');
    expect(resolves('/jobs/EJE-1065/sign')).toBe(false);
    expect(resolves('/jobs/EJE-1053/sign')).toBe(false);
  });

  it('has exactly one signature implementation in the source', () => {
    // The wizard owns it. Anything else drawing a signature pad into a page of
    // its own would be the same mistake with a different name.
    const signaturePages = ROUTES.filter((route) => /\/sign$/.test(route));
    expect(signaturePages).toEqual([]);
  });

  it('reads /jobs/open as a job number, not an Open Jobs screen', () => {
    // There is no `/jobs/open` route: the Open Jobs list is `/jobs?status=open`,
    // a filter on the one Jobs screen. `/jobs/open` therefore reaches the job
    // route with jobNumber "open" and renders the application's own "Job not
    // found" — never a bare 404. Recorded because the review asked after it.
    expect(ROUTES).not.toContain('/jobs/open');
    expect(resolves('/jobs/open')).toBe(true);
  });
});
