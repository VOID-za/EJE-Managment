import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
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
 *   <root>/<key>.json   fileName, contentType, and the renderer markers
 *
 * The sidecar exists because `getDocument` has to answer with the file's name
 * and type, and the object store is not the index — PostgreSQL is. The sidecar
 * is what lets the bytes be understood if they are ever looked at on their own.
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
}

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
      const target = pathFor(this.config.root, storageKey, '.bin');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.bytes);

      const sidecar: Sidecar = { fileName: file.fileName, contentType: file.contentType };
      await writeFile(pathFor(this.config.root, storageKey, '.json'), JSON.stringify(sidecar));
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
      const target = pathFor(this.config.root, document.storageKey, '.bin');
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, document.bytes);

      const sidecar: Sidecar = {
        fileName: document.fileName,
        contentType: document.contentType,
        ...(document.renderer === undefined ? {} : { renderer: document.renderer }),
        ...(document.backfilled === undefined ? {} : { backfilled: document.backfilled }),
      };
      await writeFile(
        pathFor(this.config.root, document.storageKey, '.json'),
        JSON.stringify(sidecar),
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

    try {
      const [bytes, sidecarRaw] = await Promise.all([readFile(binary), readFile(sidecarPath)]);
      const sidecar = JSON.parse(sidecarRaw.toString('utf8')) as Sidecar;

      return {
        storageKey,
        fileName: sidecar.fileName,
        contentType: sidecar.contentType,
        bytes: new Uint8Array(bytes),
        ...(sidecar.renderer === undefined ? {} : { renderer: sidecar.renderer }),
        ...(sidecar.backfilled === undefined ? {} : { backfilled: sidecar.backfilled }),
      };
    } catch {
      return null;
    }
  }
}
