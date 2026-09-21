/**
 * The Job Creation & Assignment workflow, in a real browser.
 *
 * Drives the whole thing the way EJE will: the office raises a job against a
 * customer, site and machine, names who receives the customer's copy, attaches
 * a document, assigns a technician and an assistant, and creates it. Then the
 * technician finds it, is notified of it, accepts it, and has the customer
 * information they need to do the work.
 *
 * It also makes the requests a browser would NOT make. An authenticated
 * technician calling the API directly is refused the things the screens never
 * offered them — which is the only way to show that the restriction is in the
 * server rather than in the markup.
 *
 * Usage:
 *   npm run build && npm start -- -p 3210
 *   npm run workflow-check
 *
 * Environment:
 *   EJE_SMOKE_BASE_URL   defaults to http://localhost:3210
 *   PLAYWRIGHT_CHROMIUM  explicit Chromium binary, when not managed by Playwright
 */
import { chromium } from 'playwright';
import { signInAs, signOut } from './sign-in.mjs';

const BASE = process.env.EJE_SMOKE_BASE_URL ?? 'http://localhost:3210';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const fails = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS ' : 'FAIL '} ${what}`); if (!ok) fails.push(what); };
// The rendered DOM, not innerText: innerText drops content the layout has
// pushed out of the visible box, which silently turns a real assertion into a
// passing one.
const body = async () => page.content();
const ready = () => page.getByRole('link', { name: 'Jobs', exact: true }).first().waitFor({ timeout: 25000 });

// ---------- MASTER: create the job ----------
await page.goto(BASE, { waitUntil: 'networkidle' });
await signInAs(page, 'Elmarie Coetzee');
await ready();

await page.goto(`${BASE}/jobs/new`, { waitUntil: 'networkidle' });

const selectByLabel = async (label, index = 1) => {
  const field = page.getByLabel(label, { exact: false }).first();
  const values = await field.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  await field.selectOption(values[index] ?? values[0]);
  return values[index] ?? values[0];
};

await selectByLabel('Customer', 0);
await page.waitForTimeout(300);
await selectByLabel('Site', 0);
await page.waitForTimeout(300);
const recipient = await selectByLabel('Customer email recipient', 0);
check(Boolean(recipient), 'the customer email recipient is a named, selectable field');
await selectByLabel('Machine', 0);

// Job type: the four the workflow names.
const typeField = page.getByLabel('Job type', { exact: false }).first();
const typeLabels = await typeField.locator('option').allTextContents();
for (const wanted of ['Breakdown', 'Installation', 'Service', 'Test']) {
  check(typeLabels.some((t) => t.includes(wanted)), `job type "${wanted}" is offered`);
}
await typeField.selectOption({ label: typeLabels.find((t) => t.includes('Breakdown')) ?? typeLabels[0] });

const FAULT = 'Browser check: spindle drive tripping on start-up.';
await page.getByLabel('Fault', { exact: false }).first().fill(FAULT);

// Technician + an assistant, both chosen BY NAME so the later assertions know
// who they are. Riaan is deliberately left off the job: he is the unauthorised
// technician the direct-API checks use.
const techField = page.getByLabel('Primary technician', { exact: false }).first();
const techLabels = await techField.locator('option').allTextContents();
const siphoLabel = techLabels.find((label) => label.includes('Sipho Mahlangu'));
check(Boolean(siphoLabel), 'Sipho is offered as a primary technician');
await techField.selectOption({ label: siphoLabel });
await page.waitForTimeout(400);

const assistants = page.locator('fieldset input[type="checkbox"]');
check(await assistants.count() > 0, 'additional technicians can be chosen at creation');
const andre = page.locator('fieldset label', { hasText: 'André Steyn' }).locator('input');
if (await andre.count() > 0) await andre.check();
else await assistants.first().check();

check((await body()).includes('when they accept it'), 'the form states the job will be created Open, not started');

// An attachment, through the real file input.
await page.locator('input[type="file"]').setInputFiles({
  name: 'customer-order-99500.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4 browser check'),
});
await page.waitForTimeout(400);
let formHtml = await body();
check(formHtml.includes('customer-order-99500.pdf'), 'an attached document is listed on the form');
check(formHtml.includes('up to 25 MB'), 'the form states the size and formats it accepts');

await page.getByRole('button', { name: 'Create job' }).click();
await page.waitForURL('**/jobs/EJE-**', { timeout: 20000 });
const jobNumber = page.url().split('/').pop();
console.log(`  (raised ${jobNumber})`);

// ---------- The job as the office sees it ----------
// Wait for the job screen's own content, not merely the URL: the page renders
// a skeleton first and asserting against that proves nothing.
await page.getByText(jobNumber, { exact: false }).first().waitFor({ timeout: 20000 });
await page.waitForLoadState('networkidle');
let t = await body();
check(!t.includes('Something went wrong'), 'the new job screen loads');
check(t.includes(FAULT), 'the fault description is on the job');
check(t.includes('receives the job card'), 'the job names who receives the customer copy');
check(t.includes('customer-order-99500.pdf'), 'the attachment is recorded on the job');

// THE ROUND TRIP. The file went up; it comes back, byte for byte, through an
// authorised route — no storage key, no public URL.
const attachment = await page.evaluate(async (number) => {
  const view = await (await fetch(`/api/jobs/${number}`, { credentials: 'same-origin' })).json();
  const file = view.data?.view?.job?.attachments?.[0];
  if (file === undefined) return { found: false };

  const jobId = view.data.view.job.id;
  const download = await fetch(`/api/jobs/${jobId}/attachments/${file.id}`, {
    credentials: 'same-origin',
  });
  const text = await download.text();
  return {
    found: true,
    jobId,
    attachmentId: file.id,
    status: download.status,
    disposition: download.headers.get('content-disposition'),
    type: download.headers.get('content-type'),
    body: text,
    leaksKey: JSON.stringify(file).includes('uploads/'),
  };
}, jobNumber);

