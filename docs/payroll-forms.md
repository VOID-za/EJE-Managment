# Payroll forms — Timesheets, Attendance and My Monthly Forms (PAYROLL-ONE-1)

Decided by the owner on 5 November 2026; released as **v1.5.0** (`cf6fe86`,
migration 0052) the same day, the autosave follow-ups as **v1.5.1** (`e9fe38a`,
migration 0053) — **accepted by the owner on 5 November 2026** — and the
completion audit's fixes as **v1.5.2** (`835eaaa`, no migration), deployed the same day; the
day-by-day Timesheets page and the move of everything submitted to My Monthly
Forms (TS-DAY-1, the owner, 6 November 2026) as **v1.6.0** (`42e6bd4`, no migration), deployed 6 November 2026 — not yet approved; and
**the form lifecycle** (FORM-LIFECYCLE-1, the owner, 6 November 2026 — each form
completed on its own page, both submitted to the office together; Present and
Absent toggle; the six-column timesheet rows) as **v1.7.0** (`38b75cd`, migration 0054), deployed 6 November 2026 — not yet approved; and
**Withdraw and Correct** with the Timesheets corrections (FORM-WITHDRAW-1, TS-DAY-2, FORM-LOCK-2, TEST-ISOLATION-1,
the owner, 6 November 2026) as **v1.7.1** (`55e1d06`, migration 0055), deployed 7 November 2026 — **accepted by the owner on 7 November 2026** (the stable baseline); and
**repeated dates with line identity, personal My Monthly Forms and one History** (REPEAT-DATES-1, FORMS-OWN-1, HISTORY-ONE-1, the owner, 7 November 2026) as **v1.8.0** (`c34d1e7`, migration 0056), deployed 7 November 2026 — not yet approved. Release records:
`docs/deploy-next-release.md`. The device checks that only a person can do:
`docs/timesheets-physical-test-sheet.md`. This replaces the "Submit timesheet" of TS-PAPER
(`docs/timesheets-paper.md`) and the calendar-month "Submit" of PAY-02. The
earlier proposal (`docs/payroll-single-submission-proposal.md`) is kept as
history; where the two differ, this document is what the system does.

## The owner's decisions

1. **The Finance month is the calendar month holding the period's To.**
   24 Oct – 25 Nov 2026 → November 2026.
2. **Timesheet and attendance are submitted together** for exactly the same
   From and To, on My Monthly Forms, in one submission.
3. **Overlaps.** Dates covering only part of an earlier submission are refused,
   naming it. Dates covering all of it replace it, only after explicit
   confirmation; the original is kept, with its PDFs and file names, linked to
   its replacement, and never counted again.
4. **People who keep no timesheet** (the Office — the existing role rule,
   `completesTimesheet`) submit attendance alone. Recorded as
   `timesheet_required = false`; no empty timesheet is created.
5. **Incomplete timesheet lines are saved as drafts on the server** and block
   the submission until completed or removed.
6. **PDF names are stored** per person per working document, and the submitted
   documents keep the names they went with.

## The form lifecycle (FORM-LIFECYCLE-1, 6 November 2026)

| State | Where | What can be done |
|---|---|---|
| **In progress** | Timesheets, Attendance | Everything — each change saves itself. |
| **Completed — awaiting submission** | My Monthly Forms | Preview, Print, Download, Save PDF of the PDF stored when it was completed. Locked: nothing in its dates is changed by any page, device or request (`form_completed`). |
| **Withdrawn** (v1.7.1) | My Monthly Forms → Corrections | Kept exactly as it was completed, PDF included; Preview, Download. Never submitted, never counted for Submit to Office. |
| **Correction draft** (v1.7.1) | Timesheets or Attendance, on the withdrawn form's dates | Everything, as In progress; completed again with Completed — a NEW completed form, linked to the withdrawn one. |
| **Submitted to the office** | My Monthly Forms → History | Read only, for ever (`form_submitted`); never withdrawn; a submitted timesheet is changed only by a correction (TS-16). |
| **History** | My Monthly Forms | Every submission, its documents exactly as they went. No edit, delete, reopen or resubmit. |

