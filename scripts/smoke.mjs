/**
 * End-to-end smoke test for the EJE demonstration system.
 *
 * Drives a real browser through the whole job-card journey — sign in, accept,
 * capture labour, write up, sign, review and submit — then checks the
 * simulated outbox, the read-only state of a closed job, the checklist gate,
 * search, the library and the tablet layout.
 *
 * Usage:
 *   npm run build && npm start -- -p 3210
 *   npm run smoke
 *
 * Environment:
 *   EJE_SMOKE_BASE_URL   defaults to http://localhost:3210
 *   EJE_SMOKE_SHOTS      directory for screenshots, defaults to ./.smoke
 *   PLAYWRIGHT_CHROMIUM  explicit Chromium binary, when not managed by Playwright
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.EJE_SMOKE_BASE_URL ?? 'http://localhost:3210';
const shots = process.argv[2] ?? process.env.EJE_SMOKE_SHOTS ?? '.smoke';
mkdirSync(shots, { recursive: true });
const errors = [];
const log = (m) => console.log(m);

const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(
  executablePath === undefined ? {} : { executablePath },
);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

const step = async (name, fn) => {
  try {
    await fn();
    log(`PASS  ${name}`);
  } catch (e) {
    log(`FAIL  ${name} :: ${e.message}`);
    errors.push(`${name}: ${e.message}`);
  }
};

await step('sign in page renders', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 10000 });
});

await step('sign in as technician Sipho Mahlangu', async () => {
  await page.getByRole('tab', { name: 'Technician' }).click();
  await page.getByRole('button', { name: /Sipho Mahlangu/ }).click();
  await page.getByRole('heading', { name: /Hello, Sipho/ }).waitFor({ timeout: 10000 });
});

await step('technician dashboard shows assigned work', async () => {
  await page.getByText('My Jobs').first().waitFor({ timeout: 8000 });
  await page.getByText('EJE-1048').first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/01-tech-dashboard.png`, fullPage: false });
});

await step('EJE-1048 is waiting for acceptance on the technician dashboard', async () => {
  await page.getByText('Waiting for you to accept').waitFor({ timeout: 8000 });
});

await step('open job EJE-1048', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1048' }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/02-job-detail.png`, fullPage: false });
});

await step('capturing work is blocked before the job is accepted', async () => {
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  if (await page.getByRole('button', { name: 'Add labour' }).first().isVisible()) {
    throw new Error('Labour capture should not be offered on an unaccepted job');
  }
  await page.getByRole('tab', { name: 'Overview' }).click();
});

await step('acceptance requires confirmation and starts the job', async () => {
  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByText('there is no separate start step', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByText('In Progress').first().waitFor({ timeout: 10000 });
});

await step('acceptance then OFFERS the site location, rather than sending it', async () => {
  await page.getByRole('heading', { name: 'Send Site Location?' }).waitFor({ timeout: 8000 });
  await page
    .getByText('Would you like to send the site location to the technician via WhatsApp?')
    .waitFor({ timeout: 5000 });

  // The preview must carry everything the technician needs, and a maps link.
  const preview = await page.locator('pre').first().innerText();
  for (const fragment of [
    'EJE-1048',
    'ABC Engineering (Pty) Ltd',
    'Leadwell V-40',
    'Johannesburg',
    'https://www.google.com/maps/dir/?api=1&destination=',
  ]) {
    if (!preview.includes(fragment)) {
      throw new Error(`site location preview missing ${fragment}`);
    }
  }
  await page.screenshot({ path: `${shots}/13-site-location-prompt.png`, fullPage: false });
});

await step('"No, Thanks" sends nothing and leaves the job in progress', async () => {
  await page.getByRole('button', { name: 'No, Thanks' }).click();
  await page.getByRole('heading', { name: 'Send Site Location?' }).waitFor({
    state: 'hidden',
    timeout: 8000,
  });
  await page.getByText('In Progress').first().waitFor({ timeout: 8000 });

  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  const whatsappEntries = await page.getByText('Template: eje_site_location').count();
  if (whatsappEntries !== 0) throw new Error('declining still queued a WhatsApp message');
});

await step('declining is recorded on the job activity trail', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('Site location not requested').first().waitFor({ timeout: 8000 });
});

await step('accepting a second job and choosing "Send Location" queues one message', async () => {
  // EJE-1058 is seeded open; accept it to reach the prompt again.
  await page.goto(`${BASE}/jobs/EJE-1058`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByRole('heading', { name: 'Send Site Location?' }).waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: 'Send Location' }).click();
  await page.getByRole('heading', { name: 'Send Site Location?' }).waitFor({
    state: 'hidden',
    timeout: 8000,
  });
  await page.getByText('Site location queued', { exact: false }).waitFor({ timeout: 8000 });

  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('Site location requested via WhatsApp').first().waitFor({ timeout: 8000 });
});

await step('the queued WhatsApp message appears in the Simulated Outbox', async () => {
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  await page.getByText('Template: eje_site_location').first().waitFor({ timeout: 8000 });
  await page.getByText('Nothing in this list was sent').waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${shots}/14-site-location-outbox.png`, fullPage: false });
});

await step('back to EJE-1048 to continue the main journey', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1048' }).waitFor({ timeout: 8000 });
});

await step('add labour to EJE-1048', async () => {
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByLabel('Description of work').fill('Replaced spindle drive cooling fan');
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Replaced spindle drive cooling fan').waitFor({ timeout: 8000 });
});

await step('labour line is priced', async () => {
  // 2 hrs at R950.00 normal time = R1 900.00
  await page.getByText(/R\u00a01\u00a0900,00/).first().waitFor({ timeout: 8000 });
});

await step('write completion report', async () => {
  await page.getByRole('tab', { name: 'Completion' }).click();
  await page.getByLabel(/Work performed/).fill(
    'Replaced the seized spindle drive cooling fan, cleared alarm 750 and test ran the machine.',
  );
  await page.getByRole('button', { name: 'Save write-up' }).click();
  await page.getByText('Saved').first().waitFor({ timeout: 8000 });
});

await step('move job to completion', async () => {
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Completion').first().waitFor({ timeout: 8000 });
});

await step('start customer signature', async () => {
  await page.getByRole('button', { name: 'Customer signature' }).click();
  await page.waitForURL('**/sign', { timeout: 10000 });
  await page.getByRole('heading', { name: 'Customer signature' }).waitFor({ timeout: 8000 });
  await page.getByText('I confirm that the work described above has been completed.').waitFor();
  await page.screenshot({ path: `${shots}/03-signature.png`, fullPage: false });
});

