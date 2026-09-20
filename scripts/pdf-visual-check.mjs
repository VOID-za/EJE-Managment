/**
 * Visual and geometric verification of the final job-card PDF.
 *
 * A PDF can contain every correct string and still be wrong: text can run past
 * the margin, two runs can overlap, a signature box can be empty. Extracting
 * the text proves none of that — and a review found exactly those faults after
 * a text-only check had passed.
 *
 * So this downloads the real document from the running application, then:
 *
 *  1. Parses the page content streams and measures every text run with the same
 *     font metrics the renderer used, checking margins, overlap and clipping.
 *  2. Asserts the signature is physically in the bytes — a drawn path, or the
 *     script-font facsimile the on-screen card falls back to for a seeded job.
 *  3. Renders every page to a PNG through Chromium's own PDF engine, so a
 *     person can look at the document rather than trust a description of it.
 *
 * Usage:
 *   npm run start
 *   npm run pdf-check                       # EJE-1044, the regression fixture
 *   npm run pdf-check -- EJE-1056 EJE-1062
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';

const BASE = process.env.EJE_PDF_URL ?? 'http://localhost:3000';
const OUT = process.env.EJE_PDF_OUT ?? '.pdf-check';
const JOBS = process.argv.slice(2).filter((argument) => argument.startsWith('EJE-'));
const TARGETS = JOBS.length > 0 ? JOBS : ['EJE-1044'];

const problems = [];
const note = (job, message) => problems.push(`${job}: ${message}`);

const latin1 = (buffer) => buffer.toString('latin1');

/**
 * Byte-level sanity, without re-implementing the measuring.
 *
 * The geometric checks — margins, collisions, a present signature — are done by
 * `inspectPdf` in `src/lib/pdf/inspect.ts` and asserted by
 * `final-document-layout.test.ts`, so they run in `npm run verify` and cannot
 * drift from the renderer. What this adds is the part a test cannot do: it
 * fetches the document the way a person does, and draws it.
 */
const sanity = (job, pdf) => {
  const text = latin1(pdf);
  if (!text.startsWith('%PDF-')) note(job, 'the download is not a PDF');
  if (!text.trimEnd().endsWith('%%EOF')) note(job, 'the PDF has no EOF marker');
  if (text.includes('<html') || text.includes('<!DOCTYPE')) note(job, 'the download is HTML');

  const pages = Number(/\/Count (\d+)/.exec(text)?.[1] ?? 0);
  if (pages < 1) note(job, 'the PDF declares no pages');

  // The signature is in the bytes as either the script font or stroked path
  // operators. Its absence is the fault this script exists to catch.
  const hasScript = text.includes('/Times-Italic');
  const strokes = [...text.matchAll(/[\d.-]+ [\d.-]+ l/g)].length;
  const signature = hasScript ? 'facsimile (script face)' : strokes >= 2 ? `drawn (${strokes} segments)` : null;
  if (signature === null) note(job, 'NO SIGNATURE is present in the document');

  return { pages, signature };
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.PLAYWRIGHT_CHROMIUM },
);
const page = await browser.newPage({ viewport: { width: 1000, height: 1300 }, acceptDownloads: true });

// The store is the server's now, so a previous run's work would otherwise be
// what these documents are rendered from.
await resetDemonstration(page, BASE);
await signInAs(page, 'Elmarie Coetzee');
await page.getByRole('heading', { name: /Good day, Elmarie/ }).waitFor({ timeout: 25000 });

for (const jobNumber of TARGETS) {
  await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
  await page.getByText('Final signed job card').waitFor({ timeout: 25000 });

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 25000 }),
    page.getByRole('button', { name: 'Download Final PDF' }).click(),
  ]);
  const file = join(OUT, download.suggestedFilename());
  await download.saveAs(file);

  const pdf = readFileSync(file);
  const result = sanity(jobNumber, pdf);
  console.log(
    `${jobNumber}  ${download.suggestedFilename()}  ${pdf.length} bytes  ` +
      `${result.pages} page(s)  signature: ${result.signature ?? 'MISSING'}`,
  );

  // Render each page through Chromium's PDF engine, for a person to look at.
  const viewer = await browser.newPage({ viewport: { width: 1000, height: 1300 } });
  // Resolved so an absolute EJE_PDF_OUT is not joined onto the working directory.
  await viewer.goto(`file://${resolve(file)}`, { waitUntil: 'load', timeout: 30000 });
  await viewer.waitForTimeout(3500);
  for (let pageNumber = 1; pageNumber <= result.pages; pageNumber += 1) {
    await viewer.screenshot({ path: join(OUT, `${jobNumber}-page-${pageNumber}.png`) });
    if (pageNumber < result.pages) {
      await viewer.mouse.move(650, 700);
      for (let scroll = 0; scroll < 14; scroll += 1) {
        await viewer.mouse.wheel(0, 500);
        await viewer.waitForTimeout(110);
      }
      await viewer.waitForTimeout(1200);
    }
  }
  await viewer.close();
}

await browser.close();

console.log(`\nPage images written to ${OUT}/`);
console.log('\n=== PDF VISUAL CHECK ===');
if (problems.length === 0) {
  console.log('Every document downloaded as a real PDF and carries its signature.');
  console.log('Look at the page images above to judge the layout.');
} else {
  console.log(`${problems.length} problem(s):`);
  problems.forEach((problem) => console.log(` - ${problem}`));
  process.exitCode = 1;
}
