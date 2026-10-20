import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type {
  StorageService,
  StoredDocument,
  StoredFile,
  UploadedFile,
} from '../ports';
import { generatedStorageKey } from '../simulated/storage';

/**
 * PRODUCTION STORAGE. The bytes are on disk.
 *
 * WHAT THIS REPLACES. The demonstration adapter keeps bytes in a snapshot that
 * dies with the process. A business cannot run on that: a customer's order
 * attached to a job in March has to still be there in September, across every
 * restart and deployment in between. This writes to a directory and reads it
 * back, so "durable" means the ordinary thing it means — the file is on a
 * filesystem and survives everything that is not the disk failing.
 *
 * WHY A DIRECTORY AND NOT S3. It is the smallest thing that is genuinely
 * durable, needs no external account, and can be proven by a test that writes a
 * file and reads it after building a new adapter. An S3-compatible object store
 * is the same swap in `buildServices`: implement this interface against the
 * bucket and no caller changes. What matters is that nothing above this line
 * knows which it has.
 *
 * WHAT IS STORED. Two files per key:
 *
 *   <root>/<key>.bin    the bytes, exactly as uploaded
 *   <root>/<key>.json   fileName, contentType, the renderer markers, the byte
 *                       length and the SHA-256 of the bytes
 *
 * The sidecar exists because `getDocument` has to answer with the file's name
 * and type, and the object store is not the index — PostgreSQL is. The sidecar
 * is what lets the bytes be understood if they are ever looked at on their own.
 *
 * HOW THE BYTES GET THERE, AND WHY IT IS NOT `writeFile`. A customer-signed job
 * card may never change (IMMUT-6) and is the only copy there is, so the two
 * ways a plain `writeFile` loses one are both closed here:
 *
 *   - `writeFile` returns when the data is in the PAGE CACHE, not on the disk.
 *     A power loss seconds later leaves a file that is empty or half written,
 *     and the database row still says a job card is there. Every write below
 *     goes to a temporary file, is `fsync`ed, is renamed into place — which is
 *     atomic on a POSIX filesystem, so a reader sees the old file or the new
 *     one and never half of one — and the DIRECTORY is then `fsync`ed too, or
 *     the rename itself can be lost.
 *   - A truncated file that somehow does land is unreadable as a PDF and
 *     indistinguishable from a correct one by looking at the row. So the
 *     sidecar records the byte length and the SHA-256, and `getDocument`
 *     RECOMPUTES them: bytes that are not the bytes that were written raise
 *     `StorageIntegrityFailed` rather than being handed to a customer.
 *
 * WHAT IS NOT HERE: any URL a browser can fetch. `resolveUrl` returns an inert
 * reference. Retrieval goes through an authenticated route that decides whether
 * the person asking may see the job first — a storage key is not a credential,
 * and this adapter is written so it cannot accidentally become one.
 */
export interface StorageConfiguration {
  /** Absolute path to the directory the bytes live in. */
  readonly root: string;
}

/** The default location, relative to where the server runs. */
const DEFAULT_DIRECTORY = '.eje-storage';

/**
 * Where this deployment keeps files.
 *
 * Unlike WhatsApp there is no "unconfigured" answer worth having: a filesystem
 * always exists, and refusing to store a document because nobody set a
 * variable would be worse than storing it in a sensible default. The default
 * is a directory beside the application; a real deployment sets
 * `EJE_STORAGE_DIR` to a path on a volume that is actually backed up, which is
 * the part a default cannot do for anybody.
 */
export const readStorageConfiguration = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): StorageConfiguration => {
  const configured = (env.EJE_STORAGE_DIR ?? '').trim();
  return { root: configured.length > 0 ? resolve(configured) : resolve(cwd, DEFAULT_DIRECTORY) };
};

export class StorageWriteFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageWriteFailed';
  }
}

/**
 * THE FILE IS THERE AND IT IS NOT THE FILE THAT WAS WRITTEN.
 *
 * Separate from `StorageWriteFailed` and from the null that means "nothing is
 * stored under this key", because it is a different fact with a different
 * remedy: nothing is wrong with the request, the stored bytes are damaged, and
 * the answer is a restore rather than a retry. It is raised rather than
 * swallowed — handing out a document that fails its own checksum is the one
 * outcome a checksum exists to prevent.
 */
export class StorageIntegrityFailed extends Error {
  constructor(
    readonly storageKey: string,
    message: string,
  ) {
    super(message);
    this.name = 'StorageIntegrityFailed';
  }
}

