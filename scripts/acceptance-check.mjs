/**
 * PHYSICAL ACCEPTANCE FOLLOW-UP THROUGH THE SCREEN (3 November 2026).
 *
 * At one viewport per run (`EJE_FORMS_VIEWPORT=1440x900`, `768x1024:touch`,
 * `390x844:touch`), against the demonstration backend, from a reset:
 *
 *   - the standby block sits directly below the Overview greeting, with this
 *     week's four places (STANDBY-DASH-2);
 *   - the screenshot scenario: two main technicians who rotate the main and
 *     helper places swap several pairs of days, by the form, with no reason
 *     asked and no "That swap cannot be asked for." (STANDBY-DAY-2,
 *     STANDBY-NOREASON-1);
 *   - the Office changes a place in a published week WITHOUT a reason
 *     (STANDBY-NOREASON-1); the Senior Tech is listed for main and helper
 *     standby, never apprentice (STANDBY-ELIG-2);
 *   - the timesheet line form has no Shared tick, and overlapping periods are
 *     sent, the later replacing the earlier (TS-CALLOUT-2, TS-OVERLAP-1);
 *   - a Delivery Note raised by the Office with its delivery date, part lines
 *     with comments and NO price field, signed and issued: closed as a
 *     Delivery Note, its price-less document on file, filterable in Closed
 *     Jobs beside Invoiced (DELIVERY-NOTE-1, INVOICED-CLOSED-1);
 *   - no page scrolls sideways, and no page error is thrown.
 *
 * The signature itself is taken through the API here: drawing on the pad by
 * finger and stylus is a physical-device check (docs/staff-testing.md, T10).
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
      if (type.includes('json')) return { status: response.status, json: await response.json() };
      return { status: response.status, json: null, bytes: (await response.arrayBuffer()).byteLength };
    },
    [method, path, body],
  );
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const tab = (name) => page.getByRole('tab', { name: new RegExp(`^${name}`, 'u') });

await resetDemonstration(page, BASE);

/* ---- Standby: the live roster's rotation, published -------------------- */
await check('the Office publishes a year where the two main technicians also rotate the helper place (the live roster)', async () => {
  await as('Christene van Niekerk');
  for (const id of ['user-tech-sipho', 'user-tech-riaan']) await call('POST', '/api/standby/eligibility', { userId: id, main: true, helper: true, apprentice: false });
  for (const id of ['user-tech-andre', 'user-tech-naledi', 'user-tech-deon', 'user-tech-lerato']) await call('POST', '/api/standby/eligibility', { userId: id, main: false, helper: false, apprentice: true });
  const year = Number(today.slice(0, 4));
  for (const plan of [year, year + 1]) {
    const generated = await call('POST', '/api/standby/generate', {
      year: plan,
      rotation: { main: ['user-tech-sipho', 'user-tech-riaan'], helper: ['user-tech-riaan', 'user-tech-sipho'], apprentice_1: ['user-tech-andre', 'user-tech-naledi'], apprentice_2: ['user-tech-deon', 'user-tech-lerato'] },
    });
    if (generated.status !== 200) fail(`generating ${plan} answered ${generated.status} ${JSON.stringify(generated.json?.error ?? '')}`);
    const published = await call('POST', '/api/standby/publish', { year: plan, acknowledgeIncomplete: true });
    if (published.status !== 200) fail(`publishing ${plan} answered ${published.status} ${JSON.stringify(published.json?.error ?? '')}`);
  }
});

