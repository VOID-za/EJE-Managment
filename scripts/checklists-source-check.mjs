/**
 * CHK-SRC-1 — THE BUSINESS'S OWN CHECKLISTS, THROUGH THE SCREEN.
 *
 * At one screen size per run (EJE_FORMS_VIEWPORT, as the forms regression):
 *   - Administration → Checklists shows Installation, Service — Milling Machine
 *     and Service — Lathe as the issued checklists, each readable in full with
 *     36, 39 and 41 rows, the printed titles, and the handwritten Lathe line
 *     marked; the demonstration wording is listed as archived.
 *   - A Service job's checklist step asks "Which Service checklist do you need
 *     to complete?" and cannot be passed without a choice; Lathe opens the
 *     Lathe checklist and nothing else; Milling opens Milling.
 *   - An Installation job opens the Installation checklist with no choice.
 *   - A completed Lathe checklist's job card says it is the Lathe checklist.
 *   - A job completed on the demonstration wording still shows that wording.
 *   - No page scrolls sideways, and no page throws.
 *
 *   npm run checklists-source-check                 (desktop, 1440x900)
 *   EJE_FORMS_VIEWPORT=390x844:touch npm run checklists-source-check
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';
import { assertLocalTarget } from './local-target.mjs';

const BASE = assertLocalTarget(process.env.EJE_E2E_URL ?? process.env.EJE_SMOKE_BASE_URL ?? 'http://localhost:3210');
const [shape, mode] = (process.env.EJE_FORMS_VIEWPORT ?? '1440x900').split(':');
const [width, height] = shape.split('x').map(Number);
const touch = mode === 'touch';
const label = `${width}x${height}${touch ? ' touch' : ''}`;
const SHOTS = process.env.EJE_SHOTS ?? null;

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
const shot = async (name) => {
  if (SHOTS !== null) await page.screenshot({ path: `${SHOTS}/${name}-${width}x${height}.png`, fullPage: false });
};
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
// A tab's name carries its badge ("Checklist Done"), so it is matched by how it starts.
const tab = (name) => page.getByRole('tab', { name: new RegExp(`^${name}`, 'u') }).first();

await resetDemonstration(page, BASE);

/* ---------------------------------------------------------------- office */
await as('Elmarie Coetzee');
const users = (await call('GET', '/api/admin')).json?.data?.users ?? [];
const sipho = users.find((user) => user.email === 'sipho.mahlangu@eje-demo.co.za')?.id;

/** A new job of this type, assigned to Sipho, created through the API as the office would. */
const newJob = async (jobType) => {
  const created = await call('POST', '/api/jobs', {
    customerId: 'cust-abc',
    siteId: 'site-abc-jhb',
    contactId: 'contact-abc-jhb',
    machineId: 'machine-abc-lv40',
    jobType,
    priority: 'normal',
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: 'PO-CHK-SRC-1',
    referenceNumber: '',
    faultDescription: jobType === 'service' ? 'Annual preventative maintenance.' : 'New machine installation.',
    primaryTechnicianId: sipho,
    courierCollection: false,
    deliveryNote: '',
  });
  if (created.status !== 200) fail(`creating a ${jobType} job answered ${created.status}`);
  return created.json.data;
};
const serviceForLathe = await newJob('service');
const serviceForMilling = await newJob('service');
const installation = await newJob('installation');

