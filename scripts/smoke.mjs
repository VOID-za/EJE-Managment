/**
 * End-to-end smoke test for the EJE demonstration system.
 *
 * Drives a real browser through the whole job-card journey — sign in, accept,
 * capture labour, write up, sign, review and submit — then checks the
 * simulated outbox, the read-only state of a closed job, the checklist gate,
 * search, the library and the tablet layout.
 *
 * Usage:
 *   npm run build && npm start -- -p 3210
 *   npm run smoke
 *
 * Environment:
 *   EJE_SMOKE_BASE_URL   defaults to http://localhost:3210
 *   EJE_SMOKE_SHOTS      directory for screenshots, defaults to ./.smoke
 *   PLAYWRIGHT_CHROMIUM  explicit Chromium binary, when not managed by Playwright
 */
import { mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { resetDemonstration, signInAs, signOut as signOutOf } from './sign-in.mjs';

/*
 * ONE VARIABLE CAN POINT EVERY GATE AT ONE SERVER. 23 October 2026.
 *
 * This read `EJE_SMOKE_BASE_URL` and nothing else, and defaulted to port 3210
 * while `check-routes`, `e2e`, `tablet-pdf-check` and `responsive-check` all
 * default to 3000 and all accept `EJE_E2E_URL`. A runner that started one
 * server and exported `EJE_E2E_URL` therefore ran four gates against it and
 * sent this one to a port with nothing on it — ERR_CONNECTION_REFUSED, which
 * reads as a failure of the application. WORSE: if anything IS listening on
 * 3210, this gate silently tests that instead, which can be a stale build.
 *
 * `EJE_SMOKE_BASE_URL` still wins where it is set, so nothing that uses it
 * changes.
 */
const BASE =
  process.env.EJE_SMOKE_BASE_URL ?? process.env.EJE_E2E_URL ?? 'http://localhost:3210';

/**
 * A calendar date IN THE BUSINESS ZONE, offset by `days`.
 *
 * The zone matters, and getting it from the runner's clock was a real defect
 * (QA-5's shape). Every rule that asks "is this person away today?" asks it of
 * the business date — South African time — so a script that typed the runner's
 * own date into an availability dialog disagreed with the server for two hours
 * out of every twenty-four on a machine running UTC: the takeover step passed
 * all day and failed between 22:00 and midnight, which reads as a flake.
 */
const businessDate = (days = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
};
const shots = process.argv[2] ?? process.env.EJE_SMOKE_SHOTS ?? '.smoke';
mkdirSync(shots, { recursive: true });
const errors = [];
const log = (m) => console.log(m);

const executablePath = process.env.PLAYWRIGHT_CHROMIUM;
const browser = await chromium.launch(
  executablePath === undefined ? {} : { executablePath },
);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

/*
 * A REFUSAL IS NOT A CONSOLE ERROR.
 *
 * The browser logs every non-2xx fetch as "Failed to load resource", and the
 * application now asks a server for everything — so a refused sign-in, a
 * validation failure the screen renders, a job the actor may not read and a
 * first visit with no session all produce one. Each is the API working
 * correctly, and each is asserted where it happens.
 *
 * 5xx is NOT on this list: an internal error is a fault, and these suites must
 * keep failing on one.
 */
const EXPECTED_HTTP = /Failed to load resource:.*status of (400|401|403|404|409|422|429)\b/;

/*
 * THE ONE PLACE A TRANSPORT FAILURE IS EXPECTED.
 *
 * The PWA checks at the end of this file take the browser offline on purpose,
 * and a request that cannot leave the machine logs `ERR_INTERNET_DISCONNECTED`
 * rather than an HTTP status. That is the condition under test, so it is
 * allowed for exactly as long as the suite is holding the network down — and
 * nowhere else, because outside that window it is a real fault.
 */
const OFFLINE_TRANSPORT =
  /net::ERR_INTERNET_DISCONNECTED|net::ERR_NETWORK_CHANGED|Failed to fetch/;
let offlineExpected = false;

page.on('console', (msg) => {
  if (msg.type() !== 'error') return;
  const text = msg.text();
  if (EXPECTED_HTTP.test(text)) return;
  if (offlineExpected && OFFLINE_TRANSPORT.test(text)) return;
  errors.push(`console: ${text}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

const step = async (name, fn) => {
  const before = errors.length;
  try {
    await fn();
    log(`PASS  ${name}`);
  } catch (e) {
    log(`FAIL  ${name} :: ${e.message}`);
    errors.push(`${name}: ${e.message}`);
  }
  // Attribute any console or page error to the step that provoked it, so a
  // summary line is something a person can act on rather than hunt for.
  for (let index = before; index < errors.length; index += 1) {
    if (/^(console|pageerror):/.test(errors[index])) {
      errors[index] = `${errors[index]}  [during: ${name}]`;
    }
  }
};

/**
 * Signing out now lives in the top-right profile menu, not the sidebar.
 *
 * The sidebar carries navigation and nothing else, so every sign-out goes
 * through the menu — which is also what proves the menu works.
 */
const signOut = () => signOutOf(page, 10000);

/**
 * A REAL, DECODABLE PNG, built here rather than committed as a fixture. PWA-3.
 *
 * It has to be decodable, not merely well-signed: the panel renders the
 * photograph it captured and the browser only shows an image it can decode, so
 * a file with a valid header and no pixels in it would fail in the one place
 * these checks are looking. Four pixels, coloured from the caption, so two
 * photographs differ byte for byte.
 */
const pngBytes = (label) => {
  const table = [...Array(256).keys()].map((n) => {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const name = Buffer.from(type, 'ascii');
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };

  const side = 2;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // 8 bits per channel
  header[9] = 2; // truecolour RGB

  const colour = [0, 1, 2].map(
    (offset) => (label.charCodeAt(offset % label.length) * 7 + offset * 40) % 256,
  );
  const rows = [];
  for (let y = 0; y < side; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < side; x += 1) rows.push(Buffer.from(colour));
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/**
 * Attaches a photograph the way a technician does on a tablet.
 *
 * The file goes into the hidden gallery input, which is what the "Choose
 * photo" button clicks; the camera input is the same element with
 * `capture="environment"`, and a headless browser has no camera to drive. The
 * modal then shows the frame before it is sent, which is asserted here because
 * a preview nobody checks is how a thumb over the lens reaches a customer.
 */
const attachPhoto = async (caption, visibility) => {
  await page.setInputFiles('[data-testid="job-photo-gallery"]', {
    name: `${caption.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`,
    mimeType: 'image/png',
    buffer: pngBytes(caption),
  });

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });
  await dialog.locator('[data-testid="job-photo-preview"]').waitFor({ timeout: 8000 });
  await dialog.getByLabel('Caption').fill(caption);
  if (visibility !== undefined) {
    await dialog.getByLabel('Who it is for').selectOption(visibility);
  }
  await dialog.getByRole('button', { name: 'Attach photo' }).click();
  await page.getByText(caption).first().waitFor({ timeout: 15000 });
};

const signInAsMasterIfNeeded = async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const heading = await page.locator('h1').first().innerText().catch(() => '');
  if (heading.includes('Elmarie')) return;
  await signInAs(page, 'Elmarie Coetzee', { greeting: /Good day, Elmarie/, timeout: 15000 });
};

/*
 * A clean demonstration, first.
 *
 * The store is the SERVER'S now, so a second run would open on the first run's
 * work. This is the one step that must succeed before any other means anything.
 */
await step('the demonstration data is reset to its seeded state', async () => {
  await resetDemonstration(page, BASE);
});

await step('sign in page renders', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 10000 });
});

/*
 * WHAT THIS STEP REPLACES.
 *
 * It used to assert the identity picker: three role tabs and a list of people,
 * one click to become any of them. That is gone, and what replaced it is worth
 * asserting in its place — an email address, a password, no role selector, and
 * a server that refuses the wrong one.
 */
await step('the sign-in screen asks for a password and offers no role', async () => {
  await page.getByLabel('Email address').waitFor({ timeout: 8000 });
  await page.getByLabel('Password').waitFor({ timeout: 8000 });

  for (const role of ['Master', 'Coordinator', 'Technician']) {
    if ((await page.getByRole('tab', { name: role }).count()) > 0) {
      throw new Error(`the sign-in screen still offers a ${role} role to pick`);
    }
  }
});

/**
 * Submits the sign-in form and returns what the screen said.
 *
 * Waits for the ANSWER rather than reading straight after the click: the
 * verification is an Argon2id hash on the server, deliberately slow, and the
 * form is busy until it comes back. Reading early gets the empty live region,
 * and clicking again while it is busy gets nothing at all.
 */
const attemptSignIn = async (email, password) => {
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="alert"]')].some(
        (node) => (node.textContent ?? '').trim().length > 0,
      ),
    null,
    { timeout: 20000 },
  );

  return (await page.getByRole('alert').allInnerTexts()).join(' ').trim();
};

await step('a wrong password is refused, and says nothing about the account', async () => {
  const message = await attemptSignIn('sipho.mahlangu@eje-demo.co.za', 'not-the-password');

  if (!/do not match/i.test(message)) {
    throw new Error(`unexpected sign-in refusal: ${message}`);
  }
  if (/locked|disabled|no such|does not exist/i.test(message)) {
    throw new Error(`the refusal discloses account state: ${message}`);
  }
  // Still at the gate.
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 5000 });
});

await step('an unknown address is refused in exactly the same words', async () => {
  const message = await attemptSignIn('nobody@eje-demo.co.za', 'not-the-password');

  if (!/do not match/i.test(message)) {
    throw new Error(`an unknown address was answered differently: ${message}`);
  }
});

await step('the API refuses an unauthenticated request', async () => {
  const result = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/jobs`, { credentials: 'omit' });
    return { status: response.status, body: await response.text() };
  }, BASE);

  if (result.status !== 401) {
    throw new Error(`GET /api/jobs without a session answered ${result.status}`);
  }
  if (/argon2|password|token/i.test(result.body)) {
    throw new Error('the refusal body mentions a credential');
  }
});

await step('no session token is readable from the browser', async () => {
  const cookies = await page.evaluate(() => document.cookie);
  if (cookies.includes('eje_session')) {
    throw new Error('the session cookie is readable by script — it must be HttpOnly');
  }
  const stored = await page.evaluate(() => {
    const read = (store) => {
      const out = {};
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        out[key] = store.getItem(key);
      }
      return out;
    };
    return { local: read(window.localStorage), session: read(window.sessionStorage) };
  });

  // The theme preference is a per-viewer convenience and is allowed; anything
  // that looks like an identity is not.
  const entries = [
    ...Object.entries(stored.local),
    ...Object.entries(stored.session),
  ].filter(([key]) => key !== 'eje.theme');

  for (const [key, value] of entries) {
    if (/session|token|user|password|auth|identity/i.test(`${key} ${value}`)) {
      throw new Error(`authentication state was found in browser storage: ${key}=${value}`);
    }
  }
});

await step('sign in as technician Sipho Mahlangu', async () => {
  await signInAs(page, 'Sipho Mahlangu');
  await page.getByRole('heading', { name: /Hello, Sipho/ }).waitFor({ timeout: 10000 });
});

await step('technician dashboard shows assigned work', async () => {
  await page.getByText('My Jobs').first().waitFor({ timeout: 8000 });
  await page.getByText('EJE-1048').first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/01-tech-dashboard.png`, fullPage: false });
});

await step('EJE-1048 is waiting for acceptance on the technician dashboard', async () => {
  await page.getByText('Waiting for you to accept').waitFor({ timeout: 8000 });
});

await step('open job EJE-1048', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1048' }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/02-job-detail.png`, fullPage: false });
});

await step('capturing work is blocked before the job is accepted', async () => {
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  if (await page.getByRole('button', { name: 'Add labour' }).first().isVisible()) {
    throw new Error('Labour capture should not be offered on an unaccepted job');
  }
  await page.getByRole('tab', { name: 'Overview' }).click();
});

await step('acceptance requires confirmation and starts the job', async () => {
  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByText('there is no separate start step', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByText('In Progress').first().waitFor({ timeout: 10000 });
});

await step('acceptance then OFFERS the site location, rather than sending it', async () => {
  await page.getByRole('heading', { name: 'Send Site Location?' }).waitFor({ timeout: 8000 });
  /*
   * WHERE IT GOES, SAID ON THE PROMPT. WHATSAPP-1: the destination used to be
   * an optional field in the request body — a way to send an EJE-branded
   * template to any number — and is now the actor's own, from their account.
   */
  await page
    .getByText('Would you like the site location sent to your own WhatsApp number?', {
      exact: false,
    })
    .waitFor({ timeout: 5000 });

  // The preview must carry everything the technician needs, and a maps link.
  const preview = await page.locator('pre').first().innerText();
  for (const fragment of [
    'EJE-1048',
    'ABC Engineering (Pty) Ltd',
    'Leadwell V-40',
    'Johannesburg',
    'https://www.google.com/maps/dir/?api=1&destination=',
  ]) {
    if (!preview.includes(fragment)) {
      throw new Error(`site location preview missing ${fragment}`);
    }
  }
  await page.screenshot({ path: `${shots}/13-site-location-prompt.png`, fullPage: false });
});

await step('"No, Thanks" sends nothing and leaves the job in progress', async () => {
  await page.getByRole('button', { name: 'No, Thanks' }).click();
  await page.getByRole('heading', { name: 'Send Site Location?' }).waitFor({
    state: 'hidden',
    timeout: 8000,
  });
  await page.getByText('In Progress').first().waitFor({ timeout: 8000 });

  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  const whatsappEntries = await page.getByText('Template: eje_site_location').count();
  if (whatsappEntries !== 0) throw new Error('declining still queued a WhatsApp message');
});

await step('declining is recorded on the job activity trail', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('Site location not requested').first().waitFor({ timeout: 8000 });
});

/*
 * The other half of the site-location prompt: choosing to send it.
 *
 * AS LERATO, deliberately. EJE-1058 is seeded as HER job — she has the
 * "New job assigned" notification for it — and under DECISION 5 a technician
 * reads the open pool, their own work, what they have participated in and the
 * finished history of machines they have worked, and nothing else. Sipho used
 * to be able to open and accept somebody else's live job by typing its URL;
 * that is precisely the hole the decision closes, so the step signs in as the
 * technician whose job it actually is.
 */
await step('signing in as the technician whose second job it is', async () => {
  await signOut();
  await signInAs(page, 'Lerato Dlamini');
  // Signing in returns you to the page you were on, which here is a job screen
  // rather than the dashboard — so the greeting is asked for where it lives.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Hello, Lerato/ }).waitFor({ timeout: 15000 });
});

await step('accepting a second job and choosing "Send Location" queues one message', async () => {
  await page.goto(`${BASE}/jobs/EJE-1058`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByRole('heading', { name: 'Send Site Location?' }).waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: 'Send Location' }).click();
  await page.getByRole('heading', { name: 'Send Site Location?' }).waitFor({
    state: 'hidden',
    timeout: 8000,
  });
  await page.getByText('Site location queued', { exact: false }).waitFor({ timeout: 8000 });
  /*
   * QUEUED IS NOT SENT, and the screen has to say which it is. WHATSAPP-1: the
   * message is written to the outbox with the request and handed to the
   * provider afterwards, so a screen claiming it was sent would be claiming
   * something nothing had established yet.
   */
  const outcome = await page.locator('main').innerText();
  if (!/Queued is not sent/i.test(outcome)) {
    throw new Error(`the outcome claims more than it knows: ${outcome.slice(0, 300)}`);
  }

  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('Site location requested via WhatsApp').first().waitFor({ timeout: 8000 });
});

/*
 * THIS STEP USED TO READ THE OUTBOX AS THE TECHNICIAN, and the server refuses
 * that: Master Scope SEC-1 — "Technicians cannot access customer
 * correspondence" — and `/api/outbox` answers 403 with "The outbox is an
 * office screen." The queued message is still the thing being checked; the
 * office is who checks it.
 */
await step('a technician cannot read the outbox at all', async () => {
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  if ((await page.getByText('Template: eje_site_location').count()) !== 0) {
    throw new Error('a technician was shown customer correspondence');
  }
});

/*
 * THE TECHNICIAN REPORTS THAT THE REGISTER IS WRONG, AND THE OFFICE DECIDES.
 * CUST-CR.
 *
 * The application has told technicians for months that they may do this —
 * "Technicians can view customers and raise change requests, but not edit
 * them" — and there was nowhere to do it. Both halves are checked in a real
 * browser because the whole feature is about who may do what: a technician can
 * raise one and cannot read anybody else's, and the office sees it, decides,
 * and has to say what they did.
 */
const REPORTED = 'The serial plate on this machine reads MZ-QT200-11903, not what the register has.';

await step('a technician reports a problem with a record they cannot edit', async () => {
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByTestId('report-register-problem').waitFor({ timeout: 10000 });

  // The panel the office acts on must NOT be here: that somebody complained
  // about a record is not a technician's to read.
  if ((await page.getByTestId('change-requests-panel').count()) !== 0) {
    throw new Error('a technician was shown the office’s reported-problems panel');
  }

  await page.getByTestId('report-register-problem').click();
  await page.getByTestId('change-request-details').fill(REPORTED);
  await page.getByTestId('change-request-submit').click();
  await page.getByTestId('change-request-details').waitFor({ state: 'hidden', timeout: 10000 });
});

await step('the office sees the report, and the technician’s own copy says it is waiting', async () => {
  const mine = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/change-requests?mine=1`);
    const payload = await response.json();
    return { status: response.status, rows: payload?.data?.rows ?? [] };
  }, BASE);
  if (mine.status !== 200) throw new Error(`a technician could not read their own reports: ${mine.status}`);
  if (mine.rows.length !== 1) throw new Error(`the technician has ${mine.rows.length} reports, expected 1`);
  if (mine.rows[0].state !== 'open') throw new Error('the report did not arrive as open');

  // And the office's list is refused to them outright, rather than answered
  // empty — an empty list reads as "there are no problems with the register".
  const refused = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/change-requests`);
    return response.status;
  }, BASE);
  if (refused !== 403) throw new Error(`the office list answered a technician HTTP ${refused}`);
});

await step('the office records what it did about the report', async () => {
  await signOut();
  await signInAsMasterIfNeeded();
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });

  const panel = page.getByTestId('change-requests-panel');
  await panel.waitFor({ timeout: 10000 });
  const text = await panel.innerText();
  if (!text.includes('MZ-QT200-11903')) {
    throw new Error(`the office cannot see what was reported: ${text.slice(0, 200)}`);
  }

  await page.getByTestId('change-request-apply').first().click();
  await page.getByTestId('change-request-note').fill('Serial corrected on the machine record.');
  await page.getByTestId('change-request-decision-confirm').click();

  await page.getByTestId('change-request-resolution').first().waitFor({ timeout: 10000 });
  const resolved = await page.getByTestId('change-requests-panel').innerText();
  if (!resolved.includes('Applied by the office')) {
    throw new Error('the decision was not shown against the report');
  }
  if (!resolved.includes('Serial corrected on the machine record.')) {
    throw new Error('the office’s own words are not kept with the decision');
  }
  // Nothing is offered twice: the decision stands.
  if ((await page.getByTestId('change-request-apply').count()) !== 0) {
    throw new Error('a report that was dealt with is still offering a decision');
  }
  await page.screenshot({ path: `${shots}/14a-change-request.png`, fullPage: false });
});

/**
 * A FILE FILED AGAINST A CUSTOMER. October mandate §4.
 *
 * The customer register carried no files at all: the signed service agreement
 * and the credit application lived in somebody's mailbox. This is the whole
 * path in a browser — choose a real file, upload it, see it on the customer's
 * own screen, and fetch the exact bytes back through the authorised route.
 */
await step('the office files a document against a customer, and gets those bytes back', async () => {
  await signOut();
  await signInAsMasterIfNeeded();
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });

  /*
   * ON THE "NOTES & DOCUMENTS" TAB, since Customers §2.
   *
   * The panel used to be on Overview while the tab named for it showed a
   * hard-coded "storage is simulated" empty state. Both real panels are on
   * that tab now, so this step goes where a person would go.
   */
  await page.getByRole('tab', { name: 'Notes & Documents' }).click();

  const panel = page.getByTestId('customer-documents-empty');
  await panel.waitFor({ timeout: 10000 });

  const body = '%PDF-1.4\nABC Engineering service agreement 2026\n%%EOF';
  await page.getByTestId('customer-document-caption').fill('Signed service agreement, 2026');
  // The hidden input behind the button, which a headless browser can set
  // directly — the button is what a person taps and what the responsive gate
  // measures.
  await page.getByTestId('customer-document-file').setInputFiles({
    name: 'abc-service-agreement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(body, 'utf8'),
  });

  // The row appears because the list was re-read from the server, not because
  // this component hoped the upload worked.
  await page.getByTestId('customer-document-row').first().waitFor({ timeout: 15000 });
  const row = await page.getByTestId('customer-documents').innerText();
  if (!row.includes('abc-service-agreement.pdf')) {
    throw new Error(`the document is not on the customer's screen: ${row.slice(0, 200)}`);
  }
  if (!row.includes('Signed service agreement, 2026')) {
    throw new Error('the description was not kept with the document');
  }
  // A genuine upload carries no SIMULATED badge — §1's label means something
  // only because real records do not get it.
  if ((await page.getByTestId('customer-documents').getByTestId('simulated-badge').count()) !== 0) {
    throw new Error('a document somebody really uploaded is labelled as demonstration data');
  }

  // THE BYTES, through the authorised route, read inside the page.
  const href = await page.getByTestId('customer-document-download').first().getAttribute('href');
  const fetched = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    return { status: response.status, text: await response.text() };
  }, href);
  if (fetched.status !== 200) {
    throw new Error(`the download answered HTTP ${fetched.status}`);
  }
  if (fetched.text !== body) {
    throw new Error('the bytes that came back are not the bytes that went in');
  }
  await page.screenshot({ path: `${shots}/14b-customer-document.png`, fullPage: false });
});

await step('a technician READS the customer register’s files and cannot change them', async () => {
  /*
   * CUST-DOC-2, the owner's decision of 23 October 2026. This step asserted
   * the opposite — a 403 at both ends — for three releases, deliberately,
   * because whether a technician should see a customer's paperwork was a
   * question recorded rather than guessed at. They answered it: a technician
   * may VIEW AND DOWNLOAD what is filed against a customer. Filing and
   * withdrawing are still the office's.
   */
  await signOut();
  await signInAs(page, 'Sipho Mahlangu');

  const asked = await page.evaluate(async (base) => {
    const list = await fetch(`${base}/api/customers/cust-abc/documents`, {
      credentials: 'include',
    });
    const body = list.ok ? await list.json() : null;
    const documents = body?.data?.documents ?? [];
    const first = documents[0] ?? null;

    // THE BYTES, through the technician's own session.
    const file =
      first === null
        ? null
        : await fetch(`${base}/api/customers/cust-abc/documents/${first.id}`, {
            credentials: 'include',
          });

    // And the writes, which the decision did NOT widen.
    const withdrawn =
      first === null
        ? null
        : await fetch(`${base}/api/customers/cust-abc/documents/${first.id}/withdraw`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });

    return {
      list: list.status,
      count: documents.length,
      hasKey: documents.some((document) => 'storageKey' in document),
      file: file === null ? null : file.status,
      fileLength: file === null || !file.ok ? 0 : (await file.arrayBuffer()).byteLength,
      withdraw: withdrawn === null ? null : withdrawn.status,
    };
  }, BASE);

  if (asked.list !== 200) {
    throw new Error(`the customer document list answered a technician HTTP ${asked.list}`);
  }
  if (asked.count === 0) throw new Error('the technician was sent no customer documents');
  if (asked.hasKey) throw new Error('a storage key reached a technician’s browser');
  if (asked.file !== 200) {
    throw new Error(`the technician's download answered HTTP ${asked.file}`);
  }
  if (asked.fileLength === 0) throw new Error('the technician’s download carried no bytes');
  if (asked.withdraw !== 403) {
    throw new Error(`a technician's withdrawal answered HTTP ${asked.withdraw}, not 403`);
  }

  // And their own customer screen shows them, with no control to change them.
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Notes & Documents' }).click();
  await page.getByTestId('customer-document-row').first().waitFor({ timeout: 10000 });
  if ((await page.getByTestId('customer-document-choose').count()) !== 0) {
    throw new Error('a technician is being offered the document uploader');
  }
  if ((await page.getByTestId('customer-document-withdraw').count()) !== 0) {
    throw new Error('a technician is being offered Withdraw');
  }
  if ((await page.getByTestId('customer-document-download').count()) === 0) {
    throw new Error('a technician is not offered the download');
  }
});

/**
 * PAPER ABOUT ONE MACHINE, AND THE AUDIENCE THAT DECIDES WHO READS IT.
 * October mandate §4.
 *
 * Two documents on the same machine: one marked for the FIELD and one kept to
 * the OFFICE. The next step signs in as the technician and proves that the
 * first is readable and the second is not even in the response — which is the
 * only assertion that matters, because a screen that hides a row still
 * received it.
 */
await step('the office files two documents against a machine, one for the field', async () => {
  await signOut();
  await signInAsMasterIfNeeded();
  await page.goto(`${BASE}/machines/machine-abc-lv40`, { waitUntil: 'networkidle' });

  await page.getByTestId('machine-documents-empty').waitFor({ timeout: 10000 });

  const manual = '%PDF-1.4\nLeadwell V-40 commissioning report\n%%EOF';
  await page.getByTestId('machine-document-caption').fill('Commissioning report, 2019');
  await page.getByTestId('machine-document-audience-field').click();
  await page.getByTestId('machine-document-file').setInputFiles({
    name: 'lv40-commissioning.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(manual, 'utf8'),
  });
  await page.getByTestId('machine-document-row').first().waitFor({ timeout: 15000 });

  const invoice = '%PDF-1.4\nSupplier invoice for the machine\n%%EOF';
  await page.getByTestId('machine-document-caption').fill('Supplier invoice');
  await page.getByTestId('machine-document-audience-office_only').click();
  await page.getByTestId('machine-document-file').setInputFiles({
    name: 'lv40-supplier-invoice.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(invoice, 'utf8'),
  });
  await page
    .getByTestId('machine-document-row')
    .nth(1)
    .waitFor({ timeout: 15000 });

  const listed = await page.getByTestId('machine-documents').innerText();
  if (!listed.includes('lv40-commissioning.pdf') || !listed.includes('lv40-supplier-invoice.pdf')) {
    throw new Error(`both documents are not on the machine's screen: ${listed.slice(0, 200)}`);
  }
  // The office is told which is which, because the office is the one who can
  // get it wrong: a manual left office-only is a technician telephoning in.
  if (!listed.includes('Readable in the field') || !listed.includes('Office only')) {
    throw new Error('the office cannot see which documents the field may read');
  }
  // A genuine upload carries no SIMULATED badge.
  if ((await page.getByTestId('machine-documents').getByTestId('simulated-badge').count()) !== 0) {
    throw new Error('a document somebody really uploaded is labelled as demonstration data');
  }

  await page.screenshot({ path: `${shots}/14c-machine-documents.png`, fullPage: false });
});

await step('a technician reads the FIELD document and never sees the office-only one', async () => {
  await signOut();
  await signInAs(page, 'Sipho Mahlangu');

  // THE SERVER'S ANSWER, asked for by a technician's own browser.
  const listed = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/machines/machine-abc-lv40/documents`, {
      credentials: 'include',
    });
    return { status: response.status, body: await response.json() };
  }, BASE);
  if (listed.status !== 200) {
    throw new Error(`the machine document list answered a technician HTTP ${listed.status}`);
  }
  const names = (listed.body?.data?.documents ?? []).map((row) => row.fileName);
  if (names.length !== 1 || names[0] !== 'lv40-commissioning.pdf') {
    throw new Error(`a technician's own list is wrong: ${JSON.stringify(names)}`);
  }

  // The field document's BYTES, through the authorised route.
  await page.goto(`${BASE}/machines/machine-abc-lv40`, { waitUntil: 'networkidle' });
  await page.getByTestId('machine-document-row').first().waitFor({ timeout: 15000 });
  const href = await page.getByTestId('machine-document-download').first().getAttribute('href');
  const fetched = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'include' });
    return { status: response.status, text: await response.text() };
  }, href);
  if (fetched.status !== 200) {
    throw new Error(`the field document answered a technician HTTP ${fetched.status}`);
  }
  if (!fetched.text.includes('commissioning report')) {
    throw new Error('the bytes that came back are not the bytes that went in');
  }

  // And the technician is offered no upload and no withdrawal: the register is
  // the office's, and the screen says the same thing the server does.
  if ((await page.getByTestId('machine-document-choose').count()) !== 0) {
    throw new Error('a technician is being offered the machine-document upload');
  }
  if ((await page.getByTestId('machine-document-withdraw').count()) !== 0) {
    throw new Error('a technician is being offered to withdraw a machine document');
  }
});

await step('the queued WhatsApp message appears in the office Simulated Outbox', async () => {
  await signOut();
  await signInAsMasterIfNeeded();
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  await page.getByText('Template: eje_site_location').first().waitFor({ timeout: 8000 });
  await page.getByText('Nothing in this list was sent').waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${shots}/14-site-location-outbox.png`, fullPage: false });
});

await step('back to EJE-1048 to continue the main journey', async () => {
  await signOut();
  await signInAs(page, 'Sipho Mahlangu');
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Hello, Sipho/ }).waitFor({ timeout: 15000 });

  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1048' }).waitFor({ timeout: 8000 });
});

await step('add labour to EJE-1048', async () => {
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: '2', exact: true }).click();
  /*
   * NO DESCRIPTION IS ASKED FOR. MASTER SCOPE LAB-1.
   *
   * A labour line is hours at a rate; what was done is the completion
   * write-up, which is the formal record printed on the customer's job card.
   * Asking twice put two accounts of the same work on one document.
   */
  if ((await page.getByLabel('Description of work').count()) !== 0) {
    throw new Error('the labour dialog still asks for a description of work');
  }
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Normal Time').first().waitFor({ timeout: 8000 });
});

await step('the technician adds the part they fitted', async () => {
  await page.getByRole('button', { name: 'Add part' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Part number').fill('FAN-24V-80');
  await dialog.getByLabel('Description').fill('Spindle drive cooling fan');
  await dialog.getByLabel(/Unit price/).fill('485');
  await dialog.getByRole('button', { name: 'Add part' }).click();
  await page.getByText('FAN-24V-80').first().waitFor({ timeout: 8000 });
});

await step('labour line is priced', async () => {
  // 2 hrs at R950.00 normal time = R1 900.00
  await page.getByText(/R\u00a01\u00a0900,00/).first().waitFor({ timeout: 8000 });
});

await step('write completion report', async () => {
  await page.getByRole('tab', { name: 'Completion' }).click();
  await page.getByLabel(/Work performed/).fill(
    'Replaced the seized spindle drive cooling fan, cleared alarm 750 and test ran the machine.',
  );
  // THE WRITE-UP SAVES ITSELF. MASTER SCOPE WRITEUP-1 — there is no Save
  // write-up button; the panel says Saved on its own once the typing stops.
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });
});

await step('Complete job opens the guided close-out, not just a status change', async () => {
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Step 1 of', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByText('Complete job EJE-1048', { exact: false }).waitFor({ timeout: 8000 });
  // The customer and machine stay on screen throughout: the tablet gets handed
  // over, and whoever holds it has to be able to see whose machine this is.
  await page.getByText('ABC Engineering (Pty) Ltd').first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/03-wizard-completion.png`, fullPage: false });
});

