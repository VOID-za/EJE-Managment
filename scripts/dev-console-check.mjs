/**
 * Development-mode console check.
 *
 * `npm run smoke` runs against a production build, where React strips its
 * development warnings — including "Cannot update a component while rendering a
 * different component". That class of bug is therefore invisible to it.
 *
 * This script drives the same flows against `next dev` and fails on any React
 * warning or error, so development-only diagnostics are caught in CI rather than
 * by whoever next runs the dev server.
 *
 * Usage:
 *   npm run dev -- -p 3500
 *   EJE_DEV_URL=http://localhost:3500 npm run dev-check
 */
import { chromium } from 'playwright';

const BASE = process.env.EJE_DEV_URL ?? 'http://localhost:3000';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;

const browser = await chromium.launch(
  executablePath === undefined ? {} : { executablePath },
);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    const text = message.text();
    // Next's dev overlay and telemetry notices are not application problems.
    if (text.includes('Download the React DevTools')) return;
    problems.push(`[${message.type()}] ${text}`);
  }
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

const step = async (name, fn) => {
  const before = problems.length;
  await fn();
  const added = problems.slice(before);
  console.log(`${added.length === 0 ? 'CLEAN' : 'DIRTY'}  ${name}`);
  added.forEach((problem) => console.log(`         ${problem}`));
};

await step('sign in as a technician', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Technician' }).click();
  await page.getByRole('button', { name: /Lerato Dlamini/ }).click();
  await page.getByRole('heading', { name: /Hello, Lerato/ }).waitFor({ timeout: 20000 });
});

await step('drive a job through to the signature screen', async () => {
  await page.goto(`${BASE}/jobs/EJE-1058`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1058' }).waitFor({ timeout: 20000 });

  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByRole('button', { name: 'No, Thanks' }).click({ timeout: 20000 });

  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Normal Time').first().waitFor({ timeout: 20000 });

  await page.getByRole('tab', { name: 'Completion' }).click();
  await page.getByLabel(/Work performed/).fill('Replaced the light curtain controller.');
  await page.getByRole('button', { name: 'Save write-up' }).click();
  await page.getByText('Saved').first().waitFor({ timeout: 20000 });

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByRole('button', { name: 'Customer signature' }).click({ timeout: 20000 });
  await page.waitForURL('**/sign', { timeout: 30000 });
});

await step('draw on the signature pad', async () => {
  await page.getByRole('heading', { name: 'Customer signature' }).waitFor({ timeout: 20000 });

  const pad = page.locator('div.touch-none').first();
  if ((await pad.count()) === 0) throw new Error('signature pad did not render');

  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 50, box.y + 110);
  await page.mouse.down();
  for (let i = 0; i < 30; i += 1) {
    await page.mouse.move(box.x + 50 + i * 10, box.y + 110 - Math.sin(i / 3) * 35);
  }
  // Pointer-up is where the parent was previously notified from inside a state
  // updater. This is the exact moment the warning used to fire.
  await page.mouse.up();
  await page.waitForTimeout(500);
});

await browser.close();

console.log('\n=== DEV CONSOLE SUMMARY ===');
const reactWarnings = problems.filter(
  (problem) =>
    problem.includes('Cannot update a component') ||
    problem.includes('while rendering a different component'),
);

if (reactWarnings.length > 0) {
  console.log(`FAIL — ${reactWarnings.length} React setState-during-render warning(s)`);
  reactWarnings.forEach((warning) => console.log(' - ' + warning));
  process.exitCode = 1;
} else if (problems.length > 0) {
  console.log(`${problems.length} other console message(s):`);
  problems.forEach((problem) => console.log(' - ' + problem));
  console.log('No React setState-during-render warnings.');
} else {
  console.log('CLEAN — no console errors or warnings at all.');
}
