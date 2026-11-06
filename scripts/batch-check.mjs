/**
 * THE NEXT CRITICAL BATCH THROUGH THE SCREEN (2 November 2026).
 *
 * At one viewport per run (`EJE_FORMS_VIEWPORT=1440x900`, `768x1024:touch`,
 * `390x844:touch`), against the demonstration backend, from a reset:
 *
 *   - the sidebar says Overview; the Overview shows this week's standby — an
 *     empty state with no published schedule, the four places once published
 *     (STANDBY-DASH-1);
 *   - the role names: Senior Tech, Office, Technician, and Apprentice offered
 *     when the Office adds a user (ROLE-APP-1, ROLE-LABEL-1);
 *   - a technician cancels their own accepted job with a written reason; the
 *     button waits for the reason (CANCEL-ALL-1);
 *   - a ZIP is uploaded to a job and chosen for the customer email (JOB-ATT-1/3);
 *   - Default or Custom Rates below Payment terms on Add customer; the Custom
 *     Rates tab beside Notes & Documents, only for a Custom Rates customer and
 *     only for the office; a job of a Custom Rates customer without rates says
 *     so, and stops saying so once they are set (CUST-RATES-1);
 *   - Attendance: From and To top-right, no Month selector, Preview and Print
 *     only — no Download, no Submit, no timesheet controls; Timesheets: Preview
 *     and Print only; Monthly Forms: Download, Preview, Print and Submit, with
 *     no month-end restriction; the timesheet file named for the To month
 *     (FORMS-PAGES-1, MONTH-END-OFF-1, TS-NAME-TO-1);
 *   - the Inbox: Jobcards, Messages, Monthly Forms and Standby (NOTIF-TABS-2);
 *   - no page scrolls sideways, and no page error is thrown.
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';
import { completeAndSubmit } from './payroll-flow.mjs';
import { assertLocalTarget } from './local-target.mjs';

const BASE = assertLocalTarget(process.env.EJE_E2E_URL ?? process.env.EJE_SMOKE_BASE_URL ?? 'http://localhost:3210');
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
const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch && width < 700, acceptDownloads: true });
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
      const type = response.headers.get('content-type') ?? '';
      const disposition = response.headers.get('content-disposition') ?? '';
      if (type.includes('json')) return { status: response.status, json: await response.json(), disposition };
      return { status: response.status, json: null, disposition };
    },
    [method, path, body],
  );
const fileNameOf = (disposition) => /filename="([^"]+)"/u.exec(disposition)?.[1] ?? '';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const shortMonth = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }).slice(0, 3);
const jobsOf = async () => (await call('GET', '/api/jobs')).json.data.rows.map((row) => row.job);
/** A job the signed-in technician is working on — accepting one assigned to them if need be. */
const workingJob = async (userId, except = []) => {
  const all = await jobsOf();
  const working = all.find((job) => job.status === 'in_progress' && job.primaryTechnicianId === userId && !except.includes(job.jobNumber));
  if (working !== undefined) return working;
  const open = all.find((job) => job.status === 'open' && job.primaryTechnicianId === userId && !except.includes(job.jobNumber));
  if (open === undefined) fail(`${userId} has no job to work on`);
  const accepted = await call('POST', `/api/jobs/${open.jobNumber}/accept`, {});
  if (accepted.status !== 200) fail(`accepting ${open.jobNumber} answered ${accepted.status}`);
  return (await jobsOf()).find((job) => job.jobNumber === open.jobNumber);
};

await resetDemonstration(page, BASE);

/* ---- Overview and the current week's standby ----------------------------- */
await check('the sidebar says Overview; with no published schedule the Overview says so', async () => {
  await as('Sipho Mahlangu');
  await go('/dashboard');
  if (width >= 1024) {
    await page.locator('nav a[href="/dashboard"]').filter({ hasText: 'Overview' }).first().waitFor({ timeout: 15000 });
    if ((await page.locator('nav a[href="/dashboard"]').filter({ hasText: 'Dashboard' }).count()) !== 0) fail('the sidebar still says Dashboard');
  }
  await page.getByTestId('overview-standby').waitFor({ timeout: 20000 });
  await page.getByTestId('overview-standby-empty').waitFor({ timeout: 10000 });
  await noPageOverflow('the Overview');
});

