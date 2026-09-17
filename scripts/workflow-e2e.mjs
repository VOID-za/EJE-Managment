/**
 * The job workflow, end to end, in a real browser.
 *
 * Written after a live demonstration reported `/jobs/<n>/sign` and
 * `/jobs/<n>/review` returning 404. Both routes were present and correct — a
 * stale server was answering the port — but nothing in the suite walked the
 * whole workflow through the browser's own address bar and asserted that no
 * step lands on a 404. `npm run smoke` drives the same workflow through the UI,
 * which means a broken deep link or notification target could hide behind a
 * button that happens to work.
 *
 * So this exercises the routes the way a person does: type the URL, click the
 * notification, follow where it goes. Every navigation asserts the page is not
 * the 404 page.
 *
 * Usage:
 *   npm run start              # or npm run dev
 *   npm run e2e
 *   EJE_E2E_URL=http://localhost:3000 npm run e2e
 */
import { chromium } from 'playwright';

const BASE = process.env.EJE_E2E_URL ?? 'http://localhost:3000';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;

const failures = [];
const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(`${name} :: ${error.message.split('\n')[0]}`);
    console.log(`FAIL  ${name} :: ${error.message.split('\n')[0]}`);
  }
};

/** Navigate, and refuse to accept a 404 as an answer. */
const visit = async (url) => {
  const response = await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  const status = response === null ? 0 : response.status();
  const body = await page.locator('body').innerText();
  if (body.includes('This page could not be found')) {
    throw new Error(`${url} served the 404 page`);
  }
  if (status >= 400) throw new Error(`${url} returned HTTP ${status}`);
};

/** Assert the browser is not on a 404 after a click-through. */
const assertNot404 = async (what) => {
  const body = await page.locator('body').innerText();
  if (body.includes('This page could not be found')) {
    throw new Error(`${what} landed on a 404 (${page.url()})`);
  }
};

const signInAs = async (role, name, greeting) => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  if ((await page.getByRole('button', { name: 'Sign out' }).count()) > 0) {
    await page.getByRole('button', { name: 'Sign out' }).click();
  }
  await page.getByRole('tab', { name: role }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('heading', { name: greeting }).waitFor({ timeout: 20000 });
};

const drawSignature = async () => {
  const pad = page.locator('div.touch-none').first();
  await pad.waitFor({ timeout: 15000 });
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 110);
  await page.mouse.down();
  for (let i = 0; i < 28; i += 1) {
    await page.mouse.move(box.x + 60 + i * 11, box.y + 110 - Math.sin(i / 3) * 34);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
};

// ── PART 18: EJE-1056 Master Review route ────────────────────────────────────
await signInAs('Master', 'Elmarie Coetzee', /Good day, Elmarie/);

await step('EJE-1056 Master Review route loads, typed straight into the address bar', async () => {
  await visit('/jobs/EJE-1056/review');
  await page.getByRole('heading', { name: 'Review job card' }).waitFor({ timeout: 15000 });
  await page.getByText('EJE-1056').first().waitFor({ timeout: 10000 });
});

await step('EJE-1056 is closed, so its review screen is the final job card', async () => {
  await page.getByText('Issued and closed').waitFor({ timeout: 10000 });
  await page.getByText('EJE-1056-Final-Job-Card.pdf').first().waitFor({ timeout: 10000 });
  // Opening a closed job must not offer to issue it again.
  if ((await page.getByRole('button', { name: 'Submit Job Card' }).count()) > 0) {
    throw new Error('a closed job offered Submit Job Card');
  }
});

await step('EJE-1056 carries its real job data, not a placeholder', async () => {
  const body = await page.locator('main').innerText();
  for (const value of ['ABC Engineering', 'Johannesburg', 'Coolant pump']) {
    if (!body.includes(value)) throw new Error(`the review page does not show ${value}`);
  }
});

// ── PART 17: EJE-1065 signature route and workflow ───────────────────────────
await step('EJE-1065 signature route loads rather than 404ing', async () => {
  await visit('/jobs/EJE-1065/sign');
  await page.getByRole('heading', { name: 'Customer signature' }).first().waitFor({ timeout: 15000 });
});

await step('EJE-1065 is not ready, and the page says why instead of 404ing', async () => {
  // An open job has no work captured, so signature is refused by the domain.
  await page.getByText('not ready for signature', { exact: false }).waitFor({ timeout: 10000 });
});

await step('a technician drives EJE-1065 to the signature stage through the UI', async () => {
  await signInAs('Technician', 'Sipho Mahlangu', /Hello, Sipho/);
  await visit('/jobs/EJE-1065');

  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByRole('button', { name: 'No, Thanks' }).click({ timeout: 20000 });

  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Normal Time').first().waitFor({ timeout: 15000 });

  await page.getByRole('tab', { name: 'Completion' }).click();
  await page.getByLabel(/Work performed/).fill('Replaced the faulty contactor and retested the line.');
  await page.getByRole('button', { name: 'Save write-up' }).click();
  await page.getByText('Saved').first().waitFor({ timeout: 15000 });

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Complete job' }).click();
});

