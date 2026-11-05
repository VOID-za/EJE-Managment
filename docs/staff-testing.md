# Staff testing — the deployed EJE system

*Written 27 October 2026 for the release from `claude/office-workflow-parts`.*

> **WHAT IS LIVE:** see the newest "Automated post-deployment verification"
> section at the end of this file and `docs/deploy-next-release.md`. For the
> releases of 29 October 2026, test **section H** (the reviewer's changes and
> timesheet corrections) and **section I** (monthly forms and the Finance
> package).
>
> *History: on 28 October 2026 `ef0f695` was live (migrations 0034–0036, rollback
> `51fb112`) and section G was what to test then.*

**Where:** https://eje.syncza.co.za — the existing EJE server. It holds
**demonstration data** (fictional customers and jobs), so nothing you do here
reaches a real customer.

**What is not live, and must not be reported as working:**

- **Email to customers.** Until EJE supply the Microsoft 365 app registration,
  a submitted job card is stored and recorded as *pending* delivery — it is
  **not emailed**. That is correct behaviour, not a fault.
- **WhatsApp.** Until EJE supply the WhatsApp token and approved templates,
  assignment and transfer messages are queued and recorded, **not sent**.
- **Text recognition (OCR) on library documents** stays off until EJE approve it.

Record every check in the table at the end: **PASS**, **FAIL** (with what you
saw and a screenshot), or **NOT RUN**. A blank is not a pass.

## Before you start

1. Open the address above on a desktop browser and on the rugged tablet
   (Chrome). The sign-in page is the address itself. On this demonstration
   deployment use **DEMO ONLY · Switch user** to sign in as the Master, the
   Coordinator or a Technician — **anyone with the address can do this, so
   never enter real customer information here.**
2. On the tablet, install it: Chrome menu → *Install app* (or *Add to Home
   screen*). See `docs/tablet-installation.md` for the full device checks.
3. Check the build: the address `/api/health` shows `"status":"ok"` and the
   `commit` the operator says was deployed.

## A. Signing in and roles

| # | Do this | Pass looks like |
|---|---|---|
| A1 | Sign in as a Master, a Coordinator and a Technician in turn | Each lands on their own dashboard; the technician sees only their jobs |
| A2 | As a Technician, try to open Administration, Customers' editing, Attendance recording | Refused or not offered |
| A3 | Sign out from the profile menu (top right) | Back at sign-in |

## B. A field job, start to finish (online)

| # | Do this | Pass looks like |
|---|---|---|
| B1 | Master: create a breakdown job for a customer, assign a technician | Job appears with its number; the technician sees it as waiting for acceptance and has an in-app notice; the job's **Activity** says the WhatsApp message was **queued** — queued is not sent (the Notifications outbox stays empty until EJE's WhatsApp is connected) |
| B2 | Technician: open it, *Accept job* | Status In Progress |
| B3 | Add labour, travel, a part, a note; add a photograph from the camera | Each appears on the job; the photograph shows as a picture, not a placeholder |
| B4 | Type the completion write-up | It says *Saving… / Saved* by itself — there is no Save button |
| B5 | Scroll to the **bottom** of the In Progress job: *Complete job* is there (not at the top), with a summary of labour, km, parts and notes. Press it → through the steps → Review | One *Complete job* button only; the review lists what was captured |
| B6 | Signature: customer name, surname, sign, *Confirm signature* | The signed job card PDF is shown, **with the photograph in it** |
| B7 | *Submit job card* | Job goes to the office (**Office Handling**); the customer copy's delivery shows **failed — customer email is not configured**. That is the honest answer until EJE's Microsoft 365 is connected: nothing was emailed |
| B8 | Office: Notifications → Inbox → *Mark handled* | Moves to **Awaiting PO** |
| B9 | Enter the invoice number | Moves to **Invoiced**; it appears in Closed Jobs |
| B10 | Office: transfer another job to a different technician | The receiving technician sees it; the job's Activity records the WhatsApp as **queued** with the approved assignment template |

## C. Refusal and corrections

| # | Do this | Pass looks like |
|---|---|---|
| C1 | Technician: at the signature step, tick *Customer refused to sign*, give a reason | Job goes to the office; Master and Coordinator are notified |
| C2 | Office: resolve it — correct and return for signature, or issue without signature | Without signature → Office Handling (not closed directly) |
| C3 | Master: on a closed signed job, *Raise correction* with area **Labour** | The acknowledgement answer is locked to **Yes**; the correction says *Awaiting the customer* until an acknowledgement is recorded |
| C4 | Raise a correction with only **Dates** | Yes or No may be chosen |

## D. Offline (the tablet, network off)

Do these on the tablet with **flight mode** on, after opening the job once with signal.

| # | Do this | Pass looks like |
|---|---|---|
| D1 | On an open job: add labour, a note, a checklist answer, a photograph | Each says it is held on the tablet and *Not sent* |
| D2 | Close the app and reopen it (still offline) | The offline page shows the job's copy and the held work count |
| D3 | On the offline page, under your job: hold a **Note** and **Labour** | *Held on this tablet — not on the job* |
| D4 | Flight mode off; open the app | Rows say *Syncing…* then leave; the job shows every held item **once** |
| D5 | Offline signature: take a job to the **signature step with signal**, then flight mode on; the job card appears on the screen; show it, take the signature | *Held on this tablet — not on the job yet* |
| D6 | Flight mode off | The job moves to Review; the Activity trail's *Customer signed* line names the document identity |
| D7 | Repeat D5, but have the office **apply the call-out fee** to that job while the tablet is offline; then reconnect | Nothing is signed; the row says *With the office*; the office's **Field Captures** shows the held signature with reason *document changed* |
| D8 | Look for a video button anywhere | None: video is no longer accepted (photos and documents only). Videos recorded before stay visible as *Videos (historical)* |

## E. Office records

| # | Do this | Pass looks like |
|---|---|---|
| E1 | Customers: open a customer | One site with address and a Google Maps link; contacts listed; a legacy multi-site customer can be consolidated with a preview |
| E2 | Technician: **Attendance** (own) — mark yourself Present for today and Absent for an earlier day | Both saved; days you did not mark say *Not recorded* (nothing is assumed); future days refused. Office: Attendance shows them; export CSV |
| E3 | Technician: **Timesheets** — for a past date, *Add line*: customer, NT, OT, DBL T, call-outs, comment; edit it; remove a line | Saved exactly as typed — nothing is worked out from labour; a day with no lines says *Not recorded*, a day with a 0-hour line says *Recorded*; over 24 h in a day or hours without a customer is refused. Another technician cannot edit your sheet. Office: view and export — unrecorded days export as `NOT RECORDED` |
| E4 | Field Captures (office) | Lists work a tablet could not apply, with the reason; *Apply* works for labour; a held signature offers only *No action — record why* |
| E4a | Field Captures (technician) | The menu item is there; it shows only **your own** referred captures with *With the office / Applied to the job / No action* and the office's note |
| E5 | Closed Jobs, search and exports | Results load; an export is recorded on the audit trail |

## G. Real-world testing fixes (27 October 2026)

| # | Do this | Pass looks like |
|---|---|---|
| G1 | Technician: *Complete job*, then on the first step press **Cancel completion** → *Back to In Progress* | Job is In Progress again; labour, travel, parts, notes, photos, documents, checklist answers and write-up all still there. Repeat from the signature step (step back from the signature): same result |
| G2 | Leave the wizard part-way (or close the browser), reopen the job | *Continue completing* and **Cancel completion** are both offered on the job |
| G3 | After the customer has signed, look for *Cancel completion* | Not offered; the server refuses it too |
| G4 | Labour & Parts → *Add part* → **Add another part** twice → save; then *Add part* again | Three parts saved in one go; the next dialog starts empty |
| G5 | Accept a **Parts** job and a **Test & Repair** job | No *Send Site Location?* prompt. A breakdown still asks |
| G6 | Master: Administration → Settings → **Test bench fee** (e.g. R450). Technician: on a job tick **Test bench** beside call-out | Unticked by default; ticking adds the fee once to the totals, review and PDF; after signature it can no longer be changed, and changing the setting later does not alter the signed total |
| G7 | Look for a discount control anywhere (job, wizard, office) | None. A job discounted before this release still shows *Discount (historical)* with its original total |
| G8 | Job → Photos & documents: **Add Photo** and **Add Documents** (a PDF) | Both appear; video is not offered; a video file is refused |
| G9 | Messages: open a chat → **Delete chat** → confirm | Gone from your list only; the other person still has it; if they write again it comes back with only the new message |
| G10 | Notifications: *Mark as read* on one | The bell count drops immediately. A *Job card submitted* notification has a green edge, icon and label |
| G11 | Office: a job card already issued → **Corrections** panel | The help text explains when to use it (a wrong issued job card), that the signed card is never edited, who raises it (Master) and who records the customer's acknowledgement |
| G12 | Job → **What the customer has asked for** → *Record a request* | Recorded against the job, waiting for the office; the office accepts or declines with a reason; nothing on the job changes by itself |