await check('once the office publishes the year, the Overview shows this week’s four places', async () => {
  await as('Christene van Niekerk');
  const people = { main: ['user-tech-sipho', 'user-tech-riaan'], helper: ['user-tech-thabo', 'user-tech-francois'], apprentice: ['user-tech-andre', 'user-tech-naledi', 'user-tech-deon', 'user-tech-lerato'] };
  for (const id of people.main) await call('POST', '/api/standby/eligibility', { userId: id, main: true, helper: true, apprentice: false });
  for (const id of people.helper) await call('POST', '/api/standby/eligibility', { userId: id, main: false, helper: true, apprentice: false });
  for (const id of people.apprentice) await call('POST', '/api/standby/eligibility', { userId: id, main: false, helper: false, apprentice: true });
  const year = Number(today.slice(0, 4));
  const generated = await call('POST', '/api/standby/generate', { year, rotation: { main: people.main, helper: people.helper, apprentice_1: people.apprentice.slice(0, 2), apprentice_2: people.apprentice.slice(2) } });
  if (generated.status !== 200) fail(`generating answered ${generated.status} ${JSON.stringify(generated.json?.error ?? '')}`);
  const published = await call('POST', '/api/standby/publish', { year, acknowledgeIncomplete: true });
  if (published.status !== 200) fail(`publishing answered ${published.status} ${JSON.stringify(published.json?.error ?? '')}`);
  await as('Sipho Mahlangu');
  await go('/dashboard');
  const block = page.getByTestId('overview-standby');
  await block.getByTestId('overview-standby-main').waitFor({ timeout: 20000 });
  for (const position of ['main', 'helper', 'apprentice_1', 'apprentice_2']) {
    const text = await block.getByTestId(`overview-standby-${position}`).innerText();
    if (/Not assigned/u.test(text)) fail(`${position} is empty: ${text}`);
  }
  await noPageOverflow('the Overview with standby');
});

/* ---- Roles --------------------------------------------------------------- */
await check('the role names are Senior Tech, Office and Technician; Add user offers Apprentice, never Senior Tech', async () => {
  // Accounts and their roles are kept by the Senior Tech, in Administration.
  await as('Elmarie Coetzee');
  await go('/admin');
  await press(page.getByRole('tab', { name: 'Users', exact: true }).first());
  await page.getByRole('button', { name: 'Add user' }).waitFor({ timeout: 20000 });
  const text = await page.locator('main').innerText();
  for (const role of ['Senior Tech', 'Office', 'Technician']) if (!text.includes(role)) fail(`no "${role}" role label`);
  if (/\b(Master|Coordinator)\b/u.test(text.replace(/Office Coordinator \(DEMO\)|Operations Coordinator|Office Coordinator|Master Review/gu, ''))) fail('a role is still labelled Master or Coordinator');
  await press(page.getByRole('button', { name: 'Add user' }));
  const role = page.getByRole('dialog').getByLabel('Role');
  await role.waitFor({ timeout: 10000 });
  const options = await role.locator('option').allInnerTexts();
  if (!options.includes('Apprentice') || !options.includes('Technician') || !options.includes('Office')) fail(`the role choices are ${options.join(', ')}`);
  if (options.includes('Senior Tech') || options.includes('Master')) fail('a Senior Tech account is offered');
  await noPageOverflow('Add user');
  await page.keyboard.press('Escape');
  return options.join(', ');
});

