/**
 * JOBS-FILTER-1, ARCHIVE-1, PO-FLOW-1 — THROUGH THE SCREEN, at one size per run.
 *
 *   - Jobs: the search and the status tabs are always there; Status, Job type,
 *     Priority and "Only jobs assigned to me" are folded away, closed by
 *     default; opened, they combine with the search; the button counts what is
 *     set, and Clear filters clears it.
 *   - Closed Jobs: the archive search always there, the filters folded away;
 *     newest finished first (by the moment it finished, never by job number);
 *     a filter narrows, Clear clears; no page scrolls sideways.
 *   - A job raised with its customer's PO is handled straight to Awaiting
 *     Invoice No (the panel says so beforehand).
 *
 *   npm run office-filters-check                 (desktop, 1440x900)
 *   EJE_FORMS_VIEWPORT=390x844:touch npm run office-filters-check
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';
import { assertLocalTarget } from './local-target.mjs';

const BASE = assertLocalTarget(process.env.EJE_E2E_URL ?? process.env.EJE_SMOKE_BASE_URL ?? 'http://localhost:3210');
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
    results.push(['FAIL', name]);
    console.log(`FAIL  ${name} :: ${String(error?.message ?? error).split('\n')[0]}`);
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
const count = async () => Number(((await page.getByTestId('jobs-count').innerText()).match(/\d+/) ?? ['0'])[0]);

await resetDemonstration(page, BASE);
await signInAs(page, 'Elmarie Coetzee', { base: BASE });

await check('Jobs: search and tabs visible; the advanced filters closed by default', async () => {
  await go('/jobs');
  await page.getByTestId('jobs-search').waitFor({ timeout: 20000 });
  await page.getByTestId('jobs-filter-open').waitFor({ timeout: 10000 });
  if ((await page.getByTestId('jobs-advanced').count()) !== 0) fail('the advanced filters are open by default');
  await noPageOverflow('jobs');
});

await check('Jobs: a folded filter combines with the search and a tab; the button counts it; Clear clears it', async () => {
  const before = await count();
  await press(page.getByTestId('jobs-advanced-toggle'));
  await page.getByTestId('jobs-advanced').waitFor({ timeout: 5000 });
  await page.getByTestId('jobs-advanced').getByLabel('Job type').selectOption('breakdown');
  const narrowed = await count();
  if (narrowed > before) fail(`a filter widened the list (${before} → ${narrowed})`);
  const toggle = await page.getByTestId('jobs-advanced-toggle').innerText();
  if (!/1/.test(toggle)) fail(`the toggle does not count the filter: "${toggle}"`);
  await page.getByTestId('jobs-search').fill('zz-no-such-job-zz');
  if ((await count()) !== 0) fail('the search did not combine with the filter');
  await page.getByTestId('jobs-search').fill('');
  await press(page.getByTestId('jobs-clear-filters'));
  if ((await count()) !== before) fail(`Clear left ${await count()} of ${before}`);
  return `${before} → ${narrowed} → ${before}`;
});

await check('Closed Jobs: search visible, filters folded; newest finished first; a filter narrows and Clear clears', async () => {
  await go('/jobs/closed');
  await page.getByTestId('closed-search').waitFor({ timeout: 20000 });
  if ((await page.getByTestId('closed-advanced').count()) !== 0) fail('the advanced filters are open by default');
  const page1 = (await call('GET', '/api/jobs/closed?page=1')).json.data;
  const at = (row) => Date.parse(row.job.closedAt ?? row.job.invoice?.recordedAt ?? '') || 0;
  for (let index = 1; index < page1.rows.length; index += 1) {
    if (at(page1.rows[index]) > at(page1.rows[index - 1])) fail(`row ${index + 1} finished after row ${index}`);
  }
  await press(page.getByTestId('closed-advanced-toggle'));
  await page.getByTestId('closed-advanced').waitFor({ timeout: 5000 });
  await page.getByTestId('closed-outcome').selectOption('invoiced');
  const invoiced = (await call('GET', '/api/jobs/closed?outcome=invoiced')).json.data.matched;
  await page.getByText(new RegExp(`${invoiced} closed job`)).first().waitFor({ timeout: 10000 });
  await press(page.getByTestId('closed-clear'));
  await page.getByText(new RegExp(`${page1.matched} closed job`)).first().waitFor({ timeout: 10000 });
  await noPageOverflow('closed jobs');
  return `${page1.matched} archived, ${invoiced} invoiced`;
});

await check('PO-FLOW-1: a job raised with its PO is handled straight to Awaiting Invoice No', async () => {
  // EJE-1048 is a seeded job raised with PO-88123; take it to the office through the API.
  const sipho = (await call('GET', '/api/admin')).json.data.users.find((user) => user.email === 'sipho.mahlangu@eje-demo.co.za').id;
  const job = (await call('GET', '/api/jobs/EJE-1048')).json.data.view.job;
  if (job.primaryTechnicianId !== sipho) await call('POST', `/api/jobs/${job.id}/assign_primary`, { technicianId: sipho });
  await signInAs(page, 'Sipho Mahlangu', { base: BASE });
  const steps = [
    ['accept', {}],
    ['add_labour', { date: '2026-10-20', rateType: 'normal', hours: 1, description: '' }],
    ['save_report', { faultFindings: '', diagnosis: '', workPerformed: 'Replaced the fan.', recommendations: '', generalNotes: '' }],
    ['start_completion', {}],
    ['start_signature', {}],
    ['capture_signature', { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L10,10' }],
    ['issue', {}],
  ];
  for (const [action, body] of steps) {
    const answered = await call('POST', `/api/jobs/${job.id}/${action}`, body);
    if (answered.status !== 200) fail(`${action} answered ${answered.status}: ${JSON.stringify(answered.json?.error?.message ?? '')}`);
  }
  await signInAs(page, 'Elmarie Coetzee', { base: BASE });
  await go('/jobs/EJE-1048');
  const panel = page.getByTestId('office-lifecycle');
  await panel.waitFor({ timeout: 20000 });
  const said = await panel.getByTestId('handling-next-stage').innerText();
  if (!said.includes('already has PO PO-88123')) fail(`the panel says: ${said}`);
  await press(panel.getByTestId('mark-handled'));
  await panel.getByTestId('invoice-number').waitFor({ timeout: 15000 });
  const after = (await call('GET', '/api/jobs/EJE-1048')).json.data.view.job;
  if (after.status !== 'awaiting_invoice_no' || after.purchaseOrder?.number !== 'PO-88123') fail(`${after.status}, PO ${after.purchaseOrder?.number}`);
  await noPageOverflow('the office panel');
});

await check('no page threw an error', async () => {
  if (pageErrors.length > 0) fail(pageErrors.join(' | '));
});

await browser.close();
const failed = results.filter(([state]) => state === 'FAIL');
console.log(`\n${label}: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
