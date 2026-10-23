import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { indexDocumentText, reindexDocument, uploadDocument } from './library-operations';
import { searchLibraryText } from './library-search';
import { approveDocument } from './library-operations';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { builtinPdfText, popplerPdfText } from '@/services/pdf-text';
import type { TechnicalDocument } from '@/domain';

/**
 * THE LIBRARY'S PRIMARY SEARCH PATH, PAGE BY PAGE. MASTER SCOPE LIB-TEXT-1.
 *
 * EJE's library holds MANUFACTURER MANUALS, so the text a PDF already contains
 * is what the search is built on and recognition is the fallback for the pages
 * that are pictures. These tests use the real `pdftotext` engine against a PDF
 * encoded the way a real manual is encoded (`__fixtures__/cid-manual.pdf`,
 * built by the script beside it): a subset Type0 font with Identity-H
 * encoding, glyph ids in the content stream and a /ToUnicode map.
 *
 * WHAT THEY PROVE, and the first is the reason the rest exist:
 *
 *  1. A document the built-in byte reader reports as an unsearchable SCAN is
 *     read in full by the real engine. That document would otherwise have gone
 *     to recognition at 23-25 seconds a page (BD-21) and been stopped by the
 *     page bound at page 40 of 214.
 *  2. A manual with a scanned diagram in it is `partially_indexed` and NAMES
 *     the page that is a picture, rather than being called searchable or not
 *     searchable as if it were wholly one thing.
 *  3. A search result carries the PAGE, so a technician is sent to page 212 of
 *     the drive manual rather than to the drive manual.
 *  4. A deployment without poppler keeps working, with no page detail and no
 *     page numbers — the behaviour the library had for its first three
 *     releases.
 */
const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');

const CID_MANUAL = new Uint8Array(readFileSync('src/services/__fixtures__/cid-manual.pdf'));