### What these screens are for (plain words)

- **Corrections** — the only way to fix a job card the customer has already
  received. The signed card is never changed. A Master writes a numbered
  correction (a separate addendum PDF linked to the original) saying what was
  wrong and what is right. If it changes a price, a quantity or the work
  described, the customer must acknowledge it, and the office records that.
- **Field Captures** — when a technician captured something offline (hours,
  travel, a part, a note, a checklist answer, a signature or refusal) and by the
  time it reached the server the job would not take it (signed, closed,
  reassigned, or the job card changed). Nothing is lost: it waits here. The
  office decides *Apply* or *No action*; the technician sees the outcome. A held
  signature is never applied — the customer signs the current job card again.
- **What the customer has asked for** — requests the customer makes after the
  job was raised: more work, a different date, a change to what was agreed.
  Anybody on the job records it; the office accepts or declines it with a
  reason. It is not the original fault description and not the technician's
  write-up, and nothing on the job changes by itself.

## H. The reviewer's changes, the owner's decisions and timesheet corrections (28–29 October 2026)

**LIVE since 29 October 2026** in `1a34d1c` (migrations 0037, 0038 and 0039
applied; `docs/deploy-next-release.md`). Use fictional data only
while the demonstration switcher is on. Two accounts are needed for the
corrections: a technician and a Master or Coordinator.

**H0 — FIRST, refresh every rugged tablet to the deployed build** (close the
app/tab fully and reopen it, or pull down to reload, and check *Signed in as …*
appears again). Do this before ANY courier collection. A tablet still on the old
build shows the courier the priced job card at the signature step, and a courier
signature it holds offline goes to Field Captures instead of the job — safe, but
the courier must sign again.

### What the automated checks already prove (no person needed)

Run on every commit in CI and before the release: the unit, HTTP and PostgreSQL
suites (absence reasons, timesheet isolation, From/To rules, Send to office,
overlap, notifications, the seven columns, corrections and every database
refusal, courier documents and signatures, offline and stale-build recovery,
parts locking), the browser smoke journey (including a correction asked for and
accepted), and the tablet check on a browser with no PDF viewer: the job card,
the Delivery Note and the Time Sheet open INSIDE the app, nothing downloads by
itself, Print asks the browser to print once with only the document on the page
and writes nothing, Download PDF saves the same PDF each time. **What no
automated check can prove** is below in the *Needs a person* steps: the real
print dialog, the real printer, the real rugged tablet and its browser.

### Needs a person — in this order

| # | Do this | Pass looks like |
|---|---|---|
| H1 | Technician: **Attendance** → *Absent* on a day | A reason is required — exactly Leave, Sick Leave, Family Responsibility, IOD (Injury on Duty). The day shows "Absent — the reason". An absent day from before shows "reason not recorded" |
| H2 | Office: Attendance register → *Absent* for someone; export CSV | Same four reasons; the CSV has an *Absence reason* column |
| H3 | Technician: **Timesheets**; set **From** and **To** (e.g. the 3rd to the 12th). Then set From AFTER To. Then leave the page and come back | Oldest day at the TOP, both chosen days included, each date with its day ("Mon 26 Oct 2026"). From after To shows a message and saves nothing. Coming back: From and To are back to the 1st of the month → today, and every saved line is still there |
| H4 | *Add line* → **Workshop**; OT, D/T, **Callout (R)**, **Int Km**, **Cust Km**. Try Workshop AND a customer name | No NT box. The line shows Workshop, the amount, both kilometres. Workshop with a customer is refused |
| H5 | Two technicians shared a R1 000 call-out: each enters **R500** and ticks *Shared* | Each shows R500 (shared). Nothing is divided or changed by the system |
| H6 | Type the period's **Comments** → **Save**; **Preview**; **Print** | "Saved … Not sent to the office". The Time Sheet appears in the app with your name, the Period, the columns **Date, Customer, OT, D/T, Callout, Int Km, Cust Km** (no Hm, no NT) and your comment. Print shows only the sheet. Nothing is sent |
| H7 | **Send to office** → confirm | "Sent to office (date) by (you)". Add line, Edit, Remove, Save and Send are gone for those days |
| H8 | Try to send the SAME From/To again; then choose a period that includes one of those days and try to send it | Both refused, with a message; nothing new is sent |
| H9 | Office (Master or Coordinator): the **bell** → *Timesheet sent to the office*; Timesheets → that technician → the same From and To → Preview | One notification. The sent version, read-only, with the comment. The technician who sent it got no such notification |
| H10 | Technician, on the sent period: **Ask for a correction** → change one line's OT, add a line, press *Send correction for review* WITHOUT a reason; then type a reason and send | Without a reason: refused, everything typed kept. With it: "Correction sent to the office for review"; *Correction 1 — Pending the office's review*, listing exactly what changes; the sheet still shows the original; *Ask for a correction* is not offered again while it waits |
| H11 | Office: Timesheets → *Timesheet corrections waiting for you* → **Open** → read the changes → **Reject** with no note, then with a note | Without a note: refused. With it: *Rejected*, the note shown; the sheet unchanged ("In force: Original submission"); the technician is notified and may ask again (Correction 2) |
| H12 | Office: on the next correction → **Accept correction** | *Accepted*; "In force: Correction 2, accepted … by (you)"; the day badges say "Sent — correction 2 accepted"; totals, Preview, Print and Export CSV (*Sent version* column) show the corrected lines. **Preview the original submission**: still exactly what was sent, marked superseded. The technician is notified |
| H13 | Try to decide the accepted correction again (another office user, or reload and look) | No Accept/Reject offered; a decision is final. A technician never sees Accept/Reject |
| H14 | A **breakdown, installation, service and Test & Repair** job: **Complete job**, then try to add, change or remove a part | Not offered on any of them; the screen explains why. *Cancel completion* → parts editable again in In Progress. A Parts job still records its goods at completion and cannot have completion cancelled |
| H15 | New Job → **Parts**: leave the order number empty, fill **Quote number** | The job is raised; the quote number is on the job card |
| H16 | A Parts or Test & Repair job collected by a **courier** (waybill entered): at the signature step | The screen shows the **Delivery Note** (goods, quantities, waybill, NO prices) and the courier signs **once**. After submitting: the priced job card (to the customer, kept for the office) shows the courier's signature "given once, on the Delivery Note" with a signature reference; *Delivery note* shows the stored note with the same signature and reference and no prices |
| H17 | Repeat H16 **with no signal** at the signature step; restore the signal | The signature is held, then accepted; both documents carry it once; no second Delivery Note appears |
| H18 | **On the actual rugged tablet** (the reviewer's report is UNCONFIRMED): a Test & Repair job → Complete job → Review → **Job card PDF** in the browser EJE uses | Record what happens. Pass: the job card appears INSIDE the app (not a silent download, not a blank screen). Note the tablet model, Android version and browser |
| H19 | In that preview press **Print** | Record whether the print dialog opens, what it shows (only the job card, no app menus) and — if a printer is reachable — what prints. Cancel is fine |
| H20 | In that preview press **Download PDF**, then open the file from the tablet's Downloads | Record whether the file saves, its name, and whether it opens and shows the same job card. Repeat H18–H20 for the Delivery Note and the Time Sheet |
| H21 | Regression: a normal breakdown job start to finish (section B), a refusal (C), offline capture (D), a customer and machine edit, and the office review | Unchanged from before |

What these do NOT prove: real email or WhatsApp delivery (out of scope; EJE's
credentials are needed — job cards are recorded as *pending*/refused, not sent).
Notifications for timesheets and corrections are in-app only.

## I. Monthly forms and the Finance package (29 October 2026)

**LIVE since 29 October 2026** in `a46e767` (migration 0040 applied; `docs/deploy-next-release.md`).
Fictional data only while the demonstration switcher is on. Needs a technician
account, a Coordinator or Master account, and — for I12 — a Master.

**Before you start:** refresh every tablet to the deployed build (H0). A Master
sets each technician's **Name on documents** (Administration → Users → edit,
e.g. JC, RUAN) and the **Finance recipient** (Administration → System). On this
site email is NOT configured (`email: refuse`): Prepare works, Send is refused
with a message — that is correct until EJE's Microsoft 365 credentials and the
approved Finance address are in place. Do not use a real Finance mailbox for
testing.

### What the automated checks already prove (no person needed)

Both PDFs are exactly ONE page — read back from the PDF file itself — for
normal and worst-case months (three long lines every day, the longest comment,
155 lines in two panels, a 92-day period, 31 days of long attendance notes),
with every row present and nothing cut off. The file names follow the rule. A
month is submitted once, both documents together, and freezes the attendance
for the technician. The package carries exactly two one-page PDFs per selected
technician; ten technicians make twenty PDFs in ONE email (with a fake mail
transport); two clicks send once; a failure is recorded and can be retried; an
unconfigured server refuses before anything is recorded as sent; a correction
after sending never changes what was sent. Technicians are refused every
office route.

### Needs a person — in this order

