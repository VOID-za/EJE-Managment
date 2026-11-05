# Payroll — physical-device test sheet (v1.5.2)

*Rewritten 5 November 2026 for the payroll completion. The v1.2.0 sheet it
replaces described a Timesheets page with Add line, Save line and Submit
timesheet; since PAYROLL-ONE-1 lines are typed straight into each day and save
themselves, and both forms are submitted together on **My Monthly Forms**.
V1–V13 and O1–O6 keep their numbers; rows whose v1.2.0 wording no longer
matches the app are rewritten, and nothing automated is left on this list.*

**Only what a person on a real device can judge is here.** Everything else in
V1–V13 and O1–O6 runs automatically in Chromium at 1440×900, 768×1024 touch and
390×844 touch on every change (CI) — see *What is automated* at the end. **None
of the rows below has been done on a real phone, the rugged tablet or a real
printer.** Mark a row only when it has actually been done on the device named.

Site: https://eje.syncza.co.za (demonstration data — nothing entered here is
the business's record; email is off, nothing is sent). Use the demonstration
users (Demo mode → Switch user): a **technician** (e.g. David Technician), the
**Senior Tech** (John Master) and the **Office** (Sarah Coordinator). Do not
use a real employee's name.

Before starting, on each device: Administration → System (or the page footer)
says **v1.5.2**; if a bar says "A new version of EJE is available", press
**Update now** first.

Record: **P** = pass, **F** = fail (write what happened), **—** = not done.

## A. Real mobile phone (Android or iPhone), as a technician

| # | Action | Expected result | P/F | Device / notes |
|---|---|---|---|---|
| V1 | Timesheets → **Add line** on today. Customer = type a name, OT 2.5, Cust Km 42, Callout 450. Wait for **Saved**. Close the browser app completely (swipe it away); open the site again; Timesheets. | The line is there with every value. Each line's labels are readable on the phone, nothing is cut off, nothing scrolls sideways — in daylight outdoors, and wearing work gloves if staff wear them. | | |
| V3a | Half-type a line (customer only), switch to another app for a minute or lock the phone; come back. | Every typed value is still there, and it says Saved once it has gone. | | |
| V3b | On a line, use the phone's own **date picker**: clear the date, pick another. | The page stays answering; the line moves to the new day and saves. | | |
| P1 | Turn on **airplane mode**; type a line; wait. Turn data back on. Repeat once on a weak signal (far from the building). | Offline, the page says the change is kept on this device and not saved yet; when the signal is back it saves by itself, without retyping. | | |

## B. The rugged tablet, as a technician (portrait, then landscape)

| # | Action | Expected result | P/F | Notes |
|---|---|---|---|---|
| V4 | Change OT on one line; **Remove** another. Use the touchscreen as staff do (gloves if worn). | The change saves; the removed line goes. Every control is big enough to hit first time. | | |
| V4a | Turn the tablet with a line half typed. | Every typed value stays. | | |
| P2 | With the tablet's **physical keyboard**, if it has one: Tab through a line; type numbers into OT and Km. | Tab moves field to field in order; the numbers go where typed. | | |
| V5 | **My Monthly Forms** → choose From and To → **Preview** both forms → **Submit both**; confirm. | Both forms previewed; after confirming, both are in the History; on Timesheets the submitted lines are read only. Typing feels responsive on this tablet (no freeze — TST-TS-2). | | |
| V12a | In the History (or Timesheets → your submitted timesheets) press **Download PDF**, then **Save PDF**, of a submission you renamed first. | The tablet's own save/share sheet opens; the file opens in its PDF app, under the name you gave it. | | |
| V8 | Timesheets → your submitted timesheet → **Corrections** → change OT, give a reason, send. (Then do C. V8b.) | "Sent for review"; the original stays readable. | | |

## C. The office desktop and printer

