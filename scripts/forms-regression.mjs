/**
 * THE TESTER'S CRITICAL FIXES, THROUGH THE SCREEN, AT ONE VIEWPORT.
 * (31 October 2026 — Timesheets, Attendance autosave, My Monthly Forms, PDF
 * previews, job validation, Test & Repair parts, Closed Jobs.)
 *
 * Every check drives the real application in a browser, as the person whose
 * role it names, and asserts what they would see — or, for a permission, what
 * the SERVER answers to a request a manipulated client sends. Run it once per
 * device shape:
 *
 *   EJE_E2E_URL=http://localhost:3210 EJE_FORMS_VIEWPORT=1440x900 node scripts/forms-regression.mjs
 *   EJE_FORMS_VIEWPORT=768x1024:touch …   (a portrait tablet, by touch)
 *   EJE_FORMS_VIEWPORT=390x844:touch …    (a phone, by touch)
 *
 * The demonstration data is reset first, so a run starts from the seed. It
 * never runs against a database holding a business's data: the reset endpoint
 * does not exist there.
 *
 * Prints PASS / FAIL / BLOCKED per check; exits 1 on any FAIL.
 */
import { readFile } from 'node:fs/promises';
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
    const kind = message.startsWith('BLOCKED') ? 'BLOCKED' : 'FAIL';
    results.push([kind, `${name} :: ${message}`]);
    console.log(`${kind}  ${name} :: ${message}`);
  }
};
const fail = (message) => {
  throw new Error(message);
};

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
const context = await browser.newContext({
  viewport: { width, height },
  hasTouch: touch,
  isMobile: touch && width < 700,
  acceptDownloads: true,
});
// The print dialog cannot be driven by a test: count the calls, and note what was on the page.
await context.addInitScript(() => {
  window.__prints = [];
  window.print = () => {
    window.__prints.push({
      isolated: document.documentElement.classList.contains('eje-print-isolate'),
      pages: document.querySelectorAll('.eje-print-root img').length,
    });
    window.dispatchEvent(new Event('afterprint'));
  };
});
const page = await context.newPage();
page.on('dialog', (dialog) => void dialog.accept());
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const press = async (locator) => {
  await locator.scrollIntoViewIfNeeded();
  if (touch) await locator.tap();
  else await locator.click();
};
const as = (who) => signInAs(page, who, { base: BASE });
const go = async (path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
};
const today = () => page.evaluate(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' }));
const noPageOverflow = async (where) => {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`${where}: the page scrolls sideways by ${over}px`);
};
/** A write from this browser's own session, as a manipulated client would send it. */
const post = (path, body) =>
  page.evaluate(
    async ([url, payload]) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: response.status, json };
    },
    [path, body],
  );
const get = (path) => page.evaluate(async (url) => {
  const response = await fetch(url);
  return { status: response.status, json: await response.json().catch(() => null) };
}, path);

/* ---------------------------------------------------------------------- */
/* The PDF viewer                                                           */
/* ---------------------------------------------------------------------- */

/** The in-app viewer opened the document and drew page `number` with real ink. */
const viewerDrew = async (testId = 'document-preview', number = 1) => {
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-viewer-state') === 'ready',
    testId,
    { timeout: 30000 },
  );
  const viewer = page.getByTestId(testId);
  if ((await viewer.getAttribute('data-preview-kind')) !== 'pdf-viewer') fail(`${testId} is not the PDF viewer`);
  await viewer.locator(`[data-page="${number}"][data-drawn="yes"]`).waitFor({ timeout: 30000 });
  const dark = await viewer.locator(`[data-page="${number}"] canvas`).evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] < 230) count += 1;
    return count;
  });
  if (dark < 100) fail(`page ${number} was drawn blank`);
  if ((await viewer.locator('iframe, embed, object').count()) !== 0) fail('the viewer embeds a browser PDF plugin');
  return Number(await viewer.getAttribute('data-pages'));
};

const pdfText = (bytes) =>
  page.evaluate(async (base64) => {
    const pdfjs = await import('/vendor/pdfjs-4.10.38/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs-4.10.38/pdf.worker.min.mjs';
    const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const pdf = await pdfjs.getDocument({ data, isEvalSupported: false, standardFontDataUrl: '/vendor/pdfjs-4.10.38/standard_fonts/' }).promise;
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      pages.push((await (await pdf.getPage(number)).getTextContent()).items.map((item) => item.str).join(' '));
    }
    const count = pdf.numPages;
    await pdf.destroy();
    return { pages: count, text: pages.join('\n'), perPage: pages };
  }, Buffer.from(bytes).toString('base64'));

const downloadOf = async (button) => {
  const started = page.waitForEvent('download', { timeout: 30000 });
  await press(button);
  const file = await started;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
};

/**
 * EVERY PREVIEW, THE SAME NINE THINGS (the tester's list): it opens and draws;
 * pages are navigated; zoom and Fit width work; it scrolls; it closes; it
 * reopens; Download is the same PDF the viewer shows; Print prints the PDF's
 * own pages, alone. `open` presses whatever opens this preview.
 */
