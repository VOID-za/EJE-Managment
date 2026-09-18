/**
 * What became of a record the office asked to remove.
 *
 * Removal has two honest outcomes and the caller is told which happened, because
 * they are materially different: a deleted record is gone, an archived one is
 * still on every job card that named it and can still be read from history.
 *
 * Nothing that a job refers to is ever deleted. A closed job card that named a
 * site, a contact or a machine has to keep naming it — the customer holds a copy
 * of that document — so those records are archived instead: withdrawn from the
 * register and from every picker, still resolvable by id for ever.
 */
export type RemovalOutcome = 'deleted' | 'archived';

export interface RemovalResult {
  readonly outcome: RemovalOutcome;
  /** What to show the person who asked, in their words rather than ours. */
  readonly message: string;
}