await step('capture signature', async () => {
  await page.getByLabel('Customer name').fill('Pieter');
  await page.getByLabel('Customer surname').fill('Nel');

  const pad = page.locator('div.touch-none').first();
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.down();
  for (let i = 0; i < 24; i += 1) {
    await page.mouse.move(box.x + 60 + i * 12, box.y + 120 - Math.sin(i / 2) * 40);
  }
  await page.mouse.up();

  await page.getByRole('button', { name: 'Confirm signature' }).click();
  await page.waitForURL('**/review', { timeout: 10000 });
});

await step('job card preview renders real data', async () => {
  await page.getByRole('heading', { name: 'Review job card' }).waitFor({ timeout: 8000 });
  await page.getByText('ABC Engineering (Pty) Ltd').first().waitFor({ timeout: 8000 });
  await page.getByText('LW-V40-70214').first().waitFor({ timeout: 8000 });
  await page.getByText('Replaced the seized spindle drive cooling fan', { exact: false })
    .first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/04-jobcard.png`, fullPage: false });
});

await step('technician hands over for Master review, WITHOUT emailing', async () => {
  await page.getByRole('button', { name: 'Submit for Master Review' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByText('is not emailed at this step', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await page.getByText('With the office for review').first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${shots}/05-master-review.png`, fullPage: false });
});