| # | Action | Expected result | P/F | Notes |
|---|---|---|---|---|
| V8b | As the Office: Timesheets → the technician's submission → Corrections → **Accept**. | View corrected version and View original both open and differ only by the correction. | | |
| V7 | As the Office: Timesheets → a technician → **Export CSV**; open it in **Excel**. | Opens cleanly: one row per line, columns OT, D/T, Callout, Int Km, Cust Km. | | |
| V12b | As the Office: EJE Monthly Forms → the month → **View forms** (read only) → tick the technician → **Prepare**. Do **not** press Send. **Discard**. | The package lists both PDFs under their submitted names; Discard leaves nothing sent. | | |
| V13a | Print a normal timesheet on the office printer. | One A4 page; the Comments box printed; nothing cut at the edges. | | |
| V13b | Print a long timesheet (one with more lines than fit a page — make one in the demonstration). | Headings and "Page X of Y" on every page; totals after the last line. | | |
| O1–O3 | On each real device, as the Office: Attendance → mark today; My Monthly Forms → **Submit attendance**. | Attendance only — no timesheet is asked for; the History shows the attendance alone. Readable on the device. | | |

## D. The installed tablet application

| # | Action | Expected result | P/F | Notes |
|---|---|---|---|---|
| P3 | On the rugged tablet, with EJE **installed** to the home screen (Android): when "A new version is available" shows, press **Update now**. Then open My Monthly Forms and download a PDF. | The update completes; the forms open; the download lands in Downloads. | | |

## What is automated (not on this sheet)

Run on every change in CI, at desktop, tablet (touch) and phone (touch):

| Rows | Automated by |
|---|---|
| V1 (reload, sign out and in), V2 (several lines and Workshop on one day), V3 (a line outside the period is said and brought back) | `payroll-forms-check` steps 1–6; `forms-regression`; `payroll-views-check` "Timesheets: … a line outside the period" |
| V3a, V4a (values kept: leaving, reloading, turning) | `forms-regression` "a half-typed line survives a reload"; `timesheet-two-devices-check` "LEAVING at once", "a NEW line … after a reload"; `tablet-interaction-check` |
| V3b (date cleared and retyped) | `tablet-interaction-check`; the smoke suite |
| V4 (edit, remove) | `payroll-forms-check` 7–10; `forms-regression` |
| V5 (Preview and submit both) | `payroll-forms-check` 14–17, 24–27 |
| V6 (the same dates again are refused; only a confirmed complete replacement) | `payroll-forms-check` 30; `payroll-views-check` "a complete replacement through the screen" |
| V10 (a partial overlap is refused) | `acceptance-check` |
| V11 (replaced, the original kept as replaced and readable) | `payroll-views-check` "a complete replacement through the screen" |
| V12a (the submitted name everywhere) | `payroll-forms-check` 18–20, 27–28; `payroll-views-check` "History …" |
| V7 (the CSV's columns) | `payroll-views-check` "Corrections …" |
| V8 (the correction asked for and accepted; version in force; original readable) | `payroll-views-check` "Corrections …" |
| V9 (each person sees their own forms only) | `forms-regression`; `payroll-views-check` "another technician sees none of it" |
| V12b (View forms read only; Prepare; a package no longer current is refused at Send) | `payroll-views-check` "the office …", "Finance …" |
| V13a, V13b (the PDF itself: one page; many pages with headings, Page X of Y, totals last) | `forms-regression` "PDF: the Time Sheet for the period"; unit tests `one-page-form.test.ts`, `timesheets-paper-fixes.test.ts` |
| O1 (attendance only for the Office) | `payroll-views-check` "attendance only"; `forms-regression` |
| O2, O3 (each role its own days only) | `forms-regression` |
| O4 (the office reads; there is no attendance CSV — CSV-OFF-2) | `payroll-views-check` "the office …"; `tester-fixes-check` |
| O5 (no CSV on a technician's own sheet) | `forms-regression`; `batch-check` |
| O6 (unrecorded days left out of the PDFs) | unit tests (PDF-UNREC-1) |
| Two devices on one line; offline then online; leaving mid-save | `timesheet-two-devices-check` |
