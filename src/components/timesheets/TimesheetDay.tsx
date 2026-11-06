"use client";

import { useId, useState } from "react";
import { Badge, Button, Icon, TextField } from "@/components/ui";
import { formatCurrency } from "@/lib/format";
import { dayState, summariseDay } from "@/lib/timesheet-day";
import { formatDayAndDate, isCalendarDay } from "@/lib/timesheet-dates";
import type { TimesheetAutosaver } from "@/lib/timesheet-autosave";
import {
  TimesheetLineEditor,
  TimesheetLineHeader,
  lineStatus,
  shownLine,
  type EditableLine,
} from "./TimesheetLineEditor";

const STATE_TEXT = {
  empty: null,
  saved: { tone: "green", text: "Saved" },
  saving: { tone: "outline", text: "Saving…" },
  draft: { tone: "amber", text: "Draft" },
  failed: { tone: "red", text: "Save failed" },
} as const;

const hours = (value: number): string => value.toFixed(2);

/**
 * ONE DAY OF THE OPEN TIMESHEET (TS-DAY-1, the owner, 6 November 2026).
 *
 * Collapsed, the day is one row: its date, what its lines add up to (OT, D/T,
 * call-outs, kilometres), how many customers or sites, and whether it is
 * saved. Opened (Edit), it holds each customer or site visited that day as its
 * own line, with **Add line** inside the day for the next one — a second line
 * is on the same date and starts empty, so nothing of the first is copied.
 * A line is changed or removed on its own; the day's other lines stay.
 *
 * Nothing is stored for the day itself (`summariseDay`): the figures are the
 * sum of its lines, as on the paper Time Sheet, so they cannot be counted
 * twice. **Change date** moves all of the day's lines together.
 */
