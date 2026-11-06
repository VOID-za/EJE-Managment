/**
 * PAYROLL-ONE-1 — TIMESHEETS AND ATTENDANCE SAVE THEMSELVES; MY MONTHLY FORMS
 * SUBMITS BOTH TOGETHER FOR THE PERIOD. THROUGH THE SCREEN (the owner,
 * 5 November 2026; docs/payroll-forms.md).
 *
 * At one screen size per run (EJE_FORMS_VIEWPORT): a technician chooses a
 * cross-month From and To on Timesheets, types several lines (no Save, no
 * Submit on the page), sees each saved, reloads and signs out and in — every
 * line is still there — edits one, records attendance for the same days,
 * opens My Monthly Forms for the period, previews and prints both forms,
 * renames both PDFs (kept after a reload), downloads both under those names,
 * is stopped by an incomplete line with a way to fix it, fixes it, submits
 * both together, and finds them in the history exactly as submitted — the
 * submitted lines read-only on Timesheets, the same submission refused a second
 * time. The office reads the period and its documents; another technician
 * reads none of it. No page scrolls sideways.
 *
 *   npm run payroll-forms-check                     (desktop, 1440x900)
 *   EJE_FORMS_VIEWPORT=768x1024:touch npm run payroll-forms-check
 *   EJE_FORMS_VIEWPORT=390x844:touch npm run payroll-forms-check
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs, signOut } from './sign-in.mjs';

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
if (process.env.EJE_TRACE_LINES === '1') {
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/lines')) { const b = JSON.parse(request.postData() ?? '{}'); console.log('  >', b.id?.slice(0, 8), b.date, JSON.stringify(b.typed?.customerName), b.typed?.overtime, b.expectedRevision?.slice(11, 23) ?? null); } });
  page.on('response', async (response) => { if (response.request().method() === 'POST' && response.url().includes('/lines')) { const j = await response.json().catch(() => null); console.log('  <', response.status(), j?.data?.line?.id?.slice(0, 8), JSON.stringify(j?.data?.line?.typed?.customerName), j?.data?.line?.revision?.slice(11, 23), j?.error?.violations?.[0]?.code ?? ''); } });
}

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
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// A CROSS-MONTH period ending yesterday: the 24th of two months ago … yesterday (at least a month and a bit).
const [year, month] = today.split('-').map(Number);
const twoBack = new Date(Date.UTC(year, month - 3, 24)).toISOString().slice(0, 10);
const FROM = twoBack;
const TO = shift(today, -1);
const inPeriod = [FROM, shift(FROM, 8), shift(TO, -2)];
const lines = (date) => page.locator(`[data-testid="timesheet-line"][data-date="${date}"]`);

/** Opens a day block (TS-DAY-1: every day starts closed). */
const openDay = async (date) => {
  const day = page.locator(`[data-testid="timesheet-day"][data-date="${date}"]`);
  if ((await day.getAttribute('data-open')) !== 'yes') await press(day.getByTestId('timesheet-day-toggle'));
  await day.getByTestId('timesheet-day-body').waitFor({ timeout: 10000 });
};
/** Opens Timesheets on exactly the period, with the days the check uses open. */
const openTimesheets = async () => {
  await go(`/timesheets?from=${FROM}&to=${TO}`);
  await page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  for (const date of inPeriod) await openDay(date);
};
/** Waits until every change on the page is on the server. */
const allSaved = async () => {
  await page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === 'saved', null, { timeout: 20000 });
};
/** Adds a line on a day through the screen, typing as a person does. */
const addLine = async (date, { customer = '', ot = '0', callout = '0', ckm = '0' } = {}) => {
  await openDay(date);
  const before = await lines(date).count();
  await press(page.getByTestId(`add-timesheet-line-${date}`));
  await page.waitForFunction(([d, n]) => document.querySelectorAll(`[data-testid="timesheet-line"][data-date="${d}"]`).length > n, [date, before], { timeout: 10000 });
  const row = lines(date).nth(before);
  if (customer !== '') await row.getByTestId('timesheet-customer-name').fill(customer);
  await row.getByTestId('timesheet-overtime').fill(ot);
  await row.getByTestId('timesheet-callout').fill(callout);
  await row.getByTestId('timesheet-customer-km').fill(ckm);
  return row;
};

