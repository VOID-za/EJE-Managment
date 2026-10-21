import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesystemStorageService } from './production/file-storage';
import { trackStorageWrites } from './storage-rollback';
import type { StorageService } from './ports';

/**
 * A FAILED TRANSACTION MUST NOT LEAVE A FILE BEHIND.
 *
 * Driven against the real filesystem adapter rather than a stub, because the
 * thing being asserted is that bytes are gone from a disk — and a stub that
 * forgets a key in a Map would pass while the real store kept the file.
 */

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('storage writes a failing unit of work made', () => {
  let root: string;
  let storage: StorageService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eje-rollback-'));
    storage = new FilesystemStorageService({ root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('are gone after a rollback', async () => {
    const tracked = trackStorageWrites(storage);
    const stored = await tracked.storage.storeUpload({
      fileName: 'order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 the customer order'),
    });

    // There before, which is what makes the next assertion mean something.
    expect(await storage.getDocument(stored.storageKey)).not.toBeNull();

    const removed = await tracked.rollback();

    expect(removed).toEqual([stored.storageKey]);
    expect(await storage.getDocument(stored.storageKey)).toBeNull();
  });

  it('are untouched when the unit of work succeeds', async () => {
    const tracked = trackStorageWrites(storage);
    const stored = await tracked.storage.storeUpload({
      fileName: 'order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4'),
    });

    // No rollback call: that is what success looks like from here.
    const read = await storage.getDocument(stored.storageKey);
    expect(read?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('are all removed, not merely the last one', async () => {
    const tracked = trackStorageWrites(storage);
    const keys: string[] = [];
    for (const name of ['one.pdf', 'two.pdf', 'three.pdf']) {
      const stored = await tracked.storage.storeUpload({
        fileName: name,
        contentType: 'application/pdf',
        bytes: bytes(`%PDF-1.4 ${name}`),
      });
      keys.push(stored.storageKey);
    }

    expect(await tracked.rollback()).toEqual(keys);
    for (const key of keys) expect(await storage.getDocument(key)).toBeNull();
  });

  it('do not include a document written at an explicit key', async () => {
    /*
     * `putDocument` is given its key by the caller and that key may already
     * hold bytes a row has pointed at for months — the final job card rendered
     * on first download is exactly that. Removing it on a rollback would
     * delete a document the database still refers to, which is worse than the
     * orphan this exists to prevent. The reconcile's orphan scan is what makes
     * such a write visible instead.
     */
    const tracked = trackStorageWrites(storage);
    await tracked.storage.putDocument({
      storageKey: 'jobcards/final/EJE-2015.pdf',
      fileName: 'EJE-2015.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 signed'),
    });

    expect(await tracked.rollback()).toEqual([]);
    expect(await storage.getDocument('jobcards/final/EJE-2015.pdf')).not.toBeNull();
  });

  it('are removed once, so a retried unit of work does not trip over them', async () => {
    const tracked = trackStorageWrites(storage);
    const stored = await tracked.storage.storeUpload({
      fileName: 'order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4'),
    });

    expect(await tracked.rollback()).toEqual([stored.storageKey]);
    // Idempotent: the second call has nothing left to do and says so.
    expect(await tracked.rollback()).toEqual([]);
  });

  it('do not let a cleanup failure replace the error the caller is handling', async () => {
    /*
     * The rollback runs in a `catch`. A throw from here would bury the
     * constraint violation, the refused trigger or the lost connection that is
     * the actual thing to report.
     */
    const broken: StorageService = {
      resolveUrl: () => 'inert',
      storeUpload: () =>
        Promise.resolve({ storageKey: 'uploads/whatever', url: 'inert' }),
      putDocument: () => Promise.resolve(),
      getDocument: () => Promise.resolve(null),
      remove: () => Promise.reject(new Error('the disk is gone')),
    };

    const tracked = trackStorageWrites(broken);
    await tracked.storage.storeUpload({
      fileName: 'order.pdf',
      contentType: 'application/pdf',
      bytes: bytes('x'),
    });

    await expect(tracked.rollback()).resolves.toEqual(['uploads/whatever']);
  });
});
