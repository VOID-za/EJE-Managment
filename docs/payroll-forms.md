# Payroll forms — Timesheets, Attendance and My Monthly Forms (PAYROLL-ONE-1)

Decided by the owner on 5 November 2026; released as **v1.5.0** (`cf6fe86`,
migration 0052) the same day, the autosave follow-ups as **v1.5.1** (`e9fe38a`,
migration 0053) — **accepted by the owner on 5 November 2026** — and the
completion audit's fixes as **v1.5.2** (`835eaaa`, no migration), deployed the same day; the
day-by-day Timesheets page and the move of everything submitted to My Monthly
Forms (TS-DAY-1, the owner, 6 November 2026) as **v1.6.0** (`42e6bd4`, no migration), deployed 6 November 2026 — not yet approved. Release records:
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
- **No Submit.** "Review and submit on My Monthly Forms" links there for the
  period. The old route (`POST /api/timesheets/:id/period/submit`) answers
  `submission_moved`.

## Attendance — unchanged

Present / Absent with its reason, one row per person per day, each choice
saving itself (ATT-AUTO-1); Absent is saved only once its reason is chosen.
No Submit (it never had one after FORMS-PAGES-1). Each person records their
own days only (ATT-OWN-1); the office reads them. My Monthly Forms' "Edit my
attendance" opens exactly the period; the page shows at most 92 days at once,
and a longer period says it opened the first 92.

A day may still be changed after the period was submitted (RESUBMIT-1 left a
person's own days editable). The submission stays exactly as submitted — that
is what Finance gets — and the office's month view counts the days changed in
the register since ("N attendance day(s) changed in the register after
submission — Finance gets the attendance as submitted"), so a change is never
silent. A changed period is put right by submitting it again (a confirmed
complete replacement).

## My Monthly Forms — the one submission point

- Opens on the day after the last submission to today (or a link's dates).
  From and To may be any days, up to a year.
- Shows the Finance month, then two sections — **Timesheet** and
  **Attendance** — each with its file name, **Rename**, Preview, Print,
  Download PDF and Save PDF, all of the very PDF that is submitted, and a
  link to edit it for these dates. An Office person sees attendance only.
- Says plainly what stops the submission, each with where to fix it:
  incomplete lines (named, with what they need), an absent day without its
  reason, a partial overlap, a corrected timesheet in the way.
- Asks for explicit confirmation of: weekdays with no attendance, a timesheet
  with no lines, and a replacement (it names what it replaces).
- **Submit** (`POST /api/payroll/forms/:id/submit`) sends the revision the
  screen reviewed; if anything changed since (a line still saving, another
  tab), it is refused (`payroll_forms_changed`) and the forms are shown again.
  Every check is made before anything is written. Then, in the request's ONE
  PostgreSQL transaction: the timesheet period is submitted (its snapshot,
  rules and corrections as before), every earlier submission the dates cover
  is marked replaced, the attendance is frozen, both PDFs are rendered and
  stored under server-made keys (`payroll-submissions/<id>/<kind>.pdf`) with
  their SHA-256, and one `payroll_submissions` row records it all. The
  database refuses two current submissions of one person sharing a day, so
  racing requests make one submission; a replayed request is answered from
  the idempotency store. The office is notified once, after it is saved.
- **Submitted timesheets** (moved here from Timesheets on 6 November 2026):
  the person's own — each opened exactly as submitted (original and the
  corrected version in force), its PDF, and Corrections to ask for one — and,
  for the office (`timesheets.viewAll`: Senior Tech and Office), every
  technician's, with Export CSV and the corrections to accept or reject. The
  Office now reaches it too (it has no Timesheets page). Notifications of a
  submission or a correction link here.
- Nothing submitted is on the Timesheets or Attendance page.
- The **History** lists every submission — current and replaced, and the
  calendar months submitted before this release — with the stored PDFs, under
  their submitted names, exactly as they went.
- If the answer to Submit is lost (the connection drops after the server
  made the submission), the page says the submission may not have gone, and
  reloads the forms: the history then shows it, and Submit is offered only as
  an explicit replacement. Pressing Submit again before anything changed
  repeats the very same request (the same idempotency key), which the server
  answers with the submission it already made — never a second one.
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
- A month reads **Sent** only for exactly what the sent package carried; any
  later submission, replacement or accepted correction makes it **Corrected
  after it was sent** — selectable again, marked CORRECTED. (Packages sent
  before v1.5.2 carry no basis; for them it is judged by time, as before.)
- A calendar month submitted before PAYROLL-ONE-1 is sent **as submitted**
  (v1.5.2); before, its attendance was drawn from the register as it stood,
  labelled as an office correction.
- No day goes to Finance twice: current submissions never share a day (the
  database refuses it), each ends in exactly one Finance month, a submission
  already sent to Finance cannot be replaced, and a package that is no longer
  current is never sent.

## Who may do what

| | Technician / Apprentice | Senior Tech (`master`) | Office (`coordinator`) |
|---|---|---|---|
| Own timesheet lines and its comment | write | write | — (completes no timesheet, TS-ROLE-1) |
| Own attendance | write | write | write |
| Rename and Submit on My Monthly Forms | own: both forms | own: both forms | own: attendance only |
| Ask for a correction of a submitted timesheet | own | own | — |
| Accept or reject a correction | — | someone else's | yes |
| Another person's timesheet, attendance and forms | — | **read only** | **read only** |
| Monthly payroll and the Finance package (prepare, send, discard) | — | yes | yes |

No role writes another person's timesheet or attendance: v1.5.2 closed the
one gap, the day comment, which the office could write. A technician never
reads another's forms (refused by the server). Every route checks it on the server; the screen only hides what is refused.

## Known limitations

- Real Finance email needs EJE's Microsoft 365 credentials (INT-EMAIL, #79);
  production email is `refuse`, so Send is refused there and the package
  stays prepared.
- The physical-device checks in `docs/timesheets-physical-test-sheet.md` are
  for a person with the real tablet, phone and printer; everything else is
  automated.

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
