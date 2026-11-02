'use client';

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ABSENCE_REASON_LABELS, WORKSHOP_LABEL, completesTimesheet, type TimesheetEntry } from '@/domain';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { readRememberedRange, rememberRange } from '@/lib/remembered-range';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { useUnsavedWork } from '@/hooks/useUnsavedWork';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { TimesheetLineForm } from '@/components/timesheets/TimesheetLineForm';
import { reads, timesheets } from '@/api/endpoints';
import { TIMESHEET_MAX_DAYS, type TimesheetDay, type TimesheetDocument } from '@/application/timesheets';
import { useQuery } from '@/hooks/useQuery';
import { useOperation } from '@/hooks/useOperation';
import { useApp, useCurrentUser } from '@/providers/AppProvider';
import { ApiRequestError } from '@/api/client';
import { businessToday } from '@/lib/business-time';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  defaultTimesheetRange,
  formatDayAndDate,
  formatPeriod,
  isCalendarDay,
  lineDateProblem,
  timesheetRangeProblem,
} from '@/lib/timesheet-dates';
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

/**
 * The period the page opens on: the 1st of this month to today — or the
 * From/To in the address, which is how My Monthly Forms' "Edit timesheet"
 * opens exactly its month. Read once, in the browser; the page renders a
 * loading panel on the server, so nothing here can disagree with hydration.
 */
/**
 * WHERE THE PAGE OPENS: a link's dates first (Monthly Forms sends one), then
 * the person's last From/To on this page (FILTER-MEM-1, the tester, 2 November
 * 2026 — was TS-04's "reset on every visit"), then this month to date.
 */
const initialRange = (userId: string, today: string): { readonly from: string; readonly to: string } => {
  const fallback = defaultTimesheetRange(today);
  if (typeof window === 'undefined') return fallback;
  const params = new URLSearchParams(window.location.search);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (isCalendarDay(from) && isCalendarDay(to) && timesheetRangeProblem(from, to, TIMESHEET_MAX_DAYS) === null) {
    return { from, to: to > today ? today : to };
  }
  const remembered = readRememberedRange('timesheets', userId, TIMESHEET_MAX_DAYS);
  return remembered !== null && timesheetRangeProblem(remembered.from, remembered.to, TIMESHEET_MAX_DAYS) === null ? remembered : fallback;
};

/**
 * TECHNICIAN TIMESHEETS. TIMESHEET-2 (27 October 2026), reshaped by the
 * real-world reviewer on 28 October 2026 (TS-01 … TS-14).
 *
 * Each person keeps their own: for each day, the customer — or Workshop —
 * overtime (OT), double time (DT), the call-out as a rand amount (marked shared
 * when several jobs share it), internal and customer kilometres. NT is no
 * longer entered; older lines keep theirs, shown as historical.
 *
 * THE FROM AND TO DATES ARE THE TIMESHEET PERIOD (the owner, 28 October 2026).
 * The page opens on the 1st of this month to today, OLDEST DAY FIRST. The
 * period's one comment, Preview, Save, Print and Send to office act on exactly
 * those dates: Send to office makes that period read-only, the office is
 * notified and reads the version that was sent. A period that shares a day
 * with one already sent cannot be sent, so no work is sent twice.
 *
 * A SENT TIMESHEET IS CORRECTED, NOT EDITED (TS-16).
 *
 * TST-TS-2 (the tester, 31 October 2026 — "still broken when users fill it
 * in"), found by reproducing it through the screen on desktop, tablet and
 * phone:
 *
 *  1. TYPING FROZE. The open line was state of this whole page, so each key
 *     re-rendered every day of the period: ~100 ms a key on a desktop and
 *     450–580 ms on a slow tablet once a month was entered. The line now lives
 *     in `TimesheetLineForm` (its own state; the page holds it in a ref) and
 *     the days are memoised, so a key re-renders the form alone. The comment
 *     box is its own component for the same reason.
 *  2. A LINE COULD BE STRANDED. With a line open, changing From or To so its
 *     day left the list removed the form AND every Add line / Edit button
 *     (they wait for no line to be open) — nothing on the page could continue
 *     it. An open line whose day is not shown is now drawn above the list.
 *  3. A REFUSAL WAS OFF SCREEN. It was printed in the period card at the top;
 *     a few days down, Save line seemed to do nothing. It is said at the line.
 *  4. A RELOAD LOST THE LINE. Android drops background tabs; the open line is
 *     kept on the device as it is typed and offered back (`timesheet-line.ts`).
 *  5. THE OFFICE HAD NO TIMESHEET OF ITS OWN. The list offered a Master or a
 *     Coordinator technicians only, so their own month — which My Monthly
 *     Forms asks them to submit — could not be filled in. Their own timesheet
 *     is now first, and opens by default; anybody else's is read-only, as the
 *     server has always enforced.
 *
 * THE TESTER'S CHANGES OF 1 NOVEMBER 2026:
 *
 *  - NO EXPORT CSV ON ONE'S OWN SHEET (TS-CSV-OFF-1). A technician's Timesheet
 *    page has Preview, Print and the PDF, and no spreadsheet; the server
 *    refuses the export to anybody but the office, which still exports a sheet
 *    it is READING (someone else's) for its records.
 *  - A COORDINATOR KEEPS NO TIMESHEET (TS-ROLE-1). Not in their sidebar, not in
 *    the list of sheets, and every write and their own sheet refused by the
 *    server. A Coordinator who opens this address — a correction's
 *    notification links here — reads the technicians' sheets, and decides
 *    their corrections, and nothing else.
 */
