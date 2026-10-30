import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilesystemStorageService,
  readStorageConfiguration,
  StorageIntegrityFailed,
  StorageWriteFailed,
} from './file-storage';

/**
 * PRODUCTION STORAGE, against a real directory.
 *
 * The one claim that matters here is DURABILITY, and it cannot be proved by
 * asking the same object what it just stored: every retrieval below is made by
 * a NEW adapter instance built over the same directory, which is as close as a
 * test gets to "the application restarted".
 */
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('where the bytes go', () => {
  let root: string;
  let storage: FilesystemStorageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'eje-storage-'));
    storage = new FilesystemStorageService({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A brand new adapter over the same directory: the restart, simulated. */
  const afterRestart = () => new FilesystemStorageService({ root });

  it('stores an upload and reads it back', async () => {
    const stored = await storage.storeUpload({
      fileName: 'customer-order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 the customer order'),
    });

    const read = await storage.getDocument(stored.storageKey);
    expect(read?.fileName).toBe('customer-order.pdf');
    expect(read?.contentType).toBe('application/pdf');
    expect(new TextDecoder().decode(read?.bytes)).toBe('%PDF-1.4 the customer order');
  });

  it('still has it after the application restarts', async () => {
    const stored = await storage.storeUpload({
      fileName: 'order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 survives'),
    });

    // THE WHOLE POINT. A different adapter, holding no state from the first.
    const read = await afterRestart().getDocument(stored.storageKey);
    expect(new TextDecoder().decode(read?.bytes)).toBe('%PDF-1.4 survives');
  });

  it('keeps every byte exactly, including the ones that are not text', async () => {
    const binary = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x7f, 0x80]);
    const stored = await storage.storeUpload({
      fileName: 'plate.png',
      contentType: 'image/png',
      bytes: binary,
    });

    expect(Array.from((await afterRestart().getDocument(stored.storageKey))?.bytes ?? [])).toEqual(
      Array.from(binary),
    );
  });

  it('gives every upload its own key, however the files are named', async () => {
    const first = await storage.storeUpload({
      fileName: 'order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('one'),
    });
    const second = await storage.storeUpload({
      fileName: 'order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('two'),
    });

    expect(first.storageKey).not.toBe(second.storageKey);
    // And neither overwrote the other.
    expect(new TextDecoder().decode((await storage.getDocument(first.storageKey))?.bytes)).toBe(
      'one',
    );
  });

  it('never builds a path out of the file name', async () => {
    const stored = await storage.storeUpload({
      fileName: '../../etc/passwd',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4'),
    });

    // The key is generated, so a hostile name cannot reach it at all.
    expect(stored.storageKey).not.toContain('passwd');
    expect(stored.storageKey).not.toContain('..');
    expect(stored.storageKey).toMatch(/^uploads\/[0-9a-f-]{36}$/u);

    // And nothing was written outside the store.
    expect(await readdir(root)).toEqual(['uploads']);
  });

  it('refuses a key that tries to climb out of the store', async () => {
    for (const hostile of [
      '../../../etc/passwd',
      '/etc/passwd',
      'uploads/../../escape',
      '..',
    ]) {
      // A read answers "not found" rather than raising: a probe learns nothing.
      expect(await storage.getDocument(hostile)).toBeNull();
    }
  });

  it('refuses to write at a key that resolves outside the store', async () => {
    await expect(
      storage.putDocument({
        storageKey: '../escaped',
        fileName: 'x.pdf',
        contentType: 'application/pdf',
        bytes: bytes('no'),
      }),
    ).rejects.toBeInstanceOf(StorageWriteFailed);
  });

  it('answers null for a key that was never written', async () => {
    expect(await storage.getDocument('uploads/00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('offers NO WAY to allocate a key without bytes', () => {
    /*
     * `put(fileName, contentType, null)` used to be that way, and it is the
     * only call in the system that could have produced a database row
     * describing a document nobody had uploaded. Every capture path now sends
     * its image through `storeUpload`, so it was removed rather than left
     * reachable. Asserted on the OBJECT rather than the type, because a type
     * error is a compile-time fact and this is about what the running adapter
     * can be asked to do.
     */
    expect((storage as unknown as Record<string, unknown>).put).toBeUndefined();
  });

  it('offers no URL a browser could fetch', async () => {
    const stored = await storage.storeUpload({
      fileName: 'order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4'),
    });

    // A storage key is not a credential, and this must never be the thing that
    // makes it one. Retrieval goes through an authorised route.
    const url = storage.resolveUrl(stored.storageKey);
    expect(url.startsWith('http')).toBe(false);
    expect(url.startsWith('/')).toBe(false);
  });

  /* -- what a truncated or swapped file does, and what it must never do ---- */

  /**
   * THE DEFECT THESE FOUR TESTS WERE WRITTEN FOR.
   *
   * `final_documents` carried `size_bytes` and `checksum_sha256` columns that
   * NOTHING WROTE and nothing checked — every row in production read
   * `size_bytes = 0` — while the schema's own comment said the checksum was
   * "verified on every read". So a signed job card that had been truncated by
   * a full disk or a half-completed write was indistinguishable from an intact
   * one, and would have been handed to a customer as the legal record.
   */
  it('records what it stored, so a row can say what is on the disk', async () => {
    const content = bytes('%PDF-1.4 the issued job card');
    const stored = await storage.storeUpload({
      fileName: 'EJE-3001.pdf',
      contentType: 'application/pdf',
      bytes: content,
    });

    const read = await afterRestart().getDocument(stored.storageKey);
    expect(read?.sizeBytes).toBe(content.byteLength);
    expect(read?.sha256).toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('REFUSES a document that has been truncated under it', async () => {
    await storage.putDocument({
      storageKey: 'jobcards/final/EJE-3002.pdf',
      fileName: 'EJE-3002.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 a complete job card, signed by the customer'),
    });

    // A full disk, a crash mid-write, a bad block: the file is shorter than it
    // was and nothing else about the system has changed.
    await truncate(join(root, 'jobcards/final/EJE-3002.pdf.bin'), 10);

    await expect(afterRestart().getDocument('jobcards/final/EJE-3002.pdf')).rejects.toBeInstanceOf(
      StorageIntegrityFailed,
    );
  });

  it('REFUSES a document whose bytes were swapped for different ones', async () => {
    await storage.putDocument({
      storageKey: 'jobcards/final/EJE-3003.pdf',
      fileName: 'EJE-3003.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 what the customer signed'),
    });

    // Same length, different content — which is exactly what a length check
    // alone cannot see, and why the hash is recorded as well.
    await writeFile(
      join(root, 'jobcards/final/EJE-3003.pdf.bin'),
      '%PDF-1.4 NOT what they signed',
    );

    await expect(afterRestart().getDocument('jobcards/final/EJE-3003.pdf')).rejects.toBeInstanceOf(
      StorageIntegrityFailed,
    );
  });

  it('still serves a file written before any of this was recorded', async () => {
    // A sidecar from the old adapter: no length, no hash. Refusing these would
    // make the application unable to serve documents that are perfectly
    // intact, which is a worse failure than the one being prevented.
    await writeFile(join(root, 'legacy.bin'), 'older bytes');
    await writeFile(
      join(root, 'legacy.json'),
      JSON.stringify({ fileName: 'legacy.pdf', contentType: 'application/pdf' }),
    );

    const read = await storage.getDocument('legacy');
    expect(new TextDecoder().decode(read?.bytes)).toBe('older bytes');
    // And it still MEASURES what it read, so a reconcile can fill the gap in.
    expect(read?.sizeBytes).toBe('older bytes'.length);
  });

  it('leaves no half-written file behind, and no temporary one either', async () => {
    await storage.putDocument({
      storageKey: 'jobcards/final/EJE-3004.pdf',
      fileName: 'EJE-3004.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 complete'),
    });

    /*
     * A rename is the only way a reader sees the file, so there is no window in
     * which the `.bin` exists and is short. The temporaries are what prove the
     * write went through one: none may survive it.
     */
    const written = await readdir(join(root, 'jobcards/final'));
    expect(written.some((name) => name.startsWith('.tmp-'))).toBe(false);
    expect(written.sort()).toEqual(['EJE-3004.pdf.bin', 'EJE-3004.pdf.json']);
    expect((await readFile(join(root, 'jobcards/final/EJE-3004.pdf.bin'))).byteLength).toBe(
      bytes('%PDF-1.4 complete').byteLength,
    );
  });

  it('raises rather than swallowing a write it could not make', async () => {
    // A FILE where the store expects a directory: the write cannot succeed, and
    // what matters is that the adapter says so rather than returning a key for
    // bytes that never landed.
    const blocked = join(root, 'blocked');
    await writeFile(blocked, 'not a directory');
    const broken = new FilesystemStorageService({ root: join(blocked, 'store') });

    await expect(
      broken.storeUpload({
        fileName: 'order.pdf',
        contentType: 'application/pdf',
        bytes: bytes('%PDF-1.4'),
      }),
    ).rejects.toBeInstanceOf(StorageWriteFailed);
  });
});

describe('where this deployment keeps files', () => {
  it('uses EJE_STORAGE_DIR when it is set', () => {
    // `resolve`: the server's path on Linux, and this machine's spelling of it elsewhere.
    expect(readStorageConfiguration({ EJE_STORAGE_DIR: '/srv/eje/files' }).root).toBe(
      resolve('/srv/eje/files'),
    );
  });

  it('falls back to a directory beside the application', () => {
    // A filesystem always exists, so there is no "unconfigured" answer worth
    // having: refusing to store a document because nobody set a variable would
    // be worse than storing it somewhere sensible.
    const resolved = readStorageConfiguration({}, '/srv/eje').root;
    expect(resolved).toBe(resolve('/srv/eje/.eje-storage'));
  });

  it('treats whitespace as unset', () => {
    expect(readStorageConfiguration({ EJE_STORAGE_DIR: '   ' }, '/srv/eje').root).toBe(
      resolve('/srv/eje/.eje-storage'),
    );
  });
});
