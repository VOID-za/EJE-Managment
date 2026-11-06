/**
 * EVERY PAYROLL VIEW, THROUGH THE SCREEN (the payroll completion audit,
 * 5 November 2026). What the 30-step scenario (payroll-forms-check) and the
 * two-devices check do not already walk through, at one screen size per run
 * (EJE_FORMS_VIEWPORT):
 *
 *   Attendance — Absent asks for a reason and is not saved without one; a
 *     linked period longer than the page shows says so.
 *   Timesheets — From after To is refused and said; a line dated outside the
 *     period is said, never hidden, and "show those dates too" brings it back.
 *   Completed — a refused completion is said and completes nothing; the name typed in the dialog is kept;
 *     a submission whose answer is lost is said, and never made twice; the
 *     history previews and downloads under the submitted names; a complete
 *     replacement through the screen keeps the original as replaced.
 *   Timesheets, submitted — the PDF downloads under the name it was submitted
 *     under (audit D1); a correction asked for by the technician and accepted
 *     by the office becomes the version in force, the original still readable;
 *     the office's CSV has its columns.
 *   The office — the submission arrives in Notifications → Monthly Forms; View
 *     forms is read only; a Finance package prepared before an accepted
 *     correction is refused at Send, nothing sent (audit F1), and prepared
 *     again it carries the correction.
 *   Attendance only — the Coordinator submits attendance alone.
 *
 *   npm run payroll-views-check                      (desktop, 1440x900)
 *   EJE_FORMS_VIEWPORT=768x1024:touch npm run payroll-views-check
 *   EJE_FORMS_VIEWPORT=390x844:touch npm run payroll-views-check
 */
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { resetDemonstration, signInAs, signOut } from './sign-in.mjs';
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
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    [method, path, body],
  );
const download = async (locator) => {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), press(locator)]);
  return file;
};
/** Opens a day block on Timesheets (TS-DAY-1: every day starts closed). */
const openDay = async (date) => {
  const day = page.locator(`[data-testid="timesheet-day"][data-date="${date}"]`);
  if ((await day.getAttribute('data-open')) !== 'yes') await press(day.getByTestId('timesheet-day-toggle'));
  await day.getByTestId('timesheet-day-body').waitFor({ timeout: 10000 });
};
const allSaved = () =>
  page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === 'saved', null, { timeout: 20000 });

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// A short period wholly in the past, apart from the 30-step scenario's.
const TO = shift(today, -2);
const FROM = shift(TO, -6);
const DAY = shift(FROM, 2);
const MONTH = TO.slice(0, 7);
const NAME = 'Views Check Sheet';

/**
 * FORM-LIFECYCLE-1: completes one form on its own page for FROM–TO — Completed, the name typed (or the one
 * proposed), what the dialog asks confirmed, OK.
 */
const completeOnPage = async (kind, name = '') => {
  await go(`/${kind === 'timesheet' ? 'timesheets' : 'attendance'}?from=${FROM}&to=${TO}`);
  const button = page.getByTestId(`${kind}-complete`);
  await button.waitFor({ timeout: 30000 });
  await page.waitForFunction((id) => document.querySelector(`[data-testid="${id}"]`)?.hasAttribute('disabled') === false, `${kind}-complete`, { timeout: 20000 });
  await press(button);
  const field = page.getByTestId('complete-form-name');
  await field.waitFor({ timeout: 20000 });
  if (name !== '') await field.fill(name);
  for (const box of ['complete-form-confirm-unrecorded', 'complete-form-confirm-no-lines']) {
    if ((await page.getByTestId(box).count()) > 0) await page.getByTestId(box).check();
  }
  await press(page.getByTestId('complete-form-ok'));
  await page.getByTestId(`${kind}-completed-notice`).waitFor({ timeout: 20000 });
};
/** Submit to Office on My Monthly Forms. */
const submitHere = async () => {
  await go('/payroll/mine');
  await page.getByTestId('my-forms-submit').waitFor({ timeout: 20000 });
  await press(page.getByTestId('my-forms-submit'));
};
const historyFor = async (userId) => ((await call('GET', `/api/payroll/forms/${userId}/history`)).json?.data ?? []);

console.log(`payroll views check at ${label} against ${BASE} — period ${FROM} … ${TO}`);
await go('/');
await resetDemonstration(page, BASE);
await as('Sipho Mahlangu');
const sipho = (await call('GET', '/api/auth/me')).json?.data?.user?.id;

