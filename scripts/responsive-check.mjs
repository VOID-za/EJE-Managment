/**
 * THE SCREENS AT TABLET AND PHONE WIDTH, MEASURED. MASTER SCOPE UX-1, CR-03.
 *
 * WHY THIS EXISTS. The tablet layout was asserted in one smoke step, on one
 * screen, at one width: EJE-1049 at 820px, checked for horizontal overflow. The
 * system is used on rugged Android tablets held in both orientations and, when
 * a tablet is flat, on a phone — so every screen a technician or the office
 * reaches has to be measured, not looked at once.
 *
 * WHAT IT MEASURES, and why each one is a real field failure rather than a
 * style preference:
 *
 *  1. HORIZONTAL OVERFLOW. A page wider than the screen scrolls sideways, and
 *     on a touch device a sideways scroll fights every vertical swipe. The
 *     check is the document, not a guess at which element did it.
 *  2. CONTROLS OFF THE SCREEN. A button whose box ends past the right edge
 *     cannot be tapped at all. This is the defect that makes a workflow
 *     impossible rather than merely awkward, so it is measured on every
 *     control on the screen.
 *  3. TAP TARGET SIZE. A control smaller than a fingertip is a mis-tap, and a
 *     mis-tap on these screens signs, submits or deletes. An input inside a
 *     label is measured by the LABEL, because tapping the label is what
 *     activates it — which is how a 18px checkbox is legitimately a 44px
 *     target.
 *  4. KEYBOARD REACH. A control that cannot be focused cannot be used by
 *     anybody working from a keyboard, which the office does all day.
 *  5. LONG CONTENT. A customer called "Hoërskool Pretoria-Oos Tegniese
 *     Afdeling (Edms) Bpk" and a 300-character fault description are ordinary
 *     EJE data; a layout that only holds short strings breaks on the real
 *     register. Typed into the real filters, and the measurements are taken
 *     again.
 *
 * WHAT IT IS NOT. It is not acceptance of the tablet. UX-1 and the
 * tablet-installation criteria are about a rugged device in a workshop — glare,
 * gloves, a dropped connection, a real stylus — and nothing a headless browser
 * measures can stand in for that. This catches the defects that are measurable,
 * so the physical pass is about the things that are not.
 *
 * Usage:
 *   npm run start                 # or npm run dev
 *   npm run responsive-check
 *   EJE_RESPONSIVE_URL=http://localhost:3000 npm run responsive-check
 */
import { chromium } from 'playwright';
import { resetDemonstration, signInAs, signOut } from './sign-in.mjs';

const BASE =
  process.env.EJE_RESPONSIVE_URL ?? process.env.EJE_E2E_URL ?? 'http://localhost:3000';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;

