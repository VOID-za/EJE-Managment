import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE UPDATE NOTICE IS PART OF EVERY RELEASE. REL-UPD-1 (30 October 2026).
 *
 * The owner's instruction: the "new version — Update now" notice must come
 * with every production release, and no release may silently skip it. It
 * depends on a chain of facts spread over six files; each link is pinned here,
 * so breaking any one of them fails `npm test` rather than a tablet quietly
 * keeping an old version. The behaviour itself is proved in a browser across
 * two real builds by `scripts/update-check.mjs` (CI: "Update notice across two
 * releases"), and the release tool checks the live site after every release.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');

describe('every release carries a version an installed app can detect', () => {
  it('the build is stamped with its commit, and the release script builds with the commit it releases', () => {
    expect(read('next.config.ts')).toMatch(/EJE_BUILD_COMMIT: buildCommit\(\)/u);
    expect(read('deploy/release/deploy-release.sh')).toMatch(/--setenv=EJE_BUILD_COMMIT="\$SHORT"/u);
  });

  it('the page carries its build, and /api/health reports the server build', () => {
    expect(read('src/app/layout.tsx')).toMatch(/<meta name="eje-build-commit" content=\{process\.env\.EJE_BUILD_COMMIT/u);
    expect(read('src/app/layout.tsx')).toMatch(/<ServiceWorkerManager \/>/u);
    expect(read('src/app/api/health/route.ts')).toMatch(/commit: process\.env\.EJE_BUILD_COMMIT/u);
  });

  it('the running page compares its build with the server, and registers the worker under its build', () => {
    const manager = read('src/components/pwa/ServiceWorkerManager.tsx');
    expect(manager).toMatch(/const PAGE_BUILD = process\.env\.EJE_BUILD_COMMIT/u);
    expect(manager).toMatch(/\.register\(workerUrl\(PAGE_BUILD\)/u);
    expect(manager).toMatch(/fetch\('\/api\/health', \{ cache: 'no-store'/u);
    expect(manager).toMatch(/isNewRelease\(PAGE_BUILD, serverBuild\)/u);
    expect(manager).toMatch(/A new version of EJE is available\./u);
    expect(manager).toMatch(/Update now/u);
    // Checked again on returning to the screen, on reconnecting, and on a timer.
    expect(manager).toMatch(/addEventListener\('visibilitychange'/u);
    expect(manager).toMatch(/addEventListener\('online'/u);
    expect(manager).toMatch(/setInterval\(/u);
  });

  it('the worker can be told to take over, and is never served from a cache', () => {
    expect(read('public/eje-sw.js')).toMatch(/EJE_SKIP_WAITING/u);
    expect(read('next.config.ts')).toMatch(/source: '\/eje-sw\.js',[\s\S]*?no-cache, no-store, must-revalidate/u);
  });

  it('CI proves it across two builds, and the release tool checks the live site after every release', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/Update notice across two releases/u);
    expect(ci).toMatch(/node scripts\/update-check\.mjs/u);
    const stage = read('deploy/release/stage-release.ps1');
    expect(stage).toMatch(/if \(UpdateNoticeReady \$short\)/u);
    expect(stage).toMatch(/name=`"eje-build-commit`" content=`"\$Build`"/u);
  });
});