await check('Attendance: Absent asks for a reason and is not saved without one; with Sick Leave it saves', async () => {
  await go(`/attendance?from=${FROM}&to=${TO}`);
  const day = page.locator(`[data-testid="my-attendance-day"][data-date="${DAY}"]`);
  await day.waitFor({ timeout: 20000 });
  await press(day.getByTestId('my-attendance-absent'));
  await day.getByTestId('absence-reason-picker').waitFor({ timeout: 10000 });
  if (!/Choose a reason/u.test(await day.getByTestId('absence-reason-picker').innerText())) fail('no reason is asked for');
  await page.waitForTimeout(1500);
  const held = (await call('GET', `/api/attendance/mine?from=${DAY}&to=${DAY}`)).json?.data;
  if (JSON.stringify(held?.days ?? held ?? '').includes('"absent"')) fail('Absent was saved without a reason');
  await day.getByTestId('absence-reason').selectOption('sick_leave');
  await allSaved();
  if (!/Sick Leave/u.test(await day.getByTestId('my-attendance-reason').innerText())) fail('the reason is not shown');
  for (const date of [FROM, TO]) {
    const other = page.locator(`[data-testid="my-attendance-day"][data-date="${date}"]`);
    await press(other.getByTestId('my-attendance-present'));
  }
  await allSaved();
  await noPageOverflow('Attendance');
});

await check('Attendance: a linked period longer than the page shows at once says so', async () => {
  const longFrom = shift(today, -200);
  await go(`/attendance?from=${longFrom}&to=${today}`);
  await page.getByTestId('my-attendance-range-cut').waitFor({ timeout: 20000 });
  if (!/at most 92 days/u.test(await page.getByTestId('my-attendance-range-cut').innerText())) fail('the cut is not explained');
  // A period running past today is opened to today — not a 92-day cut, and never said to be one.
  await go(`/attendance?from=${shift(today, -3)}&to=${shift(today, 20)}`);
  await page.locator('[data-testid="my-attendance-day"]').first().waitFor({ timeout: 20000 });
  if ((await page.getByTestId('my-attendance-range-cut').count()) !== 0) fail('a period cut at today is said to be cut at 92 days');
});

let lineId = null;
await check('Timesheets: From after To is refused and said; a line outside the period is said and brought back', async () => {
  await go(`/timesheets?from=${FROM}&to=${TO}`);
  await page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  await page.getByTestId('timesheet-from').fill(shift(TO, 1));
  await page.getByTestId('timesheet-range-problem').waitFor({ timeout: 20000 });
  await go(`/timesheets?from=${FROM}&to=${TO}`);
  await page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  await openDay(DAY);
  const before = await page.locator(`[data-testid="timesheet-line"][data-date="${DAY}"]`).count();
  await press(page.getByTestId(`add-timesheet-line-${DAY}`));
  await page.waitForFunction(([d, n]) => document.querySelectorAll(`[data-testid="timesheet-line"][data-date="${d}"]`).length > n, [DAY, before], { timeout: 10000 });
  const line = page.locator(`[data-testid="timesheet-line"][data-date="${DAY}"]`).nth(before);
  lineId = await line.getAttribute('data-line-id');
  await line.getByTestId('timesheet-customer-name').fill('Views Check Customer');
  await line.getByTestId('timesheet-overtime').fill('2');
  await allSaved();
  await go(`/timesheets?from=${shift(DAY, 1)}&to=${TO}`);
  const note = page.getByTestId('timesheet-outside');
  await note.waitFor({ timeout: 20000 });
  if (!/Nothing is lost/u.test(await note.innerText())) fail(`the note: ${await note.innerText()}`);
  await press(page.getByTestId('timesheet-show-outside'));
  await page.locator(`[data-testid="timesheet-day"][data-date="${DAY}"]`).waitFor({ timeout: 15000 });
  await openDay(DAY);
  await page.locator(`[data-testid="timesheet-line"][data-line-id="${lineId}"]`).waitFor({ timeout: 15000 });
  if ((await page.getByTestId('timesheet-from').inputValue()) > DAY) fail('From did not move to the line');
  await noPageOverflow('Timesheets');
});

await check('Completed: a refused completion is said and completes nothing; then completed under the name typed in the dialog', async () => {
  await go(`/timesheets?from=${FROM}&to=${TO}`);
  await page.getByTestId('timesheet-complete').waitFor({ timeout: 30000 });
  await page.route('**/api/payroll/forms/*/complete', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { message: 'That form could not be completed.', violations: [{ code: 'test_refusal', message: 'Refused by the check.' }] } }) })
      : route.continue(),
  );
  await press(page.getByTestId('timesheet-complete'));
  await page.getByTestId('complete-form-name').fill(NAME);
  await press(page.getByTestId('complete-form-ok'));
  await page.getByTestId('complete-form-failure').waitFor({ timeout: 15000 });
  await page.unroute('**/api/payroll/forms/*/complete');
  await press(page.getByTestId('complete-form-cancel'));
  if ((await call('GET', `/api/payroll/forms/${sipho}/completed`)).json?.data?.timesheet !== null) fail('a refused completion completed the timesheet');
  await completeOnPage('timesheet', NAME);
  if ((await call('GET', `/api/payroll/forms/${sipho}/completed`)).json?.data?.timesheet?.fileName !== `${NAME}.pdf`) fail('the name typed was not kept');
});