/** The three shapes the system is actually used in. */
const VIEWPORTS = [
  { name: 'tablet landscape', width: 1024, height: 768 },
  { name: 'tablet portrait', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
];

/**
 * The minimum tap target, in CSS pixels.
 *
 * 36 rather than the 44 of the platform guidelines, and the number is a
 * decision rather than a convenience. The design system's small control is
 * `h-9` — 36px — used for every secondary action in a row with gaps around it,
 * and holding all of those to 44 would be a redesign of every screen rather
 * than a defect report. 36 with spacing is a target a thumb hits; below it is
 * where a miss becomes likely, and a miss on these screens submits, signs or
 * deletes.
 *
 * THE PRIMARY CAPTURE CONTROLS ARE ALREADY LARGER and are meant to be: the
 * wizard's own buttons are `h-11` (44px), which the smoke suite exercises at
 * tablet size. What this number governs is the long tail of secondary
 * controls, where a 16px link is a real defect and a 36px button is not.
 */
const MIN_TAP = 36;

/**
 * Controls measured against a smaller floor, with the reason and the floor.
 *
 * NOT exemptions from being measured — each one still has a minimum, and it is
 * written here beside why it differs. Anything not in this list is held to
 * `MIN_TAP`.
 */
const SMALLER_FLOORS = [
  {
    /*
     * A CALENDAR BAR IN A MONTH GRID. A month is five rows of seven days on
     * one screen; giving every bar 36px would mean two jobs a day and a
     * scroll for the rest, which is a worse calendar. 20px is the floor the
     * smoke suite already holds these to, and the day cell around the bar is
     * itself a target.
     */
    selector: '[data-calendar-bar], .eje-calendar-bar',
    floor: 20,
    why: 'a bar in the month grid, where the day cell is the larger target',
  },
];

const failures = [];
const notes = [];

const step = async (name, fn) => {
  try {
    const found = await fn();
    if (found === undefined || found.length === 0) {
      console.log(`PASS  ${name}`);
      return;
    }
    for (const problem of found) failures.push(`${name} :: ${problem}`);
    console.log(`FAIL  ${name}`);
    for (const problem of found.slice(0, 6)) console.log(`        ${problem}`);
    if (found.length > 6) console.log(`        … and ${found.length - 6} more`);
  } catch (error) {
    failures.push(`${name} :: ${error.message.split('\n')[0]}`);
    console.log(`FAIL  ${name} :: ${error.message.split('\n')[0]}`);
  }
};

const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
const context = await browser.newContext({
  viewport: VIEWPORTS[0],
  hasTouch: true,
  acceptDownloads: true,
});
const page = await context.newPage();

/*
 * THE MEASUREMENT, RUN IN THE PAGE.
 *
 * One pass over the document rather than a Playwright call per element: a
 * screen holds a hundred controls and a round trip each would make this take
 * minutes. It returns findings, not booleans, so a failure says WHICH control.
 */
/*
 * A REAL FUNCTION, PASSED TO THE BROWSER.
 *
 * It was a template string, and that is worth recording because it made this
 * whole script PASS WITHOUT MEASURING ANYTHING: `page.evaluate` given a string
 * that looks like a function evaluates it as an EXPRESSION, so the page handed
 * back a function it could not serialise — `undefined` — and every screen
 * reported no findings. A suite that cannot fail is worse than no suite, and it
 * was caught by checking the measurement against a screen whose controls were
 * measured by hand: /jobs at 390px has a 38×38 button and three 36px-tall
 * Accept buttons on it.
 */
const measureScreen = (options) => {
  const problems = [];
  const width = window.innerWidth;

  if (document.documentElement.scrollWidth > width + 1) {
    problems.push(
      'the page scrolls sideways: content is ' +
        document.documentElement.scrollWidth + 'px wide in a ' + width + 'px viewport',
    );
  }

  const describe = (element) => {
    const label =
      element.getAttribute('aria-label') ||
      (element.textContent || '').trim().slice(0, 40) ||
      element.getAttribute('placeholder') ||
      element.getAttribute('name') ||
      element.id ||
      '';
    return element.tagName.toLowerCase() + (label === '' ? '' : ' "' + label + '"');
  };

  const controls = [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="tab"], [tabindex]')];

  for (const control of controls) {
    const style = getComputedStyle(control);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    // A closed off-canvas drawer is `inert`: nothing in it is focusable,
    // tappable or announced, so it is not on screen in any sense that matters.
    if (control.closest('[aria-hidden="true"], [inert]') !== null) continue;
    if (control.type === 'hidden') continue;

    const box = control.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;

    /*
     * 2. Off the screen horizontally: a control nobody can tap.
     *
     * UNLESS IT IS INSIDE SOMETHING THAT SCROLLS SIDEWAYS. A wide table in an
     * `overflow-x-auto` container is how the office reads twelve columns on a
     * tablet, and the Accept button in its last column is reached by scrolling
     * the table rather than the page. What is still a defect is a control
     * pushed outside a container that does NOT scroll: that one is clipped and
     * genuinely unreachable.
     */
    const scroller = (() => {
      let node = control.parentElement;
      while (node !== null && node !== document.body) {
        const overflowX = getComputedStyle(node).overflowX;
        if (overflowX === 'auto' || overflowX === 'scroll') return node;
        node = node.parentElement;
      }
      return null;
    })();

    if (box.right > width + 1 || box.left < -1) {
      if (scroller === null) {
        problems.push(
          'off screen: ' + describe(control) + ' spans ' +
            Math.round(box.left) + '→' + Math.round(box.right) + 'px in ' + width + 'px',
        );
        continue;
      }
      // Reachable by scrolling that container — but only if it really can.
      if (scroller.scrollWidth <= scroller.clientWidth + 1) {
        problems.push(
          'clipped: ' + describe(control) + ' is outside a container that does not scroll',
        );
        continue;
      }
    }

    // 3. Tap target. An input inside a label is measured by the label, because
    // tapping the label is what activates it.
    const inlineLink = control.tagName === 'A' && style.display.startsWith('inline') && !style.display.includes('flex');
    if (!inlineLink) {
      const label = control.tagName === 'INPUT' ? control.closest('label') : null;
      const target = label === null ? box : label.getBoundingClientRect();
      /*
       * The floor for THIS control: `MIN_TAP`, or the smaller one named for it.
       * A pixel of tolerance, because a 36px control measures 35.98 once a
       * border and a sub-pixel layout are involved, and a suite that fails on
       * rounding is a suite people learn to ignore.
       */
      const smaller = options.floors.find((entry) => control.matches(entry.selector));
      const floor = (smaller === undefined ? options.minTap : smaller.floor) - 1;
      if (target.height < floor || target.width < floor) {
        problems.push(
          'small target: ' + describe(control) + ' is ' +
            Math.round(target.width) + '×' + Math.round(target.height) + 'px' +
            (smaller === undefined ? '' : ' (floor ' + smaller.floor + ': ' + smaller.why + ')'),
        );
      }
    }

    // 4. Keyboard reach.
    if (control.getAttribute('tabindex') === '-1' && control.getAttribute('aria-hidden') !== 'true') {
      problems.push('not reachable by keyboard: ' + describe(control));
    }
  }

  return problems;
};

const measure = (viewport) =>
  page.evaluate(measureScreen, { minTap: MIN_TAP, floors: SMALLER_FLOORS, viewport });

const visit = async (path) => {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  const body = await page.locator('body').innerText();
  if (body.includes('This page could not be found')) {
    throw new Error(`${path} served the 404 page`);
  }
};

/** The screens each role reaches, and must be able to work on. */
const OFFICE_SCREENS = [
  '/dashboard',
  '/jobs',
  '/jobs?status=all',
  '/jobs/closed',
  '/jobs/new',
  '/jobs/EJE-1049',
  '/jobs/EJE-1048',
  '/jobs/EJE-1044/review',
  /*
   * A CLOSED JOB'S OWN SCREEN, which is where the correction and
   * unsigned-delivery panels live (BD-02, BD-06). The review page above is a
   * different screen and does not carry them — and the gate that caught a
   * 20px file input on the customer-documents panel only caught it because
   * that screen was on this list.
   */
  '/jobs/EJE-1044',
  '/customers',
  '/customers/cust-abc',
  '/machines',
  '/machines/machine-abc-lv40',
  '/technicians/user-tech-lerato',
  '/calendar',
  '/library',
  '/search?q=LW-V40-70214',
  '/activity',
  '/admin',
  '/messages',
  '/notifications',
  '/captures',
  // ATTEND-1 and TIMESHEET-1.
  '/attendance',
  '/timesheets',
];

const FIELD_SCREENS = ['/dashboard', '/jobs', '/jobs/EJE-1052', '/library', '/calendar', '/messages', '/timesheets'];

await resetDemonstration(page, BASE);
await signInAs(page, 'Elmarie Coetzee', { base: BASE, greeting: /Elmarie/ });

for (const viewport of VIEWPORTS) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  console.log(`\n=== OFFICE, ${viewport.name} (${viewport.width}×${viewport.height}) ===`);
  for (const path of OFFICE_SCREENS) {
    await step(`${path} at ${viewport.name}`, async () => {
      await visit(path);
      return measure(viewport);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The technician's own screens, which is what the tablet is for              */
/* -------------------------------------------------------------------------- */

await page.setViewportSize({ width: 1024, height: 768 });
await visit('/dashboard');
await signOut(page);
await signInAs(page, 'Sipho Mahlangu', { base: BASE, greeting: /Sipho/ });

for (const viewport of VIEWPORTS) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  console.log(`\n=== TECHNICIAN, ${viewport.name} (${viewport.width}×${viewport.height}) ===`);
  for (const path of FIELD_SCREENS) {
    await step(`${path} at ${viewport.name}`, async () => {
      await visit(path);
      return measure(viewport);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Long content — the real register, not short fixtures                       */
/* -------------------------------------------------------------------------- */

console.log('\n=== LONG CONTENT ===');

const LONG_NAME = 'Hoërskool Pretoria-Oos Tegniese Afdeling (Edms) Bpk — Werkswinkel Nommer Sewe';
const LONG_FAULT =
  'The spindle drive trips on overcurrent within ninety seconds of starting under load, and the alarm history shows 414 followed by 751 on every occasion, '.repeat(
    2,
  );

for (const viewport of VIEWPORTS) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  await step(`a long search term does not break the Jobs list at ${viewport.name}`, async () => {
    await visit('/jobs?status=all');
    const search = page.getByPlaceholder(/Job number/).first();
    if ((await search.count()) === 0) return ['the Jobs list has no search box'];
    await search.fill(LONG_FAULT.slice(0, 200));
    await page.waitForTimeout(150);
    return measure(viewport);
  });

  await step(`a long library search does not break the library at ${viewport.name}`, async () => {
    await visit('/library');
    const search = page.locator('#library-search');
    await search.fill(LONG_NAME);
    await page.waitForTimeout(400);
    return measure(viewport);
  });

  await step(`a validation message does not break the job form at ${viewport.name}`, async () => {
    await visit('/jobs/new');
    // Submitting an empty form is how the office finds out what is required,
    // and the refusal has to fit on the screen it is read on.
    const submit = page.getByRole('button', { name: /Raise|Create|Save/ }).first();
    if ((await submit.count()) > 0) await submit.click().catch(() => {});
    await page.waitForTimeout(300);
    return measure(viewport);
  });
}

/* -------------------------------------------------------------------------- */
/* Keyboard use: a visible focus ring, on screen, nowhere hidden               */
/* -------------------------------------------------------------------------- */

console.log('\n=== KEYBOARD ===');

/*
 * WHY THIS IS MEASURED AND NOT EYEBALLED. The office works from a keyboard all
 * day, and two defects make that impossible without ever showing up on a
 * screenshot: focus that lands on something off the screen (or inside a closed
 * drawer), and focus that lands somewhere with no visible ring at all, so
 * nobody can tell where they are. Both are computable.
 *
 * Tab is pressed twenty times from the top of each screen — far enough to
 * leave the header and reach the page's own controls — and after each press the
 * focused element is measured.
 */
const focusWalk = async (path, presses = 20) => {
  await visit(path);
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  const problems = [];

  for (let press = 0; press < presses; press += 1) {
    await page.keyboard.press('Tab');
    const finding = await page.evaluate(() => {
      const node = document.activeElement;
      if (node === null || node === document.body) return null;

      const describe = () => {
        const label =
          node.getAttribute?.('aria-label') ||
          (node.textContent || '').trim().slice(0, 32) ||
          node.getAttribute?.('placeholder') ||
          node.id ||
          '';
        return `${node.tagName.toLowerCase()}${label === '' ? '' : ` "${label}"`}`;
      };

      // 1. Inside something that is not meant to be reachable.
      if (node.closest('[inert], [aria-hidden="true"]') !== null) {
        return `focus reached ${describe()} inside an inert or hidden region`;
      }

      // 2. Off the screen: focused and unreachable at the same time.
      const box = node.getBoundingClientRect();
      if (box.width > 0 && (box.right < 0 || box.left > window.innerWidth + 1)) {
        return `focus reached ${describe()}, which is off the screen`;
      }

      // 3. No visible ring. The design system uses a ring or an outline; a
      //    focused control with neither leaves a keyboard user lost.
      const style = getComputedStyle(node);
      const ring =
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        (style.boxShadow !== 'none' && style.boxShadow !== '') ||
        style.borderColor !== getComputedStyle(document.body).borderColor;
      if (!ring) return `focus reached ${describe()} with no visible focus ring`;
      return null;
    });
    if (finding !== null) problems.push(finding);
  }
  return problems;
};

for (const path of ['/jobs', '/jobs/EJE-1049', '/library', '/calendar', '/admin']) {
  await step(`keyboard focus stays visible and on screen: ${path}`, () => focusWalk(path));
}

/* -------------------------------------------------------------------------- */
/* LIB-5: an unsearchable document says why, and offers the retry             */
/* -------------------------------------------------------------------------- */

console.log('\n=== LIBRARY INDEXING STATES ===');

/** A scanned page: a real PDF with an image and no text operators at all. */
const scannedPdf = () => {
  const image = `BI /W 1700 /H 2200 /CS /G ID ${'\u00fe'.repeat(600)} EI\n`;
  const body =
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
    `4 0 obj\n<< /Length ${image.length} >>\nstream\n${image}\nendstream\nendobj\n`;
  return `%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`;
};

await step('a scanned document says it is not searchable, and why, with a retry', async () => {
  await page.setViewportSize({ width: 1024, height: 768 });
  /*
   * AS THE OFFICE, deliberately. The indexing reason and the retry are shown
   * to whoever can act on them — and a technician's own upload lands
   * `pending_approval`, which their library does not list at all.
   */
  await visit('/dashboard');
  await signOut(page);
  await signInAs(page, 'Elmarie Coetzee', { base: BASE, greeting: /Elmarie/ });
  const upload = await page.evaluate(
    async ([base, source]) => {
      const form = new FormData();
      form.append('file', new File([source], 'scanned.pdf', { type: 'application/pdf' }));
      form.append('name', 'Scanned press brake manual');
      form.append('description', 'A scan, with no text layer.');
      form.append('documentType', 'machine_manual');
      form.append('manufacturer', 'Amada');
      form.append('machineModel', 'HFE-1303');
      form.append('version', '1.0');
      form.append('tags', 'scan');
      const response = await fetch(`${base}/api/library/upload`, { method: 'POST', body: form });
      const payload = await response.json();
      return { status: response.status, state: payload?.data?.index?.state ?? null };
    },
    [BASE, scannedPdf()],
  );
  if (upload.status !== 200) return [`the scan uploaded as HTTP ${upload.status}`];
  if (upload.state !== 'needs_ocr') return [`the scan indexed as "${upload.state}"`];

  await visit('/library');
  const card = page.locator('section', { hasText: 'Scanned press brake manual' }).first();
  await card.waitFor({ timeout: 20000 });

  const problems = [];
  const badge = await card.innerText();
  if (!/Not searchable/i.test(badge)) problems.push('the card does not say it is not searchable');

  const problem = card.getByTestId('library-index-problem');
  if ((await problem.count()) === 0) {
    problems.push('the office is not told WHY the document cannot be searched');
  } else {
    const reason = await problem.innerText();
    /*
     * THE CONCEPT, NOT THE JARGON. This asked for the literal string "OCR",
     * which the reason carried while it was `index.failureReason` — a sentence
     * written for whoever reads the code. The copy now comes from
     * `describeSearchability` and says "its text has to be recognised", which
     * is the same fact in words a technician uses. What the gate is for is
     * that the office is told WHY and can act on it, so it accepts either.
     */
    if (!/OCR|recognis|recogniz/iu.test(reason)) {
      problems.push(`the reason does not say the text has to be recognised: ${reason}`);
    }
    const retry = card.getByTestId('library-reindex');
    if ((await retry.count()) === 0) problems.push('there is no route to try the index again');
    else {
      // The retry really runs, and a scan honestly stays a scan — what must
      // NOT happen is the badge flipping to "Searchable".
      await retry.click();
      await page.waitForTimeout(1500);
      const after = await page
        .locator('section', { hasText: 'Scanned press brake manual' })
        .first()
        .innerText();
      if (/\bSearchable\b/.test(after.replace(/Not searchable/gi, ''))) {
        problems.push('re-indexing a scan claimed it is now searchable');
      }
    }
  }

  // And the same measurements as every other screen, with the panel on it.
  return [...problems, ...(await measure({ name: 'tablet landscape' }))];
});

await context.close();
await browser.close();

console.log('\n=== RESPONSIVE SUMMARY ===');
for (const note of notes) console.log(` - ${note}`);
if (failures.length === 0) {
  console.log('EVERY SCREEN MEASURED CLEAN at tablet and phone width');
  console.log('NOT acceptance of the tablet: UX-1 and the installation criteria');
  console.log('need the real rugged device. See docs/tablet-installation.md.');
  process.exit(0);
}
console.log(`${failures.length} finding(s):`);
for (const failure of failures) console.log(` - ${failure}`);
process.exit(1);