await step('a breakdown is given no checklist step, and no collection step', async () => {
  const rail = page.locator('ol').filter({ hasText: 'Completion' }).last();
  const names = (await rail.locator('li').allInnerTexts()).map((line) =>
    line.replace(/^\d+\s*/, '').trim(),
  );
  // Completion, Review, Customer signature, Signed. A breakdown has no
  // checklist, and nobody collects it from a counter.
  if (names.length !== 4) throw new Error(`${names.length} steps: ${names.join(' | ')}`);
  if (names.some((name) => /checklist/i.test(name))) {
    throw new Error('a breakdown was given a checklist step');
  }
  if (names.some((name) => /collection/i.test(name))) {
    throw new Error('a breakdown was given a collection step');
  }
});

await step('the completion step carries the job photographs', async () => {
  /*
   * REAL FILES NOW. PWA-3.
   *
   * This step used to click "Add photo" and fill in a caption, because that is
   * all the panel did — a JSON body with an invented file name and no file
   * anywhere. It now chooses an actual JPEG, which is what the camera and the
   * gallery both hand the page, and the bytes go to the server.
   */
  await page.getByRole('button', { name: 'Take photo', exact: true }).waitFor({ timeout: 10000 });
  await page.getByText('No photos attached').first().waitFor({ timeout: 8000 });

  for (const caption of ['Failed cooling fan, as found', 'New fan fitted and running']) {
    await attachPhoto(caption);
  }

  // Both of them, as photographs rather than placeholders.
  await page.getByRole('heading', { name: /^Photos/ }).first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/31-wizard-photos.png`, fullPage: false });
});

await step('a captured photograph is served back, and it is the photograph', async () => {
  /*
   * THE ASSERTION THAT WOULD HAVE CAUGHT THE OLD BEHAVIOUR. A tile rendered
   * from an attachment row proves nothing — the old panel drew one over a
   * storage key with nothing behind it. This waits for the browser to DECODE
   * the bytes it fetched from `/api/jobs/:id/media/:id`: `naturalWidth` is
   * non-zero only if real image data arrived through the authenticated route.
   */
  const thumbnail = page.locator('[data-testid="job-photo-thumbnail"]').first();
  await thumbnail.waitFor({ timeout: 10000 });
  await page.waitForFunction(
    () => {
      const image = document.querySelector('[data-testid="job-photo-thumbnail"]');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    },
    undefined,
    { timeout: 15000 },
  );
});

await step('a photograph taken by mistake can be removed before signature', async () => {
  await page
    .getByRole('button', { name: 'Remove New fan fitted and running' })
    .click({ timeout: 10000 });
  await page.getByText('New fan fitted and running').first().waitFor({
    state: 'detached',
    timeout: 10000,
  });

  // The one that was right is still there.
  await page.getByText('Failed cooling fan, as found').first().waitFor({ timeout: 8000 });
});

await step('the photographs are on the job, not only in the wizard', async () => {
  // Same attachment system: the close-out writes to the job's own photo panel.
  await page.getByRole('button', { name: 'Leave the wizard' }).click();
  await page.getByRole('tab', { name: 'Photos' }).click();
  await page.getByText('Failed cooling fan, as found').first().waitFor({ timeout: 10000 });

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Continue completing' }).click();
  await page.getByText('Step 1 of 4', { exact: false }).waitFor({ timeout: 15000 });
});

await step('the three non-functional blocks are gone from the completion step', async () => {
  const body = await page.locator('main').innerText();
  for (const gone of [
    'No labour captured',
    'Add the hours worked on this job, split by normal, overtime and double time.',
    'No travel captured',
    'Travel is charged per kilometre. Capture the distance for each trip.',
    'No parts used',
    'Capture every part fitted, with its part number, quantity and unit price.',
  ]) {
    if (body.includes(gone)) throw new Error(`still rendered: "${gone}"`);
  }
});

await step('the wizard shows the review, with what was captured and nothing empty', async () => {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ready for the customer').waitFor({ timeout: 15000 });

  const card = page.locator('section').filter({ hasText: 'Ready for the customer' }).last();
  const body = await card.innerText();
  if (!body.includes('Replaced the seized spindle drive cooling fan')) {
    throw new Error('the write-up is not on the review step');
  }
  if (!/labour/i.test(body)) throw new Error('captured labour is not on the review step');
  // The part fitted earlier is listed, because it was actually captured.
  if (!body.includes('FAN-24V-80')) throw new Error('the fitted part is not on the review step');
  // No travel was captured on this job, so that section is simply absent —
  // there is no empty block explaining what could have been entered.
  if (/travel/i.test(body)) throw new Error('an empty Travel section was rendered');
});

await step('Back keeps everything that was entered', async () => {
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByText('Step 1 of', { exact: false }).waitFor({ timeout: 10000 });
  const value = await page.getByLabel(/Work performed/).inputValue();
  if (!value.includes('Replaced the seized spindle drive cooling fan')) {
    throw new Error('going back lost the write-up');
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ready for the customer').waitFor({ timeout: 15000 });
});

/*
 * THIS STEP USED TO ASSERT A PDF PREVIEW ON THE REVIEW STEP, and it is now the
 * opposite. Master Scope REV-1: the Review step is a VERIFICATION summary, and
 * on a tablet the embedded document buried the very thing being verified. The
 * renderer and the document are untouched — the SIGNED step still shows the
 * real PDF, which is asserted a few steps below.
 */
await step('the review step is a summary, with no embedded document', async () => {
  /*
   * COUNTED BY TEST ID, NOT BY IFRAME.
   *
   * It counted `iframe`s, which only ever existed on a browser that has a PDF
   * viewer of its own: on a headless shell, and on the Android tablets this
   * system runs on, the preview is drawn as HTML and an iframe count of zero
   * said nothing at all. Both branches of the preview carry the same test id,
   * so this now holds on either browser.
   */
  const previews = await page.getByTestId('job-card-preview').count();
  if (previews !== 0) {
    throw new Error(`the Review step still embeds ${previews} document preview(s)`);
  }
  if ((await page.getByText('Preview — not yet issued').count()) !== 0) {
    throw new Error('the Review step still carries the preview header');
  }
  await page.screenshot({ path: `${shots}/23-review-summary.png`, fullPage: false });
});

await step('the signature step carries the declaration exactly once', async () => {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of', { exact: false }).waitFor({ timeout: 15000 });

  const declaration = page.getByText(
    'I confirm that the work described above has been completed.',
  );
  const count = await declaration.count();
  if (count !== 1) throw new Error(`the declaration appears ${count} times, expected once`);
  await page.screenshot({ path: `${shots}/03-signature.png`, fullPage: false });
});

await step('capture signature', async () => {
  await page.getByLabel('Customer name').fill('Pieter');
  await page.getByLabel('Customer surname').fill('Nel');

  const pad = page.locator('div.touch-none').first();
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 120);
  await page.mouse.down();
  for (let i = 0; i < 24; i += 1) {
    await page.mouse.move(box.x + 60 + i * 12, box.y + 120 - Math.sin(i / 2) * 40);
  }
  await page.mouse.up();

  await page.getByRole('button', { name: 'Confirm signature' }).click();
  // Onto the signed document, which is the last thing the technician sees.
  await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 20000 });
});

await step('the signed document is shown before anything is submitted', async () => {
  await page.getByRole('heading', { name: 'Signed', exact: true }).waitFor({ timeout: 10000 });
  /*
   * WHICHEVER FRAME THIS BROWSER GETS. MASTER SCOPE PDF-1 AND PDF-3.
   *
   * The iframe is drawn only for a browser that reports a PDF viewer of its
   * own; a headless shell reports none, exactly as Chrome on Android does, and
   * is handed the same document as HTML instead. Both carry this test id, and
   * `tablet-pdf-check` is what pins each branch to its own capability.
   */
  await page.getByTestId('job-card-preview').waitFor({ timeout: 20000 });
  // There is no way back past a signature.
  if ((await page.getByRole('button', { name: 'Back' }).count()) !== 0) {
    throw new Error('the wizard offered to go back behind a captured signature');
  }
  await page.screenshot({ path: `${shots}/24-signed-preview.png`, fullPage: false });

  /*
   * THE TECHNICIAN SUBMITS IT, HERE. MASTER SCOPE CR-07.
   *
   * This read "Continue to submission" and navigated to the office review
   * screen, where a MASTER submitted. There is no office step in the normal
   * signed journey any more: the last act of the close-out is the technician's
   * own submission, taken in the wizard they are already standing in.
   */
  await page.getByRole('button', { name: 'Submit job card' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByText('closes when the customer', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Submit job card' }).click();
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 25000 });
  await page.screenshot({ path: `${shots}/05-submitted.png`, fullPage: false });
});

await step('job card preview renders real data', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048/review`, { waitUntil: 'networkidle' });
  // Read by a technician, who may not submit it again — so the page is titled
  // for reading rather than for reviewing (CR-07).
  await page.getByRole('heading', { name: 'Job card', exact: true }).waitFor({ timeout: 8000 });
  await page.getByText('ABC Engineering (Pty) Ltd').first().waitFor({ timeout: 8000 });
  await page.getByText('LW-V40-70214').first().waitFor({ timeout: 8000 });
  await page.getByText('Replaced the seized spindle drive cooling fan', { exact: false })
    .first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/04-jobcard.png`, fullPage: false });
});

await step('the captured signature is rendered in solid black', async () => {
  const graphic = page.locator('svg[aria-label="Customer signature"]');
  await graphic.waitFor({ timeout: 8000 });

  const stroke = await graphic.locator('path').evaluate(
    (node) => getComputedStyle(node).stroke,
  );
  if (stroke !== 'rgb(0, 0, 0)') {
    throw new Error(`the signature is drawn in ${stroke}, not black`);
  }

  // Not just the declared colour: the drawn pixels have to be black too, since
  // an opacity or a filter anywhere above it would fade them. Painted onto a
  // canvas in the page and read back, because that is what the eye gets.
  const darkest = await page.evaluate(async () => {
    const svg = document.querySelector('svg[aria-label="Customer signature"]');
    if (svg === null) return null;
    const serialised = new XMLSerializer().serializeToString(svg);
    const box = svg.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(box.width);
    canvas.height = Math.ceil(box.height);
    const context = canvas.getContext('2d');
    if (context === null) return null;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(null);
      };
      image.onerror = reject;
      image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(serialised)))}`;
    });

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let min = 255;
    let black = 0;
    for (let i = 0; i < data.length; i += 4) {
      const value = Math.max(data[i], data[i + 1], data[i + 2]);
      if (value < min) min = value;
      if (data[i] < 20 && data[i + 1] < 20 && data[i + 2] < 20) black += 1;
    }
    return { min, black };
  });

  if (darkest === null) throw new Error('could not sample the signature');
  if (darkest.min > 5 || darkest.black < 20) {
    throw new Error(
      `the rendered signature is not black: darkest channel ${darkest.min}, ${darkest.black} black pixels`,
    );
  }
});

/*
 * THIS STEP HAS BEEN WRITTEN THREE WAYS, AND THE HISTORY MATTERS.
 *
 *  1. Originally the technician submitted, but so could anybody — the
 *     `95e9848` audit found `issue` gated on the job's STATUS and never on
 *     permission.
 *  2. `d979aa9` narrowed it to the MASTER under §3.1/§7/§15, and this step was
 *     rewritten to have him submit from the office review screen.
 *  3. EJE confirmed on 25 September 2026 (CR-07) that the normal signed
 *     journey has no office step at all: the technician who attended the
 *     machine submits it, from the close-out. That already happened, above.
 *
 * What is left to assert is that the office is offered nothing, and that the
 * superseded wording is gone from the screens rather than merely unused.
 */
await step('the submitted job card carries no office-review wording anywhere', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  const job = await page.locator('main').innerText();
  await page.goto(`${BASE}/jobs/EJE-1048/review`, { waitUntil: 'networkidle' });
  const review = await page.locator('main').innerText();

  if ((await page.getByRole('button', { name: 'Submit for Master Review' }).count()) !== 0) {
    throw new Error('Master Review is still offered for a breakdown job');
  }
  for (const gone of [
    'With the office for submission',
    'A Master makes the final submission',
    'Review & submit job card',
    'View job card — with the office',
  ]) {
    if (job.includes(gone) || review.includes(gone)) {
      throw new Error(`the superseded office-review wording is still on screen: "${gone}"`);
    }
  }

  await page.getByText('EJE-1048-Final-Job-Card.pdf', { exact: false })
    .first().waitFor({ timeout: 15000 });
});

await step('neither the Coordinator nor the Master is offered a submit action', async () => {
  // No greeting to wait for: signing in returns you to the page you were on,
  // which here is a job screen rather than a dashboard.
  for (const who of ['Christene van Niekerk', 'Elmarie Coetzee']) {
    await signOut();
    await signInAs(page, who);
    for (const url of [`${BASE}/jobs/EJE-1048`, `${BASE}/jobs/EJE-1048/review`]) {
      await page.goto(url, { waitUntil: 'networkidle' });
      for (const name of ['Submit job card', 'Review & submit job card']) {
        if ((await page.getByRole('button', { name, exact: true }).count()) !== 0) {
          throw new Error(`${who} was offered "${name}" at ${url}`);
        }
      }
    }
  }
  await signInAsMasterIfNeeded();
});

await step('an accepted send does NOT close the job, and does not claim delivery', async () => {
  /*
   * READ ON THE JOB CARD SCREEN, not on a submission result banner.
   *
   * The banner this used to read belonged to the office review page, which the
   * submission no longer routes anybody to (CR-07). The delivery state itself
   * is unchanged and is where it has always been: on the job card screen,
   * which says the copy was issued and is still waiting to be delivered.
   */
  await page.goto(`${BASE}/jobs/EJE-1048/review`, { waitUntil: 'networkidle' });
  const banner = await page.getByText(/is still pending|could not be delivered/i).count();
  if (banner === 0) {
    throw new Error('the screen did not say the delivery was pending');
  }
  const claimed = await page.getByText('and delivered to', { exact: false }).count();
  if (claimed !== 0) throw new Error('the screen claimed a delivery nothing has confirmed');

  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 8000 });
  if (await page.getByText('Read-only — this job is closed').count() !== 0) {
    throw new Error('the job closed on an accepted send');
  }
});

await step('the issued job is already read-only, before delivery is confirmed', async () => {
  await page.getByText('Read-only — the job card has been issued', { exact: false })
    .first().waitFor({ timeout: 8000 });
});

await step('the customer email is in the outbox, marked pending rather than delivered', async () => {
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  await page.getByText('Nothing in this list was sent').waitFor({ timeout: 8000 });
  await page.getByText('EJE-1048-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
  await page.getByText('Delivery pending').first().waitFor({ timeout: 8000 });
});

/*
 * WHAT THE OFFICE IS TOLD WHEN A CUSTOMER'S COPY DOES NOT GO. MANDATE-3.
 *
 * The office has one button — *Send to the customer again* — and a sentence
 * written by a mail provider. For four kinds of failure that button works; for
 * the rest it cannot, until a credential is corrected, a permission granted, an
 * address fixed or the document made smaller. Pressing it again is then
 * somebody losing an afternoon to a problem nobody told them about.
 *
 * The failure is reported through the SAME route the demonstration outbox uses
 * to stand in for a provider's delivery report, with the kind that report would
 * carry. Nothing here invents a send: the job really did go to the simulated
 * transport, and this is the report coming back negative.
 *
 * The button must still be there. Once the credential IS corrected, this is
 * exactly the failure the office should be able to retry — what the kind
 * changes is what they are told before they press it.
 */
await step('a failed delivery tells the office whether trying again can work', async () => {
  const messageId = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/jobs/EJE-1048`);
    const payload = await response.json();
    return payload?.data?.view?.job?.delivery?.messageId ?? '';
  }, BASE);
  if (messageId.length === 0) throw new Error('EJE-1048 has no provider message id to report on');

  const report = async (state, failureReason, failureKind) =>
    page.evaluate(
      async ({ base, id, body }) => {
        const response = await fetch(`${base}/api/outbox/${encodeURIComponent(id)}/delivery`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.text()).slice(0, 300) };
      },
      { base: BASE, id: messageId, body: { state, failureReason, failureKind } },
    );

  const refusedCredential = await report(
    'failed',
    'Microsoft 365 refused the credentials (HTTP 401).',
    'credentials_rejected',
  );
  if (refusedCredential.status !== 200) {
    throw new Error(`reporting the failure answered HTTP ${refusedCredential.status}: ${refusedCredential.body}`);
  }

  await page.goto(`${BASE}/jobs/EJE-1048/review`, { waitUntil: 'networkidle' });
  const reason = page.getByTestId('delivery-failure-reason');
  await reason.waitFor({ timeout: 10000 });
  const reasonText = (await reason.innerText()).trim();
  if (!reasonText.includes('refused the credentials')) {
    throw new Error(`the office is not shown the provider's own words: ${reasonText}`);
  }

  const advice = page.getByTestId('delivery-retry-advice');
  await advice.waitFor({ timeout: 10000 });
  const unretryable = await advice.evaluate((node) => ({
    kind: node.getAttribute('data-delivery-kind'),
    retryable: node.getAttribute('data-delivery-retryable'),
    text: node.textContent ?? '',
  }));
  if (unretryable.kind !== 'credentials_rejected') {
    throw new Error(`the screen read the kind as ${unretryable.kind}`);
  }
  if (unretryable.retryable !== 'false') {
    throw new Error('a refused credential was presented as worth retrying');
  }
  if (!unretryable.text.includes('Something has to change first')) {
    throw new Error(`the advice did not say what to do: ${unretryable.text}`);
  }

  // The button stays. Hiding it would strand the office once they fix the cause.
  if ((await page.getByRole('button', { name: 'Send to the customer again' }).count()) === 0) {
    throw new Error('the re-send was taken away on an unretryable failure');
  }
  await page.screenshot({ path: `${shots}/05a-delivery-failure-advice.png`, fullPage: false });

  // And the other half of the distinction: a throttled provider IS worth retrying.
  const throttled = await report('failed', 'Too many requests.', 'throttled');
  if (throttled.status !== 200) throw new Error(`the second report answered HTTP ${throttled.status}`);

  await page.goto(`${BASE}/jobs/EJE-1048/review`, { waitUntil: 'networkidle' });
  const second = page.getByTestId('delivery-retry-advice');
  await second.waitFor({ timeout: 10000 });
  const worthTrying = await second.evaluate((node) => ({
    kind: node.getAttribute('data-delivery-kind'),
    retryable: node.getAttribute('data-delivery-retryable'),
    text: node.textContent ?? '',
  }));
  if (worthTrying.kind !== 'throttled' || worthTrying.retryable !== 'true') {
    throw new Error(`a throttled provider read as ${worthTrying.kind}/${worthTrying.retryable}`);
  }
  if (!worthTrying.text.includes('Worth trying again')) {
    throw new Error(`the advice did not encourage a retry: ${worthTrying.text}`);
  }

  // Back to where the next step expects it: accepted, awaiting confirmation.
  const restored = await report('pending_delivery', '', undefined);
  if (restored.status !== 200) throw new Error(`restoring the report answered HTTP ${restored.status}`);
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  await page.getByText('Delivery pending').first().waitFor({ timeout: 10000 });
});

await step('confirming the delivery is what closes the job', async () => {
  await page.getByRole('button', { name: 'Confirm delivered' }).first().click();
  await page.getByText('Delivered').first().waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByText('Read-only — this job is closed', { exact: false })
    .first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${shots}/05-closed-on-delivery.png`, fullPage: false });
});

/*
 * The customer who would not sign.
 *
 * A second job is taken through the same close-out as EJE-1048 was, except that at
 * the signature step the technician records a refusal instead. The point of
 * running it in a browser is the half of the rule that is not in the domain
 * tests: that the two outcomes are one choice on one screen, that the signature
 * capture actually disappears, and that Continue cannot be pressed on an empty
 * reason.
 */
const REFUSAL_REASON = 'Site manager left before the work was finished and nobody else would sign.';

/** EJE-1061 is a breakdown already in progress, worked by Sipho. */
const REFUSED_JOB = 'EJE-1061';

await step(`a second job is taken to the signature step (${REFUSED_JOB})`, async () => {
  // Worked by Riaan, which is what makes the privacy rule testable: Sipho and
  // Lerato have no business reading what this customer said.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Riaan van Wyk');
  await page.waitForURL('**/dashboard', { timeout: 15000 });

  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: REFUSED_JOB }).waitFor({ timeout: 10000 });

  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Normal Time').first().waitFor({ timeout: 8000 });

  await page.getByRole('tab', { name: 'Completion' }).click();
  await page.getByLabel(/Work performed/).fill(
    'Traced the axis fault to a failed contactor, replaced it and re-ran the machine.',
  );
  // THE WRITE-UP SAVES ITSELF. MASTER SCOPE WRITEUP-1 — there is no Save
  // write-up button; the panel says Saved on its own once the typing stops.
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Step 1 of 4', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 2 of 4', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of 4', { exact: false }).waitFor({ timeout: 15000 });
});

await step('the signature step opens on the signature, not on the refusal', async () => {
  await page.getByRole('heading', { name: 'Customer acceptance' }).waitFor({ timeout: 8000 });
  await page
    .getByText('I confirm that the work described above has been completed.')
    .waitFor({ timeout: 8000 });
  await page.getByLabel('Customer name').waitFor({ timeout: 8000 });
  if ((await page.locator('div.touch-none').count()) === 0) {
    throw new Error('the signature pad is not on the signature step');
  }
  // The refusal is offered, and is NOT the default.
  const toggle = page.getByRole('checkbox', { name: /Customer refused to sign/ });
  await toggle.waitFor({ timeout: 8000 });
  if (await toggle.isChecked()) throw new Error('the step opened already refusing');
  if ((await page.getByLabel(/Customer refusal reason/).count()) !== 0) {
    throw new Error('the refusal reason is shown before the refusal is chosen');
  }
});

await step('choosing the refusal removes the signature capture entirely', async () => {
  await page.getByRole('checkbox', { name: /Customer refused to sign/ }).check();
  await page.getByLabel(/Customer refusal reason/).waitFor({ timeout: 8000 });

  if ((await page.locator('div.touch-none').count()) !== 0) {
    throw new Error('the signature pad is still on screen after the customer refused');
  }
  if ((await page.getByLabel('Customer name').count()) !== 0) {
    throw new Error('the signature name fields are still on screen after the customer refused');
  }
  if (
    (await page
      .getByText('I confirm that the work described above has been completed.')
      .count()) !== 0
  ) {
    throw new Error('the acceptance declaration is still shown beside a refusal');
  }
  await page.screenshot({ path: `${shots}/19-refusal.png`, fullPage: false });
});

await step('an empty or whitespace-only reason will not submit', async () => {
  const submit = page.getByRole('button', { name: 'Record refusal' });
  await submit.waitFor({ timeout: 8000 });
  if (!(await submit.isDisabled())) throw new Error('an empty refusal could be submitted');

  await page.getByLabel(/Customer refusal reason/).fill('   ');
  if (!(await submit.isDisabled())) throw new Error('a whitespace-only reason could be submitted');
});

await step('a short but real reason is accepted', async () => {
  // Presence is the rule. The system does not judge whether the technician's
  // explanation is a good one, so "no" is as valid as a paragraph.
  const submit = page.getByRole('button', { name: 'Record refusal' });
  for (const reason of ['no', 'n/a', 'Customer unavailable']) {
    await page.getByLabel(/Customer refusal reason/).fill(reason);
    if (await submit.isDisabled()) throw new Error(`"${reason}" was rejected as a reason`);
  }
});

await step('Back keeps the refusal and its reason', async () => {
  await page.getByLabel(/Customer refusal reason/).fill(REFUSAL_REASON);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByText('Step 2 of 4', { exact: false }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of 4', { exact: false }).waitFor({ timeout: 10000 });

  const toggle = page.getByRole('checkbox', { name: /Customer refused to sign/ });
  if (!(await toggle.isChecked())) throw new Error('going back lost the refusal');
  const value = await page.getByLabel(/Customer refusal reason/).inputValue();
  if (value !== REFUSAL_REASON) throw new Error('going back lost the reason');
});

await step('switching back to the signature clears the refusal', async () => {
  await page.getByRole('checkbox', { name: /Customer refused to sign/ }).uncheck();
  await page.getByLabel('Customer name').waitFor({ timeout: 8000 });
  if ((await page.locator('div.touch-none').count()) === 0) {
    throw new Error('the signature pad did not come back');
  }
  if ((await page.getByLabel(/Customer refusal reason/).count()) !== 0) {
    throw new Error('the refusal reason is still on screen after switching back');
  }

  // And choosing the refusal again starts from a blank reason, so a discarded
  // one cannot be submitted by accident.
  await page.getByRole('checkbox', { name: /Customer refused to sign/ }).check();
  const value = await page.getByLabel(/Customer refusal reason/).inputValue();
  if (value.length !== 0) throw new Error('the discarded reason came back');
});

await step('recording the refusal finishes the close-out, on the job', async () => {
  /*
   * IT NO LONGER NAVIGATES TO THE REVIEW SCREEN. MASTER SCOPE CR-07.
   *
   * Finishing the close-out used to push whoever ran it to
   * `/jobs/<n>/review`, which is how the office review page got into the
   * normal journey in the first place. The wizard now closes onto the job
   * itself — where the refusal panel is the first thing on the screen.
   */
  await page.getByLabel(/Customer refusal reason/).fill(REFUSAL_REASON);
  await page.getByRole('button', { name: 'Record refusal' }).click();
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 15000 });
  if (page.url().endsWith('/review')) {
    throw new Error('the close-out still routes through the office review screen');
  }
});

/*
 * THIS STEP USED TO EXPECT THE TECHNICIAN TO STILL HAVE A BUTTON on the job
 * card they had just handed over — "Signature refusal — awaiting resolution".
 * Master Scope CR-04(a) and REF-11/REF-12 settle it the other way: recording
 * the refusal is the technician's last act, and from that moment they may VIEW
 * the job card and its refusal and do nothing else. The office's own action is
 * asserted a few steps below, where a Master opens the same job.
 */
await step('the job card is held until the office resolves the refusal', async () => {
  // The review screen is reached deliberately here, because that is where the
  // refusal's own "Awaiting resolution" card lives.
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}/review`, { waitUntil: 'networkidle' });
  await page.getByText('Awaiting resolution').first().waitFor({ timeout: 10000 });
  if ((await page.getByRole('button', { name: 'Submit job card' }).count()) !== 0) {
    throw new Error('an unresolved refusal could still be issued');
  }

  // And the technician who recorded it is read-only on it from here.
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 10000 });

  const body = await page.locator('main').innerText();
  if (!body.includes(REFUSAL_REASON)) {
    throw new Error('the technician cannot see the refusal they recorded');
  }
  for (const name of [
    'Capture signature',
    'Correct & resubmit',
    'Customer Signature',
    'Without Customer Signature',
    'Submit job card',
    'Signature refusal — awaiting resolution',
  ]) {
    if ((await page.getByRole('button', { name, exact: true }).count()) !== 0) {
      throw new Error(`the technician was offered "${name}" on a refused job card`);
    }
  }
  if ((await page.getByRole('button', { name: /Review & submit/ }).count()) !== 0) {
    throw new Error('the job still offered to submit an unresolved refusal');
  }
});

await step('the refusal shows on the job as an exception, not a seventh stage', async () => {
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 10000 });
  await page.getByText(REFUSAL_REASON).first().waitFor({ timeout: 8000 });

  const rail = page.locator('ol').filter({ hasText: 'Completion' }).last();
  const names = (await rail.locator('li').allInnerTexts()).map((line) =>
    line.replace(/^\d+\s*/, '').replace(/\s+/g, ' ').trim(),
  );
  if (names.length !== 6) throw new Error(`the rail has ${names.length} stages: ${names.join(' | ')}`);
  if (names.some((name) => /master review/i.test(name))) {
    throw new Error('Master Review came back on the rail');
  }
  // The exception is a flag ON the signature stage.
  if (!names.some((name) => /Customer Signature — Customer refused to sign/i.test(name))) {
    throw new Error(`the refusal is not marked on the signature stage: ${names.join(' | ')}`);
  }
  await page.screenshot({ path: `${shots}/20-refusal-rail.png`, fullPage: false });
});

/*
 * The FACT is on the trail. The REASON is not.
 *
 * The audit trail is a separate store with its own read path, and the refusal's
 * viewer rule governs the refusal record — so while the reason was copied into
 * the audit detail there were two copies under two sets of rules, and a
 * technician who had correctly been handed a redacted job could read it on the
 * activity feed. The trail still records that a refusal happened, on which job,
 * by whom and when, which is what an audit trail is for.
 */
await step('the refusal is on the job activity trail, without the reason', async () => {
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 8000 });
  await page.getByText('The reason is stored on the job.').first().waitFor({ timeout: 8000 });

  const trail = await page.locator('main').innerText();
  if (trail.includes(`Reason: ${REFUSAL_REASON}`)) {
    throw new Error('the audit trail restated the customer’s reason');
  }
});

await step('a technician cannot resolve or correct their own refusal', async () => {
  for (const forbidden of [
    'Record Resolution',
    'Resubmit for customer signature',
    'Issue without a signature',
    'Correct & resubmit',
  ]) {
    if ((await page.getByRole('button', { name: forbidden }).count()) !== 0) {
      throw new Error(`a technician was offered "${forbidden}"`);
    }
  }
});

await step('another technician cannot see the refusal at all', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Lerato Dlamini');
  await page.waitForURL('**/dashboard', { timeout: 15000 });

  /*
   * Straight at the job by its URL, which is the only way she could get there.
   *
   * She is handed NOTHING. This used to hand her the job with its refusals
   * stripped off; DECISION 5 now says another technician's live job is not
   * hers to read at all, and the answer she gets is the one a job number that
   * does not exist gives — the only answer that does not confirm it exists.
   */
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.getByText('Job not found').first().waitFor({ timeout: 10000 });
  const body = await page.locator('main').innerText();

  for (const leaked of [REFUSAL_REASON, 'Customer refused to sign', 'Awaiting resolution']) {
    if (body.includes(leaked)) {
      throw new Error(`another technician was shown "${leaked}" on somebody else's job`);
    }
  }
  // Nor is there a job card underneath to leak one: no tabs, no rail, nothing.
  if ((await page.getByRole('tab', { name: 'Activity' }).count()) !== 0) {
    throw new Error('another technician was given the job screen for somebody else’s job');
  }

  // And no global refusal count on her dashboard.
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const dashboard = await page.locator('main').innerText();
  if (/Customer Signature Refusals/i.test(dashboard)) {
    throw new Error('a technician was given the global refusal count');
  }
});

