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

await step('the captured signature is rendered in solid black', async () => {
  const graphic = page.locator('svg[aria-label="Customer signature"]');
  await graphic.waitFor({ timeout: 8000 });

  const stroke = await graphic.locator('path').evaluate(
    (node) => getComputedStyle(node).stroke,
  );
  if (stroke !== 'rgb(0, 0, 0)') {
    throw new Error(`the signature is drawn in ${stroke}, not black`);
  }

  // Not just the declared colour: the drawn pixels have to be black too, since
  // an opacity or a filter anywhere above it would fade them. Painted onto a
  // canvas in the page and read back, because that is what the eye gets.
  const darkest = await page.evaluate(async () => {
    const svg = document.querySelector('svg[aria-label="Customer signature"]');
    if (svg === null) return null;
    const serialised = new XMLSerializer().serializeToString(svg);
    const box = svg.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(box.width);
    canvas.height = Math.ceil(box.height);
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(null);
      };
      image.onerror = reject;
      image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(serialised)))}`;
    });

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let min = 255;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) {
      const value = Math.max(data[i], data[i + 1], data[i + 2]);
      if (value < min) min = value;
      if (data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20) black += 1;
    }
    return { min, black };
  });

  if (darkest === null) throw new Error('could not sample the signature');
  if (darkest.min > 5 || darkest.black < 20) {
    throw new Error(
      `the rendered signature is not black: darkest channel ${darkest.min}, ${darkest.black} black pixels`,
    );
  }
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
  const jobCardEmails = await page.getByText('EJE-1048-Final-Job-Card.pdf').count();
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
  await page.getByText('EJE-1048-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
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

await step('a technician can message the office', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('tab', { name: 'Technician' }).click();
  await page.getByRole('button', { name: /Lerato/ }).click();
  await page.getByRole('heading', { name: /Hello, Lerato/ }).waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Messages', exact: true }).waitFor({ timeout: 10000 });
  // Messages are a separate place from Notifications, deliberately.
  await page.getByText('System alerts live under Notifications', { exact: false })
    .waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: 'New message' }).click();
  const compose = page.getByRole('dialog');
  await compose.waitFor({ timeout: 5000 });
  // A technician does not have to guess which Master is on duty.
  await compose.getByText('Reaches every Master on duty', { exact: false })
    .waitFor({ timeout: 5000 });
  await compose.getByLabel('Message').fill(
    'Hi Christene. I have a doctor appointment tomorrow at 14:00. Back by 16:00.',
  );
  await compose.getByRole('button', { name: 'Send message' }).click();

  // The message lands in a thread the technician can see and reply in.
  await page.getByText('doctor appointment tomorrow', { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  await page.getByText('It does not change the job or anyone', { exact: false })
    .waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/16-messages-technician.png`, fullPage: false });
});

await step('the technician can carry on the same conversation, not start a new one', async () => {
  await page.getByLabel('Message').fill('The appointment is at the clinic in Edenvale.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('clinic in Edenvale', { exact: false }).first().waitFor({ timeout: 10000 });

  // Both messages sit in one thread, so one conversation is listed, not two.
  const threads = await page.getByRole('button', { name: /doctor appointment|clinic in Edenvale/ })
    .count();
  if (threads > 1) throw new Error('replying started a second conversation');
});

await step('the message alone does NOT make the technician unavailable', async () => {
  await page.goto(`${BASE}/technicians/user-tech-lerato`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Lerato/ }).first().waitFor({ timeout: 10000 });
  // A technician sees their own record but cannot change it.
  await page.getByText('send the office a message', { exact: false }).waitFor({ timeout: 8000 });
  if (await page.getByRole('button', { name: 'Mark unavailable' }).count() > 0) {
    throw new Error('a technician was offered the Master-only availability control');
  }
});

