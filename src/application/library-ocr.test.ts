import { beforeEach, describe, expect, it } from 'vitest';
import { asDocumentId, OCR_MAX_ATTEMPTS, type DocumentId, type OcrJob } from '@/domain';
import type { OcrService } from '@/services/ocr';
import { unavailableOcr } from '@/services/ocr';
import {
  describeSearchability,
  enqueueOcr,
  requeueOcr,
  runOcrAttempt,
  summariseOcrQueue,
} from './library-ocr';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * TEXT RECOGNITION, AND THE ONE RULE IT MUST NEVER BREAK. LIB-5.
 *
 * A document is reported as searchable ONLY when text was actually extracted
 * and indexed. There are five ways an attempt can end and exactly one of them
 * touches the index, so every one of the other four has a test here — and each
 * asserts the INDEX, not the job, because the index is what the library reads
 * to answer "can I find anything in this".
 */

const DOCUMENT = asDocumentId('00000000-0000-4000-8000-0000000000a1');

/** An engine that answers however the test needs it to. */
const engineThat = (answer: Awaited<ReturnType<OcrService['read']>>): OcrService => ({
  describe: () => ({ available: true, engine: 'stub 1.0', reason: '' }),
  read: () => Promise.resolve(answer),
});

const PDF = new TextEncoder().encode('%PDF-1.4 a scanned page with no text layer');

const elmarie = seedUser('user-master-elmarie');

