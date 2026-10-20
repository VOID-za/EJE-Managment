import { beforeEach, describe, expect, it } from 'vitest';
import { loadFinalDocumentFile } from './final-document';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { StorageIntegrityFailed } from '@/services/ports';

/**
 * A STORED JOB CARD THAT IS NOT THE ONE THAT WAS ISSUED. BACKUP-1.
 *
 * The store raises `StorageIntegrityFailed` when the bytes on the disk do not
 * match the length and hash recorded with them. What the application does with
 * that is the whole point of this file, because there are two wrong answers
 * and they are both tempting:
 *
 *   - treat it as "no bytes", which sends the request down the BACKFILL path:
 *     the document would be re-rendered and WRITTEN OVER the damaged file,
 *     replacing a customer's signed job card with a new document carrying the
 *     original's date and destroying the evidence that anything was wrong;
 *   - let it escape as an unhandled error, which answers the office with a
 *     generic failure that tells them nothing to do.
 *
 * It refuses, by name, with the remedy — and writes nothing.
 */
describe('opening a job card whose stored file is damaged', () => {
  let harness: Harness;
  const master = seedUser('user-master-elmarie');

  beforeEach(() => {
    harness = buildHarness();
  });

  /** A store that has the document and refuses it, as the real one does. */
  const damagedStore = (storageKey: string): void => {
    const original = harness.services.storage.getDocument.bind(harness.services.storage);
    harness.services.storage.getDocument = async (key: string) => {
      if (key === storageKey) {
        throw new StorageIntegrityFailed(
          key,
          'The stored file is 10 bytes and its record says 48120.',
        );
      }
      return original(key);
    };
  };

  const jobWithDocument = async () => {
    const jobs = await harness.repos.jobs.list();
    const job = jobs.find((candidate) => candidate.finalDocument !== null);
    expect(job, 'the demonstration data has no issued job card to damage').toBeDefined();
    return job!;
  };

  it('REFUSES it, naming the damage and the remedy', async () => {
    const job = await jobWithDocument();
    damagedStore(job.finalDocument?.storageKey ?? '');

    const refusal = await loadFinalDocumentFile(harness.as(master), job.jobNumber).catch(
      (error: unknown) => error,
    );

    const violations =
      (refusal as { violations?: readonly { code: string; message: string }[] }).violations ?? [];
    expect(violations.map((violation) => violation.code)).toEqual(['document_damaged']);
    expect(violations[0]?.message).toMatch(/restored from a backup/u);
    // And it says why re-issuing is not the answer, because that is the thing
    // somebody would otherwise try.
    expect(violations[0]?.message).toMatch(/carrying\s+the original date/u);
  });

  it('does NOT re-render over the damaged file', async () => {
    const job = await jobWithDocument();
    const storageKey = job.finalDocument?.storageKey ?? '';
    damagedStore(storageKey);

    let written = 0;
    const put = harness.services.storage.putDocument.bind(harness.services.storage);
    harness.services.storage.putDocument = async (document) => {
      written += 1;
      return put(document);
    };

    await loadFinalDocumentFile(harness.as(master), job.jobNumber).catch(() => undefined);

    // THE ASSERTION THIS FILE EXISTS FOR. A re-render here would overwrite the
    // only copy of what the customer signed.
    expect(written).toBe(0);
  });

  it('still serves every other job card', async () => {
    const job = await jobWithDocument();
    damagedStore('jobcards/final/SOMETHING-ELSE.pdf');

    const file = await loadFinalDocumentFile(harness.as(master), job.jobNumber);
    expect(file.bytes.byteLength).toBeGreaterThan(0);
  });
});
