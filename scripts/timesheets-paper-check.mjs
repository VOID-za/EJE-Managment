/**
 * TS-PAPER — TIMESHEETS AS A DIGITAL PIECE OF PAPER, THROUGH THE SCREEN.
 * The owner, 4 November 2026: "The technician maintains it. The technician
 * submits it on payday. EJE records and preserves it."
 *
 * At one screen size per run (EJE_FORMS_VIEWPORT, as the forms regression):
 * a technician fills in the sheet the way the paper one was filled in — one
 * day, then more later, several customers on a day, Workshop with no
 * customer, a date before the pay period and one in the future — edits a
 * line, writes the comment, confirms From and To and submits; the
 * confirmation names the next sheet's start; the submission is listed exactly
 * as sent and the same dates cannot be sent again. The office then sees it
 * among everybody's, opens it, and has its PDF and CSV. Another technician
 * reads none of it. No page scrolls sideways.
 *
 *   npm run timesheets-paper-check                 (desktop, 1440x900)
 *   EJE_FORMS_VIEWPORT=768x1024:touch npm run timesheets-paper-check
 *   EJE_FORMS_VIEWPORT=390x844:touch npm run timesheets-paper-check
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';

const BASE = process.env.EJE_E2E_URL ?? process.env.EJE_SMOKE_BASE_URL ?? 'http://localhost:3210';
const [shape, mode] = (process.env.EJE_FORMS_VIEWPORT ?? '1440x900').split(':');
const [width, height] = shape.split('x').map(Number);
const touch = mode === 'touch';
const label = `${width}x${height}${touch ? ' touch' : ''}`;

const results = [];
const check = async (name, fn) => {
  try {
    const note = await fn();
    results.push(['PASS', name]);
    console.log(`PASS  ${name}${typeof note === 'string' ? `  — ${note}` : ''}`);
  } catch (error) {
    const message = String(error?.message ?? error).split('\n')[0];
    results.push(['FAIL', `${name} :: ${message}`]);
    console.log(`FAIL  ${name} :: ${message}`);
  }
};
const fail = (message) => {
  throw new Error(message);
};

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch && width < 700 });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const press = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  if (touch) await locator.tap();
  else await locator.click();
};
const as = (who) => signInAs(page, who, { base: BASE });
const go = (path) => page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
const noPageOverflow = async (where) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`${where}: the page scrolls sideways by ${over}px`);
};
const call = (method, path, body) =>
  page.evaluate(
    async ([verb, url, payload]) => {
      const response = await fetch(url, {
        method: verb,
        headers: verb === 'GET' ? {} : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: verb === 'GET' ? undefined : JSON.stringify(payload ?? {}),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    [method, path, body],
  );

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const shift = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const form = () => page.getByTestId('timesheet-line-form');
const rows = (date) => page.locator(`[data-testid="timesheet-line"][data-date="${date}"]`);

/** Adds one line through the screen, as a person types it. */
const addLine = async ({ date, workshop = false, customer = '', ot = '0', dt = '0', callout = '0', ikm = '0', ckm = '0' }) => {
  const before = await rows(date).count();
  await press(page.getByTestId('add-timesheet-line'));
  await form().waitFor({ timeout: 10000 });
  await form().getByTestId('timesheet-line-date').fill(date);
  if (workshop) await form().getByTestId('timesheet-customer-pick').selectOption('__workshop__');
  else await form().getByTestId('timesheet-customer-name').fill(customer);
  await form().getByTestId('timesheet-overtime').fill(ot);
  await form().getByTestId('timesheet-double').fill(dt);
  await form().getByTestId('timesheet-callout').fill(callout);
  await form().getByTestId('timesheet-internal-km').fill(ikm);
  await form().getByTestId('timesheet-customer-km').fill(ckm);
  await press(form().getByTestId('save-timesheet-line'));
  await form().waitFor({ state: 'detached', timeout: 15000 });
  // The sheet is read again after a save: wait for the line to be on it.
  await page.waitForFunction(([d, n]) => document.querySelectorAll(`[data-testid="timesheet-line"][data-date="${d}"]`).length === n, [date, before + 1], { timeout: 15000 });
};

