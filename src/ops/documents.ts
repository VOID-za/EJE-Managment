import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { loadEnvFiles } from '@/db/seed/env';
import { scansForReferences } from '@/db/backup/references';
import {
  FilesystemStorageService,
  readStorageConfiguration,
  StorageIntegrityFailed,
} from '@/services/production/file-storage';
import {
  classifyDocument,
  demonstrationJobNumbers,
  reconcileFailed,
  summarise,
  summaryLine,
  type DocumentFinding,
  type DocumentRow,
  type StorageFact,
} from './document-rules';

/**
 * `npm run documents:reconcile` — DOES EVERY DOCUMENT RECORD DESCRIBE A FILE
 * THAT IS ACTUALLY THERE? BACKUP-1.
 *
 * WHAT IT WAS WRITTEN FOR, in the operator's words: `final_documents` held 14
 * rows whose `size_bytes` was 0, the storage directory held 8 documents, and
 * the restore test reported 25 references with no file behind them. Nothing
 * could say which of those were seeded demonstration job cards and which were
 * customer-signed records that had been lost — and that is the only question
 * worth asking first, because the two have opposite remedies.
 *
 * READ-ONLY BY DEFAULT.
 *
 *   npm run documents:reconcile                 report, write nothing
 *   npm run documents:reconcile -- --record     record what it found, as rows
 *   npm run documents:reconcile -- --report out.json
 *
 * `--record` APPENDS to `final_document_verifications` — it does not update
 * `final_documents`, and the first version of this command that tried to was
 * refused by the database, correctly:
 *
 *     final_documents is an immutable historical record; UPDATE is not
 *     permitted. Correct it by adding a new record.
 *
 * That trigger is one of the protections CR-01 rests on and it was left exactly
 * as it is. So the measurement is recorded beside the document rather than
 * written into it: an observation of what the bytes were on a given day, which
 * is what lets a later run tell a document that has changed from one that
 * never had its metadata recorded.
 *
 * NOTHING HERE MANUFACTURES A DOCUMENT. No bytes are written, no row is
 * deleted, and a missing signed job card is reported rather than re-rendered —
 * a fresh render is a new document carrying an old date, and the customer holds
 * the real one.
 *
 * It exits non-zero when a genuine document is missing, damaged, or contradicts
 * its record. An unrendered demonstration job card is not a failure.
 */

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const argument = (name: string): string | null => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
};

/**
 * Tables that hold a storage key, for the reference count the restore test
 * reports — READ FROM THE DATABASE, never listed here.
 *
 * It was a literal list of five tables, and by the time two more arrived
 * (`customer_documents`, `machine_documents`) it was quietly reporting a
 * smaller system than the one it was looking at. `backup/run.ts` and
 * `backup/restore-test.ts` both read `information_schema` for exactly that
 * reason; this now does the same, so a table that gains a `storage_key`
 * column is counted without anybody remembering to come back here.
 *
 * `REFERENCE_EXEMPT_TABLES` is applied, because `final_document_verifications`
 * records every LOOK at a document, including the looks that found nothing —
 * counting those would make the number grow each time this tool ran.
 */
/**
 * Every table carrying `provenance`, for the uncertainty count.
 *
 * Listed rather than discovered, unlike `keyTables`: `information_schema` would
 * also find a future column called `provenance` that means something else, and
 * this count is reported to an operator as a statement about documents.
 */
const PROVENANCE_TABLES = [
  'final_documents',
  'library_documents',
  'library_document_versions',
  'machine_photos',
  'customer_documents',
  'machine_documents',
] as const;

const keyTables = async (sql: postgres.Sql): Promise<readonly string[]> => {
  const rows = await sql<{ table_name: string }[]>`
    select table_name from information_schema.columns
     where column_name = 'storage_key' and table_schema = 'public'
     order by 1
  `.catch(() => null);
  if (rows === null) return [];
  return rows.map((row) => row.table_name).filter(scansForReferences);
};