await step('no customer email has been sent at technician hand-over', async () => {
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  const jobCardEmails = await page.getByText('EJE-1048-Job-Card.pdf').count();
  if (jobCardEmails !== 0) throw new Error('technician hand-over emailed the customer');
});

await step('the job is read-only for the technician while in Master review', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByText('awaiting Master review', { exact: false }).first().waitFor({
    timeout: 8000,
  });
});

await step('a Master can edit the job during review', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('tab', { name: 'Master' }).click();
  await page.getByRole('button', { name: /Elmarie Coetzee/ }).click();

  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByRole('button', { name: 'Add part' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  const partDialog = page.getByRole('dialog');
  await partDialog.getByLabel('Part number').fill('FAN-24V-80');
  await partDialog.getByLabel('Description').fill('Spindle drive cooling fan');
  await partDialog.getByLabel(/Unit price/).fill('485');
  await page.getByRole('button', { name: 'Add part' }).last().click();
  await page.getByText('FAN-24V-80').first().waitFor({ timeout: 8000 });
});

await step('Master submits, which emails the customer and closes the job', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048/review`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Submit Job Card' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByText('Once submitted, this job will be closed', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await page.getByText('submitted and closed', { exact: false }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${shots}/05-submitted.png`, fullPage: false });
});

await step('the customer email appears only after Master submission', async () => {
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  await page.getByText('Nothing in this list was sent').waitFor({ timeout: 8000 });
  await page.getByText('EJE-1048-Job-Card.pdf').first().waitFor({ timeout: 8000 });
});

await step('closed job is read-only', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByText('this job is closed', { exact: false }).first().waitFor({ timeout: 8000 });
});