/*
 * The activity trail was the way round the refusal rule.
 *
 * `redactRefusalsForViewer` correctly hid the refusal on the job screen and on
 * the review screen, and the reason was then written verbatim into an audit
 * event — a separate store, with its own read path and no viewer rule on it, on
 * a screen with no role check at all. A live browser probe confirmed an
 * unrelated technician reading another technician's refusal reason on
 * `/activity` and on the job's Activity tab. Both are covered here because both
 * were open.
 */
await step('another technician cannot reach the audit trail at all', async () => {
  // Not offered it.
  const sidebar = await page.locator('nav').first().innerText();
  if (/\bActivity\b/.test(sidebar)) {
    throw new Error('a technician was offered the company-wide Activity trail');
  }

  // And typing the URL is refused, which is the part that matters.
  await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle' });
  await page.getByText('office record', { exact: false }).first().waitFor({ timeout: 10000 });

  const body = await page.locator('main').innerText();
  for (const leaked of [REFUSAL_REASON, 'Customer refused to sign']) {
    if (body.includes(leaked)) {
      throw new Error(`the activity trail showed a technician "${leaked}"`);
    }
  }
});

await step('nor through search, which is the same data reached another way', async () => {
  await page.goto(`${BASE}/search?q=${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);

  // The term itself is echoed back on the page, so the assertion is on the
  // RESULTS: no link to the job, and nothing from it.
  if ((await page.locator(`a[href="/jobs/${REFUSED_JOB}"]`).count()) !== 0) {
    throw new Error(`search handed another technician ${REFUSED_JOB}`);
  }
  await page.getByText(`No results for "${REFUSED_JOB}"`).first().waitFor({ timeout: 8000 });

  const body = await page.locator('main').innerText();
  for (const leaked of [REFUSAL_REASON, 'Customer refused to sign']) {
    if (body.includes(leaked)) {
      throw new Error(`search showed another technician "${leaked}"`);
    }
  }
});

await step('the submitting technician still sees their own refusal', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Riaan van Wyk');
  await page.waitForURL('**/dashboard', { timeout: 15000 });

  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 10000 });
  await page.getByText(REFUSAL_REASON).first().waitFor({ timeout: 8000 });
});

await step('sign in as a Master for the office journey', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Elmarie Coetzee');
  await page.waitForURL('**/dashboard', { timeout: 10000 });
});

await step('the Master is notified that the customer refused to sign', async () => {
  await page.goto(`${BASE}/notifications`, { waitUntil: 'networkidle' });
  const card = page
    .locator('main li')
    .filter({ hasText: `${REFUSED_JOB} — customer refused to sign` })
    .first();
  await card.waitFor({ timeout: 10000 });

  const body = await card.innerText();
  for (const expected of [
    REFUSED_JOB,
    'Customer:',
    'Site:',
    'Machine:',
    'Technician: Riaan van Wyk',
    REFUSAL_REASON,
  ]) {
    if (!body.includes(expected)) throw new Error(`the notification omits "${expected}"`);
  }
  await page.screenshot({ path: `${shots}/21-refusal-notification.png`, fullPage: false });
});

await step('the notification opens the job it is about', async () => {
  await page
    .locator('main li')
    .filter({ hasText: `${REFUSED_JOB} — customer refused to sign` })
    .first()
    .getByRole('button', { name: /Open/ })
    .first()
    .click();
  await page.waitForURL(`**/jobs/${REFUSED_JOB}`, { timeout: 10000 });
});

await step('the Master sees the refusal, the reason, who took it and when', async () => {
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 10000 });
  await page.getByText(REFUSAL_REASON).first().waitFor({ timeout: 8000 });
  const panel = await page.locator('main').innerText();
  for (const expected of ['Recorded by', 'Riaan van Wyk', 'Recorded', 'Awaiting resolution']) {
    if (!panel.includes(expected)) throw new Error(`the refusal panel omits "${expected}"`);
  }
});

await step('the Master still sees the whole job behind the exception', async () => {
  // The exception does not replace the record: the write-up, the captured work,
  // the photographs and the history are all there to judge the refusal against.
  await page.getByRole('tab', { name: 'Completion' }).click();
  await page.getByText('Traced the axis fault', { exact: false }).first().waitFor({
    timeout: 8000,
  });
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  // The hours, not a second description of the work: LAB-1 removed that field
  // from the labour line, and the write-up above is where the work is set out.
  await page.getByText('2.00 hrs').first().waitFor({ timeout: 8000 });
  await page.getByRole('tab', { name: 'Photos' }).click();
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('Customer refused to sign').first().waitFor({ timeout: 8000 });
});

await step('the Master corrects the job card through the same panels', async () => {
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Correct & resubmit' }).click();
  await page.getByText('Step 1 of 2', { exact: false }).waitFor({ timeout: 15000 });

  // The office correction ends at the review, not at a signature: EJE does not
  // sign on the customer's behalf.
  const rail = page.locator('ol').filter({ hasText: 'Completion' }).last();
  const names = (await rail.locator('li').allInnerTexts()).map((line) =>
    line.replace(/^\d+\s*/, '').replace(/\s+/g, ' ').trim(),
  );
  // Completion and Review. A breakdown has no checklist, and the office does
  // not take the signature.
  if (names.length !== 2) throw new Error(`${names.length} correction steps: ${names.join(' | ')}`);
  if (names.some((name) => /signature/i.test(name))) {
    throw new Error(`the office was offered the signature pad: ${names.join(' | ')}`);
  }

  // The technician's own write-up, in the technician's own panel.
  const writeUp = await page.getByLabel(/Work performed/).inputValue();
  if (!writeUp.includes('Traced the axis fault')) {
    throw new Error('the correction did not open on the captured write-up');
  }
  await page.getByLabel(/Work performed/).fill(
    'Traced the axis fault to a failed contactor, replaced it and re-ran the machine. One hour on site.',
  );
  // THE WRITE-UP SAVES ITSELF. MASTER SCOPE WRITEUP-1 — there is no Save
  // write-up button; the panel says Saved on its own once the typing stops.
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });
  await page.screenshot({ path: `${shots}/26-correct-and-resubmit.png`, fullPage: false });
});

await step('the corrected job card is reviewed, then returned for signature', async () => {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 2 of 2', { exact: false }).waitFor({ timeout: 15000 });

  /*
   * A SUMMARY, NOT AN EMBEDDED DOCUMENT. MASTER SCOPE REV-1 — the office's
   * correction ends on the same Review step the technician uses, and that step
   * no longer carries a PDF. This asserted the iframe; it now asserts the
   * summary, and the corrected write-up in it.
   */
  await page.getByText('Ready for the customer').waitFor({ timeout: 15000 });
  if ((await page.getByTestId('job-card-preview').count()) !== 0) {
    throw new Error('the correction Review step still embeds a document preview');
  }
  const summary = await page.locator('main').innerText();
  if (!summary.includes('One hour on site')) {
    throw new Error('the corrected write-up is not on the Review step');
  }

  await page.getByRole('button', { name: 'Resubmit for customer signature' }).click();
  await page.getByText('Customer Signature').first().waitFor({ timeout: 15000 });
});

await step('the corrected job is back at Customer Signature, with the history kept', async () => {
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  const body = await page.locator('main').innerText();

  // Resolved, not deleted: the refusal and what was decided about it stay.
  if (!body.includes('Resolved')) throw new Error('the refusal is not shown as resolved');
  if (!body.includes(REFUSAL_REASON)) throw new Error('the original refusal reason was lost');
  if (!/Corrected and returned for signature/.test(body)) {
    throw new Error('the outcome of the refusal is not recorded on the job');
  }

  // Back at the signature stage, and the rail is still six.
  const rail = page.locator('ol').filter({ hasText: 'Completion' }).last();
  const names = (await rail.locator('li').allInnerTexts()).map((line) =>
    line.replace(/^\d+\s*/, '').replace(/\s+/g, ' ').trim(),
  );
  if (names.length !== 6) throw new Error(`the rail has ${names.length} stages`);
  if (/master review/i.test(names.join(' '))) throw new Error('Master Review came back');

  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('Corrected job card returned for customer signature').first().waitFor({
    timeout: 8000,
  });
  await page.getByText('Job card corrected by the office').first().waitFor({ timeout: 8000 });
});

await step('the dashboard refusal count clears once it is dealt with', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const tile = page.locator('main a, main div').filter({ hasText: 'Customer Signature Refusals' }).last();
  await tile.waitFor({ timeout: 10000 });
  if (!/Requires attention/.test(await tile.innerText())) {
    throw new Error('the refusal tile does not say what it is for');
  }
  // Resolved by returning it for signature, so it is out of the queue.
  if (!/\b0\b/.test(await tile.innerText())) {
    throw new Error(`the refusal count did not clear: ${await tile.innerText()}`);
  }
});

await step('the customer signs the corrected job card', async () => {
  /*
   * THE TECHNICIAN TAKES THE SECOND SIGNATURE. MASTER SCOPE CR-07.
   *
   * The office corrected the card and handed it back to the CUSTOMER
   * SIGNATURE stage — "Return the job to the technician/customer-signature
   * stage. Technician can capture the customer's signature." The Master's part
   * ended there, and he could not submit it afterwards even if he took the
   * signature himself.
   */
  await signOut();
  await signInAs(page, 'Riaan van Wyk');
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Capture signature' }).click();
  // The close-out opens at the start, as it always does: the corrected card is
  // there to be checked again before it is put in front of the customer.
  await page.getByText('Step 1 of 4', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 2 of 4', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of 4', { exact: false }).waitFor({ timeout: 15000 });

  await page.getByLabel('Customer name').fill('Gerhard');
  await page.getByLabel('Customer surname').fill('Smit');
  const pad = page.locator('div.touch-none').first();
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 110);
  await page.mouse.down();
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.move(box.x + 60 + i * 14, box.y + 110 - Math.sin(i / 2) * 35);
  }
  await page.mouse.up();
  await page.getByRole('button', { name: 'Confirm signature' }).click();

  /*
   * AND THE NORMAL JOURNEY RESUMES. MASTER SCOPE CR-07.
   *
   * The office resolved the refusal and handed the card back. Once it is
   * signed it is an ordinary signed job card, which means whoever took the
   * signature submits it — not a Master from a review queue.
   */
  await page.getByText('Step 4 of 4', { exact: false }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Submit job card' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Submit job card' }).click();
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 25000 });

  // Back to the office for the rest: only they can see the outbox.
  await signOut();
  await signInAsMasterIfNeeded();
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}/review`, { waitUntil: 'networkidle' });
});

await step('the signed corrected card carries no refusal block', async () => {
  // The DOCUMENT, not the page: the office's refusal panel above it is EJE's
  // own record and is supposed to be there.
  const card = await page.locator('article').first().innerText();
  if (/CUSTOMER REFUSED TO SIGN/i.test(card)) {
    throw new Error('the signed job card still shows the refusal to the customer');
  }
  if (!card.includes('Gerhard')) throw new Error('the signature is not on the job card');
});

await step('the resolved refusal is no longer outstanding in the inbox', async () => {
  await page.goto(`${BASE}/notifications`, { waitUntil: 'networkidle' });
  const outstanding = await page
    .locator('main li')
    .filter({ hasText: `${REFUSED_JOB} — customer refused to sign` })
    .count();
  if (outstanding !== 0) {
    throw new Error('the refusal is still in the inbox after it was reviewed');
  }

  await page.getByRole('tab', { name: /Handled/ }).click();
  await page
    .locator('main li')
    .filter({ hasText: `${REFUSED_JOB} — customer refused to sign` })
    .first()
    .waitFor({ timeout: 10000 });
});

await step('the resolved job card is already issued, by whoever signed it', async () => {
  /*
   * IT WAS SUBMITTED IN THE CLOSE-OUT, above. MASTER SCOPE CR-07.
   *
   * This step used to be the submission itself, taken here on the review
   * screen. The resolved card rejoins the normal journey, and the normal
   * journey has no office step — so all that is left to check is that the
   * customer's copy exists and the office is not offered it again.
   */
  await page.goto(`${BASE}/jobs/${REFUSED_JOB}/review`, { waitUntil: 'networkidle' });
  await page.getByText(`${REFUSED_JOB}-Final-Job-Card.pdf`).first().waitFor({ timeout: 20000 });
  if ((await page.getByRole('button', { name: 'Submit job card' }).count()) !== 0) {
    throw new Error('a submitted job card was offered for submission again');
  }
});

await step('the issued card carries the signature the customer eventually gave', async () => {
  const card = await page.locator('article').first().innerText();
  // Refused once, corrected, signed. The document the customer receives is the
  // one they signed — the earlier refusal is EJE's record, not their paperwork.
  if (!card.includes('Gerhard')) throw new Error('the signature is not on the issued card');
  if (/CUSTOMER REFUSED TO SIGN/i.test(card)) {
    throw new Error('the signed job card still shows the refusal to the customer');
  }
  await page.screenshot({ path: `${shots}/22-corrected-job-card.png`, fullPage: false });
});

await step('confirming delivery closes the refused job too', async () => {
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  const entry = page.locator('main li').filter({ hasText: REFUSED_JOB }).first();
  await entry.waitFor({ timeout: 10000 });
  await entry.getByRole('button', { name: 'Confirm delivered' }).first().click();

  await page.goto(`${BASE}/jobs/${REFUSED_JOB}`, { waitUntil: 'networkidle' });
  await page.getByText('Read-only — this job is closed', { exact: false }).first().waitFor({
    timeout: 15000,
  });
  // And the refusal history is still exactly what was recorded on site: the
  // customer's eventual signature does not erase the first refusal.
  await page.getByText(REFUSAL_REASON).first().waitFor({ timeout: 8000 });
});

await step('no Master Review appeared anywhere along the refusal route', async () => {
  for (const path of [
    '/jobs',
    `/jobs/${REFUSED_JOB}`,
    `/jobs/${REFUSED_JOB}/review`,
    '/notifications',
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    const body = await page.locator('main').innerText();
    if (/master review/i.test(body)) throw new Error(`Master Review is on ${path}`);
  }
});

/*
 * CORRECTING A JOB CARD EJE HAVE ALREADY ISSUED. BD-02, IMMUT-9, AUD-3.
 *
 * The acceptance blocker these two steps close: a signed job card with a
 * genuine error had no remedy at any layer. In a browser, as the office: raise
 * a correction on a job the customer SIGNED, see it listed, download the
 * addendum and read its text — then confirm that the original job card is
 * byte-for-byte what it was before.
 */
await step('a Master corrects an issued job card, and the original does not move', async () => {
  await signOut();
  await signInAsMasterIfNeeded();

  // The original's bytes, BEFORE the correction. EJE-1048 is closed and signed.
  const before = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/documents/EJE-1048`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();
    return { status: response.status, base64: body?.data?.base64 ?? '', name: body?.data?.fileName ?? '' };
  }, BASE);
  if (before.status !== 200 || before.base64.length === 0) {
    throw new Error(`the original job card could not be read: HTTP ${before.status}`);
  }

  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByTestId('correction-open').waitFor({ timeout: 10000 });
  await page.getByTestId('correction-open').click();

  await page
    .getByTestId('correction-reason')
    .fill('The labour hours were captured against the wrong rate.');
  await page
    .getByTestId('correction-narrative')
    .fill('Three hours were charged at the after-hours rate and should have been normal time.');
  await page.getByTestId('correction-area-labour').click();
  await page.getByTestId('correction-area-charges').click();
  await page.getByTestId('correction-acknowledgement-required').click();
  await page.getByTestId('correction-save').click();

  await page.getByTestId('job-correction-row').first().waitFor({ timeout: 15000 });
  const listed = await page.getByTestId('job-corrections').innerText();
  if (!listed.includes('Correction 1')) {
    throw new Error(`the correction is not on the job screen: ${listed.slice(0, 200)}`);
  }
  if (!listed.includes('Awaiting the customer')) {
    throw new Error('a correction that requires acknowledgement does not say so');
  }

  // THE ORIGINAL IS UNCHANGED. The whole feature rests on this.
  const after = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/documents/EJE-1048`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const body = await response.json();
    return { base64: body?.data?.base64 ?? '', name: body?.data?.fileName ?? '' };
  }, BASE);
  if (after.base64 !== before.base64 || after.name !== before.name) {
    throw new Error('the original job card changed when a correction was raised');
  }

  // And the ADDENDUM is its own PDF, which says what it is.
  const addendum = await page.evaluate(async (base) => {
    const view = await (await fetch(`${base}/api/jobs/EJE-1048`, { credentials: 'include' })).json();
    const correction = view?.data?.view?.corrections?.[0];
    if (correction === undefined) return { status: 0, text: '' };
    const response = await fetch(
      `${base}/api/documents/EJE-1048/corrections/${correction.id}`,
      {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    const body = await response.json();
    return { status: response.status, text: atob(body?.data?.base64 ?? '') };
  }, BASE);
  if (addendum.status !== 200) {
    throw new Error(`the addendum answered HTTP ${addendum.status}`);
  }
  if (!addendum.text.startsWith('%PDF-')) {
    throw new Error('the addendum is not a PDF');
  }
  await page.screenshot({ path: `${shots}/14d-correction.png`, fullPage: false });
});

await step('a technician sees the correction and cannot raise one', async () => {
  await signOut();
  await signInAs(page, 'Sipho Mahlangu');
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });

  // They SEE it: the person who did the work is the one who most needs to know.
  await page.getByTestId('job-correction-row').first().waitFor({ timeout: 15000 });

  // And they are not offered the form.
  if ((await page.getByTestId('correction-open').count()) !== 0) {
    throw new Error('a technician is being offered to correct an issued job card');
  }

  // Refused by the SERVER, not merely absent from the screen.
  const refused = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/jobs/EJE-1048/raise_correction`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reason: 'Trying it on.',
        narrative: 'Trying it on.',
        areas: ['labour'],
        acknowledgementRequired: false,
      }),
    });
    return response.status;
  }, BASE);
  if (refused === 200) {
    throw new Error('the server let a technician correct an issued job card');
  }

  /*
   * AND BACK TO THE OFFICE, because the steps after this one read screens a
   * technician cannot see. An inserted step that changes who is signed in has
   * to put it back — the first version of this did not, and the next step
   * waited thirty seconds for a job EJE-1049 that a technician is not on.
   */
  await signOut();
  await signInAsMasterIfNeeded();
});

await step('closed job is read-only', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  await page.getByText('this job is closed', { exact: false }).first().waitFor({ timeout: 8000 });
});

/*
 * THE REGISTER IS TODAY'S, AND THE JOB SCREEN SAYS SO. MACH-HIST (#28).
 *
 * WHERE THE MACHINE STOOD WHEN THE WORK WAS DONE. BD-20, answered.
 *
 * This step used to assert a LABEL — "this is the register as it stands today"
 * — which was the honest thing to show while BD-20 was open. The owner
 * answered on 23 October 2026: a closed job shows the location at the time of
 * the work, and where the history cannot establish it, it says UNKNOWN rather
 * than letting today's register be read as historical fact.
 *
 * The demonstration data records no machine movements, so the unknown branch is
 * what a closed job shows — and that is the branch worth proving in a browser,
 * because it is the one that stops a screen misreporting where a customer's
 * machine was. Both halves are still asserted: it is on the closed job and
 * absent from one still in progress.
 */
await step('a finished job says where the machine stood, or that it is not known', async () => {
  await page.goto(`${BASE}/jobs/EJE-1048`, { waitUntil: 'networkidle' });
  const note = page.getByTestId('machine-location-at-work-unknown');
  await note.waitFor({ timeout: 10000 });
  const text = (await note.innerText()).trim();
  if (!text.includes('not known')) {
    throw new Error(`the note does not say the location is unknown: ${text}`);
  }
  if (!text.toLowerCase().includes('today')) {
    throw new Error('the note does not say the register card is the present day');
  }
  if (!text.includes('cannot change')) {
    throw new Error('the note does not say the issued document is the historical record');
  }
  if ((await page.getByTestId('register-is-present-day-site').count()) === 0) {
    throw new Error('the site card does not carry its own warning');
  }

  // An open job must NOT carry it: there the register is simply the record a
  // technician needs, and a warning on every screen is a warning on none.
  await page.goto(`${BASE}/jobs/EJE-1049`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1049' }).waitFor({ timeout: 10000 });
  for (const id of ['machine-location-at-work', 'machine-location-at-work-unknown']) {
    if ((await page.getByTestId(id).count()) !== 0) {
      throw new Error('an unfinished job was told something historical about its machine');
    }
  }
});

await step('checklist blocks signature until complete (EJE-1053 service job)', async () => {
  await page.goto(`${BASE}/jobs/EJE-1053`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1053' }).waitFor({ timeout: 8000 });
  await page.getByText('checklist is required for this job type', { exact: false })
    .first().waitFor({ timeout: 8000 });

  // The gate now lives inside the guided close-out: a service job gets a
  // Checklist step, and Continue stays shut until the checklist is done.
  await page.getByRole('button', { name: 'Continue completing' }).click();
  await page.getByText('Step 1 of 5', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 2 of 5', { exact: false }).waitFor({ timeout: 15000 });

  const cont = page.getByRole('button', { name: 'Continue' });
  if (!(await cont.isDisabled())) {
    throw new Error('the checklist step let the job through before the checklist was done');
  }
  await page.getByText('Still to do before this step is finished').waitFor({ timeout: 8000 });

  // Leave the wizard the way a technician would, back to the tabs.
  await page.getByRole('button', { name: 'Leave the wizard' }).click();
  await page.getByRole('tab', { name: 'Overview' }).waitFor({ timeout: 10000 });
});

await step('checklist runner works', async () => {
  await page.getByRole('tab', { name: 'Checklist' }).click();
  await page.getByRole('button', { name: 'Start checklist' }).click();
  await page.getByText('Safety Systems').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Pass', exact: true }).first().click();
  await page.getByText(/1 of \d+ answered/).waitFor({ timeout: 8000 });
  // A new service job must pick up the CURRENT checklist revision.
  await page.getByText('Version 2.0-DEMO').waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/06-checklist.png`, fullPage: false });
});

await step('a failed checklist item demands a note before completion', async () => {
  // Fail the second item; the note field must become required and block progress.
  await page.getByRole('button', { name: 'Fail', exact: true }).nth(1).click();
  await page.getByText('Required — explain the finding').first().waitFor({ timeout: 8000 });
  await page
    .getByText('This item was not passed, so a note is required', { exact: false })
    .first()
    .waitFor({ timeout: 8000 });

  const outstanding = await page.getByText('needs a note explaining what was found').count();
  if (outstanding === 0) throw new Error('outstanding list did not name the item needing a note');

  // Passing items must NOT demand one.
  const optionalLabels = await page.getByText('Optional', { exact: true }).count();
  if (optionalLabels === 0) throw new Error('note fields are not optional on passed items');
});

await step('supplying the note clears the block', async () => {
  const noteBoxes = page.locator('textarea[aria-invalid="true"]');
  await noteBoxes.first().fill('Station 2 emergency stop does not latch — replacement ordered.');
  await noteBoxes.first().blur();
  await page.getByText('Required — explain the finding').first().waitFor({ timeout: 8000 });

  /*
   * Waited for rather than read straight away.
   *
   * The answer is now a round trip to the server, so the flag clears when the
   * server has actually recorded the note — not on the keystroke. That is the
   * behaviour worth having: what the screen shows is what was stored.
   */
  await page.waitForFunction(
    () => document.querySelectorAll('textarea[aria-invalid="true"]').length === 0,
    null,
    { timeout: 15000 },
  );
});

await step('a Parts job offers no labour, travel or call-out capture', async () => {
  await page.goto(`${BASE}/jobs/EJE-1064`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1064' }).first().waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: /^Parts/ }).click();
  await page.getByText('carries no labour, travel or call-out fee', { exact: false })
    .waitFor({ timeout: 8000 });
  if (await page.getByRole('button', { name: 'Add labour' }).count() > 0) {
    throw new Error('a parts collection offered labour capture');
  }
  if (await page.getByRole('button', { name: 'Add travel' }).count() > 0) {
    throw new Error('a parts collection offered travel capture');
  }
  if (await page.getByText('Charge the call-out fee').count() > 0) {
    throw new Error('a parts collection offered a call-out fee');
  }
});

await step('a Parts job is NOT accepted by anybody — MASTER SCOPE CR-12', async () => {
  /*
   * > **Superseded:** this step used to click *Accept job*, confirm it, and
   * > assert only that no site location was offered afterwards. A collection is
   * > raised straight into its own close-out now: there is no acceptance step
   * > to click, for the office or for anyone else.
   */
  if ((await page.getByRole('button', { name: 'Accept job' }).count()) !== 0) {
    throw new Error('a parts collection was offered an Accept action');
  }
  // Parts leave the EJE counter, so there is no site to send anyone to.
  if ((await page.getByText('Send Site Location?').count()) > 0) {
    throw new Error('a parts collection offered to send a site location');
  }
  // And it is waiting at the counter, not in the open pool.
  await page.getByText('Completion', { exact: false }).first().waitFor({ timeout: 10000 });
});

await step('the collector, not the customer, signs for parts', async () => {
  // Already at its close-out, so the action is to carry on rather than to
  // start one. CR-12: raising a collection and processing it are one act.
  await page.getByRole('button', { name: 'Continue completing' }).click();
  await page.getByText('Step 1 of 5', { exact: false }).waitFor({ timeout: 15000 });

  // A collection has no checklist, but it IS asked who is collecting.
  const rail = page.locator('ol').filter({ hasText: 'Parts' }).last();
  const names = (await rail.locator('li').allInnerTexts()).map((line) =>
    line.replace(/^\d+\s*/, '').replace(/\s+/g, ' ').trim(),
  );
  if (names.length !== 5) throw new Error(`${names.length} steps: ${names.join(' | ')}`);
  if (names[0] !== 'Parts') {
    throw new Error(`the collection's first step is not Parts: ${names.join(' | ')}`);
  }
  if (!names.includes('Collection')) {
    throw new Error(`the collection was given no collection step: ${names.join(' | ')}`);
  }
  // Nothing was worked on, so there is no write-up to fill in. CR-12.
  if ((await page.getByLabel(/Work performed/).count()) !== 0) {
    throw new Error('a parts collection was asked for a completion write-up');
  }
  if (!names.includes('Collector signature')) {
    throw new Error(`the collection was sent to the wrong signatory: ${names.join(' | ')}`);
  }

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 2 of 5', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3 — who is collecting. Customer collection is the default, and needs
  // no waybill.
  await page.getByText('Step 3 of 5', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('heading', { name: 'How is this being collected?' }).waitFor({
    timeout: 8000,
  });
  const customerChoice = page.getByRole('button', { name: /Customer collection/ });
  if ((await customerChoice.getAttribute('aria-pressed')) !== 'true') {
    throw new Error('customer collection was not the default for EJE-1064');
  }
  if ((await page.getByLabel('Waybill number').count()) !== 0) {
    throw new Error('a customer collection was asked for a waybill');
  }
  await page.screenshot({ path: `${shots}/25-collection-type.png`, fullPage: false });

  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 4 of 5', { exact: false }).waitFor({ timeout: 15000 });

  await page.getByRole('heading', { name: 'Collector acknowledgement' }).waitFor({ timeout: 8000 });
  await page.getByText('I confirm that I have collected the parts listed above.').waitFor();
  await page.getByLabel('Collector name').waitFor();
  await page.getByLabel('Collector surname').waitFor();
  // Nothing about completed work: a collection acknowledges receipt of goods.
  if (await page.getByText('I confirm that the work described above has been completed.').count() > 0) {
    throw new Error('the parts collector was shown the work-completed declaration');
  }
  await page.screenshot({ path: `${shots}/13-collector-signature.png`, fullPage: false });
});

await step('capturing the collector signature produces a collection note', async () => {
  await page.getByLabel('Collector name').fill('Thabo');
  await page.getByLabel('Collector surname').fill('Dlamini');

  const pad = page.locator('div.touch-none').first();
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 110);
  await page.mouse.down();
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.move(box.x + 60 + i * 14, box.y + 110 - Math.sin(i / 2) * 35);
  }
  await page.mouse.up();

  await page.getByRole('button', { name: 'Confirm collection' }).click();
  await page.getByText('Step 5 of 5', { exact: false }).waitFor({ timeout: 20000 });
  await page.getByTestId('job-card-preview').waitFor({ timeout: 20000 });

  /*
   * THE COUNTER ISSUES ITS OWN COLLECTION NOTE. MASTER SCOPE SUBMIT-10.
   *
   * CR-07 gave the final submission to the technician who attended the
   * machine — and a parts collection is handed over at the EJE counter, not on
   * a customer's site. So the exception that has always governed accepting one
   * governs issuing it too: whoever processes it, issues it. This step is run
   * by a Master, and that is the case being held.
   */
  await page.getByRole('button', { name: 'Submit collection note' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Submit collection note' }).click();
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 25000 });

  await page.goto(`${BASE}/jobs/EJE-1064/review`, { waitUntil: 'networkidle' });
  await page.getByText('Parts Collection Note').first().waitFor({ timeout: 8000 });
  await page.getByText('OKA-WW-320').first().waitFor({ timeout: 8000 });
  await page.getByText('Thabo').first().waitFor({ timeout: 8000 });
});

/*
 * A workshop repair collected by a courier.
 *
 * The commercial rule in a browser: a driver collecting on the customer's
 * behalf is handed a document with no prices on it, and cannot be handed one at
 * all without a waybill number. EJE-1059 is a Test & Repair, which is now
 * collected from the counter exactly as parts are.
 */