await check('the standby block sits directly below the Overview greeting, with this week’s four places', async () => {
  await as('Sipho Mahlangu');
  await go('/dashboard');
  const block = page.getByTestId('overview-standby');
  await block.getByTestId('overview-standby-main').waitFor({ timeout: 20000 });
  const greeting = await page.locator('main h1').first().boundingBox();
  const box = await block.boundingBox();
  if (greeting === null || box === null) fail('no greeting or no block');
  // Nothing sits between the greeting and the block: the block is the first thing after the page header.
  const between = await page.evaluate(() => {
    const block = document.querySelector('[data-testid="overview-standby"]');
    const heading = document.querySelector('main h1');
    if (block === null || heading === null) return -1;
    const top = heading.getBoundingClientRect().bottom;
    const bottom = block.getBoundingClientRect().top;
    return [...document.querySelectorAll('main [data-testid], main section, main .grid')]
      .filter((element) => !block.contains(element) && !element.contains(block) && !element.contains(heading))
      .filter((element) => { const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.top >= top - 1 && rect.bottom <= bottom + 1; }).length;
  });
  if (between !== 0) fail(`${between} element(s) sit between the greeting and the standby block`);
  for (const position of ['main', 'helper', 'apprentice_1', 'apprentice_2']) {
    const text = await block.getByTestId(`overview-standby-${position}`).innerText();
    if (/Not assigned/u.test(text)) fail(`${position} is empty: ${text}`);
  }
  if ((await page.getByTestId('overview-standby').count()) !== 1) fail('the standby block is shown twice');
  await go('/standby');
  if ((await page.getByTestId('standby-mine').count()) !== 0) fail('the Standby page still has its own upcoming-standby block');
  await go('/dashboard');
  await noPageOverflow('the Overview');
});

let swapId = null;
await check('the screenshot scenario: several pairs asked by the form — no reason, no "cannot be asked for"', async () => {
  await as('Sipho Mahlangu');
  const options = (await call('GET', '/api/standby/days/options')).json.data;
  const riaan = options.people.find((person) => person.userId === 'user-tech-riaan');
  if (riaan === undefined || options.mine.length < 2 || riaan.days.length < 2) fail('not enough days to swap');
  await go('/standby');
  await press(page.getByTestId('standby-new-swap'));
  await page.getByTestId('day-swap-dialog').waitFor({ timeout: 20000 });
  await page.getByTestId('day-swap-mine-0').selectOption({ index: 1 });
  await page.getByTestId('day-swap-person').selectOption({ label: 'Riaan van Wyk' });
  await page.getByTestId('day-swap-theirs-0').selectOption({ index: 1 });
  await press(page.getByTestId('day-swap-add-pair'));
  await page.getByTestId('day-swap-mine-1').selectOption({ index: 2 });
  await page.getByTestId('day-swap-theirs-1').selectOption({ index: 2 });
  if ((await page.getByTestId('day-swap-reason').count()) !== 0) fail('the form still asks for a reason');
  await noPageOverflow('the day swap form');
  await press(page.getByTestId('day-swap-submit'));
  await page.getByTestId('standby-message').filter({ hasText: 'Swap request sent' }).waitFor({ timeout: 20000 });
  if ((await page.getByText('That swap cannot be asked for.').count()) !== 0) fail('"That swap cannot be asked for." was shown');
  const asked = (await call('GET', '/api/standby/days')).json.data[0];
  if (asked?.status !== 'awaiting_recipient' || asked.pairs.length !== 2) fail(`the request is ${asked?.status} with ${asked?.pairs?.length} pairs`);
  swapId = asked.id;
  return asked.pairLabels.join('; ');
});

await check('the person asked approves, then the Office: both places trade on each chosen day, nothing else moves', async () => {
  if (swapId === null) fail('no swap was asked');
  await as('Riaan van Wyk');
  const answered = await call('POST', `/api/standby/days/${swapId}/answer`, { decision: 'approve' });
  if (answered.status !== 200) fail(`answering answered ${answered.status} ${JSON.stringify(answered.json?.error ?? '')}`);
  await as('Christene van Niekerk');
  await go('/standby');
  await press(tab('Swap requests'));
  const card = page.locator(`[data-testid="day-swap-request"][data-swap="${swapId}"]`);
  await card.waitFor({ timeout: 20000 });
  await press(card.getByTestId('day-swap-office-approve'));
  await page.getByTestId('standby-message').waitFor({ timeout: 20000 });
  const decided = (await call('GET', '/api/standby/days')).json.data.find((swap) => swap.id === swapId);
  if (decided?.status !== 'approved') fail(`the swap is ${decided?.status}`);
});

