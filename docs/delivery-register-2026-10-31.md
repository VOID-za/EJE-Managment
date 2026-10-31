# Delivery register — 31 October 2026: the system-wide desktop and tablet audit

The owner's "COMPLETE SYSTEM-WIDE DESKTOP AND TABLET QUALITY AUDIT" of 31
October 2026, on top of the release of 30 October (`42cd3d3`,
`docs/delivery-register-2026-10-30.md`). Requirement IDs: **UX-TAB-1 … UX-TAB-5**
in `docs/SCOPE.md`. **Nothing here is approved:** every row stays TESTED until
the owner says otherwise. No migration; no business rule changed.

## 1. How the audit was done

Not a look at a few screens. Three instruments, each run against the
production build on the demonstration backend (never production), and each
kept in the repository so it runs again:

| Instrument | What it does |
|---|---|
| `scripts/tablet-audit.mjs` (`npm run tablet-audit`) | Signs in as each role **twice** — a desktop (1440×900) and a touch tablet — opens **every page the role reaches** (every sidebar destination, plus closed jobs, new job, two job cards, a review page, a customer, a machine list, a technician, search) and **every tab on each page**, at all six tablet shapes. On each it measures: the page scrolling sideways; a control off the screen or cut off by a container that does not scroll; two controls on top of each other; a tap target under 44×44 px; text under 12 px; text cut short with no way to read it; page errors, console errors and failed requests. And it proves **parity**: every control on the desktop (by test id, or role and label) must be on the tablet; every navigation destination must be in the tablet's drawer; every word of information on the desktop page must be on the tablet page. Writes a page-by-page checklist (`.tablet-audit/checklist.md`), a JSON report and a full-page screenshot of every page at every shape. |
| `scripts/tablet-interaction-check.mjs` | What a screenshot cannot show, done with **taps**: the tablet turned landscape → portrait → landscape in the middle of a timesheet line, a message and a new job (values kept, Save/Send still the element under the finger); dialogs opened on 1280×800, 1024×768 and 768×1024 (they fit; every button is tappable); the timesheet freeze reproduced by touch. |
| `scripts/pdf-audit.mjs` + `src/services/simulated/pdf-layout-audit.test.ts` | Every PDF type downloaded the way a person gets it, checked from the bytes (a real PDF, end-of-file, page count, "Page n of N" on every page, file name), and **every page rendered to an image through Chromium's own PDF engine and looked at**. The unit test renders every type with the longest real content (an 80-character Afrikaans school name, a 90-character machine, 600-character write-ups, FANUC part numbers, a 41-character technician name) and measures every text run: nothing past a margin, nothing on top of anything else, **no rule drawn through text**, every value present. |

And the whole job workflow was run on a touch tablet, not only on a desktop:
`EJE_E2E_VIEWPORT=WIDTHxHEIGHT` for `workflow-e2e.mjs` and
`job-workflow-check.mjs`.

**Tablet shapes:** 1280×800, 1180×820, 1024×768 landscape; 1024×1366,
800×1280, 768×1024 portrait — touch enabled, coarse pointer, no hover.
Desktop reference: 1440×900.

## 2. Inventory

| Item | Count | Where |
|---|---|---|
| Pages (routes) | 27 | `src/app/**/page.tsx` — 25 in the app, the offline page, the sign-in page |
| API routes | 96 | `src/app/api/**/route.ts` — permissions asserted by `check-routes`, the API tests and the smoke suite |
| Navigation destinations | Master 15 · Coordinator 15 · Technician 10 | measured from the sidebar per role |
| Tabbed pages / tabs | 7 pages, 37 tabs | job card (7), customer (5), administration (6), library (3), notifications (5), technician (3), calendar (4 views); plus search and settings filters |
| Component files | 118 (16 UI primitives) | `src/components` |
| Dialogs | 68 (50 files) through one `Modal` / `ConfirmDialog`; 5 document previews through one `DocumentPreviewDialog` | |
| Tables | 6 `DataTable` lists; 9 drawn tables (documents, timesheets, attendance) | |
| Form fields | 289 fields (inputs, selects, text areas); 12 file inputs; 24 date/time inputs; 5 signature/canvas components | |
| Buttons | 293 `Button`s; 17 `ButtonLink`s | |
| PDF types generated | 6: final job card, correction addendum, courier delivery note, timesheet for a period, monthly timesheet, monthly attendance (the Finance package carries the last two, byte-identical); plus the in-browser job-card preview | `src/services/simulated/*-pdf.ts`, `one-page-form.ts`, `src/components/jobs/job-card-pdf.ts` |
| PDFs uploaded and previewed | technical library, customer and machine documents | `DocumentPdfPreview`, `LibraryAdminPanel` |
| PWA | service worker (`/eje-sw.js`), update notice, offline page, cached jobs, pending work and media queues | `src/components/pwa` |

