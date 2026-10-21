/**
 * DOES A STORAGE KEY RESOLVE TO A FILE? BACKUP-1, BACKUP-2.
 *
 * THE DEFECT THIS MODULE EXISTS FOR, and it is worth stating plainly because
 * the check it broke is the one the whole backup requirement rests on.
 *
 * `restore-test.ts` compared every `storage_key` in the restored database
 * against the list of files it had unpacked:
 *
 *     const present = new Set(files);            // jobcards/final/EJE-2015.pdf.bin
 *     if (!present.has(key)) orphans.push(key);  // jobcards/final/EJE-2015.pdf
 *
 * The store writes TWO files per key — `<key>.bin` for the bytes and
 * `<key>.json` for the name, type and checksum beside them — so a key never
 * equals a file name and `present.has(key)` was false for every row in the
 * database. Every reference was reported as an orphan, which is exactly what
 * the operator saw: "25 document references without corresponding stored
 * files" on a deployment whose documents were, mostly, there.
 *
 * TWO CONSEQUENCES, THE SECOND WORSE THAN THE FIRST. The restore test always
 * failed, so it could not be used; and the only way to get it to pass was
 * `EJE_RESTORE_ALLOW_ORPHANS=yes`, which accepts EVERY missing document
 * silently. A check that cries wolf gets switched off, and then it is not a
 * check at all.
 *
 * SO RESOLUTION IS DEFINED IN ONE PLACE, HERE, with the adapter's own naming,
 * and the orphans that are left are divided into two kinds that mean different
 * things — see `partitionOrphans`.
 */

/**
 * Tables whose `storage_key` is a RECORD OF a key, not a claim that a file
 * exists under it.
 *
 * `final_document_verifications` is exactly that: one row per look at a
 * document, including the looks that found nothing there. Counting those as
 * references would make a backup report the same missing job card once per
 * observation ever made of it, and the number would grow every time the
 * reconcile ran — which is how a count stops meaning anything.
 *
 * Read by the two scanners rather than by this module, which never queries
 * anything; both filter the `information_schema` listing through it.
 */
export const REFERENCE_EXEMPT_TABLES: readonly string[] = ['final_document_verifications'];

export const scansForReferences = (table: string): boolean =>
  !REFERENCE_EXEMPT_TABLES.includes(table);

/**
 * The SQL that finds every column holding a storage key a file should exist
 * under. One query, used by the backup and by the restore test, so the two
 * cannot disagree about what a reference is.
 *
 * WHY IT IS NOT `column_name = 'storage_key'` ANY MORE. It was, and it missed
 * the correction addenda: `job_corrections.document_storage_key` holds the only
 * reference to an addendum PDF's bytes, so a correction lost from storage was
 * not reported by the restore test at all. Anything whose name IS `storage_key`
 * or ENDS IN `_storage_key` names a file of its own.
 *
 * WHAT IS STILL LEFT OUT, DELIBERATELY: a column holding somebody else's key.
 * `job_corrections.corrects_document_key` and
 * `unsigned_delivery_authorisations.document_key` are foreign keys to
 * `final_documents.storage_key`, so the file they name is already counted
 * once. Counting them again would report one missing job card two or three
 * times, and a count that inflates with every feature stops meaning anything —
 * the same failure `REFERENCE_EXEMPT_TABLES` exists for.
 *
 * `documents:reconcile`'s orphan scan uses a WIDER net on purpose: there, any
 * mention at all means the file is not an orphan, and missing a mention would
 * offer a referenced file for deletion.
 */
export const KEY_COLUMN_QUERY =
  "SELECT table_name || '.' || column_name FROM information_schema.columns " +
  "WHERE table_schema = 'public' " +
  "AND (column_name = 'storage_key' OR column_name LIKE '%\\_storage\\_key') ORDER BY 1";

/** `table.column`, as `KEY_COLUMN_QUERY` returns it, split and filtered. */
export const keyColumnsFrom = (
  output: string,
): readonly { readonly table: string; readonly column: string }[] =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const dot = line.indexOf('.');
      return { table: line.slice(0, dot), column: line.slice(dot + 1) };
    })
    .filter((entry) => entry.table.length > 0 && entry.column.length > 0)
    .filter((entry) => scansForReferences(entry.table))
    /*
     * BOTH NAMES CHECKED AGAIN HERE. They come from `information_schema`, not
     * from a request, and they are interpolated into a query — so they are
     * re-validated as plain identifiers rather than trusted because of where
     * they came from.
     */
    .filter((entry) => /^[a-z_][a-z0-9_]*$/u.test(entry.table))
    .filter((entry) => /^[a-z_][a-z0-9_]*$/u.test(entry.column));