await resetDemonstration(page, BASE);
// Deon has no timesheet history in the demonstration: his first sheet.
await as('Deon Botha');
const me = (await call('GET', '/api/auth/me')).json?.data?.user?.id;

await check('one day entered and saved; back later, the sheet is as it was and continues', async () => {
  await go('/timesheets');
  await page.getByTestId('timesheet-sheet').waitFor({ timeout: 20000 });
  await addLine({ date: shift(-2), customer: 'Kruger Engineering', ot: '2.5', callout: '450', ckm: '42' });
  await go('/dashboard');
  await go('/timesheets');
  await rows(shift(-2)).filter({ hasText: 'Kruger Engineering' }).waitFor({ timeout: 10000 });
  await addLine({ date: shift(-1), customer: 'Vaal Steel', ot: '1' });
  if ((await rows(shift(-1)).count()) !== 1) fail('the second day did not join the sheet');
  await noPageOverflow('the sheet');
});

await check('several customers on one day, and Workshop with no customer at all', async () => {
  await addLine({ date: shift(-1), customer: 'Sasol Secunda', ot: '0.75', ikm: '18' });
  await addLine({ date: shift(-1), workshop: true, ot: '3', ikm: '6.5' });
  const day = await rows(shift(-1)).allInnerTexts();
  if (day.length !== 3) fail(`${day.length} lines on the day`);
  if (!day.some((text) => text.includes('Workshop'))) fail('Workshop is not on the sheet');
});

await check('a date before the pay period and one in the future are lines like any other', async () => {
  await addLine({ date: shift(-60), customer: 'Forgotten job', ot: '1' });
  await addLine({ date: shift(20), customer: 'Planned shutdown', ot: '4' });
  await rows(shift(-60)).waitFor({ timeout: 5000 });
  await rows(shift(20)).waitFor({ timeout: 5000 });
});

await check('a line is corrected before submitting', async () => {
  const line = rows(shift(-2)).filter({ hasText: 'Kruger Engineering' });
  await press(line.getByTestId('edit-timesheet-line'));
  await form().getByTestId('timesheet-overtime').fill('3');
  await press(form().getByTestId('save-timesheet-line'));
  await form().waitFor({ state: 'detached', timeout: 15000 });
  await line.filter({ hasText: '3.00' }).waitFor({ timeout: 15000 }).catch(() => undefined);
  if (!(await line.innerText()).includes('3.00')) fail(`the line reads ${await line.innerText()}`);
});

