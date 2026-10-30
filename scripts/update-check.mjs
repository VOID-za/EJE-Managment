/**
 * THE UPDATE NOTICE, ACROSS TWO REAL RELEASES. REL-UPD-1 (30 October 2026).
 *
 * The owner's instruction: every production release shows installed EJE apps
 * "A new version of EJE is available" with Update now, and Update now really
 * puts them on the new version. A notice that only works after clearing the
 * cache is worth nothing, so this proves it the way a tablet meets it:
 *
 *   1. Release A (the build in `.next`) is served. A tablet-sized browser opens
 *      EJE; the service worker installs and takes control; no notice.
 *   2. Release A stops and release B (a second real build, in `.next-update`,
 *      stamped with a different commit) is served on the SAME address — which
 *      is what a production release is to a tablet that stays open.
 *   3. Without reloading or clearing anything, the open page notices: the
 *      notice appears, naming both versions, with Update now.
 *   4. Update now: the page reloads ONCE onto release B — its HTML says B, the
 *      worker in control is B's — and says "EJE has been updated", once. No
 *      further reload, no notice again, and a later check stays quiet.
 *   5. Unsaved work: on release B, a technician types a timesheet comment and
 *      the server then reports yet another build. (Reported by the browser's
 *      own request routing, not by restarting: the demonstration keeps its
 *      sign-ins in memory, so a restart here would sign the technician out —
 *      production keeps them in PostgreSQL. Steps 2–4 already proved the
 *      detection on real builds.) Update now ASKS first, naming what would be
 *      lost; Cancel keeps the page and the typing.
 *
 * Usage (after `npm run build`; builds B itself unless EJE_UPDATE_REUSE=1):
 *   npm run update-check
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { signInAs } from './sign-in.mjs';

const PORT = Number(process.env.EJE_UPDATE_PORT ?? 3299);
const BASE = `http://127.0.0.1:${PORT}`;
const DIST_A = '.next';
const DIST_B = '.next-update';
const shots = '.smoke/update-check';
mkdirSync(shots, { recursive: true });

const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(`${name} :: ${error.message.split('\n')[0]}`);
    console.log(`FAIL  ${name} :: ${error.message.split('\n')[0]}`);
  }
};

/** Next's own id for a build: two builds never share one. */
const buildIdOf = (dist) => readFileSync(`${dist}/BUILD_ID`, 'utf8').trim();

if (!existsSync(`${DIST_A}/BUILD_ID`)) throw new Error('Build release A first: npm run build');

// ---- release B: a second real build, stamped with a different commit ------------
const headA = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'unknown';
const COMMIT_B = `${process.env.EJE_BUILD_COMMIT ?? headA}-next`;
if (process.env.EJE_UPDATE_REUSE !== '1' || !existsSync(`${DIST_B}/BUILD_ID`)) {
  // `next build` rewrites these two for its distDir; they are put back exactly.
  const kept = ['tsconfig.json', 'next-env.d.ts'].map((file) => [file, readFileSync(file)]);
  console.log(`building release B (${COMMIT_B}) in ${DIST_B} …`);
  const built = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build'], {
    stdio: 'inherit',
    env: { ...process.env, EJE_DIST_DIR: DIST_B, EJE_BUILD_COMMIT: COMMIT_B },
  });
  for (const [file, bytes] of kept) writeFileSync(file, bytes);
  if (built.status !== 0) throw new Error('release B did not build');
}
if (buildIdOf(DIST_A) === buildIdOf(DIST_B)) throw new Error('the two builds are the same build');

// ---- serving one release at a time, on one address -----------------------------
let server = null;
const serve = async (dist) => {
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT), '-H', '127.0.0.1'], {
    env: { ...process.env, EJE_DIST_DIR: dist, EJE_PERSISTENCE: 'demo', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk; });
  server.stderr.on('data', (chunk) => { log += chunk; });
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const health = await (await fetch(`${BASE}/api/health`)).json();
      if (typeof health?.build?.commit === 'string') return health.build.commit;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`release in ${dist} did not start:\n${log.slice(-2000)}`);
};
const stop = async () => {
  if (server === null) return;
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
  server = null;
  // The port must be free before the next release takes it.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await fetch(`${BASE}/api/health`);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
// A rugged Android tablet, as far as a browser can be told one.
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 13; Rugged Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
let documentLoads = 0;
page.on('load', () => { documentLoads += 1; });

const pageBuild = () => page.evaluate(() => document.querySelector('meta[name="eje-build-commit"]')?.getAttribute('content') ?? null);
const controllerBuild = () =>
  page.evaluate(() => {
    const url = navigator.serviceWorker.controller?.scriptURL;
    return url === undefined ? null : new URL(url).searchParams.get('build');
  });
/** What a tablet does when EJE comes back to the screen. */
const returnToScreen = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const waitForNotice = async (timeout = 60000) => {
  const notice = page.getByTestId('app-update-available');
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await notice.isVisible().catch(() => false)) return notice;
    await returnToScreen();
    await page.waitForTimeout(2000);
  }
  throw new Error('the notice did not appear');
};

