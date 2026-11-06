/**
 * ONE BLOCK PER DAY — THE TIMESHEETS PAGE THROUGH THE SCREEN (TS-DAY-1, the
 * owner, 6 November 2026).
 *
 * At one screen size per run (EJE_FORMS_VIEWPORT), as a technician:
 *   - every day of the period is one block, closed: its date, "Not recorded"
 *     or what its lines add up to, and whether it is saved;
 *   - opened, Add line is inside the day; a line typed there saves itself;
 *     reopened after a refresh it is still there, and a saved line is edited
 *     like a new one (it never becomes read-only);
 *   - a second and a third customer or site under the SAME day: no second
 *     block, nothing of the first copied; the second edited on its own; one
 *     removed (after its confirmation; Cancel keeps it) and the others stay;
 *   - the day's figures are its lines added up, once: the day blocks add up
 *     to the period's totals and to the PDF's (what Finance is sent);
 *   - a line not complete yet is a Draft that says what it needs;
 *   - a save cut off is kept and said, Retry saves it once (no second line);
 *   - Change date moves the whole day — across a month and a year end;
 *   - lines from before the redesign are on their days and editable; a
 *     submitted timesheet is never on this page and stays exactly as it was;
 *   - the save notice is part of the page: it scrolls away with it;
 *   - Timesheets and Attendance show no submitted history; My Monthly Forms does;
 *   - a long period (a year) lays out; no page error, nothing scrolls sideways.
 *
 *   npm run timesheet-days-check                    (desktop, 1440x900)
 *   EJE_FORMS_VIEWPORT=768x1024:touch npm run timesheet-days-check
 *   EJE_FORMS_VIEWPORT=390x844:touch npm run timesheet-days-check
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
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const FROM = shift(today, -12);
const TO = today;
const DAY = shift(today, -4);
// A month end and a year end, for Change date and the period across them.
const YEAR = Number(today.slice(0, 4));
const YEAR_END = `${YEAR}-12-31`;
const NEW_YEAR = `${YEAR + 1}-01-02`;

const press = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  if (touch) await locator.tap();
  else await locator.click();
};
const go = (path) => page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
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
const saved = () =>
  page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === 'saved', null, { timeout: 20000 });
const dayOf = (date) => page.locator(`[data-testid="timesheet-day"][data-date="${date}"]`);
const linesOf = (date) => dayOf(date).locator('[data-testid="timesheet-line"]');
const lineById = (id) => page.locator(`[data-testid="timesheet-line"][data-line-id="${id}"]`);
const openSheet = async (from = FROM, to = TO) => {
  await go(`/timesheets?from=${from}&to=${to}`);
  await page.getByTestId('timesheet-days').waitFor({ timeout: 30000 });
};
const openDay = async (date) => {
  if ((await dayOf(date).getAttribute('data-open')) !== 'yes') await press(dayOf(date).getByTestId('timesheet-day-toggle'));
  await dayOf(date).getByTestId('timesheet-day-body').waitFor({ timeout: 10000 });
};
const addLine = async (date, values = {}) => {
  await openDay(date);
  const before = await linesOf(date).count();
  await press(page.getByTestId(`add-timesheet-line-${date}`));
  await page.waitForFunction(([d, n]) => document.querySelectorAll(`[data-testid="timesheet-day"][data-date="${d}"] [data-testid="timesheet-line"]`).length > n, [date, before], { timeout: 10000 });
  const id = await linesOf(date).nth(before).getAttribute('data-line-id');
  const fields = { customer: 'timesheet-customer-name', ot: 'timesheet-overtime', dt: 'timesheet-double', callout: 'timesheet-callout', ikm: 'timesheet-internal-km', ckm: 'timesheet-customer-km' };
  for (const [key, value] of Object.entries(values)) await lineById(id).getByTestId(fields[key]).fill(value);
  return id;
};
const me = async () => (await call('GET', '/api/auth/me')).json.data.user.id;
const heldLines = async () => (await call('GET', `/api/timesheets/${await me()}/lines`)).json.data;
const summaryOf = async (date) => (await dayOf(date).getByTestId('timesheet-day-summary').innerText()).replace(/\s+/gu, ' ');
const money = (text) => Number(text.replace(/[^\d,.-]/gu, '').replace(/\s/gu, '').replace(',', '.'));

console.log(`TS-DAY-1 check at ${label} against ${BASE} — period ${FROM} … ${TO}`);
await go('/');
await resetDemonstration(page, BASE);
await signInAs(page, 'Sipho Mahlangu', { base: BASE });

// What was there before anything is typed: lines from before the redesign, and the submitted timesheets.
let before = [];
let submittedBefore = [];
await check('lines from before the redesign are on their days, editable; a submitted timesheet is not on this page', async () => {
  // Written the way lines were before the redesign (the stored line, through the older route), and one period submitted.
  const who = await me();
  const old = async (date, customerName, overtimeHours) => {
    const answer = await call('POST', `/api/timesheets/${who}/entries`, { date, customerName, overtimeHours, doubleHours: 0 });
    if (answer.status !== 200) fail(`writing an earlier line answered ${answer.status}`);
  };
  await old(shift(today, -30), 'Before Redesign Submitted', 3);
  const sent = await completeAndSubmit(call, who, shift(today, -31), shift(today, -29));
  if (sent.status !== 200) fail(`submitting the earlier period answered ${sent.status} ${JSON.stringify(sent.json?.error ?? '')}`);
  await old(shift(today, -20), 'Before Redesign One', 1.5);
  await old(shift(today, -20), 'Before Redesign Two', 2);
  before = await heldLines();
  const list = (await call('GET', `/api/timesheets/submissions?userId=${await me()}`)).json?.data ?? [];
  submittedBefore = await Promise.all(list.map(async (submission) => ({ id: submission.id, document: (await call('GET', `/api/timesheets/submissions/${submission.id}?version=original`)).json?.data })));
  const working = before.filter((line) => line.submitted === null && line.date !== null);
  const submitted = before.filter((line) => line.submitted !== null);
  if (working.length < 2 || submitted.length < 1) fail(`${working.length} working and ${submitted.length} submitted earlier lines`);
  const dates = [...working, ...submitted].map((line) => line.date).sort();
  await openSheet(dates[0] < FROM ? dates[0] : FROM, TO);
  for (const line of working.slice(0, 5)) {
    await openDay(line.date);
    const shown = lineById(line.id);
    if ((await shown.count()) !== 1) fail(`the earlier line on ${line.date} is not on its day`);
    if (!(await shown.getByTestId('timesheet-overtime').isEditable())) fail('an earlier line is read-only');
  }
  const day = await summaryOf(shift(today, -20));
  // v1.7.1: the customers by name, never "2 lines · 2 customers/sites".
  if (/\b\d+ lines?\b|customers?\/sites?/u.test(day) || !/OT 3\.50/u.test(day)) fail(`the earlier day reads "${day}"`);
  const kept = await summaryOf(shift(today, -30));
  // Which timesheet holds it, in words — never just "Submitted".
  if (!/Already in your timesheet .* sent to the office/u.test(kept)) fail(`the submitted day reads "${kept}" on Timesheets`);
  if ((await page.getByTestId('timesheet-sent-overlap').count()) !== 1) fail('the page does not say the chosen dates reach into a timesheet already sent');
  for (const line of submitted) {
    if ((await lineById(line.id).count()) > 0) fail(`the submitted line on ${line.date} is on the Timesheets page`);
  }
  return `${working.length} earlier working line(s) on their days; ${submitted.length} submitted line(s) not on the page`;
});

await check('1. every day of the period is ONE block, closed: its date and "Not recorded"; no Add line until a day is opened; no submitted history', async () => {
  await openSheet();
  const days = await page.getByTestId('timesheet-day').count();
  if (days !== 13) fail(`${days} day blocks for 13 days`);
  if ((await page.locator('[data-testid="timesheet-day"][data-open="yes"]').count()) !== 0) fail('a day is open when the page opens');
  if ((await page.locator('[data-testid^="add-timesheet-line"]').count()) !== 0) fail('an Add line button is outside a day');
  if (!/Not recorded/u.test(await summaryOf(DAY))) fail(`an empty day reads "${await summaryOf(DAY)}"`);
  for (const gone of ['timesheet-submissions', 'timesheet-submission', 'timesheet-office', 'my-submitted-timesheets', 'my-monthly-history']) {
    if ((await page.getByTestId(gone).count()) > 0) fail(`Timesheets shows ${gone}`);
  }
});

await check('the save notice is part of the page: it scrolls away with it', async () => {
  const notice = page.getByTestId('autosave-status');
  if (!/saves by itself/u.test(await notice.innerText())) fail('the notice is not shown');
  const position = await notice.evaluate((element) => {
    let at = element;
    while (at !== null) {
      const style = getComputedStyle(at);
      if (style.position === 'sticky' || style.position === 'fixed') return style.position;
      at = at.parentElement;
    }
    return 'static';
  });
  if (position !== 'static') fail(`the notice is ${position}`);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const box = await notice.boundingBox();
  if (box !== null && box.y + box.height > 0 && box.y < height && (await page.evaluate(() => document.documentElement.scrollHeight)) > height * 1.6) fail(`the notice is still in view at the bottom of the page (y ${Math.round(box.y)})`);
});

let first = null;
await check('2–3. a day opened: Add line inside it; the day\'s line typed — saved by itself, the day says Saved', async () => {
  first = await addLine(DAY, { customer: 'Day Check Alpha', ot: '2', callout: '300', ckm: '12.5' });
  await saved();
  await page.waitForFunction((d) => document.querySelector(`[data-testid="timesheet-day"][data-date="${d}"]`)?.getAttribute('data-state') === 'saved', DAY, { timeout: 15000 });
  if ((await lineById(first).getAttribute('data-state')) !== 'saved') fail('the line does not say Saved');
  const summary = await summaryOf(DAY);
  if (/\b\d+ lines?\b|customers?\/sites?/u.test(summary) || !/Day Check Alpha/u.test(summary) || !/OT 2\.00/u.test(summary)) fail(`the day reads "${summary}"`);
});

await check('4–6. reopened after a refresh, the saved line is edited like a new one — and the change is kept', async () => {
  await openSheet();
  if ((await dayOf(DAY).getAttribute('data-open')) !== 'no') fail('the day is open after a refresh');
  if (!/OT 2\.00/u.test(await summaryOf(DAY))) fail('the closed day does not show what was saved');
  await openDay(DAY);
  const ot = lineById(first).getByTestId('timesheet-overtime');
  if (!(await ot.isEditable())) fail('the saved line is read-only');
  await ot.fill('2.75');
  await lineById(first).getByTestId('timesheet-customer-name').fill('Day Check Alpha Site 2');
  await saved();
  await openSheet();
  await openDay(DAY);
  if ((await lineById(first).getByTestId('timesheet-overtime').inputValue()) !== '2.75') fail('the edit was not kept');
  if ((await lineById(first).getByTestId('timesheet-customer-name').inputValue()) !== 'Day Check Alpha Site 2') fail('the customer change was not kept');
});

let second = null;
let third = null;
await check('7–8. a second and a third customer under the SAME day: one block, each line new and empty — nothing copied', async () => {
  second = await addLine(DAY);
  for (const field of ['timesheet-overtime', 'timesheet-double', 'timesheet-callout', 'timesheet-customer-km']) {
    if ((await lineById(second).getByTestId(field).inputValue()) !== '0') fail(`the second line starts with ${field} = ${await lineById(second).getByTestId(field).inputValue()}`);
  }
  if ((await lineById(second).getByTestId('timesheet-customer-name').inputValue()) !== '') fail('the second line copied the customer');
  await lineById(second).getByTestId('timesheet-customer-name').fill('Day Check Bravo');
  await lineById(second).getByTestId('timesheet-double').fill('1.5');
  third = await addLine(DAY, { customer: 'Day Check Charlie', ot: '0.5', ikm: '7.5' });
  await saved();
  if ((await page.locator(`[data-testid="timesheet-day"][data-date="${DAY}"]`).count()) !== 1) fail('a second block for the same date');
  if ((await linesOf(DAY).count()) !== 3) fail(`${await linesOf(DAY).count()} lines under the day`);
  const summary = await summaryOf(DAY);
  // Every customer of the day by name, in line order — none dropped.
  if (/\b\d+ lines?\b|customers?\/sites?/u.test(summary) || !summary.includes('Day Check Alpha Site 2, Day Check Bravo, Day Check Charlie')) fail(`the day reads "${summary}"`);
});

await check('9. the second line edited on its own: the first and third are untouched', async () => {
  await lineById(second).getByTestId('timesheet-double').fill('2.25');
  await lineById(second).getByTestId('timesheet-callout').fill('150');
  await saved();
  const held = await heldLines();
  const of = (id) => held.find((line) => line.id === id)?.typed;
  if (Number(of(second)?.double) !== 2.25 || Number(of(second)?.callout) !== 150) fail(`the second line holds ${JSON.stringify(of(second))}`);
  if (Number(of(first)?.overtime) !== 2.75 || Number(of(first)?.double) !== 0) fail(`the first line changed: ${JSON.stringify(of(first))}`);
  if (Number(of(third)?.overtime) !== 0.5 || Number(of(third)?.double) !== 0) fail(`the third line changed: ${JSON.stringify(of(third))}`);
});

await check('10. one line removed after its confirmation (Cancel keeps it); the day and its other lines stay', async () => {
  await press(lineById(third).getByTestId('remove-timesheet-line'));
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  if (!/Day Check Charlie/u.test(await dialog.innerText())) fail('the confirmation does not name the line');
  await press(dialog.getByRole('button', { name: 'Cancel' }));
  await dialog.waitFor({ state: 'detached', timeout: 5000 });
  if ((await lineById(third).count()) !== 1) fail('Cancel removed the line');
  await press(lineById(third).getByTestId('remove-timesheet-line'));
  await press(page.getByRole('dialog').getByRole('button', { name: 'Remove line' }));
  await saved();
  await openSheet();
  await openDay(DAY);
  const ids = await linesOf(DAY).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-line-id')));
  if (ids.length !== 2 || !ids.includes(first) || !ids.includes(second)) fail(`the day holds ${ids.length} lines after the removal`);
  if ((await heldLines()).some((line) => line.id === third)) fail('the removed line is still on the server');
});

await check('11. the day is its lines added up once; the days add up to the period and to the PDF Finance is sent', async () => {
  const summary = await summaryOf(DAY);
  if (!/OT 2\.75/u.test(summary) || !/D\/T 2\.25/u.test(summary) || !/Int Km 0\.0/u.test(summary) || !/Cust Km 12\.5/u.test(summary)) fail(`the day reads "${summary}"`);
  if (Math.round(money(summary.split('Callout')[1].split('·')[0]) * 100) !== 45_000) fail(`the day's call-out reads "${summary}"`);
  const document = (await call('GET', `/api/payroll/forms/${await me()}/timesheet?from=${FROM}&to=${TO}`)).json?.data;
  const totals = document?.totals;
  if (totals === undefined) fail('the PDF document did not load');
  // Every day block added up — the same total the PDF prints.
  const sums = { ot: 0, dt: 0 };
  for (const element of await page.getByTestId('timesheet-day-summary').all()) {
    const text = await element.innerText();
    sums.ot += Number(/OT (\d+\.\d+)/u.exec(text)?.[1] ?? 0);
    sums.dt += Number(/D\/T (\d+\.\d+)/u.exec(text)?.[1] ?? 0);
  }
  if (Math.abs(sums.ot - totals.overtimeHours) > 0.001 || Math.abs(sums.dt - totals.doubleHours) > 0.001) fail(`the days add up to OT ${sums.ot} D/T ${sums.dt}; the PDF says OT ${totals.overtimeHours} D/T ${totals.doubleHours}`);
  const rows = document.rows.filter((row) => row.date === DAY && row.recorded);
  if (rows.length !== 2) fail(`the PDF has ${rows.length} rows for the day (a row per line, never one more)`);
  const period = await page.getByTestId('timesheet-totals').innerText();
  if (!period.includes(`OT ${totals.overtimeHours.toFixed(2)}`)) fail(`the period reads "${period}", the PDF OT ${totals.overtimeHours}`);
  return `day OT 2.75, D/T 2.25, call-out R450; period OT ${totals.overtimeHours.toFixed(2)} = PDF`;
});

await check('v1.7.1: the headings are centred over their fields; Done · Add line · Change date under the rows; Done closes the day only', async () => {
  await openSheet();
  await openDay(DAY);
  const day = dayOf(DAY);
  // Measured together, in one go: each heading's centre over its field's centre, and its text centred down its row.
  const offsets = await day.evaluate((element) => {
    const heads = [...element.querySelectorAll('[data-testid="timesheet-columns"] > span')].slice(0, 6);
    const row = element.querySelector('[data-testid="timesheet-line"]');
    const fields = ['timesheet-customer-name', 'timesheet-overtime', 'timesheet-double', 'timesheet-callout', 'timesheet-internal-km', 'timesheet-customer-km']
      .map((id) => row?.querySelector(`[data-testid="${id}"]`));
    return heads.map((head, index) => {
      const box = head.getBoundingClientRect();
      const field = fields[index]?.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(head);
      const words = text.getBoundingClientRect();
      return {
        name: head.textContent,
        across: field === undefined ? 99 : Math.abs(box.left + box.width / 2 - (field.left + field.width / 2)),
        words: Math.abs(words.left + words.width / 2 - (box.left + box.width / 2)),
        down: Math.abs(words.top + words.height / 2 - (box.top + box.height / 2)),
      };
    });
  });
  if (offsets.map((offset) => offset.name).join('|') !== 'Customer|OT|D/T|Callout (R)|Int Km|Cust Km') fail(`the columns are ${offsets.map((offset) => offset.name).join('|')}`);
  for (const offset of offsets) {
    if (offset.across > 1.5 || offset.words > 1.5 || offset.down > 1.5) fail(`"${offset.name}" is off centre: ${JSON.stringify(offset)}`);
  }
  // No Close up in the heading; Done, Add line, Change date — in that order — under the rows.
  if (/\bClose\b/u.test(await day.getByTestId('timesheet-day-toggle').innerText())) fail('the heading still says Close');
  const order = await day.getByTestId('timesheet-day-actions').evaluate((element) => [...element.querySelectorAll('button')].map((button) => button.textContent?.trim()));
  if (order.slice(0, 3).join('|') !== 'Done|Add line|Change date') fail(`the buttons are ${order.join('|')}`);
  const before = JSON.stringify((await heldLines()).filter((line) => line.date === DAY).map((line) => [line.id, line.typed]).sort());
  const forms = (await call('GET', `/api/payroll/forms/${await me()}/completed`)).json?.data;
  await press(day.getByTestId('timesheet-day-done'));
  if ((await day.getAttribute('data-open')) !== 'no') fail('Done did not close the day');
  if ((await dayOf(shift(DAY, -1)).getAttribute('data-open')) === 'yes') fail('Done opened another day');
  const after = JSON.stringify((await heldLines()).filter((line) => line.date === DAY).map((line) => [line.id, line.typed]).sort());
  if (after !== before) fail('Done changed the lines');
  const formsAfter = (await call('GET', `/api/payroll/forms/${await me()}/completed`)).json?.data;
  if (JSON.stringify(formsAfter?.timesheet ?? null) !== JSON.stringify(forms?.timesheet ?? null) || formsAfter?.readiness !== forms?.readiness) fail('Done completed or submitted something');
  // Reopened, the lines are there and still editable; an empty day says Not recorded, no zeros.
  await openDay(DAY);
  if (!(await linesOf(DAY).first().getByTestId('timesheet-overtime').isEditable())) fail('the day is locked after Done');
  const empty = page.locator('[data-testid="timesheet-day"][data-state="empty"]').first();
  if ((await empty.count()) === 1) {
    const text = await empty.getByTestId('timesheet-day-summary').innerText();
    if (!/Not recorded/u.test(text) || /OT|0\.00/u.test(text)) fail(`an empty day reads "${text}"`);
  }
  // On a phone, only the day's table scrolls sideways — never the page.
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`the page scrolls sideways by ${over}px`);
  return `centred within ${Math.max(...offsets.map((offset) => Math.max(offset.across, offset.down))).toFixed(2)}px`;
});

await check('12. a line not complete yet is a Draft that says what it needs; the day says Draft', async () => {
  const draft = await addLine(DAY, { ot: '1.234' });
  await saved();
  await page.waitForFunction((id) => document.querySelector(`[data-testid="timesheet-line"][data-line-id="${id}"]`)?.getAttribute('data-state') === 'draft', draft, { timeout: 15000 });
  if (!/two decimals/iu.test(await lineById(draft).innerText())) fail('the draft does not say what it needs');
  if ((await dayOf(DAY).getAttribute('data-state')) !== 'draft') fail('the day does not say Draft');
  await press(lineById(draft).getByTestId('remove-timesheet-line'));
  await press(page.getByRole('dialog').getByRole('button', { name: 'Remove line' }));
  await saved();
});

await check('13. a save cut off is kept and said; Retry saves it once — no second line', async () => {
  const day = shift(today, -6);
  await page.route('**/api/timesheets/*/lines', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
  const id = await addLine(day, { customer: 'Day Check Offline', ot: '1' });
  await page.waitForFunction(() => ['offline', 'failed'].includes(document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') ?? ''), null, { timeout: 20000 });
  const state = await dayOf(day).getAttribute('data-state');
  if (state === 'saved') fail('the day says Saved while nothing is saved');
  await page.unroute('**/api/timesheets/*/lines');
  await press(page.getByTestId('autosave-retry'));
  await saved();
  const held = (await heldLines()).filter((line) => line.typed.customerName === 'Day Check Offline');
  if (held.length !== 1 || held[0].id !== id) fail(`the server holds ${held.length} copies`);
  await press(lineById(id).getByTestId('remove-timesheet-line'));
  await press(page.getByRole('dialog').getByRole('button', { name: 'Remove line' }));
  await saved();
});

await check('Change date moves the whole day — over a month end and a year end — and nothing is left behind', async () => {
  await openSheet(`${YEAR}-12-30`, `${YEAR + 1}-01-03`);
  if ((await page.getByTestId('timesheet-day').count()) !== 5) fail('the period across the year end is not five days');
  const a = await addLine(YEAR_END, { customer: 'Year End Alpha', ot: '1' });
  const b = await addLine(YEAR_END, { customer: 'Year End Bravo', dt: '2' });
  await saved();
  await press(dayOf(YEAR_END).getByTestId('timesheet-day-move'));
  await dayOf(YEAR_END).getByTestId('timesheet-day-move-date').fill(NEW_YEAR);
  await press(dayOf(YEAR_END).getByTestId('timesheet-day-move-confirm'));
  await saved();
  await openSheet(`${YEAR}-12-30`, `${YEAR + 1}-01-03`);
  if (!/Not recorded/u.test(await summaryOf(YEAR_END))) fail('lines were left on the old date');
  const moved = await summaryOf(NEW_YEAR);
  if (!moved.includes('Year End Alpha, Year End Bravo') || !/OT 1\.00/u.test(moved) || !/D\/T 2\.00/u.test(moved)) fail(`the new date reads "${moved}"`);
  const held = (await heldLines()).filter((line) => [a, b].includes(line.id));
  if (held.length !== 2 || held.some((line) => line.date !== NEW_YEAR)) fail(`the server holds ${JSON.stringify(held.map((line) => line.date))}`);
  await openDay(NEW_YEAR);
  for (const id of [a, b]) {
    await press(lineById(id).getByTestId('remove-timesheet-line'));
    await press(page.getByRole('dialog').getByRole('button', { name: 'Remove line' }));
  }
  await saved();
});

await check('a period of a whole year lays out its 366 days, closed', async () => {
  const from = shift(today, -365);
  const started = Date.now();
  await openSheet(from, today);
  const days = await page.getByTestId('timesheet-day').count();
  if (days !== 366) fail(`${days} day blocks`);
  return `${days} days in ${Date.now() - started} ms`;
});

await check('20. Attendance shows no submitted history; My Monthly Forms has the submitted timesheets', async () => {
  await go('/attendance');
  await page.getByTestId('my-attendance-from').waitFor({ timeout: 20000 });
  for (const gone of ['my-monthly-history', 'timesheet-submissions', 'my-submitted-timesheets', 'timesheet-office']) {
    if ((await page.getByTestId(gone).count()) > 0) fail(`Attendance shows ${gone}`);
  }
  await go('/payroll/mine');
  await page.getByTestId('my-submitted-timesheets').waitFor({ timeout: 20000 });
  await page.getByTestId('my-monthly-history').waitFor({ timeout: 20000 });
});

await check('21. the timesheets submitted before are exactly as they were', async () => {
  for (const { id, document } of submittedBefore) {
    const now = (await call('GET', `/api/timesheets/submissions/${id}?version=original`)).json?.data;
    if (JSON.stringify(now?.rows) !== JSON.stringify(document?.rows) || JSON.stringify(now?.totals) !== JSON.stringify(document?.totals)) fail(`submission ${id} changed`);
  }
  const after = await heldLines();
  for (const line of before.filter((candidate) => candidate.submitted !== null)) {
    const still = after.find((candidate) => candidate.id === line.id);
    if (still === undefined || JSON.stringify(still.typed) !== JSON.stringify(line.typed) || still.date !== line.date) fail(`the submitted line ${line.id} changed`);
  }
  return `${submittedBefore.length} submission(s) unchanged`;
});

await check('a line with no date keeps its place while its date is typed, and joins its day once the field is left', async () => {
  const id = crypto.randomUUID();
  const kept = await call('POST', `/api/timesheets/${await me()}/lines`, { id, date: null, typed: { pick: '', customerName: 'No Date Yet', overtime: '1', double: '0', callout: '0', internalKm: '0', customerKm: '0' }, expectedRevision: null });
  if (kept.status !== 200) fail(`keeping an undated draft answered ${kept.status}`);
  await openSheet();
  const field = lineById(id).getByTestId('timesheet-line-date');
  await field.waitFor({ timeout: 15000 });
  await press(field);
  // Typed key by key, as a person does: the browser reports partial years on the way.
  for (const key of DAY.slice(0, 4)) {
    await page.keyboard.type(key);
    if ((await page.getByTestId('timesheet-undated').locator(`[data-line-id="${id}"]`).count()) !== 1) fail('the line left its place mid-typing');
  }
  await field.fill(DAY);
  await field.blur();
  await saved();
  await page.getByTestId('timesheet-undated').waitFor({ state: 'detached', timeout: 15000 });
  await openDay(DAY);
  await dayOf(DAY).locator(`[data-testid="timesheet-line"][data-line-id="${id}"]`).waitFor({ timeout: 15000 }).catch(() => fail('the line did not join its day'));
  await press(lineById(id).getByTestId('remove-timesheet-line'));
  await press(page.getByRole('dialog').getByRole('button', { name: 'Remove line' }));
  await saved();
});

await check('a change refused because its line was submitted elsewhere is said and can be discarded', async () => {
  const day = shift(today, -8);
  await openSheet();
  const id = await addLine(day, { customer: 'Submitted Elsewhere', ot: '1' });
  await saved();
  // This device loses its connection to the line saves, and the change waits here…
  await page.route('**/api/timesheets/*/lines', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
  await lineById(id).getByTestId('timesheet-overtime').fill('2');
  await page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === 'offline', null, { timeout: 20000 });
  // …while the day is submitted from elsewhere.
  const who = await me();
  const sent = await completeAndSubmit(call, who, day, day);
  if (sent.status !== 200) fail(`submitting the day answered ${sent.status} ${JSON.stringify(sent.json?.error ?? '')}`);
  await page.unroute('**/api/timesheets/*/lines');
  await press(page.getByTestId('autosave-retry'));
  const stranded = page.getByTestId('timesheet-stranded');
  await stranded.waitFor({ timeout: 20000 });
  if (!/submitted/iu.test(await stranded.innerText())) fail(`the notice reads "${await stranded.innerText()}"`);
  if ((await lineById(id).count()) !== 0) fail('the submitted line is on the page');
  await press(page.getByTestId('timesheet-stranded-discard'));
  await stranded.waitFor({ state: 'detached', timeout: 10000 });
  if ((await page.getByTestId('autosave-status').getAttribute('data-state')) === 'failed') fail('the page still says Save failed');
  const held = (await heldLines()).find((line) => line.id === id);
  if (held?.submitted === null || Number(held?.typed.overtime) !== 1) fail(`the submitted line holds ${JSON.stringify(held?.typed)}`);
});

await check('no page error; no page scrolls sideways', async () => {
  await openSheet();
  await openDay(DAY);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`Timesheets scrolls sideways by ${over}px`);
  if (errors.length > 0) fail(errors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([verdict]) => verdict === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed at ${label}`);
process.exit(failed.length === 0 ? 0 : 1);