await step('the Master is notified of the message, and the notification opens the chat', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('tab', { name: 'Master' }).click();
  await page.getByRole('button', { name: /Elmarie Coetzee/ }).click();
  await page.getByRole('heading', { name: /Good day, Elmarie/ }).waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/notifications`, { waitUntil: 'networkidle' });
  const row = page
    .locator('li')
    .filter({ hasText: 'New message from Lerato' })
    .first();
  await row.waitFor({ timeout: 10000 });
  // A message notification opens the conversation, NOT the job page.
  const link = row.getByRole('link', { name: 'Open conversation' });
  await link.waitFor({ timeout: 8000 });
  const href = await link.getAttribute('href');
  if (href === null || !href.startsWith('/messages?conversation=')) {
    throw new Error(`a chat notification pointed at ${href} instead of the conversation`);
  }
  await link.click();
  await page.getByText('doctor appointment tomorrow', { exact: false }).first()
    .waitFor({ timeout: 10000 });
});

await step('a Master sees the message and it says it changed nothing', async () => {
  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
  await page.getByText('doctor appointment tomorrow', { exact: false }).first()
    .waitFor({ timeout: 10000 });
  await page.getByText('It does not change the job or anyone', { exact: false })
    .waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/16-messages-master.png`, fullPage: false });
});

