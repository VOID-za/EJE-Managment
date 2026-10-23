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
 *   DESKTOP — the same signal forced true, which is what a desktop browser
 *             with its viewer available reports. The iframe must still be
 *             there, still at A4 proportions. PDF-4: no regression.
 *
 * BOTH SIDES SET THE SIGNAL, and neither is left to the binary. Playwright
 * launches `chrome-headless-shell` by default, and that build reports
 * `pdfViewerEnabled === false` — the same answer an Android tablet gives — so
 * a DESKTOP case that merely left the browser alone was testing whichever
 * Chromium the runner happened to install rather than the capability it names.
 * The override is the browser's own capability signal, set the only way a real
 * device sets it — before the page loads. Nothing in the application is stubbed.
 *
 * Usage:
 *   npm run start                # or npm run dev
 *   npm run tablet-pdf-check
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs, signOut } from './sign-in.mjs';

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
  const frames = await tabletPage.locator('[data-preview-kind="pdf-viewer"]').count();
  if (frames !== 0) throw new Error(`${frames} PDF iframe(s) on a browser with no viewer`);
  const drawn = await tabletPage.getByTestId('job-card-preview').getAttribute('data-preview-kind');
  if (drawn !== 'document') throw new Error(`the preview drew "${drawn}", not the document`);
});

await step('TABLET: the frame keeps A4 proportions', async () => {
  const { ratio, box } = await frameRatio(tabletPage.getByTestId('job-card-preview'));
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
  const controls = await tabletPage.getByTestId('job-card-preview').locator('button').count();
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
/*
 * What a desktop browser with its viewer available reports — stated, not
 * inherited. `chrome-headless-shell`, which Playwright launches by default and
 * which CI installs, has no PDF viewer and answers false; leaving this context
 * untouched therefore tested the runner's choice of binary instead of the
 * desktop case, and failed on a build where the application was behaving
 * correctly. Set the same way the tablet case sets its own answer.
 */
await desktop.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', {
    get: () => true,
    configurable: true,
  });
});
const desktopPage = await reachSignedStep(desktop);

await step('DESKTOP: the browser has its own PDF viewer', async () => {
  const enabled = await desktopPage.evaluate(() => navigator.pdfViewerEnabled);
  if (enabled !== true) throw new Error(`navigator.pdfViewerEnabled is ${String(enabled)}`);
});

await step('DESKTOP: the signed PDF is still shown in the frame, at A4', async () => {
  const frame = desktopPage.locator('iframe[title*="job card preview"]').first();
  await frame.waitFor({ timeout: 25000 });
  const drawn = await desktopPage.getByTestId('job-card-preview').getAttribute('data-preview-kind');
  if (drawn !== 'pdf-viewer') throw new Error(`the preview drew "${drawn}", not the PDF frame`);
  const { ratio, box } = await frameRatio(frame);
  if (Math.abs(ratio - A4_RATIO) > 0.02) {
    throw new Error(`frame is ${box.width}×${box.height} (ratio ${ratio.toFixed(4)}), not A4`);
  }
  console.log(`      frame ${box.width.toFixed(2)} × ${box.height.toFixed(2)} px, ratio ${ratio.toFixed(4)}`);
});

/* -------------------------------------------------------------------------- */
/* THE TECHNICAL LIBRARY'S PREVIEW — the REAL stored PDF. MASTER SCOPE LIB-5. */
/* -------------------------------------------------------------------------- */

/*
 * WHAT THIS PROVES, AND WHY IT IS HERE RATHER THAN IN THE SMOKE SUITE.
 *
 * The library's preview used to be a facsimile: a white box with the title and
 * nine grey bars. It now fetches the revision's own bytes through the
 * authorised route and hands them to the browser's viewer — so the claim to
 * test is "the bytes on screen are the bytes the server stored", and that can
 * only be shown on BOTH capabilities, which is what this script already has
 * contexts for.
 *
 *   DESKTOP — the frame is a real `blob:` of the stored file. The test reads it
 *             back from inside the page and compares the PDF header and the
 *             exact byte length with what it uploaded.
 *   TABLET  — no viewer, so NO FRAME and NO FACSIMILE: the panel says the
 *             browser cannot display a PDF and offers the download. The byte
 *             length is still asserted, because the bytes were fetched and
 *             checked before the panel was drawn.
 */