await step('the Customer signature button navigates to the signature route', async () => {
  await page.getByRole('button', { name: 'Customer signature' }).click({ timeout: 20000 });
  await page.waitForURL('**/jobs/EJE-1065/sign', { timeout: 20000 });
  await assertNot404('the Customer signature button');
  await page.getByRole('heading', { name: 'Customer signature' }).first().waitFor({ timeout: 15000 });
});

await step('the signature screen shows the existing EJE acceptance wording', async () => {
  await page
    .getByText('I confirm that the work described above has been completed.')
    .waitFor({ timeout: 10000 });
});

await step('the customer signs, and the signature is captured', async () => {
  await page.getByLabel('Customer name').fill('Gerhard');
  await page.getByLabel('Customer surname').fill('Smit');
  await drawSignature();
  await page.getByRole('button', { name: 'Confirm signature' }).click();
  await page.waitForURL('**/jobs/EJE-1065/review', { timeout: 20000 });
  await assertNot404('capturing the signature');
});

await step('the captured signature renders in solid black', async () => {
  // Scoped to the job card document on the review page, so this cannot pass
  // against the signature pad's own live stroke if capture never happened.
  if (!page.url().endsWith('/jobs/EJE-1065/review')) {
    throw new Error(`not on the review page (${page.url()}), so there is no captured signature`);
  }
  const document = page.locator('.eje-document').first();
  await document.waitFor({ timeout: 15000 });
  await document.getByText('Gerhard').first().waitFor({ timeout: 10000 });

  const strokes = document.locator('svg path[stroke]');
  const count = await strokes.count();
  if (count === 0) throw new Error('the job card renders no signature strokes');

  const inks = new Set();
  for (let index = 0; index < count; index += 1) {
    inks.add(await strokes.nth(index).getAttribute('stroke'));
  }
  const wrong = [...inks].filter((ink) => ink !== '#000000');
  if (wrong.length > 0) {
    throw new Error(`the signature rendered ${wrong.join(', ')}, not #000000`);
  }
});

await step('the signature persists on the job across a reload', async () => {
  await visit('/jobs/EJE-1065');
  const body = await page.locator('main').innerText();
  if (!body.includes('Gerhard') || !body.includes('Smit')) {
    throw new Error('the signatory is not on the job after reload');
  }
  await visit('/jobs/EJE-1065/sign');
  await page.getByText('already been signed', { exact: false }).waitFor({ timeout: 10000 });
});