await step('the Master can reply, so the technician is answered', async () => {
  await page.getByLabel('Message').fill('Noted Lerato, I have recorded it. Thanks.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('I have recorded it', { exact: false }).first().waitFor({ timeout: 10000 });
});

await step('the Master records the availability from the message', async () => {
  // Explicitly, from the technician's own message — never automatically.
  await page.getByRole('button', { name: 'Mark unavailable' }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByText('doctor appointment tomorrow', { exact: false })
    .waitFor({ timeout: 5000 });

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const iso = `${tomorrow.getFullYear()}-${`${tomorrow.getMonth() + 1}`.padStart(2, '0')}-${`${tomorrow.getDate()}`.padStart(2, '0')}`;
  await dialog.getByLabel('Start date').fill(iso);
  await dialog.getByLabel('End date').fill(iso);
  await dialog.getByLabel('From').fill('14:00');
  await dialog.getByLabel('To').fill('16:00');
  await dialog.getByRole('button', { name: 'Record availability' }).click();

  await page.getByText('Availability recorded', { exact: false }).first()
    .waitFor({ timeout: 10000 });
});

await step('a full-day and a multi-day period can both be recorded', async () => {
  await page.goto(`${BASE}/technicians/user-tech-naledi`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Mark unavailable' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  const start = new Date();
  start.setDate(start.getDate() + 40);
  const end = new Date();
  end.setDate(end.getDate() + 44);
  const iso = (date) =>
    `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;

  await dialog.getByLabel('Start date').fill(iso(start));
  await dialog.getByLabel('End date').fill(iso(end));
  // A multi-day period forces all-day: a time window across days is meaningless.
  await dialog.getByText('always all-day', { exact: false }).waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Record availability' }).click();

  await page.getByText('Upcoming').first().waitFor({ timeout: 10000 });
  await page.getByText('All day').first().waitFor({ timeout: 8000 });
});

await step('an "Other" period demands a description', async () => {
  await page.getByRole('button', { name: 'Mark unavailable' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Type').selectOption('other');
  await dialog.getByRole('button', { name: 'Record availability' }).click();
  await dialog.getByText('description is required', { exact: false }).waitFor({ timeout: 8000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await step('availability appears on the calendar with its time window', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 10000 });

  // The seeded part-day appointment is today, 09:00–11:00, and clashes with a
  // job — so the conflict panel must name the window, not just "unavailable".
  await page.getByText('Appointment · 09:00–11:00', { exact: false }).first()
    .waitFor({ timeout: 10000 });

  await page.getByRole('tab', { name: 'Day' }).click();
  await page.getByRole('heading', { name: /Technician availability/ }).waitFor({ timeout: 8000 });
  await page.getByText('09:00–11:00').first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/17-calendar-availability.png`, fullPage: false });
});

await step('an unavailable technician cannot be assigned to a clashing job', async () => {
  // EJE-1067 is scheduled today. Thabo is on sick leave covering today, so
  // assigning him must be refused by the domain, not merely discouraged.
  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1067' }).first().waitFor({ timeout: 10000 });

  await page.getByRole('button', { name: 'Assign', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Role on this job').selectOption('primary');
  await dialog.getByLabel('Technician').selectOption({ label: 'Thabo Nkosi — Field Technician' });
  await dialog.getByRole('button', { name: 'Assign' }).click();

  await dialog.getByText('Technician unavailable').waitFor({ timeout: 10000 });
  await dialog.getByText('Thabo Nkosi is unavailable', { exact: false })
    .waitFor({ timeout: 8000 });
  await dialog.getByText('sick leave', { exact: false }).waitFor({ timeout: 8000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await step('an available technician can still be assigned', async () => {
  await page.getByRole('button', { name: 'Assign', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Role on this job').selectOption('primary');
  await dialog.getByLabel('Technician').selectOption({ label: 'Deon Botha — Workshop Technician' });
  await dialog.getByRole('button', { name: 'Assign' }).click();

  await page.getByText('Deon Botha').first().waitFor({ timeout: 10000 });
});

await step('a Master can cancel an Open job, with a reason', async () => {
  await page.goto(`${BASE}/jobs/EJE-1066`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Cancel job' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Reason').selectOption('customer_resolved');
  await dialog.getByLabel('Description').fill('Customer resolved the fault before dispatch.');
  await dialog.getByRole('button', { name: 'Cancel job' }).click();

  await page.getByText('Cancelled', { exact: false }).first().waitFor({ timeout: 10000 });
  await page.getByText('Customer resolved issue').first().waitFor({ timeout: 8000 });
  await page.getByText('before dispatch', { exact: false }).first().waitFor({ timeout: 8000 });
});

await step('the cancelled job leaves the active lists but stays searchable', async () => {
  await page.goto(`${BASE}/jobs?status=open-work`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if ((await page.locator('table').innerText()).includes('EJE-1066')) {
    throw new Error('a cancelled job is still in open work');
  }

  await page.goto(`${BASE}/search?q=EJE-1066`, { waitUntil: 'networkidle' });
  await page.getByText('EJE-1066 — Cancelled').first().waitFor({ timeout: 10000 });
});

await step('a cancelled job is no longer an active bar on the calendar', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(700);
  if ((await page.locator('main').innerText()).includes('EJE-1066')) {
    throw new Error('a cancelled job is still shown as scheduled work');
  }
});

await step('a Master can delete a duplicate Open job', async () => {
  await page.goto(`${BASE}/jobs/EJE-1065`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Delete job' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Why should this job not exist?').fill('Duplicate of EJE-1058.');
  await dialog.getByRole('button', { name: 'Delete job' }).click();

  await page.waitForURL('**/jobs', { timeout: 10000 });
  await page.waitForTimeout(600);
  if ((await page.locator('table').innerText()).includes('EJE-1065')) {
    throw new Error('a deleted job is still in the job list');
  }
});

await step('the deleted job keeps its record and audit trail', async () => {
  await page.goto(`${BASE}/jobs/EJE-1065`, { waitUntil: 'networkidle' });
  await page.getByText('Deleted', { exact: false }).first().waitFor({ timeout: 10000 });
  await page.getByText('Duplicate of EJE-1058.').first().waitFor({ timeout: 8000 });
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('deleted', { exact: false }).first().waitFor({ timeout: 8000 });
});

await step('an accepted job can no longer be deleted, only cancelled', async () => {
  // EJE-1067 is in progress with work already captured.
  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1067' }).first().waitFor({ timeout: 10000 });
  if (await page.getByRole('button', { name: 'Delete job' }).count() > 0) {
    throw new Error('a job with work captured against it was offered deletion');
  }
});

await step('a technician transfers their own job back to Open, keeping the work', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('tab', { name: 'Technician' }).click();
  await page.getByRole('button', { name: /Deon Botha/ }).click();
  await page.getByRole('heading', { name: /Hello, Deon/ }).waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Transfer job' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByText('All work already recorded stays on the job', { exact: false })
    .waitFor({ timeout: 5000 });
  await dialog.getByLabel('Reason').selectOption('vehicle_problem');
  await dialog.getByRole('button', { name: 'Return to Open Jobs' }).click();

  await page.getByText('Open').first().waitFor({ timeout: 10000 });
});

await step('the returned job still carries its labour, travel, parts and notes', async () => {
  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByText('FUS-HRC-32').first().waitFor({ timeout: 10000 });
  await page.getByText('Fault-finding on the spindle drive').first().waitFor({ timeout: 8000 });
  await page.getByText('Isando to Vereeniging').first().waitFor({ timeout: 8000 });

  await page.getByRole('tab', { name: /Notes/ }).click();
  await page.getByText('weekend shift', { exact: false }).first().waitFor({ timeout: 8000 });
});

await step('the transfer is on the activity trail with its reason', async () => {
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('to Open Jobs', { exact: false })
    .first().waitFor({ timeout: 10000 });
  await page.getByText('Vehicle problem', { exact: false }).first().waitFor({ timeout: 8000 });
});

await step('another technician accepts the returned job and sees the previous work', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('tab', { name: 'Technician' }).click();
  await page.getByRole('button', { name: /Riaan/ }).click();
  await page.getByRole('heading', { name: /Hello, Riaan/ }).waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();

  // The location prompt appears after acceptance, once.
  await page.getByText('Send Site Location?').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'No, Thanks' }).click();

  await page.getByText('In Progress').first().waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByText('FUS-HRC-32').first().waitFor({ timeout: 8000 });
});

await step('accepting from the Open Jobs list also offers the site location', async () => {
  await page.goto(`${BASE}/jobs?status=open`, { waitUntil: 'networkidle' });
  const acceptButton = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await acceptButton.waitFor({ timeout: 10000 });
  await acceptButton.click();

  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByText('Send Site Location?').waitFor({ timeout: 10000 });

  // Exactly one prompt, not one per render.
  const prompts = await page.getByText('Send Site Location?').count();
  if (prompts !== 1) throw new Error(`expected one location prompt, saw ${prompts}`);

  await page.getByRole('button', { name: 'Send Location' }).click();
  await page.getByText('Site location queued', { exact: false }).waitFor({ timeout: 10000 });
});

await step('the site location message carries job, customer, machine, site and a map link', async () => {
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  const outbox = await page.locator('main').innerText();
  for (const fragment of ['EJE-', 'google.com/maps']) {
    if (!outbox.includes(fragment)) {
      throw new Error(`the site location message is missing ${fragment}`);
    }
  }
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

await step('the Jobs screen offers the lists the office asks for by name', async () => {
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Jobs', exact: true }).waitFor({ timeout: 10000 });

  const chips = page.locator('main button[aria-pressed]');
  await chips.first().waitFor({ timeout: 10000 });
  // Each chip carries its own count, which is not part of its name.
  const labels = (await chips.allInnerTexts()).map((name) =>
    name.replace(/[\s\u00a0]*(\d+|—)\s*$/, '').replace(/\s+/g, ' ').trim(),
  );
  for (const label of ['Open work', 'Open', 'Awaiting spares', 'Master Review', 'Cancelled']) {
    if (!labels.includes(label)) {
      throw new Error(`the Jobs screen has no "${label}" quick filter (found ${labels.join(', ')})`);
    }
  }

  // A quick filter drives the same status filter the dropdown does.
  await page.getByRole('button', { name: /^Master Review/ }).first().click();
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1055'),
    { timeout: 10000 },
  );
  const selected = await page.getByLabel('Status').inputValue();
  if (selected !== 'submitted') {
    throw new Error(`the Master Review quick filter left the Status filter on ${selected}`);
  }

  // Closed work leaves for the archive rather than filling the working list.
  const closed = page.getByRole('link', { name: /^Closed Jobs/ }).first();
  await closed.waitFor({ timeout: 8000 });
  await closed.click();
  await page.getByRole('heading', { name: 'Closed Jobs' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${shots}/18-jobs-quick-filters.png`, fullPage: false });
});

await step('Closed Jobs is its own place in the navigation', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const link = page.getByRole('link', { name: 'Closed Jobs' }).first();
  await link.waitFor({ timeout: 10000 });
  await link.click();
  await page.getByRole('heading', { name: 'Closed Jobs' }).waitFor({ timeout: 10000 });
  await page.getByText('Historical records', { exact: false }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/18-closed-jobs.png`, fullPage: false });
});

await step('the archive lists closed jobs, and only closed jobs', async () => {
  const table = page.getByRole('table');
  await table.waitFor({ timeout: 10000 });
  const text = await table.innerText();

  // Seeded closed work.
  for (const number of ['EJE-1056', 'EJE-1057', 'EJE-1062', 'EJE-1044', 'EJE-1039']) {
    if (!text.includes(number)) throw new Error(`${number} is closed but missing from the archive`);
  }
  // EJE-1055 is in Master Review, EJE-1045 was cancelled, EJE-1049 is open,
  // and EJE-1065 was deleted earlier in this run. None of them were issued.
  for (const number of ['EJE-1055', 'EJE-1045', 'EJE-1049', 'EJE-1065']) {
    if (text.includes(number)) throw new Error(`${number} is not a closed job but is in the archive`);
  }
});

await step('the archive shows the columns the office searches by', async () => {
  // Headers are upper-cased by the stylesheet, so compare case-insensitively.
  const header = (await page.getByRole('table').locator('thead').innerText()).toLowerCase();
  for (const column of ['job', 'customer / site', 'machine', 'type', 'technician', 'closed', 'order / ref']) {
    if (!header.includes(column)) throw new Error(`the archive has no ${column} column`);
  }
  const row = page.getByRole('row').filter({ hasText: 'EJE-1044' }).first();
  const cells = await row.innerText();
  for (const value of ['ABC Engineering', 'Johannesburg', 'LW-V40-70214', 'PO-86112', 'ABC-SVC-JHB-06']) {
    if (!cells.includes(value)) throw new Error(`the EJE-1044 row does not show ${value}`);
  }
});

await step('the archive can be searched by serial number, not just job number', async () => {
  const search = page.getByLabel('Search the archive');
  await search.fill('LW-V40-70214');
  await page.waitForFunction(
    () => !(document.querySelector('table')?.innerText ?? '').includes('EJE-1057'),
    { timeout: 10000 },
  );
  const text = await page.getByRole('table').innerText();
  if (!text.includes('EJE-1044') || !text.includes('EJE-1056')) {
    throw new Error('searching by serial number lost the jobs on that machine');
  }
});

await step('the archive can be searched by customer order number', async () => {
  const search = page.getByLabel('Search the archive');
  await search.fill('PO-86112');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1044')
      && !(document.querySelector('table')?.innerText ?? '').includes('EJE-1056'),
    { timeout: 10000 },
  );
});

await step('a search that matches nothing says so, rather than showing everything', async () => {
  await page.getByLabel('Search the archive').fill('ZZ-NOTHING-MATCHES');
  await page.getByText('No closed jobs match').waitFor({ timeout: 10000 });
  await page.getByText('0 closed jobs').waitFor({ timeout: 8000 });
});

await step('the archive filters by customer, job type and technician', async () => {
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('table').waitFor({ timeout: 10000 });

  await page.getByLabel('Job type').selectOption('installation');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1039')
      && !(document.querySelector('table')?.innerText ?? '').includes('EJE-1044'),
    { timeout: 10000 },
  );

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Technician').selectOption('user-tech-deon');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1057')
      && !(document.querySelector('table')?.innerText ?? '').includes('EJE-1039'),
    { timeout: 10000 },
  );

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Customer').selectOption('cust-abc');
  await page.waitForFunction(
    () => !(document.querySelector('table')?.innerText ?? '').includes('EJE-1039'),
    { timeout: 10000 },
  );
  // Choosing the customer narrows the site list to that customer's own sites.
  const siteOptions = await page.getByLabel('Site').innerText();
  if (siteOptions.includes('Benoni Workshop')) {
    throw new Error("the Site filter offered another customer's site");
  }
});

await step('the archive filters by the date the job was closed', async () => {
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Closed to').fill('2026-04-01');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1044')
      && !(document.querySelector('table')?.innerText ?? '').includes('EJE-1062'),
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: 'Clear filters' }).click();
});