- **Completed** is on each page. It opens **Complete this form?**: what
  completing does (finalised, moved to My Monthly Forms, cannot be edited
  again; preview, print, download and save stay; submitted to the office from
  My Monthly Forms when both are ready), the dates, and the **form name** —
  proposed (the To-month rule), changed right there (`normalisePdfFileName`
  checks it). The server's own check is shown: what stops it (a line not
  complete, an absent day without its reason, dates already submitted, the
  other form completed for other dates) and what must be confirmed (weekdays
  Not recorded; a timesheet with no lines). **Cancel** changes nothing. **OK**
  completes it (`POST /api/payroll/forms/:id/complete`): in the request's one
  transaction the content (the timesheet's lines and comment, or the
  attendance days) and the PDF rendered from it are frozen in
  `payroll_form_completions`, write-once, under the chosen name. The page then
  opens on the next period, clean. Completed is offered only once every
  change on the page is saved.
- **Independent.** Either form may be completed first; one never completes
  the other. The second must be for the same From–To as the first (refused
  otherwise: `form_period_mismatch`), so the two can always go together.
- **The lock** is checked on every write path of both forms
  (`form-locks.ts`): a line saved, added, moved or removed, the old entries
  route, an attendance day chosen or cleared. A completion and a save racing it
  take the same per-person lock (a PostgreSQL advisory lock held to the end of
  the transaction), so a save either lands before the completion reads the
  form — and is in it — or is refused after; it is never written beside it.
- **One at a time.** At most one form of each kind awaits per person (the
  database's unique key): a repeated or raced OK is never a second form. The
  same request again is answered from the idempotency store.
- **Submit to Office** (My Monthly Forms) sends BOTH completed forms, as one
  submission — never one alone. Disabled until both are completed for the same
  dates, with the reason under it in words: *Both forms must be completed*,
  *Attendance form not completed*, *Timesheet form not completed*, the two
  forms' differing dates, or *Ready to submit*. The Office (a Coordinator,
  who keeps no timesheet, TS-ROLE-1) submits attendance alone. The server
  checks it all again (`submitCompletedForms`): the person's own forms, both
  awaiting, the same dates, and the live lines and days still EXACTLY as
  completed (`payroll_form_changed` otherwise — nothing is submitted). Then, in
  one transaction, the existing submission is made from them — under their
  completed names, with the timesheet's frozen comment — and both are marked
  as part of it. A lost answer and a second press are one request; another
  request finds them submitted (`payroll_already_submitted`).
- **No replacement.** Dates that share any day with a submission are never
  completed again (`payroll_period_submitted`): a submitted form is not
  resubmitted. This retires TS-PAPER-7's confirmed complete replacement and
  RESUBMIT-1's "a submitted day stays editable" (the owner, 6 November 2026).
  Replacements made before this release stay in the history, marked replaced.

## Withdraw and Correct (FORM-WITHDRAW-1, v1.7.1)

The owner's rule (6 November 2026): **a completed form can be withdrawn before
it is submitted to the office; once submitted, never.**

- **Withdraw and Correct** is on each completed form on My Monthly Forms. Its
  dialog says: the form is withdrawn from the pending submission; it is kept
  exactly as completed, PDF included; a separate draft opens with the same
  lines or days; the correction must be completed again before it can be
  submitted; a submitted form can no longer be withdrawn. **Cancel** changes
  nothing.
- **Confirm** (`POST /api/payroll/forms/:id/withdraw`), in one transaction,
  under both form locks (attendance first, as Complete and Submit take them):
  the owner's own form, completed, awaiting — not submitted
  (`form_already_submitted`), not already withdrawn (`form_already_withdrawn`),
  somebody else's refused like one that does not exist — and still exactly as
  completed (`payroll_form_changed` otherwise). Then the completion is marked
  withdrawn (its content, name, dates and PDF untouched), the **correction
  draft** is opened for its dates (`payroll_form_correction_drafts`, one per
  withdrawn form), the comment and the name it was completed with come back,
  and `payroll_form_withdrawn` is audited. A double press or a retry is one
  request (idempotency key); a second tab is refused.
- **The draft is the form's data.** Its lines or days were locked since the
  completion, so they are exactly what was completed; they are editable again
  on their page, which opens on the draft's dates and says it is a correction.
  It is completed with the same Completed dialog, for the same dates
  (`form_correction_period` otherwise) — a new frozen completed form
  (`corrects_id` → the withdrawn one), and the draft records it, once.
- **Submit to Office** counts only forms completed and awaiting: a withdrawn
  one never qualifies (`formAwaits`), and never goes in a submission (the
  database refuses it too). With one form withdrawn, the button says which form
  is being corrected.
- **Corrections** on My Monthly Forms, apart from History: each withdrawn
  form (readable as it was completed) beside its correction — *draft — being
  corrected*, *completed — awaiting submission*, or *submitted*. The TS-16
  corrections of submitted timesheets stay under Submitted timesheets. History
  stays read only: Preview and Download, nothing else.

