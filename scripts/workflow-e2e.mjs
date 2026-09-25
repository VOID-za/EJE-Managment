/**
 * The job workflow, end to end, in a real browser.
 *
 * Written after a live demonstration reported `/jobs/<n>/sign` and
 * `/jobs/<n>/review` returning 404. Both routes were present and correct — a
 * stale server was answering the port — but nothing in the suite walked the
 * whole workflow through the browser's own address bar and asserted that no
 * step lands on a 404. `npm run smoke` drives the same workflow through the UI,
 * which means a broken deep link or notification target could hide behind a
 * button that happens to work.
 *
 * So this exercises the routes the way a person does: type the URL, click the
 * notification, follow where it goes. Every navigation asserts the page is not
 * the 404 page.
 *
 * Usage:
 *   npm run start              # or npm run dev
 *   npm run e2e
 *   EJE_E2E_URL=http://localhost:3000 npm run e2e
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { resetDemonstration, signInAs as signInWith } from './sign-in.mjs';

const BASE = process.env.EJE_E2E_URL ?? 'http://localhost:3000';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;

const failures = [];
/** The first downloaded final document, so later steps can compare against it. */
let downloadedBytes = null;
const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });

const pageErrors = [];
/**
 * Which step the browser was in when an error was logged.
 *
 * "1 console error somewhere in 27 steps" is not something anybody can act on;
 * the step name is what turns it into a place to look.
 */
let currentStep = 'before the first step';

/*
 * A REFUSAL IS NOT A CONSOLE ERROR.
 *
 * The browser logs every non-2xx fetch, and the application now asks a server
 * for everything — so a refused sign-in, a validation failure the screen
 * renders and a first visit with no session each produce one. 5xx is
 * deliberately absent: an internal error is a fault, and this suite must keep
 * failing on one.
 */
const EXPECTED_HTTP = /Failed to load resource:.*status of (400|401|403|404|409|422|429)\b/;

page.on('pageerror', (error) => pageErrors.push(`[${currentStep}] ${error.message}`));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  if (EXPECTED_HTTP.test(message.text())) return;
  pageErrors.push(`[${currentStep}] ${message.text()}`);
});

const step = async (name, fn) => {
  currentStep = name;
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(`${name} :: ${error.message.split('\n')[0]}`);
    console.log(`FAIL  ${name} :: ${error.message.split('\n')[0]}`);
  }
};

/** Navigate, and refuse to accept a 404 as an answer. */
const visit = async (url) => {
  const response = await page.goto(`${BASE}${url}`, { waitUntil: 'networkidle' });
  const status = response === null ? 0 : response.status();
  const body = await page.locator('body').innerText();
  if (body.includes('This page could not be found')) {
    throw new Error(`${url} served the 404 page`);
  }
  if (status >= 400) throw new Error(`${url} returned HTTP ${status}`);
};

/** Assert the browser is not on a 404 after a click-through. */
const assertNot404 = async (what) => {
  const body = await page.locator('body').innerText();
  if (body.includes('This page could not be found')) {
    throw new Error(`${what} landed on a 404 (${page.url()})`);
  }
};

/**
 * Signs in with an email address and a password.
 *
 * `role` is kept in the call sites purely as documentation of who is being
 * signed in — it is no longer sent anywhere, because the server decides it.
 */
const signInAs = (role, name, greeting) =>
  signInWith(page, name, { base: BASE, greeting });

const drawSignature = async () => {
  const pad = page.locator('div.touch-none').first();
  await pad.waitFor({ timeout: 15000 });
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 110);
  await page.mouse.down();
  for (let i = 0; i < 28; i += 1) {
    await page.mouse.move(box.x + 60 + i * 11, box.y + 110 - Math.sin(i / 3) * 34);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
};

/*
 * A clean demonstration, first.
 *
 * The store is the server's now, so a second run would otherwise open on the
 * first run's work.
 */
await step('the demonstration data is reset to its seeded state', () =>
  resetDemonstration(page, BASE),
);

// ── PART 18: EJE-1056 review route ───────────────────────────────────────────
await signInAs('Master', 'Elmarie Coetzee', /Good day, Elmarie/);

await step('EJE-1056 review route loads, typed straight into the address bar', async () => {
  await visit('/jobs/EJE-1056/review');
  /*
   * "Job card", not "Review job card". MASTER SCOPE CR-07.
   *
   * EJE-1056 is CLOSED, so there is nothing to review and nobody to submit
   * it — the page is titled for what the reader can actually do with it. The
   * route itself is what this step exists to prove still resolves, which was
   * the 404 reported in a live demonstration.
   */
  await page.getByRole('heading', { name: 'Job card', exact: true }).waitFor({ timeout: 15000 });
  await page.getByText('EJE-1056').first().waitFor({ timeout: 10000 });
});