let A = null;
let B = null;
try {
  A = await serve(DIST_A);
  console.log(`release A is serving: ${A}`);

  await step('release A: the tablet opens EJE, the worker takes control under A’s build, and there is no notice', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null && navigator.serviceWorker?.controller !== undefined, null, { timeout: 30000 });
    if ((await pageBuild()) !== A) throw new Error(`the page says ${await pageBuild()}`);
    if ((await controllerBuild()) !== A) throw new Error(`the worker in control is ${await controllerBuild()}`);
    await page.waitForTimeout(1500);
    if (await page.getByTestId('app-update-available').isVisible()) throw new Error('a notice with nothing new');
  });

  await stop();
  B = await serve(DIST_B);
  console.log(`release B is serving: ${B}`);
  if (A === B) throw new Error('both releases report the same commit');

  await step('release B goes live: the open page notices WITHOUT a reload or a cache clear, and offers Update now', async () => {
    const loadsBefore = documentLoads;
    const notice = await waitForNotice();
    const text = await notice.innerText();
    if (!text.includes('A new version of EJE is available.')) throw new Error(`notice reads: ${text}`);
    if ((await notice.getAttribute('data-target')) !== B || (await notice.getAttribute('data-current')) !== A) {
      throw new Error(`notice says ${await notice.getAttribute('data-current')} → ${await notice.getAttribute('data-target')}`);
    }
    await notice.getByTestId('app-update-now').waitFor({ timeout: 5000 });
    if (documentLoads !== loadsBefore) throw new Error('the page reloaded by itself');
    await page.screenshot({ path: `${shots}/1-notice.png` });
  });

  await step('Update now puts the tablet on release B — page and worker — and says so once', async () => {
    const loadsBefore = documentLoads;
    await page.getByTestId('app-update-now').click();
    await page.waitForFunction((b) => document.querySelector('meta[name="eje-build-commit"]')?.getAttribute('content') === b, B, { timeout: 30000 });
    await page.waitForLoadState('networkidle');
    const updated = page.getByTestId('app-updated');
    await updated.waitFor({ timeout: 15000 });
    if ((await updated.getAttribute('data-build')) !== B) throw new Error(`updated notice says ${await updated.getAttribute('data-build')}`);
    if ((await controllerBuild()) !== B) throw new Error(`the worker in control is ${await controllerBuild()}, not ${B}`);
    await page.screenshot({ path: `${shots}/2-updated.png` });
    // No loop: one reload, and a later check stays quiet.
    await page.waitForTimeout(12000);
    await returnToScreen();
    await page.waitForTimeout(3000);
    if (documentLoads - loadsBefore !== 1) throw new Error(`${documentLoads - loadsBefore} reloads, expected exactly 1`);
    if (await page.getByTestId('app-update-available').isVisible()) throw new Error('the notice came back after updating');
  });

  await step('the "updated" confirmation is shown once, not on every visit', async () => {
    await page.getByTestId('app-updated').getByRole('button', { name: 'OK' }).click();
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    if (await page.getByTestId('app-updated').isVisible()) throw new Error('the confirmation was shown again');
    if (await page.getByTestId('app-update-available').isVisible()) throw new Error('a notice with nothing new');
  });

  await step('typed work is named and kept: Update now asks first, and Cancel keeps the page and the typing', async () => {
    await signInAs(page, 'Sipho Mahlangu', { base: BASE });
    await page.goto(`${BASE}/timesheets`, { waitUntil: 'networkidle' });
    const comment = page.getByTestId('timesheet-period-comment');
    await comment.waitFor({ timeout: 15000 });
    await comment.fill('Typed and not saved — must survive the update offer');
    await page.route('**/api/health', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, build: { ...body.build, commit: `${B}-later` } } });
    });
    const notice = await waitForNotice();
    const loadsBefore = documentLoads;
    await notice.getByTestId('app-update-now').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByText('Update with unsaved work on this screen?').waitFor({ timeout: 5000 });
    if (!(await dialog.innerText()).includes('a timesheet line or comment being typed')) throw new Error(`the dialog does not name the work: ${await dialog.innerText()}`);
    await page.screenshot({ path: `${shots}/3-unsaved.png` });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(2000);
    if (documentLoads !== loadsBefore) throw new Error('the page reloaded although Cancel was chosen');
    if ((await comment.inputValue()) !== 'Typed and not saved — must survive the update offer') throw new Error('the typing was lost');
    await page.unroute('**/api/health');
  });

  await step('no page errors throughout', async () => {
    if (pageErrors.length > 0) throw new Error(pageErrors.join(' | '));
  });
} finally {
  await browser.close();
  await stop();
}

console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILED`} — release A ${A}, release B ${B}`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
