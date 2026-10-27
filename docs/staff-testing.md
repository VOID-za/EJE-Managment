# Staff testing — the deployed EJE system

*Written 27 October 2026 for the release from `claude/office-workflow-parts`.*

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
   (Chrome). Sign in with the account you were given — or, on this
   demonstration deployment, the role buttons on the sign-in page.
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
| B1 | Master: create a breakdown job for a customer, assign a technician | Job appears with its number; the technician sees it as waiting for acceptance; the Notifications outbox shows a **queued** WhatsApp (not sent) |
| B2 | Technician: open it, *Accept job* | Status In Progress |
| B3 | Add labour, travel, a part, a note; add a photograph from the camera | Each appears on the job; the photograph shows as a picture, not a placeholder |
| B4 | Type the completion write-up | It says *Saving… / Saved* by itself — there is no Save button |
| B5 | *Complete job* → through the steps → Review | The review lists what was captured |
| B6 | Signature: customer name, surname, sign, *Confirm signature* | The signed job card PDF is shown, **with the photograph in it** |
| B7 | *Submit job card* | Job goes to the office (**Office Handling**); delivery shows *pending* (email is not live) |
| B8 | Office: Notifications → Inbox → *Mark handled* | Moves to **Awaiting PO** |
| B9 | Enter the invoice number | Moves to **Invoiced**; it appears in Closed Jobs |
| B10 | Office: transfer another job to a different technician | The receiving technician sees it; a WhatsApp is **queued** with the approved assignment template |

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
