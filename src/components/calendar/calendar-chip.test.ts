import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { entryClasses } from './CalendarEntryChip';
import { JOB_TYPE_CODES, getJobTypeDefinition, type JobTypeCode } from '@/domain';
import type { CalendarEntry } from '@/application/calendar';

/**
 * Month-view chip appearance.
 *
 * Two rules the redesign must not lose: the job-type colour system stays
 * exactly as it was, and absence is quieter than work without being invisible
 * or relying on colour alone.
 */
const source = readFileSync(new URL('./CalendarEntryChip.tsx', import.meta.url), 'utf8');

const jobEntry = (jobType: JobTypeCode) =>
  ({
    kind: 'job',
    id: 'j1',
    start: '2026-09-17',
    end: '2026-09-17',
    days: 1,
    title: 'EJE-1048',
    subtitle: '',
    jobNumber: 'EJE-1048',
    jobType,
    status: 'open',
    priority: 'normal',
    customerName: 'ABC Engineering',
    siteName: 'Johannesburg',
    machineLabel: 'Leadwell V-40',
    technicianIds: [],
    technicianNames: [],
    technicianInitials: [],
  }) as CalendarEntry;

const absence = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: 'availability',
    id: 'a1',
    start: '2026-09-17',
    end: '2026-09-17',
    days: 1,
    title: 'Thabo Nkosi',
    subtitle: 'Sick leave · All day',
    availabilityType: 'sick_leave',
    availabilityStatus: 'active',
    userId: 'u1',
    userName: 'Thabo Nkosi',
    userInitials: 'TN',
    blocking: true,
    allDay: true,
    timeLabel: 'All day',
    description: '',
    ...overrides,
  }) as CalendarEntry;

describe('job-type colours', () => {
  it('keep the established accent for every job type', () => {
    const expected: Record<string, string> = {
      breakdown: 'signal', // red
      installation: 'eje', // blue
      service: 'verdant', // green
      test_and_repair: 'violet-eje', // purple
      parts: 'amber-eje', // amber
    };

    for (const code of JOB_TYPE_CODES) {
      expect(entryClasses(jobEntry(code))).toContain(`bg-${expected[code]}-50`);
    }
  });

  it('draws every job type from its domain accent, not a local list', () => {
    for (const code of JOB_TYPE_CODES) {
      expect(['red', 'blue', 'green', 'violet', 'amber']).toContain(
        getJobTypeDefinition(code).accent,
      );
    }
  });
});

describe('absence is visually secondary to work', () => {
  it('uses a flat grey rather than any job accent', () => {
    const classes = entryClasses(absence({ availabilityType: 'annual_leave' }));
    expect(classes).toContain('bg-steel-100');
    for (const accent of ['bg-signal-50', 'bg-eje-50', 'bg-verdant-50', 'bg-violet-eje-50']) {
      expect(classes).not.toContain(accent);
    }
  });

  it('keeps sick leave distinguishable, but softened', () => {
    // Amber at reduced opacity: still readable as "off sick", no longer as loud
    // as an amber Parts job.
    expect(entryClasses(absence())).toContain('bg-amber-eje-50/70');
    expect(entryClasses(jobEntry('parts'))).toContain('bg-amber-eje-50');
    expect(entryClasses(jobEntry('parts'))).not.toContain('/70');
  });

  it('strikes through a cancelled record so it cannot read as live', () => {
    expect(entryClasses(absence({ availabilityStatus: 'cancelled' }))).toContain('line-through');
  });

  it('is drawn shorter than a job bar', () => {
    // 15px against 18px. The difference reads as weight, not misalignment.
    expect(source).toContain("'h-[15px] text-[10px] font-medium'");
    expect(source).toContain("'h-[18px] text-[11px] font-semibold'");
  });

  it('never relies on colour alone — it keeps its icon and type label', () => {
    expect(source).toContain('<Icon name="user"');
    expect(source).toContain('availabilityTypeShortLabel(entry.availabilityType)');
  });
});

describe('month view is deliberately compact', () => {
  it('shows nothing but the job number on a job bar', () => {
    // Customer and technician initials are behind `!compact`, so the month cell
    // carries the number and the colour and nothing else.
    expect(source).toContain('{!compact && <span className="truncate font-normal">{entry.customerName}</span>}');
    expect(source).toContain('{!compact && entry.technicianInitials.length > 0 && (');
  });

  it('still flags an urgent job, which is not secondary information', () => {
    expect(source).toContain("entry.priority === 'urgent'");
  });

  it('holds the part-day time window back to the roomier views', () => {
    expect(source).toContain('{!entry.allDay && !compact && (');
  });
});

describe('tapping an entry', () => {
  it('leaves a job linking straight to its job card', () => {
    expect(source).toContain('href={`/jobs/${entry.jobNumber}`}');
  });

  it('gives an absence a button, since it has no page of its own', () => {
    expect(source).toContain('onClick={() => onSelect(entry)}');
  });

  it('labels both for a screen reader', () => {
    expect(source).toContain('aria-label={`${entry.jobNumber} — ${entry.subtitle}`}');
    expect(source).toContain('aria-label={`${entry.userName} — ${entry.subtitle}`}');
  });
});
