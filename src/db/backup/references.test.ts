import { describe, expect, it } from 'vitest';
import {
  describeReferences,
  KEY_COLUMN_QUERY,
  keyColumnsFrom,
  partitionOrphans,
  referenceId,
  resolveReferences,
  scansForReferences,
  storedFilesFor,
  unresolved,
  type ResolvedReference,
} from './references';

/**
 * THE CHECK THAT ALWAYS FAILED. BACKUP-1.
 *
 * `restore-test.ts` compared a storage key against the names of the files it
 * had unpacked. The store writes `<key>.bin` and `<key>.json`, so a key never
 * equalled a file name and EVERY reference came back an orphan — which is what
 * the operator saw as "25 document references without corresponding stored
 * files" on a deployment whose documents were mostly present. The first test
 * below is that comparison, written the way the adapter actually names things.
 */
const present = (...files: readonly string[]): ReadonlySet<string> => new Set(files);

const reference = (storageKey: string, table = 'final_documents') => ({ table, storageKey });

describe('resolving a storage key to the files behind it', () => {
  it('knows the two files the store writes for one key', () => {
    expect(storedFilesFor('jobcards/final/EJE-2015.pdf')).toEqual({
      bytes: 'jobcards/final/EJE-2015.pdf.bin',
      sidecar: 'jobcards/final/EJE-2015.pdf.json',
    });
  });

  it('RESOLVES a key whose bytes and sidecar are both there', () => {
    const resolved = resolveReferences(
      [reference('jobcards/final/EJE-2015.pdf')],
      present('jobcards/final/EJE-2015.pdf.bin', 'jobcards/final/EJE-2015.pdf.json'),
    );

    // Against the old comparison — `present.has(key)` — this was an orphan,
    // and so was every other row in the database.
    expect(resolved[0]?.verdict).toBe('resolved');
    expect(unresolved(resolved)).toEqual([]);
  });

  it('reports a key with no bytes as missing', () => {
    const resolved = resolveReferences([reference('uploads/nothing-here')], present());
    expect(resolved[0]?.verdict).toBe('bytes_missing');
  });

  /**
   * BYTES WITHOUT A SIDECAR IS ITS OWN FAILURE, not a resolved reference.
   * `getDocument` needs the sidecar for the name, type and checksum and
   * answers null without it — so this is a job card that is on the disk and
   * cannot be opened, which is worth a different sentence from "it is gone".
   */
  it('reports bytes with no sidecar separately, because the application cannot serve them', () => {
    const resolved = resolveReferences(
      [reference('jobcards/final/EJE-2016.pdf')],
      present('jobcards/final/EJE-2016.pdf.bin'),
    );
    expect(resolved[0]?.verdict).toBe('sidecar_missing');
    expect(unresolved(resolved)).toHaveLength(1);
  });

  it('does not confuse one key with another that starts the same way', () => {
    const resolved = resolveReferences(
      [reference('jobcards/final/EJE-2.pdf')],
      present('jobcards/final/EJE-20.pdf.bin', 'jobcards/final/EJE-20.pdf.json'),
    );
    expect(resolved[0]?.verdict).toBe('bytes_missing');
  });
});

describe('whose fault a missing document is', () => {
  const orphans: readonly ResolvedReference[] = [
    { table: 'machine_photos', storageKey: 'uploads/allocated-never-written', verdict: 'bytes_missing' },
    { table: 'final_documents', storageKey: 'jobcards/final/EJE-4100.pdf', verdict: 'bytes_missing' },
  ];

  it('separates what was already missing from what the backup LOST', () => {
    // The manifest recorded the first one as dangling at the moment the backup
    // ran. The second one was there and is not any more.
    const recorded = new Set(['machine_photos:uploads/allocated-never-written']);
    const partition = partitionOrphans(orphans, recorded);

    expect(partition.preExisting.map(referenceId)).toEqual([
      'machine_photos:uploads/allocated-never-written',
    ]);
    expect(partition.lost.map(referenceId)).toEqual(['final_documents:jobcards/final/EJE-4100.pdf']);
  });

  it('calls everything LOST when the manifest recorded nothing', () => {
    // A backup taken before the dangling list existed. Nothing may be called
    // pre-existing on no evidence — the operator decides, and is told so.
    const partition = partitionOrphans(orphans, new Set());
    expect(partition.lost).toHaveLength(2);
    expect(partition.preExisting).toHaveLength(0);
  });

  it('says the dangerous number in its own line, where it cannot be skimmed past', () => {
    const text = describeReferences({
      total: 25,
      resolvedCount: 23,
      partition: partitionOrphans(orphans, new Set(['machine_photos:uploads/allocated-never-written'])),
    });

    expect(text).toMatch(/23 of 25 storage key\(s\) resolved/u);
    expect(text).toMatch(/1 were ALREADY missing when this backup was taken/u);
    expect(text).toMatch(/1 HAD a file when the backup was taken and do not now/u);
  });

  it('says nothing about either kind when there is nothing to say', () => {
    const text = describeReferences({
      total: 8,
      resolvedCount: 8,
      partition: { preExisting: [], lost: [] },
    });
    expect(text).toBe('8 of 8 storage key(s) resolved to a stored file');
  });
});

describe('which tables are scanned at all', () => {
  it('skips the table that merely RECORDS keys, including the absent ones', () => {
    // `final_document_verifications` holds one row per look at a document, and
    // the looks that found nothing are the point of it. Counting those as
    // references would report the same missing job card once per observation
    // and grow the number every time the reconcile ran.
    expect(scansForReferences('final_documents')).toBe(true);
    expect(scansForReferences('job_media')).toBe(true);
    expect(scansForReferences('final_document_verifications')).toBe(false);
  });
});

describe('which columns name a file of their own', () => {
  it('takes storage_key and anything ending in _storage_key', () => {
    const columns = keyColumnsFrom(
      ['final_documents.storage_key', 'job_corrections.document_storage_key'].join('\n'),
    );
    expect(columns).toEqual([
      { table: 'final_documents', column: 'storage_key' },
      { table: 'job_corrections', column: 'document_storage_key' },
    ]);
  });

  it('includes the correction addendum, which it used to miss entirely', () => {
    /*
     * `job_corrections.document_storage_key` holds the ONLY reference to an
     * addendum PDF's bytes. While the scan asked for `column_name =
     * 'storage_key'`, a correction lost from storage was not reported by the
     * restore test at all — the one document class the restore test was blind
     * to. Proved against a real backup afterwards: the reference count went
     * from 16 to 17 and the resolved count from 7 to 8 on the same database.
     */
    expect(KEY_COLUMN_QUERY).toContain("column_name LIKE '%\\_storage\\_key'");
    expect(keyColumnsFrom('job_corrections.document_storage_key')).toHaveLength(1);
  });

  it('leaves out the verification table, whose keys are observations', () => {
    expect(keyColumnsFrom('final_document_verifications.storage_key')).toEqual([]);
  });

  it('refuses a table or column name that is not a plain identifier', () => {
    // They come from `information_schema` and are interpolated into a query,
    // so they are re-checked rather than trusted for their provenance.
    expect(keyColumnsFrom('"evil table".storage_key')).toEqual([]);
    expect(keyColumnsFrom('jobs.storage_key; drop table jobs')).toEqual([]);
  });

  it('ignores blank lines and whitespace, which psql emits', () => {
    expect(keyColumnsFrom('\n  final_documents.storage_key  \n\n')).toEqual([
      { table: 'final_documents', column: 'storage_key' },
    ]);
  });
});