await check('the Office changes a published week’s place with NO reason asked', async () => {
  await as('Christene van Niekerk');
  await go('/standby');
  const next = page.locator('[data-testid="standby-week"][data-status="published"]').nth(1);
  await press(next);
  const dialog = page.getByTestId('standby-week-dialog');
  await dialog.waitFor({ timeout: 20000 }).catch(async (error) => { await page.screenshot({ path: 'acceptance-standby-week.png' }); throw error; });
  const editor = dialog.getByTestId('standby-edit-apprentice_1');
  const select = editor.locator('select');
  const weekStart = await next.getAttribute('data-week');
  // Emptying the place is always a real change (choosing somebody may meet their other place that week).
  await select.selectOption('__empty__');
  await editor.getByTestId('standby-edit-confirm-apprentice_1').waitFor({ timeout: 10000 });
  if ((await page.getByTestId('standby-edit-reason-apprentice_1').count()) !== 0) fail('a reason is still asked');
  if ((await page.getByText('Reason for changing a published week').count()) !== 0) fail('the reason field is still shown');
  await press(editor.getByTestId('standby-edit-save-apprentice_1'));
  await page.getByText('Everyone affected has been told', { exact: false }).first().waitFor({ timeout: 20000 });
  const after = (await call('GET', `/api/standby?from=${weekStart}&to=${weekStart}`)).json.data.weeks[0];
  if (after.places.find((place) => place.position === 'apprentice_1').userId !== null) fail('the place did not change');
  await noPageOverflow('the published week editor');
});

await check('the Senior Tech is listed for main and helper standby — never apprentice', async () => {
  await as('Christene van Niekerk');
  await go('/standby');
  await press(tab('Manage schedule'));
  const row = page.getByTestId('standby-eligibility-row').filter({ hasText: 'Elmarie' });
  await row.waitFor({ timeout: 20000 });
  if (!(await row.innerText()).includes('Senior Tech')) fail('not marked as Senior Tech');
  if ((await row.getByTestId('standby-eligible-main').count()) !== 1 || (await row.getByTestId('standby-eligible-apprentice').count()) !== 0) fail('the wrong places are offered');
  await press(row.getByTestId('standby-eligible-main'));
  await page.getByText('Standby eligibility saved for Elmarie', { exact: false }).waitFor({ timeout: 15000 });
});

/* ---- Timesheets ----------------------------------------------------------- */
await check('the timesheet line form has no Shared call-out tick; it says the amount is your own share', async () => {
  await as('Sipho Mahlangu');
  await go('/timesheets');
  await press(page.getByTestId('add-timesheet-line').first());
  const form = page.getByTestId('timesheet-line-form');
  await form.waitFor({ timeout: 15000 });
  if ((await form.getByTestId('timesheet-callout-shared').count()) !== 0) fail('the Shared call-out tick is still there');
  const hint = await form.getByTestId('timesheet-callout-hint').innerText();
  if (!/own share|YOUR share/iu.test(hint) || !/divided/iu.test(hint)) fail(`the hint reads "${hint}"`);
  await noPageOverflow('the timesheet line form');
  await press(form.getByRole('button', { name: 'Cancel', exact: true }));
});

