import { describe, expect, it } from 'vitest';
import { evaluateChecklist, requiresNote } from './validation';
import { emptyChecklistResponse } from '../types/checklist';
import { asChecklistTemplateId } from '../types/common';
import type {
  ChecklistInstance,
  ChecklistResponse,
  ChecklistTemplate,
} from '../types/checklist';

/**
 * Notes on checklist items.
 *
 * A pass needs no explanation; a failure always does, because the customer reads
 * it. Demanding a note on every item would only train technicians to type filler.
 */
const template: ChecklistTemplate = {
  id: asChecklistTemplateId('chk-test'),
  name: 'Test Checklist',
  description: '',
  jobTypeCode: 'service',
  version: '1.0-TEST',
  status: 'current',
  sourceDocument: 'TEST',
  updatedAt: '2026-09-17T00:00:00.000Z',
  sections: [
    {
      id: 'sec-1',
      title: 'Section',
      description: '',
      items: [
        {
          id: 'pass-fail',
          text: 'Emergency stops functional',
          helpText: '',
          responseType: 'pass_fail_na',
          required: true,
          photoRequired: false,
          unit: null,
          expectedRange: null,
        },
        {
          id: 'measure',
          text: 'Cabinet temperature',
          helpText: '',
          responseType: 'measurement',
          required: true,
          photoRequired: false,
          unit: '°C',
          expectedRange: { min: 10, max: 35 },
        },
      ],
    },
  ],
};

const instance = (responses: ChecklistResponse[]): ChecklistInstance => ({
  templateId: template.id,
  templateVersion: template.version,
  responses,
  completedAt: null,
  completedBy: null,
});

const answer = (
  itemId: string,
  overrides: Partial<ChecklistResponse>,
): ChecklistResponse => ({
  ...emptyChecklistResponse(itemId),
  answeredAt: '2026-09-17T10:00:00.000Z',
  ...overrides,
});

const inRange = answer('measure', { measurement: 20 });

describe('requiresNote', () => {
  it('is false for a pass', () => {
    const item = template.sections[0]!.items[0]!;
    expect(requiresNote(item, answer('pass-fail', { choice: 'pass' }))).toBe(false);
  });

  it('is false for N/A', () => {
    const item = template.sections[0]!.items[0]!;
    expect(requiresNote(item, answer('pass-fail', { choice: 'na' }))).toBe(false);
  });

  it('is true for a fail', () => {
    const item = template.sections[0]!.items[0]!;
    expect(requiresNote(item, answer('pass-fail', { choice: 'fail' }))).toBe(true);
  });

  it('is true for a measurement outside the expected range', () => {
    const item = template.sections[0]!.items[1]!;
    expect(requiresNote(item, answer('measure', { measurement: 48 }))).toBe(true);
    expect(requiresNote(item, inRange)).toBe(false);
  });
});

describe('checklist completion', () => {
  it('completes with a pass and no note', () => {
    const progress = evaluateChecklist(
      template,
      instance([answer('pass-fail', { choice: 'pass' }), inRange]),
    );
    expect(progress.complete).toBe(true);
  });

  it('completes with N/A and no note', () => {
    const progress = evaluateChecklist(
      template,
      instance([answer('pass-fail', { choice: 'na' }), inRange]),
    );
    expect(progress.complete).toBe(true);
  });

  it('BLOCKS completion when a failed item has no note', () => {
    const progress = evaluateChecklist(
      template,
      instance([answer('pass-fail', { choice: 'fail' }), inRange]),
    );

    expect(progress.complete).toBe(false);
    const issue = progress.issues.find((candidate) => candidate.reason === 'note_required');
    expect(issue?.itemId).toBe('pass-fail');
    expect(issue?.message).toContain('Emergency stops functional');
  });

  it('completes once the failed item is explained', () => {
    const progress = evaluateChecklist(
      template,
      instance([
        answer('pass-fail', { choice: 'fail', notes: 'Station 2 E-stop does not latch.' }),
        inRange,
      ]),
    );
    expect(progress.complete).toBe(true);
    expect(progress.failedItems).toBe(1);
  });

  it('treats whitespace as no note at all', () => {
    const progress = evaluateChecklist(
      template,
      instance([answer('pass-fail', { choice: 'fail', notes: '   ' }), inRange]),
    );
    expect(progress.complete).toBe(false);
  });

  it('also demands a note for an out-of-range measurement', () => {
    const progress = evaluateChecklist(
      template,
      instance([
        answer('pass-fail', { choice: 'pass' }),
        answer('measure', { measurement: 48 }),
      ]),
    );
    expect(progress.complete).toBe(false);
    expect(progress.issues.some((issue) => issue.itemId === 'measure')).toBe(true);
  });

  it('names every item that still needs a note', () => {
    const progress = evaluateChecklist(
      template,
      instance([
        answer('pass-fail', { choice: 'fail' }),
        answer('measure', { measurement: 48 }),
      ]),
    );
    expect(progress.issues.filter((issue) => issue.reason === 'note_required')).toHaveLength(2);
  });
});