await step('checklist blocks signature until complete (EJE-1053 service job)', async () => {
  await page.goto(`${BASE}/jobs/EJE-1053`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1053' }).waitFor({ timeout: 8000 });
  await page.getByText('checklist is required for this job type', { exact: false })
    .first().waitFor({ timeout: 8000 });
  const signBtn = page.getByRole('button', { name: 'Customer signature' });
  if (!(await signBtn.isDisabled())) throw new Error('Signature button should be disabled');
});

await step('checklist runner works', async () => {
  await page.getByRole('tab', { name: 'Checklist' }).click();
  await page.getByRole('button', { name: 'Start checklist' }).click();
  await page.getByText('Safety Systems').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Pass', exact: true }).first().click();
  await page.getByText(/1 of \d+ answered/).waitFor({ timeout: 8000 });
  // A new service job must pick up the CURRENT checklist revision.
  await page.getByText('Version 2.0-DEMO').waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/06-checklist.png`, fullPage: false });
});

await step('a failed checklist item demands a note before completion', async () => {
  // Fail the second item; the note field must become required and block progress.
  await page.getByRole('button', { name: 'Fail', exact: true }).nth(1).click();
  await page.getByText('Required — explain the finding').first().waitFor({ timeout: 8000 });
  await page
    .getByText('This item was not passed, so a note is required', { exact: false })
    .first()
    .waitFor({ timeout: 8000 });

  const outstanding = await page.getByText('needs a note explaining what was found').count();
  if (outstanding === 0) throw new Error('outstanding list did not name the item needing a note');

  // Passing items must NOT demand one.
  const optionalLabels = await page.getByText('Optional', { exact: true }).count();
  if (optionalLabels === 0) throw new Error('note fields are not optional on passed items');
});

await step('supplying the note clears the block', async () => {
  const noteBoxes = page.locator('textarea[aria-invalid="true"]');
  await noteBoxes.first().fill('Station 2 emergency stop does not latch — replacement ordered.');
  await noteBoxes.first().blur();
  await page.getByText('Required — explain the finding').first().waitFor({ timeout: 8000 });
  const stillInvalid = await page.locator('textarea[aria-invalid="true"]').count();
  if (stillInvalid !== 0) throw new Error('note was recorded but the item is still flagged');
});

await step('a Parts job offers no labour, travel or call-out capture', async () => {
  await page.goto(`${BASE}/jobs/EJE-1064`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1064' }).first().waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: /^Parts/ }).click();
  await page.getByText('carries no labour, travel or call-out fee', { exact: false })
    .waitFor({ timeout: 8000 });
  if (await page.getByRole('button', { name: 'Add labour' }).count() > 0) {
    throw new Error('a parts collection offered labour capture');
  }
  if (await page.getByRole('button', { name: 'Add travel' }).count() > 0) {
    throw new Error('a parts collection offered travel capture');
  }
  if (await page.getByText('Charge the call-out fee').count() > 0) {
    throw new Error('a parts collection offered a call-out fee');
  }
});

await step('accepting a Parts job does NOT offer the site location', async () => {
  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByText('In Progress').first().waitFor({ timeout: 10000 });
  // Parts leave the EJE counter, so there is no site to send anyone to.
  if (await page.getByText('Send Site Location?').count() > 0) {
    throw new Error('a parts collection offered to send a site location');
  }
});

await step('the collector, not the customer, signs for parts', async () => {
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByRole('button', { name: /signature/i }).first().click();
  await page.waitForURL('**/sign', { timeout: 10000 });
  await page.getByRole('heading', { name: 'Collector signature' }).waitFor({ timeout: 8000 });
  await page.getByText('I confirm that I have collected the parts listed above.').waitFor();
  await page.getByLabel('Collector name').waitFor();
  await page.getByLabel('Collector surname').waitFor();
  // Nothing about completed work: a collection acknowledges receipt of goods.
  if (await page.getByText('I confirm that the work described above has been completed.').count() > 0) {
    throw new Error('the parts collector was shown the work-completed declaration');
  }
  await page.screenshot({ path: `${shots}/13-collector-signature.png`, fullPage: false });
});

await step('capturing the collector signature produces a collection note', async () => {
  await page.getByLabel('Collector name').fill('Thabo');
  await page.getByLabel('Collector surname').fill('Dlamini');

  const pad = page.locator('div.touch-none').first();
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 110);
  await page.mouse.down();
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.move(box.x + 60 + i * 14, box.y + 110 - Math.sin(i / 2) * 35);
  }
  await page.mouse.up();

  await page.getByRole('button', { name: 'Confirm collection' }).click();
  await page.waitForURL('**/review', { timeout: 10000 });
  await page.getByText('Parts Collection Note').first().waitFor({ timeout: 8000 });
  await page.getByText('OKA-WW-320').first().waitFor({ timeout: 8000 });
  await page.getByText('Thabo').first().waitFor({ timeout: 8000 });
});

await step('a customer collection note SHOWS prices', async () => {
  await page.goto(`${BASE}/jobs/EJE-1062/review`, { waitUntil: 'networkidle' });
  await page.getByText('Parts Collection Note').first().waitFor({ timeout: 10000 });
  await page.getByText('LW-CLT-220').first().waitFor({ timeout: 8000 });
  // R 485,00 x 2 plus R 1 320,00 = R 2 290,00
  await page.getByText('R\u00a02\u00a0290,00').first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/14-parts-customer.png`, fullPage: false });
});

await step('a COURIER collection note carries no prices at all', async () => {
  await page.goto(`${BASE}/jobs/EJE-1063/review`, { waitUntil: 'networkidle' });
  await page.getByText('Delivery Note').first().waitFor({ timeout: 10000 });
  await page.getByText('SIE-6SL3-0.75').first().waitFor({ timeout: 8000 });
  await page.getByText('Prices are not shown on a courier collection note.').waitFor();

  const note = await page.locator('article').first().innerText();
  if (/R\u00a0\d/.test(note)) {
    throw new Error(`a price leaked onto the courier note: ${note.match(/R\u00a0[\d\u00a0,]+/)?.[0]}`);
  }
  if (note.includes('Unit price')) {
    throw new Error('the courier note kept its unit price column');
  }
  await page.screenshot({ path: `${shots}/15-parts-courier.png`, fullPage: false });
});

