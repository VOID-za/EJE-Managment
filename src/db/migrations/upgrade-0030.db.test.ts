import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase, type Database } from '@/db/client';
import { testDatabaseUrl } from '@/data/postgres/test-database';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { PostgresDocumentRepository } from '@/data/postgres/document-repository';
import { asDocumentId, asUserId, type TechnicalDocument } from '@/domain';

/**
 * THE UPGRADE PATH THE NEXT RELEASE TAKES: 0029 → 0030, WITH DATA IN IT.
 *
 * Every database test builds its schema from EMPTY (`openTestDatabase`), which
 * proves the migrations compose. It does not prove what a deployment does: a
 * database that has been running at `0029`, holding real rows, receiving one
 * more migration through the REAL migrator. This does exactly that.
 *
 *  - THE REAL MIGRATOR. `npm run db:migrate` is `drizzle-kit migrate`, which
 *    records each migration in `drizzle.__drizzle_migrations` and applies only
 *    those whose journal timestamp is newer than the last one recorded. A
 *    migration with an older `when` than its predecessor is SILENTLY SKIPPED —
 *    so the journal entry for `0030` is part of what is under test, and raw SQL
 *    could not catch it. `drizzle-orm`'s `migrate` is the engine drizzle-kit
 *    calls, reading the same folder and the same ledger.
 *  - THE LIVE STATE FIRST. The folder is cut off at `0029` — the live ledger
 *    read 30 after 24 October — and library documents are written in every
 *    indexing state the live code produces, with their page rows.
 *  - THEN 0030, and: every row identical to the byte; the ledger at 31; the
 *    "coverage unknown" row (partially indexed, 0 of M) refused BEFORE and
 *    accepted AFTER; an overstated `indexed` still refused; and a second run
 *    applying nothing.
 *
 * Run with `npm run db:test`. Skipped where there is no `TEST_DATABASE_URL`.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const MIGRATIONS = join(import.meta.dirname, '.');
const LAST_LIVE = '0029_library_page_text';

const doc = (suffix: string): string => `00000000-0000-4000-8000-0000000003${suffix}`;
const STATES = {
  indexed: doc('01'),
  partial: doc('02'),
  needsOcr: doc('03'),
  failed: doc('04'),
  probe: doc('05'),
} as const;

const technicalDocument = (id: string, name: string): TechnicalDocument => ({
  id: asDocumentId(id),
  name: `Manual ${name}`,
  description: '',
  documentType: 'service_manual',
  manufacturer: 'Leadwell',
  machineModel: 'V40',
  version: '1.0',
  status: 'current',
  fileName: `${name}.pdf`,
  fileSizeBytes: 1024,
  checksumSha256: null,
  pageCount: 10,
  storageKey: `uploads/${id}`,
  provenance: 'genuine',
  uploadedAt: '2026-10-01T08:00:00.000Z',
  uploadedBy: asUserId(IDS.master),
  tags: [],
});

/** A migrations folder holding exactly the migrations up to `lastTag`. */
const folderThrough = (lastTag: string): string => {
  const out = mkdtempSync(join(tmpdir(), 'eje-migrations-'));
  mkdirSync(join(out, 'meta'));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const cut = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (cut < 0) throw new Error(`${lastTag} is not in the journal`);
  const entries = journal.entries.slice(0, cut + 1);
  writeFileSync(join(out, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }, null, 2));
  for (const entry of entries) copyFileSync(join(MIGRATIONS, `${entry.tag}.sql`), join(out, `${entry.tag}.sql`));
  return out;
};

const refusalOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    let current: unknown = error;
    const said: string[] = [];
    for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
      said.push(current.message);
      current = (current as { cause?: unknown }).cause;
    }
    return said.join(' | ');
  }
  throw new Error('that statement was expected to be refused, and was not');
};

const ledger = async (db: Database): Promise<number> => {
  const rows = await db.execute<{ n: string }>(sql`select count(*)::text as n from drizzle.__drizzle_migrations`);
  return Number(rows[0]?.n ?? -1);
};

/** Every library row, as text, in a stable order — what "unchanged" is compared on. */
const snapshot = async (db: Database): Promise<string> => {
  const documents = await db.execute(sql`select * from library_documents order by id`);
  const versions = await db.execute(sql`select * from library_document_versions order by id`);
  const texts = await db.execute(
    sql`select document_id, state, source, characters, pages, pages_indexed, truncated,
               unreadable_streams, failure_reason, content, search::text as search
          from library_document_text order by document_id`,
  );
  const pages = await db.execute(
    sql`select document_id, page_number, source, characters, content, search::text as search
          from library_document_pages order by document_id, page_number`,
  );
  return JSON.stringify({ documents, versions, texts, pages });
};

