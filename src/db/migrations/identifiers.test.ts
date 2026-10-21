import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NO IDENTIFIER IN A SHIPPED MIGRATION MAY BE LONGER THAN PostgreSQL ALLOWS.
 *
 * PostgreSQL's `NAMEDATALEN` is 64, so an identifier is cut at 63 characters —
 * with a NOTICE that scrolls past in the middle of `drizzle-kit`'s output and
 * that nobody reads. The migration still succeeds. The constraint still works.
 * What is then true is worse than a failure: the constraint exists under a name
 * that appears NOWHERE in this repository, so a later migration that drops or
 * renames it by the name written in the file fails against every database that
 * has it.
 *
 * Drizzle generates `<table>_<column>_<reftable>_<refcolumn>_fk`, which two of
 * this release's foreign keys exceeded by five and thirteen characters. Both are
 * named explicitly now. This test is how it stays that way, because the only
 * signal otherwise is a NOTICE in a log.
 *
 * THE ONE EXCEPTION IS RECORDED RATHER THAN FIXED. `0014` is already applied to
 * EJE's database, and editing an applied migration changes the hash drizzle
 * records against it, which would make the next `db:migrate` try to run it
 * again. The name is wrong in the file and right in the database; the fix
 * belongs in a future migration that renames the constraint, not here.
 */

const LIMIT = 63;

const ALREADY_APPLIED_AND_LEFT_ALONE = [
  'final_document_verifications_final_document_id_final_documents_id_fk',
] as const;

const directory = join(import.meta.dirname, '.');

const migrations = readdirSync(directory)
  .filter((name) => name.endsWith('.sql'))
  .sort();

describe('migration identifiers fit in PostgreSQL', () => {
  it('finds the migrations, so a passing run means something', () => {
    expect(migrations.length).toBeGreaterThan(15);
  });

  for (const file of migrations) {
    it(`${file} names nothing longer than ${LIMIT} characters`, () => {
      const sql = readFileSync(join(directory, file), 'utf8');
      /*
       * Quoted identifiers only. Drizzle quotes every name it writes, and an
       * unquoted word that long in a comment or a CHECK body is not an
       * identifier — matching those would make this test fail on prose.
       */
      const quoted = sql.match(/"[A-Za-z_][A-Za-z0-9_]*"/g) ?? [];
      const tooLong = [...new Set(quoted.map((name) => name.slice(1, -1)))]
        .filter((name) => name.length > LIMIT)
        .filter(
          (name) =>
            !ALREADY_APPLIED_AND_LEFT_ALONE.includes(
              name as (typeof ALREADY_APPLIED_AND_LEFT_ALONE)[number],
            ),
        );
      expect(tooLong, `PostgreSQL would silently truncate: ${tooLong.join(', ')}`).toEqual([]);
    });
  }
});