await step('the courier job still holds its prices internally', async () => {
  await page.goto(`${BASE}/jobs/EJE-1063`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /^Parts/ }).click();
  // Withheld from the customer-facing document, never deleted from the job.
  await page.getByText('SIE-6SL3-0.75').first().waitFor({ timeout: 8000 });
  await page.getByText('R\u00a012\u00a0400,00').first().waitFor({ timeout: 8000 });
});

await step('master dashboard and admin', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('tab', { name: 'Master' }).click();
  await page.getByRole('button', { name: /Elmarie Coetzee/ }).click();
  await page.getByRole('heading', { name: /Good day, Elmarie/ }).waitFor({ timeout: 10000 });
  await page.getByText('Total Open Jobs').waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/07-master-dashboard.png`, fullPage: false });
});

await step('a Master can add a customer, with its first site', async () => {
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add customer' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });

  await dialog.getByLabel('Company name').fill('Zenith Precision Works');
  await dialog.getByLabel('Account number').fill('ZEN001');
  await dialog.getByLabel('Industry').fill('Precision machining');
  await dialog.getByLabel('Site name').fill('Zenith Germiston');
  await dialog.getByLabel('City / town').fill('Germiston');
  await dialog.getByLabel('Street address').fill('22 Anvil Street');
  await dialog.getByLabel('First name').fill('Marlize');
  await dialog.getByLabel('Surname').fill('Botha');

  await dialog.getByRole('button', { name: 'Create customer' }).click();
  await page.waitForURL('**/customers/**', { timeout: 10000 });
  await page.getByRole('heading', { name: 'Zenith Precision Works' }).first()
    .waitFor({ timeout: 10000 });
});

await step('the new customer is selectable when raising a job', async () => {
  await page.goto(`${BASE}/jobs/new`, { waitUntil: 'networkidle' });
  const options = await page.locator('select').first().locator('option').allTextContents();
  if (!options.some((option) => option.includes('Zenith Precision Works'))) {
    throw new Error('a newly created customer was not offered on the new job screen');
  }
});

await step('a Master can add a machine, which lands on the register confirmed', async () => {
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.getByText('ABC Engineering (Pty) Ltd').first().click();
  await page.getByRole('tab', { name: /Machines/ }).click();
  await page.getByRole('button', { name: 'Add machine' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Manufacturer').fill('Mazak');
  await dialog.getByLabel('Model').fill('QT-200');
  await dialog.getByLabel('Serial number').fill('MZ-QT200-11902');
  await dialog.getByRole('button', { name: 'Add machine' }).click();

  await page.getByText('MZ-QT200-11902').first().waitFor({ timeout: 10000 });
});

await step('a duplicate serial number is refused', async () => {
  await page.getByRole('button', { name: 'Add machine' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Manufacturer').fill('Mazak');
  await dialog.getByLabel('Model').fill('QT-250');
  // The serial already on the register, in a different case.
  await dialog.getByLabel('Serial number').fill('mz-qt200-11902');
  await dialog.getByRole('button', { name: 'Add machine' }).click();

  await dialog.getByText('is already on the register', { exact: false })
    .waitFor({ timeout: 8000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await step('a technician-added machine is waiting for the Master to confirm', async () => {
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.getByText('Vaal Toolroom Services').first().click();
  await page.getByRole('tab', { name: /Machines/ }).click();
  await page.getByText('Awaiting approval').first().waitFor({ timeout: 8000 });
  await page.getByRole('heading', { name: 'Awaiting your approval' }).waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: 'Confirm on register' }).first().click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('Awaiting your approval'),
    { timeout: 10000 },
  );
});

await step('disabled users are kept out of the default user list', async () => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Active users/ }).waitFor({ timeout: 10000 });

  const active = await page.locator('table').first().innerText();
  if (active.includes('Yusuf Patel')) {
    throw new Error('a disabled user appeared in the active list');
  }

  await page.getByRole('tab', { name: /Disabled users/ }).click();
  await page.getByText('Yusuf Patel').first().waitFor({ timeout: 8000 });
});

await step('a Master cannot edit another Master', async () => {
  await page.getByRole('tab', { name: /Active users/ }).click();
  const denise = page.getByRole('row').filter({ hasText: 'Denise' }).first();
  await denise.waitFor({ timeout: 8000 });
  await denise.getByText('Master accounts cannot be edited by another Master')
    .waitFor({ timeout: 8000 });
  if (await denise.getByRole('button', { name: 'Disable' }).count() > 0) {
    throw new Error('a Master was offered a control to disable another Master');
  }
});

await step('a Master can add and then disable a technician', async () => {
  await page.getByRole('button', { name: 'Add user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('First name').fill('Nomvula');
  await dialog.getByLabel('Surname').fill('Khumalo');
  await dialog.getByLabel('Email').fill('nomvula.khumalo@eje-demo.co.za');
  await dialog.getByRole('button', { name: 'Create user' }).click();

  const row = page.getByRole('row').filter({ hasText: 'Nomvula Khumalo' }).first();
  await row.waitFor({ timeout: 10000 });

  await row.getByRole('button', { name: 'Disable' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disable user' }).click();

  await page.waitForFunction(
    () => !document.querySelector('table')?.innerText.includes('Nomvula Khumalo'),
    { timeout: 10000 },
  );
  await page.getByRole('tab', { name: /Disabled users/ }).click();
  await page.getByText('Nomvula Khumalo').first().waitFor({ timeout: 8000 });
});

await step('a Master can approve a technician document upload', async () => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Technical Library' }).click();
  await page.getByText('waiting for approval', { exact: false }).waitFor({ timeout: 10000 });

  const pending = page.getByRole('row').filter({ hasText: 'Amada HFE-1303' }).first();
  await pending.getByRole('button', { name: 'Approve' }).click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('waiting for approval'),
    { timeout: 10000 },
  );
});

await step('a used checklist version cannot be edited, only re-versioned', async () => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Checklists' }).click();
  await page.getByText('has been completed on a job', { exact: false })
    .first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${shots}/16-checklist-admin.png`, fullPage: false });
});