| # | Do this | Pass looks like |
|---|---|---|
| I1 | Master: Administration → Users → a technician → **Name on documents** = e.g. "JC" → Save | Saved; the hint shows "JC TIMESHEET OCT.pdf" |
| I2 | Master: Administration → System → **Finance recipient** = a TEST address you control → Save. A Coordinator tries the same | Saved and on the activity trail; the Coordinator cannot change it |
| I3 | Technician: **Monthly forms** → last month | Your name and the month; two cards: Timesheet "JC TIMESHEET OCT.pdf · one page", Attendance "JC ATTEN OCTOBER.pdf · one page" |
| I4 | **Preview** each, then **Print** each, then **Export PDF** each | The documents appear in the app (not a silent download): Time Sheet with Date, Customer, OT, D/T, Callout, Int Km, Cust Km; Attendance with Date, Attendance, Absence reason, Note and the month's count. Print shows only the document. The downloaded files carry exactly those names and open as ONE page each |
| I5 | Make an absent day with no reason impossible to submit: try to submit a month that has one (if any) | Refused, naming the day — record the reason in Attendance first |
| I6 | With weekdays unrecorded, look at **Submit** | Disabled until you tick the confirmation that lists those days |
| I7 | **Submit** → confirm | "Submitted to the office: JC TIMESHEET OCT.pdf and JC ATTEN OCTOBER.pdf"; Submit is gone; the office's bell shows one notification |
| I8 | Technician: Attendance → try to change a day in that month | Refused: the month has been submitted (the office can still correct it) |
| I9 | Office: **Monthly forms** → the month | Every technician with a status (Not submitted / Ready / Correction waiting / Sent / Corrected after sending), the Finance recipient, and the email readiness sentence |
| I10 | Tick the ready technicians → **Prepare package** | The package lists exactly two files per technician with their names, "1" page each, sizes and the total against the limit; nothing is sent. **Open** a file: it is the same document the technician previews |
| I11 | **Send to Finance** → confirm | On this site: refused — "Email cannot be sent from this deployment", the package stays Prepared. Once email is configured: ONE email to the test address with every file attached; the package shows Sent, who, when and the provider's answer; Send is gone |
| I12 | After a send: accept a timesheet correction for one of those technicians (H10–H12), then look at the month | That technician shows "Corrected after sending"; a new package marks their files "… CORRECTED.pdf"; the first package is unchanged |
| I13 | On the **actual rugged tablet**: I3–I4 in the tablet's browser | Record whether the previews show in the app, whether the print dialog opens, and whether the exported files save and open as one page each |

What these do NOT prove: real delivery to Finance (EJE's Microsoft 365
credentials and an approved Finance address are needed — section 4 of
`docs/delivery-register-2026-10-29.md`).

## J. The Attendance page's monthly form, and the update notice (30 October 2026)

**LIVE since 30 October 2026** in `e54f7d3` (no migration; `docs/delivery-register-2026-10-30.md`).
Fictional data only while the demonstration switcher is on.

### What the automated checks already prove (no person needed)

On the Attendance page a technician's monthly attendance form previews in the
app, Print asks the browser exactly once, Download PDF saves ONE page under the
rule's name (read back from the file), Export PDF hands that same one-page file
to the share sheet, and Send to office submits the month once — afterwards
nothing offers it and a second request is refused. The office sees the status,
opens the form, and is not offered Send for a technician (smoke). Across two
real builds served in turn on one address, an open tablet-sized page shows "A
new version of EJE is available" WITHOUT a reload or a cache clear; Update now
moves the page AND its service worker to the new build with exactly one reload,
says "EJE has been updated" once, and never shows the notice again; with typed
work on screen it asks first and Cancel keeps the typing (update-check).

### Needs a person — in this order

| # | Do this | Pass looks like |
|---|---|---|
| J1 | Technician: **Attendance** | At the top, "Monthly attendance form" with a Month field (last month) and the card "… ATTEN <MONTH>.pdf · one page" |
| J2 | **Preview**, **Print**, **Download PDF**, **Export PDF** | The form in the app; the print dialog once, showing only the form; a downloaded file with exactly that name, ONE page; Export opens the device's share sheet (on a desktop: the file downloads and the card says why) |
| J3 | **Send {month} to the office** → confirm | The card says the timesheet goes with it; afterwards "Submitted …" and no Send button. Monthly forms shows the same month as submitted |
| J4 | Master or Coordinator: **Attendance** → the month | Every technician with a status; **Open form** shows their card with Preview/Print/Download/Export and **no** Send |
| J5 | Office: correct a day of that technician's submitted month in the register, then open their form again | "corrected by the office after submission (1)" |
| J6 | On the **actual rugged tablet** (installed EJE): leave EJE open on any screen; after the next release, return to it | Within a few minutes (or on coming back to the screen) the amber bar "A new version of EJE is available" with Update now |
| J7 | Type a timesheet comment without saving, then tap **Update now** | A dialog naming the unsaved comment; Cancel keeps it |
| J8 | Save, tap **Update now** | EJE reloads once and shows "EJE has been updated. You are now on version …" (Administration → System shows the same commit); the bar does not come back |

## F. Documents

| # | Do this | Pass looks like |
|---|---|---|
| F1 | Download a signed job card PDF | Opens; shows photographs, the signature, the correct totals |
| F2 | A parts collection: complete it as a courier collection | The delivery note shows **no prices**; the waybill number is printed |

## The record

| Field | Value |
|---|---|
| Tester(s) | |
| Date | |
| Devices (model, Android/Chrome versions) | |
| Deployed commit (from `/api/health`) | |

| Check | Result | What was seen / screenshot | Notes |
|---|---|---|---|
| A1–A3 | | | |
| B1–B10 | | | |
| C1–C4 | | | |
| D1–D8 | | | |
| E1–E5 | | | |
| F1–F2 | | | |
| G1–G12 | | | |
| H0–H21 (after the release) | | | |
| I1–I13 (after the release carrying 0040) | | | |

Faults go to the owner with the check number, what was done, what was expected,
what happened, and a screenshot.

## Automated post-deployment verification — 27 October 2026, against `51fb112`

Run from outside the server against `https://eje.syncza.co.za`, signed in
only through the deployment's demonstration switcher (no password handled).
Every record created is labelled **DEPLOY-VERIFY 51fb112 27-Oct-2026**:
jobs **EJE-2047 … EJE-2053** and one attendance entry (Technician 3, 27
October). No existing job, customer, signed document or audit line was changed,
and nothing was deleted. Email is in `refuse` mode and WhatsApp has no
credentials, so no message reached anybody.

**API: 58 checks — 57 passed, 1 failed (a defect in the check itself, see below) — plus 5 informational results and a follow-up run that confirmed the photograph's measurement, the price-free exports and the notification trail.**

| Area | Verified |
|---|---|
| Deployment | commit `51fb112`, PostgreSQL reachable, HTTP → HTTPS 308, unauthenticated API read refused (401) |
| Roles | Master reads administration; Technician refused administration (403) and the office's Field Captures (403); Coordinator reads Field Captures; Technician refused another technician's timesheet (403) and the attendance register (403) |
| Job lifecycle (EJE-2047) | create and assign → accept → labour (a replay under the same key is **not** duplicated) → photograph (stored, 1 542 bytes, SHA-256 measured, reads back) → write-up → completion → Customer Signature → signed → **Office Handling** → *Mark handled* → **Awaiting PO** → empty invoice number refused → **Invoiced** |
| Issued document | the issued PDF is a PDF and embeds the photograph |
| Corrections (BD-27) | a labour correction without acknowledgement refused (422 `acknowledgement_required`); with it, raised as *required*; the Coordinator records the acknowledgement |
| Media (BD-26) | a video is filed **internal** even when the upload asks for customer-facing; it cannot be reclassified (422 `video_internal_only`) |
| Held signature (BD-23) | EJE-2048: identical document → **accepted**, job to Review. EJE-2049: the office applied the call-out fee meanwhile → **referred** (`document_changed`), job unsigned at Customer Signature, the office **cannot apply** it (400), closed with a reason |
| Refusal | EJE-2050: refusal recorded → Master notified in-app → resolved *without customer signature* → **Office Handling** (`issued_unsigned`) |
| Parts job | EJE-2051: refuses labour and travel (422). It starts at Completion, so it cannot be cancelled (only an Open job can) and stays as a labelled test record |
| Offline by job number (OFF-2) | a capture sent with the transport the tablet uses, naming the job by its number, lands on that job |
| Customers | the customer record loads with one site and its contacts |
| Attendance, timesheets, exports | attendance reads and exports; timesheets read (office and own) and export with their columns; the jobs export carries **no prices** for office or technician |
| Notifications | the technician's in-app *job assigned* notice (channels in-app + WhatsApp); the job's Activity says the WhatsApp was **queued, not sent**; the customer copy's delivery is `failed — Customer email is not configured` |

*The one failure:* the photograph check looked for a checksum in the upload's
response, which does not return one. The job view shows it measured — a defect
in the check, not the application.