const main = async (): Promise<void> => {
  loadEnvFiles();
  const record = flag('record');
  const reportPath = argument('report');
  const url = (process.env.DATABASE_URL ?? '').trim();
  if (url.length === 0) {
    throw new Error(
      'DATABASE_URL is not set, so there is no register to reconcile. See docs/vps-deployment.md.',
    );
  }

  const storage = new FilesystemStorageService(readStorageConfiguration(process.env));
  const sql = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => undefined });

  try {
    /*
     * The job NUMBER comes from the join, because it is what an operator reads
     * and what tells a demonstration job from a real one. The row's own
     * columns are read exactly as stored — a 0 is reported as a 0.
     *
     * `recorded` IS THE §1.3 QUESTION: was this row's provenance recorded, or
     * backfilled by 0015's default? `final_documents` is write-once, so
     * migration 0018 could not relabel its pre-provenance rows the way it did
     * for the other five tables — it wrote down WHEN recording began instead,
     * and this is where that row is spent. A job card older than the cutoff
     * carries a label nobody chose, whatever the column says, and is read as
     * "the row did not say".
     *
     * A database with no cutoff row — one restored from a dump predating 0018
     * — reports true, which is the previous behaviour and no worse than it.
     *
     * (No backticks below: the query is a template literal, and one would end
     * the string. That mistake cost a compile.)
     */
    const rows = await sql<
      {
        id: string;
        jobNumber: string;
        storageKey: string;
        fileName: string;
        sizeBytes: string;
        checksum: string | null;
        renderer: number;
        provenance: string | null;
        recorded: boolean;
      }[]
    >`
      select d.id            as "id",
             j.job_number    as "jobNumber",
             d.storage_key   as "storageKey",
             d.file_name     as "fileName",
             d.size_bytes    as "sizeBytes",
             d.checksum_sha256 as "checksum",
             d.renderer_version as "renderer",
             d.provenance    as "provenance",
             -- Was this row's provenance recorded, or backfilled? See above.
             coalesce(d.created_at >= r.recorded_from, true) as "recorded"
        from final_documents d
        join jobs j on j.id = d.job_id
        left join provenance_recording r on r.id = 'cutoff'
       order by j.job_number
    `;

    const demonstration = demonstrationJobNumbers();
    const findings: DocumentFinding[] = [];
    /** The document id and measurement behind each finding, for `--record`. */
    const observed = new Map<string, { id: string; fact: StorageFact }>();

    for (const raw of rows) {
      const row: DocumentRow = {
        jobNumber: raw.jobNumber,
        storageKey: raw.storageKey,
        fileName: raw.fileName,
        sizeBytes: Number(raw.sizeBytes),
        checksumSha256: raw.checksum,
        rendererVersion: Number(raw.renderer),
        /*
         * WHAT THE ROW SAYS IT IS. October mandate §1.3: read from the column
         * rather than inferred from the job number, which is the fallback for
         * rows written before the column existed.
         */
        /*
         * `unknown`, an unrecognised value, and a row that PREDATES recording
         * all arrive as null — which is what `classifyDocument` reads as "the
         * row did not say" and answers with the dataset fallback. One meaning,
         * one representation.
         */
        provenance: !raw.recorded
          ? null
          : raw.provenance === 'genuine' || raw.provenance === 'simulated'
            ? raw.provenance
            : null,
      };

      let fact: StorageFact;
      try {
        const stored = await storage.getDocument(row.storageKey);
        fact =
          stored === null
            ? { present: false }
            : {
                present: true,
                sizeBytes: stored.sizeBytes ?? stored.bytes.byteLength,
                sha256: stored.sha256,
                renderer: stored.renderer,
              };
      } catch (cause) {
        /*
         * A REFUSAL IS EVIDENCE, not an error to abort on. The store raises
         * when the bytes do not match what was recorded with them, and that is
         * precisely one of the verdicts this tool reports.
         */
        fact = {
          present: true,
          damaged:
            cause instanceof StorageIntegrityFailed
              ? cause.message
              : `the store could not read it: ${cause instanceof Error ? cause.message : 'unknown'}`,
        };
      }

      findings.push(classifyDocument(row, fact, demonstration));
      observed.set(row.storageKey, { id: raw.id, fact });
    }

    /* -- the wider reference count, which is what a restore test reports --- */
    const references: { table: string; total: number }[] = [];
    for (const table of await keyTables(sql)) {
      const counted = await sql<{ count: string }[]>`
        select count(*)::text as count from ${sql(table)}
      `.catch(() => null);
      if (counted !== null) {
        references.push({ table, total: Number(counted[0]?.count ?? '0') });
      }
    }

    /*
     * -- WHOSE RECORDS NOBODY CLASSIFIED. October mandate §1.3. -------------
     *
     * Counted per table and reported even when it is zero, because "no rows of
     * uncertain origin" is the answer an operator wants and silence is not it.
     * Read off the column rather than computed: migration 0018 relabelled the
     * rows written before provenance existed, and anything still reading
     * `unknown` afterwards is a row some later insert left unsaid.
     */
    const unrecorded: { table: string; total: number }[] = [];
    for (const table of PROVENANCE_TABLES) {
      /*
       * THE SAME RULE THE CLASSIFIER USES, or the two would disagree and the
       * summary would under-report exactly the rows the classifier distrusts:
       * a `genuine` label on a row written before recording began is a
       * default somebody never chose. A `simulated` label was positively
       * written and is believed whatever its date.
       */
      const counted = await sql<{ count: string }[]>`
        select count(*)::text as count
          from ${sql(table)} t
          left join provenance_recording r on r.id = 'cutoff'
         where t.provenance = 'unknown'
            or (t.provenance = 'genuine' and r.recorded_from is not null
                and t.created_at < r.recorded_from)
      `.catch(() => null);
      if (counted !== null) {
        unrecorded.push({ table, total: Number(counted[0]?.count ?? '0') });
      }
    }

    /* -- record what was found, beside the document and never in it -------- */
    let recorded = 0;
    if (record) {
      const verifiedAt = new Date().toISOString();
      for (const finding of findings) {
        const entry = observed.get(finding.storageKey);
        if (entry === undefined) continue;
        const measured = entry.fact;
        await sql`
          insert into final_document_verifications
            (id, final_document_id, storage_key, verdict, size_bytes, checksum_sha256,
             renderer_version, detail, verified_at)
          values (${crypto.randomUUID()}, ${entry.id}, ${finding.storageKey},
                  ${finding.verdict},
                  ${measured.present && measured.damaged === undefined ? (measured.sizeBytes ?? null) : null},
                  ${measured.present && measured.damaged === undefined ? (measured.sha256 ?? null) : null},
                  ${measured.renderer ?? null},
                  ${finding.detail}, ${verifiedAt})
        `;
        recorded += 1;
      }
    }

    /* -- say it ------------------------------------------------------------- */
    const summary = summarise(findings);
    process.stdout.write('\n=== EJE DOCUMENT RECONCILE ===\n');
    process.stdout.write(`${rows.length} final document record(s) examined\n`);
    process.stdout.write(
      `storage keys recorded elsewhere: ${references
        .filter((entry) => entry.table !== 'final_documents')
        .map((entry) => `${entry.table}=${entry.total}`)
        .join('  ')}\n`,
    );

    const uncertain = unrecorded.filter((entry) => entry.total > 0);
    if (uncertain.length === 0) {
      process.stdout.write('provenance: every record says where it came from.\n\n');
    } else {
      process.stdout.write(
        `provenance NOT RECORDED on: ${uncertain
          .map((entry) => `${entry.table}=${entry.total}`)
          .join('  ')}\n` +
          '  These rows predate the provenance column, or an insert left it unsaid. They are ' +
          'NOT claimed to be genuine and NOT claimed to be demonstration data — somebody has ' +
          'to look at them. This is a finding, not a failure.\n\n',
      );
    }

    for (const finding of findings) {
      if (finding.verdict === 'intact') continue;
      process.stdout.write(
        `[${finding.verdict.toUpperCase().padEnd(20)}] ${finding.jobNumber}  ${finding.detail}\n`,
      );
    }

    process.stdout.write(`\n${summaryLine(summary)}\n`);
    if (record) {
      process.stdout.write(
        `${recorded} observation(s) appended to final_document_verifications. ` +
          'No document record was altered, no row was removed, and no bytes were written.\n',
      );
    } else if (findings.length > 0) {
      process.stdout.write(
        'Nothing was written. Re-run with --record to keep this as evidence beside each ' +
          'document.\n',
      );
    }

    if (reportPath !== null) {
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          { examinedAt: new Date().toISOString(), summary, references, findings },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      process.stdout.write(`report written to ${reportPath}\n`);
    }

    if (reconcileFailed(findings)) {
      process.stdout.write(
        'RECONCILE FAILED — a document that is not demonstration data is missing, damaged or ' +
          'disagrees with its record. Recover it from a backup; do not re-render it.\n',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('RECONCILE PASSED.\n');
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
};

void main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const url = (process.env.DATABASE_URL ?? '').trim();
  // The driver quotes what it was given, and what it was given has a password.
  process.stderr.write(
    `documents  FAILED: ${url.length === 0 ? message : message.split(url).join('[connection string]')}\n`,
  );
  process.exitCode = 1;
});
