import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { approveDocument, uploadDocument } from './library-operations';
import { describeSearchability } from './library-ocr';
import { searchLibraryText } from './library-search';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { builtinPdfText, popplerPdfText, type PdfTextLimits } from '@/services/pdf-text';
import { buildManual, pageMarker } from '@/test/pdf-manual';
import type { TechnicalDocument } from '@/domain';
import { formatNumber } from '@/lib/format';

/**
 * LIB-TEXT-1 (#70) — DOCUMENTS FAR LONGER THAN THE 214-PAGE FIXTURE.
 *
 * The old whole-document budget (400 000 characters) stopped an ordinary
 * 214-page manual at page 96. These documents are five to seven times that
 * length, read through the REAL upload → index → search path with the REAL
 * engine, and they establish:
 *
 *   1. every page of a 1 200-page manual is indexed and searchable, page 1 100
 *      included, and a search names the page;
 *   2. a reading stopped by any limit is `partially_indexed` with a truthful
 *      N of M and the limit's own sentence — never `indexed`;
 *   3. a page cut at the per-page bound keeps the document from claiming
 *      `indexed` even though every page was read;
 *   4. recognition is NOT queued for pages that were never examined;
 *   5. the built-in reader, cut at its summary budget, records the page
 *      coverage as unknown rather than claiming every page.
 *
 * Needs `pdftotext` (poppler in CI, which installs it; any `pdftotext` locally).
 */
const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');

const PAGES = 1_200;
const MANUAL = buildManual({ pages: PAGES });

const requirePdftotext = (): void => {
  if (popplerPdfText().describe().perPage) return;
  throw new Error(
    'These tests need `pdftotext` (package poppler-utils): `sudo apt-get install -y poppler-utils`.',
  );
};

const upload = async (harness: Harness, bytes: Uint8Array, name: string): Promise<TechnicalDocument> => {
  const uploaded = await uploadDocument(harness.as(master), {
    name,
    description: 'A long manual, generated for the test.',
    documentType: 'service_manual',
    manufacturer: 'Leadwell',
    machineModel: 'V40',
    version: '1.0',
    tags: ['alarms'],
    file: { fileName: `${name}.pdf`, contentType: 'application/pdf', bytes },
  });
  return approveDocument(harness.as(master), uploaded.document);
};

const withLimits = (limits: Partial<PdfTextLimits>): Harness =>
  buildHarness({ pdfText: popplerPdfText({ limits }) });

describe('a 1 200-page manual, read in full', () => {
  let harness: Harness;
  let document: TechnicalDocument;

  beforeAll(async () => {
    requirePdftotext();
    harness = buildHarness({ pdfText: popplerPdfText() });
    document = await upload(harness, MANUAL, 'Leadwell V40 complete manual');
  }, 120_000);

  it('is indexed on EVERY page — 1 200 of 1 200 — not cut at a whole-document budget', async () => {
    const index = await harness.repos.documents.findTextIndex(document.id);
    expect(index?.state).toBe('indexed');
    expect(index?.pages).toBe(PAGES);
    expect(index?.pagesIndexed).toBe(PAGES);
    expect(index?.truncated).toBe(false);
    expect(index?.failureReason).toBe('');

    const pages = await harness.repos.documents.listPageText(document.id);
    expect(pages).toHaveLength(PAGES);
    // Far more text than the old 400 000-character budget could have held.
    expect(pages.reduce((sum, page) => sum + page.characters, 0)).toBeGreaterThan(2_000_000);
  });

  it('finds page 1 100 — a page the old budget never reached — and names it', async () => {
    const answer = await searchLibraryText(harness.repos, technician, {
      term: pageMarker(1_100),
      page: 1,
    });
    expect(answer.hits).toHaveLength(1);
    expect(answer.hits[0]?.pageMatches.map((match) => match.pageNumber)).toEqual([1_100]);
  });

  it('matches terms that are on DIFFERENT pages, and points to each page', async () => {
    const answer = await searchLibraryText(harness.repos, technician, {
      term: `${pageMarker(3)} ${pageMarker(1_150)}`,
      page: 1,
    });
    expect(answer.hits).toHaveLength(1);
    expect(answer.hits[0]?.pageMatches.map((match) => match.pageNumber).sort((a, b) => a - b)).toEqual([
      3, 1_150,
    ]);
  });

  it('is not queued for recognition: every page had text', async () => {
    expect(await harness.repos.documents.findOcrJob(document.id)).toBeNull();
  });
});