await step('a historical job card still renders the version it was answered against', async () => {
  // EJE-1044 was serviced six months ago against checklist v1.0-DEMO, while
  // v2.0-DEMO is the version issued to new jobs today.
  await page.goto(`${BASE}/jobs/EJE-1044/review`, { waitUntil: 'networkidle' });
  await page.getByText('1.0-DEMO', { exact: false }).first().waitFor({ timeout: 10000 });
});

await step('global search finds by serial number', async () => {
  await page.goto(`${BASE}/search?q=LW-V40-70214`, { waitUntil: 'networkidle' });
  await page.getByText('Machines').first().waitFor({ timeout: 8000 });
  await page.getByText('Leadwell V-40').first().waitFor({ timeout: 8000 });
});

await step('technical library preview', async () => {
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
  await page.getByText('Leadwell V-40 Machine Manual').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Open' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${shots}/08-library.png`, fullPage: false });
});

await step('calendar shows jobs, multi-day service and leave', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 10000 });

  // Month view by default, with the seeded multi-day service visible.
  await page.getByRole('tab', { name: 'Month' }).waitFor({ timeout: 8000 });
  await page.getByText('EJE-1049').first().waitFor({ timeout: 8000 });

  // A multi-day bar must be visibly wider than a single-day one.
  // A multi-day bar is legitimately split when it crosses a week boundary, so
  // compare the widest fragment.
  const widest = async (selector) => {
    const boxes = await page.locator(selector).all();
    let max = 0;
    for (const box of boxes) {
      const rect = await box.boundingBox();
      if (rect !== null) max = Math.max(max, rect.width);
    }
    return max;
  };

  const multiDay = await widest('a[href="/jobs/EJE-1049"]');
  const single = await widest('a[href="/jobs/EJE-1048"]');
  if (multiDay === 0 || single === 0) throw new Error('calendar bars not rendered');
  if (multiDay <= single) {
    throw new Error(
      `multi-day service (${multiDay}px) does not span more than a single-day job (${single}px)`,
    );
  }

  await page.screenshot({ path: `${shots}/15-calendar-month.png`, fullPage: false });
});