const TimesheetsPage = () => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const { invalidate, reportConnectionError } = useApp();
  // Why the open line was not saved when Save or Send to office saved it first.
  const [lineRefusal, setLineRefusal] = useState<string | null>(null);
  const today = businessToday();
  // Remembered per person on this device (FILTER-MEM-1).
  const [{ from: firstFrom, to: firstTo }] = useState(() => initialRange(currentUser.id, today));
  const [from, setFrom] = useState(firstFrom);
  const [to, setTo] = useState(firstTo);
  // The open line: which opening of it (`key` remounts the form), and its values in `draft`.
  const [open, setOpen] = useState<{ readonly key: number; readonly anchor: string; readonly correcting: boolean } | null>(null);
  const draft = useRef<TimesheetDraft | null>(null);
  const openings = useRef(0);
  const [lineDirty, setLineDirty] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
  const restoredFor = useRef<string | null>(null);
  // The period comment being typed (null: untouched), held in a ref like the line.
  const comment = useRef<string | null>(null);
  const [commentDirty, setCommentDirty] = useState(false);
  const [removing, setRemoving] = useState<TimesheetEntry | null>(null);
  const [previewing, setPreviewing] = useState<'preview' | 'print' | null>(null);
  const [confirmSend, setConfirmSend] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const rangeProblem = timesheetRangeProblem(from, to, TIMESHEET_MAX_DAYS);
  const people = useQuery(`timesheets:people:${currentUser.id}`, () => timesheets.people());
  /*
   * ALWAYS ONE'S OWN. TS-WHOSE-OFF-1 (the tester, 2 November 2026): the "Whose
   * timesheet" block is gone from this page. Each person keeps and sends their
   * own timesheet here; the office reads everybody's latest submission on EJE
   * Monthly Forms. A Coordinator keeps none (TS-ROLE-1).
   */
  const personId = completesTimesheet(currentUser.role) ? currentUser.id : null;
  const sheet = useQuery(`timesheets:${personId ?? 'none'}:${from}:${to}`, () =>
    personId === null || rangeProblem !== null ? Promise.resolve(null) : timesheets.sheet(personId, from, to),
  );
  const periodDocument = useQuery(`timesheets:document:${personId ?? 'none'}:${from}:${to}`, () =>
    personId === null || rangeProblem !== null ? Promise.resolve(null) : timesheets.document(personId, from, to),
  );
  const customers = useQuery('timesheets:customers', () => reads.customers());

  // OLDEST DAY FIRST (TS-04): the first entries of the range are at the top.
  const days = sheet.data?.days ?? [];
  const editable = sheet.data?.editable === true;
  const period = sheet.data?.period ?? null;
  const sentAt = period?.submittedAt ?? null;
  const overlapsSent = period?.overlapsSent ?? [];
  // Save and Send act on a period that has ended and shares no day with a
  // DIFFERENT sent period. A period already sent can be saved and sent again,
  // replacing the earlier submission (RESUBMIT-1). The server asks the same.
  const periodOpen = editable && overlapsSent.length === 0 && to <= today;
  const savedComment = period?.comment ?? '';
  const showHistoricalNt = days.some((day) => day.normalHours > 0);
  const showHistoricalCount = days.some((day) => day.callouts > 0);
  const storageKey = personId !== null && personId === currentUser.id ? timesheetDraftKey(currentUser.id, personId) : null;

  /*
   * NOTHING TYPED IS LOST BY LEAVING. A line half-typed, or a comment being
   * written, warns before the page is closed or reloaded — and before Update
   * now reloads it (REL-UPD-1).
   */
  useUnsavedWork(lineDirty || commentDirty, 'a timesheet line or comment being typed');

  /*
   * A LINE KEPT ON THIS DEVICE IS OFFERED BACK (TST-TS-2 #4), once per visit,
   * when the person's own sheet has loaded and no line is open.
   */
  useEffect(() => {
    if (storageKey === null || !editable || restoredFor.current === storageKey) return;
    restoredFor.current = storageKey;
    const kept = keptTimesheetDraft(storageKey);
    if (kept === null) return;
    draft.current = kept.draft;
    openings.current += 1;
    setOpen({ key: openings.current, anchor: kept.draft.anchor, correcting: kept.draft.entryId !== undefined });
    setLineDirty(true);
    setRestored(`A line you had not saved (kept on this device at ${formatDateTime(kept.keptAt)}) has been put back. Save it or cancel it.`);
  }, [storageKey, editable]);

  const refresh = useCallback(() => {
    sheet.refetch();
    periodDocument.refetch();
    // The refetch functions are stable; the queries are named for clarity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeLine = useCallback(() => {
    draft.current = null;
    setOpen(null);
    setLineDirty(false);
    setRestored(null);
    setLineRefusal(null);
    if (storageKey !== null) keepTimesheetDraft(storageKey, null);
  }, [storageKey]);

  const openLine = useCallback((next: TimesheetDraft) => {
    draft.current = next;
    openings.current += 1;
    setOpen({ key: openings.current, anchor: next.anchor, correcting: next.entryId !== undefined });
    setLineDirty(false);
    setRestored(null);
    setSaved(null);
    if (storageKey !== null) keepTimesheetDraft(storageKey, next);
  }, [storageKey]);

  // The form's copy of the open line, kept where typing costs the page nothing.
  const currentDraft = useCallback(() => draft.current ?? emptyTimesheetDraft(today), [today]);
  const keepDraft = useCallback((next: TimesheetDraft) => {
    draft.current = next;
  }, []);
  const keepComment = useCallback((value: string) => {
    comment.current = value;
  }, []);

  const addLine = useCallback((date: string) => openLine(emptyTimesheetDraft(date)), [openLine]);
  const editLine = useCallback((entry: TimesheetEntry) => openLine(timesheetDraftOf(entry)), [openLine]);

  /**
   * Sends the line; the refusal's own words, or null when it was saved (and
   * the form closed). Called straight rather than through `useOperation`, so
   * the words come back to the form that pressed Save line instead of to a
   * notice at the top of the page.
   */
  const sendLine = async (line: TimesheetDraft): Promise<string | null> => {
    if (personId === null) return 'Choose whose timesheet this is.';
    const dateProblem = lineDateProblem(line.date, from, to, today);
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
    // Something changed on the server, so everything on screen is stale.
    invalidate();
    closeLine();
    setSaved(`Line for ${formatDayAndDate(line.date)} saved ${formatDateTime(new Date().toISOString())}. Not sent to the office.`);
    refresh();
    return null;
  };

  /** The open line, if any, saved first — Save and Send to office both begin here. */
  const saveOpenLine = async (): Promise<boolean> => {
    if (draft.current === null || open === null) return true;
    const refused = await sendLine(draft.current);
    if (refused !== null) {
      setSaved(null);
      setLineRefusal(refused);
      return false;
    }
    return true;
  };

  if (people.error !== null) {
    return <QueryFailure code={people.errorCode} message={people.error} onRetry={people.refetch} />;
  }
  if (people.loading || people.data === null || people.data === undefined) {
    return <LoadingPanel rows={4} label="Loading timesheets" />;
  }
  if (people.data.length === 0) {
    return (
      <EmptyState
        title="No technicians yet"
        description="Timesheets appear here once technicians are on the system."
        icon={<Icon name="clock" />}
      />
    );
  }

  /** SAVE (TS-12): the open line, if any, and the period's comment. Never a submission. */
  const save = async (): Promise<void> => {
    if (personId === null) return;
    if (!(await saveOpenLine())) return;
    const typed = comment.current;
    if (typed !== null && typed !== savedComment) {
      const ok = await operation.run(async () => {
        await timesheets.savePeriodComment(personId, from, to, typed);
      });
      if (!ok) return;
    }
    comment.current = null;
    setCommentDirty(false);
    setSaved(`Saved ${formatDateTime(new Date().toISOString())}. Not sent to the office.`);
    refresh();
  };

  const remove = async (): Promise<void> => {
    if (personId === null || removing === null) return;
    const ok = await operation.run(async () => {
      await timesheets.removeEntry(personId, removing.id);
    });
    setRemoving(null);
    if (ok) refresh();
  };

  /** SEND TO OFFICE (TS-02, TS-14): saves first, then sends the period once. */
  const send = async (): Promise<void> => {
    if (personId === null) return;
    setConfirmSend(false);
    if (!(await saveOpenLine())) return;
    const typed = comment.current;
    const ok = await operation.run(async () => {
      if (typed !== null && typed !== savedComment) await timesheets.savePeriodComment(personId, from, to, typed);
      await timesheets.submit(personId, from, to);
    });
    if (ok) {
      comment.current = null;
      setCommentDirty(false);
      setSaved(null);
    }
    refresh();
  };

  /** A change of person or period starts its comment afresh; an open line stays open. */
  const changePeriod = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    if (timesheetRangeProblem(nextFrom, nextTo, TIMESHEET_MAX_DAYS) === null) {
      rememberRange('timesheets', currentUser.id, { from: nextFrom, to: nextTo });
    }
    comment.current = null;
    setCommentDirty(false);
  };

  const listShown = rangeProblem === null && sheet.error === null && !sheet.loading && sheet.data !== null && sheet.data !== undefined;
  const anchorShown = open !== null && listShown && days.some((day) => day.date === open.anchor);
  const lineForm: ReactNode =
    open === null ? null : (
      <TimesheetLineForm
        // Drawn somewhere else (its day left the list, or came back): it starts again from the page's copy.
        key={`${open.key}:${anchorShown ? 'day' : 'elsewhere'}`}
        initial={currentDraft}
        onChange={keepDraft}
        storageKey={storageKey}
        from={from}
        to={to}
        today={today}
        customers={customers.data ?? []}
        customersLoading={customers.loading}
        onSave={sendLine}
        onCancel={closeLine}
        onDirtyChange={setLineDirty}
      />
    );

  return (
    <>
      <PageHeader
        title="Timesheets"
        description="Each person keeps their own timesheet: the customer or Workshop, OT, D/T, the call-out amount and Int Km / Cust Km, entered by hand for each day — as you go, or all at once later."
      />
      {!completesTimesheet(currentUser.role) && (
        <p role="status" className="mb-4 text-sm text-steel-600" data-testid="timesheet-not-required">
          Coordinators do not complete a timesheet — only their attendance. Everybody’s latest submitted timesheet is on EJE Monthly Forms.
        </p>
      )}

      <ConfirmDialog
        open={removing !== null}
        title="Remove this line?"
        message={removing === null ? '' : `${removing.workshop ? WORKSHOP_LABEL : removing.customerName || 'This line'} on ${removing.date} will be removed from your timesheet. The removal is recorded.`}
        confirmLabel="Remove line"
        confirmVariant="danger"
        busy={operation.running}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(null)}
      />

      <ConfirmDialog
        open={confirmSend}
        title={`Send the timesheet for ${formatPeriod(from, to)} to the office?`}
        message={
          sentAt === null
            ? 'It is saved first, then sent. The office is notified and reads the version you sent. You can still change it and send it again; the new submission replaces this one. No other period may include these days.'
            : 'It is saved first, then sent again. This replaces the submission the office has now; the earlier one is not kept.'
        }
        confirmLabel="Send to office"
        busy={operation.running}
        onConfirm={() => void send()}
        onCancel={() => setConfirmSend(false)}
      />

      {personId !== null && (
        <DocumentPreviewDialog
          open={previewing !== null}
          autoPrint={previewing === 'print'}
          title={`Time Sheet — ${formatPeriod(from, to)}`}
          description={sentAt === null ? 'Preview of the draft. Nothing is saved or sent by looking at it.' : `The version in force: ${period?.versionInForce ?? ''}.`}
          loadPdf={() => timesheets.pdf(personId, from, to)}
          renderHtml={() =>
            periodDocument.data === null || periodDocument.data === undefined ? null : (
              <TimesheetDocumentView document={periodDocument.data as TimesheetDocument} />
            )
          }
          onClose={() => setPreviewing(null)}
        />
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <TextField label="From" type="date" value={from} onChange={(event) => changePeriod(event.target.value, to)} containerClassName="w-44" data-testid="timesheet-from" />
          <TextField label="To" type="date" value={to} onChange={(event) => changePeriod(from, event.target.value)} containerClassName="w-44" data-testid="timesheet-to" />
        </div>
        {rangeProblem !== null && (
          <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="timesheet-range-problem">
            {rangeProblem}
          </p>
        )}
        <p className="mt-3 text-xs text-steel-500">
          {editable
            ? 'Add a line for each customer — or Workshop — you worked for on a day. You can correct or remove your own lines at any time, also after sending; send the period again and the new submission replaces the earlier one. Every change is recorded.'
            : 'This is the person’s own timesheet. Only they enter it; the office reads it, previews and prints it, and exports it.'}
        </p>
      </Card>

      {restored !== null && (
        <p role="status" className="mb-3 rounded-[var(--radius-control)] border border-amber-eje-200 bg-amber-eje-50 px-3 py-2 text-sm text-amber-eje-700" data-testid="timesheet-line-restored">
          {restored}
        </p>
      )}

      {/* An open line whose day is not on screen is never stranded (TST-TS-2 #2). */}
      {open !== null && !anchorShown && (
        <Card className="mb-5" data-testid="timesheet-line-elsewhere">
          <p className="text-sm font-semibold text-steel-900">
            Line being {open.correcting ? 'corrected' : 'entered'} for {isCalendarDay(open.anchor) ? formatDayAndDate(open.anchor) : open.anchor}
          </p>
          <p className="text-xs text-steel-500">
            Its day is not in the dates chosen above. Save it with a date inside them, change the dates back, or cancel it.
          </p>
          {lineForm}
        </Card>
      )}

      {rangeProblem === null && period !== null && (
      <Card className="mb-5" data-testid="timesheet-period">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm font-semibold text-steel-900" data-testid="timesheet-period-label">
            Timesheet period: {period.label}
          </p>
          {sentAt === null ? (
            <Badge tone="amber" size="sm">Draft — not sent</Badge>
          ) : (
            <Badge tone="green" size="sm">
              Sent to office {formatDateTime(sentAt)}
              {period.submittedByName ? ` by ${period.submittedByName}` : ''}
            </Badge>
          )}
        </div>
        {sentAt === null && overlapsSent.length > 0 && (
          <p role="status" className="mt-2 text-sm text-amber-eje-700" data-testid="timesheet-period-overlap">
            Part of these dates was already sent to the office ({overlapsSent.map((sent) => formatPeriod(sent.from, sent.to)).join('; ')}). Choose From and To dates outside it to send a new period.
          </p>
        )}
        {sentAt === null && overlapsSent.length === 0 && to > today && editable && (
          <p role="status" className="mt-2 text-sm text-steel-600">A period can be sent once its To date has passed or is today.</p>
        )}
        <div className="mt-3">
          {periodOpen ? (
            <PeriodComment
              key={`${personId}:${from}:${to}:${savedComment}`}
              label={`Comments for ${period.label}`}
              saved={savedComment}
              onChange={keepComment}
              onDirty={() => {
                setCommentDirty(true);
                setSaved(null);
              }}
            />
          ) : (
            <div className="text-sm">
              <p className="mb-1 font-medium text-steel-700">Comments for {period.label}</p>
              <p className="whitespace-pre-wrap text-steel-800" data-testid="timesheet-period-comment-read">
                {savedComment.length > 0 ? savedComment : '—'}
              </p>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('preview')} data-testid="timesheet-preview">
            Preview
          </Button>
          {periodOpen && (
            <Button variant="secondary" loading={operation.running} onClick={() => void save()} data-testid="timesheet-save">
              Save
            </Button>
          )}
          <Button variant="secondary" leadingIcon={<Icon name="document" className="size-4" />} onClick={() => setPreviewing('print')} data-testid="timesheet-print">
            Print
          </Button>
          {periodOpen && (
            <Button onClick={() => setConfirmSend(true)} loading={operation.running} data-testid="timesheet-send">
              {sentAt === null ? 'Send to office' : 'Send again'}
            </Button>
          )}
        </div>
        {saved !== null && (
          <p role="status" className="mt-2 text-sm text-verdant-700" data-testid="timesheet-saved">
            {saved}
          </p>
        )}
        {operation.error !== null && (
          <p role="alert" className="mt-2 text-sm font-medium text-signal-600">
            {operation.error}
          </p>
        )}
        {open !== null && lineRefusal !== null && (
          <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="timesheet-open-line-refused">
            The open line was not saved: {lineRefusal} It is still open{anchorShown ? ' on its day below' : ' above'}.
          </p>
        )}
        <p className="mt-2 text-xs text-steel-500">
          Preview and Print show the Time Sheet for these dates exactly as it prints, and change nothing. A period can be sent again at any time; the new submission replaces the one the office has, and the earlier one is not kept.
        </p>
      </Card>
      )}

      {rangeProblem !== null || personId === null ? null : sheet.error !== null ? (
        <QueryFailure code={sheet.errorCode} message={sheet.error} onRetry={sheet.refetch} />
      ) : sheet.loading || sheet.data === null || sheet.data === undefined ? (
        <LoadingPanel rows={6} label="Loading the timesheet" />
      ) : (
        <>
          <Card className="mb-5">
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm" data-testid="timesheet-totals">
              <span>OT <strong className="tabular-nums">{hours(sheet.data.totals.overtimeHours)}</strong></span>
              <span>D/T <strong className="tabular-nums">{hours(sheet.data.totals.doubleHours)}</strong></span>
              <span>Callout <strong className="tabular-nums">{formatCurrency(sheet.data.totals.calloutAmount)}</strong></span>
              <span>Int Km <strong className="tabular-nums">{kilometres(sheet.data.totals.internalKm)}</strong></span>
              <span>Cust Km <strong className="tabular-nums">{kilometres(sheet.data.totals.customerKm)}</strong></span>
              {sheet.data.totals.normalHours > 0 && (
                <span className="text-steel-500">NT (historical) <strong className="tabular-nums">{hours(sheet.data.totals.normalHours)}</strong></span>
              )}
              <span>Recorded days <strong>{sheet.data.totals.recordedDays}</strong></span>
              <span className={sheet.data.totals.unrecordedDays > 0 ? 'text-amber-eje-700' : ''}>
                Not recorded <strong>{sheet.data.totals.unrecordedDays}</strong>
              </span>
            </div>
          </Card>
          <Card>
            <ul className="divide-y divide-steel-100" data-testid="timesheet-table">
              {days.map((day) => (
                <DayRow
                  key={day.date}
                  day={day}
                  today={today}
                  editable={editable}
                  lineOpen={open !== null}
                  showHistoricalNt={showHistoricalNt}
                  showHistoricalCount={showHistoricalCount}
                  form={anchorShown && open?.anchor === day.date ? lineForm : null}
                  onAdd={addLine}
                  onEdit={editLine}
                  onRemove={setRemoving}
                />
              ))}
            </ul>
          </Card>
        </>
      )}
    </>
  );
};

/**
 * One day of the period. MEMOISED (TST-TS-2 #1): with no line open on it, it
 * re-renders only when its own day changes — never because a key was pressed
 * somewhere else on the page.
 */
const DayRow = memo(function DayRow({
  day,
  today,
  editable,
  lineOpen,
  showHistoricalNt,
  showHistoricalCount,
  form,
  onAdd,
  onEdit,
  onRemove,
}: {
  readonly day: TimesheetDay;
  readonly today: string;
  readonly editable: boolean;
  readonly lineOpen: boolean;
  readonly showHistoricalNt: boolean;
  readonly showHistoricalCount: boolean;
  readonly form: ReactNode;
  readonly onAdd: (date: string) => void;
  readonly onEdit: (entry: TimesheetEntry) => void;
  readonly onRemove: (entry: TimesheetEntry) => void;
}) {
  // RESUBMIT-1: a day in a sent period stays editable; `locked` only marks it sent.
  const writable = editable;
  return (
    <li className="py-3" data-testid="timesheet-day" data-date={day.date} data-recorded={day.recorded ? 'yes' : 'no'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-steel-900" data-testid="timesheet-day-label">
            {formatDayAndDate(day.date)}
          </span>
          {day.recorded ? <Badge tone="green" size="sm">Recorded</Badge> : <Badge tone="amber" size="sm">Not recorded</Badge>}
          {day.locked && (
            <span data-testid="timesheet-day-sent-version">
              <Badge tone="outline" size="sm">{day.sentVersion || 'Sent to office'}</Badge>
            </span>
          )}
          {day.attendance !== null && (
            <Badge tone="outline" size="sm">
              {day.attendance === 'present'
                ? 'Present'
                : day.absenceReason === null
                  ? 'Absent'
                  : `Absent — ${ABSENCE_REASON_LABELS[day.absenceReason]}`}
            </Badge>
          )}
        </div>
        {/* A day that has not happened cannot hold a line, so it offers none. */}
        {writable && !lineOpen && day.date <= today && (
          <Button size="sm" variant="secondary" onClick={() => onAdd(day.date)} data-testid="add-timesheet-line">
            <Icon name="plus" className="size-4" /> Add line
          </Button>
        )}
      </div>

      {day.entries.length > 0 && (
        <div className="eje-scrollbar mt-2 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-steel-500 uppercase">
                <th className="py-1 pr-3">Customer</th>
                <th className="py-1 pr-3 text-right">OT</th>
                <th className="py-1 pr-3 text-right">D/T</th>
                <th className="py-1 pr-3 text-right">Callout</th>
                <th className="py-1 pr-3 text-right">Int Km</th>
                <th className="py-1 pr-3 text-right">Cust Km</th>
                {showHistoricalNt && <th className="py-1 pr-3 text-right">NT (historical)</th>}
                {showHistoricalCount && <th className="py-1 pr-3 text-right">Call-outs (historical)</th>}
                {writable && <th className="py-1" />}
              </tr>
            </thead>
            <tbody>
              {day.entries.map((entry) => (
                <tr key={entry.id} className="border-t border-steel-100" data-testid="timesheet-line">
                  <td className="py-1.5 pr-3">{entry.workshop ? WORKSHOP_LABEL : entry.customerName || '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{hours(entry.overtimeHours)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{hours(entry.doubleHours)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {formatCurrency(entry.calloutAmount)}
                    {entry.calloutShared && ' (shared)'}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{kilometres(entry.internalKm)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{kilometres(entry.customerKm)}</td>
                  {showHistoricalNt && <td className="py-1.5 pr-3 text-right tabular-nums text-steel-500">{entry.normalHours > 0 ? hours(entry.normalHours) : ''}</td>}
                  {showHistoricalCount && <td className="py-1.5 pr-3 text-right tabular-nums text-steel-500">{entry.callouts > 0 ? entry.callouts : ''}</td>}
                  {writable && (
                    <td className="py-1.5 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" disabled={lineOpen} onClick={() => onEdit(entry)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={lineOpen} onClick={() => onRemove(entry)}>
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form}

      {day.comment.length > 0 && (
        <p className="mt-2 text-sm whitespace-pre-wrap text-steel-600" data-testid="timesheet-day-comment">
          <span className="text-xs font-semibold text-steel-500">Day comment (written before one comment per timesheet): </span>
          {day.comment}
        </p>
      )}
    </li>
  );
});

/**
 * The period's one comment, typed in its own state so a key re-renders this
 * box alone (TST-TS-2 #1). The page keeps the typed value (`onChange`) for
 * when it saves or sends.
 */
const PeriodComment = ({
  label,
  saved,
  onChange,
  onDirty,
}: {
  readonly label: string;
  readonly saved: string;
  readonly onChange: (value: string) => void;
  readonly onDirty: () => void;
}) => {
  const [value, setValue] = useState(saved);
  const told = useRef(false);
  return (
    <TextAreaField
      label={label}
      value={value}
      maxLength={2000}
      rows={3}
      hint="One comment for the whole timesheet. It is printed in the Comments box."
      onChange={(event) => {
        setValue(event.target.value);
        onChange(event.target.value);
        if (!told.current) {
          told.current = true;
          onDirty();
        }
      }}
      data-testid="timesheet-period-comment"
    />
  );
};

export default TimesheetsPage;