const insertText = (
  db: Database,
  id: string,
  state: string,
  pages: number,
  pagesIndexed: number,
  content: string,
) =>
  db.execute(sql`insert into library_document_text
      (document_id, state, source, extracted_at, characters, pages, pages_indexed, truncated,
       unreadable_streams, failure_reason, content)
    values (${id}, ${state},
      ${state === 'indexed' || state === 'partially_indexed' ? 'text_layer' : null},
      now(), ${content.length}, ${pages}, ${pagesIndexed}, false, 0,
      ${state === 'indexed' ? '' : `The reason for ${state}.`}, ${content})`);

describeDb('the upgrade path 0029 → 0030, on PostgreSQL 16, through the real migrator', () => {
  let db: Database;
  let live: string;
  let before: string;

  beforeAll(async () => {
    db = createDatabase({ connectionString: url ?? '', maxConnections: 2 });
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);

    live = folderThrough(LAST_LIVE);
    await migrate(db, { migrationsFolder: live });

    // The live state: the baseline register, and library documents in every
    // indexing state the live code writes, with their page rows.
    await seedBaseline(db);
    const documents = new PostgresDocumentRepository(db);
    for (const [name, id] of Object.entries(STATES)) {
      await documents.save(technicalDocument(id, name));
    }
    await insertText(db, STATES.indexed, 'indexed', 10, 10, 'Every page of the alarm manual.');
    await insertText(db, STATES.partial, 'partially_indexed', 10, 7, 'Seven pages; three are diagrams.');
    await insertText(db, STATES.needsOcr, 'needs_ocr', 10, 0, '');
    await insertText(db, STATES.failed, 'failed', 10, 0, '');
    for (let page = 1; page <= 10; page += 1) {
      await db.execute(sql`insert into library_document_pages
          (document_id, page_number, source, characters, content, extracted_at)
        values (${STATES.indexed}, ${page}, 'text_layer', 12, ${`Page ${page} text`}, now())`);
    }
    for (const page of [1, 2, 3, 5, 6, 8, 9]) {
      await db.execute(sql`insert into library_document_pages
          (document_id, page_number, source, characters, content, extracted_at)
        values (${STATES.partial}, ${page}, 'text_layer', 12, ${`Page ${page} text`}, now())`);
    }
    before = await snapshot(db);
  }, 120_000);

  afterAll(async () => {
    rmSync(live, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
  });

  it('starts where the live server is: 30 migrations recorded', async () => {
    expect(await ledger(db)).toBe(30);
  });

  it('BEFORE 0030, a partial index with page coverage unknown (0 of M) is refused', async () => {
    const refusal = await refusalOf(insertText(db, STATES.probe, 'partially_indexed', 214, 0, 'Some.'));
    expect(refusal).toContain('library_document_text_pages_indexed_matches_state');
  });

  it('applies 0030 through the real migrator — the journal timestamp is newer, so it is not skipped', async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect(await ledger(db)).toBe(31);
  });

  it('leaves every existing library row exactly as it was', async () => {
    expect(await snapshot(db)).toBe(before);
  });

  it('AFTER 0030, accepts a partial index with page coverage unknown (0 of M)', async () => {
    await insertText(db, STATES.probe, 'partially_indexed', 214, 0, 'The first part of a long manual.');
    const rows = await db.execute<{ state: string; pages_indexed: number }>(
      sql`select state, pages_indexed from library_document_text where document_id = ${STATES.probe}`,
    );
    expect(rows[0]).toEqual({ state: 'partially_indexed', pages_indexed: 0 });
  });

  it('…and still refuses `indexed` claiming fewer pages than the document has', async () => {
    const refusal = await refusalOf(
      db.execute(sql`update library_document_text set state = 'indexed', pages_indexed = 96, pages = 214
                       where document_id = ${STATES.probe}`),
    );
    expect(refusal).toContain('library_document_text_pages_indexed_matches_state');
  });

  it('a second run applies nothing — re-running the migration is safe', async () => {
    await migrate(db, { migrationsFolder: MIGRATIONS });
    expect(await ledger(db)).toBe(31);
  });

  it('cuts the folder where it says: 0030 is the only migration the live server lacks', () => {
    const shipped = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort();
    const atLive = readdirSync(live).filter((name) => name.endsWith('.sql')).sort();
    expect(shipped.filter((name) => !atLive.includes(name))).toEqual([
      '0030_library_page_coverage_unknown.sql',
    ]);
  });
});