await step('EJE-1056 is closed, so its review screen is the final job card', async () => {
  await page.getByText('Issued and closed').waitFor({ timeout: 10000 });
  await page.getByText('EJE-1056-Final-Job-Card.pdf').first().waitFor({ timeout: 10000 });
  // Opening a closed job must not offer to issue it again.
  if ((await page.getByRole('button', { name: 'Submit Job Card' }).count()) > 0) {
    throw new Error('a closed job offered Submit Job Card');
  }
});

await step('EJE-1056 carries its real job data, not a placeholder', async () => {
  const body = await page.locator('main').innerText();
  for (const value of ['ABC Engineering', 'Johannesburg', 'Coolant pump']) {
    if (!body.includes(value)) throw new Error(`the review page does not show ${value}`);
  }
});

// ── PART 17: EJE-1065 signature workflow ─────────────────────────────────────
/*
 * The old standalone signature route is gone, and must stay gone.
 *
 * It was a second implementation of the signature — no refusal option, no
 * collection-method step, no waybill — that nothing linked to but that anybody
 * with an old bookmark could still reach, and that could therefore sign a
 * courier collection out as a priced customer collection. The guided close-out
 * below is the one way to take a signature.
 */
await step('the old standalone signature route no longer exists', async () => {
  const response = await page.goto(`${BASE}/jobs/EJE-1065/sign`, { waitUntil: 'networkidle' });
  const body = await page.locator('body').innerText();
  const gone = response.status() === 404 || body.includes('This page could not be found');
  if (!gone) {
    throw new Error(`/jobs/EJE-1065/sign is still served (HTTP ${response.status()})`);
  }
});

await step('EJE-1065 opens on its job screen, which is where the close-out lives', async () => {
  await visit('/jobs/EJE-1065');
  await page.getByRole('heading', { name: 'EJE-1065' }).first().waitFor({ timeout: 15000 });
});

await step('a technician drives EJE-1065 through the guided close-out', async () => {
  await signInAs('Technician', 'Sipho Mahlangu', /Hello, Sipho/);
  await visit('/jobs/EJE-1065');

  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByRole('button', { name: 'No, Thanks' }).click({ timeout: 20000 });

  // Complete Job opens the wizard; the close-out happens inside it.
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Step 1 of', { exact: false }).waitFor({ timeout: 20000 });
  await assertNot404('the completion wizard');

  /*
   * NOTHING IS PRESSED TO SAVE THIS. MASTER SCOPE WRITEUP-1.
   *
   * There is no Save write-up button any more. The step used to click one;
   * now it types and waits for the panel to say Saved on its own, which is
   * the behaviour rather than the button. If autosave ever stops firing, this
   * is where it is caught — the badge never appears.
   */
  await page.getByLabel(/Work performed/).fill('Replaced the faulty contactor and retested the line.');
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });

  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  // LAB-1: hours and a rate, and no second place to describe the work.
  const labourForm = await page.getByRole('dialog').innerText();
  if (/description of work/i.test(labourForm)) {
    throw new Error('the labour dialog still asks for a description of work');
  }
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Normal Time').first().waitFor({ timeout: 15000 });
});

await step('the call-out fee sits under Parts, not up beside Labour', async () => {
  const sections = await page.evaluate(() =>
    [...document.querySelectorAll('main h2, main h3')].map((node) => node.textContent.trim()),
  );
  const parts = sections.indexOf('Parts');
  const callout = sections.indexOf('Call-out fee');
  if (parts === -1 || callout === -1) {
    throw new Error(`Parts and Call-out fee are not both on the capture screen: ${sections}`);
  }
  if (callout < parts) {
    throw new Error(`Call-out fee is above Parts (${sections.join(' → ')})`);
  }
});

await step('the wizard reaches its review and then the signature step', async () => {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ready for the customer').waitFor({ timeout: 20000 });

  /*
   * NO DOCUMENT PREVIEW HERE. MASTER SCOPE REV-1.
   *
   * The Review step is a verification summary; the PDF belongs on the Signed
   * step, which is asserted a few steps below. Counting iframes is the whole
   * check, because the preview is the only one on the screen.
   */
  const previews = await page.locator('iframe').count();
  if (previews !== 0) {
    throw new Error(`the Review step still embeds ${previews} document preview(s)`);
  }
  // And the summary it was hiding is the thing that IS there.
  const summary = await page.locator('main').innerText();
  // The summary sets its labels in capitals, so they are asserted as drawn.
  for (const heading of ['CUSTOMER', 'SITE', 'MACHINE', 'JOB TYPE', 'WORK PERFORMED']) {
    if (!summary.includes(heading)) {
      throw new Error(`the Review summary is missing ${heading}`);
    }
  }

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of', { exact: false }).waitFor({ timeout: 20000 });
  await assertNot404('the signature step');
});

