'use client';

import { daysBetween } from '@/domain';
import { TextField } from '@/components/ui';

/**
 * THE JOB'S DATES, AS ONE SECTION. JOB-DATES-UI-1 (7 November 2026).
 *
 * The start date sat in the row with Job type and Priority while the end date
 * sat below it in a tinted box of its own, with a hint only it carried — two
 * fields describing one booking that looked like they came from two forms.
 * Both are now the same `TextField`, with the same control class, side by side
 * from `sm` up and stacked full width on a phone, under one "Dates" heading.
 *
 * PRESENTATION ONLY. The labels, the values, the `min` on the end date and the
 * error the form passes are what they were; the date rules stay in
 * `checkSchedule` and on the server.
 */
export interface JobScheduleDatesProps {
  /** Whether this job type is booked across a range (`schedulesDateRange`). */
  readonly range: boolean;
  readonly start: string;
  readonly end: string;
  readonly onStartChange: (value: string) => void;
  readonly onEndChange: (value: string) => void;
  readonly startError?: string;
  readonly endError?: string;
  readonly disabled?: boolean;
}

/**
 * One class for both inputs. `min-w-0` lets a date input shrink inside its grid
 * cell instead of pushing the page sideways on a narrow phone, and Safari's
 * centred date value is aligned left like every other field.
 */
export const DATE_CONTROL_CLASS = 'min-w-0 [&::-webkit-date-and-time-value]:text-left';

export const JobScheduleDates = ({
  range,
  start,
  end,
  onStartChange,
  onEndChange,
  startError,
  endError,
  disabled,
}: JobScheduleDatesProps) => (
  <fieldset
    className="min-w-0 rounded-[var(--radius-control)] border border-steel-200 p-4"
    data-testid="job-schedule-dates"
  >
    <legend className="px-1 text-sm font-semibold text-steel-800">Dates</legend>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <TextField
        label={range ? 'Scheduled start date' : 'Scheduled date'}
        type="date"
        value={start}
        error={startError}
        disabled={disabled}
        className={DATE_CONTROL_CLASS}
        containerClassName="min-w-0"
        onChange={(event) => onStartChange(event.target.value)}
      />
      {range && (
        <TextField
          label="Scheduled end date"
          type="date"
          value={end}
          min={start.length > 0 ? start : undefined}
          error={endError}
          disabled={disabled}
          className={DATE_CONTROL_CLASS}
          containerClassName="min-w-0"
          onChange={(event) => onEndChange(event.target.value)}
        />
      )}
    </div>
    {range && (
      <p className="mt-3 text-sm text-steel-600" data-testid="job-schedule-dates-summary">
        {start.length > 0 && end.length > 0 ? (
          <>
            Booked for{' '}
            <span className="font-semibold text-steel-800">{daysBetween(start, end) + 1} days</span>{' '}
            on the calendar.
          </>
        ) : (
          'A service is quoted for a number of days and is booked across a range. Leave the end date blank for a single-day service.'
        )}
      </p>
    )}
  </fieldset>
);