console.log(`PAYROLL-ONE-1 check at ${label} against ${BASE} — period ${FROM} … ${TO}`);
await go('/');
await resetDemonstration(page, BASE);
await as('Sipho Mahlangu');

await check('1–4. Timesheets: a cross-month From and To, lines typed straight in, saved with no Save or Submit button', async () => {
  await openTimesheets();
  for (const forbidden of ['timesheet-send', 'save-timesheet-line', 'timesheet-save']) {
    if ((await page.getByTestId(forbidden).count()) > 0) fail(`the page still has ${forbidden}`);
  }
  if ((await page.getByRole('button', { name: /submit/iu }).count()) > 0) fail('a Submit button is on the Timesheets page');
  if ((await page.getByTestId('timesheet-from').inputValue()) !== FROM || (await page.getByTestId('timesheet-to').inputValue()) !== TO) fail('the period is not the one asked for');
  await addLine(inPeriod[0], { customer: 'Cross Month Customer A', ot: '2', callout: '450', ckm: '35.5' });
  await addLine(inPeriod[1], { customer: 'Cross Month Customer B', ot: '1.5' });
  await addLine(inPeriod[2], { customer: 'Cross Month Customer C', ot: '3' });
  await allSaved();
  if ((await page.getByTestId('autosave-conflict').count()) > 0) fail(`a save was refused as stale: ${await page.getByTestId('autosave-conflict').textContent()}`);
  if ((await page.locator('[data-testid="timesheet-line"][data-state="saved"]').count()) < 3) fail('not every line says Saved');
  await noPageOverflow('Timesheets');
  return `${await page.locator('[data-testid="timesheet-line"]').count()} lines, all saved`;
});

await check('5–6. a reload keeps every saved line', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  for (const date of inPeriod) await openDay(date);
  for (const [index, date] of inPeriod.entries()) {
    const value = await lines(date).first().getByTestId('timesheet-customer-name').inputValue();
    if (!value.startsWith('Cross Month Customer')) {
      const me = (await call('GET', '/api/auth/me')).json?.data?.user?.id;
      const held = (await call('GET', `/api/timesheets/${me}/lines`)).json?.data?.find((l) => l.date === date);
      fail(`line ${index + 1} on ${date} shows "${value}" after a reload; the server holds ${JSON.stringify(held?.typed ?? null)}`);
    }
  }
});

await check('7–10. signed out and in again: still there; an edit saves itself', async () => {
  await signOut(page);
  await as('Sipho Mahlangu');
  await openTimesheets();
  const row = lines(inPeriod[1]).first();
  if ((await row.getByTestId('timesheet-overtime').inputValue()) !== '1.5') fail('the line did not survive signing out');
  await row.getByTestId('timesheet-overtime').fill('2.5');
  await page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') !== 'saved', null, { timeout: 5000 }).catch(() => undefined);
  await allSaved();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  for (const date of inPeriod) await openDay(date);
  if ((await lines(inPeriod[1]).first().getByTestId('timesheet-overtime').inputValue()) !== '2.5') fail('the edit was not kept');
});

await check('an incomplete line is kept as a Draft on the server and says what it needs', async () => {
  const row = await addLine(inPeriod[2], { ot: '1.234' });
  await allSaved();
  await page.waitForFunction((d) => [...document.querySelectorAll(`[data-testid="timesheet-line"][data-date="${d}"]`)].some((el) => el.getAttribute('data-state') === 'draft'), inPeriod[2], { timeout: 15000 });
  if (!/two decimals/iu.test(await row.textContent())) fail('the draft does not say what it needs');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  for (const date of inPeriod) await openDay(date);
  if ((await page.locator(`[data-testid="timesheet-line"][data-date="${inPeriod[2]}"][data-state="draft"]`).count()) !== 1) fail('the draft was not kept across a reload');
});

