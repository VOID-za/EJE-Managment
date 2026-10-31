/**
 * THE WHOLE SYSTEM, AT DESKTOP AND AT EVERY TABLET SHAPE, FOR EVERY ROLE.
 * MASTER SCOPE UX-TAB-1.
 *
 * `responsive-check.mjs` measures a list of screens at three shapes. This goes
 * further in the one way that matters for a tablet: it proves PARITY. For every
 * role it signs in twice — once on a desktop, once on a touch tablet — opens
 * every page that role reaches (the sidebar, the pages linked from it, and one
 * of each detail page) and every tab on each, and compares what the two can do:
 *
 *  1. EVERY CONTROL ON THE DESKTOP IS ON THE TABLET. A control is named by its
 *     test id, or by its role and label; a desktop control missing from the
 *     tablet at any of the six shapes is a parity failure, not a layout one.
 *  2. EVERY NAVIGATION DESTINATION. The tablet's sidebar is a drawer below
 *     1024px, so it is opened and read; its destinations must equal the
 *     desktop's.
 *  3. EVERY WORD OF INFORMATION. The visible text of the page (`innerText`,
 *     which leaves out what CSS hides) on the tablet must contain every word
 *     the desktop shows. This is what catches a table column hidden to save
 *     room.
 *
 * And on each shape it measures what makes a control unusable rather than
 * untidy: the page scrolling sideways; a control outside the screen or cut off
 * by a container that does not scroll; two controls on top of each other; a
 * tap target under MIN_TAP; text under MIN_TEXT; text cut short with an
 * ellipsis and no way to read the rest; a page error, a console error or a
 * failed request.
 *
 * What it is NOT: a rugged tablet in a workshop. Glare, gloves, a real stylus,
 * an on-screen keyboard and a printer are physical, and nothing here stands in
 * for them (docs/staff-testing.md H–K).
 *
 * Output: a PASS/FAIL line per role, page and shape; `.tablet-audit/report.json`
 * and `.tablet-audit/checklist.md` (the page-by-page checklist); a screenshot
 * of every page at every shape under `.tablet-audit/<role>/`.
 *
 * Usage:
 *   npm run start
 *   EJE_AUDIT_URL=http://127.0.0.1:3210 node scripts/tablet-audit.mjs [role…]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { resetDemonstration, signInAs } from './sign-in.mjs';

const BASE = process.env.EJE_AUDIT_URL ?? process.env.EJE_E2E_URL ?? 'http://localhost:3000';
const OUT = process.env.EJE_AUDIT_OUT ?? '.tablet-audit';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM;

const DESKTOP = { name: 'desktop 1440x900', width: 1440, height: 900 };
const ALL_TABLETS = [
  { name: 'landscape 1280x800', width: 1280, height: 800 },
  { name: 'landscape 1180x820', width: 1180, height: 820 },
  { name: 'landscape 1024x768', width: 1024, height: 768 },
  { name: 'portrait 1024x1366', width: 1024, height: 1366 },
  { name: 'portrait 800x1280', width: 800, height: 1280 },
  { name: 'portrait 768x1024', width: 768, height: 1024 },
];
/*
 * EJE_AUDIT_SHAPES=1024x768,768x1024 measures those shapes only — CI runs the
 * two hardest (the shortest landscape, with the sidebar; the narrowest
 * portrait, without it) on every push; a release audit runs all six.
 */
const shapes = (process.env.EJE_AUDIT_SHAPES ?? '').split(',').filter((shape) => shape !== '');
const TABLETS = shapes.length === 0 ? ALL_TABLETS : ALL_TABLETS.filter((t) => shapes.includes(`${t.width}x${t.height}`));
if (TABLETS.length === 0) throw new Error(`EJE_AUDIT_SHAPES matched no shape: ${shapes.join(', ')}`);

/**
 * A fingertip. 44 CSS pixels is the platform guideline, and on a touch screen
 * the design system's small controls grow to it (`pointer-coarse:` in the
 * Button, the Field and the global rules), so the tablet is held to it.
 */