**Real browser (headless Chrome): offline run 11 of 11 passed; UI run 23 of 24 passed — the one failure opened `/login`, which is not this application's sign-in address; the sign-in page at `/` was then checked and renders as described below.**

| Area | Verified |
|---|---|
| Offline job (OFF-2, EJE-2052) | the job list then the job opened online; network off; the job opens from the tablet's copy; a note is held and says it is **not on the job**; network on; it lands on the job **exactly once** |
| Held signature (OFF-SIG, EJE-2053) | at the signature step with the network off the job card itself is shown; the signature is held (*not on the job yet*); network on; the server verifies the document and accepts it; job to Review; the audit line names the document identity and the tablet's time |
| Screens | every main screen renders for the Master (8), the Coordinator (6) and a Technician (3) with no page error; a Technician's `/admin` says administration is restricted |
| Write-up | autosaves with no Save button, and the server has the text |
| Attendance | the office records an entry; a correction for the same day is accepted; a future day is refused |
| Sign-in page | renders the email and password form and *DEMO ONLY · Switch user* |

**Not verifiable automatically — needs a person and the device:** installing
the app on the tablet, the rear camera, gloved and daylight use, lock / kill /
flat battery recovery (check 20), a full shift offline, and the D section above
on the real tablet. Email and WhatsApp delivery need EJE's credentials.

## Automated post-deployment verification — 28 October 2026, against `ef0f695`

Run from outside the server against `https://eje.syncza.co.za`, signed in
only through the deployment's demonstration switcher (no password handled).
Every record created is labelled **DEPLOY-VERIFY ef0f695 28-Oct-2026**: jobs
**EJE-2055 … EJE-2061**; for Technician 3, one timesheet line and comment
(26 October), attendance for 28 October (present) and 23 October (absent); one
chat between Technicians 3 and 2; one customer request on EJE-2056 (declined);
one Field Capture (closed *No action*). The test bench fee was set to R450.00
for the run and **restored to R0.00**, its value before. No existing job,
customer, signed document or audit line was changed and nothing that existed
before was deleted (the only removal was a timesheet line the run itself had
just typed, to test *Remove*). Email is in `refuse` mode and WhatsApp has no
credentials, so no message reached anybody.

**API: 92 checks passed, 0 application failures, plus 25 informational
results.** The first pass had six failures, every one a defect in the check
(wrong expectation or wrong order of steps), each re-run corrected and passed —
listed below so nothing is hidden.

| Area | Verified |
|---|---|
| Deployment | `/api/health` reports commit `ef0f695`, PostgreSQL reachable, `email refuse`, `deployment demonstration`, `demoSwitcher true`; HTTP → HTTPS 308; an unauthenticated read is refused (401) |
| Migrations | **0034**: manual lines saved, edited, removed, read back and exported. **0035**: `testBenchFee` in settings, `testBenchApplied` on the job, `testBenchFee` frozen in the pricing snapshot. **0036**: a chat deleted for one participant stays deleted when re-read from the server. (The schema ledger itself is read only on the server; the release output records it.) |
| Permissions | Technician refused: administration, the attendance register, another technician's timesheet, the office's Field Captures list, the settings (403). Technician reads their own Field Captures and sees no one else's; Coordinator reads the office list. Neither another technician nor the Master can write a technician's timesheet (403). A technician not on a job cannot even see it (404) |
| Timesheets (TIMESHEET-2) | Past-date line with customer, NT 7.5 → edited to 8, OT 1.25, call-out 1; a second line by customer name; daily comment; remove. Refused: hours not in quarter hours, over 24 h in a day, hours without a customer, a future date. Office reads the sheet; export shows the line and **NOT RECORDED** for unrecorded days |
| Attendance (ATTEND-2) | Technician marks self Present today and Absent on an earlier day; future day refused; cannot mark another technician (403); office register shows it; CSV export |
| Multiple parts (PARTS-MULTI-1) | Three parts on one job, none lost or merged |
| Test bench fee (BENCH-1) | Master sets it; unticked on a new job; ticked beside call-out; after signature it cannot be changed; frozen at R450.00 in the signed pricing; changing the setting afterwards leaves the signed pricing identical; the issued PDF carries the *Test bench* line |
| Discount (DISCOUNT-OFF-1) | `apply_discount` and `clear_discount` do not exist on the API, even for the Master (404) |
| Media (VIDEO-OFF-1 / DOCUMENTS-1) | A photo and a PDF document stored; a video refused as video (400 *Video is not accepted*) and as a photo (400 *not a photograph*) |
| Cancel completion (COMPLETE-CANCEL-1) | From the first step and from the signature step: back to In Progress with labour, travel, parts, photo, document, note, call-out, bench fee and write-up all kept, each on the activity trail. Refused: when not completing; after the signature (`already_signed`); while a refusal waits for the office; after a refusal froze the prices (`pricing_frozen`); on a Parts job (no In Progress stage) |
| Pin location (PIN-1) | *Send Site Location* refused on a Parts job and a Test & Repair job |
| Submission and PDF | Signed → issued → **Office Handling**; the issued job card is a PDF |
| Notifications (NOTIF-AUDIT-1) | The office gets *job card submitted*; the Master's refusal notice is created and marked handled when the office returns the job; marking a notice read drops the bell count by exactly one (1 → 0) |
| Offline capture | A held capture sent by job number lands once (the resend is a replay). A late capture on a signed job is refused, referred to the office, visible to that technician only, cannot be applied to the signed job, closed *No action* with a note the technician sees; the signed job unchanged |
| Field Captures (FIELD-CAP-1) | As above, and the technician's list holds only their own referral |
| Customer requests (CUST-REQ-HELP-1) | Recorded by the technician on the job, waiting for the office, nothing on the job changed; the office declines with a reason |
| Delete chat (CHAT-DELETE-1) | Someone not in the chat cannot delete it; delete removes it from my list only; the other participant keeps it and the first message; when they write again it returns to me with only the new message |
| Historical records | Every existing job view loads; 27 signed jobs keep their signatures; job cards issued before this release (EJE-2046, 2045, 2041, 2050, closed EJE-2018) still open as PDFs; EJE-2047's video from before stays on record |

*The six check defects:* a malformed timesheet line id is refused 422 *does
not exist* — no server error, which is what AUDIT-4 fixed; the check wrongly
demanded 404. A technician not on the job got 404 rather than the 403 the
check expected; hiding the job is the stronger refusal. Two bell checks ran
after the office had already returned the refused job, which marks the
refusal notice handled; re-run on an unread *job card submitted* notice:
1 → 0. One historical PDF check picked EJE-2048, which is signed but was never
issued; re-run on issued job cards.

**Real browser (headless Chrome): 38 of 38 passed, no page errors.** Four
steps first failed — three because this PC went to sleep mid-run and the app
correctly fell back to the tablet's copy ("Could not reach the EJE server",
"as the server had it 12 hours ago" — the PC really had been asleep for 12
hours), one because the check looked on the wrong Admin tab — and passed when
re-run.

| Area | Verified |
|---|---|
| Screens | Master (8), Coordinator (5) and Technician (7) screens render with no page error |
| Technician menu | *Field Captures*, *Timesheets*, *Attendance*; Field Captures lists only my referral, with its outcome and the office's note |
| Timesheets | My typed line, *Not recorded* days, *Add line* |
| Accept (PIN-1) | Test & Repair (EJE-2061): no *Send Site Location?* prompt. Breakdown (EJE-2060): still asks; *No, Thanks* sends nothing |
| Complete job (COMPLETE-POS-1) | Exactly one *Complete job* button, below the tabs, with the summary of what is recorded; reachable at tablet width (800 × 1280) |
| Multiple parts | *Add part* → *Add another part* twice → three parts saved in one go; the next dialog starts with one empty line |
| Test bench / discount | The checkbox beside call-out, unticked; no discount control on the job |
| Media | *Add Photo* and *Add Documents*; no video button; EJE-2047 shows *Videos (historical)* |
| Cancel completion | *Complete job* → wizard → *Cancel completion* → *Back to In Progress*; the summary is unchanged |
| Offline | Network off: a note is held and says so; network on: it lands on the job exactly once |
| Delete chat | Asks for confirmation, saying it is removed from your list only and EJE keep every message (cancelled here) |
| Notifications | *Job card submitted* labelled, with the green edge |
| Admin | *Rates & VAT* shows *Test bench fee* |
| Help text | Corrections and *What the customer has asked for* show their explanations |

**Not verified here, and why:**

- `npm run smoke` / `npm run e2e` were **not** run against the live site:
  both begin by resetting the demonstration data (`/api/demo/reset`). On this
  server that must not happen. Both passed in CI on `ef0f695` against a
  throw-away server.
- *Discount (historical)*: no job on the live site has ever carried a
  discount, so the historical display cannot be seen here; the unit tests
  cover it.
- Needs a person and the real tablet: installing the app, the camera, gloved
  and daylight use, lock / kill / flat battery recovery, a full shift
  offline, and section G on the device. Email and WhatsApp delivery need
  EJE's credentials.

