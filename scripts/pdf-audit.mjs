/**
 * EVERY PDF EJE PRODUCES, DOWNLOADED THE WAY A PERSON GETS IT, AND DRAWN.
 * MASTER SCOPE UX-TAB-1 §7.
 *
 * `pdf-visual-check.mjs` does this for the job card. This does it for every
 * document type the system issues, from the running application (the
 * demonstration backend — never production; it raises a correction):
 *
 *   the final job card · a correction addendum · the courier delivery note ·
 *   the timesheet for a period · the monthly timesheet · the monthly
 *   attendance form
 *
 * and, when given a folder of samples (EJE_PDF_SAMPLES, written by
 * `pdf-layout-audit.test.ts` with the longest content EJE's register holds),
 * those too. For each file it checks what can be checked from the bytes — a
 * real PDF, an end-of-file marker, the page count it declares, "Page n of N"
 * on every page where the document numbers its pages, and the file name — and
 * then renders EVERY PAGE to a PNG through Chromium's own PDF engine, so a
 * person looks at the document rather than trusting this description of it.
 *
 * The geometry (margins, overlap, wrapping) is asserted by
 * `pdf-layout-audit.test.ts` and `final-document-layout.test.ts` on the same
 * renderers; this is the part a unit test cannot do.
 *
 * Usage:
 *   npm run start                       # EJE_PERSISTENCE=demo
 *   EJE_PDF_URL=http://127.0.0.1:3210 EJE_PDF_SAMPLES=<folder> node scripts/pdf-audit.mjs
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';

const BASE = process.env.EJE_PDF_URL ?? 'http://localhost:3000';
const OUT = resolve(process.env.EJE_PDF_OUT ?? '.pdf-audit');
const SAMPLES = process.env.EJE_PDF_SAMPLES;
const MONTH = process.env.EJE_PDF_MONTH ?? new Date().toISOString().slice(0, 7);

const problems = [];
const results = [];
mkdirSync(OUT, { recursive: true });

const latin1 = (bytes) => Buffer.from(bytes).toString('latin1');
const pageCount = (bytes) => (latin1(bytes).match(/\/Type\s*\/Page(?!s)/gu) ?? []).length;

const check = (label, fileName, bytes, { numbered = false, expectName = null } = {}) => {
  const text = latin1(bytes);
  const found = [];
  if (!text.startsWith('%PDF-')) found.push('not a PDF');
  if (!text.trimEnd().endsWith('%%EOF')) found.push('no end-of-file marker');
  const pages = pageCount(bytes);
  const declared = Number(/\/Count (\d+)/u.exec(text)?.[1] ?? 0);
  if (pages < 1 || pages !== declared) found.push(`page count: ${pages} page objects, /Count ${declared}`);
  if (numbered) {
    for (let page = 1; page <= pages; page += 1) {
      if (!text.includes(`Page ${page} of ${pages}`)) found.push(`page ${page} is not numbered "Page ${page} of ${pages}"`);
    }
  }
  if (expectName !== null && !expectName.test(fileName)) found.push(`file name "${fileName}" does not match ${expectName}`);
  writeFileSync(join(OUT, fileName.replace(/[\\/:*?"<>|]/gu, '_')), bytes);
  results.push({ label, fileName, bytes: bytes.length, pages, ok: found.length === 0 });
  for (const problem of found) problems.push(`${label}: ${problem}`);
  console.log(`${found.length === 0 ? 'PASS' : 'FAIL'}  ${label} — ${fileName} · ${pages} page(s) · ${bytes.length} bytes${found.length ? ' :: ' + found.join('; ') : ''}`);
  return pages;
};

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM === undefined ? {} : { executablePath: process.env.PLAYWRIGHT_CHROMIUM },
);
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await resetDemonstration(page, BASE);
await signInAs(page, 'Elmarie Coetzee');

/** A JSON command in the page, as the screens send it. */
const call = (method, path, body) =>
  page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    { method, path, body },
  );
/** A file download in the page: the bytes and the name the server gives it. */
const download = (path) =>
  page.evaluate(async (path) => {
    const response = await fetch(path);
    const disposition = response.headers.get('content-disposition') ?? '';
    const name = /filename\*=UTF-8''([^;]+)/u.exec(disposition)?.[1] ?? /filename="([^"]+)"/u.exec(disposition)?.[1] ?? '';
    const buffer = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, name: decodeURIComponent(name), bytes: [...buffer] };
  }, path);
const fromBase64 = (file) => Buffer.from(file.base64, 'base64');

const files = [];

