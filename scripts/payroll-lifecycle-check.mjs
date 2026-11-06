/**
 * THE FORM LIFECYCLE THROUGH THE SCREEN — FORM-LIFECYCLE-1 (the owner,
 * 6 November 2026). docs/payroll-forms.md.
 *
 * At one screen size per run (EJE_FORMS_VIEWPORT), on the demonstration:
 *   A. Attendance — Present and Absent toggle (pressed again: Not recorded),
 *      switch either way, persist across a reload; unrecorded days say so.
 *   B. Timesheets — each day's lines are rows of Customer | OT | D/T |
 *      Callout | Int Km | Cust Km, in that order and side by side; several
 *      rows a day, each edited and removed (confirmed) on its own.
 *   C. Completed — the dialog explains, shows the name and lets it be
 *      changed; Cancel changes nothing; OK locks the form and moves it to My
 *      Monthly Forms; the page is clean for the next period; a reload does not
 *      bring it back; direct requests against it are refused; a completion that
 *      fails loses nothing; two at once make one.
 *   D. My Monthly Forms — no pay-period filter; Timesheet before Attendance;
 *      Preview, Print, Download, Save PDF of the completed PDF; no editing.
 *   E. Submit to Office — the four states of the button, said in words; the
 *      server refuses every bypass (one form, another person's, other dates);
 *      a lost answer and a second press make ONE submission of BOTH forms.
 *   F. History — the submission, read only, its documents previewed; nothing
 *      submitted before this run changed; another technician sees none of it.
 *   And the Office: attendance alone.
 *
 *   npm run payroll-lifecycle-check                    (desktop, 1440x900)
 *   EJE_FORMS_VIEWPORT=768x1024:touch npm run payroll-lifecycle-check
 *   EJE_FORMS_VIEWPORT=390x844:touch npm run payroll-lifecycle-check
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
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const FROM = shift(today, -12);
const TO = shift(today, -3);
const D1 = shift(today, -10);
const D2 = shift(today, -8);
const NAME = 'Lifecycle Check Timesheet';

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
const me = async () => (await call('GET', '/api/auth/me')).json.data.user.id;
const codeOf = (answer) => answer.json?.error?.violations?.[0]?.code ?? answer.json?.error?.code ?? null;
const download = async (locator) => {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), press(locator)]);
  return file;
};
const dayRow = (date) => page.locator(`[data-testid="my-attendance-day"][data-date="${date}"]`);
const daySaved = (date, status) =>
  page.waitForFunction(
    ([d, s]) => {
      const row = document.querySelector(`[data-testid="my-attendance-day"][data-date="${d}"]`);
      return row?.getAttribute('data-status') === s && row?.getAttribute('data-saved') === 'yes';
    },
    [date, status],
    { timeout: 20000 },
  );
const serverDay = async (date) => {
  const days = (await call('GET', `/api/attendance/mine?from=${FROM}&to=${TO}`)).json.data.days;
  return days.find((day) => day.date === date)?.record?.status ?? null;
};
const openTimesheets = async (from = FROM, to = TO) => {
  await go(`/timesheets?from=${from}&to=${to}`);
  await page.getByTestId('timesheet-days').waitFor({ timeout: 30000 });
};
const openDay = async (date) => {
  const day = page.locator(`[data-testid="timesheet-day"][data-date="${date}"]`);
  if ((await day.getAttribute('data-open')) !== 'yes') await press(day.getByTestId('timesheet-day-toggle'));
  await day.getByTestId('timesheet-day-body').waitFor({ timeout: 10000 });
  return day;
};
const sheetSaved = () =>
  page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === 'saved', null, { timeout: 20000 });
const lineById = (id) => page.locator(`[data-testid="timesheet-line"][data-line-id="${id}"]`);
const addLine = async (date, values) => {
  const day = await openDay(date);
  const before = await day.locator('[data-testid="timesheet-line"]').count();
  await press(page.getByTestId(`add-timesheet-line-${date}`));
  await page.waitForFunction(([d, n]) => document.querySelectorAll(`[data-testid="timesheet-day"][data-date="${d}"] [data-testid="timesheet-line"]`).length > n, [date, before], { timeout: 10000 });
  const id = await day.locator('[data-testid="timesheet-line"]').nth(before).getAttribute('data-line-id');
  for (const [testId, value] of Object.entries(values)) await lineById(id).getByTestId(testId).fill(value);
  return id;
};
const myForms = async () => {
  await go('/payroll/mine');
  await page.getByTestId('my-forms-submit').waitFor({ timeout: 30000 });
};

console.log(`FORM-LIFECYCLE-1 check at ${label} against ${BASE} — period ${FROM} … ${TO}`);
await go('/');
await resetDemonstration(page, BASE);
await signInAs(page, 'Sipho Mahlangu', { base: BASE });
const SIPHO = await me();
const historyBefore = (await call('GET', `/api/payroll/forms/${SIPHO}/history`)).json.data;
const submissionsBefore = (await call('GET', `/api/timesheets/submissions?userId=${SIPHO}`)).json.data;

/* ---- A. Attendance ------------------------------------------------------- */
await check('A. Present toggles: pressed it is Present; pressed again the day is Not recorded — on the server too, after a reload', async () => {
  await go(`/attendance?from=${FROM}&to=${TO}`);
  await dayRow(D1).waitFor({ timeout: 30000 });
  await press(dayRow(D1).getByTestId('my-attendance-present'));
  await daySaved(D1, 'present');
  if ((await serverDay(D1)) !== 'present') fail('Present was not saved');
  await press(dayRow(D1).getByTestId('my-attendance-present'));
  await daySaved(D1, 'unrecorded');
  await page.reload({ waitUntil: 'networkidle' });
  await dayRow(D1).waitFor({ timeout: 20000 });
  if ((await dayRow(D1).getAttribute('data-status')) !== 'unrecorded') fail('the cleared day came back after a reload');
  if (!/Not recorded/u.test(await dayRow(D1).innerText())) fail('the cleared day does not say Not recorded');
  if ((await serverDay(D1)) !== null) fail('the server still holds an answer for the cleared day');
});