await check('overlapping periods are sent; the later replaces the earlier for the office; the lines stay', async () => {
  await as('Sipho Mahlangu');
  const me = 'user-tech-sipho';
  const line = await call('POST', `/api/timesheets/${me}/entries`, { date: shift(today, -3), customerName: 'Acceptance', overtimeHours: 1, doubleHours: 0 });
  if (line.status !== 200) fail(`saving a line answered ${line.status}`);
  const first = await call('POST', `/api/timesheets/${me}/period/submit`, { from: shift(today, -10), to: shift(today, -2) });
  const second = await call('POST', `/api/timesheets/${me}/period/submit`, { from: shift(today, -5), to: today });
  if (first.status !== 200 || second.status !== 200) fail(`the sends answered ${first.status} and ${second.status} ${JSON.stringify(second.json?.error ?? '')}`);
  // Dates overlapping the last submission: the page says submitting replaces it (the earlier one is kept).
  await go('/timesheets');
  await page.getByTestId('timesheet-from').fill(shift(today, -12));
  await page.getByTestId('timesheet-period-overlap').filter({ hasText: 'replaces' }).waitFor({ timeout: 15000 });
  const sheet = (await call('GET', `/api/timesheets/${me}?from=${shift(today, -10)}&to=${today}`)).json?.data;
  if (sheet !== undefined && sheet !== null) {
    const lines = sheet.days.flatMap((day) => day.entries ?? []);
    if (!lines.some((entry) => entry.customerName === 'Acceptance')) fail('the line was lost');
  }
  await noPageOverflow('the timesheet');
});

/* ---- The Delivery Note ---------------------------------------------------- */
let note = null;
await check('the Office raises a Delivery Note with its delivery date; it goes straight to completion, no technician', async () => {
  await as('Christene van Niekerk');
  await go('/jobs/new');
  await page.getByLabel('Job type').selectOption('delivery_note');
  await page.getByTestId('delivery-note-details').waitFor({ timeout: 15000 });
  const first = async (labelText) => {
    const field = page.getByLabel(labelText, { exact: false }).first();
    const values = await field.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
    await field.selectOption(values[0]);
  };
  await first('Customer');
  await page.waitForTimeout(300);
  await first('Site');
  await page.waitForTimeout(300);
  await first('Customer email recipient');
  await page.getByTestId('delivery-date').fill(today);
  if ((await page.getByText('Who is doing the work?').count()) !== 0) fail('a technician is asked for');
  await noPageOverflow('New Job — Delivery Note');
  await press(page.getByRole('button', { name: 'Create job' }));
  await page.waitForURL('**/jobs/EJE-**', { timeout: 25000 });
  note = page.url().split('/').pop().split('?')[0];
  const job = (await call('GET', `/api/jobs/${note}`)).json.data.view.job;
  if (job.jobType !== 'delivery_note' || job.status !== 'completion' || job.primaryTechnicianId !== null || job.deliveryDate !== today) {
    fail(`raised as ${JSON.stringify({ type: job.jobType, status: job.status, tech: job.primaryTechnicianId, date: job.deliveryDate })}`);
  }
  return note;
});

await check('two part lines with comments — and no price field, no total', async () => {
  if (note === null) fail('no Delivery Note');
  // Straight into its completion workflow, as the New Job page leaves it.
  await go(`/jobs/${note}?continue=1`);
  const add = page.getByRole('button', { name: /Add part/u }).first();
  await press(add);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 15000 });
  if ((await dialog.getByLabel('Unit price (excl. VAT)').count()) !== 0) fail('a price field is offered');
  const fill = async (index, number, description, quantity, comment) => {
    const line = dialog.getByTestId('part-line').nth(index);
    await line.getByLabel('Part number').fill(number);
    await line.getByLabel('Description').fill(description);
    await line.getByLabel('Quantity').fill(quantity);
    await line.getByTestId('part-comment-input').fill(comment);
  };
  await fill(0, 'LU-200', 'Loan servo drive', '1', 'Loan unit');
  await press(dialog.getByTestId('add-part-line'));
  await fill(1, 'ENC-1024', 'Encoder, 1024 ppr', '2', 'Part returned');
  if ((await dialog.getByText('Parts total').count()) !== 0) fail('a parts total is shown');
  await noPageOverflow('the parts dialog');
  await press(dialog.getByTestId('save-parts'));
  await dialog.waitFor({ state: 'detached', timeout: 20000 });
  const job = (await call('GET', `/api/jobs/${note}`)).json.data.view.job;
  if (JSON.stringify(job.parts.map((part) => [part.partNumber, part.quantity, part.unitPrice, part.comment])) !== JSON.stringify([['LU-200', 1, 0, 'Loan unit'], ['ENC-1024', 2, 0, 'Part returned']])) {
    fail(`the lines are ${JSON.stringify(job.parts)}`);
  }
  // The server refuses a price on it whatever the screen does.
  const priced = await call('POST', `/api/jobs/${job.id}/add_part`, { partNumber: 'X', description: 'Priced', quantity: 1, unitPrice: 100 });
  if (priced.status !== 422) fail(`a priced line answered ${priced.status}`);
  const text = await page.locator('main').innerText();
  if (/Job value/u.test(text)) fail('a job value is shown');
});