await step('the signature screen shows the existing EJE acceptance wording', async () => {
  await page
    .getByText('I confirm that the work described above has been completed.')
    .waitFor({ timeout: 10000 });
});

await step('the customer signs, and the signature is captured', async () => {
  await page.getByLabel('Customer name').fill('Gerhard');
  await page.getByLabel('Customer surname').fill('Smit');
  await drawSignature();
  await page.getByRole('button', { name: 'Confirm signature' }).click();
  // The signed document is shown before anything is submitted.
  await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 25000 });
  const preview = page.locator('iframe[title$="job card preview"]');
  await preview.waitFor({ timeout: 25000 });

  /*
   * THE PREVIEW IS THE SHAPE OF THE PAGE. MASTER SCOPE PDF-1.
   *
   * It was a 60vh letterbox holding a portrait A4 document, so the viewer
   * shrank the page into a squeezed strip. The frame now carries A4's own
   * proportions and is capped so it never outgrows the viewport. Measured
   * rather than described: a ratio is the only honest way to assert "not
   * squeezed".
   */
  const box = await preview.boundingBox();
  if (box === null) throw new Error('the signed preview is not on screen');
  const ratio = box.height / box.width;
  const a4 = 841.89 / 595.28;
  if (Math.abs(ratio - a4) > 0.02) {
    throw new Error(
      `the signed preview is ${ratio.toFixed(3)}:1, not A4's ${a4.toFixed(3)}:1 — the page is distorted`,
    );
  }
  const viewport = page.viewportSize();
  if (box.height > viewport.height) {
    throw new Error(`the signed preview is ${box.height}px tall in a ${viewport.height}px viewport`);
  }

  /*
   * THE TECHNICIAN SUBMITS IT FROM HERE. MASTER SCOPE CR-07.
   *
   * This read "Continue to submission" and navigated to the office review
   * screen, where a MASTER submitted. There is no office step in the normal
   * signed journey any more: the last act of the close-out is the technician's
   * own submission, taken in the wizard they are already standing in.
   */
  await page.getByRole('button', { name: 'Submit job card' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Submit job card' }).click();

  // Back on the job, which is now awaiting the customer's delivery.
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 30000 });
  await assertNot404('submitting the signed job card');
});

await step('the captured signature renders in solid black', async () => {
  // Scoped to the job card document on the review page, so this cannot pass
  // against the signature pad's own live stroke if capture never happened.
  await visit('/jobs/EJE-1065/review');
  const document = page.locator('.eje-document').first();
  await document.waitFor({ timeout: 15000 });
  await document.getByText('Gerhard').first().waitFor({ timeout: 10000 });

  const strokes = document.locator('svg path[stroke]');
  const count = await strokes.count();
  if (count === 0) throw new Error('the job card renders no signature strokes');

  const inks = new Set();
  for (let index = 0; index < count; index += 1) {
    inks.add(await strokes.nth(index).getAttribute('stroke'));
  }
  const wrong = [...inks].filter((ink) => ink !== '#000000');
  if (wrong.length > 0) {
    throw new Error(`the signature rendered ${wrong.join(', ')}, not #000000`);
  }
});

await step('the signature persists on the job across a reload', async () => {
  await visit('/jobs/EJE-1065');
  const body = await page.locator('main').innerText();
  if (!body.includes('Gerhard') || !body.includes('Smit')) {
    throw new Error('the signatory is not on the job after reload');
  }
  // And the signature is on the job screen itself, which is the only place it
  // is ever shown or taken.
  await visit('/jobs/EJE-1065');
  await page.getByText('Gerhard', { exact: false }).first().waitFor({ timeout: 10000 });
});

/*
 * ── PART 19: THE TECHNICIAN SUBMITTED IT. THE OFFICE WAS NEVER INVOLVED. ─────
 *
 * MASTER SCOPE CR-07, confirmed 25 September 2026. This part has now been
 * written three ways, and the history is worth keeping straight:
 *
 *  1. Originally the technician submitted, but so could anybody — the
 *     `95e9848` audit found `issue` gated on the job's STATUS and never on
 *     permission.
 *  2. `d979aa9` narrowed it to the MASTER under §3.1/§7/§15, and this step was
 *     rewritten to have him submit.
 *  3. EJE then confirmed there is no office step in the normal signed journey
 *     at all. The technician who attended the machine submits it; a Master and
 *     a Coordinator are refused, which is what the cases below assert.
 *
 * The submission itself already happened, in the wizard, in the step above.
 */
await step('EJE-1065 is submitted and awaiting delivery, with no office step', async () => {
  await visit('/jobs/EJE-1065');
  const body = await page.locator('main').innerText();

  if (/master review/i.test(body)) {
    throw new Error('the job screen mentions the retired stage');
  }
  for (const gone of [
    'With the office for submission',
    'A Master makes the final submission',
    'Review & submit job card',
  ]) {
    if (body.includes(gone)) {
      throw new Error(`the superseded office-review wording is still on screen: "${gone}"`);
    }
  }

  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 20000 });
});