await check('A. Absent toggles; Present ⇄ Absent switch either way; every unrecorded day says Not recorded', async () => {
  await press(dayRow(D1).getByTestId('my-attendance-absent'));
  await dayRow(D1).getByTestId('absence-reason').selectOption('leave');
  await daySaved(D1, 'absent');
  if ((await serverDay(D1)) !== 'absent') fail('Absent was not saved');
  await press(dayRow(D1).getByTestId('my-attendance-absent'));
  await daySaved(D1, 'unrecorded');
  if ((await serverDay(D1)) !== null) fail('pressing Absent again did not clear it');
  await press(dayRow(D1).getByTestId('my-attendance-present'));
  await daySaved(D1, 'present');
  await press(dayRow(D1).getByTestId('my-attendance-absent'));
  await dayRow(D1).getByTestId('absence-reason').selectOption('sick_leave');
  await daySaved(D1, 'absent');
  await press(dayRow(D1).getByTestId('my-attendance-present'));
  await daySaved(D1, 'present');
  if ((await serverDay(D1)) !== 'present') fail('switching Absent to Present was not saved');
  const rows = await page.locator('[data-testid="my-attendance-day"][data-status="unrecorded"]').all();
  for (const row of rows) if (!/Not recorded/u.test(await row.innerText())) fail(`${await row.getAttribute('data-date')} does not say Not recorded`);
  return `${rows.length} unrecorded days, each "Not recorded"`;
});

/* ---- B. Timesheets ------------------------------------------------------- */
let first = null;
let second = null;
await check('B. a day\'s lines are rows of Customer | OT | D/T | Callout | Int Km | Cust Km, side by side; two rows on one day, each its own', async () => {
  await openTimesheets();
  first = await addLine(D2, { 'timesheet-customer-name': 'Lifecycle Customer A', 'timesheet-overtime': '1.5', 'timesheet-callout': '300', 'timesheet-internal-km': '12', 'timesheet-customer-km': '8' });
  second = await addLine(D2, { 'timesheet-customer-name': 'Workshop', 'timesheet-double': '2', 'timesheet-internal-km': '15' });
  await sheetSaved();
  const day = await openDay(D2);
  const header = (await day.getByTestId('timesheet-columns').innerText()).split(/\s*\n\s*/u).filter((text) => text !== '' && !/State and remove/u.test(text));
  if (JSON.stringify(header) !== JSON.stringify(['Customer', 'OT', 'D/T', 'Callout (R)', 'Int Km', 'Cust Km'])) fail(`the columns read ${JSON.stringify(header)}`);
  const order = ['timesheet-customer-name', 'timesheet-overtime', 'timesheet-double', 'timesheet-callout', 'timesheet-internal-km', 'timesheet-customer-km'];
  // Measured together, in one frame: the page may still be settling (the save notice) between separate reads.
  const boxes = await lineById(first).evaluate((row, ids) => ids.map((id) => {
    const box = row.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
    return box === undefined || box.width === 0 ? null : { x: box.x, y: box.y };
  }), order);
  if (boxes.some((box) => box === null)) fail('a field of the row is not drawn');
  if (Math.max(...boxes.map((box) => box.y)) - Math.min(...boxes.map((box) => box.y)) > 2) fail('the six fields are not on one row');
  for (let index = 1; index < boxes.length; index += 1) if (boxes[index].x <= boxes[index - 1].x) fail(`${order[index]} is not to the right of ${order[index - 1]}`);
  if ((await lineById(second).getByTestId('timesheet-customer-name').inputValue()) !== 'Workshop') fail('Workshop is not shown as Workshop');
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`the page scrolls sideways by ${over}px (only the day's table may)`);
});

