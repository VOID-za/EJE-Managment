import type { StorageService, StoredDocument, StoredFile, UploadedFile } from './ports';

/**
 * BYTES WRITTEN BY A TRANSACTION THAT THEN FAILED. The orphan problem.
 *
 * WHAT WAS WRONG. Every upload path writes the bytes first and records the row
 * afterwards, and that order is right: it is what makes it impossible for a
 * database row to claim a customer's document exists when nothing was ever
 * written. The price is the other direction. The row and the audit event are
 * written inside a transaction; the bytes are not, because a filesystem has no
 * transaction to join. So a failed insert, a refused immutability trigger, a
 * constraint violation or a lost connection rolled the row back and left the
 * bytes on the disk with nothing pointing at them. Nothing noticed, nothing
 * could remove them, and the storage directory grew for the rest of the
 * deployment's life.
 *
 * It is not merely untidy. A customer's document that a technician believes
 * failed to upload is sitting in the storage directory, in a backup, and in
 * every restore of that backup, with no row to say whose it is or who may read
 * it.
 *
 * WHAT THIS DOES. It wraps the storage service for the duration of one unit of
 * work and remembers the keys that unit CREATED. If the work throws, the
 * runtime removes exactly those keys and rethrows the original error. If the
 * work succeeds, nothing is removed.
 *
 * THE TWO KINDS OF WRITE, AND WHY ONE NEEDS A QUESTION ASKED FIRST.
 * `storeUpload` GENERATES a fresh key, so a key it returned cannot be referred
 * to by anything that existed before this transaction: removing it is safe by
 * construction. `putDocument` is handed an EXPLICIT key by its caller, and that
 * key may already hold bytes a row has referred to for months — the final job
 * card rendered on first download is exactly that case. Removing THAT on a
 * rollback would delete a document the database still points at, which is the
 * failure this file exists to prevent, in the worse direction.
 *
 * So a `putDocument` is tracked only when the key held NOTHING beforehand,
 * which is asked before the write and not guessed at afterwards. A write that
 * created the file is this transaction's to undo; a write that replaced one is
 * not, and is left alone. That covers the two paths whose key belongs to the
 * record rather than to the store — a library revision and a post-signature
 * addendum — which until now could orphan their bytes on a failed insert.
 *
 * IF THE QUESTION CANNOT BE ANSWERED, THE KEY IS NOT TRACKED. A store that
 * refuses to say whether a file is there — `StorageIntegrityFailed` on bytes
 * that are present but damaged, or a read that throws — is a store where
 * deleting on a guess could destroy a referenced document. Leaving the bytes
 * is the recoverable mistake; `documents:reconcile` reports anything in the
 * store that no row refers to, and removes it only when an operator asks for
 * it by name.
 *
 * CLEANUP NEVER RAISES. It runs on a path that is already failing, and an
 * exception from a cleanup would replace the real error with its own.
 */
export interface TrackedStorage {
  /** The service to hand to the unit of work. */
  readonly storage: StorageService;
  /**
   * Removes everything this unit created. Call it only when the work failed.
   *
   * Resolves to the keys it removed, which is what the tests assert on and
   * what a caller may log. It swallows every error from the removals.
   */
  rollback(): Promise<readonly string[]>;
}

export const trackStorageWrites = (inner: StorageService): TrackedStorage => {
  const created: string[] = [];

  const storage: StorageService = {
    resolveUrl: (storageKey) => inner.resolveUrl(storageKey),
    getDocument: (storageKey) => inner.getDocument(storageKey),
    remove: (storageKey) => inner.remove(storageKey),
    putDocument: async (document: StoredDocument): Promise<void> => {
      /*
       * ASKED BEFORE THE WRITE, because afterwards there is no way to tell a
       * file this transaction created from one it replaced. Anything other
       * than a plain "there is nothing there" leaves the key untracked: see
       * above for why the cautious direction is to keep the bytes.
       */
      let existed = true;
      try {
        existed = (await inner.getDocument(document.storageKey)) !== null;
      } catch {
        existed = true;
      }
      await inner.putDocument(document);
      if (!existed) created.push(document.storageKey);
    },

    storeUpload: async (file: UploadedFile): Promise<StoredFile> => {
      const stored = await inner.storeUpload(file);
      created.push(stored.storageKey);
      return stored;
    },
  };

  return {
    storage,
    rollback: async () => {
      /*
       * A COPY, AND THE LIST IS EMPTIED. A rollback must be idempotent: the
       * runtime calls it in a `catch`, and a retry of the same unit of work
       * must not try to remove keys the first attempt already removed.
       */
      const keys = [...created];
      created.length = 0;
      for (const key of keys) {
        try {
          await inner.remove(key);
        } catch {
          // Already failing. There is nothing useful to do and nothing worth
          // saying that would not bury the error the caller is handling.
        }
      }
      return keys;
    },
  };
};