**Minor defect found (not blocking):** a timesheet line for a future date is
refused with the attendance wording, *"Attendance cannot be recorded for a day
that has not happened."* The refusal is right; the sentence should say
timesheet. Not fixed in this release, to avoid a redeploy for wording.

## Automated post-deployment verification — 29 October 2026, against `1a34d1c`

Run from outside the server against `https://eje.syncza.co.za`, signed in only
through the demonstration switcher (no password handled). **Read-only, as the
owner asked: no job, timesheet line, period, correction, attendance record or
setting was created or changed.** The only writes sent were requests that had
to be refused — and were — plus sign-in sessions and the audited "document
opened" line each job-card read records. Email is `refuse`, WhatsApp
unconfigured; nothing reached anybody.

**API and screens: 43 passed, 0 failed** (two checks first failed because the
check sent the wrong query parameters to the attendance endpoints — `?date=`
and `?from=&to=` were needed — and passed when sent correctly).

| Area | Verified |
|---|---|
| Deployment | `/api/health`: commit `1a34d1c`, status ok, PostgreSQL reachable, `email refuse`, `deployment demonstration`, `demoSwitcher true` (unchanged); HTTP → HTTPS 308; unauthenticated read 401 |
| Screens | Master: dashboard, jobs, timesheets, attendance, notifications, calendar, admin, Field Captures; Technician: dashboard, jobs, timesheets, attendance, messages — all 200 |
| 0037 | Attendance register and a technician's own attendance load; **Absent without a reason is refused** (422 `absence_reason_required`, nothing recorded); the absent day recorded before the release (23 Oct) keeps **no invented reason** |
| 0038 | A technician's timesheet loads with the From/To period model; the period document and the Time Sheet PDF load; the CSV has D/T, Int Km, Cust Km and *Sent version*, no Hm |
| 0039 | The office's (Master's and Coordinator's) pending-corrections list reads `timesheet_corrections` (empty) |
| Permissions (refused, nothing written) | A technician cannot read another's timesheet (403), decide a correction (403), or ask to correct another's (403); the office cannot ask on a technician's behalf (403) or send a technician's timesheet (403); deciding a correction that does not exist → 422 `correction_not_found`; a period over 92 days / ending in the future → 422; a technician is refused administration |
| Historical records | Every job view loads (58); **the same 58 open-list jobs, 10 closed, 33 signed and 20 issued as just before the release**; the same 3 technicians; **issued job cards EJE-2050, EJE-2046, EJE-2041 and EJE-2001 are byte-identical** (SHA-256 taken while `ef0f695` was serving, compared after the switch) |

**Browser on an emulated rugged tablet (no PDF viewer), live: 6 of 6 passed.**
The technician's Time Sheet preview shows IN the app with exactly Date,
Customer, OT, D/T, Callout, Int Km, Cust Km; Print asks the browser to print
once; the office Timesheets screen renders; no page errors; no write request
from looking; nothing downloaded by itself. (EJE-2050's screen offered this
role no job-card preview button — recorded, not counted.)

**Not verified live, by design:** the correction workflow, Send to office and a
courier collection were NOT exercised on production (the owner asked for no
test records there); each is proved by CI and the local browser suites above,
and is staff checks H7–H17. The physical tablet, its print dialog and a printer
are H18–H20.

## Automated post-deployment verification — 29 October 2026, against `a46e767`

Run from outside the server against `https://eje.syncza.co.za`, signed in only
through the demonstration switcher. **Read-only: no submission, package,
attendance, timesheet or setting was created.** The only writes sent had to be
refused — and were. Email `refuse`; nothing reached anybody.

**API and screens: 36 passed, 0 failed.**

| Area | Verified |
|---|---|
| Deployment | `/api/health`: commit `a46e767`, ok, PostgreSQL reachable, `email refuse`, `deployment demonstration`, `demoSwitcher true` (unchanged); unauthenticated read 401 |
| Screens | Master: dashboard, Monthly forms, timesheets, attendance, admin, jobs; Technician: dashboard, Monthly forms, timesheets, attendance — all 200 |
| 0040 | The office month view reads `monthly_submissions` and `finance_packages` (3 technicians, 0 packages); production email reported NOT ready ("Microsoft 365 credentials are not set") and no Finance recipient set — nothing can be sent |
| PDFs | A technician's monthly forms load; the timesheet and attendance PDFs download under **`PETER TIMESHEET SEP.pdf`** and **`PETER ATTEN SEPTEMBER.pdf`** and are **exactly one page each**, counted in the downloaded files; the office downloads a technician's attendance PDF |
| Permissions (refused, nothing written) | Another technician cannot read the forms or download the PDFs (403); a technician cannot see the office month or prepare a package (403); the office cannot submit a technician's month (403); a month not yet ended → 422 `month_not_ended`; preparing with no recipient → 422 `finance_recipient_missing` |
| Historical records | Every job view loads; **the same 58 open-list, 10 closed, 33 signed and 20 issued jobs as just before the release**; issued job cards EJE-2050, EJE-2046, EJE-2041 and EJE-2001 **byte-identical** (SHA-256 taken while `1a34d1c` was serving) |
| Visual | The live `/icons/icon-192.png` is byte-identical to the generated EJE mark; the live favicon is the same mark |

**Emulated rugged tablet (no PDF viewer), live: 8 of 8 passed.** The Time
Sheet preview in the app with exactly the seven columns; Print asked once; the
monthly attendance and timesheet forms shown IN the app; no page errors; no
write request from looking; nothing downloaded by itself.

**Not verified live, by design:** submitting a month and preparing or sending a
Finance package were NOT done on production (no test records there; email is
not configured). They are proved by CI and the local browser suites, and are
staff checks I1–I13. The physical tablet, its print dialog and a printer
remain staff checks (H18–H20, I13).

## K. The tester's changes and the timesheet freeze (30 October 2026, evening)

**LIVE since 30 October 2026** in `42cd3d3` (no migration; `docs/delivery-register-2026-10-30.md`, second part).
Fictional data only while the demonstration switcher is on.

| # | Do this | Pass looks like |
|---|---|---|
| K1 | Technician: Timesheets → Add line on a day → in **Date** press Backspace, then retype a day of the period; fill Customer, OT, D/T, Callout, Int Km, Cust Km, Shared; change OT again; Save line | The form never disappears or stops responding; while the date is incomplete it says so and Save line is disabled; the line saves on its date; Edit shows exactly what was typed |
| K2 | Technician: Jobs | No New Job, no Download CSV; My Jobs, In progress, Awaiting completion; no Open work |
| K3 | Coordinator: the sidebar | My Monthly Forms, EJE Monthly Forms, Users; no Timesheets, no Closed Jobs. Jobs → Closed Jobs still opens the archive |
| K4 | Coordinator: Users → a person → Availability | Who is away today and what is booked; Mark unavailable works; no account, role or password controls anywhere |
| K5 | Coordinator and Master: Attendance | Their own monthly form and days at the top, the team register below |
| K6 | Any role: My Monthly Forms → submit last month | Submitted once; it appears in History; EJE Monthly Forms shows them as submitted |
| K7 | Master: EJE Monthly Forms | Every user (Masters, Coordinators, Technicians) with role and status, and "N submitted / M not submitted" |
| K8 | Technician on the tablet: Messages → write → Send; the office replies | Send is visible without hunting; both messages stay in the conversation |
| K9 | On the **actual rugged tablet**: K1 and K8 | Record the result |

## L. The tablet audit — on the actual rugged tablet (31 October 2026)

**LIVE since 31 October 2026** in `316544f` (no migration).
`docs/delivery-register-2026-10-31.md`. Everything in it was measured on an
**emulated** tablet; these are the checks only the real device can answer.
Fictional data only while the demonstration switcher is on.

| # | Do this | Pass looks like |
|---|---|---|
| L1 | Each role, landscape then portrait: open every item in the menu, and every tab on a job card, a customer, Administration and Notifications | Nothing is cut off, nothing scrolls sideways, every button the desktop has is there; tables show every column's information (below the first column in portrait) |
| L2 | Technician: accept a job, complete it, capture the signature, submit — on the tablet only | Every step can be done without a desktop |
| L3 | With a gloved finger: the top bar (menu, theme, notifications), the Jobs filter chips, the calendar's Day/Week/Month/Year, a calendar day, a dialog's buttons | Each is hit first time; no mis-taps on neighbours; all text readable without zooming |
| L4 | Type in a dialog near the bottom of the screen (Mark unavailable, a timesheet line, a message) with the on-screen keyboard up | The field being typed in and the dialog's Save/Cancel stay above the keyboard |
| L5 | Print a job card and a monthly form from the preview to a real printer | The printout is the document only, complete, nothing cut at the edges |
| L6 | Install the app from Chrome, open it from the home screen, turn it, put it in the background and come back, turn Wi-Fi off and on | It opens on EJE, survives each, and the connection banner says what is true |

## M. The tester's critical fixes — on a real tablet and a real phone (31 October 2026)

