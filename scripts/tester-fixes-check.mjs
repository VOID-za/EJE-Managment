/**
 * THE TESTER'S CRITICAL FIXES OF 2 NOVEMBER 2026, THROUGH THE SCREEN.
 *
 * At one viewport per run (`EJE_FORMS_VIEWPORT=1440x900`, `768x1024:touch`,
 * `390x844:touch`), against the demonstration backend, from a reset:
 *
 *   - Attendance: From and To across months, oldest first, remembered after
 *     leaving; the period PDF named for its months ("… Atten Oct-Nov.pdf"),
 *     with no Notes column; a submitted month changed and submitted again.
 *   - Timesheets: no "Whose timesheet" block; From and To remembered; a period
 *     sent and sent again; a multi-month PDF named "… Timesheet, Oct + Nov …".
 *   - The Job Complete steps on the device: visible, scrolling inside the card,
 *     a done step a tab back to it; the customer's signature drawn (by finger
 *     on a touch viewport) across the pad, saved with its true proportions,
 *     shown again, and drawn in the issued PDF with those proportions.
 *   - Invoicing: Handled → Awaiting PO (an invoice number refused, the PO
 *     required) → Awaiting Invoice No → Invoiced, in the Invoiced tab.
 *   - Notifications: the Inbox in Jobcards, Messages and Forms, each holding
 *     exactly its own; Monthly Forms with no Export CSV.
 *   - No page scrolls sideways, no page error.
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
      const disposition = response.headers.get('content-disposition') ?? '';
      if (type.includes('json')) return { status: response.status, json: await response.json(), disposition };
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      return { status: response.status, text, disposition };
    },
    [method, path, body],
  );
const fileNameOf = (disposition) => /filename="([^"]+)"/u.exec(disposition)?.[1] ?? '';

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const shiftMonths = (date, months) => {
  const at = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() + months);
  return at.toISOString().slice(0, 10);
};
const PREVIOUS_MONTH_START = shiftMonths(today, -1);
const PREVIOUS_MONTH = PREVIOUS_MONTH_START.slice(0, 7);

await resetDemonstration(page, BASE);

/* ---- Attendance ---------------------------------------------------------- */
await check('Attendance: From and To across months, oldest day first, remembered after leaving the page', async () => {
  await as('Sipho Mahlangu');
  await go('/attendance');
  await page.getByTestId('my-attendance').waitFor({ timeout: 20000 });
  await page.getByTestId('my-attendance-from').fill(PREVIOUS_MONTH_START);
  await page.getByTestId('my-attendance-to').fill(today);
  await page.waitForFunction(
    (from) => document.querySelector('[data-testid="my-attendance-day"]')?.getAttribute('data-date') === from,
    PREVIOUS_MONTH_START,
    { timeout: 20000 },
  );
  const dates = await page.locator('[data-testid="my-attendance-day"]').evaluateAll((rows) => rows.map((row) => row.dataset.date));
  if (dates[0] !== PREVIOUS_MONTH_START || dates.at(-1) !== today) fail(`the days run ${dates[0]} … ${dates.at(-1)}`);
  if ([...dates].sort().join() !== dates.join()) fail('the days are not oldest first');
  await noPageOverflow('Attendance');
  await go('/dashboard');
  await go('/attendance');
  await page.getByTestId('my-attendance').waitFor({ timeout: 20000 });
  const from = await page.getByTestId('my-attendance-from').inputValue();
  const to = await page.getByTestId('my-attendance-to').inputValue();
  if (from !== PREVIOUS_MONTH_START || to !== today) fail(`after returning the page shows ${from} … ${to}`);
  return `${dates.length} days, ${from} → ${to}`;
});

await check('Attendance: the period PDF is named for both months and has no Notes column', async () => {
  // FORMS-PAGES-1 (2 November 2026): the page previews and prints it; the PDF itself is the same route.
  await page.getByTestId('attendance-preview').waitFor({ timeout: 10000 });
  const pdf = await call('GET', `/api/attendance/pdf?from=${PREVIOUS_MONTH_START}&to=${today}`);
  if (pdf.status !== 200) fail(`the PDF answered ${pdf.status}`);
  const name = fileNameOf(pdf.disposition);
  if (!/^SIPHO Atten [A-Z][a-z]{2}( \d{4})?-[A-Z][a-z]{2}( \d{4})?\.pdf$/u.test(name)) fail(`file name ${name}`);
  if (/\(Note\)/u.test(pdf.text)) fail('the PDF still has a Note column');
  if (!pdf.text.startsWith('%PDF-')) fail('not a PDF');
  return name;
});