let submittedFrom = '';
await check('confirm From and To, and Submit timesheet: the confirmation names the next sheet; lines outside stay', async () => {
  await page.getByTestId('timesheet-period-comment').fill('Shutdown week, two call-outs.');
  await press(page.getByTestId('timesheet-save'));
  await page.getByTestId('timesheet-saved').waitFor({ timeout: 10000 });
  // First sheet: From proposes the earliest open line; payday is today.
  submittedFrom = await page.getByTestId('timesheet-from').inputValue();
  if (submittedFrom !== shift(-60)) fail(`From proposes ${submittedFrom}`);
  if ((await page.getByTestId('timesheet-to').inputValue()) !== today) fail('To does not propose today');
  const label = await page.getByTestId('timesheet-period-label').innerText();
  if (!/5 lines/u.test(label) || !/1 outside/u.test(label)) fail(`the period reads "${label}"`);
  await noPageOverflow('the Submit card');
  await press(page.getByTestId('timesheet-send'));
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await press(dialog.getByRole('button', { name: 'Submit timesheet' }));
  const done = await page.getByTestId('timesheet-submitted').innerText({ timeout: 15000 });
  if (!done.includes('next timesheet starts')) fail(`the confirmation reads "${done}"`);
  // The future line stays on the sheet; From now proposes the day after To.
  await rows(shift(20)).waitFor({ timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="timesheet-line"]').length === 1, null, { timeout: 15000 }).catch(() => undefined);
  if ((await page.locator('[data-testid="timesheet-line"]').count()) !== 1) fail('lines inside the submitted dates are still on the sheet');
  if ((await page.getByTestId('timesheet-from').inputValue()) !== shift(1)) fail('the next sheet does not start the day after');
  if ((await page.getByTestId('timesheet-period-comment').inputValue()) !== '') fail('the comment was not cleared');
});

let submissionId = '';
await check('the submission is listed exactly as sent, and the same dates cannot be sent again', async () => {
  const listed = page.locator(`[data-testid="timesheet-submission"][data-from="${submittedFrom}"][data-to="${today}"]`);
  await listed.waitFor({ timeout: 10000 });
  if (!(await listed.innerText()).includes('5 lines')) fail(`the submission reads ${await listed.innerText()}`);
  await press(listed.getByTestId('timesheet-submission-view-original'));
  await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
  await press(page.getByTestId('preview-close'));
  const mine = (await call('GET', '/api/timesheets/submissions')).json?.data ?? [];
  submissionId = mine.find((row) => row.from === submittedFrom && row.to === today)?.id ?? '';
  if (submissionId === '') fail('the submission is not in the list');
  const again = await call('POST', `/api/timesheets/${me}/period/submit`, { from: submittedFrom, to: today });
  if (again.status !== 422) fail(`the same dates again answered ${again.status}`);
  await noPageOverflow('the submitted timesheets');
});

await check('another technician cannot read the working sheet or the submission', async () => {
  await as('Sipho Mahlangu');
  const sheet = await call('GET', `/api/timesheets/${me}/working`);
  const submission = await call('GET', `/api/timesheets/submissions/${submissionId}`);
  if (sheet.status !== 403) fail(`the working sheet answered ${sheet.status}`);
  if (submission.status === 200) fail('the submission was readable');
  const theirs = (await call('GET', '/api/timesheets/submissions')).json?.data ?? [];
  if (theirs.some((row) => row.id === submissionId)) fail('another technician lists the submission');
});

await check('the office sees it among everybody’s, opens it, and has its PDF and CSV', async () => {
  await as('Elmarie Coetzee');
  await go('/timesheets');
  const office = page.getByTestId('timesheet-office');
  await office.waitFor({ timeout: 20000 });
  const row = office.locator(`[data-testid="timesheet-submission"][data-from="${submittedFrom}"][data-to="${today}"]`).filter({ hasText: 'Deon' });
  await row.waitFor({ timeout: 15000 });
  await row.getByTestId('timesheet-submission-pdf').waitFor({ timeout: 5000 });
  await row.getByTestId('timesheet-submission-csv').waitFor({ timeout: 5000 });
  await press(row.getByTestId('timesheet-submission-view-original'));
  await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
  await press(page.getByTestId('preview-close'));
  const document = (await call('GET', `/api/timesheets/submissions/${submissionId}`)).json?.data;
  if (document?.comment !== 'Shutdown week, two call-outs.') fail(`the office reads the comment "${document?.comment}"`);
  if (document.rows.length !== 5) fail(`${document.rows.length} rows in the submitted document`);
  if (!document.rows.some((line) => line.customer === 'Workshop')) fail('Workshop is not in the submission');
  await noPageOverflow('the office list');
});

await check('no page errors anywhere in the run', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([kind]) => kind === 'FAIL');
console.log(`\n=== timesheets ${label}: ${results.length - failed.length} passed, ${failed.length} failed ===`);
for (const [, text] of failed) console.log(` FAIL ${text}`);
process.exit(failed.length === 0 ? 0 : 1);
