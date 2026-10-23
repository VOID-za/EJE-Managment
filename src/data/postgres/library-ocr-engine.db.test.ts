import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asDocumentId, asUserId, type DocumentId, type TechnicalDocument } from '@/domain';
import type { Database } from '@/db/client';
import { PostgresDocumentRepository } from '@/data/postgres/document-repository';
import { IDS, seedBaseline } from '@/data/postgres/test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from '@/data/postgres/test-database';
import { FilesystemStorageService } from '@/services/production/file-storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { builtinPdfText } from '@/services/pdf-text';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { buildOcr, localOcr } from '@/services/ocr';
import {
  describeSearchability,
  enqueueOcr,
  runOcrAttempt,
} from '@/application/library-ocr';
import type { OperationContext } from '@/application/context';

/**
 * THE WHOLE CHAIN, WITH THE REAL ENGINE AND THE REAL DATABASE. LIB-5.
 *
 * Every other OCR test proves one layer against a stub, which is right: the
 * queue, the retry policy, the constraints and the index are what the
 * application owns, and they must be provable without anybody installing
 * anything. What NONE of them can say is whether a scanned document put into
 * this system comes out SEARCHABLE — and "the architecture is built" is a
 * different claim from "it works".
 *
 * So this one runs the lot: a PDF with no text layer is stored, queued, claimed,
 * rasterised by `pdftoppm`, recognised by `tesseract`, written to the index with
 * `source: 'ocr'` — and then FOUND by searching for words that existed only as
 * pixels when the file was uploaded.
 *
 * SKIPPED WITHOUT POSTGRESQL OR WITHOUT THE BINARIES, which is CI and every
 * deployment today. A test that passed by doing nothing would be worse than one
 * that says it skipped — and the engine's behaviour when it is NOT installed is
 * tested unconditionally elsewhere, because that is the state EJE are in.
 */
const url = testDatabaseUrl();
const engineInstalled = localOcr().describe().available;
const describeChain = url === null || !engineInstalled ? describe.skip : describe;

const DOCUMENT = asDocumentId('00000000-0000-4000-8000-0000000000e9');

/** The fixture has NO TEXT LAYER — see `ocr-engine.local.test.ts`. */
const SCAN = readFileSync(
  join(import.meta.dirname, '../../services/__fixtures__/scan-three-pages.pdf'),
);

const document = (id: DocumentId, storageKey: string): TechnicalDocument => ({
  id,
  name: 'Alarm list (scanned)',
  description: 'Three pages, scanned, no text layer.',
  documentType: 'service_manual',
  manufacturer: 'Fanuc',
  machineModel: '0i-MF',
  version: '1.0',
  status: 'current',
  fileName: 'alarm-list-scan.pdf',
  fileSizeBytes: SCAN.byteLength,
  checksumSha256: null,
  pageCount: 3,
  storageKey,
  provenance: 'genuine',
  uploadedAt: '2026-10-22T08:00:00.000Z',
  uploadedBy: asUserId(IDS.master),
  tags: [],
});