describe('the library index, page by page', () => {
  let harness: Harness;

  const upload = async (bytes: Uint8Array): Promise<TechnicalDocument> => {
    const uploaded = await uploadDocument(harness.as(master), {
      name: 'Leadwell V40 service manual',
      description: 'Alarms, torque settings and the wiring.',
      documentType: 'service_manual',
      manufacturer: 'Leadwell',
      machineModel: 'V40',
      version: '1.0',
      tags: ['alarms'],
      file: { fileName: 'leadwell.pdf', contentType: 'application/pdf', bytes },
    });
    // Approved so it is an answer: only `current` revisions are searchable,
    // for everybody, Masters included.
    return approveDocument(harness.as(master), uploaded.document);
  };

  describe('with the real engine', () => {
    beforeEach(() => {
      harness = buildHarness({ pdfText: popplerPdfText() });
    });

    it('reads a manual the byte reader calls a scan, and says which page is a picture', async () => {
      const document = await upload(CID_MANUAL);
      const index = await harness.repos.documents.findTextIndex(document.id);

      /*
       * THE WHOLE POINT. The built-in reader reports this file as `needs_ocr`
       * — asserted in `src/services/pdf-text.test.ts` against the same bytes
       * — because it cannot resolve a subset font's /ToUnicode map. Three of
       * its four pages are now in the index.
       */
      expect(index?.state).toBe('partially_indexed');
      expect(index?.pages).toBe(4);
      expect(index?.pagesIndexed).toBe(3);
      expect(index?.source).toBe('text_layer');

      // NAMED, not counted: "page 3" is actionable and "one page" is not.
      expect(index?.failureReason).toContain('page 3');

      const pages = await harness.repos.documents.listPageText(document.id);
      expect(pages.map((page) => page.pageNumber)).toEqual([1, 2, 4]);
      expect(pages.every((page) => page.source === 'text_layer')).toBe(true);
    });

    it('answers a search with the PAGE the words were on', async () => {
      const document = await upload(CID_MANUAL);

      const answer = await searchLibraryText(harness.repos, technician, {
        term: 'torque settings',
        page: 1,
      });

      expect(answer.matched).toBe(1);
      const hit = answer.hits[0];
      expect(hit?.document.id).toBe(document.id);
      // Page 4 of the fixture carries the torque settings.
      expect(hit?.pageMatches.map((match) => match.pageNumber)).toEqual([4]);
      expect(hit?.pageMatches[0]?.snippets.join(' ')).toMatch(/torque/iu);
      expect(hit?.pageMatches[0]?.source).toBe('text_layer');
    });

    it('reports the partly-indexed manual separately from the unsearchable ones', async () => {
      await upload(CID_MANUAL);

      const answer = await searchLibraryText(harness.repos, technician, {
        term: 'alarm',
        page: 1,
      });

      /*
       * TWO DIFFERENT ANSWERS TO A PERSON. "Nothing in the library mentions
       * that" and "this manual has pages nobody has read yet" lead somewhere
       * different, so they are counted separately.
       */
      expect(answer.partiallySearchable).toBe(1);
      expect(answer.notSearchable.needsOcr).toBe(0);
      expect(answer.notSearchable.failed).toBe(0);
    });

    it('replaces the page rows when a revision is indexed again', async () => {
      const document = await upload(CID_MANUAL);
      expect((await harness.repos.documents.listPageText(document.id)).length).toBe(3);

      /*
       * STALE PAGES ARE THE DEFECT THE REPLACE SEMANTICS EXISTS FOR. A
       * re-extraction that merged would leave pages the new reading never
       * mentioned still matching searches.
       */
      await indexDocumentText(
        harness.as(master),
        document,
        new TextEncoder().encode('not a PDF at all'),
      );

      const index = await harness.repos.documents.findTextIndex(document.id);
      expect(index?.state).toBe('failed');
      expect(await harness.repos.documents.listPageText(document.id)).toEqual([]);

      const answer = await searchLibraryText(harness.repos, technician, {
        term: 'torque settings',
        page: 1,
      });
      expect(answer.matched).toBe(0);
    });

    it('re-indexes on request and reports what the engine found', async () => {
      const document = await upload(CID_MANUAL);
      const again = await reindexDocument(harness.as(master), document);
      expect(again.state).toBe('partially_indexed');
      expect(again.pagesIndexed).toBe(3);
    });
  });

  describe('without poppler, as a fallback deployment', () => {
    beforeEach(() => {
      harness = buildHarness({ pdfText: builtinPdfText('no poppler on this server') });
    });

    it('records no page detail rather than guessing at one', async () => {
      const document = await upload(CID_MANUAL);
      const index = await harness.repos.documents.findTextIndex(document.id);

      // The byte reader cannot read this manual at all, which is the defect
      // LIB-TEXT-1 exists to fix — and the fallback is still HONEST about it.
      expect(index?.state).toBe('needs_ocr');
      expect(index?.pagesIndexed).toBe(0);
      expect(await harness.repos.documents.listPageText(document.id)).toEqual([]);
    });

    it('still searches and still answers, with no page numbers', async () => {
      /*
       * A PDF the byte reader CAN read: uncompressed text operators, which is
       * what every document this library held before LIB-TEXT-1 looked like to
       * it. The search works exactly as it did, and names no page.
       */
      const simple = new TextEncoder().encode(
        '%PDF-1.4\n4 0 obj\n<< /Length 60 >>\nstream\n' +
          'BT /F1 11 Tf 40 800 Td (ALARM 414 HYDRAULIC PRESSURE LOW CHECK THE PUMP) Tj ET\n' +
          'endstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
      );
      const document = await upload(simple);

      const index = await harness.repos.documents.findTextIndex(document.id);
      expect(index?.state).toBe('indexed');
      // Every page counts as indexed, which is what this engine has always
      // effectively claimed — now said rather than implied.
      expect(index?.pagesIndexed).toBe(index?.pages);

      const answer = await searchLibraryText(harness.repos, technician, {
        term: 'hydraulic pressure',
        page: 1,
      });
      expect(answer.matched).toBe(1);
      expect(answer.hits[0]?.pageMatches).toEqual([]);
      expect(answer.hits[0]?.snippets.join(' ')).toMatch(/hydraulic/iu);
    });
  });
});
