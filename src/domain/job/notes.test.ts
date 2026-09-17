import { describe, expect, it } from 'vitest';
import { customerFacingNotes, internalNotes } from './notes';
import { asUserId } from '../types/common';
import type { JobNote } from '../types/job';

/**
 * The rule the business cares about: a note marked internal must never appear on
 * the document the customer receives, and a note that is NOT internal must.
 * Previously the job card rendered no notes at all, so customer-facing notes
 * were silently lost.
 */
const note = (id: string, internal: boolean, createdAt: string): JobNote => ({
  id,
  body: `note ${id}`,
  authorId: asUserId('user-tech-sipho'),
  createdAt,
  internal,
});

const notes = [
  note('b', false, '2026-09-17T10:00:00.000Z'),
  note('a', true, '2026-09-17T09:00:00.000Z'),
  note('c', false, '2026-09-17T11:00:00.000Z'),
];

describe('customerFacingNotes', () => {
  it('includes every note that is not internal', () => {
    expect(customerFacingNotes(notes).map((entry) => entry.id)).toEqual(['b', 'c']);
  });

  it('excludes every internal note', () => {
    expect(customerFacingNotes(notes).some((entry) => entry.internal)).toBe(false);
  });

  it('orders them oldest first, the way a running record reads', () => {
    const ordered = customerFacingNotes(notes).map((entry) => entry.createdAt);
    expect(ordered).toEqual([...ordered].sort());
  });

  it('returns nothing when every note is internal', () => {
    expect(customerFacingNotes([note('a', true, '2026-09-17T09:00:00.000Z')])).toHaveLength(0);
  });

  it('returns nothing when there are no notes', () => {
    expect(customerFacingNotes([])).toHaveLength(0);
  });

  it('does not mutate the source array', () => {
    const source = [...notes];
    customerFacingNotes(source);
    expect(source.map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('internalNotes', () => {
  it('returns only internal notes, newest first', () => {
    expect(internalNotes(notes).map((entry) => entry.id)).toEqual(['a']);
  });

  it('is the exact complement of the customer-facing set', () => {
    expect(internalNotes(notes).length + customerFacingNotes(notes).length).toBe(notes.length);
  });
});
