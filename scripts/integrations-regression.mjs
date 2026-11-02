/**
 * EMAIL TEMPLATES, THE AUTOMATIC SIGNED JOB CARD EMAIL, WHATSAPP AND SITE
 * PINS, THROUGH THE SCREEN, AT ONE VIEWPORT. (INT-EMAIL, INT-WA, INT-MAP,
 * INT-ADMIN — 1 November 2026.)
 *
 * Every check drives the real application in a browser, as the person whose
 * role it names. The demonstration backend's adapters are SIMULATED — nothing
 * leaves the building — and the screens say so; this proves the workflow, not
 * Microsoft, Meta or Google. Run it once per device shape:
 *
 *   EJE_E2E_URL=http://localhost:3210 EJE_FORMS_VIEWPORT=1440x900 node scripts/integrations-regression.mjs
 *   EJE_FORMS_VIEWPORT=768x1024:touch …   (a portrait tablet, by touch)
 *   EJE_FORMS_VIEWPORT=390x844:touch …    (a phone, by touch)
 *
 * The demonstration data is reset first. Prints PASS / FAIL per check; exits 1
 * on any FAIL.
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
const go = async (path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
};
const noPageOverflow = async (where) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`${where}: the page scrolls sideways by ${over}px`);
};
const api = (method, path, body) =>
  page.evaluate(
    async ([verb, url, payload]) => {
      const response = await fetch(url, {
        method: verb,
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    [method, path, body],
  );
const openTab = async (name) => {
  await press(page.getByRole('tab', { name }));
};

await resetDemonstration(page, BASE);

/* ---- 1. Email templates, the Master and the Coordinator ---------------- */
for (const who of ['Elmarie Coetzee', 'Christene van Niekerk']) {
  await check(`Email Templates: ${who.split(' ')[0]} sees one emailed default per job type`, async () => {
    await as(who);
    await go('/admin');
    await openTab('Email Templates');
    await page.getByTestId('email-templates-panel').waitFor({ timeout: 20000 });
    for (const jobType of ['breakdown', 'installation', 'service', 'test_and_repair']) {
      const row = page.getByTestId(`email-coverage-${jobType}`);
      if (!(await row.innerText()).includes('Emailed automatically')) fail(`${jobType} is not covered by a default`);
    }
    await noPageOverflow('Email Templates');
  });
}

await check('Email Templates: the Coordinator inserts a placeholder, previews, and saves version 2', async () => {
  await as('Christene van Niekerk');
  await go('/admin');
  await openTab('Email Templates');
  const row = page.getByTestId('email-template-row').filter({ hasText: 'Signed job card — Breakdown' });
  await press(row.getByTestId('email-template-edit'));
  const editor = page.getByTestId('email-template-editor');
  await editor.waitFor();
  const body = editor.getByTestId('email-template-body');
  await body.click();
  await body.press('End');
  await body.press('Control+End');
  await body.type('\nOur reference for you: ');
  await press(editor.getByTestId('email-placeholder-reference'));
  if (!(await body.inputValue()).includes('Our reference for you: {{reference}}')) fail('the placeholder was not inserted at the cursor');
  await press(page.getByTestId('email-template-preview'));
  const preview = page.getByTestId('email-template-preview-body');
  await preview.waitFor({ timeout: 15000 });
  if (!(await preview.innerText()).includes('Our reference for you: REF-9931')) fail('the preview did not fill the placeholder');
  if (!(await page.getByTestId('email-template-preview-subject').innerText()).startsWith('EJE-2078')) fail('the subject preview is not filled');
  await press(page.getByTestId('email-template-save'));
  await editor.waitFor({ state: 'detached', timeout: 15000 });
  await page.getByTestId('email-template-row').filter({ hasText: 'Signed job card — Breakdown' }).filter({ hasText: 'version 2' }).waitFor({ timeout: 15000 });
});

await check('Email Templates: an unknown placeholder is shown as a problem and cannot be saved', async () => {
  await press(page.getByTestId('email-template-new'));
  const editor = page.getByTestId('email-template-editor');
  await editor.getByTestId('email-template-name').fill('Broken');
  await editor.getByTestId('email-template-subject').fill('{{job_numbr}}');
  await press(page.getByTestId('email-template-preview'));
  const problems = page.getByTestId('email-template-problems');
  await problems.waitFor({ timeout: 15000 });
  if (!(await problems.innerText()).includes('{{job_numbr}}')) fail('the problem does not name the placeholder');
  await press(page.getByTestId('email-template-save'));
  await page.getByText('The template was not saved').waitFor({ timeout: 15000 });
  await press(page.getByRole('button', { name: 'Cancel' }));
});

