import type { JobNote } from '../types/job';

/**
 * Which notes reach the customer.
 *
 * Lives in the domain rather than in the document component because it is a
 * disclosure rule, not a rendering detail: an internal note must never appear on
 * anything the customer receives, whichever surface renders it.
 */
export const customerFacingNotes = (notes: readonly JobNote[]): readonly JobNote[] =>
  [...notes]
    .filter((note) => !note.internal)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Internal notes, newest first, for EJE staff only. */
export const internalNotes = (notes: readonly JobNote[]): readonly JobNote[] =>
  [...notes]
    .filter((note) => note.internal)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