describe('a reading stopped by a limit is PARTIAL, truthfully', () => {
  beforeAll(requirePdftotext);

  it('the PAGE limit: 500 of 1 200, the limit named, the later pages not searchable', async () => {
    const harness = withLimits({ maxPages: 500 });
    const document = await upload(harness, MANUAL, 'Paged out');
    const index = await harness.repos.documents.findTextIndex(document.id);

    expect(index?.state).toBe('partially_indexed');
    expect(index?.pagesIndexed).toBe(500);
    // 1 200 where `pdfinfo` can say so; otherwise "at least 501" — never fewer
    // than the pages read plus the one the reading stopped before.
    expect([PAGES, 501]).toContain(index?.pages);
    expect(index?.truncated).toBe(true);
    expect(index?.failureReason).toContain('first 500 pages');

    const label = describeSearchability(index ?? null, null);
    expect(label.label).toBe(`Searchable — 500 of ${index?.pages} pages`);

    const late = await searchLibraryText(harness.repos, technician, { term: pageMarker(900), page: 1 });
    expect(late.hits).toHaveLength(0);
    const early = await searchLibraryText(harness.repos, technician, { term: pageMarker(450), page: 1 });
    expect(early.hits).toHaveLength(1);

    // Pages 501+ were never examined — recognising them would re-read text.
    expect(await harness.repos.documents.findOcrJob(document.id)).toBeNull();
  }, 120_000);

  it('the DEADLINE: stops at a batch boundary and keeps every batch it finished', async () => {
    /*
     * A clock that advances ten seconds every time it is read, against a
     * 25-second deadline: the page count and the first batch fit, the second
     * does not. Deterministic, and nothing waits for real time to pass.
     */
    let clock = 0;
    const harness = buildHarness({
      pdfText: popplerPdfText({
        limits: { deadlineMs: 25_000, batchPages: 100 },
        now: () => (clock += 10_000),
      }),
    });
    const document = await upload(harness, MANUAL, 'Out of time');
    const index = await harness.repos.documents.findTextIndex(document.id);

    expect(index?.state).toBe('partially_indexed');
    expect(index?.pagesIndexed).toBe(100);
    expect(index?.failureReason).toMatch(/Reading stopped after 25 seconds, at page 100/u);
    expect(await harness.repos.documents.findOcrJob(document.id)).toBeNull();
  }, 120_000);

  it('the DOCUMENT text bound: stops at the page that would exceed it, and says so', async () => {
    const harness = withLimits({ maxDocumentCharacters: 50_000 });
    const document = await upload(harness, MANUAL, 'Too much text');
    const index = await harness.repos.documents.findTextIndex(document.id);

    expect(index?.state).toBe('partially_indexed');
    expect(index?.pagesIndexed).toBeGreaterThan(0);
    expect(index?.pagesIndexed).toBeLessThan(30);
    expect(index?.characters).toBeLessThanOrEqual(50_000);
    expect(index?.failureReason).toContain(`${formatNumber(50_000, 0)} characters`);
  }, 120_000);

  it('a PAGE cut at the per-page bound: every page read, and still NOT `indexed`', async () => {
    const harness = withLimits({ maxPageCharacters: 1_000 });
    const document = await upload(harness, buildManual({ pages: 40 }), 'Dense pages');
    const index = await harness.repos.documents.findTextIndex(document.id);

    // Every page is in the index in part; none of them in full.
    expect(index?.state).toBe('partially_indexed');
    expect(index?.pages).toBe(40);
    expect(index?.pagesIndexed).toBe(0);
    expect(index?.failureReason).toContain(`${formatNumber(1_000, 0)} characters`);
    expect(await harness.repos.documents.listPageText(document.id)).toHaveLength(40);
  }, 120_000);
});

describe('pages without text, in a long manual', () => {
  beforeAll(requirePdftotext);

  it('a complete reading names them and queues recognition for them alone', async () => {
    const harness = buildHarness({ pdfText: popplerPdfText() });
    const document = await upload(
      harness,
      buildManual({ pages: 1_500, blankPages: [7, 1_499] }),
      'Manual with two diagrams',
    );
    const index = await harness.repos.documents.findTextIndex(document.id);

    expect(index?.state).toBe('partially_indexed');
    expect(index?.pages).toBe(1_500);
    expect(index?.pagesIndexed).toBe(1_498);
    expect(index?.failureReason).toContain('pages 7, 1499');
    expect(await harness.repos.documents.findOcrJob(document.id)).not.toBeNull();
  }, 120_000);
});

describe('the built-in reader, cut at its summary budget', () => {
  it('records the page coverage as UNKNOWN — partially indexed, 0 of M — not every page', async () => {
    const harness = buildHarness({ pdfText: builtinPdfText() });
    const document = await upload(
      harness,
      new Uint8Array(readFileSync('src/services/__fixtures__/long-manual.pdf')),
      'Read without poppler',
    );
    const index = await harness.repos.documents.findTextIndex(document.id);

    expect(index?.state).toBe('partially_indexed');
    expect(index?.pagesIndexed).toBe(0);
    expect(index?.truncated).toBe(true);
    expect(index?.failureReason).toContain('Install poppler-utils');
    expect(describeSearchability(index ?? null, null).label).toBe(
      `Searchable in part — of ${index?.pages} pages, which ones is not known`,
    );
  });
});
