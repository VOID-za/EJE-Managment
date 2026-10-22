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
  it('REMOVES A `putDocument` THAT CREATED ITS FILE', async () => {
    /*
     * The two paths whose key belongs to the RECORD rather than to the store —
     * a library revision and a post-signature addendum — write through
     * `putDocument` at a key generated when the row was built. Until this was
     * tracked, a failed insert on either left the bytes on the disk for the
     * rest of the deployment's life with nothing pointing at them.
     */
    const tracked = trackStorageWrites(storage);
    const key = 'library/fanuc-0i-mf/1.0.pdf';
    await tracked.storage.putDocument({
      storageKey: key,
      fileName: 'fanuc-0i-mf.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 the alarm list'),
      renderer: 1,
      backfilled: false,
    });

    // There before, which is what makes the next assertion mean something.
    expect(await storage.getDocument(key)).not.toBeNull();
    expect(await tracked.rollback()).toEqual([key]);
    expect(await storage.getDocument(key)).toBeNull();
  });

  it('LEAVES A `putDocument` THAT REPLACED ONE, which is the dangerous case', async () => {
    /*
     * THE WORSE FAILURE, IN THE OTHER DIRECTION. The final job card is
     * rendered on first download and written at the key its `final_documents`
     * row has carried since the signature. A rollback that removed it would
     * delete a document the database still points at — a signed customer
     * record — to tidy up bytes that were never this transaction's.
     *
     * So the file is written, the rollback removes NOTHING, and the ORIGINAL
     * bytes are still readable: the overwrite is not undone either, because
     * undoing it would mean this wrapper holding a copy of every document it
     * ever replaced.
     */
    const key = 'jobcards/EJE-2026-0001.pdf';
    await storage.putDocument({
      storageKey: key,
      fileName: 'EJE-2026-0001.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 the signed job card'),
      renderer: 1,
      backfilled: false,
    });

    const tracked = trackStorageWrites(storage);
    await tracked.storage.putDocument({
      storageKey: key,
      fileName: 'EJE-2026-0001.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4 re-rendered'),
      renderer: 1,
      backfilled: true,
    });

    expect(await tracked.rollback()).toEqual([]);
    const after = await storage.getDocument(key);
    expect(after).not.toBeNull();
    expect(new TextDecoder().decode(after!.bytes)).toContain('re-rendered');
  });

  it('leaves the key alone when the store cannot say whether a file was there', async () => {
    /*
     * A store that throws on the existence question is a store where deleting
     * on a guess could destroy a referenced document. Keeping the bytes is the
     * recoverable mistake, and `documents:reconcile` is what finds them.
     */
    const unreadable: StorageService = {
      resolveUrl: () => 'inert',
      storeUpload: () => Promise.resolve({ storageKey: 'uploads/whatever', url: 'inert' }),
      putDocument: () => Promise.resolve(),
      getDocument: () => Promise.reject(new Error('the disk is confused')),
      remove: () => Promise.resolve(),
    };

    const tracked = trackStorageWrites(unreadable);
    await tracked.storage.putDocument({
      storageKey: 'library/whatever.pdf',
      fileName: 'whatever.pdf',
      contentType: 'application/pdf',
      bytes: bytes('%PDF-1.4'),
      renderer: 1,
      backfilled: false,
    });

    expect(await tracked.rollback()).toEqual([]);
  });
});