describeChain('a scanned document becoming searchable, end to end', () => {
  let db: Database;
  let documents: PostgresDocumentRepository;
  let storageRoot: string;
  let context: OperationContext;

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await rm(storageRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    documents = new PostgresDocumentRepository(db);
    storageRoot = await mkdtemp(join(tmpdir(), 'eje-ocr-chain-'));

    const clock = new SystemClock();
    const ids = new SequentialIdGenerator();
    const outbox = new SimulatedOutbox();
    context = {
      /*
       * THE REAL DOCUMENT REPOSITORY, and a stub for the audit trail — which
       * `createPostgresRepositories` would also give, but building the whole
       * bundle here would drag in every other table for an assertion about
       * one. `append` is the only method the OCR path calls.
       */
      repos: { documents, activity: { append: () => Promise.resolve() } } as never,
      actor: {
        id: asUserId(IDS.master),
        firstName: 'Elmarie',
        lastName: 'Coetzee',
        initials: 'EC',
        email: 'elmarie@example-test.co.za',
        mobile: '',
        role: 'master',
        jobTitle: 'Master',
        active: true,
        createdAt: clock.now(),
      },
      services: {
        clock,
        ids,
        email: new SimulatedEmailService(outbox, clock, ids),
        whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
        pdf: new SimulatedPdfService(clock),
        pdfText: builtinPdfText(),
        storage: new FilesystemStorageService({ root: storageRoot }),
      },
    } as unknown as OperationContext;
  });

  it('reads the pixels and makes the document FINDABLE BY ITS WORDS', async () => {
    const storageKey = `library/${DOCUMENT}/1.0.pdf`;
    await context.services.storage.putDocument({
      storageKey,
      fileName: 'alarm-list-scan.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array(SCAN),
      renderer: 1,
      backfilled: false,
    });
    await documents.save(document(DOCUMENT, storageKey));

    // BEFORE: no index at all, so the library says it is not searchable.
    expect(await documents.findTextIndex(DOCUMENT)).toBeNull();

    await enqueueOcr(context, DOCUMENT);
    const claimed = await documents.claimOcrJob(context.services.clock.now());
    expect(claimed?.documentId).toBe(DOCUMENT);

    const outcome = await runOcrAttempt(context, buildOcr({ EJE_OCR: 'local' }), claimed!);

    // THE JOB IS DONE, and it recorded which engine did it.
    expect(outcome.job.state).toBe('done');
    expect(outcome.job.engine).toMatch(/tesseract/iu);
    expect(outcome.job.lastError).toBe('');

    // THE INDEX IS REAL TEXT, LABELLED AS RECOGNISED.
    expect(outcome.index?.state).toBe('indexed');
    expect(outcome.index?.source).toBe('ocr');
    expect(outcome.index?.pages).toBe(3);
    expect(outcome.index?.truncated).toBe(false);
    expect((outcome.index?.characters ?? 0)).toBeGreaterThan(20);

    // AND THE LIBRARY SAYS SO, in the words a technician reads.
    const said = describeSearchability(outcome.index, outcome.job);
    expect(said.searchable).toBe(true);
    expect(said.label).toMatch(/recognised/iu);

    /*
     * THE ASSERTION THE WHOLE FEATURE IS FOR. These words existed only as
     * PIXELS when the file was stored — `pdftotext` returns nothing from this
     * fixture — and the document is now found by searching for them, through
     * the same full-text search the library screen uses.
     */
    const found = await documents.searchTextIds(['ALARM', '412'], [DOCUMENT], 10);
    expect(found).toContain(DOCUMENT);

    // A word that is NOT in the scan does not find it, so the search is
    // matching the recognised text rather than everything. Asked of the same
    // generated `tsvector` the library screen queries.
    expect(await documents.searchTextIds(['HYDRAULIC'], [DOCUMENT], 10)).not.toContain(DOCUMENT);
  });

  it('records a TRUNCATED index when a limit stops it, and says which', async () => {
    const storageKey = `library/${DOCUMENT}/1.0.pdf`;
    await context.services.storage.putDocument({
      storageKey,
      fileName: 'alarm-list-scan.pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array(SCAN),
      renderer: 1,
      backfilled: false,
    });
    await documents.save(document(DOCUMENT, storageKey));
    await enqueueOcr(context, DOCUMENT);
    const claimed = await documents.claimOcrJob(context.services.clock.now());

    const outcome = await runOcrAttempt(
      context,
      buildOcr({ EJE_OCR: 'local', EJE_OCR_MAX_PAGES: '1' }),
      claimed!,
    );

    /*
     * PARTIALLY INDEXED, which is what one page of three actually is.
     * LIB-TEXT-1.
     *
     * This asserted `indexed` with `truncated: true` beside it — a document
     * claiming to be searchable with a flag most readers never looked at. The
     * state now says it and the page tally says how much, which is the
     * overstatement the partial state exists to prevent. `truncated` is still
     * true and still carries WHICH limit bit, because "stopped at the page
     * bound" and "two pages are pictures" send somebody to different places.
     */
    expect(outcome.index?.state).toBe('partially_indexed');
    expect(outcome.index?.pagesIndexed).toBe(1);
    expect(outcome.index?.pages).toBe(3);
    expect(outcome.index?.truncated).toBe(true);
    // WHY it is partial, in the index itself — the SETTING rather than the
    // document, so nobody goes looking at the scan for a limit nobody raised.
    expect(outcome.index?.failureReason).toMatch(/EJE_OCR_MAX_PAGES/u);
    const said = describeSearchability(outcome.index, outcome.job);
    expect(said.searchable).toBe(true);
    expect(said.label).toMatch(/1 of 3 pages/u);
    expect(said.detail).toMatch(/EJE_OCR_MAX_PAGES/u);

    // The first page IS findable; the third is not, which is what truncated
    // means and what the label is warning about.
    expect(await documents.searchTextIds(['ALARM', '411'], [DOCUMENT], 10)).toContain(DOCUMENT);
    expect(await documents.searchTextIds(['ALARM', '413'], [DOCUMENT], 10)).not.toContain(
      DOCUMENT,
    );
  });
});