await step('the customer copy exists and names the technician as its submitter', async () => {
  await visit('/jobs/EJE-1065');
  await page.getByRole('tab', { name: /Activity/ }).click();
  const trail = await page.locator('main').innerText();
  if (!/Sipho/.test(trail)) {
    throw new Error('the submission is not recorded against the technician who made it');
  }
});

await step('a Coordinator gets no submit action of any kind on a signed job', async () => {
  await signInAs('Coordinator', 'Christene van Niekerk', /Christene/);
  await visit('/jobs/EJE-1065');

  for (const name of ['Review & submit job card', 'Submit job card']) {
    if ((await page.getByRole('button', { name, exact: true }).count()) !== 0) {
      throw new Error(`the Coordinator was offered "${name}" on an ordinary signed job`);
    }
  }
  await visit('/jobs/EJE-1065/review');
  if ((await page.getByRole('button', { name: 'Submit job card' }).count()) !== 0) {
    throw new Error('the Coordinator was offered the final submission');
  }
});

await step('a Master gets none either — CR-07 took it from him too', async () => {
  await signInAs('Master', 'Elmarie Coetzee', /Good day, Elmarie/);
  await visit('/jobs/EJE-1065');

  for (const name of ['Review & submit job card', 'Submit job card']) {
    if ((await page.getByRole('button', { name, exact: true }).count()) !== 0) {
      throw new Error(`the Master was offered "${name}" on an ordinary signed job`);
    }
  }
  await visit('/jobs/EJE-1065/review');
  if ((await page.getByRole('button', { name: 'Submit job card' }).count()) !== 0) {
    throw new Error('the Master was offered the final submission');
  }
});

await step('a Coordinator is not offered Accept on field work', async () => {
  await signInAs('Coordinator', 'Christene van Niekerk', /Christene/);
  await visit('/jobs');
  const accepts = await page.getByRole('button', { name: 'Accept job' }).count();
  if (accepts !== 0) {
    throw new Error(`the Coordinator was offered Accept on ${accepts} field job(s)`);
  }
  await signInAs('Master', 'Elmarie Coetzee', /Good day, Elmarie/);
});

await step('the job did NOT close on a send the provider merely accepted', async () => {
  if ((await page.getByText('successfully delivered', { exact: false }).count()) !== 0) {
    throw new Error('the screen claimed a delivery that nothing has confirmed');
  }
  await visit('/jobs/EJE-1065');
  await assertNot404('the issued job');
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 15000 });
});

await step('the customer copy was recorded exactly once, and is pending', async () => {
  await visit('/notifications?tab=outbox');
  const emails = await page.getByText('EJE-1065-Final-Job-Card.pdf').count();
  if (emails !== 1) throw new Error(`the final job card was sent ${emails} times, expected 1`);
  await page.getByText('Delivery pending').first().waitFor({ timeout: 15000 });
});

// ── PART 20: delivery confirmation closes the job ────────────────────────────
await step('confirming the delivery is what closes EJE-1065', async () => {
  const row = page.locator('li').filter({ hasText: 'EJE-1065' }).first();
  await row.getByRole('button', { name: 'Confirm delivered' }).click();
  await page.getByText('Delivered').first().waitFor({ timeout: 20000 });

  await visit('/jobs/EJE-1065');
  await page.getByText('this job is closed', { exact: false }).first().waitFor({ timeout: 20000 });
});

await step('closing did not send the customer a second copy', async () => {
  await visit('/notifications?tab=outbox');
  const emails = await page.getByText('EJE-1065-Final-Job-Card.pdf').count();
  if (emails !== 1) throw new Error(`the final job card was sent ${emails} times, expected 1`);
});

await step('EJE-1065 now appears in the Closed Jobs archive', async () => {
  await visit('/jobs/closed');
  await page.getByLabel('Search the archive').fill('EJE-1065');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1065'),
    { timeout: 20000 },
  );
});

await step('the closed job carries its final job card, with both actions', async () => {
  await page.getByRole('row').filter({ hasText: 'EJE-1065' }).first().click();
  await page.waitForURL('**/jobs/EJE-1065', { timeout: 20000 });
  await page.getByText('Final signed job card').waitFor({ timeout: 15000 });
  await page.getByText('EJE-1065-Final-Job-Card.pdf').first().waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'View Final PDF' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Download Final PDF' }).waitFor({ timeout: 10000 });
});

await step('View Final PDF loads the stored document, not a 404', async () => {
  await page.getByRole('button', { name: 'View Final PDF' }).click();
  await page.waitForURL('**/jobs/EJE-1065/review', { timeout: 20000 });
  await assertNot404('View Final PDF');
  await page.getByText('EJE-1065-Final-Job-Card.pdf').first().waitFor({ timeout: 15000 });
  await page.getByText('Issued and closed').waitFor({ timeout: 10000 });
});

