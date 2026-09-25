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
import { resetDemonstration, signInAs, signOut as signOutOf } from './sign-in.mjs';

const BASE = process.env.EJE_DEV_URL ?? 'http://localhost:3000';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;

const browser = await chromium.launch(
  executablePath === undefined ? {} : { executablePath },
);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

/*
 * A REFUSAL IS NOT A CONSOLE ERROR.
 *
 * The browser logs every non-2xx fetch as "Failed to load resource", and the
 * application now asks a server for everything — so a refused sign-in, a
 * validation failure the screen renders, a job the actor may not read and a
 * first visit with no session all produce one. Each is the API working
 * correctly, and each is asserted where it happens.
 *
 * 5xx is NOT on this list: an internal error is a fault, and these suites must
 * keep failing on one.
 */
const EXPECTED_HTTP = /Failed to load resource:.*status of (400|401|403|404|409|422|429)\b/;

const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    const text = message.text();
    // Next's dev overlay and telemetry notices are not application problems.
    if (text.includes('Download the React DevTools')) return;
    if (EXPECTED_HTTP.test(text)) return;
    problems.push(`[${message.type()}] ${text}`);
  }
});
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));

/** Signing out is in the top-right profile menu now, not the sidebar. */
const signOut = () => signOutOf(page, 15000);

const step = async (name, fn) => {
  const before = problems.length;
  await fn();
  const added = problems.slice(before);
  console.log(`${added.length === 0 ? 'CLEAN' : 'DIRTY'}  ${name}`);
  added.forEach((problem) => console.log(`         ${problem}`));
};

await step('reset the demonstration data', async () => {
  await resetDemonstration(page, BASE);
});

await step('sign in as a technician', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signInAs(page, 'Lerato Dlamini');
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
  // The write-up saves itself (WRITEUP-1): there is no Save write-up button,
  // so this waits for the panel to say so rather than pressing anything.
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });

  await page.getByRole('tab', { name: 'Overview' }).click();
  // Complete job opens the guided close-out, and the signature is its last step.
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Step 1 of 4', { exact: false }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 20000 });
  await page.getByText('Step 2 of 4', { exact: false }).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Continue' }).click({ timeout: 20000 });
  await page.getByText('Step 3 of 4', { exact: false }).waitFor({ timeout: 30000 });
});