await check('11–13. Attendance for the same days saves itself', async () => {
  await go(`/attendance?from=${FROM}&to=${TO}`);
  await page.getByTestId('autosave-status').waitFor({ timeout: 20000 });
  for (const date of [inPeriod[0], inPeriod[1]]) {
    const day = page.locator(`[data-testid="my-attendance-day"][data-date="${date}"]`);
    await press(day.getByTestId('my-attendance-present'));
  }
  await allSaved();
  if ((await page.getByRole('button', { name: /submit/iu }).count()) > 0) fail('a Submit button is on the Attendance page');
  await noPageOverflow('Attendance');
});

await check('14–17. My Monthly Forms: both forms for the period, the latest saved data, preview and print', async () => {
  await go(`/payroll/mine?from=${FROM}&to=${TO}`);
  await page.getByTestId('monthly-forms').waitFor({ timeout: 20000 });
  const financeMonth = await page.getByTestId('monthly-forms-finance-month').textContent();
  const expected = new Date(`${TO}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (!financeMonth?.includes(expected)) fail(`the Finance month says "${financeMonth}", not ${expected}`);
  const summary = await page.getByTestId('monthly-timesheet-summary').textContent();
  if (!/3 lines/u.test(summary ?? '')) fail(`the timesheet summary is not the latest data: ${summary}`);
  if (!/OT 7\.50/u.test(summary ?? '')) fail(`the OT total is not the edited value: ${summary}`);
  if (!/Present 2/u.test(await page.getByTestId('monthly-attendance-summary').textContent() ?? '')) fail('the attendance summary is not the latest data');
  for (const kind of ['timesheet', 'attendance']) {
    await press(page.getByTestId(`monthly-${kind}-preview`));
    await page.locator('[data-testid="document-preview"]').first().waitFor({ timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="document-preview"][data-preview-kind="loading"]'), null, { timeout: 20000 });
    if ((await page.locator('[data-testid="document-preview"][data-preview-kind="error"]').count()) > 0) fail(`the ${kind} preview failed`);
    await press(page.getByTestId('preview-close'));
    if ((await page.getByTestId(`monthly-${kind}-print`).count()) !== 1) fail(`no Print for the ${kind}`);
  }
  await noPageOverflow('My Monthly Forms');
});

await check('18–20. both PDFs renamed, kept after a reload, downloaded under those names', async () => {
  for (const [kind, name] of [['timesheet', 'Sipho Timesheet Payroll Check'], ['attendance', 'Sipho Attendance Payroll Check']]) {
    await press(page.getByTestId(`monthly-${kind}-rename`));
    await page.getByTestId('rename-input').fill('../bad/name');
    if (!(await page.getByTestId('rename-save').isDisabled())) fail('an unsafe name could be saved');
    await page.getByTestId('rename-input').fill(name);
    await press(page.getByTestId('rename-save'));
    await page.waitForFunction(([k, n]) => document.querySelector(`[data-testid="monthly-${k}-file"]`)?.textContent === `${n}.pdf`, [kind, name], { timeout: 15000 });
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('monthly-forms').waitFor({ timeout: 20000 });
  for (const [kind, name] of [['timesheet', 'Sipho Timesheet Payroll Check.pdf'], ['attendance', 'Sipho Attendance Payroll Check.pdf']]) {
    if ((await page.getByTestId(`monthly-${kind}-file`).textContent()) !== name) fail(`the ${kind} name was not kept`);
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), press(page.getByTestId(`monthly-${kind}-download`))]);
    if (download.suggestedFilename() !== name) fail(`the ${kind} downloaded as ${download.suggestedFilename()}`);
  }
});

await check('21–22. an incomplete line stops the submission, says which and how to fix it', async () => {
  if (!(await page.getByTestId('monthly-forms-submit').isDisabled())) fail('Submit is offered with an incomplete line');
  const problems = await page.getByTestId('monthly-forms-problems').textContent();
  if (!/is not complete/u.test(problems ?? '')) fail(`no explanation: ${problems}`);
  if ((await page.getByTestId('monthly-forms-fix-lines').count()) !== 1) fail('no way to the line from here');
});

await check('23. the line corrected on Timesheets', async () => {
  await press(page.getByTestId('monthly-forms-fix-lines'));
  await page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  // The link opens the days that hold a line not complete yet; nothing else is open.
  const day = page.locator(`[data-testid="timesheet-day"][data-date="${inPeriod[2]}"]`);
  await day.getByTestId('timesheet-day-body').waitFor({ timeout: 15000 });
  if ((await day.getAttribute('data-state')) !== 'draft') fail(`the day says ${await day.getAttribute('data-state')}, not Draft`);
  if ((await page.locator('[data-testid="timesheet-day"][data-open="yes"]').count()) !== 1) fail('more than the day to fix is open');
  // By its id: its state changes from Draft to Saving as soon as it is typed into.
  const id = await page.locator(`[data-testid="timesheet-line"][data-date="${inPeriod[2]}"][data-state="draft"]`).getAttribute('data-line-id', { timeout: 15000 });
  const draft = page.locator(`[data-testid="timesheet-line"][data-line-id="${id}"]`);
  await draft.getByTestId('timesheet-overtime').fill('1.25');
  await draft.getByTestId('timesheet-customer-name').fill('Cross Month Customer D');
  await allSaved();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="timesheet-line"][data-state="draft"]').length === 0, null, { timeout: 15000 });
});

let submissionId = null;
let sipho = 'user-tech-sipho';
await check('24–27. both forms submitted together, once; frozen with the names they went under', async () => {
  await go(`/payroll/mine?from=${FROM}&to=${TO}`);
  await page.getByTestId('monthly-forms').waitFor({ timeout: 20000 });
  for (const box of ['monthly-forms-acknowledge', 'monthly-forms-no-lines', 'monthly-forms-confirm-replace']) {
    if ((await page.getByTestId(box).count()) > 0) await page.getByTestId(box).check();
  }
  await press(page.getByTestId('monthly-forms-submit'));
  await press(page.getByRole('button', { name: /^Submit both$/u }));
  await page.getByTestId('monthly-forms-done').waitFor({ timeout: 20000 });
  const row = page.locator('[data-testid="my-monthly-history-row"]').first();
  await row.waitFor({ timeout: 20000 });
  if ((await row.getAttribute('data-from')) !== FROM || (await row.getAttribute('data-to')) !== TO) fail('the history does not show the period');
  for (const [kind, name] of [['timesheet', 'Sipho Timesheet Payroll Check.pdf'], ['attendance', 'Sipho Attendance Payroll Check.pdf']]) {
    if ((await row.getByTestId(`history-${kind}-file`).textContent()) !== name) fail(`the submitted ${kind} is not named ${name}`);
  }
  const me = (await call('GET', '/api/auth/me')).json?.data?.user?.id;
  sipho = me;
  const history = await call('GET', `/api/payroll/forms/${me}/history`);
  submissionId = history.json?.data?.[0]?.id ?? null;
  if (submissionId === null) fail('no submission in the history');
  // The working names went with it: the next forms start from the defaults.
  if ((await page.getByTestId('monthly-timesheet-file').textContent()) === 'Sipho Timesheet Payroll Check.pdf') fail('the working name was not reset after submission');
});

await check('27–28. submitted lines leave Timesheets and cannot be changed there (the server refuses); the history is on My Monthly Forms only; renaming the next PDF never reaches the submitted one', async () => {
  const held = (await call('GET', `/api/timesheets/${sipho}/lines`)).json?.data ?? [];
  const submittedIds = held.filter((line) => line.submitted !== null).map((line) => line.id);
  if (submittedIds.length < 4) fail(`only ${submittedIds.length} lines are held as submitted`);
  await openTimesheets();
  for (const id of submittedIds) {
    if ((await page.locator(`[data-testid="timesheet-line"][data-line-id="${id}"]`).count()) > 0) fail('a submitted line is on the Timesheets page');
  }
  for (const date of inPeriod) {
    const summary = await page.locator(`[data-testid="timesheet-day"][data-date="${date}"] [data-testid="timesheet-day-summary"]`).innerText();
    if (!/Not recorded/u.test(summary)) fail(`${date} still shows submitted work: ${summary}`);
  }
  for (const gone of ['timesheet-submissions', 'timesheet-submission', 'timesheet-office', 'my-submitted-timesheets', 'my-monthly-history', 'timesheet-last-submission']) {
    if ((await page.getByTestId(gone).count()) > 0) fail(`Timesheets still shows ${gone}`);
  }
  const first = held.find((line) => line.id === submittedIds[0]);
  const refused = await call('POST', `/api/timesheets/${sipho}/lines`, { id: first.id, date: first.date, typed: { ...first.typed, overtime: '9' }, expectedRevision: first.revision });
  if (refused.status !== 422 || !JSON.stringify(refused.json).includes('timesheet_line_submitted')) fail(`changing a submitted line answered ${refused.status}`);
  const removed = await call('POST', `/api/timesheets/${sipho}/lines/${first.id}/remove`, {});
  if (removed.status !== 422) fail(`removing a submitted line answered ${removed.status}`);
  await go(`/attendance?from=${FROM}&to=${TO}`);
  await page.getByTestId('my-attendance-from').waitFor({ timeout: 20000 });
  for (const gone of ['my-monthly-history', 'my-monthly-history-row', 'timesheet-submissions', 'my-submitted-timesheets']) {
    if ((await page.getByTestId(gone).count()) > 0) fail(`Attendance shows ${gone}`);
  }
  await go(`/payroll/mine?from=${FROM}&to=${TO}`);
  await page.locator(`[data-testid="my-submitted-timesheets"] [data-testid="timesheet-submission"][data-from="${FROM}"][data-to="${TO}"]`).waitFor({ timeout: 20000 });
  await go(`/payroll/mine?from=${FROM}&to=${TO}`);
  await page.getByTestId('monthly-forms').waitFor({ timeout: 20000 });
  await press(page.getByTestId('monthly-timesheet-rename'));
  await page.getByTestId('rename-input').fill('Something Else');
  await press(page.getByTestId('rename-save'));
  await page.waitForFunction(() => document.querySelector('[data-testid="monthly-timesheet-file"]')?.textContent === 'Something Else.pdf', null, { timeout: 15000 });
  const row = page.locator('[data-testid="my-monthly-history-row"]').first();
  if ((await row.getByTestId('history-timesheet-file').textContent()) !== 'Sipho Timesheet Payroll Check.pdf') fail('the submitted name changed');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), press(row.getByTestId('history-timesheet-download'))]);
  if (download.suggestedFilename() !== 'Sipho Timesheet Payroll Check.pdf') fail(`the submitted PDF downloaded as ${download.suggestedFilename()}`);
});

await check('30. the same submission again is refused; only a confirmed complete replacement is possible', async () => {
  if (!(await page.getByTestId('monthly-forms-submit').isDisabled())) {
    const replaces = await page.getByTestId('monthly-forms-replaces').count();
    if (replaces !== 1) fail('Submit is offered again without saying it would replace the submission');
  }
  if ((await page.getByTestId('monthly-forms-confirm-replace').count()) !== 1) fail('no explicit replacement confirmation');
});

await check('29. the office reads the period and its documents; another technician does not', async () => {
  const me = (await call('GET', `/api/payroll/forms/${sipho}/history`)).json?.data ?? [];
  await signOut(page);
  await as('Christene van Niekerk');
  const forms = await call('GET', `/api/payroll/forms/${sipho}?from=${FROM}&to=${TO}`);
  if (forms.status !== 200) fail(`the office cannot read the forms: ${forms.status}`);
  const pdf = await page.evaluate(async (id) => (await fetch(`/api/payroll/submissions/${id}/attendance/pdf`)).status, submissionId);
  if (pdf !== 200) fail(`the office cannot open the submitted attendance: ${pdf}`);
  await go('/payroll');
  await page.waitForLoadState('networkidle');
  await noPageOverflow('Monthly payroll (office)');
  await signOut(page);
  await as('Riaan van Wyk');
  const theirs = await page.evaluate(async (id) => (await fetch(`/api/payroll/submissions/${id}/attendance/pdf`)).status, submissionId);
  if (theirs < 400) fail('another technician opened the submitted form');
  return `office 200, other technician ${theirs}; ${me.length} in history`;
});

await check('no page error', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([verdict]) => verdict === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed at ${label}`);
process.exit(failed.length === 0 ? 0 : 1);