await step('Download Final PDF downloads a real PDF, and never opens a print dialog', async () => {
  await visit('/jobs/EJE-1065');
  await page.getByText('Final signed job card').waitFor({ timeout: 15000 });

  // If the handler called window.print() the browser would raise a print
  // dialog, which Playwright cannot dismiss — so it is recorded and asserted
  // against instead of being stubbed away.
  await page.evaluate(() => {
    window.__ejePrintCalls = 0;
    const original = window.print;
    window.print = () => {
      window.__ejePrintCalls += 1;
      return original === undefined ? undefined : undefined;
    };
  });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.getByRole('button', { name: 'Download Final PDF' }).click(),
  ]);

  // The exact name stored on the job's FinalDocument.
  if (download.suggestedFilename() !== 'EJE-1065-Final-Job-Card.pdf') {
    throw new Error(`downloaded as ${download.suggestedFilename()}`);
  }

  const path = await download.path();
  if (path === null) throw new Error('the download produced no file');
  const bytes = readFileSync(path);
  const head = bytes.subarray(0, 5).toString('latin1');
  if (head !== '%PDF-') throw new Error(`the downloaded file starts with ${JSON.stringify(head)}`);
  if (!bytes.subarray(-32).toString('latin1').includes('%%EOF')) {
    throw new Error('the downloaded PDF has no EOF marker');
  }
  if (bytes.length < 1000) throw new Error(`the downloaded PDF is only ${bytes.length} bytes`);
  // Not an HTML page wearing a .pdf name.
  const text = bytes.toString('latin1');
  if (text.includes('<html') || text.includes('<!DOCTYPE')) {
    throw new Error('the download is HTML, not a PDF');
  }
  // The company name comes from the system settings, as it does on screen.
  if (!text.includes('EJE-1065') || !text.includes('EJE Industrial Electronics')) {
    throw new Error('the downloaded PDF does not carry this job card');
  }
  // A signature captured in the application is drawn as its own geometry, so
  // the document carries stroke operators rather than a typeset name.
  const strokes = [...text.matchAll(/[\d.-]+ [\d.-]+ l/g)].length;
  if (strokes < 2) {
    throw new Error(`the downloaded PDF carries no drawn signature (${strokes} segments)`);
  }
  if (text.includes('/Times-Italic')) {
    throw new Error('a captured signature was rendered as text instead of its geometry');
  }

  const printCalls = await page.evaluate(() => window.__ejePrintCalls);
  if (printCalls !== 0) throw new Error(`Download called window.print() ${printCalls} time(s)`);

  downloadedBytes = bytes;
});

await step('downloading again returns the identical file, not a new one', async () => {
  const [again] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.getByRole('button', { name: 'Download Final PDF' }).click(),
  ]);
  const path = await again.path();
  const bytes = readFileSync(path);

  if (again.suggestedFilename() !== 'EJE-1065-Final-Job-Card.pdf') {
    throw new Error(`the second download was named ${again.suggestedFilename()}`);
  }
  if (!bytes.equals(downloadedBytes)) {
    throw new Error('a second download produced different bytes');
  }
});