// ── PART 19: new submission, Master notification, click-through ──────────────
await step('the technician submits EJE-1065 for Master Review', async () => {
  await visit('/jobs/EJE-1065/review');
  await page.getByRole('button', { name: 'Submit for Master Review' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await page.getByText('With the office for review').first().waitFor({ timeout: 20000 });
});

await step('no customer email was sent at hand-over', async () => {
  await visit('/notifications?tab=outbox');
  if ((await page.getByText('EJE-1065-Final-Job-Card.pdf').count()) !== 0) {
    throw new Error('the technician hand-over emailed the customer');
  }
});

await step('every active Master has a notification for the new submission', async () => {
  for (const master of [
    { name: 'Elmarie Coetzee', greeting: /Good day, Elmarie/ },
    { name: 'Johan', greeting: /Good day, Johan/ },
  ]) {
    await signInAs('Master', master.name, master.greeting);
    await visit('/notifications');
    const rows = page.locator('li').filter({ hasText: 'Job EJE-1065 submitted for review' });
    const count = await rows.count();
    if (count !== 1) {
      throw new Error(`${master.name} has ${count} notifications for EJE-1065, expected exactly 1`);
    }
  }
});

await step('the notification opens the Master Review screen for EJE-1065, not a 404', async () => {
  await signInAs('Master', 'Elmarie Coetzee', /Good day, Elmarie/);
  await visit('/notifications');
  const row = page.locator('li').filter({ hasText: 'Job EJE-1065 submitted for review' }).first();
  const link = row.getByRole('link').first();
  const href = await link.getAttribute('href');
  // The canonical Master Review route, not the job page and not a stale path.
  if (href !== '/jobs/EJE-1065/review') {
    throw new Error(`the notification points at ${href}`);
  }
  await link.click();
  await page.waitForURL('**/jobs/EJE-1065/review', { timeout: 20000 });
  await assertNot404('the Master Review notification');
  await page.getByRole('heading', { name: 'Review job card' }).waitFor({ timeout: 15000 });
  await page.getByText('EJE-1065').first().waitFor({ timeout: 10000 });
});

await step('the review screen offers the Master both editing and issuing', async () => {
  await page.getByRole('button', { name: 'Submit Job Card' }).waitFor({ timeout: 15000 });
  // "Edit job" goes back to the job itself, so landing on review costs nothing.
  const edit = page.getByRole('button', { name: 'Edit job' });
  await edit.waitFor({ timeout: 10000 });
  await edit.click();
  await page.waitForURL('**/jobs/EJE-1065', { timeout: 20000 });
  await assertNot404('Edit job');
  await page.getByRole('heading', { name: 'EJE-1065' }).waitFor({ timeout: 15000 });
  await visit('/jobs/EJE-1065/review');
});

// ── PART 20: finalise, close, final document ─────────────────────────────────
await step('the Master issues the job card, which closes the job', async () => {
  await page.getByRole('button', { name: 'Submit Job Card' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByText('submitted and closed', { exact: false }).waitFor({ timeout: 20000 });
});

await step('the customer was emailed exactly once, only now', async () => {
  await visit('/notifications?tab=outbox');
  const emails = await page.getByText('EJE-1065-Final-Job-Card.pdf').count();
  if (emails !== 1) throw new Error(`the final job card was emailed ${emails} times, expected 1`);
});

await step('EJE-1065 now appears in the Closed Jobs archive', async () => {
  await visit('/jobs/closed');
  await page.getByLabel('Search the archive').fill('EJE-1065');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1065'),
    { timeout: 20000 },
  );
});

await step('the closed job carries its final job card, with both actions', async () => {
  await page.getByRole('row').filter({ hasText: 'EJE-1065' }).first().click();
  await page.waitForURL('**/jobs/EJE-1065', { timeout: 20000 });
  await page.getByText('Final signed job card').waitFor({ timeout: 15000 });
  await page.getByText('EJE-1065-Final-Job-Card.pdf').first().waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'View Final PDF' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Download Final PDF' }).waitFor({ timeout: 10000 });
});

await step('View Final PDF loads the stored document, not a 404', async () => {
  await page.getByRole('button', { name: 'View Final PDF' }).click();
  await page.waitForURL('**/jobs/EJE-1065/review', { timeout: 20000 });
  await assertNot404('View Final PDF');
  await page.getByText('EJE-1065-Final-Job-Card.pdf').first().waitFor({ timeout: 15000 });
  await page.getByText('Issued and closed').waitFor({ timeout: 10000 });
});

await step('Download Final PDF reaches the same document without a 404', async () => {
  // The print dialog is suppressed; what matters is that the route resolves.
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await visit('/jobs/EJE-1065/review?print=1');
  await page.getByText('EJE-1065-Final-Job-Card.pdf').first().waitFor({ timeout: 15000 });
});

await step('the closed job is read-only, and its signature survived', async () => {
  await visit('/jobs/EJE-1065');
  await page.getByText('this job is closed', { exact: false }).first().waitFor({ timeout: 15000 });
  const body = await page.locator('main').innerText();
  if (!body.includes('Gerhard')) throw new Error('the signature was lost on closure');
});

await step('viewing the closed job card twice does not duplicate the document event', async () => {
  await visit('/jobs/EJE-1065');
  await page.getByRole('tab', { name: /Activity/ }).click();
  await page.getByText('Activity', { exact: false }).first().waitFor({ timeout: 10000 });
  const before = await page.getByText('document generated', { exact: false }).count();

  await visit('/jobs/EJE-1065/review');
  await page.getByText('Issued and closed').waitFor({ timeout: 15000 });
  await visit('/jobs/EJE-1065');
  await page.getByRole('tab', { name: /Activity/ }).click();
  await page.getByText('Activity', { exact: false }).first().waitFor({ timeout: 10000 });
  const after = await page.getByText('document generated', { exact: false }).count();

  if (after !== before) {
    throw new Error(`viewing a closed job card regenerated its document (${before} -> ${after})`);
  }
});

await step('the two-way chat is still intact', async () => {
  await visit('/messages');
  await page.getByRole('heading', { name: 'Messages', exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'New message' }).waitFor({ timeout: 10000 });
});

await browser.close();

console.log('\n=== WORKFLOW E2E SUMMARY ===');
const realErrors = pageErrors.filter((text) => !text.includes('Failed to load resource'));
if (failures.length > 0) {
  console.log(`${failures.length} step(s) FAILED:`);
  failures.forEach((failure) => console.log(` - ${failure}`));
  process.exitCode = 1;
} else if (realErrors.length > 0) {
  console.log(`All steps passed, but ${realErrors.length} console error(s) were logged:`);
  realErrors.forEach((text) => console.log(` - ${text}`));
  process.exitCode = 1;
} else {
  console.log('COMPLETE WORKFLOW PASSED end to end, with no 404 and no console errors');
}