**LIVE since 31 October 2026** in `c68b3c3` (migration 0041). `docs/delivery-register-2026-10-31-critical.md`. Tested in
desktop Chrome and in Chrome emulating a touch tablet and a phone at eleven
sizes; these are the checks only real devices and a real printer can answer.
Fictional data only while the demonstration switcher is on.

| # | Do this | Pass looks like |
|---|---|---|
| M1 | On the Android tablet AND an Android phone: open each preview — a job card, a delivery note, the time sheet, the monthly timesheet and attendance, a final job card, a correction, a library manual — page through it, zoom in and out, pinch, turn the device, close and reopen | The PDF itself is shown every time (not a "couldn't display" block), every page, readable when zoomed, nothing cut at the edges, Close always reachable |
| M2 | Print each of those from the preview to a real printer, from the tablet and from a desktop | The printout is the PDF only, complete, page for page, nothing cut |
| M3 | Technician, on the tablet with the on-screen keyboard: fill in a timesheet line for every day of a month, correct one, reopen the page | Typing never lags or freezes; every line is there after reopening |
| M4 | Mark attendance for a month on the tablet, with Wi-Fi switched off halfway and on again, and the app put in the background once | The status says what is true (kept offline, then saved); every day is saved afterwards |
| M5 | As a Master and as a Coordinator: My Monthly Forms → Edit my timesheet; then EJE Monthly Forms → View forms for a technician | Your own timesheet opens for editing; a technician's forms open read-only, with no Edit or Submit |

## N. WhatsApp, Google Maps and email — with the REAL accounts (1 November 2026)

**NOT YET POSSIBLE**: these need the Microsoft 365, Meta and Google setup in
`docs/integrations-setup.md`. Until then each integration says "Not configured"
in Administration → Integrations, signed job cards are stored with their email
queued (not sent), and nothing reaches a customer or a technician's phone.
Use ONLY internal recipients (EMAIL_TEST_RECIPIENTS, WHATSAPP_TEST_RECIPIENTS,
an EJE mailbox as a test contact). Never a real customer's job.

| # | Do this | Pass looks like |
|---|---|---|
| N1 | Administration → Integrations → Email → Send test email | It arrives from sales@ejeie.co.za; it is in sales@'s Sent Items; the card says Connected |
| N2 | A test job whose contact is an EJE mailbox: complete it and have it signed on the tablet | The customer email arrives by itself within a minute, from sales@, with the template's words and ONLY the signed job card PDF (open it: it is the signed one); the job's email history says Sent, with the template version |
| N3 | Edit the Breakdown template, sign a second test job | The new wording arrives; the first job's history still shows the old wording |
| N4 | Administration → Integrations → WhatsApp — dedicated EJE number. Before the test it says **Not configured** (credentials set, no real test yet). Send test message (only after Meta approves the templates) | The message arrives on the test phone **from the dedicated number**; the status becomes Connected; Delivered, then Read |
| N5 | Assign a test job to a technician with a test phone; transfer it to another; return one to Open Jobs | The assigned, then the receiving, technician gets a message; Open Jobs sends nothing |
| N6 | Accept a test job on the tablet → Send Location | The site location arrives on the technician's phone; the Google Maps link opens on the site's pin |
| N7 | Create a test customer with a real address; then change the address | A pin is found within a minute and shown on the customer's card with the date Google's coordinates will be refreshed or deleted; after the change it is looked up again; a pin you marked correct is kept, marked Re-check, and a suggestion is offered |
| N8 | **The office WhatsApp number** (decision recorded: a dedicated EJE number is used) | The office's WhatsApp Business app keeps working on the office phones throughout, with its chats and linked devices |
| N9 | On the test customer's location card, Edit location → **Use this device's location**, standing at the site | The coordinates fill in; saved, the card says "Entered by the office: kept" |
## O. Attendance and timesheets — the tester's changes (1 November 2026)

Automated on desktop (1440), tablet (768) and phone (390) — `scripts/forms-regression.mjs`, `scripts/smoke.mjs`. These are the checks a person makes on the real devices.

| # | Do this | Pass looks like |
|---|---|---|
| O1 | As a **Coordinator**, look at the menu; open My Monthly Forms | No Timesheets item; the month shows the attendance form only — no timesheet, no "Edit my timesheet"; Send to office sends the attendance alone |
| O2 | As a **Coordinator**, open the Attendance page | Your own monthly form and your own days only; no Team register; Present/Absent save by themselves |
| O3 | As a **Master**, open the Attendance page | The same page as everybody: your own form and days; no Team register, no other person listed |
| O4 | As a **Master** or **Coordinator**, open EJE Monthly Forms, choose last month, **View forms** for a technician | Their attendance (and timesheet) open read only — Preview, Print, Download — with no Send, no edit; "Everybody's attendance as a spreadsheet" is under the list |
| O5 | As a **Technician**, open Timesheets | No Export CSV button; Preview, Print and the PDF are there |
| O6 | Record only three days of a month, then Preview the monthly attendance and timesheet PDFs | Only the recorded days appear, in order; no blank rows, no "NOT RECORDED"; the totals add up the lines shown; the note says only recorded days are listed |
## P. Job creation, the test bench quantity and the job card — the tester's changes (2 November 2026)

Automated on desktop (1440), tablet (768) and phone (390) — `scripts/forms-regression.mjs`; the PDF placement and the bench-fee arithmetic in the unit suite. These are the checks a person makes on the real tablet and phone, on a TEST job only.

| # | Do this | Pass looks like |
|---|---|---|
| P1 | Create New Job → Installation → leave **Machine (optional)** empty → Create job | The job is created with no machine; the job card prints no machine block |
| P2 | The same for a **Service** job; then create another Service choosing a registered machine | Both are created; the second carries its machine as before |
| P3 | On a Test & Repair job in progress, tick **Charge the test bench fee** | *Quantity* appears set to **1**; the line reads 1 × the bench rate |
| P4 | Change Quantity to **3** and tap away | The line reads 3 × rate = amount; the job's Subtotal, VAT and Total rise by exactly 2 × rate (incl. VAT); try 0 or 100 — refused with "Enter a whole number from 1 to 99" |
| P5 | Preview the job card PDF of that job (with two or more parts booked in) | Under **Labour, travel and parts**: the parts received (Part 1 received, Part 2 received …), the Collection line, then the price table with *Test bench fee — Qty 3 — Rate — Amount*. **Job details** no longer lists the parts received or the collection |
| P6 | Open an already-signed job card that carried the bench fee | Its amounts are exactly as before — nothing repriced |

## Q. The standby calendar (2 November 2026)

Automated at desktop (1440), tablet (768, touch) and phone (390, touch) — `scripts/standby-check.mjs`, in CI. These are the checks a person makes on the real rugged tablet and phone. Use a year with no real schedule yet, and put the places back afterwards.

| # | Do this | Pass looks like |
|---|---|---|
| Q1 | As the Coordinator: Standby Calendar → Manage schedule → tick who may be Main, Helper and Apprentice | Each tick saves; ticking Apprentice clears Main and Helper; an inactive person cannot be ticked |
| Q2 | Enter an order for each place, then **Generate** the year | The year's remaining weeks appear as **Draft**; each place follows the order; nothing published changed |
| Q3 | As a technician, open the Standby Calendar | No draft is visible and there is no Manage schedule tab |
| Q4 | As the Coordinator: **Publish** — leave one place empty first | Publishing asks you to acknowledge the empty place; afterwards the technician sees the weeks and *Your upcoming standby* |
| Q5 | Month view, Week view, the year and month arrows, with gloves, in daylight | Every week shows Main, Helper, Apprentice 1, Apprentice 2; nothing scrolls sideways; buttons are easy to hit |
| Q6 | As a main technician: open your week → **Request a swap** → choose the other technician and their week → Send | *Swap pending* appears on both weeks; the names have NOT changed |
| Q7 | As the Coordinator: Swap requests → **Approve** with a note | Only the two main places changed; helpers and apprentices did not; both technicians have a notification |
| Q8 | As an apprentice: ask for an apprentice swap; as a Master, **Reject** it with a note; then change a published place (reason required) | The calendar is unchanged after the rejection; the apprentice is notified; the changed place notifies both people and shows in Activity |

## R. The tester’s critical fixes (2 November 2026, evening)

Automated at 1440, 768 (touch) and 390 (touch) — `scripts/tester-fixes-check.mjs`, in CI. These are the checks a person makes on the real rugged tablet and phone, on TEST data.

