'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { completesTimesheet } from '@/domain';
import { Button, ButtonLink, Card, Icon, LoadingPanel, QueryFailure, TextAreaField, TextField } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { AutosaveStatus } from '@/components/attendance/AutosaveStatus';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { TimesheetDay } from '@/components/timesheets/TimesheetDay';
import { TimesheetLineEditor, shownLine, type EditableLine } from '@/components/timesheets/TimesheetLineEditor';
import { useTimesheetAutosave } from '@/components/timesheets/useTimesheetAutosave';
import { CompleteFormDialog } from '@/components/payroll/CompleteFormDialog';
import { payroll, reads, timesheets } from '@/api/endpoints';
import type { TimesheetDocument } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { useCurrentUser } from '@/providers/AppProvider';
import { businessToday } from '@/lib/business-time';
import { formatCurrency } from '@/lib/format';
import { isUsableRange, readRememberedRange, rememberRange, type DateRange } from '@/lib/remembered-range';
import { daysInPeriod, formatDayAndDate, formatPeriod, isCalendarDay } from '@/lib/timesheet-dates';
import { COMMENT_KEY } from '@/lib/timesheet-autosave';
import { groupByDay } from '@/lib/timesheet-day';
import { emptyTimesheetLineTyped, parseTyped, randToCents } from '@/lib/timesheet-line';

/** The longest period the page lays out day by day; the submission itself may be up to a year. */
const TIMESHEET_RANGE_MAX_DAYS = 366;

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

const daysOf = (from: string, to: string): string[] => {
  const days: string[] = [];
  for (let at = from; at <= to && days.length < TIMESHEET_RANGE_MAX_DAYS; at = addDays(at, 1)) days.push(at);
  return days;
};

const newLineId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/gu, () => Math.floor(Math.random() * 16).toString(16));

/** The calendar day `days` after `iso` (YYYY-MM-DD). */
const addDaysIso = (iso: string, days: number): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** A link's dates (My Monthly Forms opens exactly its period), else the person's last choice here. */
const linkedRange = (): DateRange | null => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  return isCalendarDay(from) && isCalendarDay(to) && from <= to ? { from, to } : null;
};

/**
 * TIMESHEETS — WORKING DATA THAT SAVES ITSELF. PAYROLL-ONE-1 (the owner,
 * 5 November 2026), on TS-PAPER (docs/payroll-forms.md); TS-DAY-1 (the owner,
 * 6 November 2026).
 *
 * The same page as Attendance: the period's From and To top-right, then the
 * period with Preview and Print, then every day of the period, oldest first,
 * each ONE block (`TimesheetDay`): collapsed to its date and what its lines
 * add up to; opened, a line for each customer, site or Workshop visited, and
 * Add line inside the day. Every change saves itself (Saving…, Saved, Save
 * failed + Retry — never "Saved" before the server said so). A line not
 * complete yet is kept on the server as a Draft and says what it needs. There
 * is NO Submit here: the timesheet is submitted with the attendance, for the
 * same From and To, on My Monthly Forms.
 *
 * ONLY THE WORKING SHEET IS HERE. A submitted line, the submitted timesheets,
 * their PDFs and corrections, and the office's list of everybody's are on My
 * Monthly Forms; the server keeps refusing a change to a submitted line.
 *
 * Kept: Workshop/customer, OT, D/T, call-out amount, internal and customer km,
 * historical NT and call-out counts, the one comment.
 */