await check('Administration → Checklists issues Installation, Service — Milling Machine and Service — Lathe, each readable in full', async () => {
  await go('/admin');
  await press(tab('Checklists'));
  const cards = page.getByTestId('checklist-admin-card');
  await cards.first().waitFor({ timeout: 20000 });
  const expectations = [
    ['installation', 'Installation Procedure', 36],
    ['service_milling', 'PREVENTATIVE MAINTENANCE CHECKLIST - MACHINING CENTRE', 39],
    ['service_lathe', 'PREVENTATIVE MAINTENACE CHECKLIST - LATHE', 41],
  ];
  for (const [kind, title, rows] of expectations) {
    const contents = page.getByTestId(`checklist-contents-${kind}`);
    await contents.waitFor({ timeout: 10000 });
    const printed = await contents.getByTestId('checklist-printed-title').innerText();
    if (printed.trim() !== title) fail(`${kind}: printed title "${printed}"`);
    const count = await contents.getByTestId('checklist-contents-item').count();
    if (count !== rows) fail(`${kind}: ${count} rows shown, the source has ${rows}`);
  }
  const lathe = await page.getByTestId('checklist-contents-service_lathe').innerText();
  if (!lathe.includes('Changed Fanuc control battery') || !lathe.includes('Handwritten on the supplied source.')) {
    fail('the handwritten Lathe line is not shown, or not marked handwritten');
  }
  // The first three cards are the issued ones; the demonstration wording is archived.
  const firstThree = await Promise.all([0, 1, 2].map((index) => cards.nth(index).innerText()));
  if (!firstThree.every((text) => text.includes('Current'))) fail('the three source checklists are not listed first as Current');
  const all = await cards.allInnerTexts();
  const demo = all.filter((text) => text.includes('DEMO'));
  if (demo.length === 0 || demo.some((text) => text.includes('Current'))) fail('demonstration wording is still issued');
  await noPageOverflow('Administration → Checklists');
  await shot('admin-checklists');
  return `${all.length} versions listed, ${demo.length} archived demonstration`;
});

/* ------------------------------------------------------------ technician */
await as('Sipho Mahlangu');
for (const job of [serviceForLathe, serviceForMilling, installation]) {
  const accepted = await call('POST', `/api/jobs/${job.id}/accept`, {});
  if (accepted.status !== 200) fail(`accepting ${job.jobNumber} answered ${accepted.status}`);
}

await check('a Service job asks which checklist, and cannot be passed without a choice', async () => {
  await go(`/jobs/${serviceForLathe.jobNumber}`);
  await press(tab('Checklist'));
  const choice = page.getByTestId('checklist-choice');
  await choice.waitFor({ timeout: 15000 });
  const text = await choice.innerText();
  if (!text.includes('Which Service checklist do you need to complete?')) fail('the question is not asked');
  if (!text.includes('1. Milling Machine / Machining Centre') || !text.includes('2. Lathe')) fail(`options: ${text}`);
  const go_ = page.getByTestId('checklist-choice-continue');
  if (!(await go_.isDisabled())) fail('Continue is available with nothing chosen');
  // Nor can the screen's absence be used: the server refuses a start with no choice.
  const bare = await call('POST', `/api/jobs/${serviceForLathe.id}/start_checklist`, {});
  if (bare.status !== 422) fail(`a start with no choice answered ${bare.status}`);
  await noPageOverflow('the Service checklist choice');
  await shot('service-choice');
});

await check('choosing Lathe opens the Lathe checklist and nothing else, and records the choice', async () => {
  await press(page.getByTestId('checklist-choice-service_lathe'));
  await press(page.getByTestId('checklist-choice-continue'));
  await page.getByTestId('checklist-kind').waitFor({ timeout: 15000 });
  const kind = await page.getByTestId('checklist-kind').innerText();
  if (kind.trim() !== 'Lathe') fail(`the checklist says it is "${kind}"`);
  const body = await page.locator('main').innerText();
  if (!body.includes('PREVENTATIVE MAINTENACE CHECKLIST - LATHE')) fail('the Lathe title is not shown');
  if (body.includes('Check ATC box oil')) fail('a Milling row is on the Lathe checklist');
  const rows = await page.locator('[data-testid^="checklist-item-"]').count();
  if (rows !== 41) fail(`${rows} rows, the Lathe source has 41`);
  if ((await page.getByTestId('checklist-source-note').count()) < 1) fail('the handwritten line is not marked');
  const view = await call('GET', `/api/jobs/${serviceForLathe.jobNumber}`);
  if (view.json?.data?.view?.job?.checklist?.checklistKind !== 'service_lathe') fail('the choice is not recorded');
  await noPageOverflow('the Lathe checklist');
  await shot('lathe-open');
});