| # | Do this | Pass looks like |
|---|---|---|
| R1 | On the PHONE: complete a job to the signature step; sign with a finger, several lines, filling the box | The whole signature shows on the pad, then on the job card and the PDF — not a thin line |
| R2 | On the phone: the Job Complete steps at the top | Every step can be reached by scrolling the step bar; a done step taps back to it; the page does not scroll sideways |
| R3 | On the tablet and on a desktop: sign as before | Exactly as before — nothing changed |
| R4 | A Test & Repair job: Complete job → in the Parts step add two parts, remove one | The list updates; reload — it is kept; the PDF lists the final parts; at the signature they can no longer change |
| R5 | Preview that Test & Repair job card PDF | **Parts received** is its own section directly under **Reported fault** |
| R6 | Attendance: choose a From in last month and a To today; leave the page and return | Both months listed oldest first; the same From/To are back; Download PDF is named "… Atten Oct-Nov.pdf" and has no Notes column |
| R7 | My Monthly Forms: submit last month; change a day; submit again | It submits again; the office sees the new version only |
| R8 | Timesheets (Master): no Whose timesheet; send a period; change a line; Send again | Sent again; the office reads the latest; a two-month PDF is named "… Timesheet, Oct + Nov 2026.pdf" |
| R9 | Office: a submitted job → Mark handled → try to save without a PO → save a PO → save the invoice number | Refused without a PO; then Awaiting Invoice No; then Invoiced, in the Invoiced tab with PO and invoice number |
| R10 | Notifications: Jobcards, Messages, Forms | Each shows only its own; unread counts right; Monthly Forms has no Export CSV |

## S. The next critical batch (2 November 2026, night)

Automated at 1440, 768 (touch) and 390 (touch) — `scripts/batch-check.mjs` and `scripts/standby-check.mjs`, in CI. On the real tablet and phone, on TEST data:

| # | Do this | Pass looks like |
|---|---|---|
| S1 | A job in progress → Photos → Add Documents: a PDF, a ZIP and a Word file | All three listed; each opens/downloads |
| S2 | Tick "Send to the customer with the signed job card" on two documents; finish the job with a TEST contact address | The email (once email is configured) carries the signed PDF and both documents |
| S3 | The final signed job card of that job | **Download Attachments** beside the two PDF buttons; the ZIP holds the original files; a job with no documents shows no such button |
| S4 | Overview, every role | "Standby this week" with the four places, or "No standby schedule has been published" |
| S5 | As a technician, on your own accepted job: Cancel job | The button waits for a written reason; the job shows Cancelled with the reason; not offered once the customer signature is reached |
| S6 | Two technicians: A asks B to swap one Saturday each (Standby → Request a swap) | B is notified; B approves; the Office is notified; nothing changes until the Office approves; then only those two days change |
| S7 | Administration → Users | Roles read Senior Tech, Office, Technician; Add user offers Apprentice; an apprentice signs in and sees what a technician sees |
| S8 | Add customer → Rates: Custom Rates; open the customer | A Custom Rates tab beside Notes & Documents; a job for it says the rates are missing until saved, then prices at them |
| S9 | Attendance | From/To top-right, Preview and Print only, no Submit, no timesheet controls; nothing waits for the month to end |
| S10 | Timesheets | Preview and Print only; a 24 Oct – 22 Nov period prints as "… Timesheet Nov 2026.pdf" |
| S11 | My Monthly Forms | Download, Preview, Print and Submit for both forms; this month can be submitted |
| S12 | Notifications | Jobcards, Messages, Monthly Forms, Standby; Invoiced shows "Purchase Order:…" in blue |
| S13 | As the Senior Tech, on a job card issued WITHOUT a signature: Photos → tick "Send to the customer with the unsigned job card" on a document; then *Authorise sending it to the customer* with a TEST contact address | The panel lists the PDF and the document; the email (once email is configured) carries both. A document over the limit is refused with the reason and nothing is sent |

### S1–S13 — what is proven, and what still needs the device (review of 3 November 2026)

**Nothing in this table was done on a phone or a rugged tablet.** "Browser" means a desktop browser driving the screen at 1440×900, and at 768×1024 and 390×844 with touch emulation (Playwright, in CI and on the development PC). Emulation is not acceptance: every check below still needs the real device, and none is marked physically passed.

| # | What it tests | Automated (unit / API / database) | Browser at desktop, tablet, phone | Physical device |
|---|---|---|---|---|
| S1 | PDF, ZIP and Word documents attached to a job | `batch-2-november.test.ts` (types sniffed from the bytes; fake ZIP refused) | `batch-check.mjs` (ZIP uploaded by the screen) ×3; `workflow-e2e.mjs` | NOT TESTED — the tablet's file picker and camera roll |
| S2 | Chosen documents travel in the signed email | `batch-2-november.test.ts` (outbox carries both files; size limit; missing file) | `batch-check.mjs` (document chosen) ×3 | NOT TESTED — needs email configured; demonstration mode keeps it off |
| S3 | Download Attachments ZIP beside the PDF buttons | `zip.test.ts`, `batch-2-november.test.ts` | `workflow-e2e.mjs` | NOT TESTED — opening the ZIP on the device |
| S4 | Overview standby block | `standby-days.test.ts` | `batch-check.mjs` ×3; `acceptance-check.mjs` (directly below the greeting) ×3 | NOT TESTED |
| S5 | A technician cancels their own job, with a reason | `batch-2-november.test.ts` (every role and stage) | `batch-check.mjs` ×3 | NOT TESTED |
| S6 | Two technicians swap Saturdays; two approvals | `standby-days.test.ts` (incl. the main/helper rotation, STANDBY-DAY-2) | `standby-check.mjs` ×3; `acceptance-check.mjs` (several pairs, the live rotation) ×3 | NOT TESTED |
| S7 | Role names; Add user offers Apprentice | `batch-2-november.test.ts`, `access.test.ts` | `batch-check.mjs` ×3 | NOT TESTED |
| S8 | Custom Rates tab; missing rates flagged | `batch-2-november.test.ts` | `batch-check.mjs` ×3 | NOT TESTED |
| S9 | Attendance: From/To, Preview and Print only | `payroll.test.ts` | `batch-check.mjs`, `forms-regression.mjs` ×3 | NOT TESTED — printing from the device |
| S10 | Timesheets: Preview and Print; To-month file name | `payroll.test.ts` | `batch-check.mjs`, `tablet-pdf-check.mjs` | NOT TESTED — printing from the device |
| S11 | Monthly Forms: Download, Preview, Print, Submit | `payroll.test.ts` | `batch-check.mjs`, `forms-regression.mjs` ×3 | NOT TESTED |
| S12 | Notification tabs; "Purchase Order:" label | `tester-fixes-2-november.test.ts` | `batch-check.mjs` ×3; `tester-fixes-check.mjs` (now in Closed Jobs) ×3 | NOT TESTED |
| S13 | Unsigned job card carries chosen documents | `unsigned-attachments.test.ts` (9) | — (the panel is covered by the responsive audit only) | NOT TESTED |

## T. Physical acceptance follow-up (3 November 2026)

Automated at 1440, 768 (touch) and 390 (touch) — `scripts/acceptance-check.mjs`, in CI and run on the development PC (13/13 at each size before release). On the real tablet and phone, on TEST data:

| # | Do this | Pass looks like | Automated | Browser ×3 | Physical |
|---|---|---|---|---|---|
| T1 | Timesheets → Add line | No "Shared call-out" tick; the text says the call-out is YOUR share and nothing is divided | `reviewer-feedback.test.ts` | yes | NOT TESTED |
| T2 | Send a timesheet period, then send a period that overlaps it (and the same period again) | Both are sent; the earlier one is replaced for the office; your daily lines are unchanged and still editable; the PDF is named for the To month | `reviewer-feedback.test.ts`, `payroll.test.ts`, `timesheet-corrections.test.ts`, database test | yes | NOT TESTED |
| T3 | Two main technicians who rotate Main and Helper: one asks the other for several pairs of days | The request is sent (no "That swap cannot be asked for."); after both approvals, on each chosen day the two trade Main and Helper; nothing else moves | `standby-days.test.ts` | yes | NOT TESTED |
| T4 | Standby → Manage schedule → Who may stand by | The Senior Tech is listed with Main and Helper only; ticking Main saves | `standby.test.ts` | yes | NOT TESTED |
| T5 | Office: open a published week and change a place | No reason is asked; *Save change*; everyone affected is told | `standby.test.ts` | yes | NOT TESTED |
| T6 | Open Overview | The standby block is the first thing below the greeting: this week's four places, next week, your upcoming standby; not on the Standby page any more | `standby-days.test.ts` | yes | NOT TESTED |
| T7 | Office: Jobs → New job → Delivery Note; choose the customer and delivery date | Raised straight into completion; no technician is asked for; it is not in any technician's queue | `delivery-note-job.test.ts` | yes | NOT TESTED |
| T8 | Add parts: two lines, each with a comment (Loan unit, Part returned); remove one, add it back | No price field and no total; the lines and comments are listed | `delivery-note-job.test.ts` | yes | NOT TESTED |
| T9 | Collection: Courier with no waybill, then with one; on another note, Customer collection | Courier without a waybill is refused; customer collection needs none | `delivery-note-job.test.ts` | yes (API) | NOT TESTED |
| T10 | Take the signature with a finger and with the stylus; *Issue Delivery Note* | The pad keeps its proportions and the page does not scroll while signing; the job shows **Delivery Note**; the PDF prints the company, delivery date, part numbers, descriptions, quantities, comments, collection method, waybill, signature and job number, and no price | `delivery-note-job.test.ts` (document text) | issue by the screen; signature through the API | NOT TESTED — **the signature itself has only been taken through the API** |
| T11 | Try to add or change a part on the issued Delivery Note | Refused: it is final | `delivery-note-job.test.ts`, database test | yes | NOT TESTED |
| T12 | Closed Jobs → Status: Delivery Note, then Invoiced | The Delivery Note is listed as Delivery Note, never as Invoiced; no amount anywhere | `office-lifecycle.test.ts` | yes | NOT TESTED |
| T13 | Office: take a job through Handled → Awaiting PO → Awaiting Invoice No → Invoiced | It leaves the Notifications queues (there is no Invoiced tab) and appears in Closed Jobs with "Purchase Order:…", its invoice number, signed PDF and attachments | `office-lifecycle.test.ts`, `office-lifecycle-api.test.ts` | `tester-fixes-check.mjs`, `workflow-e2e.mjs` | NOT TESTED |

