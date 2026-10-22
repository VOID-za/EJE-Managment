/**
 * WHAT IS IN THE STORE THAT THE DATABASE HAS NEVER HEARD OF? BACKUP-1, DEMO-1.
 *
 * `documents:reconcile` asks one direction of the question — does every row
 * describe a file that is there. This is the other direction, and nothing asked
 * it before: are there files there that no row describes?
 *
 * WHY IT MATTERS, AND IT IS NOT TIDINESS. Every upload writes the bytes first
 * and records the row afterwards. When the row cannot be written — a refused
 * trigger, a constraint, a lost connection — the transaction rolls back and the
 * bytes stay. `trackStorageWrites` now undoes those as they happen — including
 * a `putDocument` that CREATED its file, though never one that replaced an
 * existing document — but it cannot undo the ones written before it existed,
 * and it leaves a key alone when the store cannot say whether a file was there.
 * So a customer's document that a technician was told failed to upload may be
 * sitting in the storage directory, in every backup of it, and in every restore
 * of those backups, with no row to say whose it is or who may read it.
 *
 * THE SAFE DIRECTION IS TO OVER-REPORT A REFERENCE, NEVER AN ORPHAN. A file
 * wrongly called an orphan is one an operator may delete; a reference this
 * misses is litter. So the caller gathers keys from EVERY column that could
 * hold one — including the foreign keys the backup's reference count leaves out
 * on purpose, and the outbox's array column — and anything mentioned anywhere
 * is not an orphan.
 *
 * NOTHING HERE DELETES ANYTHING. It reports. `--remove-orphans` is a separate
 * flag an operator has to ask for, and it has to say how many it expects.
 */

/** The two files `FilesystemStorageService` writes, and what else turns up. */
export interface StoreScan {
  /** Keys with bytes in the store that nothing in the database refers to. */
  readonly orphans: readonly string[];
  /**
   * Leftovers from an interrupted durable write: `.tmp-<uuid>-<name>`.
   *
   * The adapter writes to one of these, fsyncs it and renames it into place,
   * removing it if the write fails. One that survived means the process died
   * between the open and the rename, so it is half a file at most and is
   * litter by definition — but it is reported rather than removed quietly,
   * because a store full of them says something about the machine.
   */
  readonly temporary: readonly string[];
  /**
   * Files that are neither `<key>.bin`, `<key>.json`, nor a temporary.
   *
   * Never offered for removal. Something put them there and this tool does not
   * know what — that is a question for an operator, not an answer for a script.
   */
  readonly unexpected: readonly string[];
  /** Keys whose sidecar is there and whose bytes are not, or the reverse. */
  readonly halfStored: readonly string[];
}

/** Is this the litter of an interrupted write? */
const isTemporary = (file: string): boolean => {
  const slash = file.lastIndexOf('/');
  return (slash === -1 ? file : file.slice(slash + 1)).startsWith('.tmp-');
};

/**
 * Divides what is on disk against what the database refers to.
 *
 * `files` are paths relative to the store root, as `filesUnder` returns them.
 * `referenced` is every storage key the database mentions, from anywhere.
 */
export const scanStore = (
  files: readonly string[],
  referenced: ReadonlySet<string>,
): StoreScan => {
  const temporary: string[] = [];
  const unexpected: string[] = [];
  const bytes = new Set<string>();
  const sidecars = new Set<string>();

  for (const file of files) {
    if (isTemporary(file)) {
      temporary.push(file);
      continue;
    }
    if (file.endsWith('.bin')) {
      bytes.add(file.slice(0, -'.bin'.length));
      continue;
    }
    if (file.endsWith('.json')) {
      sidecars.add(file.slice(0, -'.json'.length));
      continue;
    }
    unexpected.push(file);
  }

  const orphans: string[] = [];
  for (const key of bytes) {
    if (!referenced.has(key)) orphans.push(key);
  }

  /*
   * A SIDECAR WITH NO BYTES IS NOT AN ORPHAN AND NOT NOTHING.
   *
   * It is half a write: the bytes landed and the sidecar did not, or the
   * reverse. The adapter answers null for such a key, so a row pointing at it
   * reads as a missing document, and a row that does not exist leaves a file
   * nobody can interpret. Reported on its own, and never removed by this tool,
   * because which half is missing decides what to do about it.
   */
  const halfStored: string[] = [];
  for (const key of bytes) if (!sidecars.has(key)) halfStored.push(key);
  for (const key of sidecars) if (!bytes.has(key)) halfStored.push(key);

  return {
    orphans: orphans.sort(),
    temporary: temporary.sort(),
    unexpected: unexpected.sort(),
    halfStored: [...new Set(halfStored)].sort(),
  };
};

/**
 * Is this scan a reason to exit non-zero?
 *
 * NO, AND DELIBERATELY SO. An orphan is a file too many, not a document lost:
 * nobody is being told a record exists when it does not, which is the failure
 * the reconcile's exit code is about. Making it fail would put an operator in
 * front of a red command they cannot fix without deleting something, which is
 * how a check teaches people to pass `--force`.
 */
export const orphansAreAFailure = false;

/** One line per kind, or a sentence saying there is nothing to say. */
export const describeScan = (scan: StoreScan, root: string): string => {
  const lines: string[] = [];
  if (scan.orphans.length === 0) {
    lines.push('orphaned files: none — every file in the store is referred to by a row.');
  } else {
    lines.push(
      `ORPHANED FILES: ${scan.orphans.length} in ${root} that NO row refers to. ` +
        'Bytes somebody uploaded whose record was never written, or was written and ' +
        'rolled back. They are in every backup of this store.',
    );
    for (const key of scan.orphans.slice(0, 20)) lines.push(`  orphan  ${key}`);
    if (scan.orphans.length > 20) {
      lines.push(`  … and ${scan.orphans.length - 20} more; use --report to list them all.`);
    }
    lines.push(
      '  Remove them with: npm run documents:reconcile -- --remove-orphans --expect-orphans ' +
        `${scan.orphans.length}`,
    );
  }

  if (scan.halfStored.length > 0) {
    lines.push(
      `HALF-STORED: ${scan.halfStored.length} key(s) have bytes without a sidecar or the ` +
        'reverse. Not removed here — which half is missing decides what to do: ' +
        `${scan.halfStored.slice(0, 10).join(', ')}`,
    );
  }
  if (scan.temporary.length > 0) {
    lines.push(
      `INTERRUPTED WRITES: ${scan.temporary.length} .tmp- file(s). Each is a write whose ` +
        'process died before the rename, so it is half a file at most. Safe to delete by hand.',
    );
  }
  if (scan.unexpected.length > 0) {
    lines.push(
      `UNEXPECTED: ${scan.unexpected.length} file(s) that are not a stored document. This ` +
        `tool will not touch them: ${scan.unexpected.slice(0, 10).join(', ')}`,
    );
  }
  return lines.join('\n');
};
