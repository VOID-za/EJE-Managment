import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/db/schema';
import type { Database } from '@/db/client';
import { IDS, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';

/**
 * ACCOUNT NOTES ON PostgreSQL. Customers §2.
 *
 * Two things that only exist here:
 *
 *   - THE EDIT IS WHOLE OR ABSENT. A note recorded as edited by nobody, or at
 *     no time, is half a record — and the equivalence has to be written
 *     NULL-proof, because a NULL inside a CHECK reads as satisfied.
 *   - AN EDITED NOTE KEEPS ITS AUTHOR. `author_id` and `created_at` are not
 *     touched by an edit, which is the whole reason the two new columns exist:
 *     the screen can show corrected words while still naming who wrote the
 *     original and when.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const messageOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) return cause.message;
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the statement was expected to be refused, and was not');
};

describeDb('customer account notes, on PostgreSQL', () => {
  let db: Database;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
  });

  const note = (over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    customerId: IDS.customer,
    body: 'Purchase order number must appear on every job card.',
    authorId: IDS.master,
    createdAt: '2026-10-01T09:00:00.000Z',
    editedBy: null,
    editedAt: null,
    ...over,
  });

  it('stores a note nobody has edited, with both edit fields null', async () => {
    await db.insert(schema.customerNotes).values(note());

    const [row] = await db.select().from(schema.customerNotes);
    expect(row?.body).toBe('Purchase order number must appear on every job card.');
    expect(row?.authorId).toBe(IDS.master);
    expect(row?.editedBy).toBeNull();
    expect(row?.editedAt).toBeNull();
  });

  it('stores an edited note, keeping the ORIGINAL author and date', async () => {
    await db.insert(schema.customerNotes).values(
      note({
        body: 'Corrected wording.',
        editedBy: IDS.coordinator,
        editedAt: '2026-10-20T14:30:00.000Z',
      }),
    );

    const [row] = await db.select().from(schema.customerNotes);
    expect(row?.body).toBe('Corrected wording.');
    // Who wrote it and when: untouched by the edit.
    expect(row?.authorId).toBe(IDS.master);
    expect(row?.createdAt).toBe('2026-10-01T09:00:00.000Z');
    // Who corrected it and when: recorded separately.
    expect(row?.editedBy).toBe(IDS.coordinator);
    expect(row?.editedAt).toBe('2026-10-20T14:30:00.000Z');
  });

  it('REFUSES an editor with no moment', async () => {
    const message = await messageOf(
      db.insert(schema.customerNotes).values(note({ editedBy: IDS.coordinator, editedAt: null })),
    );
    expect(message).toContain('customer_notes_edit_is_whole_or_absent');
  });

  it('REFUSES a moment with no editor', async () => {
    const message = await messageOf(
      db
        .insert(schema.customerNotes)
        .values(note({ editedBy: null, editedAt: '2026-10-20T14:30:00.000Z' })),
    );
    expect(message).toContain('customer_notes_edit_is_whole_or_absent');
  });

  it('REFUSES an editor who is not a user', async () => {
    const message = await messageOf(
      db.insert(schema.customerNotes).values(
        note({
          editedBy: '00000000-0000-4000-8000-0000000000ff',
          editedAt: '2026-10-20T14:30:00.000Z',
        }),
      ),
    );
    expect(message.toLowerCase()).toContain('foreign key');
  });
});