## U. Test & Repair delivery-note photo, and the simpler Delivery Note (3 November 2026)

Automated at 1440, 768 (touch) and 390 (touch) — `scripts/acceptance-check.mjs` (17/17 at each size on the development PC before release; in CI). **The camera has not been opened on a real phone or tablet**: in the browser check, *Take Photo* is checked for asking for the camera (`capture="environment"`) and the photo is supplied as a file.

| # | Do this | Pass looks like | Automated | Browser ×3 | Physical |
|---|---|---|---|---|---|
| U1 | Office, on a **phone**: New job → Test & Repair → **Take Photo** of a delivery note | The rear camera opens; the photo appears in the list with a preview; *Remove* takes it off | `tr-photo-delivery-note.test.ts` | file supplied; camera request checked | NOT TESTED — **the camera** |
| U2 | On the **rugged tablet**: the same with Take Photo, then **Choose Photo** from the gallery | Both work; a PDF or other non-photo is refused with a message | API test (bytes sniffed, size limit) | yes | NOT TESTED |
| U3 | Create the job and reopen it | "Delivery note photo (internal reference)" is the first block on the job; the photo opens | yes | yes | NOT TESTED |
| U4 | As the assigned technician, open the job (before and after accepting) | The same block and photo are there | yes | yes | NOT TESTED |
| U5 | Edit the job's details; complete, sign and issue the job card | The photo is still on the job; it is **not** on the job card PDF; the Photos tab shows it as "Delivery note — internal reference" with no *Show to customer* | yes (model and document), database check | yes | NOT TESTED |
| U6 | New job → Delivery Note | Site shows "No site" and is optional; no Customer order number or Reference number; the job is raised without a site and its PDF has no site line | yes | yes | NOT TESTED |
| U7 | A Delivery Note with a site chosen | The site is kept | yes | — | NOT TESTED |
| U8 | Complete a Delivery Note | No Additional Charges section; parts, collection, signature and issue as before | yes (a charge is refused by the server and the database) | yes | NOT TESTED |

## V. Timesheets as a piece of paper (4 November 2026)

**The printable sheet for doing these on real devices — phone, rugged tablet, office desktop and printer — is `docs/timesheets-physical-test-sheet.md`.** It was rewritten for the payroll completion (v1.5.2, 5 November 2026): only the checks a person on a real device can judge remain on it; everything else in V1–V13 and O1–O6 is automated at three screen sizes in CI. None of those rows has been done on a real device yet.

Automated at 1440, 768 (touch) and 390 (touch) — `scripts/payroll-forms-check.mjs (since PAYROLL-ONE-1; it replaced timesheets-paper-check)` (9/9 at each size on the development PC before release; in CI) — and the owner's twenty scenarios in `src/application/timesheets-paper.test.ts`.

| # | Do this | Pass looks like | Automated | Browser ×3 | Physical |
|---|---|---|---|---|---|
| V1 | As a technician on a **phone**: Add line for today with a customer, OT and Cust Km; save; close the app; reopen | The line is on the sheet, every field shown, nothing off-screen | yes | yes | NOT TESTED |
| V2 | Add two more lines on the same day — another customer, then Workshop with no customer | All three on the day; Workshop needs no customer | yes | yes | NOT TESTED |
| V3 | Add a line dated last month and one next week | Both saved; the earlier one says it is outside the dates | yes | yes | NOT TESTED |
| V4 | On the **tablet**: Edit a line, Remove a line | The change shows at once | yes | yes | NOT TESTED |
| V5 | Write the comment; Save comment; Submit on payday: check From and To, Preview, Submit timesheet | The confirmation names the next sheet's first day; the comment is cleared; the submission is listed | yes | yes | NOT TESTED |
| V6 | Try to submit the same dates again | Refused: ask for a correction | yes | yes | NOT TESTED |
| V7 | Office, on a desktop: Timesheets → Submitted timesheets — every technician | The submission is listed; View, PDF and Export CSV work | yes | yes | NOT TESTED |
| V8 | Corrections on a submission: the technician asks, the office accepts | The corrected version is in force; the original is still viewable | yes (service and HTTP) | — | NOT TESTED |
| V9 | My Monthly Forms for the month | Attendance only, with the note that the timesheet goes from the Timesheets page by payday | yes | yes | NOT TESTED |
| V10 | Choose dates covering only part of a submitted timesheet | Said in red, naming it; Submit is not offered | yes | yes (acceptance-check) | NOT TESTED |
| V11 | Choose dates covering all of it; Submit | The dialog says it REPLACES it; *Replace and submit*; the old one is listed as replaced | yes | yes (acceptance-check) | NOT TESTED |
| V12 | On a submission: View original; on a corrected one also View corrected version | Each opens and is labelled | yes | yes | NOT TESTED |
| V13 | Print a long timesheet (over ~190 lines) on the office printer | Every page has the headings and Page X of Y; the totals are on the last page | yes (text and totals) | yes (preview) | NOT TESTED — **the printer** |

## Physical-device acceptance still outstanding (all of it, in one place)

Nothing in this list can be done by automation; each stays open until a person has done it on the real device.

| Area | Checks | Issue |
|---|---|---|
| Install, update, camera, print, share on the rugged tablet | H, I, J1–J8 | #16 MANDATE-2 |
| A full job captured with the network off; offline signature | the offline checks, 23a | #15 MANDATE-1, OFF-SIG |
| Gloved use in daylight, every screen on the tablet | L | #17 UX-1 |
| The tester's critical fixes on tablet and phone | M | — |
| Real accounts: Microsoft 365, WhatsApp, Google Maps | N1–N9 | #79, #80, #81 |
| Attendance and timesheets | O1–O6 | #82 |
| Job creation, bench quantity, job card | P1–P6 | #95 |
| The standby calendar | Q1–Q8 | #96 |
| The tester’s critical fixes | R1–R10 | #97–#108 |
| The next critical batch | S1–S13 | #109–#120 |
| Timesheets as a piece of paper | V1–V9 | TS-PAPER |
| The physical acceptance follow-up | T1–T13 | #121–#127 |
| Test & Repair photo; simpler Delivery Note | U1–U8 | #128, #129 |

## Automated post-deployment verification — 30 October 2026, against `e54f7d3`

Run from outside the server against `https://eje.syncza.co.za`, signed in only
through the demonstration switcher. **Read-only: no submission, package,
attendance, timesheet or setting was created; Send to office was NOT pressed.**
Email `refuse`.

**API and screens: 36 passed, 0 failed** — health `e54f7d3`, ok, PostgreSQL
reachable, `email refuse`, demonstration with switcher (unchanged); every
screen renders for Master and Technician; the payroll month view; both monthly
PDFs download under `PETER TIMESHEET SEP.pdf` / `PETER ATTEN SEPTEMBER.pdf`,
**one page each** (counted in the files); every bypass refused (403/422);
**the same 62 open-list, 15 closed, 37 signed and 25 issued jobs as just before
the release**, and issued job cards EJE-2050, EJE-2046, EJE-2041, EJE-2001
**byte-identical**.

**Attendance page, emulated rugged tablet (no PDF viewer): 17 passed, 0
failed.** Technician: the monthly attendance form (`PETER ATTEN
SEPTEMBER.pdf`) with Preview (the form in the app), Print (asked exactly once),
Download PDF (ONE page, the rule's name, 8 864 bytes), Export PDF (the same
one-page file to the share sheet), and "Send September 2026 to the office"
offered (not pressed). Master and Coordinator: all three technicians' status
(David Ready, Mike Ready, Peter Not submitted), Open form with
Preview/Print/Download/Export and **no** Send. No page errors; nothing written
but sign-ins.

**Update mechanism, live: 8 passed, 0 failed.** The page is `e54f7d3` and the
worker in control is registered as `/eje-sw.js?build=e54f7d3`; with the server
agreeing, no notice. When `/api/health` reports another build (simulated in
that browser only), the deployed code shows "A new version of EJE is
available" with Update now, naming both versions, without reloading; Not now
hides it. Update now activating a real new release is proved across two real
builds (CI and this PC, 6 of 6); on production it will first be seen at the
NEXT release. Tablets still open on `a46e767` get that release's older bar
when their browser re-checks the worker (next page load, or within about 24 h).
