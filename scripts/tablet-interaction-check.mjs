/**
 * WHAT A TABLET DOES THAT A SCREENSHOT CANNOT SHOW. MASTER SCOPE UX-TAB-1.
 *
 * `tablet-audit.mjs` measures every page at rest. This drives the things a
 * person does with a tablet in their hands, with a touch screen and TAPS (not
 * mouse clicks), against the demonstration backend:
 *
 *  1. TURNING IT ROUND IN THE MIDDLE OF A FORM. A timesheet line, a message and
 *     a new job are typed in landscape, the tablet is turned to portrait and
 *     back, and what was typed must still be there, in a form that is still on
 *     the screen, with its Save/Send still reachable.
 *  2. DIALOGS ON THE SHORTEST SCREENS. A dialog is opened on 1280×800 and
 *     1024×768 landscape and 768×1024 portrait; it must fit the screen, and its
 *     buttons must be the element under the finger where they are drawn (not
 *     under a header, a footer or the edge of the screen).
 *  3. THE TIMESHEET FREEZE, ON A TABLET. The date is cleared and retyped by
 *     touch, and the form must stay and answer.
 *
 * Nothing here is saved except in the demonstration store, which it resets.
 *
 * Usage: EJE_E2E_URL=http://127.0.0.1:3210 node scripts/tablet-interaction-check.mjs
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';

const BASE = process.env.EJE_E2E_URL ?? 'http://localhost:3000';
const LANDSCAPE = { width: 1024, height: 768 };
const PORTRAIT = { width: 768, height: 1024 };
const SHORT_SCREENS = [{ width: 1280, height: 800 }, LANDSCAPE, PORTRAIT];

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM === undefined ? {} : { executablePath: process.env.PLAYWRIGHT_CHROMIUM },
);
const context = await browser.newContext({ viewport: LANDSCAPE, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

let failed = 0;
let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name} :: ${error.message.split('\n')[0]}`);
    await page.screenshot({ path: `tablet-interaction-fail-${failed}.png` }).catch(() => {});
  }
};

/** The element under the middle of `locator` IS that element: drawn, on screen, tappable. */
const tappable = async (locator, what) => {
  await locator.scrollIntoViewIfNeeded();
  const ok = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    if (box.bottom > window.innerHeight + 1 || box.top < -1 || box.right > window.innerWidth + 1 || box.left < -1) return false;
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === element || element.contains(hit);
  });
  if (!ok) throw new Error(`${what} is not the element under the finger where it is drawn`);
};

/** A dialog that fits the screen, with every one of its buttons tappable. */
const dialogFits = async (what) => {
  const dialog = page.getByRole('dialog').last();
  await dialog.waitFor({ timeout: 8000 });
  const box = await dialog.boundingBox();
  const screen = page.viewportSize();
  if (box.y < -1 || box.y + box.height > screen.height + 1 || box.x < -1 || box.x + box.width > screen.width + 1) {
    throw new Error(`${what}: the dialog (${Math.round(box.width)}×${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}) does not fit ${screen.width}×${screen.height}`);
  }
  for (const button of await dialog.locator('footer button, header button').all()) {
    if (await button.isVisible()) await tappable(button, `${what}: "${(await button.innerText()).trim() || (await button.getAttribute('aria-label'))}"`);
  }
};

const rotate = async (check) => {
  await page.setViewportSize(PORTRAIT);
  await page.waitForTimeout(400);
  await check('portrait');
  await page.setViewportSize(LANDSCAPE);
  await page.waitForTimeout(400);
  await check('landscape again');
};

await resetDemonstration(page, BASE);

/* ------------------------------------------------------------------ */
/* The technician                                                      */
/* ------------------------------------------------------------------ */
await signInAs(page, 'Deon Botha');

await step('technician: the timesheet freeze, by touch — clear the date, retype it, the form stays and answers', async () => {
  await page.goto(`${BASE}/timesheets`, { waitUntil: 'networkidle' });
  await page.getByTestId('timesheet-day').first().waitFor({ timeout: 15000 });
  const days = await page.getByTestId('timesheet-day').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-date')));
  await page.locator(`[data-testid="timesheet-day"][data-date="${days[1]}"]`).getByTestId('add-timesheet-line').tap();
  const form = page.getByTestId('timesheet-line-form');
  await form.waitFor({ timeout: 5000 });
  const date = form.getByTestId('timesheet-line-date');
  await date.tap();
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(300);
  if ((await form.count()) !== 1) throw new Error('the line form vanished when the date was cleared');
  await date.fill(days[3]);
  await form.getByLabel('Customer', { exact: true }).tap();
  await page.keyboard.type('Kruger Engineering Midrand', { delay: 10 });
  if ((await form.count()) !== 1) throw new Error('the form vanished while typing');
});

