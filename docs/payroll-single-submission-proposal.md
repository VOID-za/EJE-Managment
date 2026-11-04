# Timesheets, Attendance and My Monthly Forms as one submission — proposal (4 November 2026)

**Status: NOT IMPLEMENTED. Awaiting the owner's decisions below.** Asked for on
4 November 2026 (items 4–8 of the repair brief). Nothing in this document has
changed the system.

## Why this was not built in the same release

It reverses part of TS-PAPER, deployed the same day (v1.1.0/v1.2.0, issue #131 —
"the technician submits the timesheet on payday from the Timesheets page"), and
it changes **what Finance receives**:

| Today (verified in code, 4 Nov 2026) | Asked for |
|---|---|
| Timesheets: lines saved one at a time ("Save line"); **Submit timesheet** for a From–To period (TS-PAPER) — immutable snapshot, overlap/replacement rules (TS-PAPER-7), corrections (TS-16) | Attendance-style page, every change **auto-saved**, **no Submit** |
| Attendance: auto-saves each day already; **no Submit button** (it already says "submitted on Monthly Forms") | unchanged — keep |
| My Monthly Forms: a **calendar month** (`monthBounds`); submits **attendance** for the month (`monthly_submissions`, one per person per month); the timesheet travels separately | **one** submission of **both** forms, for the **actual From–To period** (e.g. 24 Oct – 25 Nov), atomic |
| Finance package: per **month** — every current timesheet submission whose **To** falls in it, plus that month's attendance submissions | the same records as the UI, PDF and snapshot for the submitted period |
| PDF names: derived on every render (`JC OCT 2026 …`), not stored | a **stored, user-chosen** name per working document, shown everywhere; never applied to a submitted document |

The coordinated submission needs the attendance submission keyed by **period**
instead of **month** — a migration on `monthly_submissions` (or a new
`payroll_submissions` table holding both snapshots in one row, written in one
transaction), and a new rule for which Finance month a cross-month period
belongs to. Getting either wrong sends Finance the wrong days, so the rules
below are needed before code.

## Decisions needed from the owner

1. **Finance month of a cross-month period.** A submission for 24 Oct – 25 Nov:
   which month's Finance package carries it? *Proposed:* the month of **To**
   (today's TS-PAPER rule — November), never split.
2. **Attendance becomes period-based.** Attendance is submitted for exactly the
   same From–To as the timesheet, in the same submission. *Proposed:* yes; the
   existing monthly attendance submissions stay as they are (read-only history).
3. **Overlaps.** A new submission whose dates overlap a submitted one:
   *Proposed:* the TS-PAPER-7 rule for both forms together — partial overlap
   refused; full cover replaces (original kept) only on explicit confirmation;
   never once a correction exists.
4. **People with no timesheet** (Coordinators today submit attendance only):
   *Proposed:* the timesheet section shows "no timesheet lines" and the
   submission carries attendance alone — still one atomic submission.
5. **Auto-saving a timesheet line that is not yet valid** (e.g. no customer and
   not Workshop): *Proposed:* the line is kept as a **draft on the device** and
   shown "Not saved — needs a customer or Workshop"; it is saved the moment it
   is valid. Nothing invalid is stored, nothing is silently dropped.
6. **Renaming.** *Proposed:* one stored name per person per working document
   (timesheet, attendance) per period; `.pdf` added if missing; 1–120
   characters; letters, digits, spaces and `- _ . ( ) , &`; no `/ \ :` or
   leading dot; duplicates allowed (it is a download name, not a storage path).
   The submitted document keeps the name it was submitted under.

## Proposed implementation, once decided

- Migration: `payroll_submissions` (person, from, to, finance month, timesheet
  snapshot, attendance snapshot, file names, idempotency key, submitted at/by,
  replaced-by) and `working_document_names` (person, kind, from, to, name).
  Additive; existing `timesheet_periods` and `monthly_submissions` untouched.
- One server command `submit_forms` in one transaction: validate both, snapshot
  both, write one row, idempotency key against double clicks and retries.
- Timesheets page rebuilt on the Attendance layout and its auto-save hook
  (`useAttendanceAutosave`: debounce, saving/saved/failed+retry, optimistic
  concurrency on the line's version so an older save cannot overwrite a newer).
- My Monthly Forms: From–To instead of Month; two sections with Preview, Print,
  Download, Save PDF and **Rename**; one **Submit both** button.
- Finance package reads `payroll_submissions` by finance month (decision 1) as
  well as the existing tables, so history is unchanged.
- Tests: the twelve period cases of the brief (same month, cross-month,
  cross-year, leap February, boundaries, empty, historical, replacement,
  Finance, preview = PDF = snapshot = Finance), rename safety and persistence,
  atomicity (a failure in either form writes nothing), idempotency, permissions;
  PostgreSQL integration; browser at three sizes.
