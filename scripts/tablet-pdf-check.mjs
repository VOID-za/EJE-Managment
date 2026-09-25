/**
 * The signed job card, on a browser with no built-in PDF viewer.
 *
 * WHY THIS EXISTS. The Signed step showed the document in an `<iframe>` holding
 * a `blob:` PDF, which needs the browser to have a PDF viewer of its own.
 * Chrome on Android — what the EJE tablets run — has never had one. It does not
 * fail quietly: it paints its own "couldn't display" block with an Open button,
 * and that button cannot act on a blob URL, so it does nothing. The technician
 * reached the last step of the job and was shown an error instead of the
 * customer's document.
 *
 * WHAT THIS PROVES. The same journey, run twice against the real application:
 *
 *   TABLET  — `navigator.pdfViewerEnabled` forced false before any script runs,
 *             which is what Chrome on Android reports. The document must be
 *             drawn in the page, at A4 proportions, with no iframe and no dead
 *             Open button.
 *   DESKTOP — untouched, so the browser keeps its viewer. The iframe must still
 *             be there, still at A4 proportions. PDF-4: no regression.
 *
 * The override is the browser's own capability signal, set the only way a real
 * device sets it — before the page loads. Nothing in the application is stubbed.
 *
 * Usage:
 *   npm run start                # or npm run dev
 *   npm run tablet-pdf-check
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';

const BASE = process.env.EJE_TABLET_URL ?? process.env.EJE_E2E_URL ?? 'http://localhost:3000';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;

/** A4's own ratio, which the frame must keep whichever viewer is used. */
const A4_RATIO = 841.89 / 595.28;

