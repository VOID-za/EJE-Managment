'use client';

import { useCallback, useEffect, useState } from 'react';
import { can, completesTimesheet } from '@/domain';
import { Badge, Button, ButtonLink, Card, Icon, LoadingPanel, QueryFailure, TextAreaField, TextField } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { AutosaveStatus } from '@/components/attendance/AutosaveStatus';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { TimesheetLineEditor, type EditableLine } from '@/components/timesheets/TimesheetLineEditor';
import { TimesheetSubmissions } from '@/components/timesheets/TimesheetSubmissions';
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
 * 5 November 2026), on TS-PAPER (docs/payroll-forms.md).
 *
 * The same page as Attendance: the period's From and To top-right, then the
 * period with Preview and Print, then every day of the period, oldest first,
 * with its lines — typed straight into the line, as many a day as needed,
 * Workshop or a customer or neither. Every change saves itself (Saving…,
 * Saved, Save failed + Retry — never "Saved" before the server said so). A
 * line not complete yet is kept on the server as a Draft and says what it
 * needs. There is NO Submit here: the timesheet is submitted with the
 * attendance, for the same From and To, on My Monthly Forms.
 *
 * Kept: Workshop/customer, OT, D/T, call-out amount, internal and customer km,
 * historical NT and call-out counts, the one comment, the submitted timesheets
 * and their corrections, the office's list of everybody's submissions.
 */
const TimesheetsPage = () => {
  const user = useCurrentUser();
  const keeps = completesTimesheet(user.role);
  const office = can(user.role, 'timesheets.viewAll');
  const personId = keeps ? user.id : null;
  const today = businessToday();

  const sheet = useQuery(`timesheets:working:${personId ?? 'none'}`, () => (personId === null ? Promise.resolve(null) : timesheets.working(personId)));
  const lines = useQuery(`timesheets:lines:${personId ?? 'none'}`, () => (personId === null ? Promise.resolve(null) : timesheets.lines(personId)));
  const everybody = useQuery(`timesheets:submissions:all:${office ? 'yes' : 'no'}`, () => (office ? timesheets.submissions() : Promise.resolve(null)));
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

  const serverLines = lines.data ?? [];
  const known = new Set(serverLines.map((line) => line.id));
  // The server's lines, then those added here: shown while they wait to be saved or once saved (until the reload brings them).
  const all: readonly EditableLine[] = [
    ...serverLines,
    ...added.filter((line) => !known.has(line.id) && (saver?.pendingFor(line.id) != null || saver?.revisionOf(line.id) != null)),
  ].filter((line) => saver?.pendingFor(line.id)?.kind !== 'remove');

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
  };

  const from = usable ? range!.from : today;
  const to = usable ? range!.to : today;
  const inside = all.filter((line) => line.date !== null && from <= line.date && line.date <= to);
  const undated = all.filter((line) => line.date === null);
  const outside = all.filter((line) => line.date !== null && (line.date < from || line.date > to) && line.submitted === null);
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

  return (
    <>
      <PageHeader
        title="Timesheets"
        description={
          keeps
            ? 'Your timesheet, like the paper one. Type your lines as you go — every change saves by itself. Submit it with your attendance on My Monthly Forms.'
            : 'Every technician keeps their own timesheet and submits it on My Monthly Forms. Their submissions are below.'
        }
      />
      {!keeps && (
        <p role="status" className="mb-4 text-sm text-steel-600" data-testid="timesheet-not-required">
          The Office does not complete a timesheet — only attendance.
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

              <AutosaveStatus
                state={status}
                onRetry={() => saver?.retry()}
                conflict={conflict}
                onDismissConflict={dismissConflict}
                idleText="Every change saves by itself as you type — there is no Save or Submit button on this page."
              />

              <Card className="mb-5" data-testid="timesheet-sheet">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold text-steel-900">Your timesheet</h2>
                    <p className="text-sm text-steel-600" data-testid="timesheet-last-submission">
                      {sheet.data.lastSubmission === null
                        ? 'You have not submitted a timesheet yet.'
                        : `Last submitted: ${formatPeriod(sheet.data.lastSubmission.from, sheet.data.lastSubmission.to)}.`}
                    </p>
                  </div>
                  <Button
                    onClick={() => addLine(today >= from && today <= to ? today : to)}
                    leadingIcon={<Icon name="plus" className="size-4" />}
                    disabled={saver === null}
                    data-testid="add-timesheet-line"
                  >
                    Add line
                  </Button>
                </div>

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

                {undated.length > 0 && (
                  <div className="mt-4" data-testid="timesheet-undated">
                    <p className="text-sm font-semibold text-amber-eje-700">Lines with no date</p>
                    <ul className="mt-2 space-y-2">
                      {undated.map((line) => (
                        <TimesheetLineEditor key={line.id} line={line} customers={customers.data ?? []} saver={saver} editable />
                      ))}
                    </ul>
                  </div>
                )}

                {usable && (
                  <ol className="mt-4 divide-y divide-steel-100" data-testid="timesheet-days">
                    {daysOf(from, to).map((date) => {
                      const ofDay = inside.filter((line) => line.date === date);
                      const submittedDay = sheet.data!.submissions.find((submission) => submission.current && submission.from <= date && date <= submission.to);
                      return (
                        <li key={date} className="py-2" data-testid="timesheet-day" data-date={date}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium text-steel-900">
                              {formatDayAndDate(date)}
                              {submittedDay !== undefined && (
                                <span className="ml-2"><Badge tone="green" size="sm">Submitted</Badge></span>
                              )}
                            </span>
                            <Button size="sm" variant="ghost" leadingIcon={<Icon name="plus" className="size-4" />} disabled={saver === null} onClick={() => addLine(date)} data-testid={`add-timesheet-line-${date}`}>
                              Add line
                            </Button>
                          </div>
                          {ofDay.length > 0 && (
                            <ul className="mt-2 space-y-2" data-testid="timesheet-table">
                              {ofDay.map((line) => (
                                <TimesheetLineEditor key={line.id} line={line} customers={customers.data ?? []} saver={saver} editable />
                              ))}
                            </ul>
                          )}
                        </li>
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

              <Card className="mb-5">
                <h2 className="mb-2 text-base font-semibold text-steel-900">Your submitted timesheets</h2>
                <TimesheetSubmissions
                  user={user}
                  submissions={sheet.data.submissions}
                  loading={false}
                  error={null}
                  onRetry={sheet.refetch}
                  showTechnician={false}
                  customers={customers.data ?? []}
                  onChanged={refresh}
                />
              </Card>
            </>
          )}
        </>
      )}

      {office && (
        <Card data-testid="timesheet-office">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-steel-900">Submitted timesheets — every technician</h2>
            <Badge tone="outline" size="sm">Office</Badge>
          </div>
          <p className="mb-3 text-sm text-steel-600">Each technician submits their own, with their attendance, on My Monthly Forms. Open one to read it exactly as submitted, download its PDF or export its lines.</p>
          <TimesheetSubmissions
            user={user}
            submissions={everybody.data ?? null}
            loading={everybody.loading}
            error={everybody.error}
            errorCode={everybody.errorCode}
            onRetry={everybody.refetch}
            showTechnician
            customers={customers.data ?? []}
            onChanged={() => everybody.refetch()}
          />
        </Card>
      )}
    </>
  );
};

export default TimesheetsPage;