await step('a Test & Repair offers a delivery note when the job is raised', async () => {
  await page.goto(`${BASE}/jobs/new`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'New Job' }).first().waitFor({ timeout: 15000 });

  // Nothing on a breakdown, which nobody collects and which has no delivery note.
  if ((await page.getByLabel('Delivery note / waybill number').count()) !== 0) {
    throw new Error('a breakdown was offered a delivery note');
  }
  /*
   * AND NOBODY IS OFFERED THE COLLECTION QUESTION HERE AT ALL, since Job
   * completion §6. It used to be on a Test & Repair; the owner asked for it to
   * wait until the job is finished, and it is now asked in the close-out
   * wizard with whoever turned up standing at the counter.
   */
  if ((await page.getByText('Courier Collection').count()) !== 0) {
    throw new Error('a breakdown was offered a courier collection');
  }

  await page.getByLabel('Job type').selectOption('test_and_repair');
  await page.getByLabel('Delivery note / waybill number').waitFor({ timeout: 8000 });
  if ((await page.getByText('Courier Collection').count()) !== 0) {
    throw new Error('a Test & Repair was offered the collection question at creation');
  }
  // The Test & Repair fields the owner asked for. §4.
  await page.getByLabel('Quote number').waitFor({ timeout: 8000 });
  await page.getByLabel('Part number').waitFor({ timeout: 8000 });

  // And on a parts collection too, which is the other thing collected.
  await page.getByLabel('Job type').selectOption('parts');
  await page.getByLabel('Delivery note / waybill number').waitFor({ timeout: 8000 });
  if ((await page.getByLabel('Quote number').count()) !== 0) {
    throw new Error('a parts collection was offered a quote number');
  }
  await page.screenshot({ path: `${shots}/27-new-job-delivery-note.png`, fullPage: false });
});

await step('a Test & Repair is worked and taken to its collection step', async () => {
  await page.goto(`${BASE}/jobs/EJE-1059`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1059' }).waitFor({ timeout: 10000 });

  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();

  /*
   * The site-location offer arrives when the SERVER has accepted the job, not
   * on the click, so it is waited for rather than counted. Counting first is
   * how a test passes on a fast machine and leaves a modal open on a slow one.
   */
  const decline = page.getByRole('button', { name: 'No, Thanks' });
  await decline.click({ timeout: 15000 }).catch(() => undefined);
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 15000 }).catch(() => undefined);

  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: '2', exact: true }).click();
  await page.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByText('Normal Time').first().waitFor({ timeout: 8000 });

  await page.getByRole('tab', { name: 'Completion' }).click();
  await page.getByLabel(/Work performed/).fill(
    'Bench tested the spindle drive and replaced the encoder coupling.',
  );
  // THE WRITE-UP SAVES ITSELF. MASTER SCOPE WRITEUP-1 — there is no Save
  // write-up button; the panel says Saved on its own once the typing stops.
  await page.getByText(/^Saved /).first().waitFor({ timeout: 20000 });

  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Complete job' }).click();
  await page.getByText('Step 1 of 5', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 2 of 5', { exact: false }).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 3 of 5', { exact: false }).waitFor({ timeout: 15000 });
});

await step('a courier collection will not continue without a waybill', async () => {
  await page.getByRole('button', { name: /Courier collection/ }).click();
  await page.getByLabel('Waybill number').waitFor({ timeout: 8000 });

  const cont = page.getByRole('button', { name: 'Continue' });
  if (!(await cont.isDisabled())) {
    throw new Error('a courier collection continued with no waybill number');
  }
  await page.getByLabel('Waybill number').fill('   ');
  if (!(await cont.isDisabled())) {
    throw new Error('whitespace was accepted as a waybill number');
  }

  await page.getByLabel('Waybill number').fill('DAW-4471');
  if (await cont.isDisabled()) throw new Error('a valid waybill was still refused');
  await page.screenshot({ path: `${shots}/28-courier-collection.png`, fullPage: false });
});

await step('the waybill sits immediately above the courier signature pad', async () => {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Step 4 of 5', { exact: false }).waitFor({ timeout: 15000 });

  const waybill = page.getByLabel('Waybill number');
  await waybill.waitFor({ timeout: 8000 });
  if ((await waybill.inputValue()) !== 'DAW-4471') {
    throw new Error('the waybill did not carry through to the signature step');
  }

  // Measured, not assumed: the waybill is the last thing above the pad.
  const pad = page.locator('div.touch-none').first();
  const padBox = await pad.boundingBox();
  const waybillBox = await waybill.boundingBox();
  if (waybillBox.y >= padBox.y) {
    throw new Error('the waybill is not above the signature pad');
  }
  const surname = await page.getByLabel('Collector surname').boundingBox();
  if (waybillBox.y <= surname.y) {
    throw new Error('the waybill is not immediately above the pad, below the name fields');
  }
  await page.screenshot({ path: `${shots}/29-waybill-above-signature.png`, fullPage: false });
});

await step('the courier signs, and the document carries no prices', async () => {
  await page.getByLabel('Collector name').fill('Johan');
  await page.getByLabel('Collector surname').fill('Pretorius');

  const pad = page.locator('div.touch-none').first();
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 110);
  await page.mouse.down();
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.move(box.x + 60 + i * 14, box.y + 110 - Math.sin(i / 2) * 35);
  }
  await page.mouse.up();
  await page.getByRole('button', { name: 'Confirm collection' }).click();

  await page.getByText('Step 5 of 5', { exact: false }).waitFor({ timeout: 20000 });
  // A test & repair is field work, so the technician who worked it submits it.
  await page.getByRole('button', { name: 'Submit job card' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Submit job card' }).click();
  await page.getByText('Awaiting Delivery', { exact: false }).first().waitFor({ timeout: 25000 });
  await page.goto(`${BASE}/jobs/EJE-1059/review`, { waitUntil: 'networkidle' });

  const card = await page.locator('article').first().innerText();
  // What the courier must see.
  for (const expected of ['Courier collection', 'DAW-4471', 'Johan']) {
    if (!card.includes(expected)) throw new Error(`the courier document omits "${expected}"`);
  }
  // What the courier must NOT see. "VAT" alone is EJE's own registration
  // number in the letter head, so the charges block itself is what is checked.
  for (const forbidden of ['VAT @', 'Subtotal', 'Total']) {
    if (card.includes(forbidden)) {
      throw new Error(`the courier document shows "${forbidden}"`);
    }
  }
  await page.screenshot({ path: `${shots}/30-courier-document.png`, fullPage: false });
});

await step('the same job still holds its prices internally', async () => {
  await page.goto(`${BASE}/jobs/EJE-1059`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  // Withheld from the courier's copy; never deleted from the job.
  await page.getByText(/R\u00a0[\d\u00a0]+,\d\d/).first().waitFor({ timeout: 8000 });
});

await step('a customer collection note SHOWS prices', async () => {
  await page.goto(`${BASE}/jobs/EJE-1062/review`, { waitUntil: 'networkidle' });
  await page.getByText('Parts Collection Note').first().waitFor({ timeout: 10000 });
  await page.getByText('LW-CLT-220').first().waitFor({ timeout: 8000 });
  // R 485,00 x 2 plus R 1 320,00 = R 2 290,00
  await page.getByText('R\u00a02\u00a0290,00').first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/14-parts-customer.png`, fullPage: false });
});

await step('a COURIER collection note carries no prices at all', async () => {
  await page.goto(`${BASE}/jobs/EJE-1063/review`, { waitUntil: 'networkidle' });
  await page.getByText('Delivery Note').first().waitFor({ timeout: 10000 });
  // The goods the driver is carrying — a delivery note with no delivery on it
  // is no use to the driver or to the receiving store.
  await page.getByText('SIE-6SL3-0.75').first().waitFor({ timeout: 8000 });
  await page
    .getByText('Prices are withheld from a courier collection.', { exact: false })
    .first()
    .waitFor({ timeout: 8000 });

  const note = await page.locator('article').first().innerText();
  if (/R\u00a0\d/.test(note)) {
    throw new Error(`a price leaked onto the courier note: ${note.match(/R\u00a0[\d\u00a0,]+/)?.[0]}`);
  }
  if (note.includes('Unit price')) {
    throw new Error('the courier note kept its unit price column');
  }
  // And the waybill, which this screen used to leave off while the PDF printed it.
  if (!note.includes('DSV-4471882')) {
    throw new Error('the courier note does not carry the waybill');
  }
  if (!note.includes('Courier collection')) {
    throw new Error('the courier note does not say who is collecting');
  }
  await page.screenshot({ path: `${shots}/15-parts-courier.png`, fullPage: false });
});

await step('the courier job still holds its prices internally', async () => {
  await page.goto(`${BASE}/jobs/EJE-1063`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /^Parts/ }).click();
  // Withheld from the customer-facing document, never deleted from the job.
  await page.getByText('SIE-6SL3-0.75').first().waitFor({ timeout: 8000 });
  await page.getByText('R\u00a012\u00a0400,00').first().waitFor({ timeout: 8000 });
});

await step('a technician can message the office', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Lerato Dlamini');
  await page.getByRole('heading', { name: /Hello, Lerato/ }).waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Messages', exact: true }).waitFor({ timeout: 10000 });
  // Messages are a separate place from Notifications, deliberately.
  await page.getByText('System alerts live under Notifications', { exact: false })
    .waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: 'New message' }).click();
  const compose = page.getByRole('dialog');
  await compose.waitFor({ timeout: 5000 });
  // A technician does not have to guess which Master is on duty.
  await compose.getByText('Reaches every Master on duty', { exact: false })
    .waitFor({ timeout: 5000 });
  await compose.getByLabel('Message').fill(
    'Hi Christene. I have a doctor appointment tomorrow at 14:00. Back by 16:00.',
  );
  await compose.getByRole('button', { name: 'Send message' }).click();

  // The message lands in a thread the technician can see and reply in.
  await page.getByText('doctor appointment tomorrow', { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  await page.getByText('It does not change the job or anyone', { exact: false })
    .waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/16-messages-technician.png`, fullPage: false });
});

await step('the technician can carry on the same conversation, not start a new one', async () => {
  await page.getByLabel('Message').fill('The appointment is at the clinic in Edenvale.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('clinic in Edenvale', { exact: false }).first().waitFor({ timeout: 10000 });

  // Both messages sit in one thread, so one conversation is listed, not two.
  const threads = await page.getByRole('button', { name: /doctor appointment|clinic in Edenvale/ })
    .count();
  if (threads > 1) throw new Error('replying started a second conversation');
});

await step('the message alone does NOT make the technician unavailable', async () => {
  await page.goto(`${BASE}/technicians/user-tech-lerato`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Lerato/ }).first().waitFor({ timeout: 10000 });
  // A technician sees their own record but cannot change it.
  await page.getByText('send the office a message', { exact: false }).waitFor({ timeout: 8000 });
  if (await page.getByRole('button', { name: 'Mark unavailable' }).count() > 0) {
    throw new Error('a technician was offered the Master-only availability control');
  }
});

await step('the Master is notified of the message, and the notification opens the chat', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Elmarie Coetzee');
  await page.getByRole('heading', { name: /Good day, Elmarie/ }).waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/notifications`, { waitUntil: 'networkidle' });
  const row = page
    .locator('li')
    .filter({ hasText: 'New message from Lerato' })
    .first();
  await row.waitFor({ timeout: 10000 });
  // A message notification opens the conversation, NOT the job page.
  const link = row.getByRole('link', { name: 'Open conversation' });
  await link.waitFor({ timeout: 8000 });
  const href = await link.getAttribute('href');
  if (href === null || !href.startsWith('/messages?conversation=')) {
    throw new Error(`a chat notification pointed at ${href} instead of the conversation`);
  }
  await link.click();
  await page.getByText('doctor appointment tomorrow', { exact: false }).first()
    .waitFor({ timeout: 10000 });
});

await step('a Master sees the message and it says it changed nothing', async () => {
  await page.goto(`${BASE}/messages`, { waitUntil: 'networkidle' });
  await page.getByText('doctor appointment tomorrow', { exact: false }).first()
    .waitFor({ timeout: 10000 });
  await page.getByText('It does not change the job or anyone', { exact: false })
    .waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/16-messages-master.png`, fullPage: false });
});

await step('the Master can reply, so the technician is answered', async () => {
  await page.getByLabel('Message').fill('Noted Lerato, I have recorded it. Thanks.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('I have recorded it', { exact: false }).first().waitFor({ timeout: 10000 });
});

await step('the Master records the availability from the message', async () => {
  // Explicitly, from the technician's own message — never automatically.
  await page.getByRole('button', { name: 'Mark unavailable' }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByText('doctor appointment tomorrow', { exact: false })
    .waitFor({ timeout: 5000 });

  const iso = businessDate(1);
  await dialog.getByLabel('Start date').fill(iso);
  await dialog.getByLabel('End date').fill(iso);
  await dialog.getByLabel('From').fill('14:00');
  await dialog.getByLabel('To').fill('16:00');
  await dialog.getByRole('button', { name: 'Record availability' }).click();

  /*
   * THE RECORD IS WHAT IS ASSERTED, NOT A MESSAGE THAT MAY NOT APPEAR.
   *
   * This waited for "Availability recorded", which is the title of the CLASH
   * dialog — raised only when the period overlaps work already booked for that
   * technician, because nothing is ever reassigned on the office's behalf.
   * Whether it appears therefore depends on what the seed has scheduled for
   * the business date this runs on, so the step was quietly asserting the
   * seed's calendar. Both outcomes are waited for; the absence itself is then
   * asserted on the technician's record.
   */
  const clash = page.getByRole('button', { name: 'I’ll deal with these' });
  const noDialog = page.locator('body:not(:has([role="dialog"]))');
  await clash.or(noDialog).first().waitFor({ timeout: 15000 });
  if (await clash.isVisible().catch(() => false)) await clash.click();
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10000 });

  const record = page.locator('main');
  await record.getByText('14:00–16:00', { exact: false }).first().waitFor({ timeout: 10000 });
});

await step('a full-day and a multi-day period can both be recorded', async () => {
  await page.goto(`${BASE}/technicians/user-tech-naledi`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Mark unavailable' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Start date').fill(businessDate(40));
  await dialog.getByLabel('End date').fill(businessDate(44));
  // A multi-day period forces all-day: a time window across days is meaningless.
  await dialog.getByText('always all-day', { exact: false }).waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Record availability' }).click();

  await page.getByText('Upcoming').first().waitFor({ timeout: 10000 });
  await page.getByText('All day').first().waitFor({ timeout: 8000 });
});