const failures = [];
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push(`${name} :: ${error.message.split('\n')[0]}`);
    console.log(`FAIL  ${name} :: ${error.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });

const drawSignature = async (page) => {
  const pad = page.locator('div.touch-none').first();
  await pad.waitFor({ timeout: 20000 });
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 90);
  await page.mouse.down();
  for (let i = 0; i < 24; i += 1) {
    await page.mouse.move(box.x + 40 + i * 9, box.y + 90 - Math.sin(i / 3) * 26);
  }
  await page.mouse.up();
  await page.waitForTimeout(350);
};

/**
 * Drives one job from In Progress to the Signed step and returns the page.
 *
 * EJE-1061 is a breakdown, so there is no checklist and no collection step:
 * write-up, review, signature, signed.
 */
const reachSignedStep = async (context) => {
  const page = await context.newPage();
  await resetDemonstration(page, BASE);
  await signInAs(page, 'Riaan van Wyk', { base: BASE, greeting: /Riaan/ });

  await page.goto(`${BASE}/jobs/EJE-1061`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Completion' }).click();
  await page
    .getByLabel(/Work performed/)
    .fill('Replaced the contactor, meggered the motor and ran the machine under load.');
  await page.getByText(/^Saved /).first().waitFor({ timeout: 25000 });

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Step 1 of', { exact: false }).waitFor({ timeout: 25000 });

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ready for the customer').waitFor({ timeout: 25000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of', { exact: false }).waitFor({ timeout: 25000 });

  await page.getByLabel('Customer name').fill('Marlene');
  await page.getByLabel('Customer surname').fill('du Toit');
  await drawSignature(page);
  await page.getByRole('button', { name: 'Confirm signature' }).click();
  await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 40000 });
  return page;
};

/** The A4 box the document is shown in, whichever element fills it. */
const frameRatio = async (locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the document frame has no box');
  return { ratio: box.height / box.width, box };
};

/* -------------------------------------------------------------------------- */
/* TABLET — a browser with no PDF viewer of its own                           */
/* -------------------------------------------------------------------------- */

const tablet = await browser.newContext({
  viewport: { width: 820, height: 1180 },
  hasTouch: true,
  acceptDownloads: true,
});
// Exactly what Chrome on Android reports, set before any application code runs.
await tablet.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', {
    get: () => false,
    configurable: true,
  });
});

const tabletPage = await reachSignedStep(tablet);

await step('TABLET: the browser reports no inline PDF viewer', async () => {
  const enabled = await tabletPage.evaluate(() => navigator.pdfViewerEnabled);
  if (enabled !== false) throw new Error(`navigator.pdfViewerEnabled is ${String(enabled)}`);
});

await step('TABLET: the Signed step shows the document, not a PDF error block', async () => {
  const signed = tabletPage.getByText('Signed', { exact: true }).first();
  await signed.waitFor({ timeout: 20000 });
  // The document itself: the job number and the company, drawn in the page.
  await tabletPage.getByText('EJE-1061').first().waitFor({ timeout: 20000 });
  const body = await tabletPage.locator('main').innerText();
  for (const fragment of ['EJE Industrial Electronics', 'Marlene', 'du Toit']) {
    if (!body.includes(fragment)) {
      throw new Error(`the signed document does not show ${fragment}`);
    }
  }
});

await step('TABLET: no PDF iframe is handed to a browser that cannot render one', async () => {
  const frames = await tabletPage.locator('iframe[title*="job card preview"]').count();
  if (frames !== 0) throw new Error(`${frames} PDF iframe(s) on a browser with no viewer`);
});

await step('TABLET: the frame keeps A4 proportions', async () => {
  const { ratio, box } = await frameRatio(
    tabletPage.locator('div.aspect-\\[595\\.28\\/841\\.89\\]').first(),
  );
  if (Math.abs(ratio - A4_RATIO) > 0.02) {
    throw new Error(`frame is ${box.width}×${box.height} (ratio ${ratio.toFixed(4)}), not A4`);
  }
  console.log(`      frame ${box.width.toFixed(2)} × ${box.height.toFixed(2)} px, ratio ${ratio.toFixed(4)}`);
});

await step('TABLET: there is no dead "Open" action, because there is nothing to be dead', async () => {
  /*
   * WHERE THE DEAD BUTTON CAME FROM.
   *
   * It was never ours. A browser with no PDF viewer paints its own "couldn't
   * display this PDF / Open" block INSIDE the iframe's own document, which is
   * why nothing in the application could disable it and why its Open did
   * nothing: a `blob:` URL exists only inside the page that made it and cannot
   * be handed to another application.
   *
   * So the assertion is that no such embedded viewer is handed to this browser
   * at all — no iframe, no embed, no object — which is what removes the block
   * and its button together. What replaces it is the document itself, and the
   * one action offered with it is Download, which is exercised below and
   * really downloads.
   */
  for (const tag of ['iframe', 'embed', 'object']) {
    const count = await tabletPage.locator(`main ${tag}`).count();
    if (count !== 0) {
      throw new Error(`${count} <${tag}> on the Signed step of a browser with no PDF viewer`);
    }
  }

  // And the frame itself holds a document, not controls that might not work.
  const controls = await tabletPage
    .locator('div.aspect-\\[595\\.28\\/841\\.89\\] button')
    .count();
  if (controls !== 0) throw new Error(`${controls} button(s) inside the document frame`);
});

await step('TABLET: the PDF itself is still offered, and downloads', async () => {
  const download = tabletPage.getByRole('button', { name: 'Download preview' });
  await download.waitFor({ timeout: 10000 });
  const started = tabletPage.waitForEvent('download', { timeout: 20000 });
  await download.click();
  const file = await started;
  const name = file.suggestedFilename();
  if (!name.endsWith('.pdf')) throw new Error(`downloaded ${name}, which is not a PDF`);
  console.log(`      downloaded ${name}`);
});

await tablet.close();

/* -------------------------------------------------------------------------- */
/* DESKTOP — the viewer is there, and nothing about it changed                */
/* -------------------------------------------------------------------------- */

const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const desktopPage = await reachSignedStep(desktop);

await step('DESKTOP: the browser has its own PDF viewer', async () => {
  const enabled = await desktopPage.evaluate(() => navigator.pdfViewerEnabled);
  if (enabled !== true) throw new Error(`navigator.pdfViewerEnabled is ${String(enabled)}`);
});

await step('DESKTOP: the signed PDF is still shown in the frame, at A4', async () => {
  const frame = desktopPage.locator('iframe[title*="job card preview"]').first();
  await frame.waitFor({ timeout: 25000 });
  const { ratio, box } = await frameRatio(frame);
  if (Math.abs(ratio - A4_RATIO) > 0.02) {
    throw new Error(`frame is ${box.width}×${box.height} (ratio ${ratio.toFixed(4)}), not A4`);
  }
  console.log(`      frame ${box.width.toFixed(2)} × ${box.height.toFixed(2)} px, ratio ${ratio.toFixed(4)}`);
});

await desktop.close();
await browser.close();

console.log('\n=== SUMMARY ===');
if (failures.length === 0) {
  console.log('THE SIGNED DOCUMENT RENDERS ON BOTH, with no dead action');
  process.exit(0);
}
for (const failure of failures) console.log(` - ${failure}`);
process.exit(1);
