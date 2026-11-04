'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { WORKSHOP_LABEL, can, completesTimesheet } from '@/domain';
import { Badge, Button, Card, ConfirmDialog, Icon, LoadingPanel, QueryFailure, TextAreaField, TextField } from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { TimesheetLineForm } from '@/components/timesheets/TimesheetLineForm';
import { TimesheetSubmissions } from '@/components/timesheets/TimesheetSubmissions';
import { useUnsavedWork } from '@/hooks/useUnsavedWork';
import { reads, timesheets } from '@/api/endpoints';
import type { WorkingTimesheetEntry } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useApp, useCurrentUser } from '@/providers/AppProvider';
import { ApiRequestError } from '@/api/client';
import { businessToday } from '@/lib/business-time';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { daysInPeriod, formatDayAndDate, formatPeriod, lineDateProblem, timesheetRangeProblem } from '@/lib/timesheet-dates';
import {
  WORKSHOP_PICK,
  emptyTimesheetDraft,
  keepTimesheetDraft,
  keptTimesheetDraft,
  parseTyped,
  randToCents,
  timesheetDraftKey,
  timesheetDraftOf,
  type TimesheetDraft,
} from '@/lib/timesheet-line';

const hours = (value: number): string => value.toFixed(2);
const kilometres = (value: number): string => value.toFixed(1);
/** One line's columns on a wide screen: date, customer, the five numbers, the buttons. */
const LINE_GRID = 'lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_repeat(5,minmax(0,0.7fr))_auto]';

/** A number of a line: right-aligned in its column on a wide screen, labelled on a phone. */
const LineValue = ({ label, value }: { readonly label: string; readonly value: string }) => (
  <div className="flex justify-between gap-2 lg:block lg:text-right">
    <span className="text-xs text-steel-500 lg:hidden">{label}</span>
    <span className="tabular-nums">{value}</span>
  </div>
);

/**
 * TIMESHEETS — A DIGITAL PIECE OF PAPER. TS-PAPER (the owner, 4 November 2026):
 * "The technician maintains it. The technician submits it on payday. EJE
 * records and preserves it." (docs/timesheets-paper.md)
 *
 *  1. YOUR TIMESHEET: every line you have written and not yet submitted — any
 *     date, past or future, several a day, Workshop or a customer or neither —
 *     with one comment. Add, correct and remove lines at any time; leave and
 *     come back. Nothing closes at month end and nothing starts on the 1st.
 *  2. SUBMIT: on payday confirm From (the day after your last submission) and
 *     To (payday — whatever day it really is) and press Submit timesheet. The
 *     lines in those dates and the comment are kept exactly as sent; lines
 *     outside them stay for the next sheet, which starts the day after To.
 *  3. SUBMITTED TIMESHEETS: yours, as sent; changed only by a correction the
 *     office decides. The office sees everybody's, previews, downloads the PDF
 *     and exports the lines.
 *
 * Kept from before: the line form in its own state (typing never re-renders
 * the page — TST-TS-2 #1), an open line kept on the device across a reload
 * (#4), the refusal said at the line (#3), and a warning before leaving with
 * something typed.
 */