## 3. Defects found, and what was done

Prioritised as the owner asked. Every one has a regression test or a
measurement that would fail if it came back.

| # | Defect | Severity | Fix | Proof |
|---|---|---|---|---|
| 1 | **Nine tables dropped columns below 1024 px** — a portrait tablet lost the job list's Machine, Scheduled and Refused; closed jobs' Machine, Technician and Order/Ref; customers' Industry; machines' Type, Year and Installed; administration's users' Email, Mobile and Record since; the library's Uploaded; and the same on a customer's and a technician's job lists. | Missing information | `DataTable`: a secondary column now **folds into the first** below `lg` — its value, labelled with its header, under the row's first cell, wrapping rather than truncating. Nothing is hidden. | tablet audit, information parity on every page |
| 2 | **The job list showed only the technician's initials below 1280 px.** | Missing information | The full name at every width. | tablet audit |
| 3 | **Touch targets under 44 px** — top-bar icon buttons 38–40 px, the logo link 36, every small button 36, the jobs filter chips, the calendar view switch, breadcrumbs, search chips, inputs 36. | Interaction | On a **coarse pointer** every button, link, tab, select and input is held to 44 px (`globals.css`, "A FINGERTIP ON A TOUCH SCREEN"; `Button` `sm`; the `min-h-9` controls). A desktop with a mouse is unchanged. The month grid's bars are the one documented exception — the day cell around them is the 44 px target and opens the whole day. | tablet audit, 44 px at every shape |
| 4 | **The year calendar's days were ~30 px on a tablet.** | Interaction | Two months a row on a touch screen: every day ≥ 44 px. | tablet audit |
| 5 | **An empty week in the month calendar was 42 px** (an inline height beat the touch rule). | Interaction | Never under 44 px. | tablet audit |
| 6 | **Text of 9–11 px** — badges, sidebar group labels, calendar headings, chips, the "SIMULATED" badge, the on-screen document replicas. | Readability | 12 px minimum everywhere. | tablet audit, 12 px at every shape |
| 7 | **A button inside a link in 17 places** ("View all", "New Job", "Open job card", "Open technician", "Resume …", …): two focus stops for one action, a 20 px inline link around a 44 px button, and invalid HTML. | Interaction, keyboard | `ButtonLink`: one element, one tab stop, the button's own size. | tablet audit; smoke steps updated to the link |
| 8 | **Absence names cut short with an ellipsis** in the calendar's day view, with no way to read them. | Missing information | They wrap. | tablet audit, truncation |
| 9 | **The exact time of a notification was only in a hover tooltip.** | Missing information on a tablet | Shown beside the relative time. | — |
| 10 | **A job tile's "Open job" hint appeared only on hover.** | Hover-only | Shown on touch screens. | — |
| 11 | **PDF: every page inherited the letter-spacing of the last spaced-out heading** — address blocks, declarations and footers printed wider than laid out; on the job card's second page the footer ran past the right margin. Character spacing is PDF text *state*; the writer only stated it when non-zero. | PDF | `Tc` is stated on every run. Documents already issued are stored bytes and do not change. | `writer.test.ts`; seen fixed on every rendered page |
| 12 | **PDF: the job card's header rule was drawn through the registration line.** | PDF | The rule sits below it. The inspector now reports **any rule drawn through text**. | `final-document-layout.test.ts` (fails on the old geometry) |
| 13 | **PDF: the delivery note's row separator cut through the next row's capitals.** | PDF | Room below the rule. | `pdf-layout-audit.test.ts` |
| 14 | **PDF: a long machine description ran 68 pt past the margin on the correction addendum.** | PDF, cut-off text | Wrapped. | `pdf-layout-audit.test.ts` |
| 15 | **PDF: long delivery-note details ran off the page; a FANUC part number printed over the description.** | PDF, cut-off text | Both wrap in their columns. | `pdf-layout-audit.test.ts` |
| 16 | **PDF: a month's km totals collided** ("3825.4" over "30615.6") on the timesheet. | PDF, overlap | The totals line sizes its columns. | `pdf-layout-audit.test.ts` |
| 17 | **PDF: the monthly forms dropped the footer's second line** — a long name and period silently lost the "Generated" stamp. | PDF, silently cut | Every line drawn. | `pdf-layout-audit.test.ts` |
| 18 | **PDF: right-aligned titles sat 2–4 pt in the margin** (spacing outside the width allowance). | PDF, minor | Measured with the spacing. | `pdf-layout-audit.test.ts` |
| 19 | **On-screen keyboard:** the viewport did not ask the browser to resize for it, and dialogs were sized by `vh`, which ignores it — a dialog's Save could sit behind the keyboard. | Forms on a tablet | `interactive-widget=resizes-content`; dialogs and the document preview sized by `dvh`. **Not verifiable without a physical tablet** — staff-testing L4. | — |

