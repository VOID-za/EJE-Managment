/**
 * TWO DEVICES, ONE TIMESHEET LINE — THROUGH THE SCREEN (PAYROLL-ONE-1
 * follow-ups, 5 November 2026).
 *
 * The same technician on two devices (two separate browser sessions) at one
 * screen size per run (EJE_FORMS_VIEWPORT):
 *   - a line added on one is seen on the other after a refresh;
 *   - SAVE/SAVE: both change it from the same version — the first is
 *     confirmed; the second is NOT silently written over it: it is refused,
 *     the device says so and names what it typed, and shows the confirmed line;
 *   - SAVE/REMOVE: one removes it, the other (still showing it) types into it —
 *     the removal is NOT reversed: the save is refused, said, the line goes;
 *   - after every step both devices, refreshed, show the same confirmed state,
 *     and there is never a second copy of the line;
 *   - OFFLINE: typed with no connection it is kept and said, and saved when the
 *     connection is back;
 *   - LEAVING: typed and the page left at once, it is still saved;
 *   - ONE DAY, TWO LINES, TWO DEVICES (TS-DAY-1, 6 November 2026): each device
 *     adds and edits its own line under the same day block — neither is
 *     refused, neither overwrites the other, the day holds both once.
 *
 * Each day is one block, closed when the page opens (TS-DAY-1): the check
 * opens the days it uses, and confirms each removal in its dialog.
 *
 *   npm run timesheet-two-devices-check                    (desktop, 1440x900)
 *   EJE_FORMS_VIEWPORT=768x1024:touch npm run timesheet-two-devices-check
 *   EJE_FORMS_VIEWPORT=390x844:touch npm run timesheet-two-devices-check
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
const device = async () => {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch && width < 700 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
};
const A = await device();
const B = await device();

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
const shift = (days) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const FROM = shift(-10);
const DAY = shift(-3);
const CUSTOMER = 'Two Device Customer';

const press = async (page, locator) => {
  await locator.scrollIntoViewIfNeeded();
  if (touch) await locator.tap();
  else await locator.click();
};
/** Opens a day block (TS-DAY-1: every day starts closed). */
const openDay = async (page, date) => {
  const day = page.locator(`[data-testid="timesheet-day"][data-date="${date}"]`);
  if ((await day.getAttribute('data-open')) !== 'yes') await press(page, day.getByTestId('timesheet-day-toggle'));
  await day.getByTestId('timesheet-day-body').waitFor({ timeout: 10000 });
};
const open = async (page) => {
  await page.goto(`${BASE}/timesheets?from=${FROM}&to=${today}`, { waitUntil: 'networkidle' });
  await page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  for (const date of [DAY, shift(-5)]) await openDay(page, date);
};
/** Remove line, then Remove line again in its confirmation. */
const removeLine = async (page, line) => {
  await press(page, line.getByTestId('remove-timesheet-line'));
  await press(page, page.getByRole('dialog').getByRole('button', { name: 'Remove line' }));
};
const saved = (page) =>
  page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === 'saved', null, { timeout: 20000 });
const lineOn = (page, id) => page.locator(`[data-testid="timesheet-line"][data-line-id="${id}"]`);
/** How many lines on the page carry the test's customer — never more than one. */
const copies = (page) => ({
  count: () => page.evaluate((name) => [...document.querySelectorAll('[data-testid="timesheet-customer-name"]')].filter((input) => input.value === name).length, CUSTOMER),
});
/** What the server holds for the line, read by the device. */
const held = (page, id) =>
  page.evaluate(async (lineId) => {
    const me = (await (await fetch('/api/auth/me')).json()).data.user.id;
    const lines = (await (await fetch(`/api/timesheets/${me}/lines`)).json()).data;
    return lines.filter((line) => line.id === lineId).map((line) => ({ overtime: line.typed.overtime, complete: line.complete }));
  }, id);

console.log(`two-devices check at ${label} against ${BASE}`);
await A.page.goto(`${BASE}/`);
await resetDemonstration(A.page, BASE);
await signInAs(A.page, 'Sipho Mahlangu', { base: BASE });
await signInAs(B.page, 'Sipho Mahlangu', { base: BASE });

let id = null;
await check('a line added on device A is seen on device B after a refresh — one copy', async () => {
  await open(A.page);
  const before = await A.page.locator(`[data-testid="timesheet-line"][data-date="${DAY}"]`).count();
  await press(A.page, A.page.getByTestId(`add-timesheet-line-${DAY}`));
  await A.page.waitForFunction(([d, n]) => document.querySelectorAll(`[data-testid="timesheet-line"][data-date="${d}"]`).length > n, [DAY, before], { timeout: 10000 });
  id = await A.page.locator(`[data-testid="timesheet-line"][data-date="${DAY}"]`).nth(before).getAttribute('data-line-id');
  await lineOn(A.page, id).getByTestId('timesheet-customer-name').fill(CUSTOMER);
  await lineOn(A.page, id).getByTestId('timesheet-overtime').fill('1');
  await saved(A.page);
  await open(B.page);
  if ((await lineOn(B.page, id).getByTestId('timesheet-overtime').inputValue()) !== '1') fail('device B does not show the line');
  if ((await copies(B.page).count()) !== 1) fail(`device B shows ${await copies(B.page).count()} copies`);
});