await check('Submit to Office: a submission whose answer is lost is said, and is made once — never twice', async () => {
  await completeOnPage('attendance');
  const before = (await historyFor(sipho)).length;
  // The request reaches the server and is made; the answer never comes back.
  await page.route('**/api/payroll/forms/*/submit', async (route) => {
    await route.fetch();
    await route.abort('internetdisconnected');
  }, { times: 1 });
  await submitHere();
  await page.getByTestId('my-forms-failure').waitFor({ timeout: 20000 });
  // The page reads the forms again: they were submitted, so nothing waits and Submit to Office is not offered.
  await page.waitForFunction(() => document.querySelector('[data-testid="my-forms-submit"]')?.getAttribute('data-readiness') === 'none', null, { timeout: 20000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('my-forms-submit').waitFor({ timeout: 20000 });
  const after = (await historyFor(sipho)).filter((row) => row.from === FROM && row.to === TO);
  if ((await historyFor(sipho)).length !== before + 1 || after.length !== 1) fail(`the history holds ${after.length} for the period`);
  if (await page.getByTestId('my-forms-submit').isEnabled()) fail('Submit to Office is offered again as if nothing was submitted');
  return 'one submission, the page knows it';
});

await check('History: previews open, the submitted names download; Submitted timesheets → PDF has the submitted name', async () => {
  const row = page.locator(`[data-testid="my-monthly-history-row"][data-from="${FROM}"][data-to="${TO}"]`).first();
  await row.waitFor({ timeout: 20000 });
  for (const kind of ['timesheet', 'attendance']) {
    await press(row.getByTestId(`history-${kind}-preview`));
    await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
    await page.keyboard.press('Escape');
    await page.getByTestId('document-preview').waitFor({ state: 'detached', timeout: 10000 }).catch(() => undefined);
  }
  if ((await row.getByTestId('history-timesheet-file').textContent()) !== `${NAME}.pdf`) fail('the history does not show the submitted name');
  const attendanceName = await row.getByTestId('history-attendance-file').textContent();
  if ((await download(row.getByTestId('history-attendance-download'))).suggestedFilename() !== attendanceName) fail('the attendance downloaded under another name');
  // The submitted timesheet is on My Monthly Forms (6 November 2026), never on Timesheets.
  const submitted = page.locator('[data-testid="my-submitted-timesheets"] [data-testid="timesheet-submission"]').filter({ hasText: new RegExp(FROM.slice(8).replace(/^0/u, '')) }).first();
  await page.getByTestId('timesheet-submissions').first().waitFor({ timeout: 20000 });
  const pdf = await download((await submitted.count()) > 0 ? submitted.getByTestId('timesheet-submission-pdf') : page.getByTestId('timesheet-submission-pdf').first());
  if (pdf.suggestedFilename() !== `${NAME}.pdf`) fail(`the submitted timesheet PDF is called ${pdf.suggestedFilename()}`);
  return `${NAME}.pdf everywhere`;
});

await check('submitted dates are read only, and are never completed or submitted again — the dialog says why', async () => {
  await go(`/attendance?from=${FROM}&to=${TO}`);
  const day = page.locator(`[data-testid="my-attendance-day"][data-date="${shift(FROM, 1)}"]`);
  await day.waitFor({ timeout: 20000 });
  if ((await day.getAttribute('data-locked')) !== 'submitted') fail('a submitted day is not read only');
  if ((await day.getByTestId('my-attendance-present').count()) !== 0) fail('Present is offered on a submitted day');
  await press(page.getByTestId('attendance-complete'));
  const problems = page.getByTestId('complete-form-problems');
  await problems.waitFor({ timeout: 20000 });
  if (!/already submitted/u.test(await problems.innerText())) fail(`the dialog says "${await problems.innerText()}"`);
  if (await page.getByTestId('complete-form-ok').isEnabled()) fail('OK is offered for submitted dates');
  await press(page.getByTestId('complete-form-cancel'));
  if ((await historyFor(sipho)).filter((row) => row.from === FROM && row.to === TO).length !== 1) fail('the period was submitted again');
});

const become = async (who) => {
  await signOut(page);
  await as(who);
};
await check('the office: the submission is in Notifications → Monthly Forms; View forms is read only', async () => {
  await become('Christene van Niekerk');
  await go('/notifications');
  await page.getByTestId('inbox-boxes').waitFor({ timeout: 20000 });
  await press(page.getByTestId('inbox-box-monthly_forms'));
  const list = page.getByTestId('inbox-list-monthly_forms');
  await list.waitFor({ timeout: 15000 });
  if (!/Sipho/u.test(await list.innerText())) fail('Sipho\'s submission is not in Monthly Forms');
  await go('/payroll');
  await page.getByTestId('payroll-month').fill(MONTH);
  const row = page.locator('[data-testid="finance-row"]').filter({ hasText: 'Sipho' }).first();
  await row.waitFor({ timeout: 20000 });
  if ((await row.getByTestId('payroll-period-submission').count()) < 1) fail('the period submission is not on the row');
  await press(row.getByRole('button', { name: /View forms/u }));
  await page.getByTestId('monthly-forms-read-only').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('monthly-forms-submit').count()) !== 0) fail('the office is offered Submit on someone else\'s forms');
  await noPageOverflow('Monthly payroll');
});