## Repeated dates and duplicate-payment safeguards (REPEAT-DATES-1, v1.8.0)

The owner's rule (7 November 2026): **the same calendar date may legitimately
appear in more than one submitted timesheet.** A date is never refused,
locked or replaced because an earlier submission had it, and the next
period's start (the day after the last submission) is only a *suggestion*.

**What was there before.** Until v1.7.1 the calendar date *was* the payroll
identity: the database allowed one current submission per person for any day
(`guard_timesheet_period`, `guard_payroll_submission` and the two
current-range unique keys), and a submitted timesheet locked its dates.

**What identifies paid work now — the work line.** Each timesheet line has its
own id (`timesheet_entries.id`). A line belongs to the timesheet that carried
it, for good:

| Record | Identity | What it says |
|---|---|---|
| `timesheet_entries` | line id | the work: person, work date, customer/site, OT, D/T, call-out, km |
| `timesheet_periods` (sent) | period id | one submitted timesheet: its From–To and the snapshot of exactly the lines it carried |
| `timesheet_submitted_lines` (0056) | **line id (primary key)** | the one sent timesheet that carried each line, its work date, when |
| `payroll_submissions` | submission id | the Submit to Office: timesheet period + frozen attendance + stored PDFs; Finance month = month of To |
| `timesheet_corrections` | correction id | TS-16 corrections of one sent timesheet, the original kept |
| `finance_packages` (manifest `basis`) | package id; per person the submissions and timesheet versions it carried | what was sent to Finance, once |

- **A new timesheet carries only OPEN lines** (`openEntries`): lines no
  submitted timesheet holds — its original snapshot, or a correction accepted
  or still pending on it. Completing, the completed PDF, Submit to Office's
  "still exactly as completed" check and the submitted snapshot all read the
  same open lines. A line already submitted is never in a second timesheet,
  whatever dates are chosen.
- **The database enforces it**: when a timesheet period is sent, the trigger
  `record_timesheet_submitted_lines` records each of its lines in
  `timesheet_submitted_lines` and refuses the whole submission if any line is
  already there (`timesheet line … is already in a submitted timesheet`). Two
  submissions racing for one person take an advisory lock, so the second sees
  the first's lines. The ledger is append-only.
- **A submitted line is never changed, moved or removed** — refused by the
  line (`timesheet_line_submitted`), on every write path. A NEW line on a
  submitted date is accepted; it belongs to the timesheet being filled in.
- **Each submission keeps its own identity**: a submission with the same or
  overlapping dates is a new row beside the earlier one, which is never
  replaced, rewritten or merged. Both stay current, readable and downloadable.
- **Retries and races**: Submit to Office carries an idempotency key; a
  completed form records its submission once (the 0054 guard); a retry with
  nothing newly completed is refused (`payroll_already_submitted`).
- **The same work typed twice by mistake** is not deleted or refused (it may be
  legitimate): the Timesheets day says which lines were already submitted for
  that date, and the office sees every repeated date as a review note.
- **Not locked by a submission**: a submitted *timesheet's* dates. **Still
  locked**: a completed form's dates while it awaits submission
  (`form_completed`), and submitted *attendance* (`form_submitted` — a day has
  one attendance; a new submission sharing the days carries them as recorded,
  and the Finance package names those days for review). A person who keeps
  **no timesheet** (the Office) is refused attendance for days already
  submitted (`attendance_already_submitted`): with no work lines, a repeat
  would only send the same attendance to Finance twice.
- Another person's submissions, a replaced submission, a withdrawn form or a
  correction draft never restrict anybody's dates.

**Payroll states that actually exist.** *Working* (lines saved) → *Completed —
awaiting submission* (locked; may be withdrawn) → *Submitted to the office*
(payroll submission; read only) → *Sent to Finance* (in a sent Finance
package). EJE records no "approved", "processed" or "paid" state: Finance pays
outside the system, and a submitted or sent form is never shown as paid.

**Office review** (EJE Monthly Forms): each of the month's submissions that
shares days with another of the person's submissions (any month, any kind)
carries a *Review — repeated dates* note naming both, the shared days, when
each was submitted and whether the earlier one already went to Finance, with
the earlier one's PDFs. Said once per pair (on the later); never a refusal.

### Which dates are locked (FORM-LOCK-2, v1.7.1; REPEAT-DATES-1, v1.8.0)