const previewWorks = async (open, expectText) => {
  await open();
  const pages = await viewerDrew();
  const dialog = page.locator('[role="dialog"]').last();
  const box = await dialog.boundingBox();
  if (box === null || box.x < -1 || box.y < -1 || box.x + box.width > width + 1 || box.y + box.height > height + 1) {
    fail(`the preview dialog does not fit the screen (${JSON.stringify(box)})`);
  }
  // Page navigation.
  const next = page.getByTestId('pdf-next');
  if (pages > 1) {
    await press(next);
    await viewerDrew('document-preview', 2);
    await press(page.getByTestId('pdf-previous'));
  } else if (!(await next.isDisabled())) fail('Next page is offered on a one-page document');
  // Zoom.
  const before = await page.getByTestId('pdf-zoom').innerText();
  await press(page.getByTestId('pdf-zoom-in'));
  const after = await page.getByTestId('pdf-zoom').innerText();
  if (after === before) fail(`zoom in left the zoom at ${before}`);
  await press(page.getByTestId('pdf-zoom-out'));
  await press(page.getByTestId('pdf-fit'));
  await viewerDrew();
  // Scrolling: the document scrolls inside the viewer, never the page sideways.
  await page.getByTestId('pdf-scroll').evaluate((element) => element.scrollBy(0, 400));
  await noPageOverflow('preview');
  // Download is the document on screen.
  const file = await downloadOf(page.getByTestId('preview-download'));
  if (file.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') fail(`${file.name} is not a PDF`);
  const read = await pdfText(file.bytes);
  if (read.pages !== pages) fail(`the viewer shows ${pages} page(s); the download has ${read.pages}`);
  for (const fragment of expectText) if (!read.text.includes(fragment)) fail(`the PDF does not say "${fragment}"`);
  // Print: the PDF's own pages, alone, once.
  await page.evaluate(() => {
    window.__prints = [];
  });
  await press(page.getByTestId('preview-print'));
  await page.waitForFunction(() => window.__prints.length > 0, null, { timeout: 30000 });
  const prints = await page.evaluate(() => window.__prints);
  if (prints.length !== 1 || !prints[0].isolated || prints[0].pages !== pages) fail(`print was ${JSON.stringify(prints)}`);
  // Close, and reopen.
  await press(page.getByTestId('preview-close'));
  await page.getByTestId('document-preview').waitFor({ state: 'detached', timeout: 10000 });
  await open();
  await viewerDrew();
  await press(page.getByTestId('preview-close'));
  await page.getByTestId('document-preview').waitFor({ state: 'detached', timeout: 10000 });
  return `${file.name}, ${pages} page(s)`;
};

/* ====================================================================== */

console.log(`forms regression at ${label} against ${BASE}`);
await resetDemonstration(page, BASE);

/* ---- 1. Closed Jobs: no Download CSV ---------------------------------- */
for (const who of ['Elmarie Coetzee', 'Christene van Niekerk']) {
  await check(`Closed Jobs has no Download CSV — ${who}`, async () => {
    await as(who);
    await go('/jobs/closed');
    await page.getByRole('heading', { name: 'Closed Jobs' }).first().waitFor({ timeout: 15000 });
    if ((await page.getByRole('button', { name: /Download CSV/u }).count()) + (await page.getByRole('link', { name: /Download CSV/u }).count()) + (await page.getByTestId('export-csv').count()) !== 0) {
      fail('Download CSV is still offered');
    }
    await noPageOverflow('Closed Jobs');
  });
}

/* ---- 2. Job validation: Installation and Service ---------------------- */
await as('Elmarie Coetzee');
const selectFirst = async (labelText) => {
  const field = page.getByLabel(labelText, { exact: false }).first();
  const values = await field.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
  await field.selectOption(values[0]);
};
for (const type of ['installation', 'service']) {
  await check(`${type}: Machine is mandatory and marked; Priority is optional`, async () => {
    await go('/jobs/new');
    await page.getByLabel('Job type').selectOption(type);
    await selectFirst('Customer');
    await page.waitForTimeout(300);
    await selectFirst('Site');
    await page.waitForTimeout(300);
    await selectFirst('Customer email recipient');
    const machineLabel = await page.locator('label', { hasText: /^Machine/u }).first().innerText();
    if (!machineLabel.includes('*')) fail(`the Machine label is not marked required: "${machineLabel}"`);
    if ((await page.getByText('Priority (optional)').count()) === 0) fail('Priority is not marked optional');
    await page.getByLabel('Fault', { exact: false }).first().fill(`Forms regression ${type}: commissioning check.`);
    // No machine: refused here, with the reason beside the field.
    await press(page.getByRole('button', { name: 'Create job' }));
    await page.getByText('Select the machine this job is for.').first().waitFor({ timeout: 10000 });
    if (!page.url().endsWith('/jobs/new')) fail('a job was raised without a machine');
  });
  await check(`${type}: raised with a Machine and NO Priority`, async () => {
    await selectFirst('Machine');
    const priority = page.getByLabel(/^Priority/u).first();
    if ((await priority.inputValue()) !== '') fail('Priority was pre-filled');
    await press(page.getByRole('button', { name: 'Create job' }));
    await page.waitForURL('**/jobs/EJE-**', { timeout: 25000 });
    const number = page.url().split('/').pop();
    const view = await get(`/api/jobs/${number}`);
    const job = view.json?.data?.view?.job;
    if (job?.jobType !== type || job?.priority !== null || job?.machineId === null) fail(`raised as ${JSON.stringify({ type: job?.jobType, priority: job?.priority, machine: job?.machineId })}`);
    return number;
  });
  await check(`${type}: the SERVER refuses one without a Machine (422 machine_required)`, async () => {
    const customers = await get('/api/customers');
    const customer = customers.json.data[0].id;
    const screen = (await get(`/api/customers/${customer}`)).json.data;
    const answer = await post('/api/jobs', {
      customerId: customer, siteId: screen.sites[0].id, contactId: screen.contacts[0].id, machineId: null, jobType: type, priority: null,
      scheduledDate: null, scheduledEndDate: null, orderNumber: '', referenceNumber: '', faultDescription: 'Server check.',
      primaryTechnicianId: null, additionalTechnicianIds: [], courierCollection: false, deliveryNote: '',
    });
    if (answer.status !== 422 || !JSON.stringify(answer.json).includes('machine_required')) fail(`answered ${answer.status} ${JSON.stringify(answer.json)?.slice(0, 160)}`);
  });
}

/* ---- 3. Test & Repair: many parts, one delivery note ------------------ */
const PARTS = [['Bearing', 'BRG-001', '2'], ['Seal kit', 'SK-010', '1'], ['Sensor', 'SNS-004', '3'], ['Coupling', 'CPL-002', '1']];
const fillParts = async (rows) => {
  for (const [index, [description, part, quantity]] of rows.entries()) {
    if (index > 0) await press(page.getByTestId('repair-item-add'));
    const row = page.getByTestId('repair-item-row').nth(index);
    await row.getByTestId('repair-item-description').fill(description);
    await row.getByTestId('repair-item-part-number').fill(part);
    await row.getByTestId('repair-item-quantity').fill(quantity);
  }
};
const listedParts = () => page.getByTestId('repair-items-list-row').allInnerTexts();
await check('Test & Repair: a new job is raised with several parts and their own quantities', async () => {
  await go('/jobs/new');
  await page.getByLabel('Job type').selectOption('test_and_repair');
  await selectFirst('Customer');
  await page.waitForTimeout(300);
  await selectFirst('Site');
  await page.waitForTimeout(300);
  await selectFirst('Customer email recipient');
  await fillParts(PARTS.slice(0, 2));
  await press(page.getByRole('button', { name: 'Create job' }));
  await page.waitForURL('**/jobs/EJE-**', { timeout: 25000 });
  await page.getByTestId('repair-items-list').waitFor({ timeout: 15000 });
  const rows = await listedParts();
  if (rows.length !== 2 || !rows[0].includes('BRG-001') || !rows[1].includes('SK-010')) fail(`listed ${JSON.stringify(rows)}`);
});
await check('Test & Repair: four parts added on the job, saved, and all four reopen in order', async () => {
  await go('/jobs/EJE-1067');
  await press(page.getByTestId('edit-repair-items'));
  await fillParts(PARTS);
  await press(page.getByTestId('save-repair-items'));
  await page.getByTestId('save-repair-items').waitFor({ state: 'detached', timeout: 15000 });
  await page.reload({ waitUntil: 'networkidle' });
  const rows = await listedParts();
  if (rows.length !== 4 || PARTS.some(([, part], index) => !rows[index]?.includes(part))) fail(`after reopening: ${JSON.stringify(rows)}`);
});
await check('Test & Repair: a quantity edited and a part removed, saved and reopened', async () => {
  await press(page.getByTestId('edit-repair-items'));
  await page.getByTestId('repair-item-row').nth(2).getByTestId('repair-item-quantity').fill('5');
  await press(page.getByTestId('repair-item-row').nth(1).getByTestId('repair-item-remove'));
  await press(page.getByTestId('save-repair-items'));
  await page.getByTestId('save-repair-items').waitFor({ state: 'detached', timeout: 15000 });
  await page.reload({ waitUntil: 'networkidle' });
  const rows = await listedParts();
  if (rows.length !== 3 || rows.some((row) => row.includes('SK-010')) || !rows[1].includes('× 5')) fail(`after the edit: ${JSON.stringify(rows)}`);
  // Back to the four, for the delivery note.
  await press(page.getByTestId('edit-repair-items'));
  await page.getByTestId('repair-item-row').nth(1).getByTestId('repair-item-quantity').fill('3');
  await press(page.getByTestId('repair-item-add'));
  const added = page.getByTestId('repair-item-row').nth(3);
  await added.getByTestId('repair-item-description').fill('Seal kit');
  await added.getByTestId('repair-item-part-number').fill('SK-010');
  await added.getByTestId('repair-item-quantity').fill('1');
  await press(page.getByTestId('save-repair-items'));
  await page.getByTestId('save-repair-items').waitFor({ state: 'detached', timeout: 15000 });
});
await check('Test & Repair: a technician cannot change the parts (server)', async () => {
  await as('Sipho Mahlangu');
  const job = (await get('/api/jobs/EJE-1067')).json.data.view.job;
  const answer = await post(`/api/jobs/${job.id}/set_repair_items`, { items: [], expected: [] });
  if (answer.status < 400 || answer.status >= 500) fail(`answered ${answer.status}`);
  // The technician finishes the work and records a courier collection, so the job has a delivery note.
  const report = await post(`/api/jobs/${job.id}/save_report`, { faultFindings: '', diagnosis: '', workPerformed: 'Bench tested and repaired.', recommendations: '', generalNotes: '' });
  const started = await post(`/api/jobs/${job.id}/start_completion`, {});
  const collected = await post(`/api/jobs/${job.id}/set_collection`, { courier: true, waybillNumber: 'DSV-PARTS-4' });
  if ([report, started, collected].some((answer) => answer.status !== 200)) fail(`collection steps answered ${[report, started, collected].map((answer) => answer.status).join(', ')}`);
});
await check('Test & Repair: ONE delivery note lists all four parts with their quantities (preview = download)', async () => {
  await as('Elmarie Coetzee');
  await go('/jobs/EJE-1067');
  return previewWorks(() => press(page.getByTestId('delivery-note-button')), ['BRG-001', 'SNS-004', 'CPL-002', 'SK-010', 'Bearing', 'Sensor', 'Coupling', 'Seal kit', 'DSV-PARTS-4']);
});
await check('Test & Repair: enough parts for several pages — every part, headings repeated, numbered pages', async () => {
  const job = (await get('/api/jobs/EJE-1067')).json.data.view.job;
  const current = [job.repairItem, ...job.moreRepairItems].filter((item) => item.description || item.partNumber);
  const many = Array.from({ length: 60 }, (_, index) => ({ description: `Replacement part ${index + 1}${index % 6 === 0 ? ' — with a long description that wraps onto a second line in its own column' : ''}`, partNumber: `PN-${String(index + 1).padStart(3, '0')}`, quantity: (index % 7) + 1 }));
  const saved = await post(`/api/jobs/${job.id}/set_repair_items`, { items: many, expected: current });
  if (saved.status !== 200) fail(`saving 60 parts answered ${saved.status}`);
  await go('/jobs/EJE-1067');
  await press(page.getByTestId('delivery-note-button'));
  const pages = await viewerDrew();
  if (pages < 2) fail(`60 parts fit on ${pages} page`);
  const file = await downloadOf(page.getByTestId('preview-download'));
  const read = await pdfText(file.bytes);
  for (let index = 1; index <= 60; index += 1) if (!read.text.includes(`PN-${String(index).padStart(3, '0')}`)) fail(`part ${index} is missing`);
  for (const [index, text] of read.perPage.entries()) {
    if (!text.includes(`Page ${index + 1} of ${read.pages}`)) fail(`page ${index + 1} is not numbered`);
    if (index > 0 && text.includes('PN-') && !text.includes('Goods (continued)')) fail(`page ${index + 1} has parts but no headings`);
  }
  await press(page.getByTestId('preview-close'));
  return `${read.pages} pages`;
});

/* ---- 4. Every other PDF type ------------------------------------------- */
await check('PDF: the issued final job card (the STORED file)', async () => {
  await go('/jobs/EJE-1044');
  return previewWorks(() => press(page.getByTestId('final-document-view')), ['EJE-1044']);
});
await check('PDF: the job card preview on the review page', async () => {
  await go('/jobs/EJE-1059/review');
  return previewWorks(() => press(page.getByTestId('job-card-pdf-button')), ['EJE-1059']);
});
await check('PDF: a corrected job card (correction document)', async () => {
  // EJE-1044 is closed with an issued final document, so a correction can be raised on it.
  await go('/jobs/EJE-1044');
  await press(page.getByTestId('correction-open'));
  await page.getByTestId('correction-reason').fill('The labour hours were captured against the wrong rate.');
  await page.getByTestId('correction-narrative').fill('Three hours were charged at the after-hours rate and should have been normal time.');
  await press(page.getByTestId('correction-area-labour'));
  await press(page.getByTestId('correction-save'));
  await page.getByTestId('job-correction-row').first().waitFor({ timeout: 15000 });
  return previewWorks(() => press(page.getByTestId('job-correction-preview').first()), ['EJE-1044']);
});
await check('PDF: a library document (uploaded, stored bytes)', async () => {
  const pdf = (() => {
    const content = 'BT /F1 14 Tf 60 780 Td (Forms regression manual: alarm 300500 drive enable.) Tj ET\n';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let body = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(body, 'latin1'));
      body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(body, 'latin1');
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return body;
  })();
  const uploaded = await page.evaluate(async (source) => {
    const form = new FormData();
    form.append('file', new File([source], 'forms-regression.pdf', { type: 'application/pdf' }));
    for (const [key, value] of Object.entries({ name: 'Forms regression manual', description: 'Uploaded by the forms regression.', documentType: 'service_manual', manufacturer: 'Siemens', machineModel: '840D', version: '1.0', tags: 'alarms' })) form.append(key, value);
    return (await fetch('/api/library/upload', { method: 'POST', body: form })).status;
  }, pdf);
  if (uploaded !== 200) fail(`upload answered ${uploaded}`);
  await go('/library');
  const card = page.locator('section', { hasText: 'Forms regression manual' }).first();
  await press(card.getByRole('button', { name: 'Open' }));
  const pages = await viewerDrew('library-pdf-viewer');
  await press(page.getByTestId('pdf-zoom-in'));
  await noPageOverflow('library preview');
  await page.keyboard.press('Escape');
  return `${pages} page`;
});