await step('a rate change does not alter the downloaded document', async () => {
  await visit('/admin');
  await page.getByRole('tab', { name: 'Rates & VAT' }).click();
  const normal = page.getByLabel('Normal Time');
  await normal.waitFor({ timeout: 15000 });
  await normal.fill('2500.00');
  await page.getByRole('button', { name: 'Save rates' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Update rates' }).click();
  await page.getByText('Saved', { exact: true }).first().waitFor({ timeout: 15000 });

  await visit('/jobs/EJE-1065');
  await page.getByText('Final signed job card').waitFor({ timeout: 15000 });
  const [after] = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.getByRole('button', { name: 'Download Final PDF' }).click(),
  ]);
  const bytes = readFileSync(await after.path());
  if (!bytes.equals(downloadedBytes)) {
    throw new Error('a rate change altered the issued document');
  }

  // Put the demo rates back.
  await visit('/admin');
  await page.getByRole('tab', { name: 'Rates & VAT' }).click();
  await page.getByLabel('Normal Time').fill('950.00');
  await page.getByRole('button', { name: 'Save rates' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Update rates' }).click();
  await page.getByText('Saved', { exact: true }).first().waitFor({ timeout: 15000 });
});

await step('downloading did not email the customer again', async () => {
  await visit('/notifications?tab=outbox');
  const emails = await page.getByText('EJE-1065-Final-Job-Card.pdf').count();
  if (emails !== 1) {
    throw new Error(`the final job card has been emailed ${emails} times, expected 1`);
  }
});

await step('the closed job is read-only, and its signature survived', async () => {
  await visit('/jobs/EJE-1065');
  await page.getByText('this job is closed', { exact: false }).first().waitFor({ timeout: 15000 });
  const body = await page.locator('main').innerText();
  if (!body.includes('Gerhard')) throw new Error('the signature was lost on closure');
});

await step('viewing the closed job card twice does not duplicate the document event', async () => {
  await visit('/jobs/EJE-1065');
  await page.getByRole('tab', { name: /Activity/ }).click();
  await page.getByText('Activity', { exact: false }).first().waitFor({ timeout: 10000 });
  const before = await page.getByText('document generated', { exact: false }).count();

  await visit('/jobs/EJE-1065/review');
  await page.getByText('Issued and closed').waitFor({ timeout: 15000 });
  await visit('/jobs/EJE-1065');
  await page.getByRole('tab', { name: /Activity/ }).click();
  await page.getByText('Activity', { exact: false }).first().waitFor({ timeout: 10000 });
  const after = await page.getByText('document generated', { exact: false }).count();

  if (after !== before) {
    throw new Error(`viewing a closed job card regenerated its document (${before} -> ${after})`);
  }
});

await step('the two-way chat is still intact', async () => {
  await visit('/messages');
  await page.getByRole('heading', { name: 'Messages', exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'New message' }).waitFor({ timeout: 10000 });
});

/*
 * ── PART 21: CUSTOMER REFUSED TO SIGN ────────────────────────────────────────
 *
 * The workflow VPS acceptance testing broke on, walked in a browser rather
 * than only asserted in the application tests. All three defects it found show
 * up here or not at all:
 *
 *  - the technician kept actions on a job card they had handed over;
 *  - Customer Signature asked the state machine to move a job to the state it
 *    was already in;
 *  - Without Customer Signature recorded the outcome and left the job showing
 *    Review, Closed and a Capture Signature button.
 */

/** Drives an open job to the point where the customer refuses to sign. */
const refuseOnSite = async (jobNumber, reason) => {
  await visit(`/jobs/${jobNumber}`);
  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByRole('button', { name: 'No, Thanks' }).click({ timeout: 20000 });

  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Step 1 of', { exact: false }).waitFor({ timeout: 20000 });
  await page
    .getByLabel(/Work performed/)
    .fill('Replaced the contactor and proved the circuit under load.');
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });

  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Normal Time').first().waitFor({ timeout: 15000 });

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ready for the customer').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of', { exact: false }).waitFor({ timeout: 20000 });

  // The two outcomes of the signature step are ONE choice, so refusing is a
  // tick rather than a second button: ticking it puts the pad away and asks
  // for a reason instead.
  await page.getByRole('checkbox').last().check();
  await page.getByLabel('Customer refusal reason').fill(reason);
  await page.getByRole('button', { name: 'Record refusal' }).click();
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 25000 });
};

await step('a technician records a customer refusal on EJE-1048', async () => {
  await signInAs('Technician', 'Sipho Mahlangu', /Hello, Sipho/);
  await refuseOnSite('EJE-1048', 'The planner disputes the hours and will not sign for them.');
});

await step('the technician is READ-ONLY on it from that moment', async () => {
  await visit('/jobs/EJE-1048');
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 20000 });

  // The reason IS theirs to see. Everything that acts on it is not.
  const body = await page.locator('main').innerText();
  if (!body.includes('disputes the hours')) {
    throw new Error('the technician cannot see the refusal they recorded');
  }
  if (!/Read-only/i.test(body)) {
    throw new Error('the job does not tell the technician it is read-only');
  }

  for (const name of [
    'Capture signature',
    'Correct & resubmit',
    'Customer Signature',
    'Without Customer Signature',
    'Submit job card',
    'Review & submit job card',
  ]) {
    const count = await page.getByRole('button', { name, exact: true }).count();
    if (count !== 0) {
      throw new Error(`the technician was offered "${name}" on a refused job card`);
    }
  }
});

await step('the office is notified, and the Coordinator can open it', async () => {
  await signInAs('Coordinator', 'Christene van Niekerk', /Christene/);
  await visit('/notifications');
  await page
    .getByText('EJE-1048 — customer refused to sign', { exact: false })
    .first()
    .waitFor({ timeout: 20000 });

  await visit('/jobs/EJE-1048');
  const body = await page.locator('main').innerText();
  if (!body.includes('Customer Signature') || !body.includes('Without Customer Signature')) {
    throw new Error('the Coordinator is not offered both refusal outcomes');
  }
});

await step('OUTCOME A — Customer Signature returns EJE-1048 to the signature step', async () => {
  await page.getByRole('button', { name: 'Customer Signature', exact: true }).click();
  // The bug this replaces: "EJE-1048 cannot move from customer_signature to
  // customer_signature". review -> customer_signature is a real transition.
  await page.getByText('Customer Signature').first().waitFor({ timeout: 25000 });
  await visit('/jobs/EJE-1048');
  const body = await page.locator('main').innerText();
  if (/could not be resolved|cannot move from/i.test(body)) {
    throw new Error(`the resolution was refused: ${body.slice(0, 400)}`);
  }
  if (!body.includes('Corrected and returned for signature')) {
    throw new Error('the refusal does not record the outcome that was chosen');
  }
});