A day is locked only by the person's OWN current forms (`lockedRanges`): the
completed form awaiting submission (`form_completed`), and — attendance only —
attendance submitted to the office (`form_submitted`). Never by a date being
in the past, by another person's form, by a replaced submission, by a
withdrawn form, by a submitted timesheet (v1.8.0), or by demonstration data of
another account.

*The 31 October report (6 November 2026).* The day shown as "In a submitted
timesheet" with **Submitted · View** belonged to the demonstration account
Mike Technician, whose 26 Oct – 4 Nov timesheet was submitted to the office on
4 November (under v1.5) during hands-on use of the demonstration — a genuine
record of that account, not seed data, a fixture or an automated check. The
chosen pay period (from 26 October) reached into it, so those days were —
correctly — that submitted timesheet's, but the page only said "Submitted"
and the lines typed there afterwards (allowed by v1.6.0's resubmission, which
v1.7.0 retired) were stranded. v1.7.1 named the timesheet holding the day and
offered the day after it as the start. v1.8.0 (REPEAT-DATES-1) goes further: the
dates are open again; a line left over there is an ordinary open line (it is in
no submitted timesheet), and the day lists the lines already submitted for it.
The record is kept as it is.

**Test data never reaches a shared deployment.** The browser suites that write
(`scripts/*-check.mjs`, `forms-regression`, `integrations-regression`) refuse
any address that is not this machine (`scripts/local-target.mjs`); CI runs
them on 127.0.0.1 against a fresh store. The read-only live checks of a release
are separate scripts that write nothing.

## Timesheets — working data that saves itself

- Laid out like Attendance: the period's From and To top-right (any days,
  across months and years; a link from My Monthly Forms opens exactly its
  period), the period with Preview, Print and totals, then every day of the
  period, oldest first.
- **One block per day** (TS-DAY-1, 6 November 2026). Closed, a day is one row:
  its date, *Not recorded* or what its lines add up to (lines, customers or
  sites, OT, D/T, call-outs, km) and whether it is Saved, Saving, a Draft or
  Save failed. **Edit** opens it; **Add line** is inside the open day and adds
  an empty line for the next customer, site or Workshop on the same date — it
  never makes a second block and copies nothing from the first line. Each line
  is changed or removed on its own (**Remove line** asks first; Cancel keeps
  it); the day and its other lines stay. **Change date** moves all of the
  day's lines to another date together. Every day starts closed; the "fix these
  lines" link from My Monthly Forms opens the days holding a Draft.
- **What belongs to the day, and what to the line.** On EJE's paper Time
  Sheet (TS-PAPER-1) OT, D/T, the call-out (your own share) and the kilometres
  are written on each customer's row — so they stay on the line (a line is one
  customer, site or Workshop visit). NT is no longer entered (TS-07). Nothing
  is stored for the day itself: its figures are the sum of its lines,
  computed and never typed twice (`summariseDay`, `src/lib/timesheet-day.ts`),
  so no hour, call-out or kilometre can be counted twice; the period totals,
  the PDF, the CSV and Finance read the same lines as before. No migration: the
  stored lines, drafts, submissions and PDFs are exactly as they were, and
  lines written before the redesign are on their days, editable as any other.
- A line is typed straight into place under its day: Customer or Workshop (or
  neither), OT, D/T, Call-out (R, your own share), internal km, customer km. A
  draft from before with no date has its own Date field until one is chosen.
  Historical NT and call-out counts on older lines are shown and kept.