/* ---- 5. Timesheets: the whole month, by a technician ------------------ */
await as('Sipho Mahlangu');
const day = (date) => page.locator(`[data-testid="timesheet-day"][data-date="${date}"]`);
const lineForm = () => page.getByTestId('timesheet-line-form');
let openDays = [];
await check('Timesheets: every day of the month entered through the screen, and all reopen', async () => {
  await go('/timesheets');
  await page.getByTestId('timesheet-table').waitFor({ timeout: 20000 });
  openDays = await page.locator('[data-testid="timesheet-day"]').evaluateAll((elements) => elements.filter((element) => element.querySelector('[data-testid="add-timesheet-line"]')).map((element) => element.dataset.date));
  if (openDays.length < 20) fail(`only ${openDays.length} days can take a line`);
  for (const [index, date] of openDays.entries()) {
    await press(day(date).getByTestId('add-timesheet-line'));
    if (index % 3 === 0) await lineForm().getByTestId('timesheet-customer-pick').selectOption('__workshop__');
    else await lineForm().getByTestId('timesheet-customer-name').fill(`Customer ${index}`);
    await lineForm().getByTestId('timesheet-overtime').fill(String((index % 4) * 0.25));
    await lineForm().getByTestId('timesheet-callout').fill(index % 7 === 0 ? '450' : '0');
    await lineForm().getByTestId('timesheet-internal-km').fill(String(index));
    await press(lineForm().getByTestId('save-timesheet-line'));
    await page.waitForFunction((d) => document.querySelector(`[data-testid="timesheet-day"][data-date="${d}"] [data-testid="timesheet-line"]`) !== null && document.querySelector('[data-testid="timesheet-line-form"]') === null, date, { timeout: 15000 });
  }
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('timesheet-table').waitFor();
  const lines = await page.locator('[data-testid="timesheet-line"]').count();
  if (lines < openDays.length) fail(`${lines} of ${openDays.length} lines after reopening`);
  await noPageOverflow('Timesheets');
  return `${openDays.length} days`;
});
await check('Timesheets: a saved line is edited and moved to another day', async () => {
  await press(day(openDays[1]).getByRole('button', { name: 'Edit' }).first());
  await lineForm().getByTestId('timesheet-line-date').fill(openDays[2]);
  await lineForm().getByTestId('timesheet-overtime').fill('2');
  await press(lineForm().getByTestId('save-timesheet-line'));
  await page.waitForFunction((d) => document.querySelectorAll(`[data-testid="timesheet-day"][data-date="${d}"] [data-testid="timesheet-line"]`).length === 2, openDays[2], { timeout: 15000 });
});
await check('Timesheets: changing From while a line is open never strands it', async () => {
  await press(day(openDays[0]).getByTestId('add-timesheet-line'));
  await lineForm().getByTestId('timesheet-overtime').fill('1.5');
  await page.getByTestId('timesheet-from').fill(openDays[5]);
  await page.getByTestId('timesheet-line-elsewhere').waitFor({ timeout: 10000 });
  if ((await lineForm().getByTestId('timesheet-overtime').inputValue()) !== '1.5') fail('the typed value was lost');
  await press(lineForm().getByTestId('cancel-timesheet-line'));
  await page.getByTestId('timesheet-from').fill(openDays[0]);
  await page.getByTestId('add-timesheet-line').first().waitFor({ timeout: 10000 });
});
await check('Timesheets: a line missing its customer says so beside it, on screen', async () => {
  await press(day(openDays[openDays.length - 1]).getByTestId('add-timesheet-line'));
  await lineForm().getByTestId('timesheet-overtime').fill('2');
  await press(lineForm().getByTestId('save-timesheet-line'));
  const seen = await page.evaluate(() => [...document.querySelectorAll('[data-testid="timesheet-line-form"] [role="alert"], [data-testid="timesheet-line-form"] [id$="-error"], [data-testid="timesheet-line-refusal"]')].some((element) => {
    const box = element.getBoundingClientRect();
    return box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
  }));
  if (!seen) fail('the reason is not on screen');
  if ((await page.getByText('Say which customer the work was for, or choose Workshop.').count()) === 0) fail('the customer rule is not stated');
});
await check('Timesheets: a half-typed line survives a reload and is offered back', async () => {
  await lineForm().getByTestId('timesheet-customer-name').fill('Kept on the device');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('timesheet-line-restored').waitFor({ timeout: 15000 });
  if ((await lineForm().getByTestId('timesheet-customer-name').inputValue()) !== 'Kept on the device') fail('the line was not restored');
  await press(lineForm().getByTestId('save-timesheet-line'));
  await lineForm().waitFor({ state: 'detached', timeout: 15000 });
});
await check('Timesheets: typing in a line costs what a bare input costs, with a month on screen', async () => {
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'bare-input';
    document.querySelector('main').prepend(input);
  });
  await press(day(openDays[3]).getByTestId('add-timesheet-line'));
  const cost = (selector) => page.evaluate(async (target) => {
    const element = document.querySelector(target);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const costs = [];
    for (const char of 'Sasol Secunda') {
      const start = performance.now();
      setter.call(element, element.value + char);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
      costs.push(performance.now() - start);
    }
    costs.sort((a, b) => a - b);
    return costs[Math.floor(costs.length / 2)];
  }, selector);
  const bare = await cost('#bare-input');
  const line = await cost('[data-testid="timesheet-customer-name"]');
  if (line > bare * 1.5 + 4) fail(`${line.toFixed(1)} ms a key in the line, ${bare.toFixed(1)} ms in a bare input`);
  await press(lineForm().getByTestId('cancel-timesheet-line'));
  return `${line.toFixed(1)} vs ${bare.toFixed(1)} ms per key`;
});
await check('Timesheets: the period comment saves and reopens', async () => {
  await page.getByTestId('timesheet-period-comment').fill('Forms regression comment');
  await press(page.getByTestId('timesheet-save'));
  await page.getByTestId('timesheet-saved').waitFor({ timeout: 15000 });
  await page.reload({ waitUntil: 'networkidle' });
  if ((await page.getByTestId('timesheet-period-comment').inputValue()) !== 'Forms regression comment') fail('the comment did not reopen');
});
await check('PDF: the Time Sheet for the period', async () => previewWorks(() => press(page.getByTestId('timesheet-preview')), ['Date', 'Customer', 'Cust Km']));

