import { describe, expect, it } from 'vitest';
import { describeScan, scanStore } from './store-scan';

/**
 * The orphan scan, on the cases that decide whether it is safe to act on.
 *
 * The asymmetry is the whole point and most of these tests are about it: a
 * file wrongly called an orphan is one somebody may delete, so every mention
 * anywhere must keep a file out of that list, while a reference this scan
 * misses only leaves litter behind.
 */

const key = 'uploads/11111111-1111-4111-8111-111111111111';
const other = 'uploads/22222222-2222-4222-8222-222222222222';

describe('files nothing refers to', () => {
  it('names a key whose bytes are there and whose row is not', () => {
    const scan = scanStore([`${key}.bin`, `${key}.json`], new Set());
    expect(scan.orphans).toEqual([key]);
    expect(scan.halfStored).toEqual([]);
  });

  it('leaves a referenced key alone', () => {
    const scan = scanStore([`${key}.bin`, `${key}.json`], new Set([key]));
    expect(scan.orphans).toEqual([]);
  });

  it('reports only the unreferenced one of two', () => {
    const scan = scanStore(
      [`${key}.bin`, `${key}.json`, `${other}.bin`, `${other}.json`],
      new Set([key]),
    );
    expect(scan.orphans).toEqual([other]);
  });

  it('judges by the BYTES, not by the sidecar', () => {
    // A sidecar alone is half a write, not an orphan: there is nothing to
    // delete that is a document, and which half is missing decides the remedy.
    const scan = scanStore([`${key}.json`], new Set());
    expect(scan.orphans).toEqual([]);
    expect(scan.halfStored).toEqual([key]);
  });

  it('reports bytes without a sidecar as half-stored as well as orphaned', () => {
    const scan = scanStore([`${key}.bin`], new Set());
    expect(scan.orphans).toEqual([key]);
    expect(scan.halfStored).toEqual([key]);
  });

  it('does not report a half-stored key that a row refers to', () => {
    // The row makes it a MISSING DOCUMENT, which is the reconcile's other
    // half and a serious finding there. It is still half-stored.
    const scan = scanStore([`${key}.json`], new Set([key]));
    expect(scan.orphans).toEqual([]);
    expect(scan.halfStored).toEqual([key]);
  });

  it('keeps keys in nested directories whole', () => {
    const nested = 'jobcards/corrections/EJE-2015-1.pdf';
    expect(scanStore([`${nested}.bin`, `${nested}.json`], new Set([nested])).orphans).toEqual([]);
    expect(scanStore([`${nested}.bin`, `${nested}.json`], new Set()).orphans).toEqual([nested]);
  });
});

describe('what is in the store that is not a document', () => {
  it('separates the litter of an interrupted write', () => {
    const scan = scanStore(
      [`${key}.bin`, `${key}.json`, 'uploads/.tmp-abc-def.bin'],
      new Set([key]),
    );
    expect(scan.temporary).toEqual(['uploads/.tmp-abc-def.bin']);
    expect(scan.orphans).toEqual([]);
    expect(scan.unexpected).toEqual([]);
  });

  it('never counts a temporary file as an orphan, even unreferenced', () => {
    const scan = scanStore(['.tmp-abc-def.bin'], new Set());
    expect(scan.orphans).toEqual([]);
    expect(scan.temporary).toEqual(['.tmp-abc-def.bin']);
  });

  it('reports anything else as unexpected and offers it for nothing', () => {
    const scan = scanStore(['README', 'uploads/notes.txt'], new Set());
    expect(scan.unexpected).toEqual(['README', 'uploads/notes.txt']);
    expect(scan.orphans).toEqual([]);
  });

  it('says plainly when there is nothing to say', () => {
    expect(describeScan(scanStore([], new Set()), '/var/lib/eje/storage')).toMatch(
      /orphaned files: none/u,
    );
  });
});

describe('what it tells an operator to do', () => {
  it('names the count in the command it suggests, so a stale run cannot delete', () => {
    const scan = scanStore([`${key}.bin`, `${key}.json`], new Set());
    const said = describeScan(scan, '/var/lib/eje/storage');
    expect(said).toMatch(/--remove-orphans --expect-orphans 1/u);
    expect(said).toMatch(/in every backup of this store/u);
  });

  it('lists at most twenty and says how many it did not', () => {
    const many = Array.from({ length: 25 }, (_, index) => `uploads/key-${index}`);
    const scan = scanStore(
      many.flatMap((entry) => [`${entry}.bin`, `${entry}.json`]),
      new Set(),
    );
    expect(scan.orphans).toHaveLength(25);
    const said = describeScan(scan, '/store');
    expect(said).toMatch(/… and 5 more/u);
    expect(said.split('\n').filter((line) => line.includes('orphan  '))).toHaveLength(20);
  });
});