describe('text recognition', () => {
  let harness: Harness;
  /** The operation context, acting as the Master throughout. */
  let context: ReturnType<Harness['as']>;

  const scannedDocument = async (): Promise<DocumentId> => {
    const stored = await context.services.storage.storeUpload({
      fileName: 'leadwell.pdf',
      contentType: 'application/pdf',
      bytes: PDF,
    });
    const document = await context.repos.documents.save({
      id: DOCUMENT,
      name: 'Leadwell V40 manual',
      documentType: 'machine_manual',
      version: '1.0',
      status: 'current',
      description: 'Scanned, with no text layer.',
      manufacturer: 'Leadwell',
      machineModel: 'V40',
      fileName: 'leadwell.pdf',
      fileSizeBytes: PDF.byteLength,
      checksumSha256: null,
      storageKey: stored.storageKey,
      pageCount: 214,
      uploadedAt: '2026-10-01T08:00:00.000Z',
      uploadedBy: elmarie.id,
      tags: [],
      provenance: 'genuine',
    });
    await context.repos.documents.saveTextIndex(
      {
        documentId: document.id,
        state: 'needs_ocr',
        source: null,
        extractedAt: '2026-10-01T08:00:05.000Z',
        characters: 0,
        pages: 214,
        truncated: false,
        unreadableStreams: 0,
        failureReason: 'This PDF carries no extractable text: it is a scan.',
      },
      '',
    );
    return document.id;
  };

  const claim = async (): Promise<OcrJob> => {
    const claimed = await context.repos.documents.claimOcrJob('2026-10-02T09:00:00.000Z');
    expect(claimed, 'a job should have been claimable').not.toBeNull();
    return claimed!;
  };

  const indexState = async (id: DocumentId): Promise<string | null> =>
    (await context.repos.documents.findTextIndex(id))?.state ?? null;

  beforeEach(() => {
    harness = buildHarness();
    context = harness.as(elmarie);
  });

  describe('the queue', () => {
    it('takes a document once, however often it is asked', async () => {
      const id = await scannedDocument();
      const first = await enqueueOcr(context, id);
      const second = await enqueueOcr(context, id);

      expect(first.state).toBe('queued');
      expect(second.queuedAt).toBe(first.queuedAt);
      expect(await context.repos.documents.listOcrJobs()).toHaveLength(1);
    });

    it('hands a claimed job to ONE caller', async () => {
      await enqueueOcr(context, await scannedDocument());

      const first = await context.repos.documents.claimOcrJob('2026-10-02T09:00:00.000Z');
      const second = await context.repos.documents.claimOcrJob('2026-10-02T09:00:01.000Z');

      // Two workers reading the same forty-page scan is forty pages of wasted
      // time and then a race over whose text wins.
      expect(first).not.toBeNull();
      expect(second).toBeNull();
    });

    it('counts the attempt when it is claimed, not when it finishes', async () => {
      await enqueueOcr(context, await scannedDocument());
      const claimed = await claim();

      // A worker killed mid-page must still have used an attempt, or a document
      // that kills workers would be retried for ever.
      expect(claimed.attempts).toBe(1);
      expect(claimed.state).toBe('running');
      expect(claimed.startedAt).not.toBeNull();
    });

    it('offers a claim again once it has gone stale', async () => {
      await enqueueOcr(context, await scannedDocument());
      await claim();

      const tooSoon = await context.repos.documents.claimOcrJob(
        '2026-10-02T09:05:00.000Z',
      );
      expect(tooSoon, 'five minutes is not abandoned').toBeNull();

      const later = await context.repos.documents.claimOcrJob('2026-10-02T09:30:00.000Z');
      expect(later, 'a worker killed mid-page must not strand its document').not.toBeNull();
      expect(later?.attempts).toBe(2);
    });

    it('stops offering a job that has used its attempts', async () => {
      await enqueueOcr(context, await scannedDocument());
      for (let attempt = 0; attempt < OCR_MAX_ATTEMPTS; attempt += 1) {
        const claimed = await context.repos.documents.claimOcrJob(
          `2026-10-02T${String(9 + attempt).padStart(2, '0')}:00:00.000Z`,
        );
        expect(claimed, `attempt ${attempt + 1}`).not.toBeNull();
        await context.repos.documents.saveOcrJob({
          ...claimed!,
          state: 'failed',
          startedAt: null,
          finishedAt: '2026-10-02T10:00:00.000Z',
          lastError: 'nothing came out',
        });
      }

      // A page that cannot be read will not become readable by being read a
      // fourth time, and a queue that retries for ever hides the failure.
      expect(
        await context.repos.documents.claimOcrJob('2026-10-03T09:00:00.000Z'),
      ).toBeNull();
    });

    it('puts a settled job back only when somebody asks', async () => {
      const id = await scannedDocument();
      await enqueueOcr(context, id);
      const claimed = await claim();
      await context.repos.documents.saveOcrJob({
        ...claimed,
        state: 'failed',
        startedAt: null,
        finishedAt: '2026-10-02T09:10:00.000Z',
        lastError: 'nothing came out',
      });

      const requeued = await requeueOcr(context, id);

      expect(requeued?.state).toBe('queued');
      // The attempts reset, because the person asking knows something changed.
      expect(requeued?.attempts).toBe(0);
      expect(requeued?.lastError).toBe('');
    });

    it('leaves a RUNNING job alone when asked to requeue it', async () => {
      const id = await scannedDocument();
      await enqueueOcr(context, id);
      await claim();

      const asked = await requeueOcr(context, id);

      // Resetting it would let a second worker claim a document the first is
      // still reading — the race `claimOcrJob` prevents, undone from the other
      // end.
      expect(asked?.state).toBe('running');
      expect(asked?.attempts).toBe(1);
    });
  });

  describe('what an attempt does to the index', () => {
    it('INDEXES the text, and records that it was recognised rather than read', async () => {
      const id = await scannedDocument();
      await enqueueOcr(context, id);
      const claimed = await claim();

      const outcome = await runOcrAttempt(
        context,
        engineThat({
          kind: 'text',
          text: 'ALARM 750 SPINDLE DRIVE',
          pages: 40,
          engine: 'stub 1.0',
          truncated: false,
          truncationReason: '',
          pagesFailed: 0,
        }),
        claimed,
      );

      expect(outcome.job.state).toBe('done');
      expect(outcome.index?.state).toBe('indexed');
      // The one assertion that makes recognised text honest downstream.
      expect(outcome.index?.source).toBe('ocr');
      expect(outcome.index?.characters).toBe('ALARM 750 SPINDLE DRIVE'.length);
      // 40 pages read out of 214: a partial index that admits it is partial.
      expect(outcome.index?.truncated).toBe(true);
    });

    it('LEAVES THE INDEX ALONE when the engine found nothing', async () => {
      const id = await scannedDocument();
      await enqueueOcr(context, id);
      const claimed = await claim();

      const outcome = await runOcrAttempt(
        context,
        engineThat({ kind: 'empty', reason: 'The scan is blank.', engine: 'stub 1.0' }),
        claimed,
      );

      expect(outcome.job.state).toBe('failed');
      expect(outcome.job.lastError).toBe('The scan is blank.');
      expect(outcome.index).toBeNull();
      // Still not searchable, and still saying so.
      expect(await indexState(id)).toBe('needs_ocr');
    });

    it('LEAVES THE INDEX ALONE when no engine is installed', async () => {
      const id = await scannedDocument();
      await enqueueOcr(context, id);
      const claimed = await claim();

      const outcome = await runOcrAttempt(context, unavailableOcr(), claimed);

      // A separate state, because the remedy is an installation rather than a
      // better scan.
      expect(outcome.job.state).toBe('unavailable');
      expect(outcome.job.lastError).toMatch(/tesseract-ocr/u);
      expect(outcome.index).toBeNull();
      expect(await indexState(id)).toBe('needs_ocr');
    });

    it('LEAVES THE INDEX ALONE when the engine throws', async () => {
      const id = await scannedDocument();
      await enqueueOcr(context, id);
      const claimed = await claim();

      const broken: OcrService = {
        describe: () => ({ available: true, engine: 'broken', reason: '' }),
        read: () => Promise.reject(new Error('segmentation fault')),
      };

      const outcome = await runOcrAttempt(context, broken, claimed);

      // A broken engine must not crash a worker partway through a queue, and
      // must not be able to mark a document unsearchable for ever either.
      expect(outcome.job.state).toBe('failed');
      expect(outcome.job.lastError).toMatch(/segmentation fault/u);
      expect(outcome.index).toBeNull();
      expect(await indexState(id)).toBe('needs_ocr');
    });

    it('fails honestly when there are no bytes to read', async () => {
      const document = await context.repos.documents.save({
        id: asDocumentId('00000000-0000-4000-8000-0000000000a2'),
        name: 'A record with no file',
        documentType: 'machine_manual',
        version: '1.0',
        status: 'current',
        description: '',
        manufacturer: '',
        machineModel: '',
        fileName: 'nothing.pdf',
        fileSizeBytes: 0,
        checksumSha256: null,
        storageKey: 'uploads/never-written',
        pageCount: 1,
        uploadedAt: '2026-10-01T08:00:00.000Z',
        uploadedBy: elmarie.id,
        tags: [],
        provenance: 'genuine',
      });
      await enqueueOcr(context, document.id);
      const claimed = await claim();

      const outcome = await runOcrAttempt(
        context,
        engineThat({
          kind: 'text',
          text: 'should never be reached',
          pages: 1,
          engine: 'stub',
          truncated: false,
          truncationReason: '',
          pagesFailed: 0,
        }),
        claimed,
      );

      expect(outcome.job.state).toBe('failed');
      expect(outcome.job.lastError).toMatch(/no stored file/u);
      expect(outcome.index).toBeNull();
    });
  });

  describe('what the library says about searchability', () => {
    it('says text came out of the document when it did', () => {
      const said = describeSearchability(
        {
          documentId: DOCUMENT,
          state: 'indexed',
          source: 'text_layer',
          extractedAt: 'x',
          characters: 10,
          pages: 1,
          truncated: false,
          unreadableStreams: 0,
          failureReason: '',
        },
        null,
      );
      expect(said.searchable).toBe(true);
      expect(said.label).toBe('Searchable');
    });

    it('says recognised text is recognised, so nobody trusts it as the document', () => {
      const said = describeSearchability(
        {
          documentId: DOCUMENT,
          state: 'indexed',
          source: 'ocr',
          extractedAt: 'x',
          characters: 10,
          pages: 1,
          truncated: false,
          unreadableStreams: 0,
          failureReason: '',
        },
        null,
      );
      expect(said.searchable).toBe(true);
      expect(said.label).toMatch(/recognised/u);
      expect(said.detail).toMatch(/can contain mistakes/u);
    });

    it('distinguishes "we are reading it" from "nothing here can read it"', () => {
      const base: OcrJob = {
        documentId: DOCUMENT,
        state: 'queued',
        attempts: 0,
        queuedAt: 'x',
        startedAt: null,
        finishedAt: null,
        lastError: '',
        engine: '',
      };

      const queued = describeSearchability(null, base);
      const running = describeSearchability(null, { ...base, state: 'running' });
      const missing = describeSearchability(null, {
        ...base,
        state: 'unavailable',
        lastError: 'Install tesseract-ocr.',
      });

      // Three different things to a technician looking for a manual, and only
      // the last means somebody has to go and install something.
      expect(queued.label).toMatch(/Waiting/u);
      expect(running.label).toMatch(/Reading/u);
      expect(missing.label).toMatch(/no text recognition on this server/iu);
      for (const said of [queued, running, missing]) expect(said.searchable).toBe(false);
    });

    it('says how many times a failure has been tried, once it has stopped trying', () => {
      const said = describeSearchability(null, {
        documentId: DOCUMENT,
        state: 'failed',
        attempts: OCR_MAX_ATTEMPTS,
        queuedAt: 'x',
        startedAt: null,
        finishedAt: 'y',
        lastError: 'The scan is too faint.',
        engine: 'stub',
      });
      expect(said.searchable).toBe(false);
      expect(said.detail).toMatch(new RegExp(`${OCR_MAX_ATTEMPTS} times`, 'u'));
    });

    it('never calls a document searchable on the strength of the QUEUE', () => {
      /*
       * The whole point of keeping the two records apart. `done` means
       * recognition finished; whether there is text is the index's answer, and
       * here there is none.
       */
      const said = describeSearchability(null, {
        documentId: DOCUMENT,
        state: 'done',
        attempts: 1,
        queuedAt: 'x',
        startedAt: null,
        finishedAt: 'y',
        lastError: '',
        engine: 'stub',
      });
      expect(said.searchable).toBe(false);
    });

    it('says "not indexed" when nothing was ever uploaded', () => {
      expect(describeSearchability(null, null).searchable).toBe(false);
      expect(describeSearchability(null, null).label).toBe('Not indexed');
    });
  });

  it('summarises the queue by state', () => {
    const job = (state: OcrJob['state']): OcrJob => ({
      documentId: DOCUMENT,
      state,
      attempts: 0,
      queuedAt: 'x',
      startedAt: state === 'running' ? 'y' : null,
      finishedAt: state === 'queued' || state === 'running' ? null : 'z',
      lastError: '',
      engine: '',
    });

    expect(summariseOcrQueue([job('queued'), job('queued'), job('failed')])).toEqual({
      queued: 2,
      running: 0,
      done: 0,
      failed: 1,
      unavailable: 0,
    });
  });
});