/* ---- 6. Attendance: it saves itself ------------------------------------ */
const status = () => page.getByTestId('autosave-status').first().getAttribute('data-state');
const waitState = (state, timeout = 20000) => page.waitForFunction((wanted) => document.querySelector('[data-testid="autosave-status"]')?.getAttribute('data-state') === wanted, state, { timeout }).then(() => true, () => false);
const attendanceDay = (date) => page.locator(`[data-testid="my-attendance-day"][data-date="${date}"]`);
let attendanceDays = [];
await check('Attendance: no Save button; every tap through the month saves itself', async () => {
  const now = await today();
  await go(`/attendance?from=${now.slice(0, 8)}01`);
  await page.getByTestId('my-attendance').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('absence-reason-confirm').count()) !== 0) fail('a Record absent button is still there');
  attendanceDays = await page.locator('[data-testid="my-attendance-day"]').evaluateAll((elements) => elements.map((element) => element.dataset.date));
  for (const [index, date] of attendanceDays.entries()) {
    if (index % 5 === 4) {
      await press(attendanceDay(date).getByTestId('my-attendance-absent'));
      await attendanceDay(date).getByLabel('Reason for absence').selectOption('sick_leave');
    } else await press(attendanceDay(date).getByTestId('my-attendance-present'));
  }
  if (!(await waitState('saved', 40000))) fail(`the status is ${await status()}`);
  if (!/Last saved/u.test(await page.getByTestId('autosave-status').first().innerText())) fail('the last save time is not shown');
  return `${attendanceDays.length} days`;
});
await check('Attendance: refresh — every day reopens as saved, one record each', async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('my-attendance').waitFor();
  const states = await page.locator('[data-testid="my-attendance-day"]').evaluateAll((elements) => elements.map((element) => element.dataset.status));
  if (states.some((state) => state === 'unrecorded')) fail('a day reopened unrecorded');
  const from = attendanceDays[attendanceDays.length - 1];
  const held = (await get(`/api/attendance/mine?from=${from}&to=${await today()}`)).json.data.days.filter((entry) => entry.record !== null).length;
  if (held !== attendanceDays.length) fail(`${held} records for ${attendanceDays.length} days`);
});
await check('Attendance: offline — kept and said; back online — saved by itself', async () => {
  await context.setOffline(true);
  await press(attendanceDay(attendanceDays[2]).getByTestId('my-attendance-absent'));
  await attendanceDay(attendanceDays[2]).getByLabel('Reason for absence').selectOption('leave');
  if (!(await waitState('offline'))) fail(`offline status was ${await status()}`);
  if ((await attendanceDay(attendanceDays[2]).getAttribute('data-saved')) !== 'no') fail('the day did not say it was unsaved');
  await context.setOffline(false);
  if (!(await waitState('saved', 40000))) fail(`after reconnecting the status is ${await status()}`);
});
await check('Attendance: a failed save is kept, said, and Retry saves it', async () => {
  let failing = true;
  await page.route('**/api/attendance', (route) => (route.request().method() === 'POST' && failing ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal_error","message":"The server failed."}}' }) : route.continue()));
  await press(attendanceDay(attendanceDays[3]).getByTestId('my-attendance-absent'));
  await attendanceDay(attendanceDays[3]).getByLabel('Reason for absence').selectOption('leave');
  if (!(await waitState('failed'))) fail(`status ${await status()}`);
  failing = false;
  await press(page.getByTestId('autosave-retry').first());
  if (!(await waitState('saved'))) fail(`after Retry the status is ${await status()}`);
  await page.unroute('**/api/attendance');
});
await check('Attendance: leaving straight after a change, then returning — the change was kept', async () => {
  await press(attendanceDay(attendanceDays[4]).getByTestId('my-attendance-absent'));
  await attendanceDay(attendanceDays[4]).getByLabel('Reason for absence').selectOption('leave');
  await go('/dashboard');
  await go(`/attendance?from=${attendanceDays[attendanceDays.length - 1]}`);
  await page.getByTestId('my-attendance').waitFor();
  await waitState('saved', 15000);
  if ((await attendanceDay(attendanceDays[4]).getAttribute('data-status')) !== 'absent') fail('the change was lost');
});
await check('Attendance: a slow connection still saves every change', async () => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 1500, downloadThroughput: 50000, uploadThroughput: 20000 });
  for (const date of attendanceDays.slice(5, 8)) await press(attendanceDay(date).getByTestId('my-attendance-present'));
  const ok = await waitState('saved', 60000);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  if (!ok) fail(`status ${await status()}`);
});