/** The SHA-256 of some bytes, lower-case hex. The one hash this store speaks. */
export const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * A key this adapter is willing to touch.
 *
 * KEYS THIS ADAPTER GENERATED ARE SAFE BY CONSTRUCTION — they are a fixed
 * prefix and a UUID. This exists for the ones it did not: a key read back from
 * a database row written years ago, or, if anything ever went wrong upstream, a
 * key that came from a request. `..`, an absolute path and a backslash are all
 * refused, and the resolved path is then checked to be inside the root. Two
 * checks rather than one, because the first is about what the string says and
 * the second is about where it actually lands.
 */
const pathFor = (root: string, storageKey: string, extension: string): string => {
  if (
    storageKey.length === 0 ||
    storageKey.length > 200 ||
    !/^[A-Za-z0-9/._-]+$/u.test(storageKey) ||
    storageKey.includes('..') ||
    storageKey.startsWith('/') ||
    storageKey.startsWith('.')
  ) {
    throw new StorageWriteFailed('That storage key is not one this store will resolve.');
  }

  const candidate = resolve(join(root, `${storageKey}${extension}`));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new StorageWriteFailed('That storage key resolves outside the store.');
  }
  return candidate;
};

interface Sidecar {
  readonly fileName: string;
  readonly contentType: string;
  readonly renderer?: number;
  readonly backfilled?: boolean;
  /**
   * The length and hash of the bytes beside it.
   *
   * OPTIONAL BECAUSE OLDER FILES HAVE NEITHER. Everything written from here on
   * carries both; a sidecar from before this existed is read, used and left
   * alone — refusing it would make the application unable to serve documents
   * that are perfectly intact, which is a worse failure than the one being
   * prevented. `npm run documents:reconcile` is what fills them in.
   */
  readonly sizeBytes?: number;
  readonly sha256?: string;
}

/**
 * Writes a file so that it is either entirely there or not there at all.
 *
 * The temporary name carries a UUID, so two writers of the same key cannot
 * truncate each other's partial file; the loser's rename simply happens second
 * and both wrote identical bytes. The `rm` on failure is best-effort — a
 * leftover `.tmp-` file is litter, while leaving a half-written `.bin` in place
 * would be a corrupt job card.
 */
