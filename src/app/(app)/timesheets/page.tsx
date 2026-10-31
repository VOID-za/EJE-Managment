'use client';

import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ABSENCE_REASON_LABELS, WORKSHOP_LABEL, can, userFullName, type TimesheetEntry } from '@/domain';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Icon,
  LoadingPanel,
  QueryFailure,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/PageHeader';
import { DownloadFileButton } from '@/components/exports/DownloadFileButton';
import { DocumentPreviewDialog } from '@/components/documents/DocumentPreviewDialog';
import { useUnsavedWork } from '@/hooks/useUnsavedWork';
import { TimesheetDocumentView } from '@/components/timesheets/TimesheetDocumentView';
import { TimesheetCorrections } from '@/components/timesheets/TimesheetCorrections';
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
const initialRange = (today: string): { readonly from: string; readonly to: string } => {
  const fallback = defaultTimesheetRange(today);
  if (typeof window === 'undefined') return fallback;
  const params = new URLSearchParams(window.location.search);
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (!isCalendarDay(from) || !isCalendarDay(to) || timesheetRangeProblem(from, to, TIMESHEET_MAX_DAYS) !== null) return fallback;
  return { from, to: to > today ? today : to };
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
 */
const TimesheetsPage = () => {
  const currentUser = useCurrentUser();
  const operation = useOperation();
  const { invalidate, reportConnectionError } = useApp();
  // Why the open line was not saved when Save or Send to office saved it first.
  const [lineRefusal, setLineRefusal] = useState<string | null>(null);
  const today = businessToday();
  // Reset on every visit (TS-04): plain state, deliberately not remembered.
  const [{ from: firstFrom, to: firstTo }] = useState(() => initialRange(today));
  const [from, setFrom] = useState(firstFrom);
  const [to, setTo] = useState(firstTo);
  const [chosen, setChosen] = useState<string | null>(null);
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
  // Your own timesheet first (TST-TS-2 #5): the list puts you first when you are on it.
  const personId = chosen ?? people.data?.[0]?.id ?? null;
  const sheet = useQuery(`timesheets:${personId ?? 'none'}:${from}:${to}`, () =>
    personId === null || rangeProblem !== null ? Promise.resolve(null) : timesheets.sheet(personId, from, to),
  );
  const periodDocument = useQuery(`timesheets:document:${personId ?? 'none'}:${from}:${to}`, () =>
    personId === null || rangeProblem !== null ? Promise.resolve(null) : timesheets.document(personId, from, to),
  );
  const customers = useQuery('timesheets:customers', () => reads.customers());
  const reviewer = can(currentUser.role, 'timesheets.reviewCorrections');
  const pendingCorrections = useQuery(`timesheets:corrections:pending:${currentUser.id}`, () =>
    reviewer ? timesheets.pendingCorrections() : Promise.resolve([]),
  );

  // OLDEST DAY FIRST (TS-04): the first entries of the range are at the top.
  const days = sheet.data?.days ?? [];
  const editable = sheet.data?.editable === true;
  const period = sheet.data?.period ?? null;
  const sentAt = period?.submittedAt ?? null;
  const overlapsSent = period?.overlapsSent ?? [];
  // Save and Send act on a period that has ended, was not sent, and shares no
  // day with one that was. The server asks the same questions.
  const periodOpen = editable && sentAt === null && overlapsSent.length === 0 && to <= today;
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
    pendingCorrections.refetch();
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
  const viewingOther = personId !== null && personId !== currentUser.id;
  const personName = userFullName(people.data.find((person) => person.id === personId) ?? people.data[0]!);

  return (
    <>
      <PageHeader
        title="Timesheets"
        description="Each person keeps their own timesheet: the customer or Workshop, OT, D/T, the call-out amount and Int Km / Cust Km, entered by hand for each day — as you go, or all at once later."
      />

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
        message="It is saved first, then sent. Once sent you can no longer add, change or remove a line on any day in this period, or change the comment, and no other period may include these days. The office is notified and reads the version you sent."
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

      {reviewer && (pendingCorrections.data ?? []).length > 0 && (
        <Card className="mb-5" data-testid="timesheet-pending-corrections">
          <p className="text-sm font-semibold text-steel-900">Timesheet corrections waiting for you</p>
          <ul className="mt-2 divide-y divide-steel-100 text-sm">
            {(pendingCorrections.data ?? []).map((pending) => (
              <li key={pending.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <strong>{pending.technicianName}</strong> — {pending.periodLabel}, correction {pending.sequence}, asked for {formatDateTime(pending.requestedAt)}. Reason: {pending.reason}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setChosen(pending.technicianId);
                    changePeriod(pending.from, pending.to);
                  }}
                  data-testid="timesheet-pending-open"
                >
                  Open
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          {people.data.length > 1 ? (
            <SelectField
              label="Whose timesheet"
              value={personId ?? ''}
              disabled={open !== null}
              hint={open !== null ? 'Save or cancel the open line first.' : undefined}
              onChange={(event) => {
                setChosen(event.target.value);
                // A comment being typed belongs to the sheet it was typed on.
                comment.current = null;
                setCommentDirty(false);
              }}
              options={people.data.map((person) => ({
                value: person.id,
                label: person.id === currentUser.id ? `${userFullName(person)} (me)` : userFullName(person),
              }))}
              containerClassName="w-full sm:w-72"
              data-testid="timesheet-person"
            />
          ) : (
            <div className="text-sm">
              <p className="mb-1.5 font-medium text-steel-700">Technician</p>
              <p className="font-semibold text-steel-900">{userFullName(people.data[0]!)}</p>
            </div>
          )}
          <TextField label="From" type="date" value={from} onChange={(event) => changePeriod(event.target.value, to)} containerClassName="w-44" data-testid="timesheet-from" />
          <TextField label="To" type="date" value={to} onChange={(event) => changePeriod(from, event.target.value)} containerClassName="w-44" data-testid="timesheet-to" />
          {personId !== null && rangeProblem === null && sheet.data !== null && sheet.data !== undefined && (
            <DownloadFileButton href={timesheets.exportUrl(personId, from, to)} fallbackName={`timesheet-${from}-${to}.csv`} label="Export CSV" />
          )}
        </div>
        {rangeProblem !== null && (
          <p role="alert" className="mt-2 text-sm font-medium text-signal-600" data-testid="timesheet-range-problem">
            {rangeProblem}
          </p>
        )}
        {viewingOther && sheet.data !== null && sheet.data !== undefined && (
          <p role="status" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-steel-700" data-testid="timesheet-read-only">
            <Badge tone="outline" size="sm">Read-only</Badge>
            {personName}&apos;s own timesheet. Only they enter it; you can read, preview, print and export it.
          </p>
        )}
        <p className="mt-3 text-xs text-steel-500">
          {editable
            ? 'Add a line for each customer — or Workshop — you worked for on a day. You can correct or remove your own lines until a period holding that day is sent to the office; every change is recorded.'
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
              Send to office
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
          Preview and Print show the Time Sheet for these dates exactly as it prints, and change nothing. Send to office is once per period; after that its days are read-only, and a mistake is put right by a correction the office accepts.
        </p>
        {sentAt !== null && personId !== null && (
          <TimesheetCorrections
            user={currentUser}
            personId={personId}
            period={period}
            entries={days.flatMap((day) => day.entries)}
            owner={editable}
            customers={customers.data ?? []}
            onChanged={refresh}
          />
        )}
      </Card>
      )}

      {rangeProblem !== null ? null : sheet.error !== null ? (
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
  const writable = editable && !day.locked;
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