const TimesheetsPage = () => {
  const user = useCurrentUser();
  const keeps = completesTimesheet(user.role);
  const personId = keeps ? user.id : null;
  const today = businessToday();

  const sheet = useQuery(`timesheets:working:${personId ?? 'none'}`, () => (personId === null ? Promise.resolve(null) : timesheets.working(personId)));
  const lines = useQuery(`timesheets:lines:${personId ?? 'none'}`, () => (personId === null ? Promise.resolve(null) : timesheets.lines(personId)));
  const customers = useQuery('timesheets:customers', () => reads.customers());
  // FORM-LIFECYCLE-1: the forms completed and awaiting Submit to Office — a completed timesheet's dates are locked.
  const completed = useQuery(`payroll:completed:${personId ?? 'none'}`, () => (personId === null ? Promise.resolve(null) : payroll.completed(personId)));

  const refresh = useCallback(() => {
    lines.refetch();
    sheet.refetch();
    completed.refetch();
    // The refetch functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const { saver, conflict, dismissConflict } = useTimesheetAutosave(personId, refresh);

  // THE PERIOD: a link's dates, else the person's last choice, else the day after the last submission to today.
  const [range, setRange] = useState<DateRange | null>(null);
  useEffect(() => {
    if (range !== null || sheet.data === null || sheet.data === undefined) return;
    const chosen = linkedRange() ?? readRememberedRange('timesheets', user.id, TIMESHEET_RANGE_MAX_DAYS) ?? sheet.data.suggested;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first period is known once the sheet has loaded.
    setRange(chosen);
  }, [range, sheet.data, user.id]);
  const choose = (next: DateRange) => {
    setRange(next);
    if (isUsableRange(next, TIMESHEET_RANGE_MAX_DAYS)) rememberRange('timesheets', user.id, next);
  };
  const usable = range !== null && isUsableRange(range, TIMESHEET_RANGE_MAX_DAYS);
  /*
   * FORM-WITHDRAW-1: a completed timesheet withdrawn on My Monthly Forms comes back here as a CORRECTION DRAFT for
   * its own dates — said at the top, the page opened on those dates once — and is completed again from here.
   */
  const draft = completed.data?.drafts.timesheet ?? null;
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (draft === null || range === null || jumped.current === draft.id) return;
    jumped.current = draft.id;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft's dates are known once the forms have loaded.
    if (range.from !== draft.from || range.to !== draft.to) setRange({ from: draft.from, to: draft.to });
  }, [draft, range]);

  const [comment, setComment] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<'preview' | 'print' | null>(null);
  // Lines added on this screen, until the server has them.
  const [added, setAdded] = useState<readonly EditableLine[]>([]);
  // The day blocks opened (TS-DAY-1): every day starts closed.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const openDay = (date: string, open = true) =>
    setOpened((current) => {
      const next = new Set(current);
      if (open) next.add(date);
      else next.delete(date);
      return next;
    });

  // Only the working sheet: a line in a current submission is on My Monthly Forms, never here.
  // FORM-LIFECYCLE-1: nor a line of the completed timesheet — it is locked and waits on My Monthly Forms.
  const serverLines = (lines.data ?? []).filter((line) => line.submitted === null && (line.completed ?? null) === null);
  // Every line the server has — a submitted one included, so a line added here and submitted elsewhere is not drawn again as new.
  const known = new Set((lines.data ?? []).map((line) => line.id));
  // The server's lines, then those added here: shown while they wait to be saved or once saved (until the reload brings them).
  const addedHere = added.filter((line) => !known.has(line.id) && (saver?.pendingFor(line.id) != null || saver?.revisionOf(line.id) != null));
  const shownIds = new Set([...known, ...addedHere.map((line) => line.id)]);
  // A line added on this device and still waiting in its queue (offline, refused, or from before a reload) is shown, so it can be fixed or removed.
  const queued: EditableLine[] = (saver?.newLines() ?? [])
    .filter((change) => !shownIds.has(change.id))
    .map((change) => ({
      id: change.id,
      date: change.date,
      typed: change.typed,
      revision: null,
      complete: false,
      problems: [],
      historical: { normalHours: 0, callouts: 0 },
      submitted: null,
    }));
  /*
   * Each line where it is now: a day moved on this device shows its lines on the new date at once, before the
   * server has answered, so a line is never typed into under the day it is leaving.
   */
  const all: readonly EditableLine[] = [...serverLines, ...addedHere, ...queued]
    .filter((line) => saver?.pendingFor(line.id)?.kind !== 'remove')
    .map((line) => {
      const shown = shownLine(line, saver);
      return shown.date === line.date ? line : { ...line, date: shown.date };
    });

  const addLine = (date: string) => {
    const line: EditableLine = {
      id: newLineId(),
      date,
      typed: emptyTimesheetLineTyped(),
      revision: null,
      complete: false,
      problems: [],
      historical: { normalHours: 0, callouts: 0 },
      submitted: null,
    };
    setAdded((current) => [...current, line]);
    saver?.change({ kind: 'line', id: line.id, date, typed: line.typed, base: null }, 0);
    openDay(date);
  };

  const from = usable ? range!.from : today;
  const to = usable ? range!.to : today;

  /** Change date (TS-DAY-1): every line of the day to the new date, each saved as it is now. */
  const moveDay = (date: string, target: string, dayLines: readonly EditableLine[]) => {
    for (const line of dayLines) {
      saver?.change({ kind: 'line', id: line.id, date: target, typed: shownLine(line, saver).typed, base: line.revision }, 0);
    }
    openDay(date, false);
    if (target >= from && target <= to) openDay(target);
  };
  const inside = all.filter((line) => line.date !== null && from <= line.date && line.date <= to);
  const undated = all.filter((line) => line.date === null);
  /*
   * A refused change to a line this page does not draw — submitted meanwhile from another device, say — would
   * otherwise wait for ever with nowhere to undo it: it is listed, with what was typed, to be discarded.
   */
  const drawn = new Set(all.map((line) => line.id));
  const stranded = (saver?.refusedChanges() ?? []).filter((change) => change.kind !== 'comment' && !drawn.has(change.id) && !(lines.data ?? []).some((line) => line.id === change.id && line.submitted === null));
  const outside = all.filter((line) => line.date !== null && (line.date < from || line.date > to));
  const byDay = groupByDay(inside, (line) => line.date);
  const drafts = inside.filter((line) => !line.complete || saver?.pendingFor(line.id) !== null).length;
  const completeInside = inside.filter((line) => line.complete);
  const total = (pick: (line: EditableLine) => number) => completeInside.reduce((sum, line) => sum + pick(line), 0);
  const savedComment = sheet.data?.comment ?? '';
  const pendingComment = saver?.pendingFor(COMMENT_KEY);
  const shownComment = comment ?? (pendingComment?.kind === 'comment' ? pendingComment.comment : savedComment);

  const document = useQuery(`timesheets:period-doc:${personId ?? 'none'}:${from}:${to}:${lines.data?.length ?? 0}:${saver?.unsavedCount ?? 0}`, () =>
    personId === null || !usable ? Promise.resolve(null) : payroll.periodDocument<TimesheetDocument>(personId, 'timesheet', from, to),
  );

  const status = saver?.state() ?? { kind: 'idle' as const };
  const awaiting = completed.data?.timesheet ?? null;
  /** Which form holds a locked date, in words — only a COMPLETED timesheet locks its dates (FORM-LIFECYCLE-1). */
  const lockedByOf = (date: string): string | undefined =>
    awaiting !== null && awaiting.from <= date && date <= awaiting.to ? formatPeriod(awaiting.from, awaiting.to) : undefined;
  /*
   * REPEATED DATES (REPEAT-DATES-1, the owner, 7 November 2026). The chosen dates may share days with a timesheet
   * already submitted: allowed — this is its own timesheet, tracked separately, and a line already submitted is
   * never in it again. Said once at the top (with the suggested start, only a suggestion), and on each day that
   * already has submitted lines, naming them, so the same work is not typed twice by mistake.
   */
  const sentInRange = usable ? (sheet.data?.submissions ?? []).filter((submission) => submission.current && submission.from <= to && from <= submission.to) : [];
  const startAfterSent = sentInRange.reduce<string | null>((latest, submission) => (latest === null || submission.to > latest ? submission.to : latest), null);
  const alsoSubmittedOf = (date: string): string | undefined => {
    const held = (lines.data ?? []).filter((line) => line.submitted !== null && line.date === date && line.entry !== null);
    if (held.length === 0) return undefined;
    const periods = [...new Map(held.map((line) => [line.submitted!.periodId, line.submitted!])).values()];
    const names = [...new Set(held.map((line) => (line.entry!.workshop ? 'Workshop' : line.entry!.customerName || 'no customer')))];
    return `Already submitted for this date, in your timesheet ${periods.map((period) => formatPeriod(period.from, period.to)).join('; ')}: ${names.join(', ')}. Those lines stay exactly as submitted and are not in this timesheet — add a line here only for other work.`;
  };
  const lockOf = (date: string): 'completed' | null => (awaiting !== null && awaiting.from <= date && date <= awaiting.to ? 'completed' : null);
  /*
   * COMPLETED (FORM-LIFECYCLE-1). Offered once everything typed is on the server; the dialog asks the server what
   * stops it. Completed, the timesheet leaves this page: it is locked and moved to My Monthly Forms, and the page
   * opens on the next period, clean.
   */
  const [completing, setCompleting] = useState(false);
  const [justCompleted, setJustCompleted] = useState<{ readonly fileName: string; readonly periodLabel: string } | null>(null);
  const unsaved = (saver?.unsavedCount ?? 0) > 0;
  // A refusal may mean the line changed state elsewhere (submitted, removed): the lines are read again, so the
  // page shows what is so — and a change it can no longer draw is listed to be discarded.
  useEffect(() => {
    if (status.kind === 'failed') refresh();
  }, [status.kind, refresh]);

  return (
    <>
      <PageHeader
        title="Timesheets"
        description={
          keeps
            ? 'Your timesheet, like the paper one: open a day and add a line for each customer, site or Workshop. Every change saves by itself. When the period is done, press Completed — the timesheet is locked and moves to My Monthly Forms, where you submit it to the office with your attendance.'
            : 'Every technician keeps their own timesheet and submits it on My Monthly Forms.'
        }
      />
      {!keeps && (
        <p role="status" className="mb-4 text-sm text-steel-600" data-testid="timesheet-not-required">
          The Office does not complete a timesheet — only attendance. Everybody&apos;s submitted timesheets are on{' '}
          <a href="/payroll" className="font-medium text-eje-700 underline">EJE Monthly Forms</a>.
        </p>
      )}

      {personId !== null && (
        <>
          {/* The first block: the period's From and To, top-right — as on Attendance. */}
          <Card className="mb-5" data-testid="timesheet-filters">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-steel-900">Period</p>
                <p className="text-xs text-steel-500">Choose the days to show — across months and years if you need. Your timesheet is submitted on My Monthly Forms.</p>
              </div>
              {range !== null && (
                <div className="flex flex-wrap items-end gap-3" data-testid="timesheet-range">
                  <TextField
                    label="From"
                    type="date"
                    value={range.from}
                    max={range.to}
                    onChange={(event) => event.target.value.length > 0 && choose({ from: event.target.value, to: range.to })}
                    containerClassName="w-44"
                    data-testid="timesheet-from"
                  />
                  <TextField
                    label="To"
                    type="date"
                    value={range.to}
                    min={range.from}
                    onChange={(event) => event.target.value.length > 0 && choose({ from: range.from, to: event.target.value })}
                    containerClassName="w-44"
                    data-testid="timesheet-to"
                  />
                </div>
              )}
            </div>
            {range !== null && !usable && (
              <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="timesheet-range-problem">
                Choose a From on or before the To, at most {TIMESHEET_RANGE_MAX_DAYS} days.
              </p>
            )}
          </Card>

          {usable && (
            <DocumentPreviewDialog
              open={previewing !== null}
              autoPrint={previewing === 'print'}
              allowDownload={false}
              title={`Time Sheet — ${formatPeriod(from, to)}`}
              description="Your timesheet for these dates as it stands. Looking at it saves and sends nothing; it is submitted on My Monthly Forms."
              loadPdf={() => payroll.periodPdf(personId, 'timesheet', from, to, 'Timesheet.pdf')}
              renderHtml={() => (document.data === null || document.data === undefined ? null : <TimesheetDocumentView document={document.data} />)}
              onClose={() => setPreviewing(null)}
            />
          )}

          {sheet.error !== null ? (
            <QueryFailure code={sheet.errorCode} message={sheet.error} onRetry={sheet.refetch} />
          ) : lines.error !== null ? (
            <QueryFailure code={lines.errorCode} message={lines.error} onRetry={lines.refetch} />
          ) : sheet.data === null || sheet.data === undefined || lines.data === null || lines.data === undefined || range === null ? (
            <LoadingPanel rows={5} label="Loading your timesheet" />
          ) : (
            <>
              {usable && (
                <Card className="mb-5" data-testid="timesheet-period">
                  <p className="text-sm font-semibold text-steel-900" data-testid="timesheet-period-label">
                    Timesheet period: {formatPeriod(from, to)} · {daysInPeriod(from, to)} day{daysInPeriod(from, to) === 1 ? '' : 's'} · <strong>{completeInside.length}</strong> line{completeInside.length === 1 ? '' : 's'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="timesheet-totals">
                    <span>OT <strong className="tabular-nums">{total((line) => parseTyped(line.typed.overtime)).toFixed(2)}</strong></span>
                    <span>D/T <strong className="tabular-nums">{total((line) => parseTyped(line.typed.double)).toFixed(2)}</strong></span>
                    <span>Callout <strong className="tabular-nums">{formatCurrency(total((line) => randToCents(line.typed.callout)))}</strong></span>
                    <span>Int Km <strong className="tabular-nums">{total((line) => parseTyped(line.typed.internalKm)).toFixed(1)}</strong></span>
                    <span>Cust Km <strong className="tabular-nums">{total((line) => parseTyped(line.typed.customerKm)).toFixed(1)}</strong></span>
                  </div>
                  {drafts > 0 && (
                    <p className="mt-2 text-sm text-amber-eje-700" data-testid="timesheet-drafts">
                      {drafts} line{drafts === 1 ? ' is' : 's are'} not complete yet (or still saving). Drafts are kept, but they are not on the PDF, and the timesheet cannot be completed until each is finished or removed.
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('preview')} data-testid="timesheet-preview">
                      Preview
                    </Button>
                    <Button variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('print')} data-testid="timesheet-print">
                      Print
                    </Button>
                    <ButtonLink href="/payroll/mine" variant="secondary" data-testid="timesheet-to-monthly-forms">
                      My Monthly Forms
                    </ButtonLink>
                    <Button
                      leadingIcon={<Icon name="check" className="size-4" />}
                      disabled={unsaved || saver === null}
                      onClick={() => {
                        setJustCompleted(null);
                        setCompleting(true);
                      }}
                      data-testid="timesheet-complete"
                    >
                      Completed
                    </Button>
                  </div>
                  {unsaved && (
                    <p className="mt-2 text-xs text-steel-600" data-testid="timesheet-complete-wait">
                      Completed is offered once every change is saved.
                    </p>
                  )}
                </Card>
              )}

              {draft !== null && (
                <div className="mb-5 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 p-3 text-sm text-steel-800" role="note" data-testid="timesheet-correction-draft">
                  <p className="font-semibold">Correction draft — timesheet for {draft.periodLabel}</p>
                  <p className="mt-1">
                    You withdrew “{draft.withdrawnFileName}” to correct it. It is kept on My Monthly Forms exactly as it was completed; this is a
                    separate draft with the same lines. Correct it here, then press <strong>Completed</strong> for {draft.periodLabel} — only the
                    completed correction can be submitted to the office.
                  </p>
                  {(range?.from !== draft.from || range?.to !== draft.to) && (
                    <Button className="mt-2" size="sm" variant="secondary" onClick={() => choose({ from: draft.from, to: draft.to })} data-testid="timesheet-correction-draft-dates">
                      Show {draft.periodLabel}
                    </Button>
                  )}
                </div>
              )}
              {justCompleted !== null && (
                <p role="status" className="mb-5 rounded-[var(--radius-control)] border border-verdant-200 bg-verdant-50 px-3 py-2 text-sm text-verdant-700" data-testid="timesheet-completed-notice">
                  Your timesheet “{justCompleted.fileName}” for {justCompleted.periodLabel} is completed and locked. It is on{' '}
                  <a href="/payroll/mine" className="font-medium underline">My Monthly Forms</a>, waiting to be submitted to the office with your attendance.
                </p>
              )}
              {usable && (
                <CompleteFormDialog
                  open={completing}
                  userId={personId}
                  kind="timesheet"
                  from={from}
                  to={to}
                  onCancel={() => setCompleting(false)}
                  onCompleted={(form) => {
                    setCompleting(false);
                    setJustCompleted({ fileName: form.fileName, periodLabel: form.periodLabel });
                    setOpened(new Set());
                    // A clean workspace for the next period: the day after it, to today.
                    void payroll.completed(personId).then((state) => choose(state.next), () => undefined);
                    refresh();
                  }}
                />
              )}
              <datalist id="timesheet-customer-options">
                <option value="Workshop" />
                {(customers.data ?? []).map((customer) => (
                  <option key={customer.id} value={customer.name} />
                ))}
              </datalist>

              <Card className="mb-5" data-testid="timesheet-sheet">
                <h2 className="text-base font-semibold text-steel-900">Your timesheet</h2>
                <p className="mt-1 text-sm text-steel-600">Open a day (Edit) to add or change its lines — one line for each customer, site or Workshop. A day&apos;s figures are its lines added up.</p>

                {/* Part of the page, not pinned: it scrolls away with the page; each line and day says its own state. */}
                <div className="mt-3">
                  <AutosaveStatus
                    state={status}
                    onRetry={() => saver?.retry()}
                    conflict={conflict}
                    onDismissConflict={dismissConflict}
                    idleText="Every change saves by itself as you type — there is no Save or Submit button on this page."
                  />
                </div>

                {/* TS-CALLOUT-2 (3 November 2026): no Shared tick — the amount IS the technician's own share. */}
                <p className="mt-2 text-sm text-steel-700" data-testid="timesheet-callout-hint">
                  Callout (R): enter only YOUR share of the call-out (e.g. R500 of a R1 000 call-out shared by two). Nothing is divided automatically.
                  Hours to two decimals (1.5 = an hour and a half); kilometres to one decimal.
                </p>

                {outside.length > 0 && (
                  <p className="mt-3 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50 px-3 py-2 text-sm text-steel-700" data-testid="timesheet-outside">
                    {outside.length} line{outside.length === 1 ? ' is' : 's are'} dated outside {formatPeriod(from, to)} ({[...new Set(outside.map((line) => line.date!))].sort().slice(0, 4).map(formatDayAndDate).join(', ')}{outside.length > 4 ? ', …' : ''}). Nothing is lost:
                    {' '}
                    <button
                      type="button"
                      className="font-medium text-eje-700 underline"
                      onClick={() => {
                        const dates = outside.map((line) => line.date!).sort();
                        choose({ from: dates[0]! < from ? dates[0]! : from, to: dates.at(-1)! > to ? dates.at(-1)! : to });
                      }}
                      data-testid="timesheet-show-outside"
                    >
                      show those dates too
                    </button>
                    .
                  </p>
                )}

                {stranded.length > 0 && (
                  <div role="alert" className="mt-3 space-y-2 rounded-[var(--radius-control)] border border-signal-200 bg-signal-50 px-3 py-2 text-sm text-signal-700" data-testid="timesheet-stranded">
                    {stranded.map((change) => (
                      <div key={change.id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1">
                          Not saved: {change.kind === 'line' ? `a change to a line of ${change.date === null ? 'no date' : formatDayAndDate(change.date)}` : 'a removal'} — {change.refused} That line is no longer on this page (it was submitted, or removed, elsewhere).
                        </span>
                        <Button size="sm" variant="secondary" onClick={() => saver?.discard(change.id)} data-testid="timesheet-stranded-discard">
                          Discard this change
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {undated.length > 0 && (
                  <div className="mt-4" data-testid="timesheet-undated">
                    <p className="text-sm font-semibold text-amber-eje-700">Lines with no date</p>
                    <ul className="mt-2 space-y-2">
                      {undated.map((line) => (
                        <TimesheetLineEditor key={line.id} line={line} customers={customers.data ?? []} saver={saver} />
                      ))}
                    </ul>
                  </div>
                )}

                {sentInRange.length > 0 && startAfterSent !== null && (
                  <div className="mt-4 rounded-[var(--radius-control)] border border-eje-200 bg-eje-50 p-3 text-sm text-steel-800" role="note" data-testid="timesheet-sent-overlap">
                    <p>
                      These dates share days with {sentInRange.length === 1 ? 'your submitted timesheet' : 'your submitted timesheets'}{' '}
                      {sentInRange.map((submission) => submission.label).join('; ')}. That is allowed: this is a separate timesheet, and
                      each submission is tracked on its own. Lines you already submitted stay exactly as they went and are not
                      included again.
                    </p>
                    {addDaysIso(startAfterSent, 1) <= to && (
                      <Button className="mt-2" size="sm" variant="ghost" onClick={() => choose({ from: addDaysIso(startAfterSent, 1), to })} data-testid="timesheet-start-after-sent">
                        Suggestion: start on {formatDayAndDate(addDaysIso(startAfterSent, 1))}
                      </Button>
                    )}
                  </div>
                )}

                {usable && (
                  <ol className="mt-4 divide-y divide-steel-100" data-testid="timesheet-days">
                    {daysOf(from, to).map((date) => {
                      const ofDay = byDay.get(date) ?? [];
                      return (
                        <TimesheetDay
                          key={date}
                          date={date}
                          lines={ofDay}
                          open={opened.has(date)}
                          onToggle={() => openDay(date, !opened.has(date))}
                          onAdd={() => addLine(date)}
                          onMove={(target) => moveDay(date, target, ofDay)}
                          locked={lockOf(date)}
                          lockedBy={lockedByOf(date)}
                          alsoSubmitted={alsoSubmittedOf(date)}
                          customers={customers.data ?? []}
                          saver={saver}
                        />
                      );
                    })}
                  </ol>
                )}

                <div className="mt-4">
                  <TextAreaField
                    label="Comments"
                    value={shownComment}
                    maxLength={2000}
                    rows={3}
                    hint="One comment for this timesheet, printed in its Comments box. It saves by itself."
                    onChange={(event) => {
                      setComment(event.target.value);
                      saver?.change({ kind: 'comment', comment: event.target.value, base: savedComment }, 900);
                    }}
                    onBlur={() => saver?.flushNow()}
                    data-testid="timesheet-period-comment"
                  />
                </div>
              </Card>

            </>
          )}
        </>
      )}

    </>
  );
};

export default TimesheetsPage;