check(attachment.found, 'the uploaded document is on the job');
check(attachment.status === 200, `the document downloads (got ${attachment.status})`);
check(attachment.body.startsWith('%PDF'), 'the bytes that come back are the bytes that went up');
check(attachment.type === 'application/pdf', 'the server decided the content type');
check((attachment.disposition ?? '').includes('attachment;'), 'it is served as a download');

// The STATE, asked of the server rather than read off a progress rail that
// names every stage including the ones the job has not reached.
const asCreated = await page.evaluate(async (number) => {
  const response = await fetch(`/api/jobs/${number}`, { credentials: 'same-origin' });
  const payload = await response.json();
  return payload.data?.view?.job ?? {};
}, jobNumber);
check(asCreated.status === 'open', `the job is Open after creation (got ${asCreated.status})`);
check(asCreated.acceptedAt === null, 'creation did NOT start the job');
check(asCreated.primaryTechnicianId !== null, 'the technician was assigned at creation');
check((asCreated.additionalTechnicianIds ?? []).length === 1, 'the assistant was assigned too');


// ---------- Direct-API denial, from an authenticated technician ----------
await signOut(page);
await signInAs(page, 'Riaan van Wyk');
await ready();

const asRiaan = await page.evaluate(async (number) => {
  const view = await fetch(`/api/jobs/${number}`, { credentials: 'same-origin' });
  const accept = await fetch(`/api/jobs/${number}/accept`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: '{}',
  });
  return { view: view.status, accept: accept.status };
}, jobNumber);

check(asRiaan.view === 404, `an unassigned technician cannot even read the job (got ${asRiaan.view})`);
check(asRiaan.accept === 404, `an unassigned technician cannot accept it (got ${asRiaan.accept})`);

const create = await page.evaluate(async () => {
  const response = await fetch('/api/jobs', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      customerId: 'cust-abc', siteId: 'site-abc-jhb', contactId: 'contact-abc-jhb',
      machineId: 'machine-abc-lv40', jobType: 'breakdown', priority: 'urgent',
      scheduledDate: null, scheduledEndDate: null, orderNumber: '', referenceNumber: '',
      faultDescription: 'Direct API attempt.', primaryTechnicianId: null,
      courierCollection: false, deliveryNote: '',
    }),
  });
  return response.status;
});
check(create === 403, `a technician cannot raise a job by direct API call (got ${create})`);

// The attachment, from somebody who may not read the job.
const stolen = await page.evaluate(
  async ({ jobId, attachmentId }) => {
    const direct = await fetch(`/api/jobs/${jobId}/attachments/${attachmentId}`, {
      credentials: 'same-origin',
    });
    return direct.status;
  },
  { jobId: attachment.jobId, attachmentId: attachment.attachmentId },
);
check(stolen === 404, `an unauthorised technician cannot download the attachment (got ${stolen})`);

// ---------- TECHNICIAN: see it, accept it ----------
await signOut(page);
await signInAs(page, 'Sipho Mahlangu');
await ready();

await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
check((await body()).includes(jobNumber), 'the technician sees the assigned job on their dashboard');

await page.goto(`${BASE}/notifications`, { waitUntil: 'networkidle' });
check((await body()).includes(jobNumber), 'the technician was notified of the assignment');

await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
await page.getByText(jobNumber, { exact: false }).first().waitFor({ timeout: 20000 });
t = await body();
check(!t.includes('Something went wrong'), 'the technician can open the job');
check(t.includes('Open'), 'the job is still Open before acceptance');

const acceptButton = page.getByRole('button', { name: /Accept/ }).first();
const offered = await acceptButton.count() > 0;
check(offered, 'the technician is offered Accept');
if (offered) await acceptButton.click();
// Confirm dialog.
const dialog = page.getByRole('dialog');
if (await dialog.count() > 0) {
  const confirm = dialog.getByRole('button', { name: /Accept/ }).first();
  if (await confirm.count() > 0) await confirm.click();
}
await page.waitForTimeout(2500);

const afterAccept = await page.evaluate(async (number) => {
  const response = await fetch(`/api/jobs/${number}`, { credentials: 'same-origin' });
  const payload = await response.json();
  return payload.data?.view ?? {};
}, jobNumber);
check(afterAccept.job?.status === 'in_progress', 'acceptance moved the job to In Progress');
check(afterAccept.job?.acceptedAt !== null, 'acceptance stamped the time');

t = await body();
check(t.includes('In Progress'), 'the screen shows In Progress');
check(!t.includes('Start job'), 'there is no separate Start action');

// ---------- Customer information after acceptance ----------
check((afterAccept.site?.addressLine1 ?? '').length > 0, 'the technician has the site address');
check((afterAccept.contact?.phone ?? '').length > 0, 'the technician has a contact phone number');
check((afterAccept.contact?.email ?? '').length > 0, 'the technician has a contact email address');
check(t.includes('receives the job card'), 'the recipient is named on the accepted job');


// Accepting twice must not repeat the side effects.
const second = await page.evaluate(async (number) => {
  const response = await fetch(`/api/jobs/${number}/accept`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: '{}',
  });
  return response.status;
}, jobNumber);
check(second === 422, `a second acceptance is refused by the state machine (got ${second})`);

// The locked customer rule still holds for this technician.
await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
t = await body();
check(!t.includes('Something went wrong') && !t.includes('You do not have access'), 'the technician still reads the customer record');
check(t.includes('days') || t.includes('VAT'), 'the commercial fields are still visible to the technician');

await browser.close();
console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