await check('Attendance: a submitted month is changed and submitted again; the new submission replaces it', async () => {
  const me = (await call('GET', '/api/auth/me')).json.data.user.id;
  const first = await call('POST', `/api/payroll/${me}/${PREVIOUS_MONTH}/submit`, { confirmUnrecorded: true });
  if (first.status !== 200) fail(`the first submission answered ${first.status} ${JSON.stringify(first.json?.error ?? '')}`);
  const day = `${PREVIOUS_MONTH}-15`;
  const changed = await call('POST', '/api/attendance', { userId: me, date: day, status: 'absent', absenceReason: 'leave', note: '' });
  if (changed.status !== 200) fail(`changing a submitted month answered ${changed.status}`);
  await go('/payroll/mine');
  const submit = page.getByTestId('monthly-forms-submit').first();
  await submit.waitFor({ timeout: 20000 });
  if (!/again/u.test(await submit.innerText())) fail(`the button reads "${await submit.innerText()}"`);
  const second = await call('POST', `/api/payroll/${me}/${PREVIOUS_MONTH}/submit`, { confirmUnrecorded: true });
  if (second.status !== 200) fail(`the second submission answered ${second.status}`);
  const submitted = await call('GET', `/api/payroll/${me}/${PREVIOUS_MONTH}/attendance?version=submitted`);
  const rows = submitted.json?.data?.rows ?? [];
  if (!rows.some((row) => row.date === day && row.status === 'Absent')) fail('the office’s copy does not carry the change');
  await noPageOverflow('My Monthly Forms');
});

/* ---- Timesheets ---------------------------------------------------------- */
await check('Timesheets: no Whose timesheet block; From and To remembered; sent, and sent again', async () => {
  await as('Elmarie Coetzee');
  await go('/timesheets');
  await page.getByTestId('timesheet-table').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('timesheet-person').count()) !== 0 || (await page.getByLabel('Whose timesheet').count()) !== 0) fail('the Whose timesheet block is still there');
  const from = PREVIOUS_MONTH_START;
  await page.getByTestId('timesheet-from').fill(from);
  await page.getByTestId('timesheet-to').fill(today);
  await page.getByTestId('timesheet-period-label').waitFor({ timeout: 15000 });
  await noPageOverflow('Timesheets');
  await go('/dashboard');
  await go('/timesheets');
  await page.getByTestId('timesheet-table').waitFor({ timeout: 20000 });
  const shownFrom = await page.getByTestId('timesheet-from').inputValue();
  const shownTo = await page.getByTestId('timesheet-to').inputValue();
  if (shownFrom !== from || shownTo !== today) fail(`after returning the page shows ${shownFrom} … ${shownTo}`);
  const me = (await call('GET', '/api/auth/me')).json.data.user.id;
  const sent = await call('POST', `/api/timesheets/${me}/period/submit`, { from, to: today });
  if (sent.status !== 200) fail(`sending answered ${sent.status} ${JSON.stringify(sent.json?.error ?? '')}`);
  const again = await call('POST', `/api/timesheets/${me}/period/submit`, { from, to: today });
  if (again.status !== 200) fail(`sending again answered ${again.status}`);
  await go('/timesheets');
  await page.getByText(/^Sent to office /u).first().waitFor({ timeout: 20000 });
  // FORMS-PAGES-1: the page shows Preview and Print only — sending is on Monthly Forms.
  if ((await page.getByTestId('timesheet-send').count()) !== 0) fail('the Timesheets page still offers Send');
  return `${from} → ${today}`;
});