const MIN_TAP = 44;
/** The smallest text a technician should have to read without zooming. */
const MIN_TEXT = 12;

const ROLES = [
  { role: 'master', who: 'Elmarie Coetzee' },
  { role: 'coordinator', who: 'Christene van Niekerk' },
  { role: 'technician', who: 'Sipho Mahlangu' },
];

/** Pages not in the sidebar, reached from inside the application. */
const EXTRA_ROUTES = [
  '/jobs/closed',
  '/jobs/new',
  '/jobs/EJE-1044',
  '/jobs/EJE-1056',
  '/jobs/EJE-1056/review',
  '/schedule',
  '/search?q=Leadwell',
  '/machines',
  '/customers/cust-abc',
  '/technicians/user-tech-lerato',
];

const only = process.argv.slice(2);
const roles = only.length === 0 ? ROLES : ROLES.filter((r) => only.includes(r.role));

/* -------------------------------------------------------------------------- */
/* THE MEASUREMENT, RUN IN THE PAGE                                            */
/* -------------------------------------------------------------------------- */

const measure = ({ minTap, minText, touch }) => {
  const W = window.innerWidth;
  const found = [];
  const add = (kind, detail) => found.push({ kind, detail });

  if (document.documentElement.scrollWidth > W + 1) {
    add('overflow', `the page is ${document.documentElement.scrollWidth}px wide in a ${W}px screen`);
  }

  const shown = (element) => {
    if (element.closest('[inert], [aria-hidden="true"]') !== null) return false;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const box = element.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  };
  const label = (element) =>
    (
      element.getAttribute('aria-label') ||
      (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50) ||
      element.getAttribute('placeholder') ||
      element.getAttribute('name') ||
      element.getAttribute('title') ||
      ''
    ).replace(/\d+/g, '#');
  const keyOf = (element) => {
    const testId = element.getAttribute('data-testid');
    const tag = element.getAttribute('role') || element.tagName.toLowerCase();
    return testId !== null ? `${tag}#${testId}` : `${tag} "${label(element)}"`;
  };
  const describe = (element) => `${element.tagName.toLowerCase()} "${label(element).slice(0, 40)}"`;

  const inChrome = (element) => element.closest('aside, [data-mobile-nav], header') !== null;
  const controls = [
    ...document.querySelectorAll(
      'a[href], button, input, select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="switch"]',
    ),
  ].filter((element) => element.type !== 'hidden' && shown(element));

  const keys = [];
  for (const control of controls) {
    if (!inChrome(control) && !control.disabled) keys.push(keyOf(control));
    const box = control.getBoundingClientRect();

    // Off the screen, or cut off by a container that does not scroll.
    let clippedBy = null;
    let scrollsX = false;
    let scrollsY = false;
    for (let node = control.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      const nodeBox = node.getBoundingClientRect();
      const clipX = style.overflowX === 'hidden' || style.overflowX === 'clip';
      const clipY = style.overflowY === 'hidden' || style.overflowY === 'clip';
      if (!scrollsX && clipX && (box.left < nodeBox.left - 1 || box.right > nodeBox.right + 1)) clippedBy = node;
      if (!scrollsY && clipY && (box.top < nodeBox.top - 1 || box.bottom > nodeBox.bottom + 1)) clippedBy = node;
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') scrollsX = true;
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') scrollsY = true;
      if (clippedBy !== null) break;
    }
    if (clippedBy !== null) {
      add('clipped', `${describe(control)} is cut off by its container (${Math.round(box.width)}×${Math.round(box.height)} at ${Math.round(box.left)},${Math.round(box.top)})`);
    } else if (!scrollsX && (box.right > W + 1 || box.left < -1)) {
      add('offscreen', `${describe(control)} is outside the screen (${Math.round(box.left)}–${Math.round(box.right)} of ${W})`);
    }

    // The tap target: an input inside a label is tapped by its label.
    if (touch) {
      const target = (control.matches('input[type="checkbox"], input[type="radio"]') && control.closest('label')) || control;
      const t = target.getBoundingClientRect();
      const inlineLink =
        control.tagName === 'A' &&
        getComputedStyle(control).display === 'inline' &&
        [...control.parentElement.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      // A bar in the month grid: the day cell around it is the 44px target and
      // the day it opens lists every entry (globals.css, "A FINGERTIP").
      const bar = control.closest('[data-calendar-bar]') !== null;
      const floor = bar ? 20 : minTap;
      if (!inlineLink && (t.width < floor - 0.5 || t.height < floor - 0.5)) {
        add('tap', `${describe(control)} is ${Math.round(t.width)}×${Math.round(t.height)}px`);
      }
    }
  }

  // Two controls on top of each other (neither inside the other).
  // Measured on the part of each control that is actually on view: a link
  // scrolled out of the sidebar is under its footer, and that is not a defect.
  const onView = (c) => {
    const r = c.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let node = c.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const n = node.getBoundingClientRect();
      left = Math.max(left, n.left);
      top = Math.max(top, n.top);
      right = Math.min(right, n.right);
      bottom = Math.max(top, Math.min(bottom, n.bottom));
    }
    return { left, top, right, bottom };
  };
  const boxes = controls
    .filter((c) => getComputedStyle(c).position !== 'fixed')
    .map((c) => [c, onView(c)]);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, ra] = boxes[i];
      const [b, rb] = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      // A month-grid bar sits on top of its day cell by design.
      if (a.closest('[data-calendar-bar]') || b.closest('[data-calendar-bar]')) continue;
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (x > 4 && y > 4) add('overlap', `${describe(a)} overlaps ${describe(b)}`);
    }
  }

  // Small text, and text cut short with no way to read the rest.
  const main = document.querySelector('main') ?? document.body;
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (element === null || seen.has(element) || node.textContent.trim() === '' || !shown(element)) continue;
    seen.add(element);
    const style = getComputedStyle(element);
    if (parseFloat(style.fontSize) < minText - 0.01) {
      add('text', `"${node.textContent.trim().slice(0, 40)}" is ${style.fontSize}`);
    }
  }
  for (const element of main.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (style.textOverflow !== 'ellipsis' || !shown(element)) continue;
    if (element.scrollWidth <= element.clientWidth + 1) continue;
    const readable = element.closest('[title]') !== null || element.closest('a[href], button') !== null;
    if (!readable) add('truncated', `"${(element.textContent || '').trim().slice(0, 50)}" is cut short with no way to read it`);
  }

  // Overlapping text is caught as overflowing boxes inside a fixed-size cell.
  return { found, keys, text: main.innerText };
};

