import { describe, expect, it } from 'vitest';
import {
  JOB_PROGRESS_STAGES,
  allowedTransitions,
  canTransition,
  jobProgressPosition,
  jobStatusLabel,
} from './workflow';
import type { JobStatus } from '../types/job';

/**
 * The progress rail is the ACTIVE workflow, drawn.
 *
 * The regression this guards: the rail listed `submitted` as a stage, so every
 * job — including ones that could never reach it — showed a seventh step
 * called "Master Review", long after a technician's submission started issuing
 * the job card directly. The picture claimed a step the state machine no
 * longer has.
 */

const EXPECTED = ['Open', 'In Progress', 'Completion', 'Customer Signature', 'Review', 'Closed'];

describe('the active progress rail', () => {
  it('is exactly the six stages of the live workflow, in order', () => {
    expect(JOB_PROGRESS_STAGES.map((stage) => jobStatusLabel(stage))).toEqual(EXPECTED);
    expect(JOB_PROGRESS_STAGES).toHaveLength(6);
  });

  it('does not contain Master Review, by label or by status', () => {
    expect(JOB_PROGRESS_STAGES).not.toContain('submitted');
    expect(JOB_PROGRESS_STAGES.map((stage) => jobStatusLabel(stage))).not.toContain(
      'Master Review',
    );
  });

  it('has one Review stage, not two', () => {
    const reviews = JOB_PROGRESS_STAGES.filter((stage) =>
      jobStatusLabel(stage).toLowerCase().includes('review'),
    );
    expect(reviews).toEqual(['review']);
  });

  it('does not draw awaiting delivery as a stage of its own', () => {
    expect(JOB_PROGRESS_STAGES).not.toContain('awaiting_delivery');
  });
});

describe('where each status sits on that rail', () => {
  const indexOf = (stage: JobStatus): number => JOB_PROGRESS_STAGES.indexOf(stage);

  it('places each live stage on itself', () => {
    for (const stage of JOB_PROGRESS_STAGES) {
      expect(jobProgressPosition(stage)).toEqual({ index: indexOf(stage), interruption: null });
    }
  });

  it('shows awaiting spares as an interruption of In Progress', () => {
    expect(jobProgressPosition('awaiting_spares')).toEqual({
      index: indexOf('in_progress'),
      interruption: 'Awaiting Spares',
    });
  });

  it('holds an issued job at Review while its copy is in transit', () => {
    const position = jobProgressPosition('awaiting_delivery');
    expect(position.index).toBe(indexOf('review'));
    expect(position.interruption).toBe('Awaiting Delivery');
    // Emphatically not shown as closed: the customer does not have it yet.
    expect(position.index).toBeLessThan(indexOf('closed'));
  });

  it('shows a job left in the retired stage simply as Review', () => {
    const position = jobProgressPosition('submitted');
    expect(position.index).toBe(indexOf('review'));
    // No annotation at all: the retired stage is not a concept put in front of
    // users, and Review is where the job actually got to.
    expect(position.interruption).toBeNull();
  });

  it('places a job outside the workflow nowhere on the rail', () => {
    expect(jobProgressPosition('draft').index).toBe(-1);
    expect(jobProgressPosition('cancelled').index).toBe(-1);
  });
});

describe('the state machine agrees with the rail', () => {
  it('takes a signed job to Review, and Review to issue', () => {
    expect(canTransition('customer_signature', 'review')).toBe(true);
    expect(canTransition('review', 'awaiting_delivery')).toBe(true);
  });

  it('closes only from awaiting delivery, never straight from Review', () => {
    expect(canTransition('review', 'closed')).toBe(false);
    expect(canTransition('awaiting_delivery', 'closed')).toBe(true);
  });

  it('keeps the historical Master Review edges so old jobs can still move on', () => {
    // Reachable only by a job already in `submitted`; nothing routes into it
    // from the live path except this retained edge, which issuing does not use.
    expect(allowedTransitions('submitted')).toContain('awaiting_delivery');
    expect(canTransition('submitted', 'awaiting_delivery')).toBe(true);
  });
});

/**
 * Master Review cannot be entered.
 *
 * The strongest form of "new jobs never go there" is that the state machine
 * has no edge into it at all: not from Review, not from anywhere. The edges OUT
 * of it stay, so a job that entered before it was retired can still be issued.
 */
describe('nothing can enter Master Review', () => {
  const ALL: readonly JobStatus[] = [
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

  it.each(ALL)('%s cannot transition to submitted', (from) => {
    expect(canTransition(from, 'submitted')).toBe(false);
  });

  it('leaves no status at all with an edge into it', () => {
    const entries = ALL.filter((from) => allowedTransitions(from).includes('submitted'));
    expect(entries).toEqual([]);
  });

  it('still lets a job already in it be issued and closed', () => {
    expect(allowedTransitions('submitted')).toEqual(['awaiting_delivery', 'closed']);
  });

  it('routes a signed job to issue instead', () => {
    expect(allowedTransitions('review')).toEqual(['awaiting_delivery', 'completion']);
  });
});