await step('an "Other" period demands a description', async () => {
  await page.getByRole('button', { name: 'Mark unavailable' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Type').selectOption('other');
  await dialog.getByRole('button', { name: 'Record availability' }).click();
  await dialog.getByText('description is required', { exact: false }).waitFor({ timeout: 8000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await step('availability appears on the calendar with its time window', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 10000 });

  // The seeded part-day appointment is today, 09:00–11:00, and clashes with a
  // job — so the conflict panel must name the window, not just "unavailable".
  await page.getByText('Appointment · 09:00–11:00', { exact: false }).first()
    .waitFor({ timeout: 10000 });

  await page.getByRole('tab', { name: 'Day' }).click();
  await page.getByRole('heading', { name: /Technician availability/ }).waitFor({ timeout: 8000 });
  await page.getByText('09:00–11:00').first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/17-calendar-availability.png`, fullPage: false });
});

await step('an unavailable technician cannot be assigned to a clashing job', async () => {
  // EJE-1067 is scheduled today. Thabo is on sick leave covering today, so
  // assigning him must be refused by the domain, not merely discouraged.
  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1067' }).first().waitFor({ timeout: 10000 });

  await page.getByRole('button', { name: 'Assign', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Role on this job').selectOption('primary');
  await dialog.getByLabel('Technician').selectOption({ label: 'Thabo Nkosi — Field Technician' });
  await dialog.getByRole('button', { name: 'Assign' }).click();

  await dialog.getByText('Technician unavailable').waitFor({ timeout: 10000 });
  await dialog.getByText('Thabo Nkosi is unavailable', { exact: false })
    .waitFor({ timeout: 8000 });
  await dialog.getByText('sick leave', { exact: false }).waitFor({ timeout: 8000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await step('an available technician can still be assigned', async () => {
  await page.getByRole('button', { name: 'Assign', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Role on this job').selectOption('primary');
  await dialog.getByLabel('Technician').selectOption({ label: 'Deon Botha — Workshop Technician' });
  await dialog.getByRole('button', { name: 'Assign' }).click();

  await page.getByText('Deon Botha').first().waitFor({ timeout: 10000 });
});

await step('a Master can cancel an Open job, with a reason', async () => {
  await page.goto(`${BASE}/jobs/EJE-1066`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Cancel job' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Reason').selectOption('customer_resolved');
  await dialog.getByLabel('Description').fill('Customer resolved the fault before dispatch.');
  await dialog.getByRole('button', { name: 'Cancel job' }).click();

  await page.getByText('Cancelled', { exact: false }).first().waitFor({ timeout: 10000 });
  await page.getByText('Customer resolved issue').first().waitFor({ timeout: 8000 });
  await page.getByText('before dispatch', { exact: false }).first().waitFor({ timeout: 8000 });
});

await step('the cancelled job leaves the active lists but stays searchable', async () => {
  await page.goto(`${BASE}/jobs?status=open-work`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if ((await page.locator('table').innerText()).includes('EJE-1066')) {
    throw new Error('a cancelled job is still in open work');
  }

  await page.goto(`${BASE}/search?q=EJE-1066`, { waitUntil: 'networkidle' });
  await page.getByText('EJE-1066 — Cancelled').first().waitFor({ timeout: 10000 });
});

await step('a cancelled job is no longer an active bar on the calendar', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(700);
  if ((await page.locator('main').innerText()).includes('EJE-1066')) {
    throw new Error('a cancelled job is still shown as scheduled work');
  }
});

await step('a Master can delete a duplicate Open job', async () => {
  await page.goto(`${BASE}/jobs/EJE-1065`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Delete job' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Why should this job not exist?').fill('Duplicate of EJE-1058.');
  await dialog.getByRole('button', { name: 'Delete job' }).click();

  await page.waitForURL('**/jobs', { timeout: 10000 });
  await page.waitForTimeout(600);
  if ((await page.locator('table').innerText()).includes('EJE-1065')) {
    throw new Error('a deleted job is still in the job list');
  }
});

/*
 * REWRITTEN FOR THE CONFIRMED BUSINESS DECISION (DECISION 6).
 *
 * This used to assert that a deleted job was still there, labelled "Deleted",
 * with its reason on the record — the soft deletion the demonstration used to
 * perform. EJE have settled it: a deleted job is GONE, and what survives is the
 * audit event that says who deleted it and why. So the assertion becomes the
 * pair of facts the decision actually requires.
 */
await step('the deleted job is gone, and the audit trail outlives it', async () => {
  await page.goto(`${BASE}/jobs/EJE-1065`, { waitUntil: 'networkidle' });
  await page.getByText('Job not found').first().waitFor({ timeout: 10000 });

  // Nor by searching for it, even for the Master who deleted it. The term is
  // echoed back on the page, so the assertion is on the results.
  await page.goto(`${BASE}/search?q=EJE-1065`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  if ((await page.locator('a[href="/jobs/EJE-1065"]').count()) !== 0) {
    throw new Error('a deleted job is still findable');
  }

  // And the evidence remains, on the office's own trail.
  await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const trail = await page.locator('main').innerText();
  if (!trail.includes('EJE-1065')) {
    throw new Error('the audit trail lost the job it recorded the deletion of');
  }
  if (!trail.includes('Duplicate of EJE-1058.')) {
    throw new Error('the audit trail lost the reason the job was deleted');
  }
});

await step('an accepted job can no longer be deleted, only cancelled', async () => {
  // EJE-1067 is in progress with work already captured.
  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1067' }).first().waitFor({ timeout: 10000 });
  if (await page.getByRole('button', { name: 'Delete job' }).count() > 0) {
    throw new Error('a job with work captured against it was offered deletion');
  }
});

await step('a technician transfers their own job back to Open, keeping the work', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Deon Botha');
  await page.getByRole('heading', { name: /Hello, Deon/ }).waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Transfer job' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByText('All work already recorded stays on the job', { exact: false })
    .waitFor({ timeout: 5000 });
  await dialog.getByLabel('Reason').selectOption('vehicle_problem');
  await dialog.getByRole('button', { name: 'Return to Open Jobs' }).click();

  await page.getByText('Open').first().waitFor({ timeout: 10000 });
});

await step('the returned job still carries its labour, travel, parts and notes', async () => {
  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByText('FUS-HRC-32').first().waitFor({ timeout: 10000 });
  await page.getByText('Fault-finding on the spindle drive').first().waitFor({ timeout: 8000 });
  await page.getByText('Isando to Vereeniging').first().waitFor({ timeout: 8000 });

  await page.getByRole('tab', { name: /Notes/ }).click();
  await page.getByText('weekend shift', { exact: false }).first().waitFor({ timeout: 8000 });
});

await step('the transfer is on the activity trail with its reason', async () => {
  await page.getByRole('tab', { name: 'Activity' }).click();
  await page.getByText('to Open Jobs', { exact: false })
    .first().waitFor({ timeout: 10000 });
  await page.getByText('Vehicle problem', { exact: false }).first().waitFor({ timeout: 8000 });
});

await step('another technician accepts the returned job and sees the previous work', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Riaan van Wyk');
  await page.getByRole('heading', { name: /Hello, Riaan/ }).waitFor({ timeout: 10000 });

  await page.goto(`${BASE}/jobs/EJE-1067`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Accept job' }).click();
  await page.getByRole('button', { name: 'Accept and start' }).click();

  // The location prompt appears after acceptance, once.
  await page.getByText('Send Site Location?').waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'No, Thanks' }).click();

  await page.getByText('In Progress').first().waitFor({ timeout: 10000 });
  await page.getByRole('tab', { name: /Labour & Parts/ }).click();
  await page.getByText('FUS-HRC-32').first().waitFor({ timeout: 8000 });
});

await step('ACCEPT-2: a refused acceptance leaves the technician where they are', async () => {
  /*
   * The other half of the rule: NAVIGATION FOLLOWS A SUCCESSFUL ACCEPTANCE AND
   * NOTHING ELSE. The server is made to refuse the acceptance — the way it
   * genuinely would if somebody else took the job first — and the technician
   * must still be on the list they were standing on.
   */
  await page.goto(`${BASE}/jobs?status=open`, { waitUntil: 'networkidle' });
  await page.route('**/api/jobs/*/accept', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'workflow_refused',
          message: 'Another technician accepted this job first.',
          violations: [{ code: 'not_open', message: 'The job is no longer open.' }],
        },
      }),
    }),
  );

  const accept = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await accept.waitFor({ timeout: 10000 });
  await accept.click();
  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.waitForTimeout(1200);

  await page.unroute('**/api/jobs/*/accept');

  if (!/\/jobs\?status=open$/.test(page.url())) {
    throw new Error(`a refused acceptance navigated to ${page.url()}`);
  }
  // And nothing was accepted: the list still offers the job.
  await page.getByRole('button', { name: 'Accept', exact: true }).first().waitFor({ timeout: 8000 });
});

await step('accepting from the Open Jobs list also offers the site location', async () => {
  await page.goto(`${BASE}/jobs?status=open`, { waitUntil: 'networkidle' });
  const acceptButton = page.getByRole('button', { name: 'Accept', exact: true }).first();
  await acceptButton.waitFor({ timeout: 10000 });
  await acceptButton.click();

  await page.getByRole('button', { name: 'Accept and start' }).click();
  await page.getByText('Send Site Location?').waitFor({ timeout: 10000 });

  // Exactly one prompt, not one per render.
  const prompts = await page.getByText('Send Site Location?').count();
  if (prompts !== 1) throw new Error(`expected one location prompt, saw ${prompts}`);

  await page.getByRole('button', { name: 'Send Location' }).click();
  await page.getByText('Site location queued', { exact: false }).waitFor({ timeout: 10000 });
});

await step('ACCEPT-1: dismissing the outcome opens the job that was just accepted', async () => {
  /*
   * ACCEPTING A JOB TAKES THE TECHNICIAN TO THE JOB. MASTER SCOPE ACCEPT-1.
   *
   * Accepted from the Open Jobs list, the acceptance succeeded, the list
   * refreshed — and the technician was left standing on the list with the job
   * they had just taken no longer on it, having to find it again to do any of
   * the work they had just committed to.
   *
   * The site-location offer still comes first, because it is part of accepting
   * and navigating away would unmount it mid-question. Answering it is what
   * finishes the flow, and the job opens.
   */
  await page.getByRole('button', { name: 'Dismiss' }).first().click();
  await page.waitForURL(/\/jobs\/EJE-\d+$/, { timeout: 15000 });

  const url = page.url();
  const jobNumber = url.slice(url.lastIndexOf('/') + 1);
  await page.getByRole('heading', { name: jobNumber }).waitFor({ timeout: 10000 });
  // The accepted job, with the work in front of the technician.
  await page.getByText('In Progress').first().waitFor({ timeout: 10000 });
});

await step('the site location message carries job, customer, machine, site and a map link', async () => {
  // READ AS THE OFFICE. SEC-1: technicians cannot reach customer
  // correspondence, and `/api/outbox` answers 403 — so the message the
  // technician just queued is checked by the people entitled to see it.
  await signOut();
  await signInAsMasterIfNeeded();
  await page.goto(`${BASE}/notifications?tab=outbox`, { waitUntil: 'networkidle' });
  const outbox = await page.locator('main').innerText();
  for (const fragment of ['EJE-', 'google.com/maps']) {
    if (!outbox.includes(fragment)) {
      throw new Error(`the site location message is missing ${fragment}`);
    }
  }
});

await step('master dashboard and admin', async () => {
  // Already the Master by the step above, which had to be to read the outbox.
  await signInAsMasterIfNeeded();
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Good day, Elmarie/ }).waitFor({ timeout: 10000 });
  await page.getByText('Total Open Jobs').waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/07-master-dashboard.png`, fullPage: false });
});

await step('every dialog field accepts typing, not one character per click', async () => {
  /*
   * The regression this guards: the Modal moved focus to itself whenever its
   * `onClose` prop changed identity, which is every render, so a keystroke
   * pulled focus out of the input being typed into. Users could enter one
   * character per click, in every form in the application.
   *
   * `fill()` cannot see it — it sets the value in one operation. This types.
   */
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add customer' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });

  const types = async (label, text) => {
    const field = page.getByLabel(label);
    await field.click();
    await field.fill('');
    await page.keyboard.type(text, { delay: 15 });
    const value = await field.inputValue();
    if (value !== text) {
      throw new Error(`typing into "${label}" produced ${JSON.stringify(value)}`);
    }
    // Focus must still be in the field the user is typing into.
    const tag = await page.evaluate(() => document.activeElement?.tagName ?? 'none');
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      throw new Error(`focus left the field for ${tag} while typing "${label}"`);
    }
  };

  for (const [label, text] of [
    ['Company name', 'Typing Test Engineering'],
    ['Account number', 'TYP001'],
    ['Registration number', '1998/004521/07'],
    ['VAT number', '4220156783'],
    ['Industry', 'Precision Engineering'],
    ['Site name', 'Typing Test Works'],
    ['City / town', 'Johannesburg'],
    ['Street address', '14 Anvil Road, Isando'],
    ['First name', 'Marlene'],
    ['Surname', 'Fourie'],
  ]) {
    await types(label, text);
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

await step('the same is true of the Add Machine form', async () => {
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Machines' }).click();
  await page.getByRole('button', { name: 'Add machine' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });

  for (const [label, text] of [
    ['Manufacturer', 'Leadwell'],
    ['Model', 'V-40 Vertical Machining Centre'],
    ['Serial number', 'TYPING-TEST-0001'],
    ['Control system', 'Fanuc 0i-MF'],
    ['Notes', 'Typed into a textarea, one character at a time.'],
  ]) {
    const field = dialog.getByLabel(label);
    await field.click();
    await field.fill('');
    await page.keyboard.type(text, { delay: 15 });
    const value = await field.inputValue();
    if (value !== text) {
      throw new Error(`typing into "${label}" produced ${JSON.stringify(value)}`);
    }
  }
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await step('a Master can add a customer, with its first site', async () => {
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add customer' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });

  await dialog.getByLabel('Company name').fill('Zenith Precision Works');
  await dialog.getByLabel('Account number').fill('ZEN001');
  await dialog.getByLabel('Industry').fill('Precision machining');
  await dialog.getByLabel('Site name').fill('Zenith Germiston');
  await dialog.getByLabel('City / town').fill('Germiston');
  await dialog.getByLabel('Street address').fill('22 Anvil Street');
  await dialog.getByLabel('First name').fill('Marlize');
  await dialog.getByLabel('Surname').fill('Botha');

  await dialog.getByRole('button', { name: 'Create customer' }).click();
  await page.waitForURL('**/customers/**', { timeout: 10000 });
  await page.getByRole('heading', { name: 'Zenith Precision Works' }).first()
    .waitFor({ timeout: 10000 });
});

await step('the new customer is selectable when raising a job', async () => {
  await page.goto(`${BASE}/jobs/new`, { waitUntil: 'networkidle' });
  const options = await page.locator('select').first().locator('option').allTextContents();
  if (!options.some((option) => option.includes('Zenith Precision Works'))) {
    throw new Error('a newly created customer was not offered on the new job screen');
  }
});

await step('a Master can add a machine, which lands on the register confirmed', async () => {
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.getByText('ABC Engineering (Pty) Ltd').first().click();
  await page.getByRole('tab', { name: /Machines/ }).click();
  await page.getByRole('button', { name: 'Add machine' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Manufacturer').fill('Mazak');
  await dialog.getByLabel('Model').fill('QT-200');
  await dialog.getByLabel('Serial number').fill('MZ-QT200-11902');
  await dialog.getByRole('button', { name: 'Add machine' }).click();

  await page.getByText('MZ-QT200-11902').first().waitFor({ timeout: 10000 });
});

await step('a duplicate serial number is refused', async () => {
  /*
   * THIS STEP USED TO FAIL WITH NOTHING TO GO ON, and twice did: once locally
   * and once on the CI runner, with
   *
   *   locator.waitFor: Timeout 8000ms exceeded.
   *     - waiting for getByRole('dialog').getByText('is already on the register')
   *
   * which says only that the wording was not there. There are three different
   * reasons it might not be — the refusal had not come back yet, the dialog
   * said something ELSE (a missing site, a validation message), or the
   * duplicate was ACCEPTED and the dialog closed on a success — and the one
   * that matters most is the last, because it is the only one that is a defect
   * in the application rather than in this step.
   *
   * So the step now waits for whichever of those three happened and SAYS WHICH.
   * The assertion is unchanged: the refusal must appear.
   */
  await page.getByRole('button', { name: 'Add machine' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });

  /*
   * LET THE DIALOG SETTLE BEFORE TYPING INTO IT. This is the fix for the
   * failure this step produced on two CI runs and never locally:
   *
   *   locator.waitFor: Timeout 20000ms exceeded.
   *     - waiting for ...('is already on the register').or(body:not(:has(dialog)))
   *
   * — neither the refusal nor a closed dialog, for twenty seconds, which only
   * happens when the form came back with a DIFFERENT message.
   *
   * WHY IT CAME BACK WITH A DIFFERENT ONE. `MachineDialog` resets its draft in
   * an effect when `open` turns true. The element is visible before that effect
   * has run, so a `fill` that lands in the gap is wiped by the reset — and the
   * read-back below can happen in the same gap and see the value that is about
   * to be discarded. The dialog then submits an EMPTY serial, the server
   * refuses it for being empty rather than for being a duplicate, and the step
   * waits out its timeout on wording that was never coming. On this machine the
   * effect flushes before Playwright gets there; on a loaded runner it does not.
   *
   * The submit button is disabled until the customer's sites have loaded, so
   * waiting for it to be ENABLED waits for a render that is strictly after the
   * reset. Nothing is retried and nothing is relaxed: the fields are filled
   * once the form is ready to hold them.
   */
  const submit = dialog.getByRole('button', { name: 'Add machine' });
  await submit.waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(
    () => {
      const node = [...document.querySelectorAll('[role="dialog"] button')].find(
        (button) => (button.textContent ?? '').trim() === 'Add machine',
      );
      return node !== undefined && !node.disabled;
    },
    undefined,
    { timeout: 10000 },
  );

  await dialog.getByLabel('Manufacturer').fill('Mazak');
  await dialog.getByLabel('Model').fill('QT-250');
  // The serial already on the register, in a different case.
  const serial = dialog.getByLabel('Serial number');
  await serial.fill('mz-qt200-11902');

  /*
   * READ BACK WHAT THE FORM ACTUALLY HOLDS before submitting it.
   *
   * These are controlled inputs, and a `fill` that races a re-render can leave
   * a field short — which is the one failure mode that would make this step
   * fail for a reason that looks nothing like its name: a serial of
   * "mz-qt200-1190" is not a duplicate, the server accepts it, the dialog
   * closes, and the wait below times out on wording that was never coming.
   * There is a whole smoke step about this class of bug ("every dialog field
   * accepts typing, not one character per click"). One retry, then an
   * assertion that says what the field holds.
   */
  if ((await serial.inputValue()) !== 'mz-qt200-11902') await serial.fill('mz-qt200-11902');
  const typed = await serial.inputValue();
  if (typed !== 'mz-qt200-11902') {
    throw new Error(`the serial field holds "${typed}", so this is not the duplicate case`);
  }

  await submit.click();

  const refusal = dialog.getByText('is already on the register', { exact: false });
  const gone = page.locator('body:not(:has([role="dialog"]))');
  /*
   * A THIRD OUTCOME, WAITED FOR BY NAME. The form's own refusal notice is
   * `RuleViolationNotice`, which carries a heading whatever the reason is — so
   * "the dialog answered with something else" is now something this step
   * OBSERVES rather than something it times out on. The assertion below is
   * unchanged; what changes is that a failure says what the dialog said.
   */
  const answered = dialog.getByText('The machine could not be added', { exact: false });
  await refusal.or(gone).or(answered).first().waitFor({ timeout: 20000 });

  if (!(await refusal.isVisible().catch(() => false)) && !(await gone.count())) {
    const said = (await dialog.innerText().catch(() => '')).replace(/\s+/gu, ' ').trim();
    throw new Error(
      `the dialog refused the machine for a different reason (serial submitted: "${typed}"): ${said.slice(0, 400)}`,
    );
  }

  if (!(await refusal.isVisible().catch(() => false))) {
    /*
     * The dialog closed, which means the server took it. Ask what is on the
     * register: two machines sharing one serial is a real defect — a serial
     * number identifies one physical asset — and this is where it would be
     * found.
     */
    const serials = await page.evaluate(async (base) => {
      const response = await fetch(`${base}/api/machines`);
      if (!response.ok) return null;
      const body = await response.json();
      return (body?.data ?? [])
        .map((row) => row?.machine?.serialNumber ?? row?.serialNumber ?? '')
        .filter((serial) => String(serial).toLowerCase() === 'mz-qt200-11902');
    }, BASE);
    throw new Error(
      serials === null
        ? 'the dialog closed without refusing the duplicate, and the register could not be read'
        : `the duplicate was ACCEPTED (serial submitted: "${typed}"): ${serials.length} machine(s) now carry MZ-QT200-11902`,
    );
  }

  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await step('the customer overview shows the company details the office asked for', async () => {
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Company details' }).waitFor({ timeout: 8000 });

  for (const label of [
    'Registered name',
    'Account number',
    'Registration number',
    'VAT number',
    'Office number',
    'Industry',
    'Payment terms',
    'Customer since',
    'Office address',
  ]) {
    if ((await page.getByText(label, { exact: true }).count()) === 0) {
      throw new Error(`the overview does not show "${label}"`);
    }
  }
});

await step('the overview no longer shows a company email or a head office block', async () => {
  const body = await page.locator('main').innerText();
  if (body.includes('maintenance@abc-engineering-demo.co.za')) {
    throw new Error('the company email is still on the overview');
  }
  if ((await page.getByRole('heading', { name: 'Head office contacts' }).count()) !== 0) {
    throw new Error('the head office contact block is still on the overview');
  }
});

await step('neither customer form asks for a company email', async () => {
  // Email belongs to a named contact person, so a company address is not
  // something the office should be able to capture in the first place.
  await page.getByRole('button', { name: 'Edit' }).first().click();
  const editing = page.getByRole('dialog');
  await editing.waitFor({ timeout: 5000 });
  if ((await editing.getByLabel('Account email').count()) !== 0) {
    throw new Error('Edit Customer still asks for a company email');
  }
  await editing.getByRole('button', { name: 'Cancel' }).click();

  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Add customer' }).click();
  const adding = page.getByRole('dialog');
  await adding.waitFor({ timeout: 5000 });
  if ((await adding.getByLabel('Account email').count()) !== 0) {
    throw new Error('Add Customer still asks for a company email');
  }
  await adding.getByRole('button', { name: 'Cancel' }).click();
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
});

await step('the office address is edited on the customer, not on a site', async () => {
  await page.getByRole('button', { name: 'Edit' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Street address').fill('400 Corporate Park');
  await dialog.getByLabel('City or town').fill('Sandton');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('400 Corporate Park', { exact: false }).first().waitFor({ timeout: 10000 });
});

await step('contacts are added, edited and removed on Sites & Contacts', async () => {
  await page.getByRole('tab', { name: 'Sites & Contacts' }).click();
  await page.getByRole('heading', { name: 'Head office contacts' }).waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: 'Add contact' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });

  // Typed rather than filled: the edit dialogs must not lose focus either.
  for (const [label, text] of [
    ['First name', 'Thandi'],
    ['Surname', 'Ngwenya'],
    ['Role', 'Maintenance Manager'],
    ['Email', 'thandi@abc-engineering-demo.co.za'],
    ['Contact number', '+27 82 555 0999'],
  ]) {
    const field = dialog.getByLabel(label);
    await field.click();
    await field.fill('');
    await page.keyboard.type(text, { delay: 12 });
    if ((await field.inputValue()) !== text) {
      throw new Error(`typing into the contact "${label}" produced the wrong value`);
    }
  }
  await dialog.getByRole('button', { name: 'Add contact' }).click();
  await page.getByText('Thandi Ngwenya').first().waitFor({ timeout: 10000 });
  await page.getByText('Maintenance Manager').first().waitFor({ timeout: 8000 });
});

await step('a contact nothing refers to is deleted outright', async () => {
  const row = page.locator('li').filter({ hasText: 'Thandi Ngwenya' }).first();
  await row.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Remove' }).last().click();
  await page.getByText('has been deleted', { exact: false }).first().waitFor({ timeout: 10000 });
  // Scoped to the list: the outcome banner names the contact too, and matching
  // that would report a deletion that never happened. Waited for rather than
  // counted once, because the list re-fetches after the banner appears.
  const rows = page.locator('li').filter({ hasText: 'Thandi Ngwenya' });
  try {
    await rows.first().waitFor({ state: 'detached', timeout: 10000 });
  } catch {
    throw new Error('the deleted contact is still listed');
  }
});

await step('a contact a job has named is kept, not destroyed', async () => {
  // Pieter Nel signed EJE-1044. Removing him must archive rather than delete.
  const row = page.locator('li').filter({ hasText: 'Pieter Nel' }).first();
  await row.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Remove' }).last().click();
  await page.getByText('so the record is kept', { exact: false }).first()
    .waitFor({ timeout: 10000 });

  // And the job card that named him still renders.
  await page.goto(`${BASE}/jobs/EJE-1044/review`, { waitUntil: 'networkidle' });
  await page.getByText('Pieter Nel').first().waitFor({ timeout: 10000 });
});

await step('a site is added and edited', async () => {
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Sites & Contacts' }).click();
  await page.getByRole('button', { name: 'Add site' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('Site name').fill('Boksburg');
  await dialog.getByLabel('Street address').fill('14 Anvil Road');
  await dialog.getByLabel('City or town').fill('Boksburg');
  await dialog.getByRole('button', { name: 'Add site' }).click();
  await page.getByRole('heading', { name: 'Boksburg' }).first().waitFor({ timeout: 10000 });

  // A Card renders as a <section>, so a site card is located by the heading it
  // contains rather than by guessing at a wrapper div.
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Boksburg', exact: true }) })
    .first();
  await card.getByRole('button', { name: 'Edit' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('dialog').getByLabel('Site access').fill('Report to the weighbridge.');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Report to the weighbridge.', { exact: false })
    .first().waitFor({ timeout: 10000 });
});

await step('a site with machines on it cannot simply be removed', async () => {
  const johannesburg = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Johannesburg', exact: true }) })
    .first();
  await johannesburg.getByRole('button', { name: 'Remove' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Remove' }).last().click();
  await page.getByText('still has machines on it', { exact: false })
    .first().waitFor({ timeout: 10000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

await step('a machine carries the customer’s own machine number', async () => {
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Machines' }).click();
  const card = page.locator('section').filter({ hasText: 'LW-V40-70214' }).last();
  await card.getByRole('button', { name: 'Edit' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });

  const field = dialog.getByLabel('Machine number');
  await field.click();
  await page.keyboard.type('STM1', { delay: 15 });
  if ((await field.inputValue()) !== 'STM1') {
    throw new Error('typing the machine number lost characters');
  }
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('STM1').first().waitFor({ timeout: 10000 });
});

await step('the machine number is searchable on its own', async () => {
  await page.goto(`${BASE}/search?q=STM1`, { waitUntil: 'networkidle' });
  await page.getByText('Matched machine number', { exact: false })
    .first().waitFor({ timeout: 10000 });
  await page.getByText('STM1 — Leadwell V-40', { exact: false })
    .first().waitFor({ timeout: 10000 });
});

await step('the Coordinator signs in and gets the office, not a technician tablet', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Christene van Niekerk');
  await page.getByText('Total Open Jobs').waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${shots}/07-coordinator-dashboard.png`, fullPage: false });
});

await step('the Coordinator reaches Closed Jobs, which is what she invoices from', async () => {
  await page.goto(`${BASE}/jobs/closed`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Closed Jobs' }).first().waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044').first().waitFor({ timeout: 10000 });
});

await step('the Coordinator is offered no Rates & VAT tab, and cannot reach one', async () => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Users', exact: true }).waitFor({ timeout: 10000 });
  if ((await page.getByRole('tab', { name: 'Rates & VAT' }).count()) !== 0) {
    throw new Error('the Coordinator was offered the charge-out rates');
  }
  if ((await page.getByRole('tab', { name: 'Checklists' }).count()) !== 0) {
    throw new Error('the Coordinator was offered checklist administration');
  }
});

await step('the Coordinator cannot create anything but a technician', async () => {
  await page.getByRole('button', { name: 'Add user' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  const text = await dialog.innerText();
  if (!text.includes('Role: Technician')) {
    throw new Error('the Coordinator was offered a role other than Technician');
  }
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

await step('back to a Master for the rest of the office journey', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Elmarie Coetzee');
  await page.getByRole('heading', { name: /Good day, Elmarie/ }).waitFor({ timeout: 10000 });
});

await step('a technician-added machine is waiting for the Master to confirm', async () => {
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle' });
  await page.getByText('Vaal Toolroom Services').first().click();
  await page.getByRole('tab', { name: /Machines/ }).click();
  await page.getByText('Awaiting approval').first().waitFor({ timeout: 8000 });
  await page.getByRole('heading', { name: 'Awaiting your approval' }).waitFor({ timeout: 8000 });

  await page.getByRole('button', { name: 'Confirm on register' }).first().click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('Awaiting your approval'),
    { timeout: 10000 },
  );
});

await step('disabled users are kept out of the default user list', async () => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Active users/ }).waitFor({ timeout: 10000 });

  const active = await page.locator('table').first().innerText();
  if (active.includes('Yusuf Patel')) {
    throw new Error('a disabled user appeared in the active list');
  }

  await page.getByRole('tab', { name: /Disabled users/ }).click();
  await page.getByText('Yusuf Patel').first().waitFor({ timeout: 8000 });
});

await step('a Master cannot edit another Master, who stays listed', async () => {
  await page.getByRole('tab', { name: /Active users/ }).click();
  const denise = page.getByRole('row').filter({ hasText: 'Denise' }).first();
  // Listed, not hidden — with no management offered on the account at all.
  await denise.waitFor({ timeout: 8000 });
  await denise.getByText('Protected account').waitFor({ timeout: 8000 });
  if ((await denise.getByRole('button', { name: 'Manage' }).count()) !== 0) {
    throw new Error('a Master was offered Manage on another Master');
  }
});

await step('one Manage menu replaces the row of buttons', async () => {
  for (const gone of ['Availability', 'Reset password', 'Disable']) {
    if ((await page.getByRole('button', { name: gone, exact: true }).count()) !== 0) {
      throw new Error(`the old "${gone}" button is still in the table`);
    }
  }
  const sipho = page.getByRole('row').filter({ hasText: 'Sipho Mahlangu' }).first();
  await sipho.getByRole('button', { name: 'Manage' }).click();
  for (const item of ['Availability', 'Edit user and role', 'Reset password', 'Disable user']) {
    await page.getByRole('menuitem', { name: item }).waitFor({ timeout: 5000 });
  }
  await page.keyboard.press('Escape');
});

await step('a Master moves a technician to Coordinator and back', async () => {
  const row = () => page.getByRole('row').filter({ hasText: 'Sipho Mahlangu' }).first();

  await row().getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('menuitem', { name: 'Edit user and role' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });
  const options = await dialog.getByLabel('Role').locator('option').allTextContents();
  if (options.includes('Master')) throw new Error('Master was offered as an assignable role');
  await dialog.getByLabel('Role').selectOption({ label: 'Coordinator' });
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('Coordinator'),
    { timeout: 10000 },
  );

  await row().getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('menuitem', { name: 'Edit user and role' }).click();
  dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });
  await dialog.getByLabel('Role').selectOption({ label: 'Technician' });
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForTimeout(600);
  if (!(await row().innerText()).includes('Technician')) throw new Error('role did not revert');
});

await step('the role change is on the activity trail, with both roles', async () => {
  await page.goto(`${BASE}/activity`, { waitUntil: 'networkidle' });
  await page.getByText('from Technician to Coordinator', { exact: false })
    .first().waitFor({ timeout: 10000 });
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Users', exact: true }).click();
});

await step('a Master can add and then disable a technician', async () => {
  await page.getByRole('button', { name: 'Add user' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByLabel('First name').fill('Nomvula');
  await dialog.getByLabel('Surname').fill('Khumalo');
  await dialog.getByLabel('Email').fill('nomvula.khumalo@eje-demo.co.za');
  await dialog.getByRole('button', { name: 'Create user' }).click();

  const row = page.getByRole('row').filter({ hasText: 'Nomvula Khumalo' }).first();
  await row.waitFor({ timeout: 10000 });
  // A new account is a technician unless the Master chose otherwise.
  if (!(await row.innerText()).includes('Technician')) {
    throw new Error('a new user did not default to Technician');
  }

  await row.getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('menuitem', { name: 'Disable user' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disable user' }).click();

  await page.waitForFunction(
    () => !document.querySelector('table')?.innerText.includes('Nomvula Khumalo'),
    { timeout: 10000 },
  );
  await page.getByRole('tab', { name: /Disabled users/ }).click();
  await page.getByText('Nomvula Khumalo').first().waitFor({ timeout: 8000 });
});

await step('a Master can approve a technician document upload', async () => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Technical Library' }).click();
  await page.getByText('waiting for approval', { exact: false }).waitFor({ timeout: 10000 });

  const pending = page.getByRole('row').filter({ hasText: 'Amada HFE-1303' }).first();
  await pending.getByRole('button', { name: 'Approve' }).click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('waiting for approval'),
    { timeout: 10000 },
  );
});

await step('a used checklist version cannot be edited, only re-versioned', async () => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Checklists' }).click();
  await page.getByText('has been completed on a job', { exact: false })
    .first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${shots}/16-checklist-admin.png`, fullPage: false });
});

await step('a historical job card still renders the version it was answered against', async () => {
  // EJE-1044 was serviced six months ago against checklist v1.0-DEMO, while
  // v2.0-DEMO is the version issued to new jobs today.
  await page.goto(`${BASE}/jobs/EJE-1044/review`, { waitUntil: 'networkidle' });
  await page.getByText('1.0-DEMO', { exact: false }).first().waitFor({ timeout: 10000 });
});

await step('the Jobs screen offers the lists the office asks for by name', async () => {
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Jobs', exact: true }).waitFor({ timeout: 10000 });

  const chips = page.locator('main button[aria-pressed]');
  await chips.first().waitFor({ timeout: 10000 });
  // Each chip carries its own count, which is not part of its name.
  const labels = (await chips.allInnerTexts()).map((name) =>
    name.replace(/[\s\u00a0]*(\d+|—)\s*$/, '').replace(/\s+/g, ' ').trim(),
  );
  for (const label of ['Open work', 'Open', 'Awaiting spares', 'Awaiting delivery', 'Cancelled']) {
    if (!labels.includes(label)) {
      throw new Error(`the Jobs screen has no "${label}" quick filter (found ${labels.join(', ')})`);
    }
  }
  if (labels.some((label) => /master review/i.test(label))) {
    throw new Error(`the Jobs screen still offers a Master Review quick filter (${labels.join(', ')})`);
  }

  // A quick filter drives the same status filter the dropdown does.
  await page.getByRole('button', { name: /^Awaiting spares/ }).first().click();
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-'),
    { timeout: 10000 },
  );
  const selected = await page.getByLabel('Status').inputValue();
  if (selected !== 'awaiting_spares') {
    throw new Error(`the Awaiting spares quick filter left the Status filter on ${selected}`);
  }

  // Closed work leaves for the archive rather than filling the working list.
  const closed = page.getByRole('link', { name: /^Closed Jobs/ }).first();
  await closed.waitFor({ timeout: 8000 });
  await closed.click();
  await page.getByRole('heading', { name: 'Closed Jobs' }).waitFor({ timeout: 10000 });
  await page.screenshot({ path: `${shots}/18-jobs-quick-filters.png`, fullPage: false });
});

await step('the Jobs page shows no Master Review count, filter or badge', async () => {
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  const body = await page.locator('main').innerText();
  if (/master review/i.test(body)) throw new Error('Master Review is on the Jobs page');

  const options = await page.locator('select').first().locator('option').allTextContents();
  if (options.some((option) => /master/i.test(option))) {
    throw new Error(`the status filter offers: ${options.join(' | ')}`);
  }
  if (!options.includes('Review')) throw new Error('Review is missing from the status filter');
});

await step('a job left in the retired stage is listed under Review, not Master Review', async () => {
  await page.locator('select').first().selectOption({ label: 'Review' });
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1055'),
    { timeout: 10000 },
  );
  const table = await page.locator('table').first().innerText();
  if (/master review/i.test(table)) throw new Error('the list still says Master Review');

  await page.goto(`${BASE}/jobs/EJE-1055`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1055' }).waitFor({ timeout: 10000 });
  const detail = await page.locator('main').innerText();
  if (/master review/i.test(detail)) throw new Error('the job detail still says Master Review');
});

await step('Closed Jobs is its own place in the navigation', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const link = page.getByRole('link', { name: 'Closed Jobs' }).first();
  await link.waitFor({ timeout: 10000 });
  await link.click();
  await page.getByRole('heading', { name: 'Closed Jobs' }).waitFor({ timeout: 10000 });
  await page.getByText('Historical records', { exact: false }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/18-closed-jobs.png`, fullPage: false });
});

await step('the archive lists closed jobs, and only closed jobs', async () => {
  const table = page.getByRole('table');
  await table.waitFor({ timeout: 10000 });
  const text = await table.innerText();

  // Seeded closed work.
  for (const number of ['EJE-1056', 'EJE-1057', 'EJE-1062', 'EJE-1044', 'EJE-1039']) {
    if (!text.includes(number)) throw new Error(`${number} is closed but missing from the archive`);
  }
  // EJE-1055 is in Master Review, EJE-1045 was cancelled, EJE-1049 is open,
  // and EJE-1065 was deleted earlier in this run. None of them were issued.
  for (const number of ['EJE-1055', 'EJE-1045', 'EJE-1049', 'EJE-1065']) {
    if (text.includes(number)) throw new Error(`${number} is not a closed job but is in the archive`);
  }
});

await step('the archive shows the columns the office searches by', async () => {
  // Headers are upper-cased by the stylesheet, so compare case-insensitively.
  const header = (await page.getByRole('table').locator('thead').innerText()).toLowerCase();
  for (const column of ['job', 'customer / site', 'machine', 'type', 'technician', 'closed', 'order / ref']) {
    if (!header.includes(column)) throw new Error(`the archive has no ${column} column`);
  }
  const row = page.getByRole('row').filter({ hasText: 'EJE-1044' }).first();
  const cells = await row.innerText();
  for (const value of ['ABC Engineering', 'Johannesburg', 'LW-V40-70214', 'PO-86112', 'ABC-SVC-JHB-06']) {
    if (!cells.includes(value)) throw new Error(`the EJE-1044 row does not show ${value}`);
  }
});

await step('the archive can be searched by serial number, not just job number', async () => {
  const search = page.getByLabel('Search the archive');
  await search.fill('LW-V40-70214');
  await page.waitForFunction(
    () => !(document.querySelector('table')?.innerText ?? '').includes('EJE-1057'),
    { timeout: 10000 },
  );
  const text = await page.getByRole('table').innerText();
  if (!text.includes('EJE-1044') || !text.includes('EJE-1056')) {
    throw new Error('searching by serial number lost the jobs on that machine');
  }
});

await step('the archive can be searched by customer order number', async () => {
  const search = page.getByLabel('Search the archive');
  await search.fill('PO-86112');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1044')
      && !(document.querySelector('table')?.innerText ?? '').includes('EJE-1056'),
    { timeout: 10000 },
  );
});

await step('a search that matches nothing says so, rather than showing everything', async () => {
  await page.getByLabel('Search the archive').fill('ZZ-NOTHING-MATCHES');
  await page.getByText('No closed jobs match').waitFor({ timeout: 10000 });
  await page.getByText('0 closed jobs').waitFor({ timeout: 8000 });
});

await step('the archive filters by customer, job type and technician', async () => {
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('table').waitFor({ timeout: 10000 });

  await page.getByLabel('Job type').selectOption('installation');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1039')
      && !(document.querySelector('table')?.innerText ?? '').includes('EJE-1044'),
    { timeout: 10000 },
  );

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Technician').selectOption('user-tech-deon');
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1057')
      && !(document.querySelector('table')?.innerText ?? '').includes('EJE-1039'),
    { timeout: 10000 },
  );

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Customer').selectOption('cust-abc');
  await page.waitForFunction(
    () => !(document.querySelector('table')?.innerText ?? '').includes('EJE-1039'),
    { timeout: 10000 },
  );
  // Choosing the customer narrows the site list to that customer's own sites.
  const siteOptions = await page.getByLabel('Site').innerText();
  if (siteOptions.includes('Benoni Workshop')) {
    throw new Error("the Site filter offered another customer's site");
  }
});

await step('the archive filters by the date the job was closed', async () => {
  await page.getByRole('button', { name: 'Clear filters' }).click();

  /*
   * THE BOUNDARY COMES FROM THE DATA, NOT FROM A DATE SOMEBODY TYPED. QA-5.
   *
   * The demonstration closes EJE-1044 a hundred and eighty days before the
   * server started, so the `2026-04-01` that used to be here was correct for
   * about a fortnight either side of the day it was written and silently wrong
   * afterwards — the step would then wait ten seconds for a row the filter was
   * right to exclude, and report a defect in the application.
   *
   * The range is inclusive at both ends, so EJE-1044's own closing day keeps it
   * in and leaves out EJE-1062, closed two days ago. That is the behaviour
   * under test and it is unchanged.
   */
  const closedTo = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/jobs/closed`);
    if (!response.ok) return '';
    const body = await response.json();
    const rows = body?.data?.rows ?? [];
    const match = rows.find((row) => row?.job?.jobNumber === 'EJE-1044');
    return (match?.job?.closedAt ?? '').slice(0, 10);
  }, BASE);
  if (closedTo === '') throw new Error('could not read the day EJE-1044 was closed');

  await page.getByLabel('Closed to').fill(closedTo);
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1044')
      && !(document.querySelector('table')?.innerText ?? '').includes('EJE-1062'),
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: 'Clear filters' }).click();
});

/* -------------------------------------------------------------------------- */
/* SEARCH-4 — the archive, downloaded as a spreadsheet                        */
/* -------------------------------------------------------------------------- */

await step('SEARCH-4: the archive downloads as a CSV, built by the server', async () => {
  /*
   * THE FILE, NOT A SCREENSHOT OF A BUTTON. The download is caught and read:
   * the header row, a job the screen is showing, and the proof that the CSV is
   * the server's own answer rather than something assembled in the browser —
   * the request goes to `/api/jobs/closed/export`, where the authorisation is.
   */
  // Whatever the filter steps above left set: the file is "what is on screen",
  // so the screen is put back to the whole archive first.
  const clear = page.getByRole('button', { name: 'Clear filters' });
  // Disabled when nothing is filtered, which is already the state this step
  // wants — so it is clicked only when it would do something.
  if (await clear.isEnabled().catch(() => false)) await clear.click();
  await page.waitForFunction(
    () => (document.querySelector('table')?.innerText ?? '').includes('EJE-1044'),
    { timeout: 10000 },
  );

  const started = page.waitForEvent('download', { timeout: 25000 });
  await page.getByTestId('export-csv').click();
  const file = await started;
  if (!/^eje-closed-jobs-\d{4}-\d{2}-\d{2}\.csv$/.test(file.suggestedFilename())) {
    throw new Error(`the archive export is named ${file.suggestedFilename()}`);
  }

  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString('utf8');

  if (!csv.startsWith('\uFEFF')) throw new Error('the CSV has no BOM, so Excel will mis-read it');
  const [header, ...rows] = csv.replace('\uFEFF', '').trimEnd().split('\r\n');
  /*
   * BD-17, decided by the owner: the Master is one of the two roles allowed the
   * prices a closed job was issued at, so this file carries the four commercial
   * columns after the operational ones. The technician's refusal and the
   * Coordinator's permission are the next step.
   */
  const operational =
    'Job number,Closed,Customer,Site,Machine,Serial number,Job type,Technician,Order number,' +
    // TR-1: the Test & Repair unit, so the archive can be reconciled. Empty on
    // every other job type, exactly as Order number already is.
    'Reference number,Quote number,Part number,Part description,Quantity,Final job card';
  const prices = 'Subtotal (excl. VAT),VAT,Total (incl. VAT),Priced at';
  if (header !== `${operational},${prices}`) {
    throw new Error(`unexpected export columns: ${header}`);
  }
  if (!rows.some((row) => row.startsWith('EJE-1044,'))) {
    throw new Error('EJE-1044 is in the archive on screen and missing from the file');
  }
  console.log(`      ${rows.length} archive row(s) exported`);
});

await step('SEARCH-4: a technician is refused the archive file, the Coordinator is not', async () => {
  /*
   * THE SERVER REFUSES IT, NOT THE SCREEN. Asked as the technician's own
   * browser asks — same cookie, same origin — so what is proved is the route's
   * authorisation and not the absence of a button.
   */
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Sipho Mahlangu');

  const refused = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/jobs/closed/export`);
    return { status: response.status, body: (await response.text()).slice(0, 400) };
  }, BASE);
  if (refused.status !== 403) {
    throw new Error(`the technician got HTTP ${refused.status} for the archive export`);
  }
  if (refused.body.includes('Job number')) {
    throw new Error('the refused archive export still handed over rows');
  }

  const own = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/jobs/export?status=all`);
    return { status: response.status, body: await response.text() };
  }, BASE);
  if (own.status !== 200) throw new Error(`the technician got HTTP ${own.status} for their own list`);
  if (!own.body.includes('Job number,Status,Priority')) {
    throw new Error('the technician export is missing its header row');
  }
  if (/total|price|rate|vat/i.test(own.body.split('\r\n')[0] ?? '')) {
    throw new Error('the technician export carries a commercial column');
  }

  /*
   * BD-17 named two roles, not one. The Coordinator is the other, so the same
   * request that the technician was refused is served to her — with the price
   * columns, because the grant is the point of the decision.
   */
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Christene van Niekerk');
  const coordinator = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/jobs/closed/export`);
    return { status: response.status, body: (await response.text()).slice(0, 400) };
  }, BASE);
  if (coordinator.status !== 200) {
    throw new Error(`the Coordinator got HTTP ${coordinator.status} for the archive export`);
  }
  if (!coordinator.body.includes('Total (incl. VAT)')) {
    throw new Error('the Coordinator export is missing the prices BD-17 allows her');
  }

  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Elmarie Coetzee');
  await page.goto(`${BASE}/jobs/closed`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Closed Jobs' }).waitFor({ timeout: 10000 });
});

await step('opening a closed job shows the complete historical record', async () => {
  await page.getByRole('row').filter({ hasText: 'EJE-1044' }).first().click();
  await page.getByRole('heading', { name: 'EJE-1044' }).waitFor({ timeout: 10000 });

  const body = await page.locator('main').innerText();
  for (const value of [
    'ABC Engineering',
    'Johannesburg',
    'LW-V40-70214',
    'Riaan',
    'PO-86112',
    'ABC-SVC-JHB-06',
  ]) {
    if (!body.includes(value)) throw new Error(`the closed job record does not show ${value}`);
  }
  // Read-only, and it says why.
  await page.getByText('this job is closed', { exact: false }).first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: `${shots}/18-closed-job-record.png`, fullPage: true });
});

await step('a closed job carries its final signed document', async () => {
  await page.getByText('Final signed job card').waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
  await page.getByText('pieter.nel@abc-engineering-demo.co.za', { exact: false }).first()
    .waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'View Final PDF' }).waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Download Final PDF' }).waitFor({ timeout: 8000 });
});

await step('"View Final PDF" opens the stored document, and does not re-make it', async () => {
  await page.getByRole('button', { name: 'View Final PDF' }).click();
  // "Job card", not "Review job card": the job is CLOSED, so there is nothing
  // to review and nobody to submit it. MASTER SCOPE CR-07.
  await page.getByRole('heading', { name: 'Job card', exact: true }).waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
  await page.getByText('Issued and closed').waitFor({ timeout: 8000 });
  await page.getByText('Final document on file').waitFor({ timeout: 8000 });

  // Merely looking at an old job card must not append a new document event.
  await page.goto(`${BASE}/jobs/EJE-1044`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Activity/ }).click();
  const before = await page.getByText('document generated', { exact: false }).count();
  await page.goto(`${BASE}/jobs/EJE-1044/review`, { waitUntil: 'networkidle' });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
  await page.goto(`${BASE}/jobs/EJE-1044`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /Activity/ }).click();
  await page.getByText('Activity', { exact: false }).first().waitFor({ timeout: 8000 });
  const after = await page.getByText('document generated', { exact: false }).count();
  if (after !== before) {
    throw new Error(`viewing a closed job card regenerated its document (${before} -> ${after})`);
  }
});

await step('a closed parts collection keeps a collection note, not a job card', async () => {
  await page.goto(`${BASE}/jobs/EJE-1062`, { waitUntil: 'networkidle' });
  await page.getByText('EJE-1062-Final-Parts-Collection-Note.pdf').first()
    .waitFor({ timeout: 10000 });
});

/** The charge-out rate the office is currently using, from the Rates screen. */
const setNormalRate = async (rands) => {
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Rates & VAT' }).click();
  const normal = page.getByLabel('Normal Time');
  await normal.waitFor({ timeout: 10000 });
  await normal.fill(rands);
  await page.getByRole('button', { name: 'Save rates' }).click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Update rates' }).click();
  await page.getByText('Saved', { exact: true }).first().waitFor({ timeout: 10000 });
};

const documentTotals = async (jobNumber) => {
  await page.goto(`${BASE}/jobs/${jobNumber}/review`, { waitUntil: 'networkidle' });
  const frame = page.locator('.eje-document').first();
  await frame.waitFor({ timeout: 10000 });
  const text = await frame.innerText();
  const line = text.split('\n').find((candidate) => /TOTAL/i.test(candidate)) ?? '';
  if (line.length === 0) throw new Error(`${jobNumber} renders no total`);
  return line;
};

await step('a closed job keeps its own prices when the Master changes the rates', async () => {
  const before = await documentTotals('EJE-1044');

  // A rate rise the office applies today must not reach an invoice already
  // issued six months ago.
  await setNormalRate('2500.00');
  const after = await documentTotals('EJE-1044');
  if (after !== before) {
    throw new Error(`a rate change altered a closed job card: ${before} -> ${after}`);
  }

  // Put the demo rates back, so the rest of this run sees the seeded prices.
  await setNormalRate('950.00');
});

await step('the same closed job is reached from the customer and the machine history', async () => {
  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Job History' }).click();
  const fromCustomer = page.getByRole('row').filter({ hasText: 'EJE-1044' });
  await fromCustomer.first().waitFor({ timeout: 10000 });
  if (await fromCustomer.count() !== 1) {
    throw new Error('the customer history holds no single EJE-1044 row');
  }
  await fromCustomer.first().click();
  await page.getByRole('heading', { name: 'EJE-1044' }).waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });

  await page.goto(`${BASE}/machines/machine-abc-lv40`, { waitUntil: 'networkidle' });
  const fromMachine = page.getByRole('row').filter({ hasText: 'EJE-1044' });
  // Waited for before it is COUNTED, exactly as the customer half above does.
  // Counting a list that has not rendered yet reads zero and reports a missing
  // row, which is a timing artefact rather than a finding.
  await fromMachine.first().waitFor({ timeout: 10000 });
  if (await fromMachine.count() !== 1) {
    throw new Error('the machine history holds no single EJE-1044 row');
  }
  await fromMachine.first().click();
  await page.getByRole('heading', { name: 'EJE-1044' }).waitFor({ timeout: 10000 });
  await page.getByText('EJE-1044-Final-Job-Card.pdf').first().waitFor({ timeout: 8000 });
});

await step('global search finds by serial number', async () => {
  await page.goto(`${BASE}/search?q=LW-V40-70214`, { waitUntil: 'networkidle' });
  await page.getByText('Machines').first().waitFor({ timeout: 8000 });
  await page.getByText('Leadwell V-40').first().waitFor({ timeout: 8000 });
});

await step('technical library preview', async () => {
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
  await page.getByText('Leadwell V-40 Machine Manual').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Open' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.screenshot({ path: `${shots}/08-library.png`, fullPage: false });
});

/**
 * DEMONSTRATION DATA SAYS SO, IN A REAL BROWSER. October mandate §1.
 *
 * The seeded library is metadata and nothing else — nine documents with no
 * bytes behind them — and until this it was drawn exactly like EJE's own
 * records, down to "214 pages · 18.4 MB" for a manual nobody has uploaded.
 * These two steps are the screen, not the API: the label a person actually
 * sees, and the download that is NOT offered.
 */
await step('the library marks demonstration records SIMULATED, in the list', async () => {
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
  await page.getByText('Leadwell V-40 Machine Manual').waitFor({ timeout: 8000 });

  const badges = page.locator('[data-testid="library-simulated-badge"]');
  const count = await badges.count();
  if (count === 0) throw new Error('no document in the seeded library is marked SIMULATED');
  const badgeText = (await badges.first().innerText()).trim();
  if (badgeText !== 'SIMULATED') {
    throw new Error(`the badge reads "${badgeText}" rather than SIMULATED`);
  }

  // And the invented file facts are gone from the row.
  const facts = await page.locator('[data-testid="library-file-facts"]').first().innerText();
  if (!facts.includes('No stored file')) {
    throw new Error(`a metadata-only row still describes a file: ${facts}`);
  }
  if (/\d+ pages/u.test(facts)) {
    throw new Error(`a metadata-only row still claims a page count: ${facts}`);
  }
});

await step('a record with no file offers no download, and says why', async () => {
  await page.goto(`${BASE}/library`, { waitUntil: 'networkidle' });
  await page.getByText('Leadwell V-40 Machine Manual').waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Open' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });

  // The panel that replaces the preview, and the full sentence inside it.
  await page.locator('[data-testid="document-metadata-only"]').waitFor({ timeout: 8000 });
  const notice = await page.locator('[data-testid="simulated-notice"]').first().innerText();
  if (!notice.includes('NOT A GENUINE EJE DOCUMENT')) {
    throw new Error(`the notice does not say what the record is: ${notice}`);
  }
  if (!notice.toLowerCase().includes('nothing')) {
    throw new Error(`the notice does not say there is nothing to open: ${notice}`);
  }

  // NOTHING to download: no frame, no embed, no download action.
  const offers = await page
    .getByRole('dialog')
    .locator('iframe, embed, object, a[download], button:has-text("Download")')
    .count();
  if (offers !== 0) {
    throw new Error(`${offers} download or preview affordance(s) on a record with no file`);
  }

  // And the detail metadata says which kind of record it is.
  const detail = await page.getByRole('dialog').innerText();
  if (!detail.includes('SIMULATED — demonstration data')) {
    throw new Error('the document details do not state the record is demonstration data');
  }
  await page.keyboard.press('Escape');
});

await step('calendar shows jobs, multi-day service and leave', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 10000 });

  // Month view by default, with the seeded multi-day service visible.
  await page.getByRole('tab', { name: 'Month' }).waitFor({ timeout: 8000 });
  await page.getByText('EJE-1049').first().waitFor({ timeout: 8000 });

  // A multi-day bar must be visibly wider than a single-day one.
  // A multi-day bar is legitimately split when it crosses a week boundary, so
  // compare the widest fragment.
  const widest = async (selector) => {
    const boxes = await page.locator(selector).all();
    let max = 0;
    for (const box of boxes) {
      const rect = await box.boundingBox();
      if (rect !== null) max = Math.max(max, rect.width);
    }
    return max;
  };

  const multiDay = await widest('a[href="/jobs/EJE-1049"]');
  const single = await widest('a[href="/jobs/EJE-1048"]');
  if (multiDay === 0 || single === 0) throw new Error('calendar bars not rendered');
  if (multiDay <= single) {
    throw new Error(
      `multi-day service (${multiDay}px) does not span more than a single-day job (${single}px)`,
    );
  }

  await page.screenshot({ path: `${shots}/15-calendar-month.png`, fullPage: false });
});

await step('calendar shows technician leave and sick leave', async () => {
  const leaveChips = await page.getByText('Leave', { exact: true }).count();
  const sickChips = await page.getByText('Sick', { exact: true }).count();
  if (leaveChips === 0) throw new Error('no annual leave on the calendar');
  if (sickChips === 0) throw new Error('no sick leave on the calendar');
});

await step('the month grid is compact — job numbers, not job details', async () => {
  const bar = page.locator('a[href="/jobs/EJE-1048"]').first();
  await bar.waitFor({ timeout: 8000 });
  const text = (await bar.innerText()).trim();

  // The month cell carries the number and the colour. Customer, site, machine
  // and technician are one tap away, not crammed into the grid.
  if (!text.includes('EJE-1048')) throw new Error(`month bar lost its job number: "${text}"`);
  for (const secondary of ['ABC Engineering', 'Leadwell', 'Johannesburg']) {
    if (text.includes(secondary)) {
      throw new Error(`month bar still carries "${secondary}"`);
    }
  }
});

await step('availability bars are slimmer than job bars', async () => {
  const jobBar = await page.locator('a[href^="/jobs/EJE-"] > span').first().boundingBox();
  const absenceBar = await page
    .locator('button[aria-label*="Leave"] > span, button[aria-label*="Sick"] > span')
    .first()
    .boundingBox();

  if (jobBar === null || absenceBar === null) throw new Error('bars not rendered');
  if (absenceBar.height >= jobBar.height) {
    throw new Error(
      `absence (${absenceBar.height}px) does not read as secondary to work (${jobBar.height}px)`,
    );
  }
});

await step('every calendar bar stays a usable tap target on a tablet', async () => {
  const targets = await page
    .locator('a[href^="/jobs/EJE-"], button[aria-label*="Leave"], button[aria-label*="Sick"]')
    .all();

  for (const target of targets.slice(0, 12)) {
    const box = await target.boundingBox();
    if (box !== null && box.height < 20) {
      throw new Error(`a calendar bar is only ${box.height}px tall — too small to tap`);
    }
  }
});

await step('a busy day collapses behind "+N more" rather than stretching', async () => {
  const more = page.getByText(/^\+ \d+ more$/).first();
  await more.waitFor({ timeout: 8000 });

  // Every week row is a comparable height, because the cap holds.
  const rows = await page.locator('div.relative.border-b').all();
  const heights = [];
  for (const row of rows) {
    const box = await row.boundingBox();
    if (box !== null) heights.push(box.height);
  }
  const tallest = Math.max(...heights);
  if (tallest > 200) {
    throw new Error(`a week row grew to ${tallest}px — the density cap is not holding`);
  }
});

await step('"+N more" reveals the whole day, losing nothing', async () => {
  const more = page.getByText(/^\+ \d+ more$/).first();
  const label = (await more.innerText()).trim();
  const hidden = Number(label.replace(/[^0-9]/g, ''));
  await more.click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });

  // The dialog lists the day in full — the bars that were drawn AND the ones
  // deferred, so nothing was removed to tidy the grid.
  const listed = await dialog.getByRole('listitem').count();
  if (listed <= hidden) {
    throw new Error(`"${label}" opened a list of only ${listed} — entries were lost`);
  }
  await page.screenshot({ path: `${shots}/18-calendar-day-more.png`, fullPage: false });
});

await step('selecting an entry there opens its details', async () => {
  await page.getByRole('dialog').getByRole('listitem').first().getByRole('button').click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });
  const text = await dialog.innerText();

  // Progressive disclosure: the detail carries what the grid deliberately left
  // out. It is a job or an absence, so accept either shape.
  const isJob = text.includes('Open job card');
  const needed = isJob
    ? ['CUSTOMER', 'SITE', 'MACHINE', 'SCHEDULED', 'TECHNICIAN']
    : ['TECHNICIAN', 'TYPE', 'TIME', 'DATES'];
  for (const field of needed) {
    if (!text.toUpperCase().includes(field)) {
      throw new Error(`entry detail is missing ${field}`);
    }
  }
  await page.keyboard.press('Escape');
});

await step('an availability bar opens its own detail, which a job page cannot show', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page
    .locator('button[aria-label*="Leave"], button[aria-label*="Sick"], button[aria-label*="Appointment"]')
    .first()
    .click({ timeout: 10000 });

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 8000 });
  await dialog.getByText('Unavailable').first().waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Open technician' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
});

await step('a job bar still goes straight to its job card', async () => {
  await page.locator('a[href="/jobs/EJE-1048"]').first().click();
  await page.waitForURL('**/jobs/EJE-1048', { timeout: 10000 });
  await page.getByRole('heading', { name: 'EJE-1048' }).first().waitFor({ timeout: 8000 });
});

await step('the calendar filters answer a planner\'s three questions', async () => {
  await page.goto(`${BASE}/calendar`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Calendar' }).waitFor({ timeout: 10000 });

  // "Who is available?" — availability only, no job bars at all.
  await page.getByRole('button', { name: 'Availability', exact: true }).click();
  await page.waitForTimeout(500);
  if ((await page.locator('a[href^="/jobs/EJE-"]').count()) !== 0) {
    throw new Error('the Availability filter still shows jobs');
  }

  // "What jobs are happening?" — jobs only.
  await page.getByRole('button', { name: 'Jobs', exact: true }).click();
  await page.waitForTimeout(500);
  if ((await page.locator('button[aria-label*="Leave"]').count()) !== 0) {
    throw new Error('the Jobs filter still shows availability');
  }
  if ((await page.locator('a[href^="/jobs/EJE-"]').count()) === 0) {
    throw new Error('the Jobs filter shows no jobs');
  }

  // Narrowed to one job type.
  await page.getByLabel('Job type').selectOption('service');
  await page.waitForTimeout(500);
  if ((await page.locator('a[href="/jobs/EJE-1048"]').count()) !== 0) {
    throw new Error('a breakdown survived the Service job-type filter');
  }
  if ((await page.locator('a[href="/jobs/EJE-1049"]').count()) === 0) {
    throw new Error('the Service filter hid a service job');
  }

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Job type').selectOption('all');
});

await step('the legend survives the declutter', async () => {
  // Scoped to the legend: the new Job type filter has options with the same
  // names, and a hidden <option> is not what this is checking.
  const legend = page.locator('div').filter({ hasText: /^Key:/ }).last();
  await legend.waitFor({ timeout: 8000 });
  const text = await legend.innerText();

  for (const label of [
    'Breakdown',
    'Installation',
    'Service',
    'Test & Repair',
    'Parts',
    'Unavailable',
    'Sick leave',
  ]) {
    if (!text.includes(label)) throw new Error(`the legend lost "${label}"`);
  }
});

await step('week view carries more than month view does', async () => {
  await page.getByRole('tab', { name: 'Week' }).click();
  await page.waitForTimeout(700);

  const bars = await page.locator('a[href^="/jobs/EJE-"]').all();
  let sawCustomer = false;
  for (const bar of bars) {
    if ((await bar.innerText()).includes('Engineering') || (await bar.innerText()).includes('(Pty)')) {
      sawCustomer = true;
      break;
    }
  }
  if (!sawCustomer) {
    throw new Error('week view is as sparse as month view — it has room for the customer');
  }
  await page.getByRole('tab', { name: 'Month' }).click();
});

await step('calendar has day, week, month and year views', async () => {
  for (const view of ['Day', 'Week', 'Year', 'Month']) {
    await page.getByRole('tab', { name: view }).click();
    await page.waitForTimeout(250);
    const selected = await page.getByRole('tab', { name: view }).getAttribute('aria-selected');
    if (selected !== 'true') throw new Error(`${view} view did not activate`);
  }

  await page.getByRole('tab', { name: 'Week' }).click();
  await page.screenshot({ path: `${shots}/16-calendar-week.png`, fullPage: false });
  await page.getByRole('tab', { name: 'Year' }).click();
  await page.screenshot({ path: `${shots}/17-calendar-year.png`, fullPage: false });
});

await step('clicking a day opens the day view with its work and availability', async () => {
  await page.getByRole('tab', { name: 'Month' }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await page.getByRole('tab', { name: 'Day' }).click();
  await page.getByRole('heading', { name: /^Scheduled work/ }).waitFor({ timeout: 8000 });
  await page.getByRole('heading', { name: /^Technician availability/ }).waitFor({
    timeout: 8000,
  });
  await page.screenshot({ path: `${shots}/18-calendar-day.png`, fullPage: false });
});

await step('Machines is no longer a top-level navigation item', async () => {
  const machinesNav = await page
    .locator('nav a[href="/machines"]')
    .count();
  if (machinesNav !== 0) throw new Error('Machines is still in the sidebar');

  // The machine screens still work, and search still finds machines.
  await page.goto(`${BASE}/machines/machine-abc-lv40`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Leadwell V-40/ }).waitFor({ timeout: 8000 });
});

await step('tablet viewport layout', async () => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto(`${BASE}/jobs/EJE-1049`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1049' }).waitFor({ timeout: 8000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (overflow) throw new Error('horizontal overflow at 820px');
  await page.screenshot({ path: `${shots}/09-tablet.png`, fullPage: false });
});


// --- Theme -----------------------------------------------------------------
// Chromium returns computed colours in lab(), so every colour below is resolved
// to sRGB by painting it to a canvas rather than parsed out of the string.
const TO_RGB = `(value) => {
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b };
}`;

const relativeLuminance = `(rgb) => {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}`;

const themeState = () =>
  page.evaluate(
    ([toRgbSrc, lumSrc]) => {
      const toRgb = eval(toRgbSrc);
      const luminance = eval(lumSrc);
      const body = getComputedStyle(document.body);
      const heading = document.querySelector('h1');
      const bg = toRgb(body.backgroundColor);
      const result = {
        theme: document.documentElement.dataset.theme,
        colorScheme: body.colorScheme,
        bgLuminance: luminance(bg),
        headingContrast: null,
      };
      if (heading !== null) {
        const fg = luminance(toRgb(getComputedStyle(heading).color));
        const [hi, lo] = fg > result.bgLuminance ? [fg, result.bgLuminance] : [result.bgLuminance, fg];
        result.headingContrast = (hi + 0.05) / (lo + 0.05);
      }
      return result;
    },
    [TO_RGB, relativeLuminance],
  );

await step('the sidebar carries navigation and nothing else', async () => {
  await signInAsMasterIfNeeded();
  const sidebar = page.locator('aside').first();
  const text = await sidebar.innerText();
  for (const gone of ['New Job', 'Sign out', 'Elmarie']) {
    if (text.includes(gone)) throw new Error(`the sidebar still shows "${gone}"`);
  }
  if ((await sidebar.locator('button[aria-label^="Switch to"]').count()) !== 0) {
    throw new Error('the sidebar still has a theme control');
  }
  if ((await sidebar.getByRole('radiogroup', { name: 'Colour theme' }).count()) !== 0) {
    throw new Error('the sidebar still has the theme radiogroup');
  }
});

await step('the header carries the profile, and no global New Job', async () => {
  const header = page.locator('header').first();
  if ((await header.innerText()).includes('New Job')) {
    throw new Error('the header still has a global New Job button');
  }
  await header.getByText('Elmarie Coetzee').waitFor({ timeout: 8000 });
  await header.getByText('Master', { exact: true }).waitFor({ timeout: 8000 });

  await header.locator('[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
});

await step('New Job lives on the Jobs screen, and still works', async () => {
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'New Job' }).first().click();
  await page.waitForURL('**/jobs/new', { timeout: 10000 });
  await page.getByRole('heading', { name: 'New job' }).waitFor({ timeout: 8000 });
});

await step('the progress rail is the six stages of the live workflow', async () => {
  await page.goto(`${BASE}/jobs/EJE-1049`, { waitUntil: 'networkidle' });
  const rail = page.locator('ol').filter({ hasText: 'Customer Signature' }).first();
  await rail.waitFor({ timeout: 10000 });
  const stages = (await rail.locator('li').allInnerTexts()).map((line) =>
    line.replace(/^\d+\s*/, '').trim(),
  );
  const expected = ['Open', 'In Progress', 'Completion', 'Customer Signature', 'Review', 'Closed'];
  if (JSON.stringify(stages) !== JSON.stringify(expected)) {
    throw new Error(`rail is ${stages.join(' | ')}`);
  }
});

await step('a job left in the retired stage is still readable, shown at Review', async () => {
  await page.goto(`${BASE}/jobs/EJE-1055`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'EJE-1055' }).waitFor({ timeout: 10000 });
  const rail = page.locator('ol').filter({ hasText: 'Customer Signature' }).first();
  const stages = (await rail.locator('li').allInnerTexts()).map((line) =>
    line.replace(/^\d+\s*/, '').trim(),
  );
  if (stages.length !== 6) throw new Error(`${stages.length} stages on a historical job`);
  // Shown at the stage it actually reached, with no retired stage named.
  if (stages[4] !== 'Review') throw new Error(`historical job sits at: ${stages[4]}`);
  if (stages.some((stage) => /master/i.test(stage))) {
    throw new Error(`the rail still names a retired stage: ${stages.join(' | ')}`);
  }
});

await step('light is the default theme', async () => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  const state = await themeState();
  if (state.theme !== 'light') throw new Error(`expected light by default, got ${state.theme}`);
  if (state.bgLuminance < 0.7) throw new Error('light background is not light');
});

await step('switching to dark re-themes the application', async () => {
  const before = await themeState();

  await page.getByRole('button', { name: /Switch to dark mode/ }).first().click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');

  const after = await themeState();
  if (after.bgLuminance >= before.bgLuminance) throw new Error('background did not darken');
  if (after.bgLuminance > 0.12) throw new Error(`dark background too light: ${after.bgLuminance}`);
  if (!after.colorScheme.includes('dark')) throw new Error('color-scheme not set to dark');

  await page.screenshot({ path: `${shots}/10-dark-dashboard.png`, fullPage: false });
});

await step('there is exactly one theme control, and it is in the top bar', async () => {
  const toggles = await page.locator('button[aria-label^="Switch to"]').count();
  if (toggles !== 1) throw new Error(`${toggles} theme controls found, expected 1`);
  const inHeader = await page.locator('header button[aria-label^="Switch to"]').count();
  if (inHeader !== 1) throw new Error('the theme control is not in the top bar');
  // It reflects the theme in force, so the next click is the right one.
  const label = await page.locator('button[aria-label^="Switch to"]').getAttribute('aria-label');
  if (label !== 'Switch to light mode') throw new Error(`control out of sync: ${label}`);
});

await step('dark mode survives a full reload, applied before hydration', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const immediate = await page.evaluate(() => document.documentElement.dataset.theme);
  if (immediate !== 'dark') throw new Error(`theme lost on reload, got ${immediate}`);

  await page.waitForLoadState('networkidle');
  const settled = await page.evaluate(() => document.documentElement.dataset.theme);
  if (settled !== 'dark') throw new Error('theme reverted after hydration');
});

await step('dark mode applies across every major screen', async () => {
  for (const path of [
    '/jobs',
    '/jobs/EJE-1049',
    '/customers/cust-abc',
    '/machines',
    '/library',
    '/search?q=Leadwell',
    '/notifications',
    '/activity',
    '/schedule',
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    const state = await themeState();
    if (state.theme !== 'dark') throw new Error(`${path} lost the dark theme`);
    if (state.bgLuminance > 0.12) throw new Error(`${path} did not darken`);
    if (!state.colorScheme.includes('dark')) {
      throw new Error(`${path} did not set color-scheme for native controls`);
    }
    if (state.headingContrast !== null && state.headingContrast < 4.5) {
      throw new Error(
        `${path} heading contrast only ${state.headingContrast.toFixed(2)}:1`,
      );
    }
  }
});

await step('admin screens render in dark for a Master', async () => {
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signOut();
  await signInAs(page, 'Elmarie Coetzee');
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });

  const state = await themeState();
  if (state.theme !== 'dark') throw new Error('admin lost the dark theme');
  if (state.headingContrast < 4.5) {
    throw new Error(`admin heading contrast only ${state.headingContrast.toFixed(2)}:1`);
  }
  await page.screenshot({ path: `${shots}/11-dark-admin.png`, fullPage: false });
});

await step('the job card preview stays light, because it represents paper', async () => {
  await page.goto(`${BASE}/jobs/EJE-1054/review`, { waitUntil: 'networkidle' });
  const documentRgb = await page.evaluate(
    (toRgbSrc) => {
      const toRgb = eval(toRgbSrc);
      const article = document.querySelector('article[data-theme="light"]');
      return article === null ? null : toRgb(getComputedStyle(article).backgroundColor);
    },
    TO_RGB,
  );
  if (documentRgb === null) throw new Error('job card document not found');
  if (documentRgb.r < 240 || documentRgb.g < 240 || documentRgb.b < 240) {
    throw new Error(`job card should stay white, got ${JSON.stringify(documentRgb)}`);
  }
  await page.screenshot({ path: `${shots}/12-dark-jobcard.png`, fullPage: false });
});

await step('returning to light mode persists across a reload', async () => {
  await page.getByRole('button', { name: /Switch to light mode/ }).first().click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');

  await page.reload({ waitUntil: 'domcontentloaded' });
  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  if (after !== 'light') throw new Error(`expected light after reload, got ${after}`);

  const state = await themeState();
  if (state.bgLuminance < 0.7) throw new Error('light mode did not restore');
});

await step('a machine with job history is withdrawn, not destroyed', async () => {
  /*
   * Last, deliberately. Withdrawing a machine takes it out of the register, the
   * pickers and the searches, so running this earlier would change what every
   * later check is looking at — and a suite that quietly depends on the order
   * of its own side effects is worse than no suite.
   */
  await signInAsMasterIfNeeded();

  await page.goto(`${BASE}/customers/cust-abc`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Machines' }).click();
  const card = page.locator('section').filter({ hasText: 'LW-V40-70214' }).last();
  await card.getByRole('button', { name: 'Remove' }).first().click();
  await page.getByRole('dialog').waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: 'Remove' }).last().click();
  await page.getByText('so the machine is kept', { exact: false })
    .first().waitFor({ timeout: 10000 });

  // The closed job carried out on it still renders its machine.
  await page.goto(`${BASE}/jobs/EJE-1044/review`, { waitUntil: 'networkidle' });
  await page.getByText('LW-V40-70214').first().waitFor({ timeout: 10000 });
});


/* =========================================================================
 * THE INSTALLED TABLET APPLICATION. PWA-1, PWA-2, PWA-4, PWA-5, PWA-6.
 * CR-09 Phase 3.
 *
 * Last in the file, after the journey, because these checks register a service
 * worker and take the browser offline — both of which change the conditions
 * every earlier check runs under. The suite has already proved what the
 * application does; this proves what survives an installed tablet losing
 * signal.
 *
 * WHAT STILL NEEDS THE RUGGED TABLET AND CANNOT BE PROVED HERE: that Android
 * offers the install (ACC-PWA-1), that the launcher shows EJE's icon, that it
 * opens without browser furniture (ACC-PWA-2), that the real camera opens for
 * `capture="environment"` (ACC-PWA-3), and that any of it is usable one-handed
 * with gloves in daylight (ACC-PWA-6). Headless Chromium has no launcher, no
 * home screen and no camera.
 * ========================================================================= */

await step('every document links a manifest, and the manifest is installable', async () => {
  /*
   * RIAAN, NOT SIPHO. By this point in the suite Sipho's job has been signed,
   * submitted and closed, so his working list is empty — and a cache check
   * against an empty list proves nothing. Riaan still has open work, which is
   * what a technician starting a shift with a tablet actually has.
   */
  await signInAs(page, 'Riaan van Wyk', { base: BASE });
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });

  const href = await page.locator('link[rel="manifest"]').first().getAttribute('href');
  if (href === null) throw new Error('no manifest link in the document');

  const response = await page.request.get(new URL(href, BASE).href);
  if (!response.ok()) throw new Error(`manifest answered ${response.status()}`);
  const manifest = await response.json();

  if (manifest.display !== 'standalone') throw new Error(`display is ${manifest.display}`);
  if (manifest.start_url !== '/') throw new Error(`start_url is ${manifest.start_url}`);
  if (!/EJE/.test(manifest.name ?? '')) throw new Error('the manifest does not name EJE');

  // An icon of at least 192px that actually exists is what a browser requires
  // before it will offer the install at all.
  const icon = (manifest.icons ?? []).find((entry) => entry.sizes === '192x192');
  if (icon === undefined) throw new Error('no 192px icon declared');
  const iconResponse = await page.request.get(new URL(icon.src, BASE).href);
  if (!iconResponse.ok()) throw new Error(`the 192px icon answered ${iconResponse.status()}`);
  if ((await iconResponse.body()).length < 100) throw new Error('the 192px icon is empty');
});

await step('the service worker is served uncacheable, and it registers', async () => {
  const worker = await page.request.get(`${BASE}/eje-sw.js`);
  if (!worker.ok()) throw new Error(`/eje-sw.js answered ${worker.status()}`);
  const cacheControl = worker.headers()['cache-control'] ?? '';
  if (!/no-store/.test(cacheControl)) {
    // A worker a browser serves from its own HTTP cache is a build that cannot
    // be replaced.
    throw new Error(`the worker is cacheable: ${cacheControl}`);
  }

  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker?.getRegistration('/');
      return registration?.active !== null && registration?.active !== undefined;
    },
    undefined,
    { timeout: 30000 },
  );
});

await step('the worker caches the shell and NOTHING authenticated', async () => {
  // Give the activated worker a moment to have served this page's assets.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return { names, urls };
  });

  const offending = cached.urls.filter((url) => {
    const { pathname } = new URL(url);
    if (pathname.startsWith('/api/')) return true;
    if (pathname === '/eje-sw.js') return true;
    // Every page of this application is rendered for one signed-in person.
    return pathname === '/' || pathname === '/jobs' || pathname.startsWith('/jobs/');
  });
  if (offending.length > 0) {
    throw new Error(`cached what it must not: ${offending.join(', ')}`);
  }

  if (!cached.urls.some((url) => new URL(url).pathname === '/offline')) {
    throw new Error('the offline page was not precached');
  }
  if (!cached.urls.some((url) => new URL(url).pathname.startsWith('/_next/static/'))) {
    throw new Error('no build assets were cached, so the shell needs the network');
  }
});

await step('the technician’s assigned jobs are cached on the device', async () => {
  const stored = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['jobs', 'meta', 'device'], 'readonly');
          const jobs = tx.objectStore('jobs').getAll();
          const meta = tx.objectStore('meta').getAll();
          const device = tx.objectStore('device').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({ jobs: jobs.result, meta: meta.result, device: device.result });
          };
          tx.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );

  if (stored.jobs.length === 0) throw new Error('no jobs were cached');
  if (stored.meta.length !== 1) throw new Error(`${stored.meta.length} meta rows, expected one`);
  if (stored.device.length !== 1) throw new Error('the confirmed session was not recorded');

  // Every record is keyed by the signed-in user, which is what stops one
  // technician's jobs reaching the next person on the tablet.
  const userId = stored.device[0].userId;
  if (stored.jobs.some((job) => job.userId !== userId)) {
    throw new Error('a cached job belongs to another user');
  }

  // And the projection is the narrow one: no ids, no refusals, no document.
  const [first] = stored.jobs;
  for (const forbidden of ['customerId', 'siteId', 'machineId', 'signatureRefusals', 'finalDocument', 'primaryTechnicianId']) {
    if (Object.prototype.hasOwnProperty.call(first, forbidden)) {
      throw new Error(`the cache holds ${forbidden}`);
    }
  }
  if (typeof first.jobNumber !== 'string' || first.jobNumber.length === 0) {
    throw new Error('a cached job has no job number');
  }
});

/* ---- real evidence, and real offline capture ---------------------------- */

await step('checklist evidence is a real file, stored and served back', async () => {
  /*
   * CHK-EVIDENCE-1. The runner used to post an item id and a file NAME and
   * store nothing, against the very questions that gate the checklist's
   * completion.
   *
   * AN INSTALLATION JOB, because the installation checklist is the one whose
   * items are marked `photoRequired` — the service template has none, so it
   * would prove nothing about evidence. EJE-1050 is the seeded installation
   * job, open in the pool, and Thabo can take it.
   */
  await signInAs(page, 'Thabo Nkosi', { base: BASE });
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });

  const accept = page.getByRole('button', { name: 'Accept job' });
  if ((await accept.count()) > 0) {
    await accept.click();
    await page.getByRole('dialog').waitFor({ timeout: 8000 });
    await page.getByRole('button', { name: 'Accept and start' }).click();
    // Acceptance offers the site location; answering it finishes the flow.
    const decline = page.getByRole('button', { name: 'No, Thanks' });
    await decline.waitFor({ timeout: 15000 });
    await decline.click();
  }
  await page.getByText('In Progress').first().waitFor({ timeout: 20000 });

  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /^Checklist/ }).click();

  const start = page.getByRole('button', { name: 'Start checklist' });
  if ((await start.count()) > 0) {
    await start.click();
  }
  // The photograph controls appear only on the items the template marks
  // `photoRequired`, which is the only place evidence belongs.
  const input = page
    .locator('[data-testid^="checklist-photo-"][data-testid$="-gallery"]')
    .first();
  await input.waitFor({ state: 'attached', timeout: 15000 });

  await input.setInputFiles({
    name: 'bearing-condition.png',
    mimeType: 'image/png',
    buffer: pngBytes('bearing condition'),
  });

  // THE BROWSER DECODES WHAT IT FETCHED. A tile that renders proves the bytes
  // went up, were stored, and came back through the authenticated route.
  await page.locator('[data-testid="checklist-evidence-thumbnail"]').first().waitFor({
    timeout: 20000,
  });
  await page.waitForFunction(
    () => {
      const image = document.querySelector('[data-testid="checklist-evidence-thumbnail"]');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    },
    undefined,
    { timeout: 20000 },
  );
  await page.screenshot({ path: `${shots}/41-checklist-evidence.png`, fullPage: false });
});

await step('the office photographs a machine, and the register shows the photograph', async () => {
  // MACH-PHOTO-1. The register used to draw grey camera icons over storage
  // keys with nothing behind them.
  await signInAs(page, 'Elmarie Coetzee', { base: BASE });
  await page.goto(`${BASE}/machines`, { waitUntil: 'networkidle' });
  // The register is a table of rows, and a row opens the machine.
  await page.locator('main table tbody tr').first().click();
  await page.locator('[data-testid="machine-detail-photo-gallery"]').waitFor({
    state: 'attached',
    timeout: 20000,
  });

  await page.locator('[data-testid="machine-detail-photo-gallery"]').setInputFiles({
    name: 'rating-plate.png',
    mimeType: 'image/png',
    buffer: pngBytes('rating plate'),
  });

  await page.locator('[data-testid="machine-photo-thumbnail"]').first().waitFor({ timeout: 20000 });
  await page.waitForFunction(
    () => {
      const image = document.querySelector('[data-testid="machine-photo-thumbnail"]');
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
    },
    undefined,
    { timeout: 20000 },
  );
  await page.screenshot({ path: `${shots}/42-machine-photo.png`, fullPage: false });
});

await step('the machine register, and its camera, stay out of a technician’s reach', async () => {
  /*
   * THE PERMISSION THIS BATCH DID NOT WIDEN. MACH-PHOTO-1 gave machine
   * photographs real bytes; it gave nobody new access. The register is the
   * office's screen — `machines.manage` — and a technician is refused the page
   * outright, which is pre-existing behaviour worth locking in beside the new
   * upload route. The route itself refuses them too (403), proved in
   * `machine-photo-api.test.ts`.
   */
  await signInAs(page, 'Riaan van Wyk', { base: BASE });
  await page.goto(`${BASE}/machines`, { waitUntil: 'networkidle' });
  await page.getByText('Your role does not include this screen', { exact: false }).first().waitFor({
    timeout: 20000,
  });
  if ((await page.locator('[data-testid="machine-detail-photo-gallery"]').count()) > 0) {
    throw new Error('a technician was offered the machine camera');
  }
});

await step('with no connection, captured labour is HELD on the tablet and says so', async () => {
  /*
   * THE HEADLINE OF THIS BATCH. OFF-2, OFF-8.
   *
   * A technician in a plant basement captures 2.5 hours. The server cannot be
   * reached, so the capture is held on the device — and the screen says that
   * plainly rather than claiming it is saved.
   */
  /*
   * The job list first, while there IS a connection: signing in as somebody
   * else earlier in this file cleared the previous user's cached copy (the
   * shared-tablet rule), so this step fills Riaan's own cache rather than
   * depending on an earlier step's leftovers.
   */
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.locator('table').first().waitFor({ timeout: 20000 });

  await page.goto(`${BASE}/jobs/EJE-1049`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Labour & Parts' }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().waitFor({ timeout: 15000 });

  offlineExpected = true;
  await page.context().setOffline(true);

  await page.getByRole('button', { name: 'Add labour' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  // A labour line is hours only — what was done belongs in the write-up — so
  // the capture is driven through the hours field the dialog actually has.
  await dialog.getByLabel('Or enter hours').fill('2.5');
  await dialog.getByRole('button', { name: 'Add labour' }).last().click();

  // Held, not saved. The wording is the requirement.
  await page.getByTestId('capture-held').waitFor({ timeout: 15000 });
  await page.getByTestId('pending-work-heading').waitFor({ timeout: 15000 });
  const queued = await page.getByTestId('pending-work-list').innerText();
  if (!/Not sent/.test(queued)) throw new Error(`the queue does not say "Not sent": ${queued}`);
  if (!/2\.5/.test(queued)) throw new Error(`the queue does not name the capture: ${queued}`);

  // The panel sits above the tabs, so the unsent capture is visible from
  // anywhere on the job and not only from the tab it was captured on. OFF-8.
  await page.getByRole('tab', { name: 'Completion' }).click();
  await page.getByTestId('pending-work-heading').waitFor({ timeout: 15000 });
  const fromAnotherTab = await page.locator('main').innerText();
  if (!/not on the server/i.test(fromAnotherTab)) {
    throw new Error('the job screen does not say the work is not on the server');
  }

  const stored = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );
  if (stored.length !== 1) throw new Error(`${stored.length} rows held, expected 1`);
  if (stored[0].action !== 'add_labour') throw new Error(`held ${stored[0].action}`);
  if (stored[0].state !== 'pending') throw new Error(`held in state ${stored[0].state}`);
  // The key that makes the send safe to repeat.
  if (typeof stored[0].idempotencyKey !== 'string' || stored[0].idempotencyKey.length === 0) {
    throw new Error('the held capture carries no idempotency key');
  }
  await page.screenshot({ path: `${shots}/43-offline-held.png`, fullPage: false });
});

await step('the held capture survives the application being closed, offline', async () => {
  /*
   * ACC-OFF-6, measured rather than asserted in prose. A reload is the closest
   * a browser gets to a battery going flat — and offline it does NOT come back
   * to the job, because no job page is ever cached (deliberately): the service
   * worker answers the navigation with the offline page.
   *
   * So the test is the honest one: the tablet lands on the offline page, that
   * page SAYS the captures are still waiting, and they are still in the store.
   */
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('offline-unsent').waitFor({ timeout: 25000 });
  const notice = await page.getByTestId('offline-unsent').innerText();
  if (!/1 capture is waiting/.test(notice)) {
    throw new Error(`the offline page does not name the waiting capture: ${notice}`);
  }
  if (!/not on the job/i.test(notice)) {
    throw new Error('the offline page does not say the capture is not on the job');
  }

  const survived = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );
  if (survived.length !== 1) {
    throw new Error(`${survived.length} captures survived the reload, expected 1`);
  }
  await page.screenshot({ path: `${shots}/45-offline-unsent.png`, fullPage: false });
});

await step('when the signal returns, the held capture is sent and lands on the job', async () => {
  await page.context().setOffline(false);
  offlineExpected = false;

  /*
   * The queue flushes by itself on reconnection — no tap required — and the
   * row leaves the panel only when the SERVER has it. Then the labour is on
   * the job, through the ordinary read.
   */
  await page.goto(`${BASE}/jobs/EJE-1049`, { waitUntil: 'networkidle' });
  await page.getByTestId('pending-work-heading').waitFor({ state: 'detached', timeout: 30000 });

  const emptied = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').count();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );
  if (emptied !== 0) throw new Error(`${emptied} captures still held after the flush`);

  await page.getByRole('tab', { name: 'Labour & Parts' }).click();
  const labour = page.locator('main').getByText('2.5', { exact: false });
  await labour.first().waitFor({ timeout: 20000 });

  // ONE line of 2.5 hours, not two: the capture was sent once, under its own
  // key, however many times the flush ran.
  const rows = (await page.locator('main').innerText())
    .split('\n')
    .filter((line) => /\b2\.5\b/.test(line) && /h\b|hours/i.test(line));
  if (rows.length > 1) {
    throw new Error(`the capture landed ${rows.length} times: ${rows.join(' | ')}`);
  }
  await page.screenshot({ path: `${shots}/44-offline-sent.png`, fullPage: false });
});

await step('with the network off, the tablet still shows the cached jobs', async () => {
  const cachedNumbers = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('jobs', 'readonly').objectStore('jobs').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result.map((job) => job.jobNumber));
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );

  offlineExpected = true;
  await page.context().setOffline(true);
  try {
    // A full navigation, which is what the worker's navigate handler answers.
    await page.goto(`${BASE}/jobs`, { waitUntil: 'domcontentloaded' });

    // THE PAGE SAYS WHAT IT IS. It does not render an empty job list that
    // reads as "no jobs today".
    await page.getByText('could not reach the EJE server', { exact: false })
      .first().waitFor({ timeout: 20000 });

    const list = page.locator('[data-testid="cached-job-list"]');
    await list.waitFor({ timeout: 20000 });
    const shown = await list.innerText();
    const missing = cachedNumbers.filter((number) => !shown.includes(number));
    if (missing.length > 0) {
      throw new Error(`cached jobs not shown offline: ${missing.join(', ')}`);
    }

    // And it is honest about what cannot be done.
    const body = await page.locator('main').innerText();
    if (!/cannot be captured/i.test(body)) {
      throw new Error('the offline page does not say that work cannot be captured');
    }
    await page.screenshot({ path: `${shots}/40-offline-jobs.png`, fullPage: false });
  } finally {
    await page.context().setOffline(false);
    offlineExpected = false;
  }
});

await step('reopening after an interruption offers the job that was open', async () => {
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.locator('table').first().waitFor({ timeout: 20000 });

  const found = (await page.locator('table').first().innerText()).match(/EJE-\d+/);
  if (found === null) throw new Error('no job on the technician’s list to open');
  const jobNumber = found[0];

  // Open the job, which is what records the place — on arrival, because a flat
  // battery runs no code on the way out.
  await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Overview' }).first().waitFor({ timeout: 20000 });

  // ...then come back as a cold launch would, with no history behind it.
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  const notice = page.locator('[data-testid="resume-notice"]');
  await notice.waitFor({ timeout: 20000 });
  const text = await notice.innerText();
  if (!text.includes(jobNumber)) {
    throw new Error(`the resume notice names ${text} rather than ${jobNumber}`);
  }
  // It promises a place, not kept work.
  if (!/not kept/i.test(text)) throw new Error('the notice implies unsent work was kept');
});

await step('signing out leaves nothing of that technician on the tablet', async () => {
  await signOut();

  const remaining = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['jobs', 'meta', 'device', 'place'], 'readonly');
          const jobs = tx.objectStore('jobs').count();
          const meta = tx.objectStore('meta').count();
          const device = tx.objectStore('device').count();
          const place = tx.objectStore('place').count();
          tx.oncomplete = () => {
            db.close();
            resolve({
              jobs: jobs.result,
              meta: meta.result,
              device: device.result,
              place: place.result,
            });
          };
          tx.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );

  // A tablet handed to the next technician holds nothing of the last one's.
  const held = Object.entries(remaining).filter(([, count]) => count > 0);
  if (held.length > 0) {
    throw new Error(`the cache still holds ${held.map(([k, v]) => `${v} ${k}`).join(', ')}`);
  }
});

/**
 * A job this signed-in technician can capture work on, right now.
 *
 * Found rather than hard-coded: by the time these checks run, earlier steps
 * have transferred, accepted and closed their way through the seeded jobs, so
 * a job number written here would be a different job's by the end of the file.
 * The technician's own in-progress work comes first; failing that, one is
 * accepted out of the open pool through the real route, which is how a
 * technician gets a job in the first place.
 *
 * A parts collection is excluded: it captures no labour at all (CR-12), so it
 * is the one job type on which this suite's capture would be refused for a
 * reason that has nothing to do with what is being tested.
 */
const workableJob = async (target) => {
  const found = await target.evaluate(async () => {
    const read = async (path) => {
      const response = await fetch(path, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`${path} answered ${response.status}`);
      return response.json();
    };
    const me = (await read('/api/auth/me')).data.user;
    const rows = ((await read('/api/jobs')).data.rows ?? []).map((row) => row.job);
    const suitable = (job) => job.jobType !== 'parts';

    const mine = rows.find(
      (job) => job.primaryTechnicianId === me.id && job.status === 'in_progress' && suitable(job),
    );
    if (mine !== undefined) return { id: mine.id, jobNumber: mine.jobNumber };

    const open = rows.find(
      (job) => job.status === 'open' && job.primaryTechnicianId === null && suitable(job),
    );
    if (open === undefined) return null;
    const accepted = await fetch(`/api/jobs/${open.id}/accept`, { method: 'POST' });
    if (!accepted.ok) return null;
    return { id: open.id, jobNumber: open.jobNumber };
  });
  if (found === null) throw new Error('no job this technician can capture work on');
  return found;
};

/* ---- BD-14: photographing the machine from the job you are on ----------- */

await step('a technician photographs the machine from their own job', async () => {
  /*
   * BD-14, MACH-PHOTO-2. The register stays out of reach (asserted above); the
   * path EJE approved is the technician standing at the machine, on their own
   * job. The server checks the job is on this machine, is theirs and is live —
   * `machine-photo-api.test.ts` proves the refusals. This proves the path
   * exists at all, and that the panel says what it does NOT do.
   */
  await signInAs(page, 'Riaan van Wyk', { base: BASE });
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.locator('table').first().waitFor({ timeout: 20000 });
  const mine = await workableJob(page);

  await page.goto(`${BASE}/jobs/${mine.jobNumber}`, { waitUntil: 'networkidle' });
  const open = page.getByTestId('machine-photo-from-job-open');
  await open.waitFor({ timeout: 20000 });
  await open.click();

  const panel = await page.locator('main').innerText();
  if (!/does\s+not\s+change the machine record/i.test(panel)) {
    throw new Error('the panel does not say a photograph changes nothing');
  }

  await page.getByLabel('Caption for the machine photograph').fill('Rating plate');
  await page.setInputFiles(
    '[data-testid="machine-from-job-photo-gallery"]',
    { name: 'plate.png', mimeType: 'image/png', buffer: pngBytes('plate') },
  );
  await page.getByTestId('machine-photo-count').waitFor({ timeout: 25000 });
  const count = await page.getByTestId('machine-photo-count').innerText();
  if (!/photograph/.test(count)) throw new Error(`the count reads ${count}`);

  // And the register is still refused: a photograph is not a way in. The
  // machine record itself is unreachable from here.
  await page.goto(`${BASE}/machines`, { waitUntil: 'networkidle' });
  await page.getByText('Your role does not include this screen', { exact: false }).first().waitFor({
    timeout: 20000,
  });
});

/* ---- BD-15: a capture the job will not take, and the office's decision --- */

await step('a capture the job refuses is referred to the office, not lost', async () => {
  /*
   * BD-15, end to end, in a real browser.
   *
   * Riaan captures an hour offline. While the tablet is away the office moves
   * the job to somebody else — which is the commonest reason a late capture is
   * refused. On reconnection the server refuses it, the tablet hands it to the
   * office instead of retrying for ever, and the panel says who has it.
   */
  await signInAs(page, 'Riaan van Wyk', { base: BASE });
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.locator('table').first().waitFor({ timeout: 20000 });
  const { jobNumber } = await workableJob(page);

  await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Labour & Parts' }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().waitFor({ timeout: 15000 });

  offlineExpected = true;
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Add labour' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Or enter hours').fill('1.5');
  await dialog.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByTestId('pending-work-heading').waitFor({ timeout: 15000 });

  /*
   * The office, in its own browser, while the tablet is still offline — the
   * situation this feature exists for. A second context so the tablet's
   * session, cache and offline state are untouched.
   */
  const officeContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const office = await officeContext.newPage();
  try {
    await signInAs(office, 'Elmarie Coetzee', { base: BASE });
    const moved = await office.evaluate(async (number) => {
      const view = await fetch(`/api/jobs/${number}`, { headers: { accept: 'application/json' } });
      if (!view.ok) return { ok: false, why: `read ${view.status}` };
      const jobId = (await view.json()).data.view.job.id;

      const people = await fetch('/api/admin', { headers: { accept: 'application/json' } });
      if (!people.ok) return { ok: false, why: `admin ${people.status}` };
      const users = (await people.json()).data.users;
      const other = users.find(
        (user) => user.role === 'technician' && user.email !== 'riaan.vanwyk@eje-demo.co.za',
      );
      if (other === undefined) return { ok: false, why: 'no other technician' };

      /*
       * Reassignment, not a transfer: a transfer checks the receiving
       * technician's availability, and half the seeded technicians are on
       * leave on the day this suite runs. What matters here is only that the
       * job stops being Riaan's while his tablet is away.
       */
      const response = await fetch(`/api/jobs/${jobId}/assign_primary`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ technicianId: other.id }),
      });
      const body = response.ok ? null : await response.text();
      return { ok: response.ok, why: `assign ${response.status} ${body ?? ''}`, jobId };
    }, jobNumber);
    if (!moved.ok) throw new Error(`the office could not move the job: ${moved.why}`);

    // The signal comes back. The server refuses the capture, and the tablet
    // refers it rather than keeping it to itself or trying again for ever.
    await page.context().setOffline(false);
    offlineExpected = false;
    await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });

    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open('eje-job-cache');
          open.onerror = () => resolve(false);
          open.onsuccess = () => {
            const db = open.result;
            const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
            request.onsuccess = () => {
              db.close();
              resolve(request.result.some((row) => row.state === 'referred'));
            };
            request.onerror = () => resolve(false);
          };
        }),
      undefined,
      { timeout: 40000 },
    );

    const held = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('eje-job-cache');
          open.onerror = () => reject(new Error('IndexedDB could not be opened'));
          open.onsuccess = () => {
            const db = open.result;
            const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
            request.onerror = () => reject(new Error('the read failed'));
          };
        }),
    );
    const referred = held.filter((row) => row.state === 'referred');
    if (referred.length !== 1) throw new Error(`${referred.length} referred rows, expected 1`);
    if (typeof referred[0].referralId !== 'string' || referred[0].referralId.length === 0) {
      throw new Error('a referred capture carries no referral id');
    }
    // The office's record was made under the capture's OWN key, which is what
    // keeps the attempt traceable to the work.
    if (typeof referred[0].idempotencyKey !== 'string' || referred[0].idempotencyKey.length === 0) {
      throw new Error('the referred capture lost its idempotency key');
    }

    /*
     * THE OFFICE'S SCREEN. The capture is on it, named, with the server's own
     * refusal — and applying it runs the ordinary capture, so the hours land
     * on the job.
     */
    await office.goto(`${BASE}/captures`, { waitUntil: 'networkidle' });
    const list = office.getByTestId('open-referrals');
    await list.waitFor({ timeout: 25000 });
    const waiting = await list.innerText();
    if (!waiting.includes(jobNumber)) throw new Error(`the office list omits ${jobNumber}`);
    if (!/1\.5/.test(waiting)) throw new Error(`the office list omits the hours: ${waiting}`);
    if (!/Riaan/.test(waiting)) throw new Error('the office list does not name the technician');
    if (!/not .*(assigned|capture)/i.test(waiting)) {
      throw new Error(`the server's refusal is not shown: ${waiting}`);
    }
    await office.screenshot({ path: `${shots}/46-office-captures.png`, fullPage: false });

    await office.getByRole('button', { name: 'Decide' }).first().click();
    await office.getByRole('dialog').waitFor({ timeout: 10000 });
    await office.getByRole('button', { name: 'Record the decision' }).click();
    await office.getByTestId('resolved-referrals').waitFor({ timeout: 25000 });
    const dealt = await office.getByTestId('resolved-referrals').innerText();
    if (!/Applied/.test(dealt)) throw new Error(`the decision was not recorded: ${dealt}`);

    // The hours are on the job, through the ordinary capture.
    const landed = await office.evaluate(async (number) => {
      const view = await fetch(`/api/jobs/${number}`, { headers: { accept: 'application/json' } });
      const body = await view.json();
      return body.data.view.job.labour.map((line) => Number(line.hours));
    }, jobNumber);
    if (!landed.includes(1.5)) {
      throw new Error(`the applied capture is not on the job: ${JSON.stringify(landed)}`);
    }

    // And the tablet's own row goes once the office has finished with it.
    await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open('eje-job-cache');
          open.onerror = () => resolve(false);
          open.onsuccess = () => {
            const db = open.result;
            const request = db.transaction('pending', 'readonly').objectStore('pending').count();
            request.onsuccess = () => {
              db.close();
              resolve(request.result === 0);
            };
            request.onerror = () => resolve(false);
          };
        }),
      undefined,
      { timeout: 40000 },
    );
  } finally {
    await officeContext.close();
    await page.context().setOffline(false);
    offlineExpected = false;
  }
});

/* ---- OFF-CHK-1: a checklist answer held with no signal ------------------- */

await step('a checklist answer is held on the tablet, with what it was answering', async () => {
  /*
   * OFF-CHK-1. The headline of this batch's offline work: the body of a
   * service or installation job is its checklist, and a technician in a plant
   * basement could not answer a single question of it.
   *
   * EJE-1050 is the seeded installation job Thabo accepted and started a
   * checklist on earlier in this file — an installation, because that is the
   * job type whose template has the items this exercises.
   */
  await signInAs(page, 'Thabo Nkosi', { base: BASE });
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /^Checklist/ }).click();
  const start = page.getByRole('button', { name: 'Start checklist' });
  if ((await start.count()) > 0) await start.click();
  await page.getByRole('button', { name: 'Pass', exact: true }).first().waitFor({ timeout: 20000 });

  offlineExpected = true;
  await page.context().setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await page.context().setOffline(false);
  offlineExpected = false;

  // Back on the job with a connection, then the signal goes while the
  // technician is standing at the machine — which is the real sequence: the
  // template is on screen because they are looking at it.
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /^Checklist/ }).click();
  await page.getByRole('button', { name: 'Fail', exact: true }).first().waitFor({ timeout: 20000 });

  offlineExpected = true;
  await page.context().setOffline(true);
  try {
    await page.getByTestId('checklist-offline-notice').waitFor({ timeout: 20000 });

    // THE TEMPLATE'S OWN RULE, BEFORE ANYTHING IS HELD. A failure with no note
    // is not held — the same rule that gates the completion, applied at the
    // moment of capture rather than hours later.
    await page.getByRole('button', { name: 'Fail', exact: true }).first().click();
    const hold = page.locator('[data-testid^="checklist-hold-"]').first();
    await hold.waitFor({ timeout: 10000 });
    await hold.click();
    await page.getByText('the note has to be written before it can be held', { exact: false })
      .first().waitFor({ timeout: 15000 });

    const stillEmpty = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('eje-job-cache');
          open.onerror = () => reject(new Error('IndexedDB could not be opened'));
          open.onsuccess = () => {
            const db = open.result;
            const request = db.transaction('pending', 'readonly').objectStore('pending').count();
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
            request.onerror = () => reject(new Error('the read failed'));
          };
        }),
    );
    if (stillEmpty !== 0) throw new Error('an answer with no note was held anyway');

    // With the finding written down, the answer is held — and the row says
    // what it was answering, which is what lets the server refuse a stale one.
    const notes = page.getByPlaceholder('What was found, and what is recommended?').first();
    await notes.fill('Floor slab cracked under the left-hand foot.');
    await notes.blur();
    await hold.click();
    await page.locator('[data-testid^="checklist-held-"]').first().waitFor({ timeout: 20000 });

    const row = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('eje-job-cache');
          open.onerror = () => reject(new Error('IndexedDB could not be opened'));
          open.onsuccess = () => {
            const db = open.result;
            const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
            request.onerror = () => reject(new Error('the read failed'));
          };
        }),
    );
    const answers = row.filter((entry) => entry.action === 'answer_checklist');
    if (answers.length !== 1) throw new Error(`${answers.length} held answers, expected 1`);
    const payload = answers[0].payload;
    if (payload.choice !== 'fail') throw new Error(`held ${JSON.stringify(payload.choice)}`);
    if ((payload.notes ?? '').length === 0) throw new Error('the held answer lost its note');
    if (typeof payload.templateVersion !== 'string' || payload.templateVersion.length === 0) {
      throw new Error('the held answer does not say which version it answered');
    }
    if (!Object.prototype.hasOwnProperty.call(payload, 'expectedAnsweredAt')) {
      throw new Error('the held answer does not say which answer it replaces');
    }

    // The progress figure counts what the SERVER has, so a held answer does
    // not inflate it, and completing the checklist needs a connection.
    const body = await page.locator('main').innerText();
    if (!/needs a connection/i.test(body)) {
      throw new Error('the runner does not say that completing needs a connection');
    }
    await page.screenshot({ path: `${shots}/48-checklist-held.png`, fullPage: false });
  } finally {
    await page.context().setOffline(false);
    offlineExpected = false;
  }

  // The signal returns: the answer goes to the job through the ordinary route
  // and the row leaves the tablet.
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result.filter((row) => row.action === 'answer_checklist').length === 0);
          };
          request.onerror = () => resolve(false);
        };
      }),
    undefined,
    { timeout: 40000 },
  );

  /*
   * Read through the API rather than off the screen: the note lives in a
   * textarea, whose text is a VALUE and not page text, so a screen-scrape
   * would pass whatever happened.
   */
  const applied = await page.evaluate(async () => {
    const response = await fetch('/api/jobs/EJE-1050', {
      headers: { accept: 'application/json' },
    });
    const body = await response.json();
    return (body.data.view.job.checklist?.responses ?? []).map((entry) => ({
      itemId: entry.itemId,
      choice: entry.choice,
      notes: entry.notes,
      answeredAt: entry.answeredAt,
    }));
  });
  const landed = applied.find((entry) => (entry.notes ?? '').includes('Floor slab cracked'));
  if (landed === undefined) {
    throw new Error(`the held answer did not reach the job: ${JSON.stringify(applied)}`);
  }
  if (landed.choice !== 'fail') throw new Error(`it landed as ${landed.choice}`);
  if (landed.answeredAt === null) throw new Error('the applied answer carries no stamp');
});