/** A storage key as some table in the database records it. */
export interface StorageReference {
  readonly table: string;
  readonly storageKey: string;
}

/** The two files `FilesystemStorageService` writes for one key. */
export const storedFilesFor = (
  storageKey: string,
): { readonly bytes: string; readonly sidecar: string } => ({
  bytes: `${storageKey}.bin`,
  sidecar: `${storageKey}.json`,
});

export type ReferenceVerdict =
  /** Bytes and sidecar both there. */
  | 'resolved'
  /** No bytes at all. The document is not in this backup. */
  | 'bytes_missing'
  /**
   * Bytes there, sidecar not.
   *
   * ITS OWN VERDICT RATHER THAN "RESOLVED", because the application cannot
   * serve it: `getDocument` needs the sidecar for the file's name and type and
   * answers null without it, so a restore in this state produces a job card
   * that exists on the disk and cannot be opened.
   */
  | 'sidecar_missing';

export interface ResolvedReference extends StorageReference {
  readonly verdict: ReferenceVerdict;
}

/**
 * Resolves every reference against a set of file paths relative to the store's
 * root — an unpacked archive, or the live storage directory.
 *
 * `present` holds paths exactly as the store writes them (`a/b.bin`), which is
 * what `filesUnder` returns and what `tar` lists once the leading `./` is
 * stripped by the caller.
 */
export const resolveReferences = (
  references: readonly StorageReference[],
  present: ReadonlySet<string>,
): readonly ResolvedReference[] =>
  references.map((reference) => {
    const files = storedFilesFor(reference.storageKey);
    if (!present.has(files.bytes)) return { ...reference, verdict: 'bytes_missing' };
    if (!present.has(files.sidecar)) return { ...reference, verdict: 'sidecar_missing' };
    return { ...reference, verdict: 'resolved' };
  });

export const unresolved = (
  resolved: readonly ResolvedReference[],
): readonly ResolvedReference[] => resolved.filter((entry) => entry.verdict !== 'resolved');

/** `table:key`, which is how a reference is written down in a manifest. */
export const referenceId = (reference: StorageReference): string =>
  `${reference.table}:${reference.storageKey}`;

export interface OrphanPartition {
  /**
   * References that had no file when the BACKUP was taken, and still do not.
   *
   * Not this backup's fault and not a reason to refuse it: a key allocated with
   * no bytes behind it (the photo capture paths do exactly that), and a seeded
   * demonstration job card whose PDF is rendered on first download, are both
   * legitimately dangling. They are reported, counted and recorded.
   */
  readonly preExisting: readonly ResolvedReference[];
  /**
   * References that DID have a file when the backup was taken and do not now.
   *
   * This is the failure BACKUP-1 exists to prevent: the database came back and
   * a document did not. It is fatal whatever any flag says, because the backup
   * itself lost something.
   */
  readonly lost: readonly ResolvedReference[];
}

/**
 * Divides what did not resolve by whether the backup is to blame.
 *
 * `recorded` is the list the backup run wrote into its own manifest at the
 * moment it ran. Its absence is handled by the caller: a manifest from before
 * this existed records nothing, and then nothing can be called pre-existing
 * without a decision from the operator.
 */
export const partitionOrphans = (
  orphans: readonly ResolvedReference[],
  recorded: ReadonlySet<string>,
): OrphanPartition => ({
  preExisting: orphans.filter((entry) => recorded.has(referenceId(entry))),
  lost: orphans.filter((entry) => !recorded.has(referenceId(entry))),
});

/**
 * What a person reads, with the counts in the order they matter.
 *
 * Deliberately one line per kind rather than a sentence listing three numbers:
 * the one that means "a document is gone" has to be impossible to skim past.
 */
export const describeReferences = (input: {
  readonly total: number;
  readonly resolvedCount: number;
  readonly partition: OrphanPartition;
}): string => {
  const lines = [
    `${input.resolvedCount} of ${input.total} storage key(s) resolved to a stored file`,
  ];
  if (input.partition.preExisting.length > 0) {
    lines.push(
      `${input.partition.preExisting.length} were ALREADY missing when this backup was taken ` +
        '(recorded in its manifest), so the backup did not lose them',
    );
  }
  if (input.partition.lost.length > 0) {
    lines.push(
      `${input.partition.lost.length} HAD a file when the backup was taken and do not now — ` +
        'this backup is missing documents',
    );
  }
  return lines.join('\n');
};