await step('calendar shows technician leave and sick leave', async () => {
  const leaveChips = await page.getByText('Leave', { exact: true }).count();
  const sickChips = await page.getByText('Sick', { exact: true }).count();
  if (leaveChips === 0) throw new Error('no annual leave on the calendar');
  if (sickChips === 0) throw new Error('no sick leave on the calendar');
});

await step('calendar has day, week, month and year views', async () => {
  for (const view of ['Day', 'Week', 'Year', 'Month']) {
    await page.getByRole('tab', { name: view }).click();
    await page.waitForTimeout(250);
    const selected = await page.getByRole('tab', { name: view }).getAttribute('aria-selected');
    if (selected !== 'true') throw new Error(`${view} view did not activate`);
  }

  await page.getByRole('tab', { name: 'Week' }).click();
  await page.screenshot({ path: `${shots}/16-calendar-week.png`, fullPage: false });
  await page.getByRole('tab', { name: 'Year' }).click();
  await page.screenshot({ path: `${shots}/17-calendar-year.png`, fullPage: false });
});

await step('clicking a day opens the day view with its work and availability', async () => {
  await page.getByRole('tab', { name: 'Month' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByRole('tab', { name: 'Day' }).click();
  await page.getByRole('heading', { name: /^Scheduled work/ }).waitFor({ timeout: 8000 });
  await page.getByRole('heading', { name: /^Technician availability/ }).waitFor({
    timeout: 8000,
  });
  await page.screenshot({ path: `${shots}/18-calendar-day.png`, fullPage: false });
});

await step('Machines is no longer a top-level navigation item', async () => {
  const machinesNav = await page
    .locator('nav a[href="/machines"]')
    .count();
  if (machinesNav !== 0) throw new Error('Machines is still in the sidebar');

  // The machine screens still work, and search still finds machines.
  await page.goto(`${BASE}/machines/machine-abc-lv40`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Leadwell V-40/ }).waitFor({ timeout: 8000 });
});

await step('tablet viewport layout', async () => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto(`${BASE}/jobs/EJE-1049`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1049' }).waitFor({ timeout: 8000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (overflow) throw new Error('horizontal overflow at 820px');
  await page.screenshot({ path: `${shots}/09-tablet.png`, fullPage: false });
});


// --- Theme -----------------------------------------------------------------
// Chromium returns computed colours in lab(), so every colour below is resolved
// to sRGB by painting it to a canvas rather than parsed out of the string.
const TO_RGB = `(value) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}`;

const relativeLuminance = `(rgb) => {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}`;

const themeState = () =>
  page.evaluate(
    ([toRgbSrc, lumSrc]) => {
      const toRgb = eval(toRgbSrc);
      const luminance = eval(lumSrc);
      const body = getComputedStyle(document.body);
      const heading = document.querySelector('h1');
      const bg = toRgb(body.backgroundColor);
      const result = {
        theme: document.documentElement.dataset.theme,
        colorScheme: body.colorScheme,
        bgLuminance: luminance(bg),
        headingContrast: null,
      };
      if (heading !== null) {
        const fg = luminance(toRgb(getComputedStyle(heading).color));
        const [hi, lo] = fg > result.bgLuminance ? [fg, result.bgLuminance] : [result.bgLuminance, fg];
        result.headingContrast = (hi + 0.05) / (lo + 0.05);
      }
      return result;
    },
    [TO_RGB, relativeLuminance],
  );

await step('light is the default theme', async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const state = await themeState();
  if (state.theme !== 'light') throw new Error(`expected light by default, got ${state.theme}`);
  if (state.bgLuminance < 0.7) throw new Error('light background is not light');
});