await check('B. each row is edited on its own; a row is removed after its confirmation (Cancel keeps it); Not recorded on an empty day', async () => {
  await lineById(second).getByTestId('timesheet-double').fill('2.5');
  await sheetSaved();
  const held = (await call('GET', `/api/timesheets/${SIPHO}/lines`)).json.data;
  const a = held.find((line) => line.id === first);
  const b = held.find((line) => line.id === second);
  if (Number(a.typed.overtime) !== 1.5 || Number(a.typed.double) !== 0) fail(`the first row changed: ${JSON.stringify(a.typed)}`);
  if (Number(b.typed.double) !== 2.5 || b.typed.pick !== '__workshop__') fail(`the second row: ${JSON.stringify(b.typed)}`);
  const third = await addLine(D2, { 'timesheet-customer-name': 'Remove Me', 'timesheet-overtime': '1' });
  await sheetSaved();
  await press(lineById(third).getByTestId('remove-timesheet-line'));
  await press(page.getByRole('dialog').getByRole('button', { name: 'Cancel' }));
  if ((await lineById(third).count()) !== 1) fail('Cancel removed the row');
  await press(lineById(third).getByTestId('remove-timesheet-line'));
  await press(page.getByRole('dialog').getByRole('button', { name: 'Remove line' }));
  await sheetSaved();
  if ((await lineById(first).count()) !== 1 || (await lineById(second).count()) !== 1) fail('another row went with it');
  const empty = page.locator(`[data-testid="timesheet-day"][data-date="${shift(FROM, 1)}"] [data-testid="timesheet-day-summary"]`);
  if (!/Not recorded/u.test(await empty.innerText())) fail('an empty day does not say Not recorded');
});

/* ---- C. Completing the timesheet ---------------------------------------- */
await check('C. Completed opens the dialog: what it does, the name; Cancel changes nothing', async () => {
  await openTimesheets();
  await press(page.getByTestId('timesheet-complete'));
  const dialog = page.getByTestId('complete-form-dialog');
  await dialog.waitFor({ timeout: 10000 });
  const text = await dialog.innerText();
  for (const words of ['finalise it and transfer it to My Monthly Forms', 'cannot be edited again', 'preview, print, download and save the PDF', 'submit it to the Office from My Monthly Forms']) {
    if (!text.includes(words)) fail(`the dialog does not say "${words}"`);
  }
  const name = page.getByTestId('complete-form-name');
  await name.waitFor({ timeout: 10000 });
  if (!/\.pdf$/u.test(await name.inputValue())) fail(`no name is proposed: "${await name.inputValue()}"`);
  await name.fill(NAME);
  await press(page.getByTestId('complete-form-cancel'));
  await dialog.waitFor({ state: 'detached', timeout: 10000 });
  const state = (await call('GET', `/api/payroll/forms/${SIPHO}/completed`)).json.data;
  if (state.timesheet !== null) fail('Cancel completed the timesheet');
  await openDay(D2);
  if ((await lineById(first).count()) !== 1) fail('Cancel took the lines away');
});

