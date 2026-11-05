# Timesheets as a digital piece of paper — before and after (TS-PAPER, 4 November 2026)

> **Superseded in part by PAYROLL-ONE-1 (5 November 2026, `docs/payroll-forms.md`):** lines now save
> themselves as typed (incomplete ones as server drafts), the Timesheets page has no Submit, and the
> timesheet is submitted with the attendance for the same From–To on My Monthly Forms. A submission is
> never rewritten; a complete replacement keeps the original. Corrections (TS-16) are unchanged.

Asked for by the owner on 4 November 2026: "The technician maintains it. The
technician submits it on payday. EJE records and preserves it."

## Before (verified in the code, 4 November 2026)

| Area | What the code did | Where |
|---|---|---|
| Period | The page opened on "1st of this month → today"; every line had to fall inside the From/To on screen | `defaultTimesheetRange`, `lineDateProblem` (`src/lib/timesheet-dates.ts`) |
| Future dates | Refused on screen and on the server (`date_in_future`) | `lineDateProblem`, `assertTimesheetDate` |
| Length | At most 92 days — on screen, on the server (`range_too_long`) **and in the database** (`timesheet_periods_range_valid`: `period_to - period_from < 92`) | `TIMESHEET_MAX_DAYS`, migration 0038 |
| Customer | A customer — or Workshop — required on any line with hours, a call-out or kilometres (`customer_required`) | `normaliseTimesheetLine`, `timesheetDraftProblems` |
| Hours | Quarter hours only | `assertHours`, `hoursProblem` |
| Sending again | Re-sending the same From/To **overwrote the snapshot and deleted the corrections** recorded against it (RESUBMIT-1) | `submitTimesheetPeriod`, `deleteCorrections` |
| Comment | Stored on a draft row keyed by the exact From/To, so changing the dates "lost" it | `saveTimesheetPeriodComment` |
| Calendar months | My Monthly Forms sent a timesheet for **exactly the calendar month** with the attendance — and, as a later overlapping submission, it would *replace* a payday submission (TS-OVERLAP-1). The database insisted on the calendar month (`guard_monthly_submission`) | `monthly-submissions.ts`, migrations 0040/0043/0046 |
| Finance | The Finance package printed the timesheet for exactly the calendar month | `finance-packages.ts` |
| Office | Read timesheets only through EJE Monthly Forms, by month | — |

Not a problem, kept: lines are typed by hand (nothing from job cards); several
lines a day; Workshop distinct from a customer; NT and call-out counts kept as
history; numbers bounded (0–24 h a line, km to one decimal, rand to the cent);
owner-only writes; office reads; every write audited; corrections decided by
the office.

## After

**The working sheet.** Each technician has one open sheet: every line they have
written that is not part of a submission. Lines may be on any real date — past,
future, before the last payday — as many as they like on a day, Workshop or a
customer or neither. Save, leave, come back. Nothing closes at month end and
nothing starts on the 1st. One comment for the sheet, kept until it is submitted.

**Submitting on payday.** The page proposes the dates: **From** = the day after
the end of the technician's last submission (the first time: their earliest
open line), **To** = today. The technician confirms or changes them — any
length, any day of the month — and presses **Submit timesheet**. Every line
dated From…To and the comment are frozen in an immutable snapshot with who and
when; the office is notified; the comment is cleared; the next sheet starts the
day after To. Lines dated after To (or before From) simply stay on the sheet.

  - normal: 26 Oct → 25 Nov; weekend: 26 Oct → Mon 27 Nov; early December:
    26 Nov → 15 Dec, then 16 Dec → 25 Jan; early or late in any month: To is
    whatever day payroll actually is.

**Corrections.** A submission is never edited or overwritten. The existing
correction workflow stays (reason + complete corrected lines, decided by the
office, the original kept). Submitting dates that overlap an earlier
submission is still possible, with a warning, and *replaces* it for the office
— the earlier one is kept, marked replaced, and audited. Re-submitting the
**same** dates is refused with "ask for a correction" (it used to overwrite).

**Office.** A "Submitted timesheets" list: technician, From, To, submitted
when and by whom, version, replaced or current; open it, preview and download
the PDF, export the exact submitted lines as CSV.

**Monthly Forms and Finance.** The monthly submission carries the attendance
only; timesheets are submitted from the Timesheets page by payday. The Finance
package for a month includes each technician's current timesheet
submission(s) **ending in that month**; a month already submitted with a
calendar-month timesheet keeps it.

## Database (migration 0050, additive)

1. `timesheet_periods_range_valid` (≤ 92 days) replaced by
   `timesheet_periods_range_ordered` (From ≤ To).
2. New table `timesheet_working_comments` — one row per person: the open
   sheet's comment.
3. `guard_monthly_submission()` — a submission without a timesheet is allowed
   for anybody (was: Coordinators only). Everything else unchanged.

Nothing is deleted or rewritten: entries, NT, call-out counts, day comments,
periods, snapshots, superseded submissions, corrections, monthly submissions
and audit events stay exactly as stored. The unique key on
(person, From, To) is kept so the live release can still be rolled back to.

## Follow-up to v1.1.0 (TS-PAPER-6…8, 4 November 2026)

The v1.1.0 investigation found that a partial overlap replaced a whole earlier
submission and left its other days out of payroll, that a legacy calendar
month could be printed beside its replacement, that a corrected-then-replaced
original had no View on screen, and that a timesheet over ~190 lines had no
PDF. The follow-up:

- **Replacement is lossless.** Dates covering only part of a current
  submission are refused (`timesheet_partial_overlap`), naming it. Dates
  covering all of it need the technician's confirmation
  (`timesheet_replace_unconfirmed` otherwise) and then replace it — the
  original kept, marked replaced. A submission with a correction is not
  replaced (`timesheet_replace_corrected`): the correction lives on the
  submission, not on the sheet's lines. The repository replaces only what the
  new dates cover.
- **Finance has one rule:** every current submission whose To is in the month.
- **View original** on every submission; **View corrected version** when one
  is in force; a replaced submission takes no correction (`timesheet_replaced`).
- **Multi-page PDF** when one page would need type under 7 pt.