await step('a held checklist answer the OFFICE has since changed is refused, not applied', async () => {
  /*
   * THE CONFLICT OFF-CHK-1 EXISTS FOR, end to end and through two browsers.
   *
   * A technician answers a checklist item in a basement; the tablet holds it.
   * While they are down there the OFFICE answers the same item — a Master may,
   * administratively — and the question becomes what happens when the signal
   * comes back. A queue that simply replays would overwrite an answer given by
   * somebody who knew something the held one does not, and nothing would say
   * so: CR-02 forbids exactly that.
   *
   * What must happen instead: the server refuses the stale capture, the capture
   * is RETAINED and referred to the office (BD-15), the job keeps the office's
   * answer, and the tablet says where the work went.
   *
   * The office is a SECOND browser context, online while the technician's is
   * not — which is the real shape of the situation and the only way to move the
   * server under a tablet that cannot reach it.
   */
  await signInAs(page, 'Thabo Nkosi', { base: BASE });
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /^Checklist/ }).click();
  await page.getByRole('button', { name: 'Pass', exact: true }).first().waitFor({ timeout: 20000 });

  /*
   * WHICH ITEM, AND THE ANSWER IT ALREADY HAS.
   *
   * An item that is ALREADY answered is the stronger case: the held capture
   * then carries `expectedAnsweredAt`, and the office changing the answer is
   * exactly what makes that expectation stale. An unanswered item would do, but
   * by this point in the suite EJE-1050's pass/fail items have all been
   * answered — and the replacement path is the one a technician actually takes
   * when they correct an answer in a basement.
   */
  const target = await page.evaluate(async () => {
    const response = await fetch('/api/jobs/EJE-1050', { headers: { accept: 'application/json' } });
    const body = await response.json();
    const job = body?.data?.view?.job ?? null;
    const template = body?.data?.view?.checklistTemplate ?? null;
    const responses = job?.checklist?.responses ?? [];
    const answered = new Map(
      responses
        .filter((entry) => entry?.answeredAt !== null)
        .map((entry) => [entry.itemId, entry.answeredAt]),
    );
    // The template's items live inside its SECTIONS, which is the shape the
    // view returns — flattened here rather than assumed away.
    const items = (template?.sections ?? []).flatMap((section) => section?.items ?? []);
    const item = items.find(
      (candidate) => candidate?.responseType === 'pass_fail_na' && answered.has(candidate.id),
    );
    return {
      jobId: job?.id ?? null,
      itemId: item?.id ?? null,
      answeredAt: item === undefined ? null : (answered.get(item.id) ?? null),
    };
  });
  if (target.itemId === null) throw new Error('EJE-1050 has no answered pass/fail item to contest');

  offlineExpected = true;
  await page.context().setOffline(true);
  let held = null;
  try {
    await page.getByTestId('checklist-offline-notice').waitFor({ timeout: 20000 });
    const scope = page.locator(`[data-testid="checklist-item-${target.itemId}"]`);
    await scope.waitFor({ timeout: 20000 });
    // N/A rather than Pass: a different answer from the one on the job, and one
    // the template does not require a note for.
    await scope.getByRole('button', { name: 'N/A', exact: true }).first().click();
    const hold = scope.locator('[data-testid^="checklist-hold-"]').first();
    await hold.waitFor({ timeout: 10000 });
    await hold.click();
    await page.locator(`[data-testid="checklist-held-${target.itemId}"]`).waitFor({ timeout: 20000 });

    /*
     * IT SURVIVES THE APPLICATION BEING CLOSED, STILL OFFLINE, AND KEEPS ITS
     * KEY. The key is what makes the later send a replay rather than a second
     * answer, so a restart that minted a new one would be a duplicate waiting
     * to happen.
     */
    const before = await page.evaluate(() => {
      return new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result.filter((entry) => entry.action === 'answer_checklist'));
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      });
    });
    if (before.length !== 1) throw new Error(`${before.length} held answers, expected 1`);
    held = before[0];

    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
    const after = await page.evaluate(() => {
      return new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result.filter((entry) => entry.action === 'answer_checklist'));
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      });
    });
    if (after.length !== 1) throw new Error('the held answer did not survive the restart');
    if (after[0].idempotencyKey !== held.idempotencyKey) {
      throw new Error('the restart minted a new idempotency key for the same capture');
    }
    if (after[0].payload.templateVersion !== held.payload.templateVersion) {
      throw new Error('the held answer lost the template version it was answered against');
    }

    /* ---- the office answers the same item, from its own browser ---------- */
    const office = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const officePage = await office.newPage();
    await signInAs(officePage, 'Elmarie Coetzee', { base: BASE, greeting: /Elmarie/ });
    const officeAnswer = await officePage.evaluate(
      async ([jobId, itemId]) => {
        const response = await fetch(`/api/jobs/${jobId}/answer_checklist`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            itemId,
            choice: 'fail',
            notes: 'Office: the customer reported this clamp as damaged before we arrived.',
          }),
        });
        return { status: response.status };
      },
      [target.jobId, target.itemId],
    );
    await office.close();
    if (officeAnswer.status !== 200) {
      throw new Error(`the office could not answer the item: HTTP ${officeAnswer.status}`);
    }
  } finally {
    await page.context().setOffline(false);
    offlineExpected = false;
  }

  /* ---- the signal returns, and the stale answer is NOT applied ---------- */
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });

  // The flush runs on reconnect; the capture ends with the office rather than
  // on the job. Either state proves it was refused — `referred` is the settled
  // outcome, `conflict` the moment before the referral is accepted.
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          request.onsuccess = () => {
            db.close();
            const answers = request.result.filter((row) => row.action === 'answer_checklist');
            resolve(
              answers.length === 1 &&
                (answers[0].state === 'referred' || answers[0].state === 'conflict'),
            );
          };
          request.onerror = () => resolve(false);
        };
      }),
    undefined,
    { timeout: 40000 },
  );

  // THE JOB KEEPS THE OFFICE'S ANSWER. This is the assertion CR-02 is about.
  const onTheJob = await page.evaluate(
    async (itemId) => {
      const response = await fetch('/api/jobs/EJE-1050', { headers: { accept: 'application/json' } });
      const body = await response.json();
      const responses = body?.data?.view?.job?.checklist?.responses ?? [];
      const found = responses.find((entry) => entry.itemId === itemId);
      return { choice: found?.choice ?? null, notes: found?.notes ?? '' };
    },
    target.itemId,
  );
  if (onTheJob.choice !== 'fail' || !onTheJob.notes.startsWith('Office:')) {
    throw new Error(
      `the held answer overwrote the office's: the job now says ${JSON.stringify(onTheJob)}`,
    );
  }

  // And the tablet says where the work went, rather than losing it.
  await page.getByTestId('pending-work-heading').waitFor({ timeout: 20000 });
  const panel = await page.getByTestId('pending-work-list').innerText();
  if (!/With the office|Refused/.test(panel)) {
    throw new Error(`the queue does not say what became of the capture: ${panel}`);
  }
  await page.screenshot({ path: `${shots}/51-checklist-conflict.png`, fullPage: false });

  /*
   * AND THE TECHNICIAN CLEARS IT, which is the end of this workflow: the office
   * has the capture, so the row's only remaining job is to tell them that, and
   * *Remove from tablet* is how they acknowledge it. Exercised here rather
   * than left behind — a referral nobody can clear would pile up on a shared
   * tablet, and the next step's count of what survives a sign-out would be
   * measuring this instead of its own work.
   */
  const remove = page
    .getByTestId('pending-work-list')
    .getByRole('button', { name: /Remove from tablet|Discard/ })
    .first();
  await remove.click();
  const confirm = page.getByRole('dialog');
  await confirm.waitFor({ timeout: 10000 });
  await confirm.getByRole('button', { name: /Remove it|Discard the capture/ }).click();
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').count();
          request.onsuccess = () => {
            db.close();
            resolve(request.result === 0);
          };
          request.onerror = () => resolve(false);
        };
      }),
    undefined,
    { timeout: 20000 },
  );
});