/* ---- 7. My Monthly Forms: own forms only ------------------------------- */
for (const [who, first] of [['Elmarie Coetzee', 'Elmarie'], ['Christene van Niekerk', 'Christene'], ['Sipho Mahlangu', 'Sipho']]) {
  await check(`My Monthly Forms: ${first} sees and edits their OWN forms only`, async () => {
    await as(who);
    await go('/payroll/mine');
    const title = await page.getByTestId('monthly-forms-title').innerText();
    if (!title.includes(first)) fail(`the forms are "${title}"`);
    for (const id of ['monthly-timesheet-preview', 'monthly-attendance-preview', 'monthly-timesheet-download', 'monthly-forms-edit-timesheet', 'monthly-forms-edit-attendance']) {
      if ((await page.getByTestId(id).count()) === 0) fail(`no ${id}`);
    }
    await press(page.getByTestId('monthly-forms-edit-timesheet'));
    await page.waitForURL('**/timesheets?from=*', { timeout: 15000 });
    await page.getByTestId('timesheet-table').waitFor({ timeout: 20000 });
    if ((await page.getByTestId('add-timesheet-line').count()) === 0) fail('their own timesheet for the month is not editable');
    const picker = page.getByTestId('timesheet-person');
    if ((await picker.count()) > 0 && !(await picker.locator('option:checked').innerText()).includes('(me)')) fail('the timesheet opened is not their own');
    await noPageOverflow('Timesheets from My Monthly Forms');
  });
}
await check('PDF: the monthly timesheet and monthly attendance (My Monthly Forms)', async () => {
  await go('/payroll/mine');
  const one = await previewWorks(() => press(page.getByTestId('monthly-timesheet-preview')), ['TIME SHEET', 'Cust Km']);
  const two = await previewWorks(() => press(page.getByTestId('monthly-attendance-preview')), ['ATTENDANCE', 'Absence reason']);
  return `${one}; ${two}`;
});
await check('My Monthly Forms: the server refuses every write to another person’s forms', async () => {
  await as('Elmarie Coetzee');
  const people = (await get('/api/timesheets')).json.data;
  const sipho = people.find((person) => person.firstName === 'Sipho');
  const now = await today();
  const month = `${now.slice(0, 4)}-${String(Number(now.slice(5, 7)) - 1 || 12).padStart(2, '0')}`;
  const attempts = {
    'timesheet line': await post(`/api/timesheets/${sipho.id}/entries`, { date: now, customerName: 'X', workshop: false, overtimeHours: 1, doubleHours: 0, calloutAmount: 0, internalKm: 0, customerKm: 0 }),
    'timesheet send': await post(`/api/timesheets/${sipho.id}/period/submit`, { from: `${month}-01`, to: `${month}-01` }),
    'month submit': await post(`/api/payroll/${sipho.id}/${month}/submit`, { confirmUnrecorded: true }),
  };
  for (const [what, answer] of Object.entries(attempts)) if (answer.status < 400 || answer.status >= 500) fail(`${what} answered ${answer.status}`);
  const theirs = (await get(`/api/payroll/${sipho.id}/${month}`)).json.data;
  if (theirs.owner !== false || theirs.canSubmit !== false) fail('another person’s month is offered as the Master’s own');
});
await check('EJE Monthly Forms: the team view and Finance package still work; another person’s forms are read-only', async () => {
  await go('/payroll');
  await page.getByTestId('payroll-month').waitFor({ timeout: 15000 });
  const open = page.getByRole('button', { name: 'View forms' }).first();
  if ((await open.count()) > 0) {
    await press(open);
    await page.getByTestId('monthly-forms').waitFor({ timeout: 15000 });
    if ((await page.getByTestId('monthly-forms-edit').count()) !== 0 || (await page.getByTestId('monthly-forms-submit').count()) !== 0) fail('another person’s forms offer editing or submission');
  }
  if ((await page.getByTestId('finance-prepare').count()) === 0) fail('the Finance package workflow is gone');
});
await check('PDF: a Finance package attachment (stored file)', async () => {
  // A submitted month is needed: Sipho submits last month, the office prepares the package (nothing is sent).
  const now = await today();
  const month = `${Number(now.slice(5, 7)) === 1 ? Number(now.slice(0, 4)) - 1 : now.slice(0, 4)}-${String(Number(now.slice(5, 7)) - 1 || 12).padStart(2, '0')}`;
  await as('Sipho Mahlangu');
  const people = (await get('/api/timesheets')).json.data;
  const submitted = await post(`/api/payroll/${people[0].id}/${month}/submit`, { confirmUnrecorded: true });
  if (submitted.status !== 200) fail(`BLOCKED: Sipho's month could not be submitted in the demonstration (${submitted.status} ${JSON.stringify(submitted.json?.error)?.slice(0, 120)})`);
  await as('Elmarie Coetzee');
  // A TEST recipient address in the demonstration only: preparing sends nothing.
  await go('/admin');
  const finance = page.getByLabel('Finance email');
  if ((await finance.count()) > 0) {
    await finance.fill('payroll@finance.example.test');
    await press(page.getByTestId('finance-email-save'));
    await page.waitForTimeout(800);
  }
  await go('/payroll');
  await page.getByTestId('payroll-month').fill(month);
  const row = page.locator('[data-testid="finance-row"][data-submitted="yes"]').filter({ hasText: 'Sipho' }).getByTestId('finance-select');
  await row.waitFor({ timeout: 15000 });
  await row.check();
  await press(page.getByTestId('finance-prepare'));
  const attachment = page.getByTestId('finance-attachment-preview').first();
  if (!(await attachment.waitFor({ timeout: 20000 }).then(() => true, () => false))) {
    fail(`BLOCKED: no package could be prepared in the demonstration (${(await page.locator('[role="alert"]').allInnerTexts()).join(' | ').slice(0, 160)})`);
  }
  return previewWorks(() => press(page.getByTestId('finance-attachment-preview').first()), ['Sipho Mahlangu']);
});