// 1. The final job card, as "Download Final PDF" fetches it.
{
  const r = await call('POST', '/api/documents/EJE-1044');
  if (r.status !== 200) problems.push(`final job card: HTTP ${r.status}`);
  else files.push(['Final job card (EJE-1044)', r.json.data.fileName, fromBase64(r.json.data), { numbered: true, expectName: /EJE-1044/u }]);
}

// 2. A correction addendum: raised here, on the demonstration store.
{
  const job = await call('GET', '/api/jobs/EJE-1044');
  const jobId = job.json?.data?.view?.job?.id;
  const raised = await call('POST', `/api/jobs/${jobId}/raise_correction`, {
    reason: 'The labour line recorded 3.5 hours; the technician worked 4.5 hours on site.',
    narrative: 'Labour on 20 Oct 2026 is corrected from 3.5 to 4.5 hours. Nothing else on the job card changes.',
    areas: ['labour'],
    acknowledgementRequired: true,
  });
  const correctionId = raised.json?.data?.id;
  if (correctionId === undefined) problems.push(`correction: could not raise one (HTTP ${raised.status} ${JSON.stringify(raised.json).slice(0, 160)})`);
  else {
    const r = await call('POST', `/api/documents/EJE-1044/corrections/${correctionId}`);
    if (r.status !== 200) problems.push(`correction document: HTTP ${r.status}`);
    else files.push(['Correction addendum (EJE-1044)', r.json.data.fileName, fromBase64(r.json.data), { numbered: true, expectName: /EJE-1044/u }]);
  }
}

// 3. The courier delivery note, on a seeded job that carries one.
{
  let found = false;
  for (const jobNumber of ['EJE-1056', 'EJE-1057', 'EJE-1062', 'EJE-1044', 'EJE-1039']) {
    const job = await call('GET', `/api/jobs/${jobNumber}`);
    const jobId = job.json?.data?.view?.job?.id;
    if (jobId === undefined) continue;
    const r = await call('POST', `/api/jobs/${jobId}/generate_delivery_note`);
    if (r.status === 200) {
      files.push([`Delivery note (${jobNumber})`, r.json.data.fileName, fromBase64(r.json.data), { numbered: true }]);
      found = true;
      break;
    }
  }
  if (!found) console.log('NOTE  no seeded job issues a delivery note here; the long-content sample covers the renderer');
}

// 4–6. The timesheet for a period, and the two monthly forms, for a technician.
{
  const staff = await call('GET', '/api/staff');
  const sipho = staff.json?.data?.rows?.find((row) => row.name === 'Sipho Mahlangu');
  if (sipho === undefined) problems.push('could not find Sipho Mahlangu in /api/staff');
  else {
    const [y, m] = MONTH.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (const [label, path, expectName] of [
      ['Timesheet for a period', `/api/timesheets/${sipho.id}/period/pdf?from=${MONTH}-01&to=${MONTH}-${String(last).padStart(2, '0')}`, /\.pdf$/u],
      ['Monthly timesheet', `/api/payroll/${sipho.id}/${MONTH}/timesheet/pdf`, /TIMESHEET/u],
      ['Monthly attendance', `/api/payroll/${sipho.id}/${MONTH}/attendance/pdf`, /ATTEN/u],
    ]) {
      const r = await download(path);
      if (r.status !== 200) problems.push(`${label}: HTTP ${r.status}`);
      else files.push([label, r.name, Buffer.from(r.bytes), { numbered: true, expectName }]);
    }
  }
}

// The longest-content samples, if given.
if (SAMPLES !== undefined) {
  for (const name of readdirSync(SAMPLES).filter((file) => file.endsWith('.pdf')).sort()) {
    files.push([`Long-content sample`, name, readFileSync(join(SAMPLES, name)), { numbered: true }]);
  }
}

// Check each file, then draw every page of it.
const viewer = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
for (const [label, fileName, bytes, options] of files) {
  const pages = check(label, fileName, bytes, options);
  const path = join(OUT, fileName.replace(/[\\/:*?"<>|]/gu, '_'));
  // Each page opened on its own (#page=N), so every image is exactly one page.
  for (let n = 1; n <= pages; n += 1) {
    await viewer.goto('about:blank');
    await viewer.goto(`file:///${path.replace(/\\/gu, '/')}#page=${n}`, { waitUntil: 'load', timeout: 30000 });
    await viewer.waitForTimeout(2200);
    await viewer.screenshot({ path: `${path.replace(/\.pdf$/u, '')}-page-${n}.png` });
  }
}
await browser.close();

writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length} documents, ${results.reduce((sum, r) => sum + r.pages, 0)} pages drawn to ${OUT}`);
if (problems.length > 0) {
  console.log(`${problems.length} problem(s):`);
  for (const problem of problems) console.log(` - ${problem}`);
  process.exitCode = 1;
}
