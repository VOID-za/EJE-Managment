# Payroll forms — Timesheets, Attendance and My Monthly Forms (PAYROLL-ONE-1)

Decided by the owner on 5 November 2026; released as **v1.5.0** (`cf6fe86`,
migration 0052) the same day. This replaces the "Submit timesheet" of TS-PAPER
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
  period, oldest first, each with its lines and **Add line**.
- A line is typed straight into place: date, Customer or Workshop (or neither),
  OT, D/T, Call-out (R, your own share), internal km, customer km. Historical
  NT and call-out counts on older lines are shown and kept.
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
- Lines in a current submission are shown read-only, marked Submitted: a
  submitted timesheet is changed by a correction (TS-16, unchanged), or by a
  complete replacement.
- The one comment saves itself the same way.
- **No Submit.** "Review and submit on My Monthly Forms" links there for the
  period. The old route (`POST /api/timesheets/:id/period/submit`) answers
  `submission_moved`.

## Attendance — unchanged

Present / Absent with its reason, one row per person per day, each choice
saving itself (ATT-AUTO-1). No Submit (it never had one after FORMS-PAGES-1).

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
- The **History** lists every submission — current and replaced, and the
  calendar months submitted before this release — with the stored PDFs, under
  their submitted names, exactly as they went.
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

## Finance

- A month's package carries each person's **current** submissions whose To is
  in the month: the timesheet in its version in force (as before), under the
  name it was submitted with; the attendance exactly as stored at submission.
  Calendar months submitted before this release are carried as before.
- A replaced submission is never counted. Each row says the period and its
  type ("Timesheet and attendance" / "Attendance only — no timesheet
  required"), and links the stored PDFs. One open package per month, as
  before; payment rules and rates are unchanged.

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

- **Code rollback to v1.4.0** works against 0052 (proved by
  `scripts/release/rollback-probe.db.test.ts` in CI) with one limitation: the
  old Timesheets page's "Submit timesheet" fails without writing anything (its
  ON CONFLICT names the replaced full unique key). Payroll submissions made by
  this release are not shown by the old code; they remain in the database.
- The migration is not reversed in production. The pre-release backup is
  restore-tested before deployment (`docs/deploy-next-release.md`).