const TimesheetsPage = () => {
  const user = useCurrentUser();
  const operation = useOperation();
  const { invalidate, reportConnectionError } = useApp();
  const keeps = completesTimesheet(user.role);
  const office = can(user.role, 'timesheets.viewAll');
  const personId = keeps ? user.id : null;
  const today = businessToday();

  const sheet = useQuery(`timesheets:working:${personId ?? 'none'}`, () =>
    personId === null ? Promise.resolve(null) : timesheets.working(personId),
  );
  const everybody = useQuery(`timesheets:submissions:all:${office ? 'yes' : 'no'}`, () =>
    office ? timesheets.submissions() : Promise.resolve(null),
  );
  const customers = useQuery('timesheets:customers', () => reads.customers());

  // The open line (its own component holds the typing; the page keeps a copy in a ref).
  const [open, setOpen] = useState<{ readonly key: number; readonly correcting: boolean } | null>(null);
  const draft = useRef<TimesheetDraft | null>(null);
  const openings = useRef(0);
  const [lineDirty, setLineDirty] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
  const restoredFor = useRef<string | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WorkingTimesheetEntry | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [previewing, setPreviewing] = useState<'preview' | 'print' | null>(null);
  // The submission's dates: null until the person changes them, so they follow the proposal.
  const [chosenFrom, setChosenFrom] = useState<string | null>(null);
  const [chosenTo, setChosenTo] = useState<string | null>(null);

  const data = sheet.data ?? null;
  const editable = data?.editable === true;
  const from = chosenFrom ?? data?.suggested.from ?? today;
  const to = chosenTo ?? data?.suggested.to ?? today;
  const rangeProblem = timesheetRangeProblem(from, to);
  const savedComment = data?.comment ?? '';
  const commentDirty = comment !== null && comment !== savedComment;
  const storageKey = personId === null ? null : timesheetDraftKey(user.id, personId);

  const document = useQuery(`timesheets:draft:${personId ?? 'none'}:${from}:${to}:${data === null ? 0 : data.entries.length}`, () =>
    personId === null || rangeProblem !== null ? Promise.resolve(null) : timesheets.document(personId, from, to),
  );

  useUnsavedWork(lineDirty || commentDirty, 'a timesheet line or comment being typed');

  // A line kept on this device is offered back once per visit (TST-TS-2 #4).
  useEffect(() => {
    if (storageKey === null || !editable || restoredFor.current === storageKey) return;
    restoredFor.current = storageKey;
    const kept = keptTimesheetDraft(storageKey);
    if (kept === null) return;
    draft.current = kept.draft;
    openings.current += 1;
    setOpen({ key: openings.current, correcting: kept.draft.entryId !== undefined });
    setLineDirty(true);
    setRestored(`A line you had not saved (kept on this device at ${formatDateTime(kept.keptAt)}) has been put back. Save it or cancel it.`);
  }, [storageKey, editable]);

  const refresh = useCallback(() => {
    invalidate();
    sheet.refetch();
    everybody.refetch();
    // The refetch functions are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeLine = useCallback(() => {
    draft.current = null;
    setOpen(null);
    setLineDirty(false);
    setRestored(null);
    if (storageKey !== null) keepTimesheetDraft(storageKey, null);
  }, [storageKey]);

  const openLine = (next: TimesheetDraft) => {
    draft.current = next;
    openings.current += 1;
    setOpen({ key: openings.current, correcting: next.entryId !== undefined });
    setLineDirty(false);
    setRestored(null);
    setNotice(null);
    setSubmitted(null);
    if (storageKey !== null) keepTimesheetDraft(storageKey, next);
  };
  const currentDraft = useCallback(() => draft.current ?? emptyTimesheetDraft(today), [today]);
  const keepDraft = useCallback((next: TimesheetDraft) => {
    draft.current = next;
  }, []);

  /** Saves the line; the refusal's own words for the form, or null when saved. */
  const sendLine = async (line: TimesheetDraft): Promise<string | null> => {
    if (personId === null) return 'Only your own timesheet can be entered.';
    const dateProblem = lineDateProblem(line.date);
    if (dateProblem !== null) return dateProblem;
    const workshop = line.pick === WORKSHOP_PICK;
    try {
      await timesheets.saveEntry(personId, {
        ...(line.entryId === undefined ? {} : { entryId: line.entryId }),
        date: line.date,
        customerId: workshop || line.pick.length === 0 ? null : line.pick,
        customerName: workshop ? '' : line.customerName,
        workshop,
        ...(line.keepNormal === undefined ? {} : { normalHours: line.keepNormal }),
        ...(line.keepCallouts === undefined ? {} : { callouts: line.keepCallouts }),
        overtimeHours: parseTyped(line.overtime),
        doubleHours: parseTyped(line.double),
        calloutAmount: randToCents(line.callout),
        calloutShared: line.calloutShared,
        internalKm: parseTyped(line.internalKm),
        customerKm: parseTyped(line.customerKm),
      });
    } catch (cause: unknown) {
      if (cause instanceof ApiRequestError) {
        if (cause.code === 'network') reportConnectionError(cause.message);
        const detail = cause.violations.map((violation) => violation.message).join(' ');
        return `${cause.message}${detail.length > 0 ? ` ${detail}` : ''}${cause.code === 'network' ? ' Nothing was lost: the line is still here — press Save line again when there is signal.' : ''}`;
      }
      return cause instanceof Error ? cause.message : 'The line could not be saved.';
    }
    reportConnectionError(null);
    closeLine();
    setNotice(`Line for ${formatDayAndDate(line.date)} saved ${formatDateTime(new Date().toISOString())}. It is on your timesheet; nothing is submitted until you press Submit timesheet.`);
    refresh();
    return null;
  };

  const saveComment = async (): Promise<boolean> => {
    if (personId === null || comment === null || comment === savedComment) return true;
    const typed = comment;
    const ok = await operation.run(async () => {
      await timesheets.saveWorkingComment(personId, typed);
    });
    if (!ok) return false;
    setComment(null);
    setNotice(`Comment saved ${formatDateTime(new Date().toISOString())}.`);
    refresh();
    return true;
  };

  const remove = async (): Promise<void> => {
    if (personId === null || removing === null) return;
    const ok = await operation.run(async () => {
      await timesheets.removeEntry(personId, removing.id);
    });
    setRemoving(null);
    if (ok) refresh();
  };

  const submit = async (): Promise<void> => {
    if (personId === null || rangeProblem !== null) return;
    if (!(await saveComment())) {
      setConfirming(false);
      return;
    }
    const ok = await operation.run(async () => {
      await timesheets.submit(personId, from, to);
    });
    setConfirming(false);
    if (!ok) return;
    const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    setSubmitted(
      `Your timesheet for ${formatPeriod(from, to)} was submitted ${formatDateTime(new Date().toISOString())}. The office has it, exactly as sent. Your next timesheet starts on ${formatDayAndDate(next)}.`,
    );
    setNotice(null);
    setChosenFrom(null);
    setChosenTo(null);
    refresh();
  };

  // What Submit would send: the open lines dated From…To (and what stays behind).
  const entries = data?.entries ?? [];
  const inside = rangeProblem === null ? entries.filter((entry) => from <= entry.date && entry.date <= to) : [];
  const outside = entries.length - inside.length;
  const total = (pick: (entry: WorkingTimesheetEntry) => number) => inside.reduce((sum, entry) => sum + pick(entry), 0);
  const overlapsLast = data?.lastSubmission !== null && data?.lastSubmission !== undefined && rangeProblem === null && from <= data.lastSubmission.to;

  return (
    <>
      <PageHeader
        title="Timesheets"
        description={
          keeps
            ? 'Your timesheet, like the paper one: add your lines as you go or all on payday, then submit it for your pay period.'
            : 'Every technician keeps and submits their own timesheet. Their submissions are below.'
        }
      />
      {!keeps && (
        <p role="status" className="mb-4 text-sm text-steel-600" data-testid="timesheet-not-required">
          The Office does not complete a timesheet — only attendance.
        </p>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove this line?"
        message={removing === null ? '' : `${removing.workshop ? WORKSHOP_LABEL : removing.customerName || 'This line'} on ${formatDayAndDate(removing.date)} will be removed from your timesheet. The removal is recorded.`}
        confirmLabel="Remove line"
        confirmVariant="danger"
        busy={operation.running}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />
      <ConfirmDialog
        open={confirming}
        title={`Submit your timesheet for ${rangeProblem === null ? formatPeriod(from, to) : 'these dates'}?`}
        message={`${inside.length} line${inside.length === 1 ? '' : 's'} from ${rangeProblem === null ? formatPeriod(from, to) : ''} and your comment will be sent to the office and kept exactly as sent.${outside > 0 ? ` ${outside} line${outside === 1 ? '' : 's'} outside these dates stay on your timesheet.` : ''}${overlapsLast ? ' These dates overlap your last submission: this one replaces it for the office (the earlier one is kept).' : ''} After submitting, a change is made by asking for a correction.`}
        confirmLabel="Submit timesheet"
        busy={operation.running}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      />
      {personId !== null && rangeProblem === null && (
        <DocumentPreviewDialog
          open={previewing !== null}
          autoPrint={previewing === 'print'}
          allowDownload={false}
          title={`Time Sheet — ${formatPeriod(from, to)}`}
          description="Preview of what Submit would send for these dates. Looking at it saves and sends nothing."
          loadPdf={() => timesheets.pdf(personId, from, to)}
          renderHtml={() => (document.data === null || document.data === undefined ? null : <TimesheetDocumentView document={document.data} />)}
          onClose={() => setPreviewing(null)}
        />
      )}

      {personId !== null &&
        (sheet.error !== null ? (
          <QueryFailure code={sheet.errorCode} message={sheet.error} onRetry={sheet.refetch} />
        ) : sheet.loading || data === null ? (
          <LoadingPanel rows={5} label="Loading your timesheet" />
        ) : (
          <>
            {submitted !== null && (
              <p role="status" className="mb-4 rounded-[var(--radius-control)] border border-verdant-200 bg-verdant-50 px-3 py-2 text-sm font-medium text-verdant-800" data-testid="timesheet-submitted">
                {submitted}
              </p>
            )}

            <Card className="mb-5" data-testid="timesheet-sheet">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-steel-900">Your timesheet</h2>
                  <p className="text-sm text-steel-600" data-testid="timesheet-last-submission">
                    {data.lastSubmission === null
                      ? 'You have not submitted a timesheet yet.'
                      : `Last submitted: ${formatPeriod(data.lastSubmission.from, data.lastSubmission.to)} (on ${formatDateTime(data.lastSubmission.submittedAt)}).`}
                  </p>
                </div>
                {editable && open === null && (
                  <Button onClick={() => openLine(emptyTimesheetDraft(today))} leadingIcon={<Icon name="plus" className="size-4" />} data-testid="add-timesheet-line">
                    Add line
                  </Button>
                )}
              </div>

              {restored !== null && (
                <p role="status" className="mt-3 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3 py-2 text-sm text-amber-eje-700" data-testid="timesheet-line-restored">
                  {restored}
                </p>
              )}
              {open !== null && (
                <TimesheetLineForm
                  key={open.key}
                  initial={currentDraft}
                  onChange={keepDraft}
                  storageKey={storageKey}
                  customers={customers.data ?? []}
                  customersLoading={customers.loading}
                  onSave={sendLine}
                  onCancel={closeLine}
                  onDirtyChange={setLineDirty}
                />
              )}
              {notice !== null && (
                <p role="status" className="mt-3 text-sm text-verdant-700" data-testid="timesheet-saved">
                  {notice}
                </p>
              )}

              {entries.length === 0 ? (
                <p className="mt-4 text-sm text-steel-500" data-testid="timesheet-empty">
                  No lines yet. Press Add line for each customer — or Workshop — you worked for on a day.
                </p>
              ) : (
                <div className="mt-4">
                  {/* Columns on a large screen; on a tablet or phone each line is its own block, every field labelled — nothing off-screen. */}
                  <div className={`hidden gap-3 border-b border-steel-100 pb-1 text-xs text-steel-500 uppercase lg:grid ${LINE_GRID}`} aria-hidden="true">
                    <span>Date</span>
                    <span>Customer</span>
                    <span className="text-right">OT</span>
                    <span className="text-right">D/T</span>
                    <span className="text-right">Callout</span>
                    <span className="text-right">Int Km</span>
                    <span className="text-right">Cust Km</span>
                    <span />
                  </div>
                  <ul className="divide-y divide-steel-100 text-sm" data-testid="timesheet-table">
                    {entries.map((entry) => {
                      const inDates = rangeProblem === null && from <= entry.date && entry.date <= to;
                      return (
                        <li
                          key={entry.id}
                          className={`grid grid-cols-2 gap-x-4 gap-y-1 py-2 lg:items-start lg:gap-3 ${LINE_GRID}`}
                          data-testid="timesheet-line"
                          data-date={entry.date}
                          data-in-period={inDates ? 'yes' : 'no'}
                        >
                          <div className="col-span-2 lg:col-span-1">
                            <span className="font-medium text-steel-900">{formatDayAndDate(entry.date)}</span>
                            {!inDates && (
                              <span className="mt-0.5 block text-xs text-amber-eje-700">
                                {entry.outsideSubmitted !== null
                                  ? `Not in your submitted ${formatPeriod(entry.outsideSubmitted.from, entry.outsideSubmitted.to)}`
                                  : 'Outside the dates below'}
                              </span>
                            )}
                          </div>
                          <div className="col-span-2 lg:col-span-1">
                            <span className="text-steel-900">{entry.workshop ? WORKSHOP_LABEL : entry.customerName || '—'}</span>
                            {(entry.normalHours > 0 || entry.callouts > 0) && (
                              <span className="mt-0.5 block text-xs text-steel-500">
                                {[
                                  entry.normalHours > 0 ? `NT ${hours(entry.normalHours)} (historical)` : null,
                                  entry.callouts > 0 ? `Call-outs ${entry.callouts} (historical)` : null,
                                ].filter((part) => part !== null).join(' · ')}
                              </span>
                            )}
                          </div>
                          <LineValue label="OT" value={hours(entry.overtimeHours)} />
                          <LineValue label="D/T" value={hours(entry.doubleHours)} />
                          <LineValue label="Callout" value={`${formatCurrency(entry.calloutAmount)}${entry.calloutShared ? ' (shared)' : ''}`} />
                          <LineValue label="Int Km" value={kilometres(entry.internalKm)} />
                          <LineValue label="Cust Km" value={kilometres(entry.customerKm)} />
                          <div className="col-span-2 flex justify-end gap-1 lg:col-span-1">
                            {editable && (
                              <>
                                <Button size="sm" variant="ghost" disabled={open !== null} onClick={() => openLine(timesheetDraftOf(entry))} data-testid="edit-timesheet-line">
                                  Edit
                                </Button>
                                <Button size="sm" variant="ghost" disabled={open !== null} onClick={() => setRemoving(entry)} data-testid="remove-timesheet-line">
                                  Remove
                                </Button>
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>

              )}
              {data.dayComments.map((day) => (
                <p key={day.date} className="mt-2 text-sm whitespace-pre-wrap text-steel-600" data-testid="timesheet-day-comment">
                  <span className="text-xs font-semibold text-steel-500">{formatDayAndDate(day.date)} — day comment (written before one comment per timesheet): </span>
                  {day.comment}
                </p>
              ))}

              {editable && (
                <div className="mt-4">
                  <TextAreaField
                    label="Comments"
                    value={comment ?? savedComment}
                    maxLength={2000}
                    rows={3}
                    hint="One comment for this timesheet. It is printed in the Comments box and sent with it."
                    onChange={(event) => setComment(event.target.value)}
                    data-testid="timesheet-period-comment"
                  />
                  <div className="mt-2">
                    <Button variant="secondary" size="sm" disabled={!commentDirty} loading={operation.running && !confirming} onClick={() => void saveComment()} data-testid="timesheet-save">
                      Save comment
                    </Button>
                  </div>
                </div>
              )}
            </Card>

            {editable && (
              <Card className="mb-5" data-testid="timesheet-submit-card">
                <h2 className="text-base font-semibold text-steel-900">Submit on payday</h2>
                <p className="mt-1 text-sm text-steel-600">
                  Check your lines, confirm the dates of your pay period, and submit. From is the day after your last submission; To is payday — change either if payroll moved.
                </p>
                <div className="mt-3 flex flex-wrap items-end gap-4">
                  <TextField label="From" type="date" value={from} onChange={(event) => setChosenFrom(event.target.value)} containerClassName="w-44" data-testid="timesheet-from" />
                  <TextField label="To" type="date" value={to} onChange={(event) => setChosenTo(event.target.value)} containerClassName="w-44" data-testid="timesheet-to" />
                </div>
                {rangeProblem !== null ? (
                  <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="timesheet-range-problem">
                    {rangeProblem}
                  </p>
                ) : (
                  <>
                    <p className="mt-3 text-sm text-steel-800" data-testid="timesheet-period-label">
                      {formatPeriod(from, to)} · {daysInPeriod(from, to)} day{daysInPeriod(from, to) === 1 ? '' : 's'} · <strong>{inside.length}</strong> line{inside.length === 1 ? '' : 's'}
                      {outside > 0 && <span className="text-steel-500"> ({outside} outside these dates stay on your timesheet)</span>}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="timesheet-totals">
                      <span>OT <strong className="tabular-nums">{hours(total((entry) => entry.overtimeHours))}</strong></span>
                      <span>D/T <strong className="tabular-nums">{hours(total((entry) => entry.doubleHours))}</strong></span>
                      <span>Callout <strong className="tabular-nums">{formatCurrency(total((entry) => entry.calloutAmount))}</strong></span>
                      <span>Int Km <strong className="tabular-nums">{kilometres(total((entry) => entry.internalKm))}</strong></span>
                      <span>Cust Km <strong className="tabular-nums">{kilometres(total((entry) => entry.customerKm))}</strong></span>
                    </div>
                    {overlapsLast && data.lastSubmission !== null && (
                      <p role="status" className="mt-2 text-sm text-amber-eje-700" data-testid="timesheet-period-overlap">
                        These dates overlap your last submission ({formatPeriod(data.lastSubmission.from, data.lastSubmission.to)}). Submitting replaces it for the office; the earlier one is kept. To fix a submitted timesheet instead, use Corrections below.
                      </p>
                    )}
                  </>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" disabled={rangeProblem !== null} leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('preview')} data-testid="timesheet-preview">
                    Preview
                  </Button>
                  <Button variant="secondary" disabled={rangeProblem !== null} leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('print')} data-testid="timesheet-print">
                    Print
                  </Button>
                  <Button disabled={rangeProblem !== null || open !== null} onClick={() => setConfirming(true)} data-testid="timesheet-send">
                    Submit timesheet
                  </Button>
                </div>
                {open !== null && <p className="mt-2 text-xs text-steel-500">Save or cancel the open line first.</p>}
                {operation.error !== null && (
                  <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="timesheet-error">
                    {operation.error}
                  </p>
                )}
              </Card>
            )}

            <Card className="mb-5">
              <h2 className="mb-2 text-base font-semibold text-steel-900">Your submitted timesheets</h2>
              <TimesheetSubmissions
                user={user}
                submissions={data.submissions}
                loading={false}
                error={null}
                onRetry={sheet.refetch}
                showTechnician={false}
                customers={customers.data ?? []}
                onChanged={refresh}
              />
            </Card>
          </>
        ))}

      {office && (
        <Card data-testid="timesheet-office">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-steel-900">Submitted timesheets — every technician</h2>
            <Badge tone="outline" size="sm">Office</Badge>
          </div>
          <p className="mb-3 text-sm text-steel-600">Each technician submits their own. Open one to read it exactly as submitted, download its PDF or export its lines.</p>
          <TimesheetSubmissions
            user={user}
            submissions={everybody.data ?? null}
            loading={everybody.loading}
            error={everybody.error}
            errorCode={everybody.errorCode}
            onRetry={everybody.refetch}
            showTechnician
            customers={customers.data ?? []}
            onChanged={refresh}
          />
        </Card>
      )}
    </>
  );
};

export default TimesheetsPage;
