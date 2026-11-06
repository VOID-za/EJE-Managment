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

await check('14–17. My Monthly Forms before anything is completed: no pay-period filter, both forms "Not completed", Submit to Office disabled and why', async () => {
  await go('/payroll/mine');
  await page.getByTestId('my-forms-submit').waitFor({ timeout: 20000 });
  for (const gone of ['my-monthly-period', 'my-monthly-from', 'my-monthly-to']) if ((await page.getByTestId(gone).count()) !== 0) fail(`${gone} is still there`);
  for (const kind of ['timesheet', 'attendance']) {
    if ((await page.getByTestId(`my-forms-${kind}`).getAttribute('data-state')) !== 'not_completed') fail(`the ${kind} is not "Not completed"`);
  }
  if (await page.getByTestId('my-forms-submit').isEnabled()) fail('Submit to Office is enabled');
  if (!/Both forms must be completed/u.test(await page.getByTestId('my-forms-submit-reason').innerText())) fail('the reason is not said');
  await noPageOverflow('My Monthly Forms');
});

await check('21–22. an incomplete line stops completing the timesheet: the dialog says which, and OK is not offered', async () => {
  await openTimesheets();
  await press(page.getByTestId('timesheet-complete'));
  const problems = page.getByTestId('complete-form-problems');
  await problems.waitFor({ timeout: 20000 });
  if (!/is not complete|not complete/u.test(await problems.innerText())) fail(`no explanation: ${await problems.innerText()}`);
  if (await page.getByTestId('complete-form-ok').isEnabled()) fail('OK is offered with an incomplete line');
  await press(page.getByTestId('complete-form-cancel'));
});

await check('23. the line corrected on Timesheets', async () => {
  await openTimesheets();
  const day = page.locator(`[data-testid="timesheet-day"][data-date="${inPeriod[2]}"]`);
  if ((await day.getAttribute('data-state')) !== 'draft') fail(`the day says ${await day.getAttribute('data-state')}, not Draft`);
  // By its id: its state changes from Draft to Saving as soon as it is typed into.
  const id = await page.locator(`[data-testid="timesheet-line"][data-date="${inPeriod[2]}"][data-state="draft"]`).getAttribute('data-line-id', { timeout: 15000 });
  const draft = page.locator(`[data-testid="timesheet-line"][data-line-id="${id}"]`);
  await draft.getByTestId('timesheet-overtime').fill('1.25');
  await draft.getByTestId('timesheet-customer-name').fill('Cross Month Customer D');
  await allSaved();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="timesheet-line"][data-state="draft"]').length === 0, null, { timeout: 15000 });
});

await check('18–20. each form completed under the name typed in its dialog (an unsafe name is refused there); kept after a reload; downloaded under it', async () => {
  await openTimesheets();
  await press(page.getByTestId('timesheet-complete'));
  const name = page.getByTestId('complete-form-name');
  await name.waitFor({ timeout: 20000 });
  await name.fill('../bad/name');
  if (await page.getByTestId('complete-form-ok').isEnabled()) fail('an unsafe name could be used');
  await name.fill('Sipho Timesheet Payroll Check');
  await press(page.getByTestId('complete-form-ok'));
  await page.getByTestId('timesheet-completed-notice').waitFor({ timeout: 20000 });
  await go(`/attendance?from=${FROM}&to=${TO}`);
  await page.getByTestId('attendance-complete').waitFor({ timeout: 20000 });
  await press(page.getByTestId('attendance-complete'));
  await page.getByTestId('complete-form-name').fill('Sipho Attendance Payroll Check');
  if ((await page.getByTestId('complete-form-confirm-unrecorded').count()) > 0) await page.getByTestId('complete-form-confirm-unrecorded').check();
  await press(page.getByTestId('complete-form-ok'));
  await page.getByTestId('attendance-completed-notice').waitFor({ timeout: 20000 });
  await go('/payroll/mine');
  await page.getByTestId('my-forms-submit').waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('my-forms-submit').waitFor({ timeout: 20000 });
  for (const [kind, file] of [['timesheet', 'Sipho Timesheet Payroll Check.pdf'], ['attendance', 'Sipho Attendance Payroll Check.pdf']]) {
    if ((await page.getByTestId(`my-forms-${kind}-file`).textContent())?.trim() !== file) fail(`the ${kind} name was not kept`);
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), press(page.getByTestId(`my-forms-${kind}-download`))]);
    if (download.suggestedFilename() !== file) fail(`the ${kind} downloaded as ${download.suggestedFilename()}`);
    await press(page.getByTestId(`my-forms-${kind}-preview`));
    await page.locator('[data-testid="document-preview"]').first().waitFor({ timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('[data-testid="document-preview"][data-preview-kind="loading"]'), null, { timeout: 20000 });
    if ((await page.locator('[data-testid="document-preview"][data-preview-kind="error"]').count()) > 0) fail(`the ${kind} preview failed`);
    await press(page.getByTestId('preview-close'));
  }
  const period = await page.getByTestId('my-forms-timesheet-period').innerText();
  if (!period.includes(new Date(`${TO}T00:00:00Z`).toLocaleDateString('en-GB', { year: 'numeric', timeZone: 'UTC' }))) fail(`the period reads ${period}`);
});

