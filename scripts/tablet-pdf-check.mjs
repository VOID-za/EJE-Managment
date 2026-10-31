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
 * WHAT THIS PROVES (PDF-VIEW-1, 31 October 2026: every preview is now the
 * application's own viewer, `PdfViewer`, which draws the PDF's pages itself).
 * The same journey, run twice against the real application:
 *
 *   TABLET  — `navigator.pdfViewerEnabled` forced false before any script runs,
 *             which is what Chrome on Android reports. The PDF ITSELF must be
 *             drawn in the page — pages with ink on them, at A4 proportions —
 *             with no iframe, no embed and so no dead Open button.
 *   DESKTOP — the same signal forced true. Exactly the same viewer: nothing
 *             about a preview depends on the browser's own PDF plugin.
 *
 * What a page SAYS is read from the PDF the preview's Download hands over —
 * the very bytes the viewer draws — with the same engine, in the page
 * (`pdfTextIn`), because a canvas has no text to read.
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

/** The viewer has opened the document and drawn page `number` with real ink on it. */
const viewerDrew = async (page, testId, number = 1) => {
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-viewer-state') === 'ready',
    testId,
    { timeout: 30000 },
  );
  const viewer = page.getByTestId(testId);
  await viewer.locator(`[data-page="${number}"][data-drawn="yes"]`).waitFor({ timeout: 30000 });
  const ink = await viewer.locator(`[data-page="${number}"] canvas`).evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] < 230) dark += 1;
    return { dark, width: canvas.width, height: canvas.height };
  });
  if (ink.dark < 100) throw new Error(`page ${number} was drawn blank (${ink.dark} dark pixels on ${ink.width}×${ink.height})`);
  return { pages: Number(await viewer.getAttribute('data-pages')), ink };
};

/** The text of a PDF, read with the same engine the viewer draws with, in the page. */
const pdfTextIn = (page, bytes) =>
  page.evaluate(async (base64) => {
    const pdfjs = await import('/vendor/pdfjs-4.10.38/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-4.10.38/pdf.worker.min.mjs';
    const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, standardFontDataUrl: '/vendor/pdfjs-4.10.38/standard_fonts/' }).promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const content = await (await pdf.getPage(number)).getTextContent();
      pages.push(content.items.map((item) => item.str).join(' '));
    }
    const count = pdf.numPages;
    await pdf.destroy();
    return { pages: count, text: pages.join('\n') };
  }, Buffer.from(bytes).toString('base64'));

/** Saves what a Download button hands over. */
const downloadOf = async (page, button) => {
  const started = page.waitForEvent('download', { timeout: 20000 });
  await button.click();
  const file = await started;
  const { readFile } = await import('node:fs/promises');
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
};