await check('courier collection needs its waybill; signed and issued, it is CLOSED as a Delivery Note with its document', async () => {
  if (note === null) fail('no Delivery Note');
  const job = (await call('GET', `/api/jobs/${note}`)).json.data.view.job;
  const noWaybill = await call('POST', `/api/jobs/${job.id}/set_collection`, { courier: true, waybillNumber: '' });
  if (noWaybill.status !== 422) fail(`a courier collection with no waybill answered ${noWaybill.status}`);
  for (const [path, body] of [
    ['set_collection', { courier: true, waybillNumber: 'DAW-ACCEPT-1' }],
    ['start_signature', {}],
    ['capture_signature', { customerName: 'Thabo', customerSurname: 'Dlamini', strokeData: 'M10,10 L60,40 L120,20' }],
  ]) {
    const answer = await call('POST', `/api/jobs/${job.id}/${path}`, body);
    if (answer.status !== 200) fail(`${path} answered ${answer.status} ${JSON.stringify(answer.json?.error ?? '')}`);
  }
  await go(`/jobs/${note}`);
  await press(page.getByRole('button', { name: 'Issue Delivery Note' }));
  await page.getByTestId('issue-delivery-note-message').waitFor({ timeout: 15000 });
  await press(page.getByRole('dialog').getByRole('button', { name: 'Issue Delivery Note' }));
  await page.getByTestId('status-delivery-note').first().waitFor({ timeout: 25000 });
  const closed = (await call('GET', `/api/jobs/${note}`)).json.data.view.job;
  if (closed.status !== 'closed' || closed.finalDocument?.fileName !== `${note}-Delivery-Note.pdf` || closed.invoice !== null) fail(`the job is ${closed.status}`);
  const pdf = await call('POST', `/api/documents/${note}`, {});
  if (pdf.status !== 200 || pdf.json?.data?.fileName !== `${note}-Delivery-Note.pdf`) fail(`the document answered ${pdf.status} ${pdf.json?.data?.fileName}`);
  // Signed: nothing on it changes.
  const late = await call('POST', `/api/jobs/${closed.id}/add_part`, { partNumber: 'LATE', description: 'Late', quantity: 1, unitPrice: 0 });
  if (late.status === 200) fail('a signed Delivery Note took another line');
  await noPageOverflow('the closed Delivery Note');
});

await check('Closed Jobs shows it as a Delivery Note — filterable, and apart from Invoiced', async () => {
  if (note === null) fail('no Delivery Note');
  await go('/jobs/closed');
  await page.getByTestId('closed-outcome').selectOption('delivery_note');
  const row = page.getByTestId(`closed-status-${note}`).first();
  await row.waitFor({ timeout: 20000 });
  await row.getByText('Delivery Note').waitFor({ timeout: 5000 });
  await page.getByTestId('closed-outcome').selectOption('invoiced');
  await page.waitForTimeout(800);
  if ((await page.getByTestId(`closed-status-${note}`).count()) !== 0) fail('the Delivery Note is listed as Invoiced');
  await noPageOverflow('Closed Jobs');
});

