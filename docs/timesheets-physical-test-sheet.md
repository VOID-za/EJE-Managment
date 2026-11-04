# Timesheets — physical-device test sheet (v1.2.0)

For the owner and staff to complete on **real devices** before issue #131 is
approved. Everything here has passed in automated browsers (Chromium at
1440×900, 768×1024 touch and 390×844 touch — `scripts/timesheets-paper-check.mjs`,
`scripts/acceptance-check.mjs`, the smoke suite). **None of it has been done on a
real phone, the rugged tablet or a real printer.** Mark each row only when it has
actually been done on the device named.

Site: https://eje.syncza.co.za (v1.2.0, demonstration data — nothing entered
here is the business's record; email is off, nothing is sent). Use the
demonstration users (Demo mode → Switch user): a **technician** (e.g. David
Technician), the **Master** (John Master) and the **Coordinator** (Sarah
Coordinator).

Before starting, on each device: open the site, check the page footer or
Administration → System says **v1.2.0**; if a bar says "A new version of EJE is
available", press **Update now** first.

Record: **P** = pass, **F** = fail (write what happened), **—** = not done.

## A. Real mobile phone (Android or iPhone), as a technician

| # | Action | Expected result | P/F | Device / notes |
|---|---|---|---|---|
| V1 | Timesheets → **Add line**. Date = today, Customer = type a name, OT 2.5, Cust Km 42, Callout 450. **Save line**. Close the browser tab completely; open the site again; Timesheets. | The line is listed under today's date with every value; on the phone each line shows Date, Customer, OT, D/T, Callout, Int Km and Cust Km stacked and labelled — nothing cut off, no sideways scrolling. | | |
| V2 | Add two more lines on the **same date**: another customer (OT 1), then choose **Workshop** in "Customer or Workshop" (OT 3) with no customer typed. | Three lines on the day; the Workshop line saves without asking for a customer. | | |
| V3 | Add a line dated **last month** and one dated **next week**. | Both save. The earlier one may say "Outside the dates below" — that is information, not an error. | | |
| V3a | Half-type a line (date and customer only), switch to another app for a minute, come back (or let the phone lock). | The line is still there, or offered back with "A line you had not saved … has been put back". | | |
| V3b | Use the phone's **date picker** in the line's Date field; clear the date and pick another. | The form stays open and answering; Save line waits until a whole date is chosen. | | |

## B. The rugged tablet, as a technician (portrait, then landscape)

| # | Action | Expected result | P/F | Notes |
|---|---|---|---|---|
| V4 | **Edit** one of the lines from A (change OT); **Remove** another (confirm). | The change shows at once; the removed line is gone after confirming. | | |
| V4a | Turn the tablet with a line half typed. | Every typed value stays; Save line stays reachable. | | |
| V5 | Type a **Comment**; **Save comment**. In **Submit on payday**: check From (the day after the last submission, or the earliest line) and To (today); press **Preview**; close it; press **Submit timesheet**; confirm. | Preview shows the Time Sheet with the lines and comment. After confirming: a green message naming the next timesheet's first day; the comment box is empty; the submission is listed under "Your submitted timesheets"; the next-week line is still on the sheet. | | |
| V6 | Set From and To back to exactly the dates just submitted; press Submit timesheet; confirm. | Refused: "You already submitted your timesheet for …" — nothing changes. | | |
| V10 | Set From to a day **inside** the submitted period and To to a later day (e.g. the next week). | A red message: the dates cover only part of the submitted timesheet; **Submit timesheet is greyed out**. | | |
| V11 | Set From to a day **before** the submitted period and To to a later day, so the dates cover **all** of it; press Submit timesheet. | The dialog says it **REPLACES** the submitted timesheet and the button reads **Replace and submit**. Press it: the old one is listed as "Replaced … by a later submission"; its **View original** still opens it. (Or press Cancel to leave everything as it was.) | | |
| V12a | On a submission: **View original**; **PDF**. | Both open/download, labelled "ORIGINAL SUBMISSION"; the PDF opens on the tablet. | | |

## C. Office desktop (Master or Coordinator)

| # | Action | Expected result | P/F | Notes |
|---|---|---|---|---|
| V7 | Timesheets → **Submitted timesheets — every technician**. Find the technician's submission from B: **View original**, **PDF**, **Export CSV**. | The list shows the technician, From, To, when submitted and lines. The preview matches what was submitted; the PDF downloads; the CSV opens in Excel with one row per line (OT, D/T, Callout, Int Km, Cust Km). | | |
| V8 | As the technician (tablet or phone): on a current submission press **Corrections**, change one line, give a reason, send. As the Coordinator on the desktop: open it, **Accept**. | The submission shows "Correction 1, accepted"; **View corrected version** shows the change; **View original** still shows the original values. | | |
| V9 | As the technician: **My Monthly Forms** for last month. | Attendance only, with the note that the timesheet is submitted from the Timesheets page by payday. | | |
| V12b | As the Master: EJE Monthly Forms → the month → **View forms** / Finance package **Prepare** (do not Send). | The technician's row says "Timesheet submitted: <period>"; the prepared package lists the timesheet PDF(s) for submissions ending in that month and the attendance; nothing is emailed (email is off). Discard the package afterwards. | | |

## D. Printer (office printer, real paper)

| # | Action | Expected result | P/F | Notes |
|---|---|---|---|---|
| V13a | Print a **normal** submitted timesheet (Print from the preview). | One A4 page, readable, every column present, the Comments box printed. | | |
| V13b | Print a **long** timesheet (over ~190 lines). The live demonstration holds none, so print `docs/samples/timesheet-long-printer-sample.pdf` — 230 lines, 1 Jul – 15 Oct 2026, produced by the deployed v1.2.0 renderer and marked SAMPLE (not a real timesheet). If a real long submission exists by then, print that too, from its PDF button. | **Several pages**; every page has the column headings and "Page X of Y"; a day's lines are not split across pages; the **Totals**, the note and the Comments are after the last line; totals OT 287.50, D/T 29.00, Callout R 14 850,00, Int Km 2875.0, Cust Km 6900.0. | | |

## Sign-off

| | Name | Date | Signature |
|---|---|---|---|
| Phone tests (A) | | | |
| Tablet tests (B) | | | |
| Office tests (C) | | | |
| Printer tests (D) | | | |