export const TimesheetDay = ({
  date,
  lines,
  open,
  onToggle,
  onAdd,
  onMove,
  locked,
  customers,
  saver,
}: {
  readonly date: string;
  /** The day's working lines — never a submitted one. */
  readonly lines: readonly EditableLine[];
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onAdd: () => void;
  readonly onMove: (to: string) => void;
  /**
   * FORM-LIFECYCLE-1: this date is in the person's COMPLETED timesheet (awaiting submission) or one SUBMITTED —
   * read only: no line is added, changed, moved or removed (the server refuses it too).
   */
  readonly locked: "completed" | "submitted" | null;
  readonly customers: readonly { readonly id: string; readonly name: string }[];
  readonly saver: TimesheetAutosaver | null;
}) => {
  const bodyId = useId();
  const [moving, setMoving] = useState<string | null>(null);
  const summary = summariseDay(lines.map((line) => shownLine(line, saver)));
  const state = dayState(lines.map((line) => lineStatus(line, saver)));
  const badge = STATE_TEXT[state];
  const figures = [
    `OT ${hours(summary.overtime)}`,
    `D/T ${hours(summary.double)}`,
    `Callout ${formatCurrency(summary.callout)}`,
    `Km ${summary.internalKm.toFixed(1)} int / ${summary.customerKm.toFixed(1)} cust`,
  ];

  return (
    <li
      className="py-1"
      data-testid="timesheet-day"
      data-date={date}
      data-state={state}
      data-open={open ? "yes" : "no"}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className={`grid min-h-12 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-[var(--radius-control)] px-2 py-2 text-left hover:bg-steel-50 focus-visible:ring-2 focus-visible:ring-eje-500 focus-visible:outline-none sm:grid-cols-[9.5rem_minmax(0,1fr)_auto] ${open ? "bg-steel-50" : ""}`}
        data-testid="timesheet-day-toggle"
      >
        <span className="col-start-1 row-start-1 text-sm font-medium text-steel-900">
          {formatDayAndDate(date)}
        </span>
        {/* On a phone the figures take their own row under the date; from a tablet up they sit between. */}
        <span
          className="col-span-2 row-start-2 min-w-0 text-sm text-steel-600 sm:col-span-1 sm:col-start-2 sm:row-start-1"
          data-testid="timesheet-day-summary"
        >
          {summary.visits === 0 ? (
            <span className="text-steel-400">
              {/* A locked day's lines are in its form, not here: never "Not recorded" for a day that was recorded. */}
              {locked === 'completed' ? 'In your completed timesheet' : locked === 'submitted' ? 'In a submitted timesheet' : 'Not recorded'}
            </span>
          ) : (
            <>
              <span className="font-medium text-steel-800">
                {summary.visits} line{summary.visits === 1 ? "" : "s"} ·{" "}
                {summary.places} customer{summary.places === 1 ? "" : "s"}/site
                {summary.places === 1 ? "" : "s"}
              </span>
              <span className="tabular-nums"> · {figures.join(" · ")}</span>
            </>
          )}
        </span>
        <span className="col-start-2 row-start-1 flex flex-wrap items-center justify-end gap-2 sm:col-start-3">
          {locked === "completed" && (
            <Badge tone="outline" size="sm">
              Completed — on My Monthly Forms
            </Badge>
          )}
          {locked === "submitted" && (
            <Badge tone="outline" size="sm">
              Submitted
            </Badge>
          )}
          {badge !== null && (
            <span data-testid="timesheet-day-status">
              <Badge tone={badge.tone} size="sm">
                {badge.text}
              </Badge>
            </span>
          )}
          <span className="inline-flex items-center gap-1 text-sm font-medium text-eje-700">
            <Icon
              name={open ? "close" : summary.visits === 0 ? "plus" : "edit"}
              className="size-4"
            />
            {open
              ? "Close"
              : locked !== null
                ? "View"
                : summary.visits === 0
                  ? "Add"
                  : "Edit"}
          </span>
        </span>
      </button>

      {open && (
        <div
          id={bodyId}
          className="mt-2 mb-3 space-y-3 rounded-[var(--radius-control)] border border-steel-200 bg-steel-50/60 p-3"
          data-testid="timesheet-day-body"
        >
          {locked !== null && (
            <p
              className="text-sm text-steel-700"
              data-testid="timesheet-day-locked"
            >
              {locked === "completed"
                ? "This date is in your completed timesheet. It is locked and waits on My Monthly Forms to be submitted to the office."
                : "This date is in a timesheet submitted to the office. It is read only; a change is asked for as a correction on My Monthly Forms."}
            </p>
          )}
          {locked === null && lines.length === 0 && (
            <p
              className="text-sm text-steel-600"
              data-testid="timesheet-day-empty"
            >
              Not recorded. Add a line for each customer, site or Workshop you
              worked at.
            </p>
          )}
          {lines.length > 0 && (
            <p className="text-xs text-steel-500 sm:hidden">Swipe the table sideways for D/T, Callout and the kilometres.</p>
          )}
          {lines.length > 0 && (
            // Customer | OT | D/T | Callout | Int Km | Cust Km, one row per line — the table scrolls sideways on a phone.
            <div
              className="-mx-1 overflow-x-auto px-1"
              data-testid="timesheet-table-scroll"
            >
              <div className="min-w-[38rem]">
                <TimesheetLineHeader />
                <ul
                  className="divide-y divide-steel-100"
                  data-testid="timesheet-table"
                >
                  {lines.map((line, index) => (
                    <TimesheetLineEditor
                      key={line.id}
                      line={line}
                      customers={customers}
                      saver={saver}
                      day={date}
                      position={index + 1}
                    />
                  ))}
                </ul>
              </div>
            </div>
          )}
          {locked === null && (
            <div className="flex flex-wrap items-end gap-2">
              <Button
                leadingIcon={<Icon name="plus" className="size-4" />}
                disabled={saver === null}
                onClick={onAdd}
                data-testid={`add-timesheet-line-${date}`}
              >
                Add line
              </Button>
              {lines.length > 0 && moving === null && (
                <Button
                  variant="ghost"
                  leadingIcon={<Icon name="calendar" className="size-4" />}
                  onClick={() => setMoving(date)}
                  data-testid="timesheet-day-move"
                >
                  Change date
                </Button>
              )}
            </div>
          )}
          {moving !== null && (
            <div
              className="flex flex-wrap items-end gap-2 rounded-[var(--radius-control)] border border-steel-200 bg-surface p-3"
              data-testid="timesheet-day-move-form"
            >
              <TextField
                label={`Move all ${lines.length} line${lines.length === 1 ? "" : "s"} of this day to`}
                type="date"
                value={moving}
                onChange={(event) => setMoving(event.target.value)}
                containerClassName="w-60"
                data-testid="timesheet-day-move-date"
              />
              <Button
                disabled={!isCalendarDay(moving) || moving === date}
                onClick={() => {
                  onMove(moving);
                  setMoving(null);
                }}
                data-testid="timesheet-day-move-confirm"
              >
                Move
              </Button>
              <Button variant="ghost" onClick={() => setMoving(null)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
};