Not defects, recorded because they were looked at: Messages, the timesheet
freeze and the Attendance page were fixed on 30 October and are re-verified
here at every shape; the month calendar's bars sit on top of their day cell by
design; the Coordinator's Administration access is unchanged (a permission
decision, not a layout one).

## 4. Desktop/tablet parity

The audit compares the two directly — see §1. Result on the final build:
**every desktop control, navigation destination and word of information is on
the tablet at every shape, for every role** (§5). The only differences are
presentational and intended: the sidebar is a drawer below 1024 px; a table's
secondary columns fold into its first column below 1024 px; the year calendar
shows two months a row on touch; controls are 44 px on touch.

## 5. Results (this PC, the production build, each browser suite run alone)

| Suite | Passed | Failed | Skipped |
|---|---|---|---|
| Unit and application (`vitest`) | 3355 | 0 | 19 (Windows-only, reasons recorded) |
| Typecheck, lint, production build | clean | — | — |
| **Tablet parity audit**, all roles, desktop + six tablet shapes | 1216 of 1222 page views on the first full run; the 6 were one defect (the Users page's name links, 20 px tall) — fixed. Final run: see the release record below | | |
| Tablet interaction check (rotation mid-form, dialogs, the freeze by touch) | 7 | 0 | — |
| Workflow end-to-end — desktop, 1024×768, 768×1024 (also 800×1280 and 1280×800 on the previous build) | 65 each | 0 | — |
| Job workflow check — desktop, 1024×768, 768×1024 | 44 each | 0 | — |
| Smoke | 268 | 0 | — |
| Tablet and phone layout (`responsive-check`) | 123 | 0 | — |
| Signed document on both PDF paths (`tablet-pdf-check`) | 18 | 0 | — |
| Routes | 33 | 0 | — |
| Update notice across two real builds | 6 | 0 | — |
| PDF audit: documents checked and every page drawn and looked at | 10 documents, 14 pages | 0 | — |

The tablet PDF check failed once (17/18) with the local server started where
`pdftotext` was not on its PATH: the built-in reader keeps no per-page text, so
a 1 200-page manual is *partially indexed* by design. Re-run with poppler on
the PATH (as CI and the VPS have it): 18/18. Not a code defect.

Screenshots: every page at every shape (`.tablet-audit/<role>/`), every PDF
page (`.pdf-audit/`), written by the runs; the CI run keeps the checklist and
report as an artifact.

## 6. What was not, and cannot be, verified here

- **A physical rugged tablet** — glare, gloves, a stylus, the on-screen keyboard
  (defect 19), a real printer through Android's print service, an installed PWA
  launched from the home screen, connection loss in a workshop. Every result
  here is **emulated** (desktop Chrome, touch emulation, coarse pointer).
  `docs/staff-testing.md` section L lists the checks.
- **Printing on a real printer.** Print is proved to call the browser's print
  exactly once and to isolate the document; no printer was attached.
- **Chrome on Android's PDF behaviour** is emulated by `pdfViewerEnabled =
  false` (the HTML document path), as CI's headless shell reports.