/* ---- Cancellation -------------------------------------------------------- */
let cancelled = null;
await check('a technician cancels their own accepted job; the button waits for the written reason', async () => {
  await as('Sipho Mahlangu');
  const job = await workingJob('user-tech-sipho');
  await go(`/jobs/${job.jobNumber}`);
  await press(page.getByRole('button', { name: 'Cancel job' }));
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Cancel job' });
  await confirm.waitFor({ timeout: 10000 });
  if (!(await confirm.isDisabled())) fail('Cancel job is offered before a reason is written');
  await dialog.getByTestId('cancel-job-reason').fill('The customer cancelled on site.');
  await noPageOverflow('the cancel dialog');
  await press(confirm);
  await page.getByText(/cancelled/iu).first().waitFor({ timeout: 20000 });
  const after = (await call('GET', `/api/jobs/${job.jobNumber}`)).json.data.view.job;
  if (after.status !== 'cancelled' || after.cancellation?.description !== 'The customer cancelled on site.') fail(`the job is ${after.status}`);
  cancelled = job.jobNumber;
  return cancelled;
});

/* ---- Attachments --------------------------------------------------------- */
await check('a ZIP is attached to a job and chosen for the customer email', async () => {
  await as('Sipho Mahlangu');
  const job = await workingJob('user-tech-sipho', [cancelled]);
  await go(`/jobs/${job.jobNumber}`);
  await press(page.getByRole('tab', { name: /^Photos/u }));
  await page.getByTestId('job-add-documents').waitFor({ timeout: 20000 });
  const input = page.locator('input[type="file"][accept*=".zip"]').first();
  await input.waitFor({ state: 'attached', timeout: 20000 });
  await input.setInputFiles({ name: 'Drawings.zip', mimeType: 'application/zip', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]) });
  const row = page.getByTestId('job-document').filter({ hasText: 'Drawings.zip' });
  await row.waitFor({ timeout: 20000 });
  const box = row.locator('input[type="checkbox"]');
  await press(box);
  await page.waitForFunction(() => document.querySelector('[data-testid="job-document"] input[type="checkbox"]')?.checked === true, null, { timeout: 15000 });
  const view = (await call('GET', `/api/jobs/${job.jobNumber}`)).json.data.view.job;
  const stored = view.attachments.find((attachment) => attachment.fileName === 'Drawings.zip');
  if (stored?.emailToCustomer !== true) fail('the choice was not saved');
  await noPageOverflow('the job documents');
  return job.jobNumber;
});

/* ---- Customer rates ------------------------------------------------------ */
await check('Add customer: the rate choice sits directly below Payment terms', async () => {
  await as('Christene van Niekerk');
  await go('/customers');
  await press(page.getByRole('button', { name: 'Add customer' }));
  const dialog = page.getByRole('dialog');
  const select = dialog.getByTestId('customer-rate-mode');
  await select.waitFor({ timeout: 10000 });
  const labels = await dialog.locator('label').allInnerTexts();
  const terms = labels.findIndex((text) => /Payment terms/u.test(text));
  const rates = labels.findIndex((text) => /^Rates/u.test(text.trim()));
  if (terms < 0 || rates !== terms + 1) fail(`Payment terms is label ${terms}, Rates ${rates}`);
  const options = await select.locator('option').allInnerTexts();
  if (options.join('|') !== 'Default Rates|Custom Rates') fail(`the options are ${options.join(', ')}`);
  await noPageOverflow('Add customer');
  await page.keyboard.press('Escape');
});