/* ---- Follow-up (3 November 2026): the Test & Repair delivery-note photo ---- */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
let repair = null;
await check('Test & Repair: Take Photo (camera) and Choose Photo; a chosen photo is previewed, a PDF refused; the job is raised with it', async () => {
  await as('Christene van Niekerk');
  await go('/jobs/new');
  await page.getByLabel('Job type').selectOption('test_and_repair');
  const block = page.getByTestId('reference-photo-block');
  await block.waitFor({ timeout: 15000 });
  if ((await block.getByText('Take Photo').count()) !== 1 || (await block.getByText('Choose Photo').count()) !== 1) fail('the two buttons are not both there');
  if ((await page.getByTestId('reference-photo-take').getAttribute('capture')) !== 'environment') fail('Take Photo does not ask for the camera');
  if ((await page.getByTestId('reference-photo-choose').getAttribute('capture')) !== null) fail('Choose Photo asks for the camera');
  await page.getByTestId('reference-photo-choose').setInputFiles({ name: 'order.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not a photo') });
  await page.getByTestId('reference-photo-error').waitFor({ timeout: 5000 });
  await page.getByTestId('reference-photo-choose').setInputFiles({ name: 'delivery-note.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await page.getByTestId('reference-photo-item').filter({ hasText: 'delivery-note.png' }).waitFor({ timeout: 5000 });
  const first = async (labelText) => {
    const field = page.getByLabel(labelText, { exact: false }).first();
    const values = await field.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
    await field.selectOption(values[0]);
  };
  await first('Customer');
  await page.waitForTimeout(300);
  if ((await page.getByLabel('Site', { exact: false }).count()) > 0 && (await page.getByTestId('job-site').count()) === 0) await first('Site');
  await page.waitForTimeout(300);
  await first('Customer email recipient');
  const technician = page.getByLabel('Primary technician');
  if ((await technician.count()) > 0) await technician.selectOption({ label: 'Sipho Mahlangu' }).catch(() => {});
  await noPageOverflow('New Job — Test & Repair');
  await press(page.getByRole('button', { name: 'Create job' }));
  await page.waitForURL('**/jobs/EJE-**', { timeout: 30000 });
  repair = page.url().split('/').pop().split('?')[0];
  const job = (await call('GET', `/api/jobs/${repair}`)).json.data.view.job;
  const photo = job.photos.find((item) => item.purpose === 'delivery_note_reference');
  if (photo === undefined || photo.visibility !== 'internal') fail(`stored as ${JSON.stringify(photo)}`);
  await page.getByTestId('reference-photo-card').waitFor({ timeout: 20000 });
  return repair;
});

await check('the technician opening the job sees the delivery-note photo; it is never on the job card', async () => {
  if (repair === null) fail('no Test & Repair job');
  await as('Sipho Mahlangu');
  await go(`/jobs/${repair}`);
  await page.getByTestId('reference-photo-card').waitFor({ timeout: 20000 });
  const src = await page.getByTestId('reference-photo-link').first().getAttribute('href');
  const image = await call('GET', src);
  if (image.status !== 200) fail(`the photo answered ${image.status}`);
  const job = (await call('GET', `/api/jobs/${repair}`)).json.data.view.job;
  // The internal photo cannot be turned customer-facing through the API either.
  const id = job.photos.find((item) => item.purpose === 'delivery_note_reference').id;
  const shown = await call('POST', `/api/jobs/${job.id}/set_media_visibility`, { attachmentId: id, visibility: 'customer_facing' });
  if (shown.status === 200) fail('the reference photo was made customer-facing');
  await noPageOverflow('the Test & Repair job');
});

/* ---- Follow-up: the simpler Delivery Note -------------------------------- */
let siteless = null;
await check('Delivery Note: no site needed, no order or reference number; raised without a site', async () => {
  await as('Christene van Niekerk');
  await go('/jobs/new');
  await page.getByLabel('Job type').selectOption('delivery_note');
  await page.getByTestId('delivery-note-details').waitFor({ timeout: 15000 });
  const customer = page.getByLabel('Customer', { exact: false }).first();
  const values = await customer.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
  await customer.selectOption(values[0]);
  await page.waitForTimeout(300);
  const site = page.getByTestId('job-site-optional');
  await site.waitFor({ timeout: 10000 });
  if ((await site.inputValue()) !== '') fail('a site was chosen for the office');
  if ((await page.getByLabel('Customer order number').count()) !== 0 || (await page.getByLabel('Reference number').count()) !== 0) fail('order or reference number is still asked');
  if ((await page.getByTestId('reference-photo-block').count()) !== 0) fail('the Test & Repair photo is offered on a Delivery Note');
  const recipient = page.getByLabel('Customer email recipient');
  const contacts = await recipient.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
  await recipient.selectOption(contacts[0]);
  await page.getByTestId('delivery-date').fill(today);
  await noPageOverflow('New Job — Delivery Note without a site');
  await press(page.getByRole('button', { name: 'Create job' }));
  await page.waitForURL('**/jobs/EJE-**', { timeout: 30000 });
  siteless = page.url().split('/').pop().split('?')[0];
  const job = (await call('GET', `/api/jobs/${siteless}`)).json.data.view;
  if (job.job.siteId !== null || job.siteRecorded !== false || job.job.orderNumber !== '' || job.job.referenceNumber !== '') fail(`raised as ${JSON.stringify({ site: job.job.siteId, order: job.job.orderNumber })}`);
  return siteless;
});

await check('Delivery Note completion: no Additional Charges section; parts, collection and issue still work without a site', async () => {
  if (siteless === null) fail('no Delivery Note');
  await go(`/jobs/${siteless}?continue=1`);
  await page.getByRole('button', { name: /Add part/u }).first().waitFor({ timeout: 20000 });
  if ((await page.getByText('Additional charges', { exact: true }).count()) !== 0) fail('the Additional Charges section is shown');
  const job = (await call('GET', `/api/jobs/${siteless}`)).json.data.view.job;
  const charge = await call('POST', `/api/jobs/${job.id}/add_additional_charge`, { description: 'Courier', amount: 25000 });
  if (charge.status !== 422) fail(`a charge answered ${charge.status}`);
  for (const [path, body] of [
    ['add_part', { partNumber: 'LU-200', description: 'Loan servo drive', quantity: 1, unitPrice: 0, comment: 'Loan unit' }],
    ['set_collection', { courier: false, waybillNumber: '' }],
    ['start_signature', {}],
    ['capture_signature', { customerName: 'Thabo', customerSurname: 'Dlamini', strokeData: 'M10,10 L60,40' }],
  ]) {
    const answer = await call('POST', `/api/jobs/${job.id}/${path}`, body);
    if (answer.status !== 200) fail(`${path} answered ${answer.status} ${JSON.stringify(answer.json?.error ?? '')}`);
  }
  const issued = await call('POST', `/api/jobs/${job.id}/issue`, {});
  if (issued.status !== 200) fail(`issue answered ${issued.status} ${JSON.stringify(issued.json?.error ?? '')}`);
  const closed = (await call('GET', `/api/jobs/${siteless}`)).json.data.view.job;
  if (closed.status !== 'closed') fail(`the note is ${closed.status}`);
  await go(`/jobs/${siteless}`);
  await page.getByTestId('status-delivery-note').first().waitFor({ timeout: 20000 });
  await noPageOverflow('the site-less Delivery Note');
});

await check('no page errors anywhere in the run', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([state]) => state === 'FAIL');
console.log(`\n${label}: ${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