let packageId = null;
/** The open package's own box (a month may list sent and discarded ones too). */
const prepared = () => page.locator('[data-testid="finance-package-item"][data-status="prepared"]').first();
const preparedFiles = async () => {
  await prepared().getByTestId('finance-attachment').first().waitFor({ timeout: 30000 });
  return prepared().getByTestId('finance-attachments').innerText();
};
await check('Finance: a package is prepared and its files listed', async () => {
  await become('Christene van Niekerk');
  await go('/payroll');
  await page.getByTestId('payroll-month').fill(MONTH);
  const row = page.locator('[data-testid="finance-row"]').filter({ hasText: 'Sipho' }).first();
  await row.getByTestId('finance-select').check();
  await press(page.getByTestId('finance-prepare'));
  const listed = await preparedFiles();
  // Exactly the names the CURRENT submission went under (the replacement, made after the working name went back to the default).
  const current = (await call('GET', `/api/payroll/forms/${sipho}/history`)).json?.data?.find((entry) => entry.from === FROM && entry.to === TO && entry.current !== false);
  for (const name of [current?.fileNames?.timesheet, current?.fileNames?.attendance]) {
    if (name === undefined || !listed.includes(name)) fail(`the package does not carry the submitted name ${name}: ${listed.replace(/s+/gu, ' ').slice(0, 300)}`);
  }
  packageId = (await call('GET', `/api/payroll/months/${MONTH}`)).json?.data?.packages?.find((p) => p.status === 'prepared')?.id ?? null;
  if (packageId === null) fail('no prepared package');
});

await check('Corrections: asked for by the technician, accepted by the office — the version in force; the original still readable', async () => {
  await become('Sipho Mahlangu');
  await go(`/payroll/mine?from=${FROM}&to=${TO}`);
  const current = page.locator('[data-testid="timesheet-submission"]').filter({ has: page.getByTestId('timesheet-submission-corrections') }).first();
  await current.waitFor({ timeout: 20000 });
  await press(current.getByTestId('timesheet-submission-corrections'));
  await press(page.getByTestId('timesheet-correction-start'));
  await page.getByTestId('timesheet-correction-ot').first().fill('3.5');
  await page.getByTestId('timesheet-correction-reason').fill('The crane job ran longer — views check');
  await press(page.getByTestId('timesheet-correction-submit'));
  await page.getByTestId('timesheet-correction-done').waitFor({ timeout: 20000 });
  await become('Christene van Niekerk');
  // The office's list of every technician's is on My Monthly Forms — reachable for the Office, who has no Timesheets page.
  await go(`/payroll/mine?from=${FROM}&to=${TO}`);
  const office = page.getByTestId('timesheet-office');
  await office.waitFor({ timeout: 20000 });
  const theirs = office.locator('[data-testid="timesheet-submission"]').filter({ hasText: 'Sipho' }).filter({ has: page.getByTestId('timesheet-submission-corrections') }).first();
  await theirs.waitFor({ timeout: 20000 });
  await press(theirs.getByTestId('timesheet-submission-corrections'));
  await press(page.getByTestId('timesheet-correction-accept'));
  await page.waitForFunction(() => document.querySelector('[data-testid="timesheet-correction"]')?.getAttribute('data-status') === 'accepted', null, { timeout: 20000 });
  if (!/Correction 1/u.test(await page.getByTestId('timesheet-version-in-force').innerText())) fail('the version in force is not Correction 1');
  const csv = await download(theirs.getByTestId('timesheet-submission-csv'));
  const text = await readFile(await csv.path(), 'utf8');
  for (const column of ['OT', 'D/T', 'Callout', 'Int Km', 'Cust Km']) if (!text.split('\n')[0].includes(column)) fail(`the CSV has no ${column} column`);
  await press(theirs.getByTestId('timesheet-submission-view-original'));
  await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
  await page.keyboard.press('Escape');
});