await check('Email Templates: a new template made the default, then the system default restored', async () => {
  const created = await api('POST', '/api/admin/email-templates', {
    op: 'create', event: 'signed_job_card', jobType: 'service', name: 'Service — short', description: '', subject: '{{job_number}} — service', body: 'Hello {{customer_name}}',
  });
  if (created.status !== 200) fail(`create answered ${created.status}`);
  await go('/admin');
  await openTab('Email Templates');
  const row = page.getByTestId('email-template-row').filter({ hasText: 'Service — short' });
  await press(row.getByTestId('email-template-make-default'));
  await page.getByTestId('email-coverage-service').filter({ hasText: 'Service — short' }).waitFor({ timeout: 15000 });
  await press(page.getByTestId('email-restore-service'));
  await page.getByTestId('email-coverage-service').filter({ hasText: 'Signed job card — Service' }).waitFor({ timeout: 15000 });
});

await check('Email Templates: a technician is refused by the server', async () => {
  await as('Sipho Mahlangu');
  const answer = await api('GET', '/api/admin/email-templates');
  if (answer.status !== 403) fail(`a technician got ${answer.status}`);
});

/* ---- 2. Integrations status --------------------------------------------- */
await check('Integrations: three services, each saying what it is, and no test without a configured recipient', async () => {
  await as('Elmarie Coetzee');
  await go('/admin');
  await openTab('Integrations');
  await page.getByTestId('integrations-panel').waitFor({ timeout: 20000 });
  for (const service of ['email', 'whatsapp', 'maps']) {
    const text = await page.getByTestId(`integration-${service}`).innerText();
    if (!/Demonstration \(simulated\)/u.test(text)) fail(`${service} does not say it is simulated: ${text.slice(0, 80)}`);
  }
  if (!(await page.getByTestId('integration-email').innerText()).includes('EMAIL_TEST_RECIPIENTS')) fail('the email card does not say why no test can be sent');
  // WA-SIM-1 (2 November 2026): the office's existing number, by WhatsApp Business coexistence.
  const whatsapp = await page.getByTestId('integration-whatsapp').innerText();
  if (!whatsapp.includes('office number, by WhatsApp Business coexistence')) fail('the WhatsApp card does not name the office number and coexistence');
  if (!/Office WhatsApp number[\s\S]*Not connected and never used/u.test(whatsapp)) fail('the WhatsApp card does not say the office number is untouched');
  await noPageOverflow('Integrations');
});

/* ---- 3. Acceptance offers the location, labelled ------------------------ */
await check('Acceptance: the technician is offered the site location with an honest link', async () => {
  await as('Sipho Mahlangu');
  await go('/jobs/EJE-1048');
  await press(page.getByRole('button', { name: /^Accept/u }).first());
  await press(page.getByRole('button', { name: 'Accept and start' }));
  const link = page.getByTestId('accept-location-link');
  await link.waitFor({ timeout: 20000 });
  const href = await link.locator('a').getAttribute('href');
  if (!href?.startsWith('https://www.google.com/maps/dir/?api=1&destination=')) fail(`unexpected link ${href}`);
  const note = await page.getByTestId('accept-location-note').innerText();
  if (note.length < 10) fail('no note on how far to trust the link');
  await press(page.getByRole('button', { name: 'No, Thanks' }));
  return note;
});

