import type { StorageService, StoredDocument, StoredFile } from '../ports';

/**
 * Where a stored file's bytes actually live.
 *
 * An interface rather than the demo database type, so this adapter stays
 * independent of the data layer: the composition root supplies an accessor over
 * the demo snapshot, and a test can supply a plain object.
 */
export interface FileStore {
  get(storageKey: string): StoredFileRecord | undefined;
  set(storageKey: string, record: StoredFileRecord): void;
}

export interface StoredFileRecord {
  readonly fileName: string;
  readonly contentType: string;
  readonly base64: string;
  /**
   * The renderer that produced these bytes.
   *
   * A file written when a Master ISSUED a job card is the historical document
   * and is never re-rendered. A file written by the backfill — for a job that
   * was already closed when the demonstration began, so no issue event ever
   * happened — is only a cache, and a renderer fix has to be able to reach it.
   * Without this, a browser that downloaded EJE-1044 once kept being handed
   * that first render for good, including its faults.
   */
  readonly renderer?: number;
  readonly backfilled?: boolean;
}

/** Base64 without depending on Node's Buffer or the DOM's atob/btoa. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);

    out += ALPHABET[(triple >> 18) & 63];
    out += ALPHABET[(triple >> 12) & 63];
    out += b === undefined ? '=' : ALPHABET[(triple >> 6) & 63];
    out += c === undefined ? '=' : ALPHABET[triple & 63];
  }
  return out;
};

export const base64ToBytes = (base64: string): Uint8Array => {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const length = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(length);

  let position = 0;
  for (let index = 0; index < clean.length; index += 4) {
    const chunk = [0, 1, 2, 3].map((offset) => ALPHABET.indexOf(clean[index + offset] ?? 'A'));
    const triple =
      ((chunk[0] ?? 0) << 18) | ((chunk[1] ?? 0) << 12) | ((chunk[2] ?? 0) << 6) | (chunk[3] ?? 0);

    if (position < length) bytes[position++] = (triple >> 16) & 0xff;
    if (position < length) bytes[position++] = (triple >> 8) & 0xff;
    if (position < length) bytes[position++] = triple & 0xff;
  }
  return bytes;
};

/**
 * Simulated storage adapter.
 *
 * DEMO BEHAVIOUR: uploads (machine photos, technical documents) still resolve
 * to deterministic placeholders, so the demo ships no binary assets and fakes
 * no upload endpoint. Documents written with `putDocument` are DIFFERENT: their
 * bytes are genuinely kept, because a closed job's final job card has to be
 * handed back byte-for-byte months later.
 *
 * Production swaps this for VPS disk and later S3-compatible object storage;
 * `getDocument` becomes a read or a signed GET and no caller changes.
 */
export class SimulatedStorageService implements StorageService {
  constructor(private readonly files: FileStore) {}

  resolveUrl(storageKey: string): string {
    return `#storage/${encodeURIComponent(storageKey)}`;
  }

  put(fileName: string, _contentType: string, _data: Blob | null): Promise<StoredFile> {
    const storageKey = `uploads/${Date.now()}-${fileName}`;
    return Promise.resolve({ storageKey, url: this.resolveUrl(storageKey) });
  }

  putDocument(document: StoredDocument): Promise<void> {
    this.files.set(document.storageKey, {
      fileName: document.fileName,
      contentType: document.contentType,
      base64: bytesToBase64(document.bytes),
      renderer: document.renderer,
      backfilled: document.backfilled,
    });
    return Promise.resolve();
  }

  getDocument(storageKey: string): Promise<StoredDocument | null> {
    const record = this.files.get(storageKey);
    if (record === undefined) return Promise.resolve(null);
    return Promise.resolve({
      storageKey,
      fileName: record.fileName,
      contentType: record.contentType,
      bytes: base64ToBytes(record.base64),
      renderer: record.renderer,
      backfilled: record.backfilled,
    });
  }
}

/** An in-memory file store, for tests and for a non-persisting composition. */
export const inMemoryFileStore = (): FileStore => {
  const records = new Map<string, StoredFileRecord>();
  return {
    get: (storageKey) => records.get(storageKey),
    set: (storageKey, record) => {
      records.set(storageKey, record);
    },
  };
};