await check('a Custom Rates customer: the tab beside Notes & Documents, a job flagged until the rates are set', async () => {
  await as('Christene van Niekerk');
  const job = (await jobsOf()).find((candidate) => candidate.status === 'in_progress' && candidate.jobNumber !== cancelled);
  const customerId = (await call('GET', `/api/jobs/${job.jobNumber}`)).json.data.view.job.customerId;
  if ((await call('POST', `/api/customers/${customerId}/rate_mode`, { mode: 'custom' })).status !== 200) fail('the rate option was not changed');
  await go(`/jobs/${job.jobNumber}`);
  await page.getByTestId('job-custom-rates-missing').waitFor({ timeout: 20000 });
  await go(`/customers/${customerId}`);
  const tabs = await page.getByRole('tab').allInnerTexts();
  const notes = tabs.findIndex((text) => text.includes('Notes & Documents'));
  if (tabs[notes + 1]?.trim() !== 'Custom Rates') fail(`the tabs are ${tabs.join(', ')}`);
  await press(page.getByRole('tab', { name: 'Custom Rates' }));
  const panel = page.getByTestId('customer-custom-rates');
  await panel.getByTestId('customer-custom-rates-missing').waitFor({ timeout: 10000 });
  const values = { normal: '1200', overtime: '1800', double: '2400', callout: '990', testBench: '510', kilometre: '25', vat: '15' };
  for (const [key, value] of Object.entries(values)) await panel.getByTestId(`customer-rate-${key}`).fill(value);
  await noPageOverflow('Custom Rates');
  await press(panel.getByTestId('customer-rates-save'));
  await press(page.getByRole('dialog').getByRole('button', { name: 'Save custom rates' }));
  await page.waitForFunction(() => document.querySelector('[data-testid="customer-custom-rates-missing"]') === null, null, { timeout: 20000 });
  const rates = (await call('GET', `/api/customers/${customerId}`)).json.data.rates;
  if (rates?.custom?.labourRates?.normal !== 120000 || rates?.custom?.calloutRate !== 99000) fail(`saved ${JSON.stringify(rates?.custom)}`);
  await go(`/jobs/${job.jobNumber}`);
  await page.getByTestId('job-custom-rates').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('job-custom-rates-missing').count()) !== 0) fail('the job still says the rates are missing');
  // A technician sees no Custom Rates tab and cannot reach the rates.
  await as('Sipho Mahlangu');
  await go(`/customers/${customerId}`);
  await page.getByRole('tab').first().waitFor({ timeout: 20000 });
  if ((await page.getByRole('tab', { name: 'Custom Rates' }).count()) !== 0) fail('a technician sees the Custom Rates tab');
  if ((await call('POST', `/api/customers/${customerId}/rates`, { labourRates: { normal: 1, overtime: 1, double: 1 }, calloutRate: 1, testBenchFee: 1, kilometreRate: 1, vatPercentage: 1 })).status !== 403) fail('a technician could set the rates');
});

/* ---- Attendance, Timesheets, Monthly Forms ------------------------------ */
await check('Attendance: From and To top-right, no Month selector, Preview and Print only, nothing of the timesheet', async () => {
  await as('Sipho Mahlangu');
  await go('/attendance');
  await page.getByTestId('my-attendance').waitFor({ timeout: 20000 });
  // In the first block, top-right — where the Month selector was.
  const range = await page.getByTestId('attendance-range').boundingBox();
  const block = await page.getByTestId('attendance-filters').boundingBox();
  if (width >= 1024 && (range === null || block === null || range.x + range.width < block.x + block.width - 40 || range.x < block.x + block.width / 2)) fail(`From/To are at ${JSON.stringify(range)} in ${JSON.stringify(block)}`);
  for (const gone of ['monthly-attendance-month', 'monthly-forms-submit', 'monthly-attendance-download', 'my-attendance-pdf', 'monthly-forms-edit-timesheet', 'monthly-forms-edit']) {
    if ((await page.getByTestId(gone).count()) !== 0) fail(`the Attendance page still has ${gone}`);
  }
  const main = await page.locator('main').innerText();
  if (/timesheet/iu.test(main)) fail('the Attendance page mentions the timesheet');
  if (/has not ended/iu.test(main)) fail('the Attendance page still waits for the month to end');
  await press(page.getByTestId('attendance-preview'));
  await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('preview-download').count()) !== 0) fail('the Attendance preview offers Download');
  await press(page.getByTestId('preview-close'));
  await page.getByTestId('attendance-print').waitFor({ timeout: 5000 });
  await noPageOverflow('Attendance');
});