/* ---- 8. The office's own timesheet ------------------------------------- */
for (const [who, first] of [['Elmarie Coetzee', 'Elmarie'], ['Christene van Niekerk', 'Christene']]) {
  await check(`Timesheets: ${first} opens and fills in their OWN timesheet; a technician's is read-only`, async () => {
    await as(who);
    await go('/timesheets');
    await page.getByTestId('timesheet-table').waitFor({ timeout: 20000 });
    if (!(await page.getByTestId('timesheet-person').locator('option:checked').innerText()).includes(`${first}`)) fail('the page did not open on their own timesheet');
    const addLine = page.getByTestId('add-timesheet-line').first();
    await press(addLine);
    await lineForm().getByTestId('timesheet-customer-pick').selectOption('__workshop__');
    await lineForm().getByTestId('timesheet-overtime').fill('1');
    await press(lineForm().getByTestId('save-timesheet-line'));
    await lineForm().waitFor({ state: 'detached', timeout: 15000 });
    await page.getByTestId('timesheet-person').selectOption('user-tech-sipho');
    await page.getByTestId('timesheet-read-only').waitFor({ timeout: 15000 });
    if ((await page.getByTestId('add-timesheet-line').count()) !== 0) fail('a technician’s timesheet offers Add line to the office');
  });
}

await check('no page errors anywhere in the run', async () => {
  if (pageErrors.length > 0) fail(pageErrors.slice(0, 3).join(' | '));
});

await browser.close();
const failed = results.filter(([kind]) => kind === 'FAIL');
const blocked = results.filter(([kind]) => kind === 'BLOCKED');
console.log(`\n=== ${label}: ${results.length - failed.length - blocked.length} passed, ${failed.length} failed, ${blocked.length} blocked ===`);
for (const [kind, text] of [...failed, ...blocked]) console.log(` ${kind} ${text}`);
process.exit(failed.length === 0 ? 0 : 1);