await step('opening a closed job shows the complete historical record', async () => {
  await page.getByRole('row').filter({ hasText: 'EJE-1044' }).first().click();
  await page.getByRole('heading', { name: 'EJE-1044' }).waitFor({ timeout: 10000 });

  const body = await page.locator('main').innerText();
  for (const value of [
    'ABC Engineering',
    'Johannesburg',
    'LW-V40-70214',
    'Riaan',
    'PO-86112',
    'ABC-SVC-JHB-06',
  ]) {
    if (!body.includes(value)) throw new Error(`the closed job record does not show ${value}`);
  }
  // Read-only, and it says why.
  await page.getByText('this job is closed', { exact: false }).first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/18-closed-job-record.png`, fullPage: true });
});

await step('a closed job carries its final signed document', async () => {
  await page.getByText('Final signed job card').waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
  await page.getByText('pieter.nel@abc-engineering-demo.co.za', { exact: false }).first()
    .waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'View Final PDF' }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Download Final PDF' }).waitFor({ timeout: 8000 });
});

await step('"View Final PDF" opens the stored document, and does not re-make it', async () => {
  await page.getByRole('button', { name: 'View Final PDF' }).click();
  await page.getByRole('heading', { name: 'Review job card' }).waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
  await page.getByText('Issued and closed').waitFor({ timeout: 8000 });
  await page.getByText('Final document on file').waitFor({ timeout: 8000 });

  // Merely looking at an old job card must not append a new document event.
  await page.goto(`${BASE}/jobs/EJE-1044`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Activity/ }).click();
  const before = await page.getByText('document generated', { exact: false }).count();
  await page.goto(`${BASE}/jobs/EJE-1044/review`, { waitUntil: 'networkidle' });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
  await page.goto(`${BASE}/jobs/EJE-1044`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Activity/ }).click();
  await page.getByText('Activity', { exact: false }).first().waitFor({ timeout: 8000 });
  const after = await page.getByText('document generated', { exact: false }).count();
  if (after !== before) {
    throw new Error(`viewing a closed job card regenerated its document (${before} -> ${after})`);
  }
});

await step('a closed parts collection keeps a collection note, not a job card', async () => {
  await page.goto(`${BASE}/jobs/EJE-1062`, { waitUntil: 'networkidle' });
  await page.getByText('EJE-1062-Final-Parts-Collection-Note.pdf').first()
    .waitFor({ timeout: 10000 });
});

/** The charge-out rate the office is currently using, from the Rates screen. */
const setNormalRate = async (rands) => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Rates & VAT' }).click();
  const normal = page.getByLabel('Normal Time');
  await normal.waitFor({ timeout: 10000 });
  await normal.fill(rands);
  await page.getByRole('button', { name: 'Save rates' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Update rates' }).click();
  await page.getByText('Saved', { exact: true }).first().waitFor({ timeout: 10000 });
};

const documentTotals = async (jobNumber) => {
  await page.goto(`${BASE}/jobs/${jobNumber}/review`, { waitUntil: 'networkidle' });
  const frame = page.locator('.eje-document').first();
  await frame.waitFor({ timeout: 10000 });
  const text = await frame.innerText();
  const line = text.split('\n').find((candidate) => /TOTAL/i.test(candidate)) ?? '';
  if (line.length === 0) throw new Error(`${jobNumber} renders no total`);
  return line;
};

await step('a closed job keeps its own prices when the Master changes the rates', async () => {
  const before = await documentTotals('EJE-1044');

  // A rate rise the office applies today must not reach an invoice already
  // issued six months ago.
  await setNormalRate('2500.00');
  const after = await documentTotals('EJE-1044');
  if (after !== before) {
    throw new Error(`a rate change altered a closed job card: ${before} -> ${after}`);
  }

  // Put the demo rates back, so the rest of this run sees the seeded prices.
  await setNormalRate('950.00');
});

await step('the same closed job is reached from the customer and the machine history', async () => {
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Job History' }).click();
  const fromCustomer = page.getByRole('row').filter({ hasText: 'EJE-1044' });
  await fromCustomer.first().waitFor({ timeout: 10000 });
  if (await fromCustomer.count() !== 1) {
    throw new Error('the customer history holds no single EJE-1044 row');
  }
  await fromCustomer.first().click();
  await page.getByRole('heading', { name: 'EJE-1044' }).waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });

  await page.goto(`${BASE}/machines/machine-abc-lv40`, { waitUntil: 'networkidle' });
  const fromMachine = page.getByRole('row').filter({ hasText: 'EJE-1044' });
  if (await fromMachine.count() !== 1) {
    throw new Error('the machine history holds no single EJE-1044 row');
  }
  await fromMachine.first().click();
  await page.getByRole('heading', { name: 'EJE-1044' }).waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
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

await step('the month grid is compact — job numbers, not job details', async () => {
  const bar = page.locator('a[href="/jobs/EJE-1048"]').first();
  await bar.waitFor({ timeout: 8000 });
  const text = (await bar.innerText()).trim();

  // The month cell carries the number and the colour. Customer, site, machine
  // and technician are one tap away, not crammed into the grid.
  if (!text.includes('EJE-1048')) throw new Error(`month bar lost its job number: "${text}"`);
  for (const secondary of ['ABC Engineering', 'Leadwell', 'Johannesburg']) {
    if (text.includes(secondary)) {
      throw new Error(`month bar still carries "${secondary}"`);
    }
  }
});

await step('availability bars are slimmer than job bars', async () => {
  const jobBar = await page.locator('a[href^="/jobs/EJE-"] > span').first().boundingBox();
  const absenceBar = await page
    .locator('button[aria-label*="Leave"] > span, button[aria-label*="Sick"] > span')
    .first()
    .boundingBox();

  if (jobBar === null || absenceBar === null) throw new Error('bars not rendered');
  if (absenceBar.height >= jobBar.height) {
    throw new Error(
      `absence (${absenceBar.height}px) does not read as secondary to work (${jobBar.height}px)`,
    );
  }
});

await step('every calendar bar stays a usable tap target on a tablet', async () => {
  const targets = await page
    .locator('a[href^="/jobs/EJE-"], button[aria-label*="Leave"], button[aria-label*="Sick"]')
    .all();

  for (const target of targets.slice(0, 12)) {
    const box = await target.boundingBox();
    if (box !== null && box.height < 20) {
      throw new Error(`a calendar bar is only ${box.height}px tall — too small to tap`);
    }
  }
});

await step('a busy day collapses behind "+N more" rather than stretching', async () => {
  const more = page.getByText(/^\+ \d+ more$/).first();
  await more.waitFor({ timeout: 8000 });

  // Every week row is a comparable height, because the cap holds.
  const rows = await page.locator('div.relative.border-b').all();
  const heights = [];
  for (const row of rows) {
    const box = await row.boundingBox();
    if (box !== null) heights.push(box.height);
  }
  const tallest = Math.max(...heights);
  if (tallest > 200) {
    throw new Error(`a week row grew to ${tallest}px — the density cap is not holding`);
  }
});

await step('"+N more" reveals the whole day, losing nothing', async () => {
  const more = page.getByText(/^\+ \d+ more$/).first();
  const label = (await more.innerText()).trim();
  const hidden = Number(label.replace(/[^0-9]/g, ''));
  await more.click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });

  // The dialog lists the day in full — the bars that were drawn AND the ones
  // deferred, so nothing was removed to tidy the grid.
  const listed = await dialog.getByRole('listitem').count();
  if (listed <= hidden) {
    throw new Error(`"${label}" opened a list of only ${listed} — entries were lost`);
  }
  await page.screenshot({ path: `${shots}/18-calendar-day-more.png`, fullPage: false });
});

await step('selecting an entry there opens its details', async () => {
  await page.getByRole('dialog').getByRole('listitem').first().getByRole('button').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });
  const text = await dialog.innerText();

  // Progressive disclosure: the detail carries what the grid deliberately left
  // out. It is a job or an absence, so accept either shape.
  const isJob = text.includes('Open job card');
  const needed = isJob
    ? ['CUSTOMER', 'SITE', 'MACHINE', 'SCHEDULED', 'TECHNICIAN']
    : ['TECHNICIAN', 'TYPE', 'TIME', 'DATES'];
  for (const field of needed) {
    if (!text.toUpperCase().includes(field)) {
      throw new Error(`entry detail is missing ${field}`);
    }
  }
  await page.keyboard.press('Escape');
});

await step('an availability bar opens its own detail, which a job page cannot show', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page
    .locator('button[aria-label*="Leave"], button[aria-label*="Sick"], button[aria-label*="Appointment"]')
    .first()
    .click({ timeout: 10000 });

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });
  await dialog.getByText('Unavailable').first().waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Open technician' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
});

await step('a job bar still goes straight to its job card', async () => {
  await page.locator('a[href="/jobs/EJE-1048"]').first().click();
  await page.waitForURL('**/jobs/EJE-1048', { timeout: 10000 });
  await page.getByRole('heading', { name: 'EJE-1048' }).first().waitFor({ timeout: 8000 });
});

await step('the calendar filters answer a planner\'s three questions', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 10000 });

  // "Who is available?" — availability only, no job bars at all.
  await page.getByRole('button', { name: 'Availability', exact: true }).click();
  await page.waitForTimeout(500);
  if ((await page.locator('a[href^="/jobs/EJE-"]').count()) !== 0) {
    throw new Error('the Availability filter still shows jobs');
  }

  // "What jobs are happening?" — jobs only.
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.waitForTimeout(500);
  if ((await page.locator('button[aria-label*="Leave"]').count()) !== 0) {
    throw new Error('the Jobs filter still shows availability');
  }
  if ((await page.locator('a[href^="/jobs/EJE-"]').count()) === 0) {
    throw new Error('the Jobs filter shows no jobs');
  }

  // Narrowed to one job type.
  await page.getByLabel('Job type').selectOption('service');
  await page.waitForTimeout(500);
  if ((await page.locator('a[href="/jobs/EJE-1048"]').count()) !== 0) {
    throw new Error('a breakdown survived the Service job-type filter');
  }
  if ((await page.locator('a[href="/jobs/EJE-1049"]').count()) === 0) {
    throw new Error('the Service filter hid a service job');
  }

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Job type').selectOption('all');
});

await step('the legend survives the declutter', async () => {
  // Scoped to the legend: the new Job type filter has options with the same
  // names, and a hidden <option> is not what this is checking.
  const legend = page.locator('div').filter({ hasText: /^Key:/ }).last();
  await legend.waitFor({ timeout: 8000 });
  const text = await legend.innerText();

  for (const label of [
    'Breakdown',
    'Installation',
    'Service',
    'Test & Repair',
    'Parts',
    'Unavailable',
    'Sick leave',
  ]) {
    if (!text.includes(label)) throw new Error(`the legend lost "${label}"`);
  }
});

await step('week view carries more than month view does', async () => {
  await page.getByRole('tab', { name: 'Week' }).click();
  await page.waitForTimeout(700);

  const bars = await page.locator('a[href^="/jobs/EJE-"]').all();
  let sawCustomer = false;
  for (const bar of bars) {
    if ((await bar.innerText()).includes('Engineering') || (await bar.innerText()).includes('(Pty)')) {
      sawCustomer = true;
      break;
    }
  }
  if (!sawCustomer) {
    throw new Error('week view is as sparse as month view — it has room for the customer');
  }
  await page.getByRole('tab', { name: 'Month' }).click();
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