await check('Finance (audit F1): the package prepared before the correction is refused at Send — nothing sent; prepared again it carries the correction', async () => {
  await become('Christene van Niekerk');
  await go('/payroll');
  await page.getByTestId('payroll-month').fill(MONTH);
  await prepared().getByTestId('finance-send').waitFor({ timeout: 20000 });
  if (await prepared().getByTestId('finance-send').isDisabled()) {
    // Email off on this deployment: Send cannot be pressed; the refusal is proved through the route instead.
    const send = await call('POST', `/api/payroll/packages/${packageId}/send`, {});
    if (send.json?.error?.violations?.[0]?.code !== 'package_out_of_date') fail(`Send answered ${send.status} ${JSON.stringify(send.json?.error)}`);
  } else {
    await press(prepared().getByTestId('finance-send'));
    await press(page.getByRole('button', { name: 'Send one email' }));
    await page.getByTestId('finance-error').waitFor({ timeout: 20000 });
    if (!/changed after this package was prepared/u.test(await page.getByTestId('finance-error').innerText())) fail(`the refusal: ${await page.getByTestId('finance-error').innerText()}`);
  }
  const stored = (await call('GET', `/api/payroll/months/${MONTH}`)).json?.data?.packages?.find((p) => p.id === packageId);
  if (stored?.status !== 'prepared' || stored?.sentAt !== null) fail(`the package is ${stored?.status}`);
  await press(prepared().getByTestId('finance-discard'));
  await page.getByTestId('finance-prepare').waitFor({ timeout: 20000 });
  const row = page.locator('[data-testid="finance-row"]').filter({ hasText: 'Sipho' }).first();
  await row.getByTestId('finance-select').check();
  await press(page.getByTestId('finance-prepare'));
  if (!/Correction 1/u.test(await preparedFiles())) fail('the new package does not carry the correction');
  await press(prepared().getByTestId('finance-discard'));
  await page.getByTestId('finance-prepare').waitFor({ timeout: 20000 });
});

await check('attendance only: the Coordinator submits attendance alone — no timesheet in the history', async () => {
  await become('Christene van Niekerk');
  const me = (await call('GET', '/api/auth/me')).json?.data?.user?.id;
  await go('/payroll/mine');
  await page.getByTestId('my-forms-submit').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('my-forms-timesheet').getAttribute('data-state')) !== 'not_required') fail('a timesheet is asked of the Coordinator');
  await completeOnPage('attendance');
  await submitHere();
  await page.getByTestId('my-forms-done').waitFor({ timeout: 20000 });
  const row = page.locator(`[data-testid="my-monthly-history-row"][data-from="${FROM}"][data-to="${TO}"]`).first();
  await row.waitFor({ timeout: 20000 });
  if ((await row.getByTestId('history-timesheet-file').count()) !== 0) fail('a timesheet is in the Coordinator\'s submission');
  if ((await row.getByTestId('history-attendance-file').count()) !== 1) fail('no attendance in the submission');
  const history = await historyFor(me);
  if (history.find((entry) => entry.from === FROM)?.timesheetRequired !== false) fail('the submission is not attendance only');
  await noPageOverflow('My Monthly Forms (Coordinator)');
});

await check('another technician sees none of it, and an empty history says so', async () => {
  await become('Riaan van Wyk');
  const riaan = (await call('GET', '/api/auth/me')).json?.data?.user?.id;
  const theirs = await call('GET', `/api/payroll/forms/${sipho}/history`);
  if (theirs.status < 400) fail('another technician read Sipho\'s history');
  await go('/payroll/mine');
  await page.getByTestId('my-forms-submit').waitFor({ timeout: 20000 });
  const mine = await historyFor(riaan);
  if (mine.length === 0 && (await page.getByTestId('my-monthly-history-empty').count()) !== 1) fail('an empty history is not said');
  if (mine.length > 0 && (await page.locator('[data-testid="my-monthly-history-row"]').count()) !== mine.length) fail('the history on the screen is not the server\'s');
});

await check('no page error', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([verdict]) => verdict === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed at ${label}`);
process.exit(failed.length === 0 ? 0 : 1);