let submissionId = null;
let sipho = 'user-tech-sipho';
await check('24–27. Submit to Office: both forms together, once; frozen with the names they were completed under', async () => {
  if (!(await page.getByTestId('my-forms-submit').isEnabled())) fail('Submit to Office is not offered with both forms completed');
  await press(page.getByTestId('my-forms-submit'));
  await page.getByTestId('my-forms-done').waitFor({ timeout: 20000 });
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
  if ((await page.getByTestId('my-forms-timesheet').getAttribute('data-state')) !== 'not_completed') fail('the submitted timesheet still waits');
});

await check('27–28. submitted lines leave Timesheets and cannot be changed there (the server refuses); the history is on My Monthly Forms only', async () => {
  const held = (await call('GET', `/api/timesheets/${sipho}/lines`)).json?.data ?? [];
  const submittedIds = held.filter((line) => line.submitted !== null).map((line) => line.id);
  if (submittedIds.length < 4) fail(`only ${submittedIds.length} lines are held as submitted`);
  await openTimesheets();
  for (const id of submittedIds) {
    if ((await page.locator(`[data-testid="timesheet-line"][data-line-id="${id}"]`).count()) > 0) fail('a submitted line is on the Timesheets page');
  }
  for (const date of inPeriod) {
    const summary = await page.locator(`[data-testid="timesheet-day"][data-date="${date}"] [data-testid="timesheet-day-summary"]`).innerText();
    if (!/submitted timesheet/u.test(summary)) fail(`${date} reads "${summary}"`);
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
  await go('/payroll/mine');
  await page.locator(`[data-testid="my-submitted-timesheets"] [data-testid="timesheet-submission"][data-from="${FROM}"][data-to="${TO}"]`).waitFor({ timeout: 20000 });
  const row = page.locator('[data-testid="my-monthly-history-row"]').first();
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), press(row.getByTestId('history-timesheet-download'))]);
  if (download.suggestedFilename() !== 'Sipho Timesheet Payroll Check.pdf') fail(`the submitted PDF downloaded as ${download.suggestedFilename()}`);
});

await check('30. the same dates again are refused — completed or submitted, a form is never submitted twice', async () => {
  for (const kind of ['timesheet', 'attendance']) {
    const again = await call('POST', `/api/payroll/forms/${sipho}/complete`, { kind, from: FROM, to: TO, fileName: '', confirmUnrecorded: true, confirmNoLines: true });
    if (again.json?.error?.violations?.[0]?.code !== 'payroll_period_submitted') fail(`the ${kind} again answered ${again.status}`);
  }
  const submit = await call('POST', `/api/payroll/forms/${sipho}/submit`, {});
  if (submit.status !== 422) fail(`Submit to Office again answered ${submit.status}`);
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