await check('SAVE/SAVE: A confirmed first; B, from the same version, is refused, told what it typed, and shows A\'s line', async () => {
  await lineOn(A.page, id).getByTestId('timesheet-overtime').fill('2');
  await saved(A.page);
  await lineOn(B.page, id).getByTestId('timesheet-overtime').fill('5');
  const conflict = B.page.getByTestId('autosave-conflict');
  await conflict.waitFor({ timeout: 20000 });
  const text = await conflict.innerText();
  if (!/changed somewhere else/iu.test(text)) fail(`B's message: ${text}`);
  if (!/Not saved from this screen: .*OT 5/u.test(text)) fail(`B is not told what it typed: ${text}`);
  await B.page.waitForFunction((lineId) => document.querySelector(`[data-testid="timesheet-line"][data-line-id="${lineId}"] [data-testid="timesheet-overtime"]`)?.value === '2', id, { timeout: 15000 });
  const server = await held(B.page, id);
  if (server.length !== 1 || server[0].overtime !== '2') fail(`the server holds ${JSON.stringify(server)}`);
  for (const side of [A, B]) {
    await open(side.page);
    if ((await lineOn(side.page, id).getByTestId('timesheet-overtime').inputValue()) !== '2') fail('a device shows another value after a refresh');
    if ((await copies(side.page).count()) !== 1) fail('a second copy of the line appeared');
  }
  return 'confirmed 2 kept; B told it typed 5';
});

await check('OFFLINE then online on B: the typing is kept and said, then saved; A sees it', async () => {
  await B.context.setOffline(true);
  await lineOn(B.page, id).getByTestId('timesheet-overtime').fill('3');
  await B.page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === 'offline', null, { timeout: 20000 });
  if (!/kept on this device/iu.test(await B.page.getByTestId('autosave-status').innerText())) fail('offline is not said');
  await B.context.setOffline(false);
  await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await saved(B.page);
  await open(A.page);
  if ((await lineOn(A.page, id).getByTestId('timesheet-overtime').inputValue()) !== '3') fail('A does not see the change saved after the connection came back');
});

await check('LEAVING at once: typed on A and the page left immediately — still saved', async () => {
  await lineOn(A.page, id).getByTestId('timesheet-overtime').fill('4');
  await A.page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  await A.page.waitForTimeout(2500);
  await open(A.page);
  if ((await lineOn(A.page, id).getByTestId('timesheet-overtime').inputValue()) !== '4') fail('the change typed before leaving was lost');
  if ((await copies(A.page).count()) !== 1) fail('a second copy appeared');
});

await check('a NEW line typed while saving is cut off is still on the screen after a reload — and saved when the connection is back', async () => {
  const day = shift(-5);
  await open(B.page);
  await B.page.route('**/api/timesheets/*/lines', (route) => (route.request().method() === 'POST' ? route.abort('internetdisconnected') : route.continue()));
  const before = await B.page.locator(`[data-testid="timesheet-line"][data-date="${day}"]`).count();
  await press(B.page, B.page.getByTestId(`add-timesheet-line-${day}`));
  await B.page.waitForFunction(([d, n]) => document.querySelectorAll(`[data-testid="timesheet-line"][data-date="${d}"]`).length > n, [day, before], { timeout: 10000 });
  const queuedId = await B.page.locator(`[data-testid="timesheet-line"][data-date="${day}"]`).nth(before).getAttribute('data-line-id');
  await lineOn(B.page, queuedId).getByTestId('timesheet-customer-name').fill('Queued On The Device');
  await lineOn(B.page, queuedId).getByTestId('timesheet-overtime').fill('1.5');
  await B.page.waitForFunction(() => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === 'offline', null, { timeout: 20000 });
  await B.page.reload({ waitUntil: 'networkidle' });
  await B.page.getByTestId('timesheet-days').waitFor({ timeout: 20000 });
  await openDay(B.page, day);
  const shown = lineOn(B.page, queuedId);
  await shown.waitFor({ timeout: 10000 });
  if ((await shown.getByTestId('timesheet-customer-name').inputValue()) !== 'Queued On The Device') fail('the queued line is not shown as typed after the reload');
  await B.page.unroute('**/api/timesheets/*/lines');
  await B.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await press(B.page, B.page.getByTestId('autosave-retry')).catch(() => undefined);
  await saved(B.page);
  const server = await held(B.page, queuedId);
  if (server.length !== 1 || server[0].overtime !== '1.5') fail(`the server holds ${JSON.stringify(server)}`);
  await removeLine(B.page, lineOn(B.page, queuedId));
  await saved(B.page);
});