- **A saved line is as editable as a new one.** Only a submission locks a
  line. (Before v1.6.0 a line's own Date field carried it to another day on
  the first keystroke, so the field lost its place mid-edit; the date is now
  the day's, moved only by Change date.)
- **Every change saves itself** (`TimesheetAutosaver`): Saving…, Saved (only
  once the server has answered), Save failed + Retry, offline (kept on the
  device and retried 2 s, 5 s, 10 s, then every 30 s, and at once when the
  connection is back). Leaving the page sends what is waiting.
- Each save names the revision it began from; a save from an older revision
  (another tab, another device) is refused (`timesheet_line_changed`) and the
  newer line is shown — never overwritten. Repeating what a line already says
  is never a conflict, so a retry after a lost answer succeeds. A new line has
  the id the screen gave it, so a retry never makes two.
- **Two devices, one line** (v1.5.1, migration 0053): saves and removals of a
  line take that line's lock, and every save gets a revision strictly later
  than the one it replaces, so of two saves from one revision exactly one is
  confirmed and the other is refused. A removed line stays removed: its
  removal is recorded (`timesheet_line_removals`, write-once), and a save that
  arrives afterwards — from another device, or still on its way from a page
  that was left — is refused (`timesheet_line_removed`). Either refusal tells
  the person exactly what they typed that was not saved ("Not saved from this
  screen: …"). Answers lost to a bad connection, or to leaving the page
  mid-save, are remembered on the device as possibly saved, so the next visit
  recognises its own work instead of reporting it as another device's. A new
  line still waiting on the device (offline, refused, from before a reload)
  stays on the screen so it can be fixed or removed.
- **Incomplete lines** — no date, a number the server cannot store (letters,
  more than two decimals of hours, more than 24 hours in a day, …), a
  customer no longer in the register, or an empty line (no customer, not
  Workshop, every value zero) — are kept as a **Draft** on the server, exactly
  as typed, with what they need. A stored line being changed keeps its last
  complete values until the draft is complete. Drafts are not on the PDF.
- **Only the working sheet is on this page.** A line in a current submission
  is not shown (a day inside a submitted period is marked *Already
  submitted*); a submitted timesheet is changed by a correction (TS-16,
  unchanged) or a complete replacement, both on My Monthly Forms, and the
  server refuses any change to a submitted line (`timesheet_line_submitted`).
- The save notice is part of the page and scrolls away with it; each day and
  line says its own Saving, Saved or Save failed where it is.
- A change refused because its line was submitted or removed elsewhere (a
  change kept on the device while offline, say) is listed with what it was and
  **Discard this change** — it never waits for ever with nowhere to undo it.
  A refusal reloads the lines. A draft with no date keeps its own Date field,
  saved when the field is left, so the line never jumps mid-typing.
- The one comment saves itself the same way.
- **Six columns, one row per line** (FORM-LIFECYCLE-1): each day's lines are
  rows of **Customer | OT | D/T | Callout | Int Km | Cust Km**, side by side
  under the column names; on a phone the day's table scrolls sideways (the
  page does not). The Customer field is one: a register customer's name typed
  exactly picks that customer, "Workshop" is Workshop (TS-06), anything else
  is the name as typed. A day with no line says **Not recorded**; a day of a
  completed or submitted timesheet says so and is read only.
- **Completed**, not Submit: see the form lifecycle above. The old route
  (`POST /api/timesheets/:id/period/submit`) still answers `submission_moved`.

## Attendance

Present / Absent with its reason, one row per person per day, each choice
saving itself (ATT-AUTO-1); Absent is saved only once its reason is chosen.
Each person records their own days only (ATT-OWN-1); the office reads them.
The page shows at most 92 days at once, and a longer period says it opened the
first 92.

- **Present and Absent toggle** (FORM-LIFECYCLE-1). Pressing the chosen one
  again takes it back: the day is **Not recorded** again — its row is removed
  (`attendance_cleared`, audited), never turned into Present or Absent.
  Pressing the other one changes it. A stale screen never clears a newer
  answer (`attendance_changed`).
- Every day without an answer says **Not recorded**.
- **Completed** finalises the attendance for From–To (the lifecycle above).
- **Locked once completed or submitted** (FORM-LIFECYCLE-1, replacing
  RESUBMIT-1): those days say so and offer nothing to press; the server
  refuses a change or a clear. Days changed after a submission before this
  release are still counted on the office's month view ("N attendance day(s)
  changed in the register after submission — Finance gets the attendance as
  submitted").

## My Monthly Forms — the one submission point

- **No pay-period filter** (FORM-LIFECYCLE-1): the dates are the completed
  forms' own.
- **Timesheet**, then **Attendance**: each *Completed — awaiting submission*
  with its name, dates, what it holds and when it was completed, and Preview,
  Print, Download and Save PDF of the PDF stored at completion (never a live
  copy); or *Not completed*, with the way to its page; or, for the Office,
  the timesheet *Not required*. Nothing here edits a form.
- **Submit to Office**, with its reason under it (the lifecycle above). The
  submission itself is the one PAYROLL-ONE-1 made: in the request's ONE
  PostgreSQL transaction the timesheet period is submitted (its snapshot,
  rules and corrections as before), the attendance is frozen, both PDFs are
  rendered and stored under server-made keys
  (`payroll-submissions/<id>/<kind>.pdf`) with their SHA-256, one
  `payroll_submissions` row records it all, and both completed forms are
  marked as part of it. Submissions may share dates (REPEAT-DATES-1); the
  database refuses a LINE in two of them. The office is notified once, after
  it is saved.
- If the answer is lost, the page says the forms may not have gone and reads
  them again: submitted, nothing awaits and the history shows them; not
  submitted, both still wait and Submit to Office is offered again — the same
  request, answered once.
- **PERSONAL, FOR EVERY ROLE** (FORMS-OWN-1, v1.8.0): only the signed-in
  person's own forms. The server takes the person from the session; completed
  forms, correction drafts, withdrawn forms and the history of anybody else
  are refused (`not_permitted` / `form_not_found`) — to a Senior Tech and the
  Office too. Every technician's submitted timesheets (Export CSV, the
  corrections to accept or reject) are on **EJE Monthly Forms** (`/payroll`),
  for `timesheets.viewAll`; notifications of a submission link there.