await step('technician: turn the tablet with a timesheet line half typed — every value stays, Save line stays reachable', async () => {
  const form = page.getByTestId('timesheet-line-form');
  await rotate(async (shape) => {
    if ((await form.count()) !== 1) throw new Error(`the line form is gone in ${shape}`);
    const customer = await form.getByLabel('Customer', { exact: true }).inputValue();
    if (customer !== 'Kruger Engineering Midrand') throw new Error(`in ${shape} the customer reads "${customer}"`);
    await tappable(form.getByTestId('save-timesheet-line'), `Save line (${shape})`);
  });
  await form.getByTestId('save-timesheet-line').tap();
  await form.waitFor({ state: 'detached', timeout: 8000 });
});

await step('technician: turn the tablet with a message half typed — the text stays, Send stays reachable', async () => {
  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
  const send = page.getByTestId('chat-send');
  await send.waitFor({ timeout: 10000 });
  const box = page.getByLabel('Message');
  await box.tap();
  await page.keyboard.type('On site at Kruger, back by three.', { delay: 10 });
  await rotate(async (shape) => {
    if ((await box.inputValue()) !== 'On site at Kruger, back by three.') throw new Error(`the message was lost in ${shape}`);
    await tappable(send, `Send (${shape})`);
  });
});

await step('technician: the Accept dialog fits every short screen and its buttons can be tapped', async () => {
  for (const screen of SHORT_SCREENS) {
    await page.setViewportSize(screen);
    await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    const accept = page.getByRole('button', { name: 'Accept' }).first();
    if ((await accept.count()) === 0) throw new Error('no job offers Accept to this technician');
    await accept.tap();
    await dialogFits(`Accept at ${screen.width}×${screen.height}`);
    await page.getByRole('dialog').last().getByRole('button', { name: 'Cancel' }).tap();
  }
  await page.setViewportSize(LANDSCAPE);
});

/* ------------------------------------------------------------------ */
/* The office                                                          */
/* ------------------------------------------------------------------ */
await signInAs(page, 'Christene van Niekerk');

await step('coordinator: Mark unavailable fits every short screen; its fields take typing; Cancel is reachable', async () => {
  for (const screen of SHORT_SCREENS) {
    await page.setViewportSize(screen);
    await page.goto(`${BASE}/technicians/user-tech-lerato`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Mark unavailable' }).first().tap();
    await dialogFits(`Mark unavailable at ${screen.width}×${screen.height}`);
    const dialog = page.getByRole('dialog').last();
    const field = dialog.locator('textarea, input[type="text"]').first();
    if ((await field.count()) > 0) {
      await field.tap();
      await page.keyboard.type('Clinic visit', { delay: 10 });
      if (!(await field.inputValue()).includes('Clinic visit')) throw new Error('the dialog field did not take typing');
    }
    await dialog.getByRole('button', { name: 'Cancel' }).tap();
  }
  await page.setViewportSize(LANDSCAPE);
});

await signInAs(page, 'Elmarie Coetzee');

await step('master: turn the tablet while raising a new job — the fault description stays, Create stays reachable', async () => {
  await page.goto(`${BASE}/jobs/new`, { waitUntil: 'networkidle' });
  const fault = page.getByLabel(/fault/i).first();
  await fault.waitFor({ timeout: 10000 });
  await fault.tap();
  await page.keyboard.type('Spindle alarm 9031 on start-up.', { delay: 10 });
  await rotate(async (shape) => {
    if (!(await fault.inputValue()).includes('Spindle alarm 9031')) throw new Error(`the fault description was lost in ${shape}`);
    await tappable(page.getByRole('button', { name: 'Create job', exact: true }), `Create job (${shape})`);
  });
});

await step('no page errors anywhere', async () => {
  if (errors.length > 0) throw new Error(errors.join(' | '));
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