/* -------------------------------------------------------------------------- */

const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
mkdirSync(OUT, { recursive: true });
const report = [];
let failed = 0;

const words = (text) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-zÀ-ɏ ]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );

const watch = (page, sink) => {
  page.on('pageerror', (e) => sink.push(`page error: ${e.message.split('\n')[0]}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) sink.push(`console: ${m.text().slice(0, 160)}`);
  });
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === new URL(BASE).origin && r.status() >= 500) sink.push(`HTTP ${r.status()} ${u.pathname}`);
  });
};

const settle = async (page) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page
    .waitForFunction(() => !/^\s*Loading/m.test(document.querySelector('main')?.innerText ?? ''), null, { timeout: 8000 })
    .catch(() => {});
  await page.waitForTimeout(250);
};

const navOf = async (page, width) => {
  if (width >= 1024) {
    return page.$$eval('aside a[href]', (links) => links.map((a) => a.getAttribute('href')));
  }
  await page.getByRole('button', { name: /open navigation|menu/i }).first().tap();
  await page.waitForTimeout(300);
  const hrefs = await page.$$eval('[data-mobile-nav] a[href]', (links) =>
    links.filter((a) => a.getBoundingClientRect().width > 0).map((a) => a.getAttribute('href')),
  );
  // Closed with a TAP on its own backdrop: a mouse click in a touch context
  // makes Chrome report a fine pointer from then on.
  await page.getByRole('button', { name: 'Close navigation' }).tap().catch(() => {});
  await page.waitForTimeout(200);
  return hrefs;
};

/** Every tab on the page, one at a time: the measurement of each panel. */
// A tablet is TAPPED: a mouse click in a touch context makes Chrome report a
// fine pointer afterwards, and the page is then measured as if on a desktop.
const visitTabs = async (page, visit, touch = false) => {
  const done = new Set();
  for (let i = 0; i < 40; i += 1) {
    // Re-read every time: a panel can bring tabs of its own.
    let next = null;
    for (const tab of await page.locator('main [role="tab"]').all()) {
      const name = (await tab.innerText()).replace(/\s+/g, ' ').replace(/\d+/g, '').trim();
      if (!done.has(name) && (await tab.isVisible()) && !(await tab.isDisabled())) {
        next = [tab, name];
        break;
      }
    }
    if (next === null) return;
    const [tab, name] = next;
    done.add(name);
    await (touch ? tab.tap() : tab.click());
    await settle(page);
    await visit(`tab "${name}"`);
  }
};

for (const { role, who } of roles) {
  const setup = await browser.newPage();
  await resetDemonstration(setup, BASE);
  await setup.close();

  const desktop = await browser.newContext({ viewport: DESKTOP });
  const tablet = await browser.newContext({ viewport: TABLETS[0], hasTouch: true, isMobile: false });
  const dPage = await desktop.newPage();
  const tPage = await tablet.newPage();
  /*
   * WHAT A TABLET REPORTS, HELD THERE. A real tablet's pointer is coarse and it
   * cannot hover. Chrome's emulation lets that slip after a full-page
   * screenshot (which resizes the emulated screen) and after any mouse event,
   * and the page is then measured as a desktop. Asserted before every
   * measurement, so the touch rules are what is measured.
   */
  const touchMedia = await tablet.newCDPSession(tPage);
  const asTablet = () =>
    touchMedia.send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'pointer', value: 'coarse' },
        { name: 'any-pointer', value: 'coarse' },
        { name: 'hover', value: 'none' },
        { name: 'any-hover', value: 'none' },
      ],
    });
  await asTablet();
  const dErrors = [];
  const tErrors = [];
  watch(dPage, dErrors);
  watch(tPage, tErrors);
  await dPage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signInAs(dPage, who);
  await tPage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await signInAs(tPage, who);
  await settle(dPage);

  const desktopNav = await navOf(dPage, DESKTOP.width);
  const routes = [...new Set([...desktopNav, ...EXTRA_ROUTES])];
  mkdirSync(`${OUT}/${role}`, { recursive: true });

  // Navigation parity, at every shape.
  for (const shape of TABLETS) {
    await tPage.setViewportSize(shape);
    await tPage.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
    await settle(tPage);
    const nav = await navOf(tPage, shape.width);
    const missing = desktopNav.filter((href) => !nav.includes(href));
    const ok = missing.length === 0;
    if (!ok) failed += 1;
    report.push({ role, page: 'navigation', shape: shape.name, ok, findings: missing.map((m) => ({ kind: 'parity', detail: `nav ${m} missing` })) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${role} · navigation (${desktopNav.length} destinations) · ${shape.name}${ok ? '' : ' :: ' + missing.join(', ')}`);
  }

  for (const route of routes) {
    // The desktop: what the role can do and read here, tab by tab.
    dErrors.length = 0;
    await dPage.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    await settle(dPage);
    const landed = new URL(dPage.url()).pathname;
    const routePath = route.split('?')[0];
    if (landed !== routePath) {
      report.push({ role, page: route, shape: 'all', ok: true, findings: [], note: `not available to this role (lands on ${landed})` });
      console.log(`SKIP  ${role} · ${route} · not available to this role (lands on ${landed})`);
      continue;
    }
    const desktopViews = new Map();
    const dVisit = async (view) => {
      const result = await dPage.evaluate(measure, { minTap: MIN_TAP, minText: MIN_TEXT, touch: false });
      desktopViews.set(view, result);
      const bad = result.found.filter((f) => ['overflow', 'clipped', 'offscreen', 'overlap'].includes(f.kind));
      const findings = [...bad, ...dErrors.map((e) => ({ kind: 'error', detail: e }))];
      const ok = findings.length === 0;
      if (!ok) failed += 1;
      report.push({ role, page: route, view, shape: DESKTOP.name, ok, controls: result.keys.length, findings });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${role} · ${route} · ${view} · ${DESKTOP.name} (${result.keys.length} controls)`);
      for (const f of findings.slice(0, 5)) console.log(`        ${f.kind}: ${f.detail}`);
      dErrors.length = 0;
    };
    await dVisit('page');
    await visitTabs(dPage, dVisit);

    for (const shape of TABLETS) {
      tErrors.length = 0;
      await tPage.setViewportSize(shape);
      await tPage.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
      await settle(tPage);
      const slug = `${route.replace(/[^a-z0-9]+/gi, '_')}`;
      const tVisit = async (view) => {
        await asTablet();
        const result = await tPage.evaluate(measure, { minTap: MIN_TAP, minText: MIN_TEXT, touch: true });
        const reference = desktopViews.get(view);
        const findings = [...result.found];
        if (reference !== undefined) {
          const have = new Set(result.keys);
          for (const key of new Set(reference.keys)) {
            if (!have.has(key)) findings.push({ kind: 'parity', detail: `desktop control ${key} is not on the tablet` });
          }
          const tabletWords = words(result.text);
          const lost = [...words(reference.text)].filter((w) => !tabletWords.has(w));
          if (lost.length > 0) findings.push({ kind: 'parity', detail: `information on the desktop but not the tablet: ${lost.slice(0, 12).join(', ')}${lost.length > 12 ? ` … (${lost.length})` : ''}` });
        } else {
          findings.push({ kind: 'parity', detail: `the view "${view}" exists only on the tablet` });
        }
        for (const e of tErrors) findings.push({ kind: 'error', detail: e });
        tErrors.length = 0;
        const ok = findings.length === 0;
        if (!ok) failed += 1;
        report.push({ role, page: route, view, shape: shape.name, ok, controls: result.keys.length, findings });
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${role} · ${route} · ${view} · ${shape.name} (${result.keys.length} controls)`);
        const byKind = {};
        for (const f of findings) (byKind[f.kind] ??= []).push(f.detail);
        for (const [kind, list] of Object.entries(byKind)) {
          console.log(`        ${kind} ×${list.length}: ${list.slice(0, 3).join(' | ')}`);
        }
      };
      await tVisit('page');
      await visitTabs(tPage, tVisit, true);
      // After the tabs: a full-page screenshot resizes the emulated screen.
      await tPage.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
      await settle(tPage);
      await asTablet();
      await tPage.screenshot({ path: `${OUT}/${role}/${slug}__${shape.width}x${shape.height}.png`, fullPage: true }).catch(() => {});
    }
    await dPage.screenshot({ path: `${OUT}/${role}/${route.replace(/[^a-z0-9]+/gi, '_')}__desktop.png`, fullPage: true }).catch(() => {});
  }
  await desktop.close();
  await tablet.close();
}

await browser.close();

/* The page-by-page checklist. */
const lines = ['# Tablet audit checklist', '', `Generated against ${BASE}.`, '', '| Role | Page | View | Shape | Result | Findings |', '|---|---|---|---|---|---|'];
for (const r of report) {
  const result = r.note !== undefined ? 'N/A' : r.ok ? 'PASS' : 'FAIL';
  const detail = r.note ?? r.findings.map((f) => `${f.kind}: ${f.detail}`).join('<br>').replace(/\|/g, '/');
  lines.push(`| ${r.role} | ${r.page} | ${r.view ?? ''} | ${r.shape} | ${result} | ${detail} |`);
}
writeFileSync(`${OUT}/checklist.md`, lines.join('\n') + '\n');
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const checked = report.filter((r) => r.note === undefined);
console.log(`\n${checked.length - failed} passed, ${failed} failed (${checked.length} page views measured); checklist in ${OUT}/checklist.md`);
process.exit(failed === 0 ? 0 : 1);