await step('and the technician takes the signature again, then submits it', async () => {
  await signInAs('Technician', 'Sipho Mahlangu', /Hello, Sipho/);
  await visit('/jobs/EJE-1048');
  await page.getByRole('button', { name: 'Capture signature' }).click();

  /*
   * FROM HERE IT IS THE NORMAL JOURNEY. MASTER SCOPE CR-07.
   *
   * The office resolved the refusal and handed the card back; once the
   * customer signs it, the technician submits it themselves exactly as they
   * would have the first time. The office's part is finished.
   */
  await page.getByText('Step 1 of 4', { exact: false }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ready for the customer').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of', { exact: false }).waitFor({ timeout: 20000 });

  await page.getByLabel('Customer name').fill('Gerhard');
  await page.getByLabel('Customer surname').fill('Smit');
  await drawSignature();
  await page.getByRole('button', { name: 'Confirm signature' }).click();
  await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 30000 });

  /*
   * LEFT THE WIZARD, AND STILL ABLE TO SUBMIT.
   *
   * The other half of CR-07's routing: the submission is offered in the
   * close-out AND on the job, through the same dialog, so a technician who
   * walked away from the tablet mid-sequence is not stranded and is not sent
   * to an office review page to finish. The main journey above submits from
   * inside the wizard; this one submits from the job screen.
   */
  await page.getByRole('button', { name: 'Leave the wizard' }).click();
  await page.getByRole('button', { name: 'Submit job card' }).waitFor({ timeout: 20000 });

  const stranded = await page.locator('main').innerText();
  for (const gone of ['With the office for submission', 'A Master makes the final submission']) {
    if (stranded.includes(gone)) {
      throw new Error(`the superseded office-review wording is still on screen: "${gone}"`);
    }
  }

  await page.getByRole('button', { name: 'Submit job card' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Submit job card' }).click();
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 30000 });
});

await step('OUTCOME B — Without Customer Signature CLOSES EJE-1066', async () => {
  await refuseOnSite('EJE-1066', 'The customer will not sign anything without head office.');

  await signInAs('Coordinator', 'Christene van Niekerk', /Christene/);
  await visit('/jobs/EJE-1066');
  await page.getByRole('button', { name: 'Without Customer Signature', exact: true }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Close without a signature' }).click();

  // Closed, said on the job screen itself — the document card names the
  // outcome rather than calling an unsigned job card "signed".
  await page
    .getByText('Issued without a customer signature', { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
});

await step('and nothing about EJE-1066 offers a signature step afterwards', async () => {
  await visit('/jobs/EJE-1066');
  const body = await page.locator('main').innerText();

  if (!/Read-only — this job is closed/i.test(body)) {
    throw new Error(`EJE-1066 is not closed after Without Customer Signature: ${body.slice(0, 400)}`);
  }
  if (!body.includes('Issued without a signature')) {
    throw new Error('the refusal does not record the outcome that was chosen');
  }

  for (const name of [
    'Capture signature',
    'Correct & resubmit',
    'Customer Signature',
    'Without Customer Signature',
    'Submit job card',
    'Review & submit job card',
  ]) {
    if ((await page.getByRole('button', { name, exact: true }).count()) !== 0) {
      throw new Error(`a closed, unsigned job card still offers "${name}"`);
    }
  }

  // And not for a Master either — closed is closed for the whole office.
  await signInAs('Master', 'Elmarie Coetzee', /Good day, Elmarie/);
  await visit('/jobs/EJE-1066');
  for (const name of ['Capture signature', 'Submit job card', 'Review & submit job card']) {
    if ((await page.getByRole('button', { name, exact: true }).count()) !== 0) {
      throw new Error(`a Master is still offered "${name}" on a closed job`);
    }
  }
});

/*
 * ── PART 22: THE EXCEPTIONAL TAKEOVER ────────────────────────────────────────
 *
 * Master Scope CR-08, resolving BD-09. CR-07 made the submission the
 * technician's, which left a signed job card whose technician then went on
 * leave with nobody able to send the customer their copy. The office may
 * rescue exactly that, and only that.
 *
 * The negative half is asserted throughout Part 19 — on an ordinary signed job
 * neither the Master nor the Coordinator is offered anything. This is the
 * positive half, driven the way the office would actually do it: put the
 * absence on the calendar, then take the submission over.
 */
await step('a technician signs EJE-1058 and leaves it unsubmitted', async () => {
  await signInAs('Technician', 'Lerato Dlamini', /Hello, Lerato/);
  await visit('/jobs/EJE-1058');

  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByRole('button', { name: 'No, Thanks' }).click({ timeout: 20000 });

  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Step 1 of', { exact: false }).waitFor({ timeout: 20000 });
  await page.getByLabel(/Work performed/).fill('Replaced the drive belt and re-tensioned it.');
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });

  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Normal Time').first().waitFor({ timeout: 15000 });

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ready for the customer').waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of', { exact: false }).waitFor({ timeout: 20000 });

  await page.getByLabel('Customer name').fill('Annelie');
  await page.getByLabel('Customer surname').fill('Botha');
  await drawSignature();
  await page.getByRole('button', { name: 'Confirm signature' }).click();
  await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 30000 });

  // Walks away without submitting — which is the whole premise.
  await page.getByRole('button', { name: 'Leave the wizard' }).click();
  await page.getByRole('button', { name: 'Submit job card' }).waitFor({ timeout: 20000 });
});