/* ---- OFF-WRITEUP-1: the write-up typed with no signal -------------------- */

await step('a write-up typed with no signal is kept on the tablet, as a draft', async () => {
  /*
   * OFF-WRITEUP-1. The write-up saves itself as it is typed, and offline every
   * one of those saves fails. It used to live in a React state variable, so a
   * tablet locking took three paragraphs of fault findings with it.
   *
   * It is a DRAFT and the screen says so: nothing sends it by itself, because
   * a write-up replaces a value on the job and replaying a replacement hours
   * later is the silent overwrite CR-02 forbids.
   */
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Completion' }).click();
  const findings = page.getByLabel('Fault findings');
  await findings.waitFor({ timeout: 20000 });

  offlineExpected = true;
  await page.context().setOffline(true);
  const typed = 'Slab cracked under the left-hand foot; levelling impossible until it is repaired.';
  try {
    await findings.fill(typed);
    await findings.blur();
    await page.getByRole('button', { name: 'Save now' }).click();

    // Said honestly: not saved, and kept here.
    await page.getByText('kept on this tablet', { exact: false }).first().waitFor({
      timeout: 25000,
    });

    const drafts = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('eje-job-cache');
          open.onerror = () => reject(new Error('IndexedDB could not be opened'));
          open.onsuccess = () => {
            const db = open.result;
            const request = db.transaction('drafts', 'readonly').objectStore('drafts').getAll();
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
            request.onerror = () => reject(new Error('the read failed'));
          };
        }),
    );
    if (drafts.length !== 1) throw new Error(`${drafts.length} drafts kept, expected 1`);
    if (!drafts[0].report.faultFindings.includes('Slab cracked')) {
      throw new Error('the draft does not hold what was typed');
    }
    if (typeof drafts[0].userId !== 'string' || drafts[0].userId.length === 0) {
      throw new Error('the draft names no owner');
    }

    // IT SURVIVES THE TABLET BEING CLOSED, which is the whole point.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('offline-unsent').waitFor({ timeout: 25000 }).catch(() => undefined);
    const stillKept = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('eje-job-cache');
          open.onerror = () => reject(new Error('IndexedDB could not be opened'));
          open.onsuccess = () => {
            const db = open.result;
            const request = db.transaction('drafts', 'readonly').objectStore('drafts').count();
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
            request.onerror = () => reject(new Error('the read failed'));
          };
        }),
    );
    if (stillKept !== 1) throw new Error('the draft did not survive the reload');
    await page.screenshot({ path: `${shots}/49-writeup-draft.png`, fullPage: false });
  } finally {
    await page.context().setOffline(false);
    offlineExpected = false;
  }

  /*
   * AND THE TECHNICIAN PUTS IT ON THE JOB. Nothing replayed it: the notice
   * offers it back, and loading it saves the ordinary way.
   */
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Completion' }).click();
  const notice = page.getByTestId('writeup-local-draft');
  await notice.waitFor({ timeout: 25000 });
  const noticeText = await notice.innerText();
  if (!/NOT on the server/i.test(noticeText)) {
    throw new Error(`the draft notice does not say it is unsaved: ${noticeText}`);
  }

  await page.getByTestId('writeup-use-draft').click();
  await page.getByRole('button', { name: 'Save now' }).click();
  await page.getByText('Saved', { exact: false }).first().waitFor({ timeout: 25000 });

  // On the server now, so the device's copy is gone and the notice with it.
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('drafts', 'readonly').objectStore('drafts').count();
          request.onsuccess = () => {
            db.close();
            resolve(request.result === 0);
          };
          request.onerror = () => resolve(false);
        };
      }),
    undefined,
    { timeout: 30000 },
  );

  const saved = await page.evaluate(async () => {
    const response = await fetch('/api/jobs/EJE-1050', { headers: { accept: 'application/json' } });
    const body = await response.json();
    return body.data.view.job.completionReport.faultFindings;
  });
  if (!saved.includes('Slab cracked')) {
    throw new Error(`the loaded draft did not reach the job: ${saved}`);
  }
});
await step('a write-up the server changed under a held draft is a CONFLICT, not an overwrite', async () => {
  /*
   * THE CASE CR-02 IS ABOUT, end to end.
   *
   * A technician types a write-up in a basement; the tablet holds it. While
   * there is no signal the same write-up is corrected at the other end — a
   * customer rang, a part number was wrong. "Load the draft into the form and
   * save" would then replace a correction made by somebody who knew something
   * the draft does not, and until now nothing said so: the notice offered the
   * draft exactly as it would over an empty field.
   *
   * The draft now carries what the server held when it was typed, so the two
   * cases can be told apart, and this one is put in front of the technician
   * with BOTH texts and no default.
   */
  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Completion' }).click();
  const findings = page.getByLabel('Fault findings');
  await findings.waitFor({ timeout: 20000 });
  const serverHeldBefore = await findings.inputValue();

  offlineExpected = true;
  await page.context().setOffline(true);
  const mine = 'Basement draft: the slab needs grouting before the machine can be levelled.';
  try {
    await findings.fill(mine);
    await findings.blur();
    await page.getByRole('button', { name: 'Save now' }).click();
    await page.getByText('kept on this tablet', { exact: false }).first().waitFor({ timeout: 25000 });
  } finally {
    await page.context().setOffline(false);
    offlineExpected = false;
  }

  /*
   * THE SERVER MOVES. Written through the API, which is the only way anything
   * reaches the job — a correction typed at a desk arrives exactly like this.
   */
  const theirs = 'Office correction: the slab was repaired by the customer on Tuesday.';
  const wrote = await page.evaluate(
    async ([text, held]) => {
      const response = await fetch('/api/jobs/EJE-1050', { headers: { accept: 'application/json' } });
      const body = await response.json();
      const job = body.data.view.job;
      const save = await fetch(`/api/jobs/${job.id}/save_report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The route takes the report's own fields, which is what the panel
        // sends: a correction typed at a desk arrives exactly like this.
        body: JSON.stringify({ ...job.completionReport, faultFindings: text }),
      });
      return { status: save.status, held };
    },
    [theirs, serverHeldBefore],
  );
  if (wrote.status !== 200) throw new Error(`the office correction was refused: HTTP ${wrote.status}`);

  await page.goto(`${BASE}/jobs/EJE-1050`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Completion' }).click();

  const conflict = page.getByTestId('writeup-draft-conflict');
  await conflict.waitFor({ timeout: 25000 });
  const notice = await page.getByTestId('writeup-local-draft').innerText();
  for (const fragment of ['changed on the server', 'On the job now', 'Your draft']) {
    if (!notice.includes(fragment)) throw new Error(`the conflict notice is missing "${fragment}"`);
  }
  if (!notice.includes('Office correction')) {
    throw new Error('the conflict does not show what is on the job now');
  }
  if (!notice.includes('Basement draft')) {
    throw new Error('the conflict does not show the draft it is weighed against');
  }
  // NOTHING WAS APPLIED: the form still holds the server's text.
  const inForm = await page.getByLabel('Fault findings').inputValue();
  if (inForm !== theirs) {
    throw new Error(`the draft was applied without being chosen: ${inForm}`);
  }
  await page.screenshot({ path: `${shots}/50-writeup-conflict.png`, fullPage: false });

  // And the technician's decision is what applies it.
  await page.getByTestId('writeup-use-draft').click();
  await page.getByRole('button', { name: 'Save now' }).click();
  await page.getByText('Saved', { exact: false }).first().waitFor({ timeout: 25000 });
  const after = await page.evaluate(async () => {
    const response = await fetch('/api/jobs/EJE-1050', { headers: { accept: 'application/json' } });
    const body = await response.json();
    return body.data.view.job.completionReport.faultFindings;
  });
  if (!after.includes('Basement draft')) {
    throw new Error(`the chosen draft did not reach the job: ${after}`);
  }
});

/* ---- OFF-DETAIL-1: the job detail, from this device's own copy ----------- */

await step('the job a technician had open is readable with the network off', async () => {
  /*
   * OFF-DETAIL-1. Until now a tablet with no coverage could show the job LIST
   * and nothing else: a technician who had the job open and whose application
   * reloaded in a basement lost sight of the hours they had captured and of
   * which checklist questions were still outstanding.
   *
   * No authenticated PAGE is cached, and none is now — the worker still
   * refuses that. What is cached is the job's own detail, written when the
   * server answered, and read back on the one screen a tablet with no signal
   * can reach.
   */
  await signInAs(page, 'Riaan van Wyk', { base: BASE });
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.locator('table').first().waitFor({ timeout: 20000 });
  const { jobNumber } = await workableJob(page);

  // Opening the job online is what writes the copy.
  await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Overview' }).first().waitFor({ timeout: 20000 });

  const cached = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('details', 'readonly').objectStore('details').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );
  if (cached.length === 0) throw new Error('the job detail was not cached');
  const mine = cached.find((row) => row.jobNumber === jobNumber);
  if (mine === undefined) throw new Error(`no cached copy of ${jobNumber}`);
  if (typeof mine.userId !== 'string' || mine.userId.length === 0) {
    throw new Error('the cached detail names no owner');
  }
  if (mine.key !== `${mine.userId}:${jobNumber}`) {
    throw new Error(`the cached detail is keyed ${mine.key}`);
  }

  /*
   * WHAT IT MUST NOT CARRY, read out of the record itself rather than trusted
   * from the projection's unit test: prices, the signature, a document
   * pointer, the customer's staff, or any identifier the client could hand
   * back as authority.
   */
  const blob = JSON.stringify(mine);
  for (const forbidden of ['unitPrice', 'pricingSnapshot', 'strokeData', 'finalDocument', 'storageKey', 'calloutApplied']) {
    if (blob.includes(forbidden)) throw new Error(`the cached detail holds ${forbidden}`);
  }

  offlineExpected = true;
  await page.context().setOffline(true);
  try {
    // A full navigation to the job, which the worker answers with the offline
    // page — it still caches no authenticated page, and that has not changed.
    await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('cached-job-detail').waitFor({ timeout: 25000 });
    /*
     * The whole copy, not just its header: the id sits on an element inside
     * the card because `Card` forwards only its own props.
     */
    const card = page
      .locator('section', { has: page.getByTestId('cached-job-detail') })
      .first();
    const text = await card.innerText();

    if (!text.includes(jobNumber)) throw new Error(`the copy names ${text.slice(0, 80)}`);
    if (!/Copy on this tablet/i.test(text)) {
      throw new Error('the copy does not say it is a copy');
    }
    if (!/As the server had it/i.test(text)) {
      throw new Error('the copy does not say how old it is');
    }
    if (!/Nothing on this copy can be changed from here/i.test(text)) {
      throw new Error('the copy does not say it is read-only');
    }
    if (!/no prices, no signature/i.test(text)) {
      throw new Error('the copy does not say what it leaves out');
    }
    // No action on it at all: a cached page may not offer what the server has
    // not agreed to.
    if ((await card.getByRole('button').count()) !== 0) {
      throw new Error('the cached copy offers an action');
    }
    await page.screenshot({ path: `${shots}/51-cached-detail.png`, fullPage: false });
  } finally {
    await page.context().setOffline(false);
    offlineExpected = false;
  }

  /*
   * And it goes when the tablet changes hands: it is a copy of server data, so
   * sign-out clears it — unlike held work, which deliberately survives.
   *
   * Back into the application first: the previous navigation was answered by
   * the worker with the offline page, which has no profile menu to sign out
   * from.
   */
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await signOut();
  const after = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('details', 'readonly').objectStore('details').count();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );
  if (after !== 0) throw new Error(`${after} cached job details survived the sign-out`);
});
/* ---- OFF-MEDIA-1: a photograph taken with no signal --------------------- */

await step('a photograph taken offline is kept on the tablet, bytes and all', async () => {
  /*
   * OFF-MEDIA-1. The failure this closes: a technician photographs a burnt
   * contactor in a basement, the upload fails, the file lives in a React state
   * variable — and the tablet locking loses the only photograph of the fault,
   * taken at the only moment it could be taken.
   *
   * The bytes are now kept in IndexedDB, under their owner, with the key the
   * attempt used; the flush sends them through the same authenticated
   * multipart route the online capture uses.
   */
  await signInAs(page, 'Riaan van Wyk', { base: BASE });
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.locator('table').first().waitFor({ timeout: 20000 });
  const { jobNumber } = await workableJob(page);

  await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: /^Photos/ }).first().click();
  await page.locator('[data-testid="job-photo-gallery"]').waitFor({ state: 'attached', timeout: 20000 });

  offlineExpected = true;
  await page.context().setOffline(true);
  try {
    await page.setInputFiles('[data-testid="job-photo-gallery"]', {
      name: 'burnt-contactor.png',
      mimeType: 'image/png',
      buffer: pngBytes('burnt contactor'),
    });
    const caption = page.getByLabel('Caption');
    if ((await caption.count()) > 0) await caption.first().fill('Burnt contactor');

    // The modal's own send, which with no connection keeps the bytes instead
    // of spending thirty seconds proving the obvious.
    await page.getByRole('dialog').getByRole('button', { name: 'Attach photo' }).click();
    await page.getByTestId('job-photo-held').waitFor({ timeout: 25000 });

    const stored = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('eje-job-cache');
          open.onerror = () => reject(new Error('IndexedDB could not be opened'));
          open.onsuccess = () => {
            const db = open.result;
            const request = db.transaction('media', 'readonly').objectStore('media').getAll();
            request.onsuccess = () => {
              db.close();
              resolve(
                request.result.map((row) => ({
                  kind: row.destination?.kind,
                  userId: row.userId,
                  jobNumber: row.jobNumber,
                  state: row.state,
                  sizeBytes: row.sizeBytes,
                  byteLength: row.bytes?.byteLength ?? 0,
                  key: row.idempotencyKey,
                  caption: row.caption,
                })),
              );
            };
            request.onerror = () => reject(new Error('the read failed'));
          };
        }),
    );
    if (stored.length !== 1) throw new Error(`${stored.length} photographs held, expected 1`);
    if (stored[0].kind !== 'job_photo') throw new Error(`held ${stored[0].kind}`);
    if (stored[0].jobNumber !== jobNumber) throw new Error('the held photograph names the wrong job');
    // THE BYTES, not a reference to a file the browser will forget.
    if (stored[0].byteLength < 8) throw new Error('the held photograph has no bytes');
    if (stored[0].sizeBytes !== stored[0].byteLength) {
      throw new Error('the held size does not match the bytes');
    }
    if (typeof stored[0].key !== 'string' || stored[0].key.length === 0) {
      throw new Error('the held photograph carries no idempotency key');
    }
    if (typeof stored[0].userId !== 'string' || stored[0].userId.length === 0) {
      throw new Error('the held photograph names no owner');
    }

    // And the queue panel says so, in the same place the captures do.
    await page.getByTestId('pending-media-heading').waitFor({ timeout: 20000 });
    const panel = await page.getByTestId('pending-media-list').innerText();
    if (!/Not sent/.test(panel)) throw new Error(`the panel does not say "Not sent": ${panel}`);

    // It survives the application being closed, which is the whole point.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('offline-held-photos').waitFor({ timeout: 25000 });
    await page.screenshot({ path: `${shots}/50-photo-held.png`, fullPage: false });
  } finally {
    await page.context().setOffline(false);
    offlineExpected = false;
  }

  /*
   * THE SIGNAL RETURNS. The bytes go up through the ordinary route and the row
   * leaves the tablet — and the photograph is on the job, fetched back through
   * the authenticated media route, which is what proves the file is real.
   */
  await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('media', 'readonly').objectStore('media').count();
          request.onsuccess = () => {
            db.close();
            resolve(request.result === 0);
          };
          request.onerror = () => resolve(false);
        };
      }),
    undefined,
    { timeout: 40000 },
  );

  const landed = await page.evaluate(async (number) => {
    const response = await fetch(`/api/jobs/${number}`, { headers: { accept: 'application/json' } });
    const body = await response.json();
    return body.data.view.job.photos.map((photo) => ({
      caption: photo.caption,
      sizeBytes: photo.sizeBytes,
    }));
  }, jobNumber);
  if (landed.length === 0) throw new Error('the held photograph never reached the job');
  if (!landed.some((photo) => photo.sizeBytes > 0)) {
    throw new Error('the photograph on the job has no bytes behind it');
  }
});
/* ---- BD-16: a shared tablet, and work that belongs to one person -------- */

await step('unsent work survives a sign-out and stays with its owner', async () => {
  /*
   * BD-16. A tablet is handed over at the gate. Sipho's unsent hours must
   * still be there, must not be visible to Riaan, and must come back to Sipho
   * when he signs in again.
   *
   * The sign-out is the part that used to be silent: the dialog now says where
   * the work went and whose it is.
   */
  await signInAs(page, 'Sipho Mahlangu', { base: BASE });
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.locator('table').first().waitFor({ timeout: 20000 });
  const { jobNumber } = await workableJob(page);

  /*
   * THE SESSION'S OWN VALUE, TAKEN WHILE THERE IS ONE.
   *
   * Read from the BROWSER CONTEXT, where Playwright can see an HttpOnly cookie
   * the page cannot, and kept for the storage check further down — which runs
   * after the sign-out, when there is deliberately no cookie left to read.
   * Asserting on field NAMES catches a field somebody called `sessionToken`;
   * it does not catch one called `d` holding the session, which is why the
   * value itself is what the stores are checked against.
   */
  /*
   * EVERY cookie, not `cookies(BASE)`.
   *
   * The session cookie is `Secure` — and `__Host-` prefixed, which requires it
   * — so Playwright does not return it for an `http://` URL even though the
   * browser is holding it for 127.0.0.1, which Chromium treats as a
   * trustworthy origin. Filtering by URL therefore found nothing and the check
   * reported "no session cookie" on a session that plainly existed.
   */
  const sessionCookie = (await page.context().cookies()).find((cookie) =>
    cookie.name.endsWith('eje_session'),
  );
  if (sessionCookie === undefined) throw new Error('there is no session cookie to check against');
  if (!sessionCookie.httpOnly) throw new Error('the session cookie is not HttpOnly');
  if (sessionCookie.value.length < 16) {
    throw new Error('the session cookie is too short to be a real token');
  }

  await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Labour & Parts' }).click();
  await page.getByRole('button', { name: 'Add labour' }).first().waitFor({ timeout: 15000 });

  offlineExpected = true;
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Add labour' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 10000 });
  await dialog.getByLabel('Or enter hours').fill('3.5');
  await dialog.getByRole('button', { name: 'Add labour' }).last().click();
  await page.getByTestId('pending-work-heading').waitFor({ timeout: 15000 });

  // Signing out with work unsent asks first, and says what happens to it.
  await page.locator('header [aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  const confirm = page.getByRole('dialog');
  await confirm.waitFor({ timeout: 10000 });
  const warning = await confirm.innerText();
  if (!/not reached the EJE server/i.test(warning)) {
    throw new Error(`the sign-out warning does not say the work is unsent: ${warning}`);
  }
  if (!/under your name/i.test(warning)) {
    throw new Error(`the sign-out warning does not say whose the work is: ${warning}`);
  }
  if (!/will not see them|cannot send them/i.test(warning)) {
    throw new Error(`the sign-out warning does not say it is private: ${warning}`);
  }
  await page.screenshot({ path: `${shots}/47-signout-unsent.png`, fullPage: false });
  await confirm.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('heading', { name: 'Sign in' }).waitFor({ timeout: 20000 });

  /*
   * THE SIGN-OUT THE SERVER HAS NOT HEARD. BD-16. It was made with no signal,
   * so the session cannot have been revoked — and the screen says so rather
   * than looking like an ordinary sign-out, because until the server is told
   * the cookie this page cannot read is still valid.
   */
  const held = page.getByTestId('sign-out-pending');
  await held.waitFor({ timeout: 15000 });
  const heldText = await held.innerText();
  if (!/not been told/i.test(heldText)) {
    throw new Error(`the sign-in screen does not say the sign-out is undelivered: ${heldText}`);
  }

  await page.context().setOffline(false);
  offlineExpected = false;

  // The work is still on the tablet, under Sipho's id, and the read cache is
  // gone — the two halves of the policy, which pull in opposite directions.
  const afterSignOut = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['pending', 'jobs', 'device'], 'readonly');
          const pending = tx.objectStore('pending').getAll();
          const jobs = tx.objectStore('jobs').count();
          const device = tx.objectStore('device').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({ pending: pending.result, jobs: jobs.result, device: device.result });
          };
          tx.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );
  if (afterSignOut.pending.length !== 1) {
    throw new Error(`${afterSignOut.pending.length} captures survived the sign-out, expected 1`);
  }
  if (afterSignOut.jobs !== 0) throw new Error('the cached job list survived the sign-out');
  // The device no longer knows whose session it held — the only row left is
  // the record of the sign-out itself, which is what keeps it signed out.
  const confirmed = afterSignOut.device.filter((row) => row.key === 'last_confirmed_session');
  if (confirmed.length > 0) throw new Error('the device still names the last session');
  const owed = afterSignOut.device.filter((row) => row.key === 'unconfirmed_sign_out');
  if (owed.length !== 1) throw new Error('the undelivered sign-out was not recorded');
  const owner = afterSignOut.pending[0].userId;
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error('the retained capture names no owner');
  }

  /*
   * NOTHING WORTH STEALING TWICE. No password, session cookie or token is
   * written to the device — the session is an HttpOnly cookie the page cannot
   * read, and this is the assertion that keeps it that way.
   */
  const secrets = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const names = [...db.objectStoreNames];
          const tx = db.transaction(names, 'readonly');
          const reads = names.map((name) => tx.objectStore(name).getAll());
          tx.oncomplete = () => {
            db.close();
            resolve({
              indexedDb: JSON.stringify(reads.map((read) => read.result)),
              local: JSON.stringify(
                Object.fromEntries(
                  Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]),
                ),
              ),
              // Session storage as well: it is cleared when the tab closes,
              // which makes it a tempting place to keep a token and no safer.
              session: JSON.stringify(
                Object.fromEntries(
                  Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]),
                ),
              ),
            });
          };
          tx.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );
  for (const [where, blob] of Object.entries(secrets)) {
    const offending = ['password', 'eje-demo', 'passwordHash', 'accessToken', 'sessionToken', 'bearer']
      .filter((needle) => new RegExp(needle, 'i').test(blob));
    if (offending.length > 0) {
      throw new Error(`${where} holds ${offending.join(', ')}`);
    }
    if (blob.includes(sessionCookie.value)) {
      throw new Error(`${where} holds the session cookie's own value`);
    }
  }

  // The next technician on the tablet. The work is not theirs, so they are not
  // shown it and cannot reach it.
  await signInAs(page, 'Riaan van Wyk', { base: BASE });
  await page.goto(`${BASE}/jobs`, { waitUntil: 'networkidle' });
  await page.locator('table').first().waitFor({ timeout: 20000 });
  if ((await page.getByTestId('pending-work-heading').count()) > 0) {
    throw new Error('the next technician was shown the last one’s unsent work');
  }
  const stillThere = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').getAll();
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
          request.onerror = () => reject(new Error('the read failed'));
        };
      }),
  );
  if (stillThere.length !== 1) {
    throw new Error(`${stillThere.length} captures held while another user is signed in`);
  }

  /*
   * AND NOTHING OF THE LAST PERSON'S READ CACHE, which pulls the other way.
   * OFF-DETAIL-1 cached one job's detail for its owner; signing in as somebody
   * else clears every record that is not theirs, because that is a copy of
   * server data and costs nothing to lose — unlike the capture above.
   */
  const cachedForOthers = await page.evaluate(
    (owner) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => reject(new Error('IndexedDB could not be opened'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['details', 'jobs'], 'readonly');
          const details = tx.objectStore('details').getAll();
          const jobs = tx.objectStore('jobs').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              details: details.result.filter((row) => row.userId === owner).length,
              jobs: jobs.result.filter((row) => row.userId === owner).length,
            });
          };
          tx.onerror = () => reject(new Error('the read failed'));
        };
      }),
    owner,
  );
  if (cachedForOthers.details !== 0 || cachedForOthers.jobs !== 0) {
    throw new Error(
      `the next technician's session still holds ${cachedForOthers.details} job details and ${cachedForOthers.jobs} cached jobs belonging to somebody else`,
    );
  }
  if (stillThere[0].userId === owner) {
    // Correct: it is still Sipho's. Riaan signing in neither sent it nor
    // claimed it.
  } else {
    throw new Error('the retained capture changed owner when somebody else signed in');
  }
  // And it was not sent on Riaan's session either: still waiting, no attempt
  // made under the wrong identity.
  if (stillThere[0].state !== 'pending') {
    throw new Error(`the retained capture is in state ${stillThere[0].state}`);
  }

  /*
   * AND IT COMES BACK TO ITS OWNER. Sipho signs in again, with a connection,
   * and the tablet sends what it was holding — which is also the proof that
   * the work was never lost, only withheld.
   */
  await signInAs(page, 'Sipho Mahlangu', { base: BASE });
  await page.goto(`${BASE}/jobs/${jobNumber}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('eje-job-cache');
        open.onerror = () => resolve(false);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('pending', 'readonly').objectStore('pending').count();
          request.onsuccess = () => {
            db.close();
            resolve(request.result === 0);
          };
          request.onerror = () => resolve(false);
        };
      }),
    undefined,
    { timeout: 40000 },
  );

  await page.getByRole('tab', { name: 'Labour & Parts' }).click();
  await page.locator('main').getByText('3.5', { exact: false }).first().waitFor({ timeout: 25000 });
});

await browser.close();

console.log('\n=== SUMMARY ===');
if (errors.length === 0) {
  console.log('ALL CHECKS PASSED, no console/page errors');
} else {
  console.log(`${errors.length} problem(s):`);
  errors.forEach((e) => console.log(' - ' + e));
  process.exitCode = 1;
}