await step('switching to dark re-themes the application', async () => {
  const before = await themeState();

  await page.getByRole('button', { name: /Switch to dark mode/ }).first().click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');

  const after = await themeState();
  if (after.bgLuminance >= before.bgLuminance) throw new Error('background did not darken');
  if (after.bgLuminance > 0.12) throw new Error(`dark background too light: ${after.bgLuminance}`);
  if (!after.colorScheme.includes('dark')) throw new Error('color-scheme not set to dark');

  await page.screenshot({ path: `${shots}/10-dark-dashboard.png`, fullPage: false });
});

await step('the sidebar control reflects the active theme', async () => {
  const pressed = await page
    .getByRole('radio', { name: 'Dark theme' })
    .first()
    .getAttribute('aria-checked');
  if (pressed !== 'true') throw new Error(`sidebar control out of sync: ${pressed}`);
});

await step('dark mode survives a full reload, applied before hydration', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const immediate = await page.evaluate(() => document.documentElement.dataset.theme);
  if (immediate !== 'dark') throw new Error(`theme lost on reload, got ${immediate}`);

  await page.waitForLoadState('networkidle');
  const settled = await page.evaluate(() => document.documentElement.dataset.theme);
  if (settled !== 'dark') throw new Error('theme reverted after hydration');
});

await step('dark mode applies across every major screen', async () => {
  for (const path of [
    '/jobs',
    '/jobs/EJE-1049',
    '/customers/cust-abc',
    '/machines',
    '/library',
    '/search?q=Leadwell',
    '/notifications',
    '/activity',
    '/schedule',
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    const state = await themeState();
    if (state.theme !== 'dark') throw new Error(`${path} lost the dark theme`);
    if (state.bgLuminance > 0.12) throw new Error(`${path} did not darken`);
    if (!state.colorScheme.includes('dark')) {
      throw new Error(`${path} did not set color-scheme for native controls`);
    }
    if (state.headingContrast !== null && state.headingContrast < 4.5) {
      throw new Error(
        `${path} heading contrast only ${state.headingContrast.toFixed(2)}:1`,
      );
    }
  }
});

await step('admin screens render in dark for a Master', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('tab', { name: 'Master' }).click();
  await page.getByRole('button', { name: /Elmarie Coetzee/ }).click();
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });

  const state = await themeState();
  if (state.theme !== 'dark') throw new Error('admin lost the dark theme');
  if (state.headingContrast < 4.5) {
    throw new Error(`admin heading contrast only ${state.headingContrast.toFixed(2)}:1`);
  }
  await page.screenshot({ path: `${shots}/11-dark-admin.png`, fullPage: false });
});

await step('the job card preview stays light, because it represents paper', async () => {
  await page.goto(`${BASE}/jobs/EJE-1054/review`, { waitUntil: 'networkidle' });
  const documentRgb = await page.evaluate(
    (toRgbSrc) => {
      const toRgb = eval(toRgbSrc);
      const article = document.querySelector('article[data-theme="light"]');
      return article === null ? null : toRgb(getComputedStyle(article).backgroundColor);
    },
    TO_RGB,
  );
  if (documentRgb === null) throw new Error('job card document not found');
  if (documentRgb.r < 240 || documentRgb.g < 240 || documentRgb.b < 240) {
    throw new Error(`job card should stay white, got ${JSON.stringify(documentRgb)}`);
  }
  await page.screenshot({ path: `${shots}/12-dark-jobcard.png`, fullPage: false });
});

await step('returning to light mode persists across a reload', async () => {
  await page.getByRole('button', { name: /Switch to light mode/ }).first().click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

  await page.reload({ waitUntil: 'domcontentloaded' });
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  if (after !== 'light') throw new Error(`expected light after reload, got ${after}`);

  const state = await themeState();
  if (state.bgLuminance < 0.7) throw new Error('light mode did not restore');
});

await browser.close();

console.log('\n=== SUMMARY ===');
if (errors.length === 0) {
  console.log('ALL CHECKS PASSED, no console/page errors');
} else {
  console.log(`${errors.length} problem(s):`);
  errors.forEach((e) => console.log(' - ' + e));
  process.exitCode = 1;
}