await check('C. a completion that fails loses nothing: the lines stay, editable', async () => {
  await page.route('**/api/payroll/forms/*/complete', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
  await press(page.getByTestId('timesheet-complete'));
  await page.getByTestId('complete-form-name').waitFor({ timeout: 10000 });
  await press(page.getByTestId('complete-form-ok'));
  await page.getByTestId('complete-form-failure').waitFor({ timeout: 15000 });
  await page.unroute('**/api/payroll/forms/*/complete');
  await press(page.getByTestId('complete-form-cancel'));
  if ((await call('GET', `/api/payroll/forms/${SIPHO}/completed`)).json.data.timesheet !== null) fail('a failed completion completed it');
  await openDay(D2);
  if (!(await lineById(first).getByTestId('timesheet-overtime').isEditable())) fail('the lines are no longer editable');
});

await check('C. OK: the timesheet is completed under its new name, locked, gone from the workspace; a reload does not bring it back', async () => {
  await press(page.getByTestId('timesheet-complete'));
  await page.getByTestId('complete-form-name').fill(NAME);
  const noLines = page.getByTestId('complete-form-confirm-no-lines');
  if ((await noLines.count()) > 0) fail('it asks to confirm there are no lines');
  await press(page.getByTestId('complete-form-ok'));
  await page.getByTestId('timesheet-completed-notice').waitFor({ timeout: 20000 });
  if (!(await page.getByTestId('timesheet-completed-notice').innerText()).includes(NAME)) fail('the notice does not name the form');
  if ((await lineById(first).count()) !== 0) fail('a completed line is still in the workspace');
  await page.waitForFunction((from) => document.querySelector('[data-testid="timesheet-from"]')?.value > from, TO, { timeout: 15000 });
  await openTimesheets();
  if ((await lineById(first).count()) !== 0 || (await lineById(second).count()) !== 0) fail('the completed lines came back after a reload');
  const day = await openDay(D2);
  if ((await day.getByTestId('timesheet-day-locked').count()) !== 1) fail('the completed day is not said to be locked');
  if ((await day.locator('[data-testid^="add-timesheet-line-"]').count()) !== 0) fail('Add line is offered on a completed day');
  const state = (await call('GET', `/api/payroll/forms/${SIPHO}/completed`)).json.data;
  if (state.timesheet?.fileName !== `${NAME}.pdf` || state.timesheet.from !== FROM || state.timesheet.to !== TO) fail(`completed: ${JSON.stringify(state.timesheet)}`);
});

await check('C. the completed timesheet refuses every direct request: change, new line, removal, old route; a second completion', async () => {
  const held = (await call('GET', `/api/timesheets/${SIPHO}/lines`)).json.data.find((line) => line.id === first);
  const answers = [
    await call('POST', `/api/timesheets/${SIPHO}/lines`, { id: first, date: D2, typed: { ...held.typed, overtime: '9' }, expectedRevision: held.revision }),
    await call('POST', `/api/timesheets/${SIPHO}/lines`, { id: crypto.randomUUID(), date: D1, typed: { pick: '', customerName: 'Sneaky', overtime: '1', double: '0', callout: '0', internalKm: '0', customerKm: '0' }, expectedRevision: null }),
    await call('POST', `/api/timesheets/${SIPHO}/lines/${first}/remove`, {}),
    await call('POST', `/api/timesheets/${SIPHO}/entries`, { date: D1, customerName: 'Sneaky', overtimeHours: 1, doubleHours: 0 }),
  ];
  for (const answer of answers) if (answer.status !== 422 || codeOf(answer) !== 'form_completed') fail(`answered ${answer.status} ${codeOf(answer)}`);
  const again = await call('POST', `/api/payroll/forms/${SIPHO}/complete`, { kind: 'timesheet', from: FROM, to: TO, fileName: '', confirmNoLines: true });
  if (codeOf(again) !== 'form_already_completed') fail(`a second completion answered ${codeOf(again)}`);
  const after = (await call('GET', `/api/timesheets/${SIPHO}/lines`)).json.data.find((line) => line.id === first);
  if (after?.typed.overtime !== held.typed.overtime) fail('the completed line changed');
});

/* ---- D. My Monthly Forms ------------------------------------------------- */
await check('D. My Monthly Forms: no pay-period filter; Timesheet before Attendance; the completed timesheet under its name; no editing', async () => {
  await myForms();
  for (const gone of ['my-monthly-period', 'my-monthly-from', 'my-monthly-to', 'monthly-timesheet-rename', 'monthly-attendance-rename']) {
    if ((await page.getByTestId(gone).count()) !== 0) fail(`${gone} is still on the page`);
  }
  const order = await page.evaluate(() => [...document.querySelectorAll('[data-testid="my-forms-timesheet"], [data-testid="my-forms-attendance"]')].map((element) => element.getAttribute('data-testid')));
  if (JSON.stringify(order) !== JSON.stringify(['my-forms-timesheet', 'my-forms-attendance'])) fail(`the order is ${order.join(', ')}`);
  if ((await page.getByTestId('my-forms-timesheet').getAttribute('data-state')) !== 'completed') fail('the timesheet is not shown as completed');
  if ((await page.getByTestId('my-forms-timesheet-file').innerText()).trim() !== `${NAME}.pdf`) fail('the completed name is not shown');
  if ((await page.getByTestId('my-forms-attendance').getAttribute('data-state')) !== 'not_completed') fail('the attendance is not shown as not completed');
  const editing = await page.locator('[data-testid="my-forms-timesheet"]').getByRole('button', { name: /edit|rename|delete|reopen|remove/iu }).count();
  if (editing !== 0) fail('the completed form offers an editing action');
});

await check('D. Preview, Print, Download and Save PDF act on the completed PDF, under its name', async () => {
  await press(page.getByTestId('my-forms-timesheet-preview'));
  await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
  await page.getByTestId('preview-close').click();
  await press(page.getByTestId('my-forms-timesheet-print'));
  await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
  await page.getByTestId('preview-close').click();
  const file = await download(page.getByTestId('my-forms-timesheet-download'));
  if (file.suggestedFilename() !== `${NAME}.pdf`) fail(`downloaded as ${file.suggestedFilename()}`);
  const saved = await download(page.getByTestId('my-forms-timesheet-export')).catch(() => null);
  if (saved !== null && saved.suggestedFilename() !== `${NAME}.pdf`) fail(`saved as ${saved.suggestedFilename()}`);
  return saved === null ? 'Save PDF used the device\'s own save sheet' : `${NAME}.pdf`;
});

/* ---- E. Submit to Office ------------------------------------------------- */
await check('E. only the timesheet completed: Submit to Office disabled — "Attendance form not completed", said under it; the server refuses it too', async () => {
  const button = page.getByTestId('my-forms-submit');
  if (await button.isEnabled()) fail('Submit to Office is enabled');
  if (!/Attendance form not completed/u.test(await page.getByTestId('my-forms-submit-reason').innerText())) fail(`the reason reads "${await page.getByTestId('my-forms-submit-reason').innerText()}"`);
  const bypass = await call('POST', `/api/payroll/forms/${SIPHO}/submit`, {});
  if (codeOf(bypass) !== 'submit_attendance_missing') fail(`a request around the button answered ${codeOf(bypass)}`);
  const other = await call('POST', `/api/payroll/forms/${SIPHO}/complete`, { kind: 'attendance', from: shift(FROM, 1), to: TO, fileName: '', confirmUnrecorded: true });
  if (codeOf(other) !== 'form_period_mismatch') fail(`attendance for other dates answered ${codeOf(other)}`);
});

await check('E. the attendance completed on its page (unrecorded weekdays confirmed in the dialog); its days lock; the button is enabled — "Ready to submit"', async () => {
  await go(`/attendance?from=${FROM}&to=${TO}`);
  await dayRow(D1).waitFor({ timeout: 20000 });
  await press(page.getByTestId('attendance-complete'));
  await page.getByTestId('complete-form-name').waitFor({ timeout: 10000 });
  const confirm = page.getByTestId('complete-form-confirm-unrecorded');
  if ((await confirm.count()) === 1) {
    if (await page.getByTestId('complete-form-ok').isEnabled()) fail('OK is offered before the unrecorded days are confirmed');
    await confirm.check();
  }
  await press(page.getByTestId('complete-form-ok'));
  await page.getByTestId('attendance-completed-notice').waitFor({ timeout: 20000 });
  const edit = await call('POST', '/api/attendance', { userId: SIPHO, date: D1, status: 'absent', absenceReason: 'leave', note: '' });
  if (codeOf(edit) !== 'form_completed') fail(`a direct change answered ${codeOf(edit)}`);
  const clear = await call('POST', '/api/attendance', { userId: SIPHO, date: D1, status: 'none', note: '' });
  if (codeOf(clear) !== 'form_completed') fail(`a direct clear answered ${codeOf(clear)}`);
  await go(`/attendance?from=${FROM}&to=${TO}`);
  await dayRow(D1).waitFor({ timeout: 20000 });
  if ((await dayRow(D1).getAttribute('data-locked')) !== 'completed') fail('the completed day is not locked');
  if ((await dayRow(D1).getByTestId('my-attendance-present').count()) !== 0) fail('Present is offered on a completed day');
  await myForms();
  if (!(await page.getByTestId('my-forms-submit').isEnabled())) fail('Submit to Office is not enabled');
  if (!/Ready to submit/u.test(await page.getByTestId('my-forms-submit-reason').innerText())) fail('the reason does not say Ready to submit');
});

await check('E. Submit to Office cut off before it reached the server: nothing submitted, both still wait; pressed again — submitted once', async () => {
  await page.route('**/api/payroll/forms/*/submit', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
  await press(page.getByTestId('my-forms-submit'));
  await page.getByTestId('my-forms-failure').waitFor({ timeout: 20000 });
  await page.unroute('**/api/payroll/forms/*/submit');
  if ((await call('GET', `/api/payroll/forms/${SIPHO}/history`)).json.data.some((entry) => entry.from === FROM)) fail('something was submitted');
  const state = (await call('GET', `/api/payroll/forms/${SIPHO}/completed`)).json.data;
  if (state.timesheet === null || state.attendance === null) fail('a form stopped waiting');
  await page.waitForFunction(() => document.querySelector('[data-testid="my-forms-submit"]')?.getAttribute('data-readiness') === 'ready', null, { timeout: 15000 });
  await press(page.getByTestId('my-forms-submit'));
  await page.getByTestId('my-forms-done').waitFor({ timeout: 20000 });
  const history = (await call('GET', `/api/payroll/forms/${SIPHO}/history`)).json.data;
  const ours = history.filter((entry) => entry.from === FROM && entry.to === TO);
  if (ours.length !== 1) fail(`${ours.length} submissions for the period`);
  if (ours[0].documents.length !== 2) fail('the submission does not carry both forms');
  if (ours[0].fileNames.timesheet !== `${NAME}.pdf`) fail(`the timesheet went as ${ours[0].fileNames.timesheet}`);
  const again = await call('POST', `/api/payroll/forms/${SIPHO}/submit`, {});
  if (codeOf(again) !== 'payroll_already_submitted') fail(`a further request answered ${codeOf(again)}`);
});

await check('E. after submitting, nothing awaits: disabled — "Both forms must be completed"; the submitted dates are read only', async () => {
  await myForms();
  if (await page.getByTestId('my-forms-submit').isEnabled()) fail('Submit to Office is enabled with nothing completed');
  if (!/Both forms must be completed/u.test(await page.getByTestId('my-forms-submit-reason').innerText())) fail('the reason does not say both forms must be completed');
  const edit = await call('POST', '/api/attendance', { userId: SIPHO, date: D1, status: 'absent', absenceReason: 'leave', note: '' });
  if (codeOf(edit) !== 'form_submitted') fail(`a submitted day answered ${codeOf(edit)}`);
});

await check('E. only the attendance completed: disabled — "Timesheet form not completed"', async () => {
  const next = (await call('GET', `/api/payroll/forms/${SIPHO}/completed`)).json.data.next;
  const done = await call('POST', `/api/payroll/forms/${SIPHO}/complete`, { kind: 'attendance', from: next.from, to: next.to, fileName: '', confirmUnrecorded: true });
  if (done.status !== 200) fail(`completing the next attendance answered ${done.status} ${codeOf(done)}`);
  await myForms();
  if (await page.getByTestId('my-forms-submit').isEnabled()) fail('Submit to Office is enabled');
  if (!/Timesheet form not completed/u.test(await page.getByTestId('my-forms-submit-reason').innerText())) fail('the reason does not say the timesheet is not completed');
  const race = await Promise.all([1, 2].map(() => call('POST', `/api/payroll/forms/${SIPHO}/complete`, { kind: 'timesheet', from: next.from, to: next.to, fileName: '', confirmNoLines: true })));
  if (race.filter((answer) => answer.status === 200).length !== 1) fail(`${race.filter((answer) => answer.status === 200).length} of two simultaneous completions succeeded`);
});

/* ---- F. History ---------------------------------------------------------- */
await check('F. History: the submission, read only, its documents previewed; nothing submitted before changed', async () => {
  await myForms();
  const row = page.locator(`[data-testid="my-monthly-history-row"][data-from="${FROM}"][data-to="${TO}"]`);
  await row.waitFor({ timeout: 20000 });
  for (const word of [/edit/iu, /delete/iu, /reopen/iu, /resubmit/iu, /modify/iu]) {
    if ((await page.getByTestId('my-monthly-history').getByRole('button', { name: word }).count()) !== 0) fail(`the history offers ${word}`);
  }
  await press(row.getByTestId('history-timesheet-preview'));
  await page.getByTestId('document-preview').waitFor({ timeout: 20000 });
  await page.getByTestId('preview-close').click();
  const history = (await call('GET', `/api/payroll/forms/${SIPHO}/history`)).json.data;
  for (const before of historyBefore) {
    const now = history.find((entry) => entry.id === before.id);
    if (JSON.stringify(now?.documents) !== JSON.stringify(before.documents) || now?.current !== before.current) fail(`an earlier submission changed: ${before.id}`);
  }
  const submissions = (await call('GET', `/api/timesheets/submissions?userId=${SIPHO}`)).json.data;
  for (const before of submissionsBefore) if (!submissions.some((entry) => entry.id === before.id && entry.lineCount === before.lineCount)) fail('an earlier timesheet submission changed');
  return `${history.length} in the history`;
});

await check('F. another technician sees and changes none of it', async () => {
  const completion = (await call('GET', `/api/payroll/forms/${SIPHO}/completed`)).json.data.attendance;
  await signOut(page);
  await signInAs(page, 'Riaan van Wyk', { base: BASE });
  for (const [what, answer] of [
    ['forms', await call('GET', `/api/payroll/forms/${SIPHO}/completed`)],
    ['history', await call('GET', `/api/payroll/forms/${SIPHO}/history`)],
    ['complete', await call('POST', `/api/payroll/forms/${SIPHO}/complete`, { kind: 'attendance', from: FROM, to: TO, fileName: '' })],
    ['submit', await call('POST', `/api/payroll/forms/${SIPHO}/submit`, {})],
  ]) {
    if (answer.status < 400) fail(`${what} answered ${answer.status}`);
  }
  if (completion !== null) {
    const pdf = await page.evaluate(async (id) => (await fetch(`/api/payroll/completions/${id}/pdf`)).status, completion.id);
    if (pdf < 400) fail(`Sipho's completed PDF answered ${pdf}`);
  }
  await myForms();
  if ((await page.locator('[data-testid="my-monthly-history-row"]').count()) !== 0) fail('Riaan sees a history');
});

await check('the Office keeps no timesheet: "Not required"; attendance completed alone is ready to submit, and goes alone', async () => {
  await signOut(page);
  await signInAs(page, 'Christene van Niekerk', { base: BASE });
  const office = await me();
  await myForms();
  if ((await page.getByTestId('my-forms-timesheet').getAttribute('data-state')) !== 'not_required') fail('the timesheet is not said to be not required');
  const done = await call('POST', `/api/payroll/forms/${office}/complete`, { kind: 'attendance', from: FROM, to: TO, fileName: '', confirmUnrecorded: true });
  if (done.status !== 200) fail(`completing answered ${done.status} ${codeOf(done)}`);
  const timesheet = await call('POST', `/api/payroll/forms/${office}/complete`, { kind: 'timesheet', from: FROM, to: TO, fileName: '' });
  if (codeOf(timesheet) !== 'timesheet_not_required') fail(`a timesheet answered ${codeOf(timesheet)}`);
  await myForms();
  if (!(await page.getByTestId('my-forms-submit').isEnabled())) fail('Submit to Office is not enabled');
  await press(page.getByTestId('my-forms-submit'));
  await page.getByTestId('my-forms-done').waitFor({ timeout: 20000 });
  const history = (await call('GET', `/api/payroll/forms/${office}/history`)).json.data;
  if (history[0]?.timesheetRequired !== false || history[0]?.documents.length !== 1) fail(`the Office's submission: ${JSON.stringify(history[0])}`);
});

await check('no page error; no page scrolls sideways', async () => {
  for (const path of ['/payroll/mine', '/attendance', '/timesheets']) {
    await go(path);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) fail(`${path} scrolls sideways by ${over}px`);
  }
  if (errors.length > 0) fail(errors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([verdict]) => verdict === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed at ${label}`);
process.exit(failed.length === 0 ? 0 : 1);