/** No embedded browser viewer anywhere in `scope` — no frame for a dead Open button to live in. */
const noEmbeddedViewer = async (page, scope) => {
  for (const tag of ['iframe', 'embed', 'object']) {
    const count = await page.locator(`${scope} ${tag}`).count();
    if (count !== 0) throw new Error(`${count} <${tag}> in ${scope}`);
  }
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

await step('TABLET: the Signed step shows the PDF itself, drawn in the app — not an error block', async () => {
  const signed = tabletPage.getByText('Signed', { exact: true }).first();
  await signed.waitFor({ timeout: 20000 });
  const drawn = await viewerDrew(tabletPage, 'job-card-preview');
  if ((await tabletPage.getByTestId('job-card-preview').getAttribute('data-preview-kind')) !== 'pdf-viewer') {
    throw new Error('the preview is not the PDF viewer');
  }
  console.log(`      ${drawn.pages} page(s); page 1 drawn with ${drawn.ink.dark} dark pixels`);
});

await step('TABLET: no embedded browser viewer, so no dead "Open" action can exist', async () => {
  /*
   * The dead Open button was never ours: a browser with no PDF viewer paints
   * its own "couldn't display this PDF / Open" block INSIDE an iframe holding
   * a `blob:`. No iframe, embed or object is handed to the browser at all now
   * — the pages are canvases drawn by the application — so there is nowhere
   * for that block to appear.
   */
  await noEmbeddedViewer(tabletPage, 'main');
});

await step('TABLET: the page keeps A4 proportions', async () => {
  const { ratio, box } = await frameRatio(tabletPage.getByTestId('job-card-preview').locator('[data-page="1"]'));
  if (Math.abs(ratio - A4_RATIO) > 0.02) {
    throw new Error(`page is ${box.width}×${box.height} (ratio ${ratio.toFixed(4)}), not A4`);
  }
  console.log(`      page ${box.width.toFixed(2)} × ${box.height.toFixed(2)} px, ratio ${ratio.toFixed(4)}`);
});

await step('TABLET: the PDF downloads, and it is the signed job card the viewer drew', async () => {
  const file = await downloadOf(tabletPage, tabletPage.getByRole('button', { name: 'Download preview' }));
  if (!file.name.endsWith('.pdf')) throw new Error(`downloaded ${file.name}, which is not a PDF`);
  const read = await pdfTextIn(tabletPage, file.bytes);
  for (const fragment of ['EJE-1061', 'Marlene', 'du Toit']) {
    if (!read.text.includes(fragment)) throw new Error(`the signed PDF does not say ${fragment}`);
  }
  const shown = Number(await tabletPage.getByTestId('job-card-preview').getAttribute('data-pages'));
  if (shown !== read.pages) throw new Error(`the viewer shows ${shown} page(s); the PDF has ${read.pages}`);
  console.log(`      downloaded ${file.name}: ${read.pages} page(s), the same the viewer shows`);
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

await step('DESKTOP: the SAME in-app viewer draws the signed PDF — no browser plugin frame', async () => {
  const drawn = await viewerDrew(desktopPage, 'job-card-preview');
  await noEmbeddedViewer(desktopPage, 'main');
  const { ratio, box } = await frameRatio(desktopPage.getByTestId('job-card-preview').locator('[data-page="1"]'));
  if (Math.abs(ratio - A4_RATIO) > 0.02) throw new Error(`page is ${box.width}×${box.height}, not A4`);
  console.log(`      ${drawn.pages} page(s), page 1 ${box.width.toFixed(0)} × ${box.height.toFixed(0)} px`);
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

/**
 * A LONG MANUAL, ONE MARKER WORD PER PAGE. LIB-TEXT-1 (#70).
 *
 * The same shape as `src/test/pdf-manual.ts` (which the unit and application
 * suites use), written out here because this script is plain JavaScript run
 * by node against a built server. Page `n` carries the word `pagemark<n>x` and
 * no other page does, so a search for it can only be answered by page `n`.
 */
const longManualPdf = (pages) => {
  const objects = [];
  const kids = [];
  for (let page = 1; page <= pages; page += 1) {
    const pageId = 4 + (page - 1) * 2;
    kids.push(`${pageId} 0 R`);
    const lines = [`BT /F1 9 Tf 11 TL 40 800 Td (Section ${page} pagemark${page}x) Tj`];
    for (let line = 1; line < 45; line += 1) {
      lines.push(`T* (Alarm ${page}-${line}: check the spindle drive parameter P${line} before restart.) Tj`);
    }
    lines.push('ET');
    const stream = lines.join('\n');
    objects[pageId] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  let body = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body, 'latin1');
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const startxref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return body;
};

/** Uploads a document through the real route, from inside the page. */
const uploadDocument = async (page, { name, text, source }) =>
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
    [BASE, name, source ?? libraryPdf(text)],
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
    throw new Error('the library preview is not the PDF viewer');
  }
  // The stored bytes, checked for a PDF header before anything is drawn, then drawn.
  const held = Number(await preview.getAttribute('data-preview-bytes'));
  if (held !== uploaded.bytes) throw new Error(`the preview holds ${held} bytes; ${uploaded.bytes} were uploaded`);
  const drawn = await viewerDrew(desktopPage, 'library-pdf-viewer');
  if (drawn.pages !== 1) throw new Error(`the viewer shows ${drawn.pages} pages of a one-page PDF`);
  await noEmbeddedViewer(desktopPage, '[role="dialog"]');
  console.log(`      ${held} bytes of the stored PDF, drawn`);

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

await step('DESKTOP: a 1 200-page manual is indexed on EVERY page, and a search names page 1 100 (#70)', async () => {
  /*
   * The old whole-document budget stopped an ordinary 214-page manual at page
   * 96. This uploads one five times as long through the real route, with the
   * real `pdftotext`, and then asks the library screen — as a person would —
   * for a word that exists only on page 1 100.
   *
   * As the office: the step before ends signed in as a technician, and a
   * technician's upload is a pending revision, which no search returns.
   */
  await desktopPage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut(desktopPage);
  await signInAs(desktopPage, 'Elmarie Coetzee', { base: BASE, greeting: /Elmarie/ });
  const longUpload = await uploadDocument(desktopPage, {
    name: 'Long manual proof',
    source: longManualPdf(1_200),
  });
  if (longUpload.status !== 200) throw new Error(`the upload answered HTTP ${longUpload.status}`);
  if (longUpload.indexState !== 'indexed') {
    throw new Error(`the 1 200-page manual indexed as "${longUpload.indexState}", not "indexed"`);
  }

  await desktopPage.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
  await desktopPage.locator('#library-search').fill('pagemark1100x');
  const match = desktopPage.getByTestId('library-page-match').filter({ hasText: 'Page 1100' });
  await match.first().waitFor({ timeout: 25000 });
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

await step('TABLET: the library preview DRAWS the stored PDF — where it used to offer only a download', async () => {
  const preview = await openLibraryDocument(tabletLibraryPage, 'Preview proof manual');
  if ((await preview.getAttribute('data-preview-kind')) !== 'pdf-viewer') throw new Error('not the PDF viewer');
  const held = Number(await preview.getAttribute('data-preview-bytes'));
  if (held !== uploaded.bytes) throw new Error(`the preview holds ${held} bytes; ${uploaded.bytes} were uploaded`);
  const drawn = await viewerDrew(tabletLibraryPage, 'library-pdf-viewer');
  if (drawn.pages !== 1) throw new Error(`${drawn.pages} pages shown`);
  await noEmbeddedViewer(tabletLibraryPage, '[role="dialog"]');
  const body = await tabletLibraryPage.locator('[role="dialog"]').innerText();
  if (/preview is simulated/i.test(body)) throw new Error('the simulated-preview caption is still on screen');
  await tabletLibraryPage.keyboard.press('Escape');
});

await step('TABLET: a 1 200-page manual opens at once, and its page 1 100 is reached and drawn', async () => {
  const preview = await openLibraryDocument(tabletLibraryPage, 'Long manual proof');
  const drawn = await viewerDrew(tabletLibraryPage, 'library-pdf-viewer');
  if (drawn.pages !== 1200) throw new Error(`the viewer shows ${drawn.pages} pages`);
  const input = preview.getByTestId('pdf-page-input');
  await input.fill('1100');
  await input.press('Enter');
  await viewerDrew(tabletLibraryPage, 'library-pdf-viewer', 1100);
  const counted = await preview.locator('canvas').evaluateAll((canvases) => canvases.filter((canvas) => canvas.width > 0).length);
  if (counted > 12) throw new Error(`${counted} pages hold pixels at once — far pages are not released`);
  console.log(`      1 200 pages; page 1 100 drawn; ${counted} canvases holding pixels`);
});

await tabletLibrary.close();

/* -------------------------------------------------------------------------- */
/* TABLET — the reviewer's preview (TR-02), print and download, and the        */
/* Delivery Note and Time Sheet (PARTS-03, PDF-01). 29 October 2026.           */
/* -------------------------------------------------------------------------- */

const previews = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true, acceptDownloads: true });
await previews.addInitScript(() => {
  Object.defineProperty(Navigator.prototype, 'pdfViewerEnabled', { get: () => false, configurable: true });
  // The print dialog cannot be driven by a test: count the calls instead, and
  // note whether ONLY the document was on the page when it was asked for.
  window.__printCalls = [];
  window.print = () => {
    window.__printCalls.push(document.documentElement.classList.contains('eje-print-isolate'));
    // The PDF's own pages, drawn for printing (`printPdf`), are what is on the page.
    window.__printPages = document.querySelectorAll('.eje-print-root img').length;
    window.dispatchEvent(new Event('afterprint'));
  };
});
const previewPage = await previews.newPage();
let silentDownloads = 0;
const writes = [];
previewPage.on('download', () => { silentDownloads += 1; });
previewPage.on('request', (request) => {
  if (request.method() !== 'GET' && request.url().includes('/api/') && !request.url().includes('/api/auth/')) {
    writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  }
});
await signInAs(previewPage, 'Elmarie Coetzee', { base: BASE, greeting: /Elmarie/ });

await step('TABLET: Job card PDF opens the job card INSIDE the app — no silent download (TR-02)', async () => {
  await previewPage.goto(`${BASE}/jobs/EJE-1067/review`, { waitUntil: 'networkidle' });
  writes.length = 0;
  await previewPage.getByTestId('job-card-pdf-button').click();
  await viewerDrew(previewPage, 'document-preview');
  if (silentDownloads !== 0) throw new Error(`${silentDownloads} silent download(s)`);
});

await step('TABLET: Print prints the document alone, once, and writes nothing', async () => {
  await previewPage.getByTestId('preview-print').click();
  await previewPage.waitForFunction(() => window.__printCalls.length > 0, null, { timeout: 10000 });
  const calls = await previewPage.evaluate(() => window.__printCalls);
  if (calls.length !== 1) throw new Error(`print was asked for ${calls.length} times`);
  if (calls[0] !== true) throw new Error('the application was still on the page when printing');
  const printed = await previewPage.evaluate(() => window.__printPages);
  if (!(printed > 0)) throw new Error("the PDF's own pages were not what was printed");
  if (await previewPage.evaluate(() => document.documentElement.classList.contains('eje-print-isolate'))) {
    throw new Error('the page stayed in print mode after printing');
  }
  if (writes.length !== 0) throw new Error(`printing sent ${writes.join(', ')}`);
});

await step('TABLET: Download PDF saves the same PDF each time, separately from Print, and writes nothing', async () => {
  const take = async () => {
    const started = previewPage.waitForEvent('download', { timeout: 20000 });
    await previewPage.getByTestId('preview-download').click();
    const file = await started;
    const path = await file.path();
    const { readFile } = await import('node:fs/promises');
    return { name: file.suggestedFilename(), bytes: await readFile(path) };
  };
  const first = await take();
  const second = await take();
  silentDownloads = 0; // these two were asked for
  if (!first.name.endsWith('.pdf')) throw new Error(`downloaded ${first.name}`);
  if (first.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('the download is not a PDF');
  if (!first.bytes.equals(second.bytes)) throw new Error('two downloads of the same preview differ');
  const read = await pdfTextIn(previewPage, first.bytes);
  if (!read.text.includes('EJE-1067')) throw new Error('the downloaded PDF is not this job card');
  const shown = Number(await previewPage.getByTestId('document-preview').getAttribute('data-pages'));
  if (shown !== read.pages) throw new Error(`the viewer shows ${shown} page(s); the download has ${read.pages}`);
  if (writes.length !== 0) throw new Error(`downloading sent ${writes.join(', ')}`);
  await previewPage.getByTestId('preview-close').click();
});

await step('TABLET: a courier collection offers its price-less Delivery Note, in the app (PARTS-03)', async () => {
  await previewPage.goto(`${BASE}/jobs/EJE-1063`, { waitUntil: 'networkidle' });
  await previewPage.getByTestId('delivery-note-button').click();
  await viewerDrew(previewPage, 'document-preview');
  const file = await downloadOf(previewPage, previewPage.getByTestId('preview-download'));
  silentDownloads = 0; // asked for
  const text = (await pdfTextIn(previewPage, file.bytes)).text;
  if (!text.includes('DSV-4471882')) throw new Error('the waybill is not on the Delivery Note');
  if (/R[\s\u00a0]\d/u.test(text) || text.includes('Subtotal')) throw new Error('the Delivery Note shows a price');
  if (silentDownloads !== 0) throw new Error('the Delivery Note was downloaded silently');
  await previewPage.getByTestId('preview-close').click();
});

await step('TABLET: the Time Sheet preview has exactly Date, Customer, OT, D/T, Callout, Int Km, Cust Km (PDF-01)', async () => {
  await signInAs(previewPage, 'Sipho Mahlangu', { base: BASE, greeting: /Sipho/ });
  await previewPage.goto(`${BASE}/timesheets`, { waitUntil: 'networkidle' });
  writes.length = 0;
  await previewPage.getByTestId('timesheet-preview').click();
  await viewerDrew(previewPage, 'document-preview');
  const file = await downloadOf(previewPage, previewPage.getByTestId('preview-download'));
  silentDownloads = 0; // asked for
  const text = (await pdfTextIn(previewPage, file.bytes)).text;
  for (const column of ['Date', 'Customer', 'OT', 'D/T', 'Callout', 'Int Km', 'Cust Km']) {
    if (!text.includes(column)) throw new Error(`the Time Sheet has no ${column} column`);
  }
  if (writes.length !== 0) throw new Error(`previewing sent ${writes.join(', ')}`);
  if (silentDownloads !== 0) throw new Error('the Time Sheet was downloaded silently');
  await previewPage.getByTestId('preview-close').click();
});

await step('TABLET: the monthly attendance form shows in the app, as its own document, and writes nothing (PAY-01)', async () => {
  await previewPage.goto(`${BASE}/payroll`, { waitUntil: 'networkidle' });
  writes.length = 0;
  await previewPage.getByTestId('monthly-attendance-preview').click();
  await viewerDrew(previewPage, 'document-preview');
  const file = await downloadOf(previewPage, previewPage.getByTestId('preview-download'));
  silentDownloads = 0; // asked for
  const text = (await pdfTextIn(previewPage, file.bytes)).text;
  if (!/Date[\s\S]*Attendance[\s\S]*Absence reason[\s\S]*Note/u.test(text)) throw new Error('the attendance columns are missing');
  if (writes.length !== 0) throw new Error(`previewing sent ${writes.join(', ')}`);
  if (silentDownloads !== 0) throw new Error('the attendance form was downloaded silently');
  await previewPage.getByTestId('preview-close').click();
});

await previews.close();
await browser.close();

console.log('\n=== SUMMARY ===');
if (failures.length === 0) {
  console.log('EVERY PREVIEW DRAWS THE PDF ITSELF, ON BOTH, with no embedded browser viewer and no dead action');
  process.exit(0);
}
for (const failure of failures) console.log(` - ${failure}`);
process.exit(1);
