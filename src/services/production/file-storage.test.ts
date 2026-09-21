import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FilesystemStorageService,
  readStorageConfiguration,
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

  it('answers null for a key allocated with no content behind it', async () => {
    // `put` is the photo path: a reference, and honest about carrying nothing.
    const allocated = await storage.put('photo.jpg', 'image/jpeg', null);
    expect(await storage.getDocument(allocated.storageKey)).toBeNull();
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
    expect(readStorageConfiguration({ EJE_STORAGE_DIR: '/srv/eje/files' }).root).toBe(
      '/srv/eje/files',
    );
  });

  it('falls back to a directory beside the application', () => {
    // A filesystem always exists, so there is no "unconfigured" answer worth
    // having: refusing to store a document because nobody set a variable would
    // be worse than storing it somewhere sensible.
    const resolved = readStorageConfiguration({}, '/srv/eje').root;
    expect(resolved).toBe('/srv/eje/.eje-storage');
  });

  it('treats whitespace as unset', () => {
    expect(readStorageConfiguration({ EJE_STORAGE_DIR: '   ' }, '/srv/eje').root).toBe(
      '/srv/eje/.eje-storage',
    );
  });
});