await step('draw on the signature pad', async () => {
  await page.getByRole('heading', { name: 'Customer acceptance' }).waitFor({ timeout: 20000 });

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

await step('technician messages the office and replies in the thread', async () => {
  // Opening a thread marks its messages read, which writes to the demo store.
  // Doing that during render is exactly the warning this script exists for.
  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Messages', exact: true }).waitFor({ timeout: 20000 });

  await page.getByRole('button', { name: 'New message' }).click();
  const compose = page.getByRole('dialog');
  await compose.waitFor({ timeout: 10000 });
  await compose.getByLabel('Message').fill('Running late — traffic on the R21.');
  await compose.getByRole('button', { name: 'Send message' }).click();

  /*
   * Wait for the DIALOG to go, not for the text.
   *
   * The text is in the compose box the moment it is typed, so waiting for it
   * matches before the server has been asked anything — and the next step then
   * types into a form that is still open. The dialog closes when the server has
   * actually started the conversation, which is the thing being waited for.
   */
  await compose.waitFor({ state: 'detached', timeout: 20000 });
  await page.getByText('traffic on the R21', { exact: false }).first().waitFor({ timeout: 20000 });

  await page.getByLabel('Message').fill('Should be on site by 10:30.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('on site by 10:30', { exact: false }).first().waitFor({ timeout: 20000 });
});

await step('technician moves between conversations', async () => {
  const threads = page.getByRole('button', { name: /R21|Edenvale|EJE-/ });
  const count = await threads.count();
  for (let index = 0; index < Math.min(count, 3); index += 1) {
    await threads.nth(index).click();
    await page.waitForTimeout(400);
  }
});

await step('technician reads their own availability', async () => {
  await page.goto(`${BASE}/technicians/user-tech-lerato`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Lerato/ }).first().waitFor({ timeout: 20000 });
  await page.getByRole('tab', { name: /Messages/ }).click();
  await page.waitForTimeout(400);
});

await step('technician accepts from the Open Jobs list', async () => {
  // Acceptance from the list runs the same flow as the job screen, including
  // the site-location offer, so it is worth its own dev-mode pass.
  await page.goto(`${BASE}/jobs?status=open`, { waitUntil: 'networkidle' });
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Accept', exact: true }) })
    .first();
  await row.waitFor({ timeout: 20000 });
  await row.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByRole('button', { name: 'No, Thanks' }).click({ timeout: 20000 });
  await page.waitForTimeout(600);
});

await step('technician opens the transfer dialog on their own job', async () => {
  // Sipho is the primary technician on EJE-1067, which is in progress with work
  // already captured — the case a transfer has to carry forward.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Sipho Mahlangu');
  await page.getByRole('heading', { name: /Hello, Sipho/ }).waitFor({ timeout: 20000 });

  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Transfer job' }).click({ timeout: 20000 });
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  // Switching destination and reason exercises every controlled input here.
  await dialog.getByText('A specific technician').click();
  await dialog.getByLabel('Reason').selectOption('other');
  await dialog.getByLabel('Description').fill('Covering another call-out.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(400);
});

await step('sign in as a Master', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Elmarie Coetzee');
  await page.getByRole('heading', { name: /Good day, Elmarie/ }).waitFor({ timeout: 20000 });
});

await step('Master opens a chat notification, which lands on the conversation', async () => {
  await page.goto(`${BASE}/notifications`, { waitUntil: 'networkidle' });
  const open = page.getByRole('link', { name: 'Open conversation' }).first();
  await open.waitFor({ timeout: 20000 });
  await open.click();
  await page.getByRole('heading', { name: 'Messages', exact: true }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
});

await step('Master opens the availability dialog from a message', async () => {
  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Mark unavailable' }).first().click({ timeout: 20000 });

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  // All-day toggling and the type select are the controlled inputs most likely
  // to misbehave, so both are exercised before closing.
  await dialog.getByLabel('Type').selectOption('training');
  await dialog.getByLabel('All day').check();
  await dialog.getByLabel('All day').uncheck();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(400);
});

await step('Master opens the cancel and delete dialogs', async () => {
  await page.goto(`${BASE}/jobs/EJE-1066`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Cancel job' }).click({ timeout: 20000 });
  let dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Reason').selectOption('other');
  await dialog.getByRole('button', { name: 'Keep the job' }).click();

  await page.getByRole('button', { name: 'Delete job' }).click({ timeout: 20000 });
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByRole('button', { name: 'Keep the job' }).click();
  await page.waitForTimeout(400);
});

await step('Master moves through every calendar view', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 20000 });
  for (const view of ['Day', 'Week', 'Month', 'Year']) {
    await page.getByRole('tab', { name: view }).click();
    await page.waitForTimeout(350);
  }
  await page.getByRole('tab', { name: 'Month' }).click();
  await page.waitForTimeout(350);
});

await step('Master works the calendar filters', async () => {
  for (const filter of ['Availability', 'Jobs', 'All']) {
    await page.getByRole('button', { name: filter, exact: true }).click();
    await page.waitForTimeout(300);
  }
  await page.getByLabel('Job type').selectOption('service');
  await page.waitForTimeout(300);
  await page.getByLabel('Job type').selectOption('all');
  await page.waitForTimeout(300);
});

await step('Master opens "+N more" and an entry detail from it', async () => {
  const more = page.getByText(/^\+ \d+ more$/).first();
  await more.waitFor({ timeout: 20000 });
  await more.click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });

  // Dialog-to-dialog: closing one and opening another in the same click is the
  // path most likely to update a component while another renders.
  await page.getByRole('dialog').getByRole('listitem').first().getByRole('button').click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
});

await step('Master opens an availability detail from the grid', async () => {
  await page
    .locator('button[aria-label*="Leave"], button[aria-label*="Sick"], button[aria-label*="Appointment"]')
    .first()
    .click({ timeout: 20000 });
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
});

await step('Master opens the assign dialog and hits an availability clash', async () => {
  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Assign', exact: true }).first().click({ timeout: 20000 });
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Role on this job').selectOption('primary');
  await dialog.getByLabel('Technician').selectOption({ label: 'Thabo Nkosi — Field Technician' });
  await dialog.getByRole('button', { name: 'Assign' }).click();
  // The refusal renders inside the dialog; this is the render path most at risk
  // of a setState-during-render, since it is driven by a thrown error.
  await dialog.getByText('Technician unavailable').waitFor({ timeout: 20000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(400);
});

await step('Master works the Closed Jobs archive', async () => {
  await page.goto(`${BASE}/jobs/closed`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Closed Jobs' }).waitFor({ timeout: 20000 });
  await page.getByRole('table').waitFor({ timeout: 20000 });

  // Every filter is a controlled input driving an async re-query.
  await page.getByLabel('Search the archive').fill('EJE-1044');
  await page.waitForTimeout(500);
  await page.getByLabel('Search the archive').fill('');
  await page.getByLabel('Customer').selectOption('cust-abc');
  await page.waitForTimeout(400);
  await page.getByLabel('Job type').selectOption('service');
  await page.waitForTimeout(400);
  await page.getByLabel('Closed from').fill('2026-01-01');
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.waitForTimeout(400);
});

await step('Master opens a closed job and its final document', async () => {
  await page.goto(`${BASE}/jobs/EJE-1044`, { waitUntil: 'networkidle' });
  await page.getByText('Final signed job card').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'View Final PDF' }).click();
  // "Job card", not "Review job card": the job is CLOSED, so there is nothing
  // to review and nobody to submit it. MASTER SCOPE CR-07.
  await page.getByRole('heading', { name: 'Job card', exact: true }).waitFor({ timeout: 20000 });
  await page.getByText('Issued and closed').waitFor({ timeout: 20000 });
  // The stored descriptor is derived, not written from an effect; a regression
  // here shows up as a setState-during-effect warning.
  await page.waitForTimeout(800);
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