await check('SAVE/REMOVE: A removes the line; B, still showing it, types into it — refused, told, and the line stays removed on both', async () => {
  await open(B.page);
  await removeLine(A.page, lineOn(A.page, id));
  await saved(A.page);
  await lineOn(B.page, id).getByTestId('timesheet-overtime').fill('9');
  const conflict = B.page.getByTestId('autosave-conflict');
  await conflict.waitFor({ timeout: 20000 });
  const text = await conflict.innerText();
  if (!/was removed/iu.test(text) || !/OT 9/u.test(text)) fail(`B's message: ${text}`);
  await lineOn(B.page, id).waitFor({ state: 'detached', timeout: 15000 });
  for (const side of [A, B]) {
    await open(side.page);
    if ((await lineOn(side.page, id).count()) !== 0) fail('the removed line came back');
  }
  if ((await held(B.page, id)).length !== 0) fail('the server holds the removed line again');
  return 'removal kept; B told it typed 9';
});

await check('ONE DAY, TWO DEVICES, TWO LINES: each edits its own line under the same day — both kept, neither refused, the day adds up once', async () => {
  const day = shift(-2);
  const add = async (side, name) => {
    await open(side.page);
    await openDay(side.page, day);
    const before = await side.page.locator(`[data-testid="timesheet-line"][data-date="${day}"]`).count();
    await press(side.page, side.page.getByTestId(`add-timesheet-line-${day}`));
    await side.page.waitForFunction(([d, n]) => document.querySelectorAll(`[data-testid="timesheet-line"][data-date="${d}"]`).length > n, [day, before], { timeout: 10000 });
    const lineId = await side.page.locator(`[data-testid="timesheet-line"][data-date="${day}"]`).nth(before).getAttribute('data-line-id');
    await lineOn(side.page, lineId).getByTestId('timesheet-customer-name').fill(name);
    await lineOn(side.page, lineId).getByTestId('timesheet-overtime').fill('1');
    await saved(side.page);
    return lineId;
  };
  const onA = await add(A, 'Day Visit A');
  const onB = await add(B, 'Day Visit B');
  // Both devices now type into their own line of the same day at the same time — two lines, no conflict.
  await lineOn(A.page, onA).getByTestId('timesheet-overtime').fill('2.5');
  await lineOn(B.page, onB).getByTestId('timesheet-double').fill('1.25');
  await Promise.all([saved(A.page), saved(B.page)]);
  for (const side of [A, B]) {
    if ((await side.page.getByTestId('autosave-conflict').count()) !== 0) fail('a device was told of a conflict between two different lines');
  }
  const a = await held(A.page, onA);
  const lines = await B.page.evaluate(async (lineId) => {
    const me = (await (await fetch('/api/auth/me')).json()).data.user.id;
    return (await (await fetch(`/api/timesheets/${me}/lines`)).json()).data.filter((line) => line.id === lineId).map((line) => line.typed);
  }, onB);
  if (a.length !== 1 || a[0].overtime !== '2.5') fail(`A's line on the server: ${JSON.stringify(a)}`);
  if (lines.length !== 1 || lines[0].double !== '1.25' || lines[0].overtime !== '1') fail(`B's line on the server: ${JSON.stringify(lines)}`);
  for (const side of [A, B]) {
    await open(side.page);
    await openDay(side.page, day);
    const summary = await side.page.locator(`[data-testid="timesheet-day"][data-date="${day}"] [data-testid="timesheet-day-summary"]`).innerText();
    if (!/2 lines/u.test(summary) || !/OT 3\.50/u.test(summary) || !/D\/T 1\.25/u.test(summary)) fail(`the day reads "${summary}"`);
  }
  await removeLine(A.page, lineOn(A.page, onA));
  await saved(A.page);
  await removeLine(A.page, lineOn(A.page, onB));
  await saved(A.page);
  return 'A 2.5 OT and B 1.25 D/T kept on one day: OT 3.50, D/T 1.25';
});

await check('no page error on either device; no page scrolls sideways', async () => {
  for (const side of [A, B]) {
    const over = await side.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) fail(`scrolls sideways by ${over}px`);
  }
  const errors = [...A.errors, ...B.errors];
  if (errors.length > 0) fail(errors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([verdict]) => verdict === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed at ${label}`);
process.exit(failed.length === 0 ? 0 : 1);
