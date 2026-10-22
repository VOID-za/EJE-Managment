import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A MIGRATION THAT REDEFINES A CONSTRAINT MAY NOT SWALLOW `duplicate_object`.
 *
 * The house idiom for adding a constraint is
 *
 *   DO $$ BEGIN
 *     ALTER TABLE "x" ADD CONSTRAINT "c" …;
 *   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
 *
 * which is correct for a constraint that is NEW: a second run finds it already
 * there and does nothing. It is WRONG, and silently so, for a constraint an
 * earlier migration already added and this one means to REPLACE. The `ADD`
 * raises `duplicate_object`, the handler swallows it, the migration reports
 * success — and the OLD definition is what the database keeps enforcing.
 *
 * THIS IS NOT HYPOTHETICAL. `0023` rewrote `pricing_snapshot_lines_amounts_non_
 * negative` from "every amount is non-negative" to a rule per line kind, so a
 * discount line could carry the negative total that makes the lines add up to
 * the subtotal. Written with `duplicate_object`, migrating a database that had
 * `0018` left the old constraint in place: the discount line was refused and a
 * discount recorded as a POSITIVE amount — which anything summing the lines
 * would have ADDED to the bill — was accepted. The three `charges-and-discounts`
 * database tests caught it, but only on a database built from zero; a developer
 * whose database already had the constraint saw green.
 *
 * THE FORM THAT IS RIGHT drops first and adds unconditionally, putting the
 * silence on the drop instead:
 *
 *   DO $$ BEGIN
 *     ALTER TABLE "x" DROP CONSTRAINT "c";
 *   EXCEPTION WHEN undefined_object THEN NULL; END $$;
 *   ALTER TABLE "x" ADD CONSTRAINT "c" …;
 *
 * Re-runnable, quiet on a fresh database, and it installs the definition the
 * file actually contains.
 */

const directory = join(import.meta.dirname, '.');

const migrations = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join(directory, file), 'utf8') }));

/**
 * Every constraint name a migration DEFINES, by either route.
 *
 * `ADD CONSTRAINT` is only half of it: `0000` writes most of the schema's
 * constraints INSIDE `CREATE TABLE`, as `CONSTRAINT "name" CHECK (…)` — which
 * is where `pricing_snapshot_lines_amounts_non_negative` came from, and why a
 * first version of this test matching only `ADD CONSTRAINT` passed over the
 * very defect it was written for. A `DROP CONSTRAINT` is not a definition and
 * is excluded.
 */
const declared = (sql: string): readonly string[] => [
  ...new Set(
    [...sql.matchAll(/(ADD\s+|DROP\s+)?CONSTRAINT\s+"([^"]+)"/gi)]
      .filter((match) => !/^DROP/i.test(match[1] ?? ''))
      .map((match) => match[2] as string),
  ),
];

/** Only the names a statement ADDS, for the blocks examined below. */
const added = (sql: string): readonly string[] => [
  ...new Set(
    [...sql.matchAll(/ADD\s+CONSTRAINT\s+"([^"]+)"/gi)].map((match) => match[1] as string),
  ),
];

/**
 * The constraint names this migration adds inside a `duplicate_object` handler.
 *
 * Matched by splitting on the `DO $$` blocks rather than by one expression over
 * the whole file, because a migration mixes both forms and the question is which
 * block each `ADD CONSTRAINT` sits in.
 */
const addedSwallowingDuplicates = (sql: string): readonly string[] =>
  sql
    .split(/DO \$\$/)
    .slice(1)
    .filter((block) => /EXCEPTION[\s\S]*?duplicate_object/i.test(block.split('END $$')[0] ?? ''))
    .flatMap((block) => added(block.split('END $$')[0] ?? ''));

describe('a migration never redefines a constraint by swallowing the duplicate', () => {
  it('finds the migrations, so a passing run means something', () => {
    expect(migrations.length).toBeGreaterThan(20);
  });

  for (const [index, { file, sql }] of migrations.entries()) {
    it(`${file} adds no constraint an earlier migration already added`, () => {
      const earlier = new Set(
        migrations.slice(0, index).flatMap(({ sql: before }) => declared(before)),
      );
      const redefined = addedSwallowingDuplicates(sql).filter((name) => earlier.has(name));
      expect(
        redefined,
        `${file} would leave the OLD definition in place for: ${redefined.join(', ')}. ` +
          'Drop the constraint first (swallowing `undefined_object`) and add it unconditionally.',
      ).toEqual([]);
    });
  }
});
