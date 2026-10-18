import { describe, expect, it } from 'vitest';
import { conflictingFields, draftConflictsWith, draftDiffersFrom, type ReportDraft } from './report-draft';
import type { JobCompletionReport } from '@/domain';

/**
 * A WRITE-UP TYPED WITH NO SIGNAL, AND WHAT MAY BE DONE WITH IT. OFF-WRITEUP-1.
 *
 * The case these exist for: a technician types three paragraphs in a basement,
 * the tablet keeps them, and meanwhile the office corrects the same write-up
 * from the other end — a customer rang, a part number was wrong. "Load the
 * draft into the form and save" would then replace a correction made by
 * somebody who knew something the draft does not, and nothing would say so.
 * CR-02 forbids exactly that silent overwrite.
 *
 * The decision is the technician's and is taken in front of both texts; what
 * is held here is the arithmetic that decides whether there is a conflict to
 * put in front of them at all.
 */
const report = (over: Partial<JobCompletionReport> = {}): JobCompletionReport => ({
  faultFindings: 'Replaced the contactor and meggered the motor.',
  diagnosis: '',
  workPerformed: '',
  recommendations: '',
  generalNotes: '',
  ...over,
});

const draft = (over: Partial<ReportDraft> = {}): ReportDraft => ({
  key: 'user-tech-sipho:job-1',
  userId: 'user-tech-sipho',
  jobId: 'job-1',
  jobNumber: 'EJE-1048',
  report: report({ faultFindings: 'Typed in the basement with no signal.' }),
  savedAt: '2026-10-18T07:00:00.000Z',
  ...over,
});

describe('whether a draft still has anything to say', () => {
  it('differs while the server has not caught up', () => {
    expect(draftDiffersFrom(draft(), report())).toBe(true);
  });

  it('says nothing once the server holds the same text', () => {
    const same = report({ faultFindings: 'Typed in the basement with no signal.' });
    expect(draftDiffersFrom(draft(), same)).toBe(false);
  });
});

describe('whether the server has moved under the draft', () => {
  const base = report({ faultFindings: '' });

  it('is a conflict when the server changed after the draft was taken', () => {
    const held = draft({ basedOn: base });
    const corrected = report({
      faultFindings: 'Office correction: the contactor was under warranty.',
    });

    expect(draftConflictsWith(held, corrected)).toBe(true);
    expect(conflictingFields(held, corrected)).toEqual(['faultFindings']);
  });

  it('is NOT a conflict when the server still holds what the draft was typed over', () => {
    const held = draft({ basedOn: base });
    expect(draftConflictsWith(held, base)).toBe(false);
    expect(conflictingFields(held, base)).toEqual([]);
  });

  /*
   * A draft the server has CAUGHT UP WITH is finished, not contested: the text
   * on the job is the draft's own text, however it got there.
   */
  it('is not a conflict when the server now holds the draft’s own text', () => {
    const held = draft({ basedOn: base });
    const landed = report({ faultFindings: 'Typed in the basement with no signal.' });
    expect(draftConflictsWith(held, landed)).toBe(false);
  });

  it('names every field the office changed, not just the first', () => {
    const held = draft({
      basedOn: report({ faultFindings: '', diagnosis: '', recommendations: '' }),
      report: report({ faultFindings: 'Mine.', diagnosis: 'Mine.' }),
    });
    const moved = report({
      faultFindings: 'Theirs.',
      diagnosis: 'Theirs.',
      recommendations: 'Theirs.',
    });
    expect([...conflictingFields(held, moved)].sort()).toEqual([
      'diagnosis',
      'faultFindings',
      'recommendations',
    ]);
  });

  /*
   * DRAFTS WRITTEN BEFORE THIS EXISTED HAVE NO BASE, and a conflict cannot be
   * reported honestly without one. They are offered exactly as they were — the
   * old behaviour, kept deliberately rather than guessed at.
   */
  it('reports no conflict for a draft that does not know what it was typed over', () => {
    const old = draft();
    expect(old.basedOn).toBeUndefined();
    expect(draftConflictsWith(old, report({ faultFindings: 'Anything at all.' }))).toBe(false);
    expect(conflictingFields(old, report())).toEqual([]);
  });
});