await step('while that technician is at work, the office is offered NO takeover', async () => {
  for (const [label, who, greeting] of [
    ['Coordinator', 'Christene van Niekerk', /Christene/],
    ['Master', 'Elmarie Coetzee', /Good day, Elmarie/],
  ]) {
    await signInAs(label, who, greeting);
    await visit('/jobs/EJE-1058');
    await page.getByRole('button', { name: 'View job card' }).waitFor({ timeout: 20000 });
    for (const name of ['Take over submission', 'Submit job card', 'Review & submit job card']) {
      if ((await page.getByRole('button', { name, exact: true }).count()) !== 0) {
        throw new Error(`${who} was offered "${name}" while the technician is available`);
      }
    }
  }
});

await step('the office records that the technician is away all day', async () => {
  await visit('/technicians/user-tech-lerato');
  await page.getByRole('button', { name: 'Mark unavailable' }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });

  const now = new Date();
  const today = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, '0')}-${`${now.getDate()}`.padStart(2, '0')}`;
  await dialog.getByLabel('Start date').fill(today);
  await dialog.getByLabel('End date').fill(today);
  /*
   * ALL DAY, and that is the rule rather than a convenience. CR-08 unlocks a
   * takeover on a WHOLE-day absence only: a part-day window means the
   * technician is at work either side of it and will submit the job
   * themselves. Ticking this is what makes the difference on screen.
   */
  await dialog.getByText('All day', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Record availability' }).click();
  await page.getByText('Availability recorded', { exact: false }).first().waitFor({
    timeout: 15000,
  });
});

await step('NOW the office may take over — and it says the card cannot be edited', async () => {
  await visit('/jobs/EJE-1058');
  await page.getByRole('button', { name: 'Take over submission' }).waitFor({ timeout: 20000 });

  // Never dressed up as an ordinary submission.
  for (const name of ['Submit job card', 'Review & submit job card']) {
    if ((await page.getByRole('button', { name, exact: true }).count()) !== 0) {
      throw new Error(`the takeover was presented as "${name}"`);
    }
  }

  await page.getByRole('button', { name: 'Take over submission' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });

  const explanation = await dialog.innerText();
  if (!/nothing can be changed/i.test(explanation)) {
    throw new Error('the takeover does not say the signed job card is final');
  }
  if (!/lerato/i.test(explanation)) {
    throw new Error('the takeover does not name whose job it is');
  }

  await dialog.getByRole('button', { name: 'Take over submission' }).click();
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 30000 });
});

await step('the takeover is on the trail, distinct from an ordinary submission', async () => {
  await visit('/jobs/EJE-1058');
  await page.getByRole('tab', { name: /Activity/ }).click();
  const trail = await page.locator('main').innerText();
  if (!/took over/i.test(trail)) {
    throw new Error('the activity trail does not record the takeover');
  }
  if (!/Elmarie/.test(trail)) {
    throw new Error('the activity trail does not name who took over');
  }
});

await step('a technician is never offered a takeover', async () => {
  await signInAs('Technician', 'Lerato Dlamini', /Hello, Lerato/);
  await visit('/jobs/EJE-1058');
  if ((await page.getByRole('button', { name: 'Take over submission' }).count()) !== 0) {
    throw new Error('a technician was offered a takeover');
  }
});

await browser.close();

console.log('\n=== WORKFLOW E2E SUMMARY ===');
const realErrors = pageErrors.filter((text) => !text.includes('Failed to load resource'));
if (failures.length > 0) {
  console.log(`${failures.length} step(s) FAILED:`);
  failures.forEach((failure) => console.log(` - ${failure}`));
  process.exitCode = 1;
} else if (realErrors.length > 0) {
  console.log(`All steps passed, but ${realErrors.length} console error(s) were logged:`);
  realErrors.forEach((text) => console.log(` - ${text}`));
  process.exitCode = 1;
} else {
  console.log('COMPLETE WORKFLOW PASSED end to end, with no 404 and no console errors');
}
