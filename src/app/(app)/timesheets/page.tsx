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

  const refresh = useCallback(() => {
    lines.refetch();
    sheet.refetch();
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

  const [comment, setComment] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<'preview' | 'print' | null>(null);
  // Lines added on this screen, until the server has them.
  const [added, setAdded] = useState<readonly EditableLine[]>([]);
  // The day blocks opened (TS-DAY-1): every day starts closed.
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  // Sent from My Monthly Forms to fix lines (`fix=1`): the days holding a line not complete yet open, once.
  const fixChecked = useRef(false);
  useEffect(() => {
    if (fixChecked.current || lines.data === null || lines.data === undefined) return;
    fixChecked.current = true;
    if (new URLSearchParams(window.location.search).get('fix') !== '1') return;
    const days = lines.data.filter((line) => line.submitted === null && !line.complete && line.date !== null).map((line) => line.date!);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the days to fix are known once the lines have loaded.
    setOpened(new Set(days));
  }, [lines.data]);
  const openDay = (date: string, open = true) =>
    setOpened((current) => {
      const next = new Set(current);
      if (open) next.add(date);
      else next.delete(date);
      return next;
    });

  // Only the working sheet: a line in a current submission is on My Monthly Forms, never here.
  const serverLines = (lines.data ?? []).filter((line) => line.submitted === null);
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
            ? 'Your timesheet, like the paper one: open a day and add a line for each customer, site or Workshop. Every change saves by itself. Submit it with your attendance on My Monthly Forms, where your submitted timesheets are kept.'
            : 'Every technician keeps their own timesheet and submits it on My Monthly Forms.'
        }
      />
      {!keeps && (
        <p role="status" className="mb-4 text-sm text-steel-600" data-testid="timesheet-not-required">
          The Office does not complete a timesheet — only attendance. Everybody&apos;s submitted timesheets are on{' '}
          <a href="/payroll/mine" className="font-medium text-eje-700 underline">My Monthly Forms</a>.
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
                      {drafts} line{drafts === 1 ? ' is' : 's are'} not complete yet (or still saving). Drafts are kept, but they are not on the PDF and the forms cannot be submitted until each is completed or removed.
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('preview')} data-testid="timesheet-preview">
                      Preview
                    </Button>
                    <Button variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('print')} data-testid="timesheet-print">
                      Print
                    </Button>
                    <ButtonLink href={`/payroll/mine?from=${from}&to=${to}`} variant="secondary" data-testid="timesheet-to-monthly-forms">
                      Review and submit on My Monthly Forms
                    </ButtonLink>
                  </div>
                </Card>
              )}

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
                          submitted={sheet.data!.submissions.some((submission) => submission.current && submission.from <= date && date <= submission.to)}
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