const writeFileDurably = async (target: string, bytes: Uint8Array): Promise<void> => {
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.tmp-${randomUUID()}-${basename(target)}`);

  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      // The one line that makes this a durable write rather than a hopeful one.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }

  /*
   * AND THE DIRECTORY, because a rename is metadata: the file's contents are
   * on the disk and the entry naming them need not be. Best-effort, since some
   * filesystems refuse to open a directory for sync and that is not a reason
   * to fail a write that otherwise succeeded.
   */
  try {
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Nothing to do about it, and nothing worth saying to the caller.
  }
};

export class FilesystemStorageService implements StorageService {
  constructor(private readonly config: StorageConfiguration) {}

  resolveUrl(storageKey: string): string {
    /*
     * DELIBERATELY NOT FETCHABLE.
     *
     * There is no public path to a stored file and there must not be. Anything
     * the browser displays is served by a route that authorises the request
     * first; returning a real URL here would put a customer's document one
     * guessed key away from anybody on the internet.
     */
    return `#storage/${encodeURIComponent(storageKey)}`;
  }

  /**
   * A key with NO CONTENT behind it, for the capture paths that send none.
   *
   * Honest about what it is: nothing is written, so `getDocument` answers null
   * and no screen can offer a download. Job attachments do not come this way —
   * they use `storeUpload`, which writes bytes or raises.
   */
  put(_fileName: string, _contentType: string, _data: Blob | null): Promise<StoredFile> {
    const storageKey = generatedStorageKey();
    return Promise.resolve({ storageKey, url: this.resolveUrl(storageKey) });
  }

  async storeUpload(file: UploadedFile): Promise<StoredFile> {
    const storageKey = generatedStorageKey();

    /*
     * BYTES FIRST, AND THEY EITHER LAND OR THIS RAISES.
     *
     * The caller records the attachment in the database only after this
     * returns, so a failed write means no database row — never a row pointing
     * at a file that was never written. That ordering is the whole of the
     * consistency story and it belongs to the caller; what this guarantees is
     * that it does not return successfully unless the write succeeded.
     */
    try {
      await writeFileDurably(pathFor(this.config.root, storageKey, '.bin'), file.bytes);

      const sidecar: Sidecar = {
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.bytes.byteLength,
        sha256: sha256Of(file.bytes),
      };
      await writeFileDurably(
        pathFor(this.config.root, storageKey, '.json'),
        new TextEncoder().encode(JSON.stringify(sidecar)),
      );
    } catch (cause) {
      if (cause instanceof StorageWriteFailed) throw cause;
      throw new StorageWriteFailed(
        `The file could not be stored: ${cause instanceof Error ? cause.message : 'write failed'}.`,
      );
    }

    return { storageKey, url: this.resolveUrl(storageKey) };
  }

  async putDocument(document: StoredDocument): Promise<void> {
    try {
      await writeFileDurably(
        pathFor(this.config.root, document.storageKey, '.bin'),
        document.bytes,
      );

      const sidecar: Sidecar = {
        fileName: document.fileName,
        contentType: document.contentType,
        ...(document.renderer === undefined ? {} : { renderer: document.renderer }),
        ...(document.backfilled === undefined ? {} : { backfilled: document.backfilled }),
        sizeBytes: document.bytes.byteLength,
        sha256: sha256Of(document.bytes),
      };
      await writeFileDurably(
        pathFor(this.config.root, document.storageKey, '.json'),
        new TextEncoder().encode(JSON.stringify(sidecar)),
      );
    } catch (cause) {
      if (cause instanceof StorageWriteFailed) throw cause;
      throw new StorageWriteFailed(
        `The document could not be stored: ${cause instanceof Error ? cause.message : 'write failed'}.`,
      );
    }
  }

  async getDocument(storageKey: string): Promise<StoredDocument | null> {
    /*
     * A key that does not resolve is NOT FOUND, not an error.
     *
     * A malformed key is somebody probing, and a missing file is a key that was
     * allocated with no content behind it. Neither is a fault worth raising: a
     * caller asking "is this there" gets the same answer for both, which is
     * also the answer that tells an attacker nothing.
     */
    let binary: string;
    let sidecarPath: string;
    try {
      binary = pathFor(this.config.root, storageKey, '.bin');
      sidecarPath = pathFor(this.config.root, storageKey, '.json');
    } catch {
      return null;
    }

    let bytes: Buffer;
    let sidecar: Sidecar;
    try {
      const [binaryContent, sidecarRaw] = await Promise.all([
        readFile(binary),
        readFile(sidecarPath),
      ]);
      bytes = binaryContent;
      sidecar = JSON.parse(sidecarRaw.toString('utf8')) as Sidecar;
    } catch {
      return null;
    }

    /*
     * THE CHECK IS OUTSIDE THE `catch` ON PURPOSE.
     *
     * Everything above answers null, because "there is nothing here" is a
     * legitimate answer and a missing file is not a fault. Damaged bytes are,
     * and if this raised inside that `try` the refusal would be caught by it
     * and turned into exactly the quiet null this is written to prevent.
     */
    const content = new Uint8Array(bytes);
    assertIntact(storageKey, content, sidecar);

    return {
      storageKey,
      fileName: sidecar.fileName,
      contentType: sidecar.contentType,
      bytes: content,
      ...(sidecar.renderer === undefined ? {} : { renderer: sidecar.renderer }),
      ...(sidecar.backfilled === undefined ? {} : { backfilled: sidecar.backfilled }),
      sizeBytes: content.byteLength,
      sha256: sha256Of(content),
    };
  }
}

/**
 * The bytes on disk against what the sidecar says they are.
 *
 * Length first, because it is free and catches the truncation that is the
 * likely damage; then the hash, which catches the rest. A sidecar carrying
 * neither is from before they were written and is accepted as it stands — see
 * `Sidecar`.
 */
const assertIntact = (storageKey: string, bytes: Uint8Array, sidecar: Sidecar): void => {
  if (sidecar.sizeBytes !== undefined && sidecar.sizeBytes !== bytes.byteLength) {
    throw new StorageIntegrityFailed(
      storageKey,
      `The stored file is ${bytes.byteLength} bytes and its record says ${sidecar.sizeBytes}. ` +
        'It has been truncated or overwritten; restore it from a backup rather than re-issuing it.',
    );
  }
  if (sidecar.sha256 !== undefined && sidecar.sha256 !== sha256Of(bytes)) {
    throw new StorageIntegrityFailed(
      storageKey,
      'The stored file does not match the checksum recorded when it was written. These are not ' +
        'the bytes that were issued; restore them from a backup.',
    );
  }
};