await check('Timesheets: Preview and Print on the page, no Submit (PAYROLL-ONE-1); the file is named for the To month', async () => {
  await as('Sipho Mahlangu');
  await go('/timesheets');
  await page.getByTestId('timesheet-sheet').waitFor({ timeout: 20000 });
  // PAYROLL-ONE-1: the timesheet is submitted with the attendance on My Monthly Forms — nothing is submitted here.
  if ((await page.getByTestId('timesheet-send').count()) !== 0) fail('the Timesheets page still has Submit');
  await page.getByTestId('timesheet-to-monthly-forms').waitFor({ timeout: 5000 });
  for (const id of ['timesheet-preview', 'timesheet-print']) await page.getByTestId(id).waitFor({ timeout: 5000 });
  if ((await page.getByText(/attendance form|Edit my attendance/iu).count()) !== 0) fail('the Timesheets page carries attendance controls');
  await press(page.getByTestId('timesheet-preview'));
  await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('preview-download').count()) !== 0) fail('the Timesheets preview offers Download');
  await press(page.getByTestId('preview-close'));
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 40 * 86_400_000).toISOString().slice(0, 10);
  const pdf = await call('GET', `/api/timesheets/user-tech-sipho/period/pdf?from=${from}&to=${today}`);
  const name = fileNameOf(pdf.disposition);
  if (name !== `SIPHO Timesheet ${shortMonth(today)} ${today.slice(0, 4)}.pdf`) fail(`file name ${name}`);
  await noPageOverflow('Timesheets');
  return name;
});

await check('Monthly Forms: both completed forms with Download, Save, Preview and Print, one Submit to Office — and a period may be submitted before its month ends', async () => {
  await as('Sipho Mahlangu');
  const from = `${today.slice(0, 7)}-01`;
  // FORM-LIFECYCLE-1: each form completed on its page (here through its request), then both submitted together.
  for (const kind of ['timesheet', 'attendance']) {
    const done = await call('POST', '/api/payroll/forms/user-tech-sipho/complete', { kind, from, to: today, fileName: '', confirmUnrecorded: true, confirmNoLines: true });
    if (done.status !== 200) fail(`completing the ${kind} answered ${done.status} ${JSON.stringify(done.json?.error ?? '')}`);
  }
  await go('/payroll/mine');
  const forms = page.getByTestId('my-monthly-forms');
  await forms.getByTestId('my-forms-submit').waitFor({ timeout: 20000 });
  for (const kind of ['timesheet', 'attendance']) {
    for (const action of ['download', 'export', 'preview', 'print']) await forms.getByTestId(`my-forms-${kind}-${action}`).waitFor({ timeout: 10000 });
  }
  if ((await page.getByText(/has not ended/iu).count()) !== 0) fail('the month-end restriction is still shown');
  const submitted = await completeAndSubmit(call, 'user-tech-sipho', from, today);
  if (submitted.status !== 200) fail(`submitting this month so far answered ${submitted.status} ${JSON.stringify(submitted.json?.error ?? '')}`);
  await noPageOverflow('Monthly Forms');
});

/* ---- Notifications ------------------------------------------------------- */
await check('the Inbox: Jobcards, Messages, Monthly Forms and Standby', async () => {
  await as('Elmarie Coetzee');
  await go('/notifications');
  const boxes = page.getByTestId('inbox-boxes');
  await boxes.waitFor({ timeout: 20000 });
  const labels = (await boxes.locator('[data-testid^="inbox-box-"]').allInnerTexts()).map((text) => text.replace(/\d+/gu, '').trim());
  if (labels.join('|') !== 'Jobcards|Messages|Monthly Forms|Standby') fail(`the boxes are ${labels.join(', ')}`);
  await press(page.getByTestId('inbox-box-standby'));
  await page.getByTestId('inbox-box-standby').waitFor({ timeout: 5000 });
  await noPageOverflow('the Inbox');
  return labels.join(', ');
});

await check('no page errors anywhere in the run', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([kind]) => kind === 'FAIL');
console.log(`\n=== batch ${label}: ${results.length - failed.length} passed, ${failed.length} failed ===`);
for (const [, text] of failed) console.log(` FAIL ${text}`);
process.exit(failed.length === 0 ? 0 : 1);
