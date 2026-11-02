/**
 * THE STANDBY CALENDAR THROUGH THE SCREEN. STANDBY-1…8 (2 November 2026).
 *
 * At one viewport per run (`EJE_FORMS_VIEWPORT=1440x900`, `768x1024:touch`,
 * `390x844:touch`), against the demonstration backend, from a reset:
 *
 *   - the office puts people on the standby roster, enters an order, generates
 *     NEXT year as drafts (so every week is in the future, whatever today is),
 *     and publishes it after reviewing the conflicts;
 *   - the month view, the week view, month/week and year navigation;
 *   - a technician sees no administration (and the API refuses it), finds their
 *     week, asks for a main-technician swap by tapping through the form, sees
 *     the week marked "Swap pending" with the calendar unchanged;
 *   - the office approves it in the queue; only the two main places move; both
 *     people are told; an apprentice swap is rejected with a note;
 *   - no page scrolls sideways and no page error is thrown.
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
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    [method, path, body],
  );
const tab = (name) => page.getByRole('tab', { name: new RegExp(`^${name}`, 'u') });

const today = await (async () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }))();
const YEAR = Number(today.slice(0, 4)) + 1;
const mondaysOf = (year) => {
  const weeks = [];
  const day = new Date(Date.UTC(year, 0, 1));
  while (day.getUTCDay() !== 1) day.setUTCDate(day.getUTCDate() + 1);
  while (day.getUTCFullYear() === year) {
    weeks.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 7);
  }
  return weeks;
};
const WEEKS = mondaysOf(YEAR);
const yearCalendar = async () => (await call('GET', `/api/standby?from=${YEAR}-01-01&to=${YEAR}-12-31`)).json?.data;
const holder = (calendar, weekStart, position) =>
  calendar.weeks.find((week) => week.weekStart === weekStart)?.places.find((place) => place.position === position)?.userId ?? null;

await resetDemonstration(page, BASE);

const ROSTER = {
  'Sipho Mahlangu': 'main',
  'Riaan van Wyk': 'main',
  'Thabo Nkosi': 'helper',
  'Francois du Toit': 'helper',
  'André Steyn': 'apprentice',
  'Naledi Molefe': 'apprentice',
  'Deon Botha': 'apprentice',
  'Lerato Dlamini': 'apprentice',
};
const ORDER = {
  main: ['Sipho Mahlangu', 'Riaan van Wyk'],
  helper: ['Thabo Nkosi', 'Francois du Toit'],
  apprentice_1: ['André Steyn', 'Naledi Molefe'],
  apprentice_2: ['Deon Botha', 'Lerato Dlamini'],
};

await check('the office sees the Standby Calendar with Manage schedule; the roster is set by tapping', async () => {
  await as('Christene van Niekerk');
  await go('/standby');
  await page.getByRole('heading', { name: 'Standby Calendar' }).waitFor({ timeout: 20000 });
  // The sidebar is always on screen from desktop width; on a tablet or phone it is the menu drawer.
  if (width >= 1024 && (await page.getByRole('link', { name: 'Standby Calendar' }).count()) === 0) fail('no sidebar link to the Standby Calendar');
  await press(tab('Manage schedule'));
  await page.getByTestId('standby-eligibility').waitFor({ timeout: 20000 });
  for (const [name, flag] of Object.entries(ROSTER)) {
    const row = page.getByTestId('standby-eligibility-row').filter({ hasText: name });
    const box = row.getByTestId(`standby-eligible-${flag}`);
    await press(box);
    await page.waitForFunction(
      ([who, which]) => {
        const rows = [...document.querySelectorAll('[data-testid="standby-eligibility-row"]')];
        const found = rows.find((node) => node.textContent?.includes(who));
        return found?.querySelector(`[data-testid="standby-eligible-${which}"]`)?.checked === true;
      },
      [name, flag],
      { timeout: 15000 },
    );
  }
  await noPageOverflow('Manage schedule');
  return `${Object.keys(ROSTER).length} people on the roster`;
});

await check(`the office enters an order and generates ${YEAR} as drafts, hidden from technicians`, async () => {
  await press(page.getByRole('button', { name: 'Next year' }));
  await page.getByTestId('standby-manage-year').filter({ hasText: String(YEAR) }).waitFor({ timeout: 15000 });
  for (const [position, names] of Object.entries(ORDER)) {
    const box = page.getByTestId(`standby-rotation-${position}`);
    for (const name of names) {
      await box.getByLabel('Add to the order').selectOption({ label: name });
      await press(box.getByRole('button', { name: 'Add' }));
    }
    const listed = await box.locator('li').count();
    if (listed !== names.length) fail(`${position}: ${listed} people in the order`);
  }
  await press(page.getByTestId('standby-generate-button'));
  const result = page.getByTestId('standby-generate-result');
  await result.waitFor({ timeout: 30000 });
  const text = await result.innerText();
  if (!text.startsWith(`${WEEKS.length} weeks added`)) fail(`generated: ${text}`);
  await page.getByTestId('standby-review-week').first().waitFor({ timeout: 20000 });
  const reviewed = await page.getByTestId('standby-review-week').count();
  if (reviewed !== WEEKS.length) fail(`${reviewed} weeks in the review`);
  await noPageOverflow('the year review');
  return text;
});

await check('a technician sees no draft and no administration, and the API refuses it', async () => {
  await as('Sipho Mahlangu');
  await go('/standby');
  await page.getByRole('heading', { name: 'Standby Calendar' }).waitFor({ timeout: 20000 });
  if ((await tab('Manage schedule').count()) !== 0) fail('a technician is offered Manage schedule');
  const calendar = await yearCalendar();
  if (calendar.weeks.length !== 0) fail(`a technician sees ${calendar.weeks.length} draft weeks`);
  const refused = await Promise.all([
    call('POST', '/api/standby/generate', { year: YEAR }),
    call('POST', '/api/standby/publish', { year: YEAR, acknowledgeIncomplete: true }),
    call('POST', '/api/standby/assign', { weekStart: WEEKS[0], position: 'main', userId: 'user-tech-sipho', expectedUserId: null, reason: '' }),
    call('POST', '/api/standby/eligibility', { userId: 'user-tech-sipho', main: true, helper: true, apprentice: false }),
  ]);
  if (refused.some((answer) => answer.status !== 403)) fail(`answers: ${refused.map((answer) => answer.status).join(', ')}`);
});

await check('the office reviews the conflicts and publishes the year', async () => {
  await as('Christene van Niekerk');
  await go('/standby?tab=manage');
  await page.getByTestId('standby-manage').waitFor({ timeout: 20000 });
  await press(page.getByRole('button', { name: 'Next year' }));
  await page.getByTestId('standby-review-week').first().waitFor({ timeout: 20000 });
  await press(page.getByTestId('standby-publish-open'));
  await page.getByTestId('standby-publish-review').waitFor({ timeout: 10000 });
  await press(page.getByTestId('standby-publish-confirm'));
  await page.getByTestId('standby-message').filter({ hasText: 'weeks published' }).waitFor({ timeout: 30000 });
  const calendar = await yearCalendar();
  if (calendar.weeks.some((week) => week.status !== 'published')) fail('a week is still a draft');
  if (calendar.weeks.some((week) => week.problems.length > 0)) fail('a published week has warnings');
});

await check('month view, week view, and month, week and year navigation', async () => {
  await go(`/standby?week=${WEEKS[0]}`);
  await page.getByTestId('standby-week-view').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('standby-week').count()) !== 1) fail('the week view does not show one week');
  const period = page.getByTestId('standby-period');
  const first = await period.innerText();
  await press(page.getByTestId('standby-next'));
  await page.waitForFunction((before) => document.querySelector('[data-testid="standby-period"]')?.textContent !== before, first);
  await press(page.getByTestId('standby-view-month'));
  await page.getByTestId('standby-month-view').waitFor({ timeout: 20000 });
  const weeks = await page.getByTestId('standby-week').count();
  if (weeks < 4 || weeks > 6) fail(`the month view shows ${weeks} weeks`);
  for (const position of ['main', 'helper', 'apprentice_1', 'apprentice_2']) {
    if ((await page.getByTestId(`standby-place-${position}`).count()) !== weeks) fail(`a week does not show ${position}`);
  }
  const month = await period.innerText();
  await press(page.getByTestId('standby-next-year'));
  await page.waitForFunction((before) => document.querySelector('[data-testid="standby-period"]')?.textContent !== before, month);
  const next = await period.innerText();
  if (!next.endsWith(String(YEAR + 1))) fail(`next year shows ${next}`);
  await press(page.getByTestId('standby-prev-year'));
  await page.waitForFunction((want) => document.querySelector('[data-testid="standby-period"]')?.textContent === want, month);
  await press(page.getByTestId('standby-prev'));
  await noPageOverflow('the month view');
  return `${first} → ${month} → ${next}`;
});

let before = null;
await check('a technician asks for a main-technician swap by tapping through the form; nothing changes yet', async () => {
  await as('Sipho Mahlangu');
  before = await yearCalendar();
  const mine = WEEKS.find((week) => holder(before, week, 'main') === 'user-tech-sipho');
  await go(`/standby?week=${mine}`);
  await page.getByTestId('standby-mine').waitFor({ timeout: 20000 });
  await press(page.getByTestId('standby-week'));
  await page.getByTestId('standby-week-dialog').waitFor({ timeout: 10000 });
  await noPageOverflow('the week details');
  await press(page.getByTestId('standby-request-swap'));
  await page.getByTestId('standby-swap-mine').waitFor({ timeout: 20000 });
  await page.getByTestId('standby-swap-person').selectOption({ label: 'Riaan van Wyk' });
  const theirs = page.getByTestId('standby-swap-theirs');
  await theirs.waitFor({ timeout: 5000 });
  await theirs.selectOption({ index: 1 });
  await page.getByTestId('standby-swap-reason').fill('Family wedding');
  await noPageOverflow('the swap form');
  await press(page.getByTestId('standby-swap-submit'));
  await page.getByTestId('standby-message').filter({ hasText: 'Swap request sent' }).waitFor({ timeout: 20000 });
  const during = await yearCalendar();
  if (JSON.stringify(during.weeks.map((week) => week.places)) !== JSON.stringify(before.weeks.map((week) => week.places))) {
    fail('a pending request changed the calendar');
  }
  await page.getByTestId('standby-week-pending').first().waitFor({ timeout: 20000 });
  await press(tab('Swap requests'));
  await page.getByTestId('standby-withdraw').waitFor({ timeout: 20000 });
  return `offered ${mine}`;
});

await check('the office approves it in the queue: only the two main places move, both people are told', async () => {
  await as('Christene van Niekerk');
  await go('/standby?tab=requests');
  const card = page.getByTestId('standby-request').first();
  await card.waitFor({ timeout: 20000 });
  await card.getByTestId('standby-decision-note').fill('Approved — confirmed with both');
  await press(card.getByTestId('standby-approve'));
  await page.getByTestId('standby-message').filter({ hasText: 'Swap approved' }).waitFor({ timeout: 20000 });
  const requests = (await call('GET', '/api/standby/requests?status=approved')).json.data;
  if (requests.length !== 1) fail(`${requests.length} approved requests`);
  const request = requests[0];
  const after = await yearCalendar();
  for (const week of after.weeks) {
    const was = before.weeks.find((candidate) => candidate.weekStart === week.weekStart);
    for (const place of week.places) {
      const old = was.places.find((candidate) => candidate.position === place.position).userId;
      const expected =
        place.position === 'main' && week.weekStart === request.requesterWeekStart
          ? request.counterpartId
          : place.position === 'main' && week.weekStart === request.counterpartWeekStart
            ? request.requesterId
            : old;
      if (place.userId !== expected) fail(`${week.weekStart} ${place.position}: ${place.userId}, expected ${expected}`);
    }
  }
  await as('Riaan van Wyk');
  const notes = (await call('GET', '/api/notifications')).json.data.notifications;
  if (notes.filter((note) => note.type === 'standby_swap_decided').length !== 1) fail('Riaan was not told exactly once');
  return `${request.requesterWeekStart} ⇄ ${request.counterpartWeekStart}`;
});

await check('an apprentice swap is rejected with a note; the calendar stays as it is', async () => {
  await as('André Steyn');
  const now = await yearCalendar();
  const mine = WEEKS.find((week) => holder(now, week, 'apprentice_1') === 'user-tech-andre');
  const options = (await call('GET', '/api/standby/options')).json.data;
  const target = options.candidates.find((candidate) => candidate.kind === 'apprentice' && candidate.weekStart !== mine && !now.weeks.find((week) => week.weekStart === candidate.weekStart).places.some((place) => place.userId === 'user-tech-andre') && !now.weeks.find((week) => week.weekStart === mine).places.some((place) => place.userId === candidate.userId));
  const asked = await call('POST', '/api/standby/requests', { kind: 'apprentice', weekStart: mine, counterpartId: target.userId, counterpartWeekStart: target.weekStart, reason: 'Exam' });
  if (asked.status !== 200) fail(`asking answered ${asked.status}`);
  await as('Elmarie Coetzee');
  await go('/standby?tab=requests');
  const card = page.getByTestId('standby-request').first();
  await card.waitFor({ timeout: 20000 });
  await card.getByTestId('standby-decision-note').fill('Exam week is covered already');
  await press(card.getByTestId('standby-reject'));
  await page.getByTestId('standby-message').filter({ hasText: 'Swap rejected' }).waitFor({ timeout: 20000 });
  const after = await yearCalendar();
  if (JSON.stringify(after.weeks.map((week) => week.places)) !== JSON.stringify(now.weeks.map((week) => week.places))) fail('a rejection changed the calendar');
  await press(tab('Rejected'));
  await page.getByText('Exam week is covered already').waitFor({ timeout: 10000 });
  await noPageOverflow('the swap requests');
});

await check('no page errors anywhere in the run', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([kind]) => kind === 'FAIL');
console.log(`\n=== standby ${label}: ${results.length - failed.length} passed, ${failed.length} failed ===`);
for (const [, text] of failed) console.log(` FAIL ${text}`);
process.exit(failed.length === 0 ? 0 : 1);