await check('Timesheets: a period over two months is named for the To month and its year (TS-NAME-TO-1)', async () => {
  const me = (await call('GET', '/api/auth/me')).json.data.user.id;
  const pdf = await call('GET', `/api/timesheets/${me}/period/pdf?from=${PREVIOUS_MONTH_START}&to=${today}`);
  if (pdf.status !== 200) fail(`the PDF answered ${pdf.status}`);
  const name = fileNameOf(pdf.disposition);
  const toMonth = new Date(`${today}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }).slice(0, 3);
  if (name !== `ELMARIE Timesheet ${toMonth} ${today.slice(0, 4)}.pdf`) fail(`file name ${name}`);
  return name;
});

/* ---- Monthly Forms and Notifications ------------------------------------- */
await check('Monthly Forms: no Export CSV for the Master or the Coordinator; the forms are still there', async () => {
  for (const who of ['Elmarie Coetzee', 'Christene van Niekerk']) {
    await as(who);
    await go('/payroll');
    await page.getByTestId('finance-package').waitFor({ timeout: 20000 });
    if ((await page.getByTestId('attendance-export').count()) !== 0) fail(`${who} still sees the CSV card`);
    if ((await page.getByRole('button', { name: 'Export CSV' }).count()) !== 0) fail(`${who} still sees Export CSV`);
    if ((await call('GET', `/api/attendance/export?from=${today}&to=${today}`)).status !== 404) fail('the CSV route still answers');
    await noPageOverflow(`Monthly Forms (${who})`);
  }
});

await check('Notifications: the Inbox in Jobcards, Messages, Monthly Forms and Standby, each holding exactly its own', async () => {
  // A message, so the Messages box has something in it.
  await as('Sipho Mahlangu');
  const conversations = await call('GET', '/api/conversations');
  const elmarie = 'user-master-elmarie';
  const opened = await call('POST', '/api/conversations', { participantIds: [elmarie] });
  const conversationId = opened.json?.data?.id ?? opened.json?.data?.conversation?.id ?? conversations.json?.data?.[0]?.id;
  if (conversationId !== undefined) await call('POST', `/api/conversations/${conversationId}/send`, { body: 'Standby question' });
  await as('Elmarie Coetzee');
  await go('/notifications');
  await page.getByTestId('inbox-boxes').waitFor({ timeout: 20000 });
  const all = (await call('GET', '/api/notifications')).json.data.notifications.filter((n) => n.handledAt === null);
  const category = (type) => (type === 'chat_message' ? 'messages' : /^timesheet_/u.test(type) ? 'monthly_forms' : /^standby_/u.test(type) ? 'standby' : 'jobcards');
  const counts = {};
  for (const box of ['jobcards', 'messages', 'monthly_forms', 'standby']) {
    await press(page.getByTestId(`inbox-box-${box}`));
    const expected = all.filter((n) => category(n.type) === box).length;
    const list = page.getByTestId(`inbox-list-${box}`);
    const shown = (await list.count()) === 0 ? 0 : await list.locator(':scope > li').count();
    if (shown !== expected) fail(`${box}: ${shown} shown, ${expected} expected`);
    counts[box] = shown;
    await noPageOverflow(`Inbox ${box}`);
  }
  return JSON.stringify(counts);
});

/* ---- The Job Complete steps and the signature, on the device --------------- */
const drawStroke = async (points) => {
  if (!touch) {
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y);
    await page.mouse.up();
    return;
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: points[0].x, y: points[0].y }] });
  for (const point of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
};
let drawn = null;
await check('Job Complete: the steps are visible and scroll inside the card; a done step is a tab back to it', async () => {
  await as('Lerato Dlamini');
  await go('/jobs/EJE-1058');
  await press(page.getByRole('button', { name: 'Accept job' }));
  await press(page.getByRole('button', { name: 'Accept and start' }));
  await page.getByRole('button', { name: 'No, Thanks' }).click({ timeout: 20000 }).catch(() => undefined);
  await press(page.getByRole('button', { name: 'Complete job' }));
  await page.getByText('Step 1 of', { exact: false }).waitFor({ timeout: 20000 });
  const strip = page.getByTestId('wizard-steps');
  await strip.waitFor({ timeout: 10000 });
  await noPageOverflow('the Job Complete steps');
  const box = await strip.boundingBox();
  if (box === null || box.width > width) fail('the step strip is wider than the screen');
  const current = page.locator('[data-testid="wizard-steps"] [aria-current="step"]');
  const currentBox = await current.boundingBox();
  if (currentBox === null || currentBox.x < box.x - 1 || currentBox.x + currentBox.width > box.x + box.width + 1) fail('the current step is not in view');
  await page.getByLabel(/Work performed/).fill('Replaced the drive belt and re-tensioned it.');
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });
  await press(page.getByRole('button', { name: 'Add labour' }).first());
  await press(page.getByRole('button', { name: '2', exact: true }));
  await press(page.getByRole('button', { name: 'Add labour' }).last());
  await page.getByText('Normal Time').first().waitFor({ timeout: 15000 });
  await press(page.getByRole('button', { name: 'Continue' }));
  await page.getByText('Ready for the customer').waitFor({ timeout: 20000 });
  // A future step cannot be skipped to; the done one is a tab back.
  const steps = page.locator('[data-testid="wizard-steps"] button');
  if (!(await steps.last().isDisabled())) fail('a step not reached yet can be tapped');
  await press(steps.first());
  await page.getByText('Step 1 of', { exact: false }).waitFor({ timeout: 10000 });
  await press(page.getByRole('button', { name: 'Continue' }));
  await page.getByText('Ready for the customer').waitFor({ timeout: 20000 });
  await press(page.getByRole('button', { name: 'Continue' }));
  await page.getByText('Step 3 of', { exact: false }).waitFor({ timeout: 20000 });
  await noPageOverflow('the signature step');
});

await check('Signature: drawn across the pad — by finger on a touch screen — and saved with its true proportions', async () => {
  await page.getByLabel('Customer name').fill('Annelie');
  await page.getByLabel('Customer surname').fill('Botha');
  const pad = page.getByTestId('signature-pad');
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  const left = box.x + box.width * 0.1;
  const right = box.x + box.width * 0.9;
  const top = box.y + box.height * 0.1;
  const bottom = box.y + box.height * 0.9;
  // A tall zig-zag across nearly the whole pad: several lines of "writing".
  const points = [];
  for (let i = 0; i <= 40; i += 1) points.push({ x: left + ((right - left) * i) / 40, y: i % 2 === 0 ? top : bottom });
  await drawStroke(points);
  await page.waitForTimeout(300);
  const ink = await page.getByTestId('signature-pad-ink').locator('path').getAttribute('d');
  if (ink === null || ink.split('L').length < 30) fail(`the pad kept only ${ink === null ? 0 : ink.split('L').length} points`);
  drawn = { ratio: (right - left) / (bottom - top) };
  await press(page.getByRole('button', { name: 'Confirm signature' }));
  await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 30000 });
  const job = (await call('GET', '/api/jobs/EJE-1058')).json.data.view.job;
  const path = job.signature?.strokeData ?? job.signature?.signatureData ?? '';
  const coords = [...path.matchAll(/[ML]([\d.]+),([\d.]+)/gu)].map((m) => [Number(m[1]), Number(m[2])]);
  if (coords.length < 30) fail(`the saved signature has ${coords.length} points`);
  const xs = coords.map((c) => c[0]);
  const ys = coords.map((c) => c[1]);
  const xRange = Math.max(...xs) - Math.min(...xs);
  const yRange = Math.max(...ys) - Math.min(...ys);
  // The whole height of what was drawn (not one line), and its true proportions in the 4:1 space.
  if (yRange < 0.5) fail(`the saved signature spans only ${(yRange * 100).toFixed(0)}% of the height`);
  const saved = (xRange * 4) / yRange;
  if (Math.abs(saved - drawn.ratio) / drawn.ratio > 0.08) fail(`proportions ${saved.toFixed(2)} saved for ${drawn.ratio.toFixed(2)} drawn`);
  return `${coords.length} points, height ${(yRange * 100).toFixed(0)}%, proportions ${saved.toFixed(2)} ≈ ${drawn.ratio.toFixed(2)}`;
});

await check('Signature: shown again at its own proportions, and drawn in the issued PDF with them', async () => {
  await press(page.getByRole('button', { name: 'Submit job card' }).first());
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await press(page.getByRole('dialog').getByRole('button', { name: 'Submit job card' }));
  await page.getByText('Office Handling', { exact: false }).first().waitFor({ timeout: 30000 });
  await go('/jobs/EJE-1058/review');
  const display = page.locator('svg[aria-label="Customer signature"]').first();
  await display.waitFor({ timeout: 20000 });
  const shown = await display.boundingBox();
  if (Math.abs(shown.width / shown.height - 4) > 0.15) fail(`the signature is shown at ${(shown.width / shown.height).toFixed(2)}:1`);
  // The issued document is opened by POST (opening it is audited), base64 in JSON.
  const opened = await call('POST', '/api/documents/EJE-1058', {});
  if (opened.status !== 200) fail(`the issued PDF answered ${opened.status}`);
  const pdf = { text: Buffer.from(opened.json.data.base64, 'base64').toString('latin1') };
  if (!pdf.text.startsWith('%PDF-')) fail('the issued document is not a PDF');
  // The signature is the longest run of line segments in the page's drawing.
  const runs = [];
  let run = [];
  for (const match of pdf.text.matchAll(/(-?[\d.]+) (-?[\d.]+) ([ml])\b/gu)) {
    const point = [Number(match[1]), Number(match[2])];
    if (match[3] === 'm') {
      if (run.length > 0) runs.push(run);
      run = [point];
    } else run.push(point);
  }
  if (run.length > 0) runs.push(run);
  const all = runs.filter((candidate) => candidate.length > 10).flat();
  if (all.length < 30) fail('the signature is not drawn in the PDF');
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const ratio = (Math.max(...xs) - Math.min(...xs)) / (Math.max(...ys) - Math.min(...ys));
  if (Math.abs(ratio - drawn.ratio) / drawn.ratio > 0.1) fail(`drawn in the PDF at ${ratio.toFixed(2)} for ${drawn.ratio.toFixed(2)} on the pad`);
  return `PDF proportions ${ratio.toFixed(2)} ≈ ${drawn.ratio.toFixed(2)}`;
});

/* ---- Invoicing ------------------------------------------------------------- */
await check('Invoicing: Handled → Awaiting PO (no invoice number accepted) → Awaiting Invoice No → Invoiced, then in Closed Jobs (INVOICED-CLOSED-1)', async () => {
  await as('Elmarie Coetzee');
  await go('/jobs/EJE-1058');
  const panel = page.getByTestId('office-lifecycle');
  await panel.waitFor({ timeout: 20000 });
  await press(panel.getByTestId('mark-handled'));
  await panel.getByTestId('po-number').waitFor({ timeout: 15000 });
  const jobId = (await call('GET', '/api/jobs/EJE-1058')).json.data.view.job.id;
  const skipped = await call('POST', `/api/jobs/${jobId}/record_invoice`, { invoiceNumber: 'INV-SKIP' });
  if (skipped.status !== 422) fail(`an invoice number at Awaiting PO answered ${skipped.status}`);
  await press(panel.getByTestId('save-po-number'));
  await panel.getByText("Enter the customer's PO number", { exact: false }).waitFor({ timeout: 10000 });
  await panel.getByTestId('po-number').fill('PO-CHECK-1058');
  await press(panel.getByTestId('save-po-number'));
  await panel.getByTestId('invoice-number').waitFor({ timeout: 15000 });
  await go('/notifications?tab=awaiting_invoice_no');
  const row = page.getByTestId('awaiting-invoice-EJE-1058');
  await row.waitFor({ timeout: 20000 });
  await row.getByText('Purchase Order:PO-CHECK-1058').waitFor({ timeout: 5000 });
  await press(row.getByRole('button', { name: 'Save' }));
  await row.getByText('Enter the invoice number from Sage', { exact: false }).waitFor({ timeout: 10000 });
  await row.getByTestId('invoice-number-EJE-1058').fill('INV-CHECK-1058');
  await press(row.getByRole('button', { name: 'Save' }));
  await row.waitFor({ state: 'detached', timeout: 15000 });
  // INVOICED-CLOSED-1 (3 November 2026): no Invoiced tab in the active workflow — the job is in Closed Jobs.
  if ((await page.getByRole('tab', { name: /^Invoiced/u }).count()) !== 0) fail('the office queue still has an Invoiced tab');
  await go('/jobs/closed');
  const invoiced = page.getByTestId('closed-status-EJE-1058').first();
  await invoiced.waitFor({ timeout: 20000 });
  await invoiced.getByText('Invoice INV-CHECK-1058').waitFor({ timeout: 5000 });
  await invoiced.getByText('Purchase Order:PO-CHECK-1058').waitFor({ timeout: 5000 }); // NOTIF-PO-LABEL-1 (2 November 2026)
  await invoiced.getByText('Invoiced').waitFor({ timeout: 5000 });
  await noPageOverflow('Closed Jobs');
});

await check('no page errors anywhere in the run', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([kind]) => kind === 'FAIL');
console.log(`\n=== tester fixes ${label}: ${results.length - failed.length} passed, ${failed.length} failed ===`);
for (const [, text] of failed) console.log(` FAIL ${text}`);
process.exit(failed.length === 0 ? 0 : 1);