/**
 * A small, real, text-based PDF, built here so the bytes are known exactly.
 *
 * A REAL ONE, which this did not used to be: it had no cross-reference table
 * and no font RESOURCE for the `/F1` its content stream selected. The built-in
 * byte reader did not care — it scans for streams and pulls the text operators
 * out — so this passed while uploading a file no PDF viewer would render.
 * Since LIB-TEXT-1 made `pdftotext` the primary engine the fixture has to be a
 * document, and that is a better check rather than a concession: what is
 * asserted now is that the real engine reads a real file, and the bytes are
 * still known exactly, which is what the byte-for-byte comparison needs.
 */
const libraryPdf = (text) => {
  const content = `BT /F1 11 Tf 40 800 Td (${text}) Tj ET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, offset) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${offset + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startxref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return body;
};

/** Uploads a document through the real route, from inside the page. */
const uploadDocument = async (page, { name, text }) =>
  page.evaluate(
    async ([base, documentName, source]) => {
      const file = new File([source], 'library-preview.pdf', { type: 'application/pdf' });
      const form = new FormData();
      form.append('file', file);
      form.append('name', documentName);
      form.append('description', 'Uploaded by the PDF path check.');
      form.append('documentType', 'service_manual');
      form.append('manufacturer', 'Siemens');
      form.append('machineModel', '840D');
      form.append('version', '1.0');
      form.append('tags', 'alarms');
      const response = await fetch(`${base}/api/library/upload`, { method: 'POST', body: form });
      const payload = await response.json();
      return {
        status: response.status,
        id: payload?.data?.document?.id ?? null,
        indexState: payload?.data?.index?.state ?? null,
        bytes: source.length,
      };
    },
    [BASE, name, libraryPdf(text)],
  );

const openLibraryDocument = async (page, name) => {
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
  const card = page.locator('section', { hasText: name }).first();
  await card.waitFor({ timeout: 20000 });
  await card.getByRole('button', { name: 'Open' }).click();
  const preview = page.getByTestId('library-pdf-preview');
  await preview.waitFor({ timeout: 25000 });
  return preview;
};

let uploaded = null;

await step('DESKTOP: the library preview shows the stored PDF, byte for byte', async () => {
  await signOut(desktopPage);
  await signInAs(desktopPage, 'Elmarie Coetzee', { base: BASE, greeting: /Elmarie/ });

  uploaded = await uploadDocument(desktopPage, {
    name: 'Preview proof manual',
    text: 'Alarm 300500 is a drive enable fault. Check terminal 64 before the module.',
  });
  if (uploaded.status !== 200) throw new Error(`the upload answered HTTP ${uploaded.status}`);
  if (uploaded.indexState !== 'indexed') {
    throw new Error(`the uploaded PDF indexed as "${uploaded.indexState}"`);
  }

  const preview = await openLibraryDocument(desktopPage, 'Preview proof manual');
  if ((await preview.getAttribute('data-preview-revision')) !== uploaded.id) {
    throw new Error('the preview is not showing the revision that was opened');
  }
  if ((await preview.getAttribute('data-preview-kind')) !== 'pdf-viewer') {
    throw new Error('a browser with a PDF viewer was not given the frame');
  }

  const frame = desktopPage.getByTestId('library-pdf-frame');
  await frame.waitFor({ timeout: 20000 });
  const src = await frame.getAttribute('src');
  if (src === null || !src.startsWith('blob:')) {
    throw new Error(`the frame's source is "${src}", not a blob of the stored file`);
  }

  /*
   * THE BYTES, READ BACK FROM THE BLOB THE FRAME IS RENDERING.
   *
   * This is the assertion a facsimile could never pass: the header and the
   * exact length of the file that was uploaded a moment ago.
   */
  const actual = await desktopPage.evaluate(async (url) => {
    const response = await fetch(url);
    const buffer = new Uint8Array(await response.arrayBuffer());
    return {
      head: new TextDecoder().decode(buffer.subarray(0, 5)),
      length: buffer.byteLength,
      type: response.headers.get('content-type'),
    };
  }, src);

  if (actual.head !== '%PDF-') throw new Error(`the frame is rendering "${actual.head}", not a PDF`);
  if (actual.length !== uploaded.bytes) {
    throw new Error(`the frame holds ${actual.length} bytes; ${uploaded.bytes} were uploaded`);
  }
  if (actual.type !== 'application/pdf') {
    throw new Error(`the blob's type is ${actual.type}`);
  }
  console.log(`      ${actual.length} bytes of real PDF in the frame`);

  // And no facsimile anywhere: the old preview's caption is gone for good.
  const body = await desktopPage.locator('[role="dialog"]').innerText();
  if (/preview is simulated/i.test(body)) {
    throw new Error('the simulated-preview caption is still on screen');
  }
});

