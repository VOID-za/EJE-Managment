# Staff testing — the deployed EJE system

*Written 27 October 2026 for the release from `claude/office-workflow-parts`.*

> **DEPLOYED AND VERIFIED — 27 October 2026.** `https://eje.syncza.co.za`
> runs commit **`51fb112`** (`/api/health`: `status ok`, `backend postgres`,
> `database reachable`, `email refuse`, `deployment demonstration`,
> `demoSwitcher true`). Migrations `0032` and `0033` were applied by the
> release; the previous release `e85f239` is retained for rollback. The
> automated post-deployment verification results are at the end of this file.

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
| B5 | *Complete job* → through the steps → Review | The review lists what was captured |
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
| D8 | Try to record a video offline | Refused, with the reason |

## E. Office records

| # | Do this | Pass looks like |
|---|---|---|
| E1 | Customers: open a customer | One site with address and a Google Maps link; contacts listed; a legacy multi-site customer can be consolidated with a preview |
| E2 | Attendance: mark present/absent for today; change one | Saved once per person per day; the change is on the audit trail; future days refused; export CSV |
| E3 | Timesheets: open a technician's sheet for this week | Hours by day and customer from their labour; call-out once per job, on their first day on it; add a daily comment; export CSV |
| E4 | Field Captures (office) | Lists work a tablet could not apply, with the reason; *Apply* works for labour, not for a held signature |
| E5 | Closed Jobs, search and exports | Results load; an export is recorded on the audit trail |

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
