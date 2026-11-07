import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobScheduleDates, type JobScheduleDatesProps } from './JobScheduleDates';

/**
 * THE JOB'S DATES ARE ONE SECTION, AND THE TWO FIELDS ARE ONE CONTROL.
 * JOB-DATES-UI-1 (7 November 2026).
 *
 * Start and end looked like they came from two forms: one in the Job type row,
 * the other in a tinted box below with a hint of its own. These render the
 * shared section the way the browser receives it and hold the two inputs to the
 * same markup — same component, same classes, same states — side by side from
 * `sm` and stacked below it. The suite runs in node, so this is the server
 * render, not a layout measurement; the responsive browser check covers that.
 */
const noop = (): void => undefined;

const render = (over: Partial<JobScheduleDatesProps> = {}): string =>
  renderToStaticMarkup(
    createElement(JobScheduleDates, {
      range: true,
      start: '2026-11-10',
      end: '2026-11-12',
      onStartChange: noop,
      onEndChange: noop,
      ...over,
    }),
  );

const inputs = (html: string): readonly string[] => html.match(/<input[^>]*>/gu) ?? [];
const classOf = (tag: string): string => /class="([^"]*)"/u.exec(tag)?.[1] ?? '';

describe('the Dates section', () => {
  it('is one labelled group holding both dates, side by side from sm and stacked below', () => {
    const html = render();
    expect(html).toMatch(/^<fieldset[^>]*data-testid="job-schedule-dates"/u);
    expect(html).toContain('<legend class="px-1 text-sm font-semibold text-steel-800">Dates</legend>');
    expect(html).toContain('class="grid grid-cols-1 gap-4 sm:grid-cols-2"');
    expect(html).toContain('Scheduled start date');
    expect(html).toContain('Scheduled end date');
  });

  it('draws both inputs from the same control: same type, same classes, a 44px height', () => {
    const [start, end] = inputs(render());
    expect(start).toBeDefined();
    expect(end).toBeDefined();
    expect(start).toContain('type="date"');
    expect(end).toContain('type="date"');
    expect(classOf(start!)).toBe(classOf(end!));
    // h-11 is 44px: the touch target. min-w-0 keeps a date input inside its cell on a phone.
    expect(classOf(start!)).toContain('h-11');
    expect(classOf(start!)).toContain('min-w-0');
    // The focus and disabled states come with the shared control, not per field.
    expect(classOf(start!)).toContain('focus:border-eje-500');
    expect(classOf(start!)).toContain('disabled:bg-steel-50');
  });

  it('labels each input, so both are reachable by their label', () => {
    const html = render();
    for (const tag of inputs(html)) {
      const id = /id="([^"]+)"/u.exec(tag)?.[1];
      expect(id).toBeDefined();
      expect(html).toContain(`for="${id}"`);
    }
  });

  it('keeps the end date’s rule exactly: it cannot be earlier than the start', () => {
    const [start, end] = inputs(render());
    expect(end).toContain('min="2026-11-10"');
    expect(start).not.toContain('min=');
    expect(inputs(render({ start: '' }))[1]).not.toContain('min=');
  });

  it('shows an error on the field it belongs to, in the shared error style', () => {
    const html = render({ endError: 'The end date cannot be before the start date.' });
    const [start, end] = inputs(html);
    expect(end).toContain('aria-invalid="true"');
    expect(start).toContain('aria-invalid="false"');
    expect(html).toContain(
      '<p class="text-xs font-medium text-signal-600">The end date cannot be before the start date.</p>',
    );
  });

  it('disables both together', () => {
    for (const tag of inputs(render({ disabled: true }))) expect(tag).toContain('disabled=""');
  });

  it('says how many days the range books', () => {
    expect(render()).toContain('3 days');
    expect(render({ end: '' })).toContain('Leave the end date blank for a single-day service.');
  });

  it('is a single "Scheduled date" on a job type not booked across a range', () => {
    const html = render({ range: false, end: '' });
    expect(inputs(html)).toHaveLength(1);
    expect(html).toContain('Scheduled date');
    expect(html).not.toContain('Scheduled end date');
    expect(html).not.toContain('job-schedule-dates-summary');
  });
});

describe('New Job', () => {
  const page = readFileSync(new URL('../../app/(app)/jobs/new/page.tsx', import.meta.url), 'utf8');

  it('draws its scheduled dates from the shared section, and nowhere else', () => {
    expect(page).toContain('<JobScheduleDates');
    expect(page).not.toMatch(/label="Scheduled end date"/u);
    expect(page).not.toMatch(/'Scheduled start date'/u);
  });
});