- **Corrections**: the forms withdrawn before submission (FORM-WITHDRAW-1) and,
  for a role that keeps a timesheet, *A submitted timesheet* — choose one and
  ask the office for a correction with the reason (TS-16); the original stays
  in the History exactly as it went.
- Nothing submitted is on the Timesheets or Attendance page.
- **ONE HISTORY** (HISTORY-ONE-1, v1.8.0) at the bottom: every submitted form —
  timesheets and attendance together, one row each, told apart by a badge —
  newest submitted first, with its name, dates, submission date and time, and
  Preview and Download of the PDF stored when it went. Calendar months
  submitted before PAYROLL-ONE-1 are one row each. Read only: no edit, delete,
  reopen, withdraw, resubmit or regeneration. The Office sees attendance only.
- The in-memory demonstration store has no transaction; every check runs
  before the first write there too.

## PDF names

- Rename stores the name on the server (`payroll_document_names`), for the
  working document; it is kept across reloads, devices, signing out, editing
  and changing the dates, and used by Preview, Print, Download, Save PDF and
  the submission. An empty name goes back to the default.
- Rules (`normalisePdfFileName`, and a database check as a backstop): letters
  and digits of any language, spaces and `- _ . , ( ) & '`; no `/ \ : * ? " < > |`,
  no control or invisible formatting characters; `.pdf` added when left off,
  no other extension; no leading dot, no `..`, no trailing dot; not a
  reserved device name; at most 120 characters; the two forms may not share a
  name. It is metadata only — files are stored under keys the server makes.
- Submitting freezes the names into the submission and resets the working
  names; renaming afterwards never reaches a submitted document.
- A submitted timesheet keeps its submitted name **wherever it is opened**:
  My Monthly Forms' History, Timesheets → the submitted timesheets (the
  technician's and the office's PDF button, original or corrected version),
  and the Finance package (v1.5.2; before it, the Timesheets PDF button used
  the default name).
- A reserved device name is refused with any extension after it too:
  "CON.pdf" and "CON.a.pdf" alike (v1.5.2).

## Finance

- A month's package carries each person's **current** submissions whose To is
  in the month: the timesheet in its version in force (as before), under the
  name it was submitted with; the attendance exactly as stored at submission.
  Calendar months submitted before this release are carried as before.