describe('what is retried without being asked, and what is not', () => {
  let harness: Harness;
  let context: ReturnType<Harness['as']>;

  const queued = async (state: OcrJob['state']): Promise<void> => {
    harness = buildHarness();
    context = harness.as(elmarie);
    await context.repos.documents.saveOcrJob({
      documentId: DOCUMENT,
      state,
      attempts: 1,
      queuedAt: '2026-10-02T08:00:00.000Z',
      startedAt: null,
      finishedAt: state === 'queued' ? null : '2026-10-02T08:10:00.000Z',
      lastError: state === 'failed' ? 'the disk was full' : 'no engine installed',
      engine: '',
    });
  };

  it('RETRIES a failure, because it may have been the machine', async () => {
    await queued('failed');
    // A full disk, an engine killed on one page, a transient read. Nothing
    // here can tell those from a blank scan, and trying twice more costs
    // minutes.
    expect(await context.repos.documents.claimOcrJob('2026-10-02T09:00:00.000Z')).not.toBeNull();
  });

  it('does NOT retry a missing engine, because nothing has changed', async () => {
    await queued('unavailable');
    // The next attempt would say the same thing. It waits for somebody to say
    // they have installed one.
    expect(await context.repos.documents.claimOcrJob('2026-10-02T09:00:00.000Z')).toBeNull();
  });

  it('does NOT retry a job that finished', async () => {
    await queued('done');
    expect(await context.repos.documents.claimOcrJob('2026-10-02T09:00:00.000Z')).toBeNull();
  });
});
