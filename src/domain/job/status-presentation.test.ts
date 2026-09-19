import { describe, expect, it } from 'vitest';
import {
  JOB_PROGRESS_STAGES,
  JOB_STATUS_ORDER,
  jobProgressPosition,
  jobStatusLabel,
  statusMatches,
} from './workflow';
import type { JobStatus } from '../types/job';

/**
 * Master Review is not a concept this system puts in front of anybody.
 *
 * It was removed from the workflow, and then found still on the Jobs page: a
 * count card, an entry in the status filter, and the badge on every historical
 * job — all of them reading the term straight out of `jobStatusLabel`. The
 * label was truthful about a retired status; what was wrong was exposing that
 * status to users at all.
 *
 * These assert the PRESENTATION, at its source. The status itself is untouched,
 * so no historical record is destroyed.
 */

const EVERY_STATUS: readonly JobStatus[] = [
  'draft',
  'open',
  'in_progress',
  'awaiting_spares',
  'completion',
  'customer_signature',
  'review',
  'awaiting_delivery',
  'submitted',
  'closed',
  'cancelled',
];

describe('no status is presented as Master Review', () => {
  it.each(EVERY_STATUS)('%s does not label as Master Review', (status) => {
    expect(jobStatusLabel(status).toLowerCase()).not.toContain('master');
  });

  it('presents the retired stage as Review, which is where such a job got to', () => {
    expect(jobStatusLabel('submitted')).toBe('Review');
  });

  it('never returns an empty or duplicate-looking label', () => {
    for (const status of EVERY_STATUS) {
      expect(jobStatusLabel(status).length).toBeGreaterThan(0);
    }
  });
});

describe('the status filter offers only statuses that exist for users', () => {
  it('does not offer the retired stage', () => {
    expect(JOB_STATUS_ORDER).not.toContain('submitted');
  });

  it('offers no option labelled Master Review', () => {
    const labels = JOB_STATUS_ORDER.map((status) => jobStatusLabel(status));
    expect(labels).not.toContain('Master Review');
    expect(labels.filter((label) => label.toLowerCase().includes('master'))).toEqual([]);
  });

  it('offers the live stages a job can actually be in, including awaiting delivery', () => {
    expect(JOB_STATUS_ORDER).toContain('awaiting_delivery');
    for (const stage of JOB_PROGRESS_STAGES) {
      expect(JOB_STATUS_ORDER, `${stage} is missing from the filter`).toContain(stage);
    }
  });

  it('lists exactly one Review option', () => {
    const reviews = JOB_STATUS_ORDER.map((status) => jobStatusLabel(status)).filter(
      (label) => label === 'Review',
    );
    expect(reviews).toHaveLength(1);
  });
});

describe('a job left in the retired stage is still reachable', () => {
  it('is found under the Review filter, which is what it is labelled', () => {
    expect(statusMatches('submitted', 'review')).toBe(true);
    expect(statusMatches('review', 'review')).toBe(true);
  });

  it('is not swept into any other filter', () => {
    for (const filter of EVERY_STATUS.filter((status) => status !== 'review')) {
      expect(statusMatches('submitted', filter)).toBe(filter === 'submitted');
    }
  });

  it('leaves every other status matching only itself', () => {
    for (const status of EVERY_STATUS.filter((candidate) => candidate !== 'submitted')) {
      for (const filter of EVERY_STATUS) {
        expect(statusMatches(status, filter)).toBe(status === filter);
      }
    }
  });

  it('sits at Review on the progress rail, unannotated', () => {
    const position = jobProgressPosition('submitted');
    expect(position.index).toBe(JOB_PROGRESS_STAGES.indexOf('review'));
    expect(position.interruption).toBeNull();
  });
});