- A replaced submission is never counted. Each row says the period and its
  type ("Timesheet and attendance" / "Attendance only — no timesheet
  required"), and links the stored PDFs. One open package per month, as
  before; payment rules and rates are unchanged.
- **A package is sent only while it is what is current** (v1.5.2). When it is
  prepared, each person's files record what they were made from — every
  current submission of the month and the corrections accepted on each
  timesheet (the attachment's `basis`, in the stored manifest). Send checks it
  again first: if a submission was made, replaced or corrected since, Send is
  refused (`package_out_of_date`), nothing is sent and the package stays
  prepared; the office discards it and prepares it again. Without this, a
  period submitted between Prepare and Send would never have reached Finance
  while the month read "Sent", or a replaced submission would have been sent
  in place of its replacement.
- A month reads **Sent** only for exactly what the sent packages carried. A
  **further submission** made after it was sent (REPEAT-DATES-1) reads
  *Further submission since sending*: selectable, and the next package carries
  ONLY the new submission's files, marked "Additional submission" in the
  manifest and the email — what Finance already has is never sent again. An
  accepted correction (or a v1.6.0 replacement) of something already sent makes
  it **Corrected after it was sent** — re-sent marked CORRECTED, as before.
  (Packages sent before v1.5.2 carry no basis; for them it is judged by time.)
- A calendar month submitted before PAYROLL-ONE-1 is sent **as submitted**
  (v1.5.2); before, its attendance was drawn from the register as it stood,
  labelled as an office correction.
- **No line and no submission goes to Finance twice** (REPEAT-DATES-1): a line
  is in one submission only (`timesheet_submitted_lines`); each submission
  belongs to one Finance month (its To); a submission is carried by a sent
  package once — a later package for the month carries only what no sent
  package carried (`basis` parts), or re-sends it marked CORRECTED when it was
  corrected; one package per month is open at a time
  (`finance_packages_one_open_per_month`), Send claims it in one conditional
  write and checks the basis again, so two office users, a double click or a
  retry produce one send. A repeated date alone is not a duplicate. Files of a
  further submission are named `… ADDITIONAL.pdf` (as corrected ones are
  `… CORRECTED.pdf`), and the email names any attendance days that are also in
  an earlier submission.

## Who may do what

| | Technician / Apprentice | Senior Tech (`master`) | Office (`coordinator`) |
|---|---|---|---|
| Own timesheet lines and its comment | write | write | — (completes no timesheet, TS-ROLE-1) |
| Own attendance | write | write | write |
| Complete (and name) a form; Submit to Office | own: both forms | own: both forms | own: attendance only |
| Withdraw and Correct a completed form (before submission) | own | own | own: attendance |
| My Monthly Forms: completed forms, corrections, History (FORMS-OWN-1) | own only | own only | own only — attendance only |
| Ask for a correction of a submitted timesheet | own | own | — |
| Accept or reject a correction | — | someone else's | yes |
| Another person's SUBMITTED forms (EJE Monthly Forms, `/payroll`) | — | **read only** | **read only** |
| Another person's completed-but-not-submitted forms, drafts, history | — | — | — |
| Monthly payroll and the Finance package (prepare, send, discard) | — | yes | yes |
| Repeated-date review notes | — | yes | yes |

No role writes another person's timesheet or attendance: v1.5.2 closed the
one gap, the day comment, which the office could write. A technician never
reads another's forms (refused by the server). Every route checks it on the server; the screen only hides what is refused.

## Known limitations

- **Once submitted, a form is never withdrawn** (the owner's rule). A submitted
  timesheet is corrected through TS-16; submitted attendance has no correction
  path, so a wrong one is put right by the office outside the system.
- **A To in the future** is allowed (as before), so completing to the end of a
  month part-way through it locks the days still to come, and they go Not
  recorded. The dialog shows the dates; staff should complete up to today.
- **A person whose role changes to the Office** after completing a timesheet
  submits attendance alone; the completed timesheet then stays awaiting, its
  dates locked, until the office deals with it.
- **The submitted PDFs are rendered at submission** from the very content that
  was completed (checked equal, field by field), stamped as submitted — so the
  file in the history differs in its stamp, not its content, from the one
  previewed before submitting.

- Real Finance email needs EJE's Microsoft 365 credentials (INT-EMAIL, #79);
  production email is `refuse`, so Send is refused there and the package
  stays prepared.
- The physical-device checks in `docs/timesheets-physical-test-sheet.md` are
  for a person with the real tablet, phone and printer; everything else is
  automated.

## Database (migration 0056, additive — REPEAT-DATES-1)

| Change | Why |
|---|---|
| NEW `timesheet_submitted_lines` (entry_id PK, user_id, work_date, period_id, submitted_at); append-only guard. Backfilled from every stored sent snapshot — each line once, on its current submission (on production, 7 November 2026: 28 lines from 11 sent timesheets, none in two current ones). | the line, not the date, is what is paid once |
| NEW trigger `record_timesheet_submitted_lines` on `timesheet_periods`: records a timesheet's lines as it is sent; refuses a line already recorded | the database refuses the same line in two submissions |
| `guard_timesheet_period`, `guard_payroll_submission`: the one-current-per-day checks removed; every write-once rule unchanged | repeated dates allowed |
| `timesheet_periods_user_range_current_key` → `timesheet_periods_user_range_unsent_key` (one UNSENT row per dates); `payroll_submissions_current_range_key` → plain index | several submissions may have the very same dates |

No existing row is updated or deleted; every snapshot, submission, correction,
package and PDF stays exactly as stored.

## Database (migration 0055, additive)

| Change | Why |
|---|---|
| `payroll_form_completions`: `withdrawn_at`, `withdrawn_by` (set once, together, never on a submitted form; a withdrawn form is never submitted) and `corrects_id` (a completed correction → the withdrawn form of the same person, form and dates; one per withdrawn form). The guard trigger now also checks inserts. | the withdrawal, recorded beside the untouched completion |
| `payroll_form_completions_awaiting_key` rebuilt to leave withdrawn forms out | a correction can await once its original is withdrawn |
| `payroll_form_correction_drafts` — the draft a withdrawal opens: person, form, dates, the withdrawn form (one draft each), and once completed again the correction. Write-once apart from that link; never deleted; one open per person and form. | the separate, traceable correction |

No existing row is updated or deleted by the migration: every existing
completion reads as not withdrawn.

## Database (migration 0054, additive)

| Change | Why |
|---|---|
| `payroll_form_completions` — one completed form: person, kind, From, To, name, frozen content, stored PDF, who and when, and the submission it went in. Write-once (`guard_payroll_form_completion`): only `submission_id` is set, once; never deleted. One awaiting per person and kind (`payroll_form_completions_awaiting_key`). | the completed, locked form |

No existing row is updated or deleted by the migration. v1.6.0 (`42e6bd4`)
never reads the table, so it runs against it unchanged (CI rollback probe).

## Database (migration 0052, additive)

| Change | Why |
|---|---|
| `payroll_submissions` — write-once (trigger), one current per person per day, Finance month = month of To (check), timesheet half must be the same person's current sent period for exactly the dates | the submission |
| `payroll_document_names` | stored PDF names |
| `timesheet_line_drafts` | incomplete lines on the server |
| `timesheet_periods` unique key per CURRENT row | a same-date replacement keeps the original |
| `guard_timesheet_period`: a sent period is final (never re-sent in place); a replaced one stays replaced | snapshots are never rewritten |
| `monthly_submissions`: three nullable `superseded_*` columns; `guard_monthly_submission` refuses any rewrite (RESUBMIT-1's in-place replacement ends) and a month overlapping a current payroll submission | history is kept; no day is submitted twice |

No existing row is updated or deleted by the migration.

## Recovery

- **Code rollback from v1.8.0 to v1.7.1** (`55e1d06`): nothing of the
  database is undone (0056 is additive). The limitation, proved by the CI
  rollback probe: v1.7.1's Submit to Office names the current-range keys 0056
  replaced in its ON CONFLICT, so it is refused with nothing written until the
  release is rolled forward; it reads every submission, two with the same
  dates included, and the line ledger keeps refusing a line in two
  submissions. Forms completed under v1.7.1 wait, completed, until then.

- **Code rollback from v1.7.1 to v1.7.0** (`38b75cd`): nothing of the database
  is undone (0055 is additive). The limitation, proved by the CI rollback
  probe: v1.7.0 knows nothing of a withdrawal, and the database keeps it safe —
  it can never submit a withdrawn form (the guard refuses it, nothing is
  written), and its **Completed** is refused with nothing written (its insert
  names the one-form-awaiting key as 0054 built it; 0055 rebuilt it). So under
  v1.7.0 a form is not completed until the release is rolled forward; forms
  already completed are still submitted. A correction draft open at the time
  reads, under v1.7.0, as its withdrawn form still awaiting (locked).

- **Code rollback from v1.7.0 to v1.6.0** (`42e6bd4`): nothing of the
  database is undone (0054 is additive and v1.6.0 never reads it). The
  limitation: v1.6.0 knows nothing of completion — it does not lock a
  completed form's dates, and its My Monthly Forms submits by From–To as
  before. A form completed under v1.7.0 and not yet submitted stays recorded
  in `payroll_form_completions`, awaiting, and is honoured again when v1.7.0
  is back (a changed form is then refused at Submit, `payroll_form_changed`,
  never sent as if it were the completed one).

- **Code rollback from v1.5.2 to v1.5.1** (`e9fe38a`) needs nothing of the
  database (v1.5.2 has no migration; the `basis` it adds to a package's
  manifest is ignored by v1.5.1). **From v1.5.1 to v1.5.0** (`cf6fe86`): the
  database stays at 0053, which v1.5.0 never reads (CI rollback probe).
- *v1.5.0's own note:* **Code rollback to v1.4.0** works against 0052 (proved by
  `scripts/release/rollback-probe.db.test.ts` in CI) with one limitation: the
  old Timesheets page's "Submit timesheet" fails without writing anything (its
  ON CONFLICT names the replaced full unique key). Payroll submissions made by
  this release are not shown by the old code; they remain in the database.
- The migration is not reversed in production. The pre-release backup is
  restore-tested before deployment (`docs/deploy-next-release.md`).