await step('DESKTOP: a technician cannot fetch a pending revision through the browser', async () => {
  // A technician's own upload lands pending; another technician must not get
  // the bytes, and the refusal is a 404 rather than a 403.
  //
  // Off the library screen first: the preview is a MODAL, and its overlay
  // covers the profile menu the sign-out goes through — which is what made
  // this step time out on a click rather than on anything it was testing.
  await desktopPage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut(desktopPage);
  await signInAs(desktopPage, 'Sipho Mahlangu', { base: BASE, greeting: /Sipho/ });
  const pending = await uploadDocument(desktopPage, {
    name: 'Pending preview manual',
    text: 'The hoist brake is adjusted through the castellated nut behind the cover.',
  });
  if (pending.status !== 200) throw new Error(`the upload answered HTTP ${pending.status}`);

  await signOut(desktopPage);
  await signInAs(desktopPage, 'Riaan van Wyk', { base: BASE, greeting: /Riaan/ });
  const refused = await desktopPage.evaluate(
    async ([base, id]) => {
      const response = await fetch(`${base}/api/library/${id}/file`);
      const text = await response.text();
      return { status: response.status, isPdf: text.startsWith('%PDF-') };
    },
    [BASE, pending.id],
  );
  if (refused.status !== 404) {
    throw new Error(`another technician got HTTP ${refused.status} for a pending revision`);
  }
  if (refused.isPdf) throw new Error('the refusal handed over the document anyway');
});

await desktop.close();

/* The same preview on a browser with no viewer: no frame, and no facsimile. */
const tabletLibrary = await browser.newContext({
  viewport: { width: 820, height: 1180 },
  hasTouch: true,
});
await tabletLibrary.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', {
    get: () => false,
    configurable: true,
  });
});
const tabletLibraryPage = await tabletLibrary.newPage();
await signInAs(tabletLibraryPage, 'Elmarie Coetzee', { base: BASE, greeting: /Elmarie/ });

await step('TABLET: the library preview offers the file instead of faking the page', async () => {
  const preview = await openLibraryDocument(tabletLibraryPage, 'Preview proof manual');

  if ((await preview.getAttribute('data-preview-kind')) !== 'download-only') {
    throw new Error('a browser with no PDF viewer was handed a frame');
  }
  if ((await tabletLibraryPage.getByTestId('library-pdf-frame').count()) !== 0) {
    throw new Error('a PDF frame was drawn for a browser that cannot render one');
  }
  await tabletLibraryPage.getByTestId('library-pdf-no-viewer').waitFor({ timeout: 10000 });

  // The bytes were still fetched and checked — the panel is drawn after that.
  const held = Number(await preview.getAttribute('data-preview-bytes'));
  if (held !== uploaded.bytes) {
    throw new Error(`the preview holds ${held} bytes; ${uploaded.bytes} were uploaded`);
  }

  // No embedded viewer of any kind, and no facsimile.
  for (const tag of ['iframe', 'embed', 'object']) {
    const count = await tabletLibraryPage.locator(`[role="dialog"] ${tag}`).count();
    if (count !== 0) throw new Error(`${count} <${tag}> in the preview on a browser with no viewer`);
  }
  const body = await tabletLibraryPage.locator('[role="dialog"]').innerText();
  if (/preview is simulated/i.test(body)) {
    throw new Error('the simulated-preview caption is still on screen');
  }
  if (!/cannot display a PDF inside the page/i.test(body)) {
    throw new Error('the panel does not say why the document is not shown');
  }

  // And the real file is still offered.
  await tabletLibraryPage.getByRole('button', { name: 'Download the document' }).waitFor({
    timeout: 10000,
  });
});

await tabletLibrary.close();
await browser.close();

console.log('\n=== SUMMARY ===');
if (failures.length === 0) {
  console.log('THE SIGNED DOCUMENT AND THE LIBRARY PREVIEW RENDER ON BOTH, with no dead action');
  process.exit(0);
}
for (const failure of failures) console.log(` - ${failure}`);
process.exit(1);