await check('choosing Milling opens the Milling checklist', async () => {
  await go(`/jobs/${serviceForMilling.jobNumber}`);
  await press(tab('Checklist'));
  await page.getByTestId('checklist-choice').waitFor({ timeout: 15000 });
  await press(page.getByTestId('checklist-choice-service_milling'));
  await press(page.getByTestId('checklist-choice-continue'));
  await page.getByTestId('checklist-kind').waitFor({ timeout: 15000 });
  const body = await page.locator('main').innerText();
  if (!body.includes('PREVENTATIVE MAINTENANCE CHECKLIST - MACHINING CENTRE')) fail('the Milling title is not shown');
  if (body.includes('Check Turret alignment X and Z Axis')) fail('a Lathe row is on the Milling checklist');
  const rows = await page.locator('[data-testid^="checklist-item-"]').count();
  if (rows !== 39) fail(`${rows} rows, the Milling source has 39`);
  if (!body.includes('ALL CHECKS COMPLETE')) fail('the closing line is not shown');
  await noPageOverflow('the Milling checklist');
});

await check('an Installation job opens the Installation checklist with no choice, and its blanks take readings', async () => {
  await go(`/jobs/${installation.jobNumber}`);
  await press(tab('Checklist'));
  const start = page.getByRole('button', { name: 'Start checklist' });
  await start.waitFor({ timeout: 15000 });
  if ((await page.getByTestId('checklist-choice').count()) > 0) fail('Installation was shown the Service choice');
  await press(start);
  await page.locator('[data-testid^="checklist-item-"]').first().waitFor({ timeout: 15000 });
  const rows = await page.locator('[data-testid^="checklist-item-"]').count();
  if (rows !== 36) fail(`${rows} rows, the Installation source has 36`);
  const group = await page.getByTestId('checklist-group').innerText();
  if (!group.includes('Check all oil levels:')) fail(`group heading: ${group}`);
  // 2 Check electrical voltage: type R, leave the field, and it is saved.
  const voltage = page.locator('[data-testid^="checklist-item-"]').nth(1);
  const r = voltage.locator('[data-testid$="-r"]');
  await r.fill('401');
  await r.blur();
  await page.waitForFunction(
    async (jobNumber) => {
      const response = await fetch(`/api/jobs/${jobNumber}`);
      const json = await response.json();
      return (json?.data?.view?.job?.checklist?.responses ?? []).some((answer) => answer?.fieldValues?.r === '401');
    },
    installation.jobNumber,
    { timeout: 15000 },
  );
  await noPageOverflow('the Installation checklist');
  await shot('installation-open');
});

await check('a completed Lathe checklist’s job card says it is the Lathe checklist', async () => {
  const view = (await call('GET', `/api/jobs/${serviceForLathe.jobNumber}`)).json.data.view;
  const items = view.checklistTemplate.sections.flatMap((section) => section.items);
  for (const item of items) {
    const answered = await call('POST', `/api/jobs/${serviceForLathe.id}/answer_checklist`, { itemId: item.id, choice: 'pass' });
    if (answered.status !== 200) fail(`answering "${item.text}" answered ${answered.status}`);
  }
  const done = await call('POST', `/api/jobs/${serviceForLathe.id}/complete_checklist`, {});
  if (done.status !== 200) fail(`completing answered ${done.status}: ${JSON.stringify(done.json?.error ?? '')}`);
  await go(`/jobs/${serviceForLathe.jobNumber}/review`);
  const type = page.getByTestId('job-card-checklist-type');
  await type.waitFor({ timeout: 20000 });
  const text = await type.innerText();
  if (text.trim() !== 'Service checklist: Lathe') fail(`the job card says "${text}"`);
  await noPageOverflow('the job card');
  await shot('job-card');
});

await check('a job completed on the demonstration wording still shows that wording, as answered', async () => {
  await as('Elmarie Coetzee');
  await go('/jobs/EJE-1044');
  await press(tab('Checklist'));
  const source = page.getByTestId('checklist-source');
  await source.waitFor({ timeout: 15000 });
  const text = await source.innerText();
  if (!text.includes('Earlier demonstration wording')) fail(`source line: ${text}`);
  if ((await page.getByTestId('checklist-choice').count()) > 0) fail('a completed job was offered the choice');
  await noPageOverflow('a historical checklist');
});

await check('no page threw an error', async () => {
  if (pageErrors.length > 0) fail(pageErrors.join(' | '));
});

await browser.close();
const failed = results.filter(([state]) => state === 'FAIL');
console.log(`\n${label}: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