/* ---- 4. The signed job card is emailed on its own ---------------------- */
await check('Signed job card: emailed automatically after signature, from the history, with the template version used', async () => {
  const steps = [
    ['add_labour', { date: new Date().toLocaleDateString('en-CA'), rateType: 'normal', hours: 2, description: 'Spindle drive repair' }],
    ['save_report', { faultFindings: '', diagnosis: '', workPerformed: 'Replaced the cooling fan.', recommendations: '', generalNotes: '' }],
    ['start_completion', {}],
    ['start_signature', {}],
    ['capture_signature', { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L10,10' }],
    ['issue', {}],
  ];
  for (const [action, body] of steps) {
    const answer = await api('POST', `/api/jobs/EJE-1048/${action}`, body);
    if (answer.status !== 200) fail(`${action} answered ${answer.status}: ${JSON.stringify(answer.json?.error ?? '').slice(0, 160)}`);
  }
  await as('Elmarie Coetzee');
  await go('/jobs/EJE-1048');
  const history = page.getByTestId('job-email-history');
  await history.waitFor({ timeout: 20000 });
  const email = history.getByTestId('job-email').first();
  const text = await email.innerText();
  if (!/Sent \(accepted by Microsoft 365\)/u.test(text)) fail(`not sent: ${text.slice(0, 120)}`);
  if (!(await email.getByTestId('job-email-template').innerText()).includes('Signed job card — Breakdown, version 2')) fail('the template version is not the one in force');
  if (!(await email.getByTestId('job-email-attachment').innerText()).endsWith('.pdf')) fail('no PDF attachment named');
  await press(email.getByText('The message as sent'));
  if (!(await email.getByTestId('job-email-body').innerText()).includes('Our reference for you')) fail('the body is not the edited template');
  if ((await page.getByTestId('job-email-retry').count()) !== 0) fail('a sent email offers Retry');
  await noPageOverflow('job email history');
});

/* ---- 5. WhatsApp on a direct assignment --------------------------------- */
await check('WhatsApp: a direct assignment notifies the technician and shows on the job', async () => {
  // A job raised straight onto a technician: a direct assignment.
  const created = await api('POST', '/api/jobs', {
    customerId: 'cust-abc', siteId: 'site-abc-jhb', contactId: 'contact-abc-jhb', machineId: 'machine-abc-lv40',
    jobType: 'breakdown', priority: 'normal', scheduledDate: null, scheduledEndDate: null, orderNumber: '', referenceNumber: '',
    faultDescription: 'Integration regression: direct assignment.', primaryTechnicianId: 'user-tech-riaan', additionalTechnicianIds: [],
    courierCollection: false, deliveryNote: '',
  });
  if (created.status !== 200) fail(`creating the job answered ${created.status}: ${JSON.stringify(created.json?.error ?? '').slice(0, 200)}`);
  const assigned = created.json.data;
  await go(`/jobs/${assigned.jobNumber}`);
  const message = page.getByTestId('job-whatsapp').first();
  await message.waitFor({ timeout: 20000 });
  const text = await message.innerText();
  if (!text.includes('Assignment notice') || !text.includes('eje_job_assigned')) fail(`unexpected: ${text.slice(0, 120)}`);
  return assigned.jobNumber;
});

/* ---- 6. The site pin, for the office ------------------------------------ */
await check('Site pin: the office sees the status, looks the pin up again, and takes the suggestion', async () => {
  await as('Christene van Niekerk');
  await go('/customers/cust-abc');
  const status = page.getByTestId('site-pin-status').first();
  await status.waitFor({ timeout: 20000 });
  if (!(await status.getByTestId('site-pin-label').innerText()).includes('Pin verified')) fail('the seeded pin is not shown as verified');
  // Retention, shown: the office's own pin is kept.
  if (!(await status.getByTestId('site-pin-retention').innerText()).includes('Entered by the office: kept')) fail('the office pin does not say it is kept');
  // Coordinates come from the site or the customer, not copied from Google Maps.
  await press(page.getByTestId('edit-site-location').first());
  await page.getByTestId('site-location-here').waitFor({ timeout: 20000 });
  if (!(await page.getByTestId('site-location-source-hint').innerText()).includes('not copied out of Google Maps')) fail('the dialog does not say where coordinates come from');
  await page.keyboard.press('Escape');
  await page.getByTestId('site-location-here').waitFor({ state: 'detached', timeout: 20000 });
  await press(status.getByTestId('site-pin-find'));
  const suggestion = page.getByTestId('site-pin-suggestion').first();
  await suggestion.waitFor({ timeout: 20000 });
  // A verified pin is never replaced automatically: the match waits as a suggestion.
  if (!(await status.getByTestId('site-pin-label').innerText()).includes('Pin verified')) fail('the verified pin was replaced');
  await press(page.getByTestId('site-pin-use-suggestion').first());
  await page.getByTestId('site-pin-suggestion').first().waitFor({ state: 'detached', timeout: 20000 });
  if (!(await page.getByTestId('site-pin-status').first().innerText()).includes('Simulated geocoder')) fail('the simulated geocoder is not labelled');
  // A geocoded pin says when its coordinates are refreshed or deleted (30 days).
  const retention = await page.getByTestId('site-pin-retention').first().innerText();
  if (!/coordinates: refreshed or deleted by \d{4}-\d{2}-\d{2}/u.test(retention)) fail(`the geocoded pin does not show its retention: ${retention}`);
  await noPageOverflow('customer location');
});

await check('Site pin: a technician cannot verify a pin (server)', async () => {
  await as('Sipho Mahlangu');
  const answer = await api('POST', '/api/sites/site-abc-jhb/verify_location', { kind: 'current' });
  if (answer.status !== 403) fail(`a technician got ${answer.status}`);
});

await check('no page errors anywhere in the run', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([kind]) => kind === 'FAIL');
console.log(`\n=== ${label}: ${results.length - failed.length} passed, ${failed.length} failed ===`);
for (const [kind, text] of failed) console.log(` ${kind} ${text}`);
process.exit(failed.length === 0 ? 0 : 1);
