import { deflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  approveDocument,
  addDocumentVersion,
  archiveDocument,
  canOpenDocumentFile,
  indexDocumentText,
  reindexDocument,
  uploadDocument,
} from './library-operations';
import { searchLibraryText } from './library-search';
import { WorkflowError } from './errors';
import { runSearch } from './search';
import { buildHarness, seedUser, type Harness } from './test-harness';
import type { TechnicalDocument } from '@/domain';

/**
 * SEARCHING THE DOCUMENTS THEMSELVES. MASTER SCOPE LIB-5.
 *
 * Every test here uses a REAL PDF — built in this file, compressed the way a
 * normal tool compresses one — uploaded through the real operation, stored
 * through the real storage service and indexed by the real extractor. Nothing
 * stubs the index: if the extractor stops reading PDFs, these fail.
 *
 * What they hold, in the order it matters:
 *
 *  1. The text INSIDE a document is searchable, with the words around the hit.
 *  2. An unapproved upload and an archived revision are NOT answers, for
 *     anybody — which is the authorisation half of LIB-5.
 *  3. A new revision does not inherit the old one's text, and the old one's
 *     text stops being an answer. Stale searchable text is the defect this
 *     whole design exists to make impossible.
 *  4. A scanned manual is recorded as `needs_ocr` and SAID OUT LOUD in the
 *     answer, rather than quietly contributing nothing.
 *  5. A query that cannot be served is refused with what to do instead, and
 *     the pages are bounded.
 */
const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');
const coordinator = seedUser('user-coord-christene');
const otherTechnician = seedUser('user-tech-riaan');

/** A PDF with one page of real, extractable text, compressed as usual. */
const pdfWith = (text: string): Uint8Array => {
  const content = deflateSync(Buffer.from(`BT /F1 11 Tf 40 800 Td (${text}) Tj ET\n`, 'latin1'));
  const body =
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
    `4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content.toString('latin1')}\nendstream\nendobj\n`;
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1'));
};

/** A scanned page: an image, and no text anywhere in the file. */
const scannedPdf = (): Uint8Array => {
  const image = `BI /W 1700 /H 2200 /CS /G ID ${'þ'.repeat(600)} EI\n`;
  const body =
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
    `4 0 obj\n<< /Length ${image.length} >>\nstream\n${image}\nendstream\nendobj\n`;
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1'));
};

const DRIVE_MANUAL =
  'Alarm 414 indicates a servo amplifier fault on the Z axis. Measure the DC link voltage before replacing the drive module.';

const upload = async (
  harness: Harness,
  actor: typeof master,
  bytes: Uint8Array,
  overrides: Partial<{ name: string; machineModel: string; manufacturer: string }> = {},
): Promise<TechnicalDocument> => {
  const { document } = await uploadDocument(harness.as(actor), {
    name: overrides.name ?? 'Fanuc 0i-MF alarm list',
    description: 'Alarm codes and what to do about them.',
    documentType: 'service_manual',
    manufacturer: overrides.manufacturer ?? 'Fanuc',
    machineModel: overrides.machineModel ?? '0i-MF',
    version: '1.0',
    tags: ['alarms'],
    file: { fileName: 'alarms.pdf', contentType: 'application/pdf', bytes },
  });
  return document;
};

describe('a document uploaded with its file', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('stores the bytes under the key the record carries', async () => {
    const document = await upload(harness, master, pdfWith(DRIVE_MANUAL));
    const stored = await harness.services.storage.getDocument(document.storageKey);
    expect(stored).not.toBeNull();
    expect(stored?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('takes the page count from the file instead of believing the client', async () => {
    const document = await upload(harness, master, pdfWith(DRIVE_MANUAL));
    expect(document.pageCount).toBe(1);
    expect(document.fileSizeBytes).toBeGreaterThan(0);
  });

  it('is searchable by the words inside it, with the text around the hit', async () => {
    await upload(harness, master, pdfWith(DRIVE_MANUAL));
    const page = await searchLibraryText(harness.repos, technician, { term: 'servo amplifier', page: 1 });

    expect(page.matched).toBe(1);
    expect(page.hits[0]?.document.name).toBe('Fanuc 0i-MF alarm list');
    expect(page.hits[0]?.snippets.join(' ')).toContain('servo amplifier fault');
    expect(page.hits[0]?.index.state).toBe('indexed');
  });

  /*
   * THE DISCRIMINATING TEST FOR "THIS IS NOT METADATA SEARCH".
   *
   * Nothing in the record — the name, the description, the model, the
   * manufacturer or the tags — contains "DC link". Only page one of the
   * document does.
   */
  it('finds words that appear nowhere in the document’s own metadata', async () => {
    const document = await upload(harness, master, pdfWith(DRIVE_MANUAL));
    const metadata = [
      document.name,
      document.description,
      document.manufacturer,
      document.machineModel,
      ...document.tags,
    ]
      .join(' ')
      .toLowerCase();
    expect(metadata).not.toContain('dc link');

    const page = await searchLibraryText(harness.repos, technician, { term: 'DC link', page: 1 });
    expect(page.hits.map((hit) => hit.document.id)).toEqual([document.id]);
  });

  it('is served to every role that may read the library', async () => {
    await upload(harness, master, pdfWith(DRIVE_MANUAL));
    for (const actor of [master, coordinator, technician]) {
      const page = await searchLibraryText(harness.repos, actor, { term: 'alarm 414', page: 1 });
      expect(page.matched).toBe(1);
    }
  });
});

describe('what a search must never surface', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('does not surface a technician’s upload before a Master approves it', async () => {
    const pending = await upload(harness, technician, pdfWith(DRIVE_MANUAL));
    expect(pending.status).toBe('pending_approval');

    // Not to the technician who uploaded it, and not to a Master either: an
    // unapproved document is not reference material for anybody.
    for (const actor of [technician, master]) {
      const page = await searchLibraryText(harness.repos, actor, { term: 'servo amplifier', page: 1 });
      expect(page.matched).toBe(0);
    }

    // And it becomes an answer the moment it IS approved — the same document,
    // the same text, so what changed is the approval and nothing else.
    await approveDocument(harness.as(master), pending);
    const after = await searchLibraryText(harness.repos, technician, {
      term: 'servo amplifier',
      page: 1,
    });
    expect(after.matched).toBe(1);
  });

  it('does not surface an archived revision', async () => {
    const document = await upload(harness, master, pdfWith(DRIVE_MANUAL));
    await archiveDocument(harness.as(master), document);

    const page = await searchLibraryText(harness.repos, master, { term: 'alarm 414', page: 1 });
    expect(page.matched).toBe(0);
  });

  /*
   * STALE SEARCHABLE TEXT, which is the failure this design exists to prevent.
   *
   * A new revision supersedes the old one and archives it. The old revision's
   * words must stop being answers, and the new revision must NOT inherit them
   * — it has its own file, or none at all.
   */
  it('does not let a superseded revision’s words answer for the new one', async () => {
    const first = await upload(harness, master, pdfWith(DRIVE_MANUAL));
    const second = await addDocumentVersion(harness.as(master), first, {
      version: '2.0',
      fileName: 'alarms-rev2.pdf',
      pageCount: 1,
      description: 'Revision 2.',
    });
    // The new revision carries no file yet, so it carries no text.
    expect(await harness.repos.documents.findTextIndex(second.id)).toBeNull();

    const page = await searchLibraryText(harness.repos, master, { term: 'servo amplifier', page: 1 });
    expect(page.matched).toBe(0);

    // Indexing the NEW revision's own file is what makes it findable, and only
    // on its own words.
    await indexDocumentText(
      harness.as(master),
      second,
      pdfWith('Revision two covers the spindle encoder and nothing about the servo amplifier.'),
    );
    const found = await searchLibraryText(harness.repos, master, { term: 'spindle encoder', page: 1 });
    expect(found.hits.map((hit) => hit.document.version)).toEqual(['2.0']);
  });

  it('refuses the whole search for an account that may not read the library', async () => {
    await upload(harness, master, pdfWith(DRIVE_MANUAL));
    // No seeded role lacks `library.view`, so the rule is asserted directly
    // against the capability rather than against a role that may change.
    const outsider = { id: master.id, role: 'nobody' as never };
    await expect(
      searchLibraryText(harness.repos, outsider, { term: 'alarm', page: 1 }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('keeps pending and archived documents out of the GLOBAL search too', async () => {
    const pending = await upload(harness, technician, pdfWith(DRIVE_MANUAL), {
      name: 'Pending hoist manual',
    });
    const archived = await upload(harness, master, pdfWith(DRIVE_MANUAL), {
      name: 'Withdrawn hoist manual',
    });
    await archiveDocument(harness.as(master), archived);

    const results = await runSearch(harness.repos, technician, 'hoist manual');
    const names = results.filter((result) => result.category === 'document').map((hit) => hit.title);
    expect(names).not.toContain(pending.name);
    expect(names).not.toContain(archived.name);
  });
});

describe('a document whose text cannot be read', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('is stored, recorded as needing OCR, and counted in the answer', async () => {
    const document = await upload(harness, master, scannedPdf(), { name: 'Scanned hoist manual' });

    const index = await harness.repos.documents.findTextIndex(document.id);
    expect(index?.state).toBe('needs_ocr');
    expect(index?.failureReason).toMatch(/OCR/);
    expect(index?.characters).toBe(0);
    // The file is still held: the office may have nothing else.
    expect(await harness.services.storage.getDocument(document.storageKey)).not.toBeNull();

    const page = await searchLibraryText(harness.repos, master, { term: 'hoist', page: 1 });
    expect(page.matched).toBe(0);
    expect(page.notSearchable.needsOcr).toBe(1);
  });

  it('is on the audit trail, so nobody has to notice the silence', async () => {
    await upload(harness, master, scannedPdf());
    const events = await harness.repos.activity.list();
    const indexed = events.filter((event) => event.type === 'document_indexed');
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.summary).toMatch(/NOT searchable/);
    expect(indexed[0]?.detail).toMatch(/OCR/);
  });

  it('records a file that is not a PDF at all as failed, with the reason', async () => {
    const document = await upload(
      harness,
      master,
      new Uint8Array(Buffer.from('PK\u0003\u0004 a zip, not a PDF', 'latin1')),
    );
    const index = await harness.repos.documents.findTextIndex(document.id);
    expect(index?.state).toBe('failed');
    expect(index?.failureReason).toMatch(/PDF header/);
  });
});

describe('the query itself', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = buildHarness();
    // Enough documents to page through, each holding the same phrase.
    for (let index = 0; index < 12; index += 1) {
      await upload(
        harness,
        master,
        pdfWith(`Lubrication schedule for machine ${index}. Grease the main bearing every 500 hours.`),
        { name: `Lubrication schedule ${index}`, machineModel: `M${index}` },
      );
    }
  });

  it('pages the results, and the pages do not overlap', async () => {
    const first = await searchLibraryText(harness.repos, master, { term: 'lubrication schedule', page: 1 }, 5);
    const second = await searchLibraryText(harness.repos, master, { term: 'lubrication schedule', page: 2 }, 5);
    const third = await searchLibraryText(harness.repos, master, { term: 'lubrication schedule', page: 3 }, 5);

    expect(first.matched).toBe(12);
    expect(first.hits).toHaveLength(5);
    expect(second.hits).toHaveLength(5);
    expect(third.hits).toHaveLength(2);

    const ids = [...first.hits, ...second.hits, ...third.hits].map((hit) => hit.document.id);
    expect(new Set(ids).size).toBe(12);
  });

  it('requires every term, rather than any of them', async () => {
    const both = await searchLibraryText(harness.repos, master, {
      term: 'grease bearing',
      page: 1,
    });
    expect(both.matched).toBe(12);

    const missing = await searchLibraryText(harness.repos, master, {
      term: 'grease hydraulic',
      page: 1,
    });
    expect(missing.matched).toBe(0);
  });

  it('matches whole words, so "oil" does not find "boiler"', async () => {
    await upload(harness, master, pdfWith('The boiler room is behind the workshop.'), {
      name: 'Site layout',
    });
    const page = await searchLibraryText(harness.repos, master, { term: 'oil', page: 1 });
    expect(page.matched).toBe(0);
  });

  it('refuses a query with nothing searchable in it', async () => {
    for (const term of ['', '   ', 'a', '!!']) {
      await expect(
        searchLibraryText(harness.repos, master, { term, page: 1 }),
      ).rejects.toThrowError(/nothing to search for/i);
    }
  });

  it('refuses a query longer than a search', async () => {
    await expect(
      searchLibraryText(harness.repos, master, { term: 'x'.repeat(500), page: 1 }),
    ).rejects.toThrowError(/too long/i);
  });

  it('refuses a page that does not exist', async () => {
    for (const page of [0, -1, 999, 1.5]) {
      await expect(
        searchLibraryText(harness.repos, master, { term: 'lubrication', page }),
      ).rejects.toThrowError(/page of results does not exist/i);
    }
  });
});

describe('indexing a revision again', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  /*
   * THE RETRY EXISTS SO A MISSING INDEX DOES NOT NEED A SECOND UPLOAD, which
   * would create a duplicate revision to fix a missing index.
   */
  it('re-reads the stored bytes and makes a previously unsearchable document searchable', async () => {
    const document = await upload(harness, master, scannedPdf(), { name: 'Scanned manual' });
    expect((await harness.repos.documents.findTextIndex(document.id))?.state).toBe('needs_ocr');

    /*
     * The same revision, with a readable copy put into storage behind it — the
     * case a parser improvement or a re-uploaded file produces. Nothing about
     * the RECORD changes; only what is stored under its key.
     */
    await harness.services.storage.putDocument({
      storageKey: document.storageKey,
      fileName: document.fileName,
      contentType: 'application/pdf',
      bytes: pdfWith('The scanned pages were replaced with a text-based copy of the manual.'),
    });

    const index = await reindexDocument(harness.as(master), document);
    expect(index.state).toBe('indexed');
    expect(index.characters).toBeGreaterThan(20);

    const page = await searchLibraryText(harness.repos, technician, {
      term: 'text-based copy',
      page: 1,
    });
    expect(page.matched).toBe(1);
  });

  it('is idempotent: twice leaves one index, not two', async () => {
    const document = await upload(harness, master, pdfWith(DRIVE_MANUAL));
    await reindexDocument(harness.as(master), document);
    await reindexDocument(harness.as(master), document);

    const indexes = await harness.repos.documents.listTextIndexes([document.id]);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.state).toBe('indexed');
  });

  /*
   * THE DISCRIMINATING TEST FOR "VERSION-SPECIFIC". A failed re-index of one
   * revision must leave another revision's index exactly as it was — the whole
   * point of keying the index by the revision rather than by the document.
   */
  it('cannot disturb another revision’s index, even when it fails', async () => {
    const first = await upload(harness, master, pdfWith(DRIVE_MANUAL));
    const second = await addDocumentVersion(harness.as(master), first, {
      version: '2.0',
      fileName: 'alarms-rev2.pdf',
      pageCount: 1,
      description: 'Revision 2.',
    });

    const before = await harness.repos.documents.findTextIndex(first.id);
    expect(before?.state).toBe('indexed');

    // The new revision has no stored bytes, so its re-index is refused.
    await expect(reindexDocument(harness.as(master), second)).rejects.toThrowError(
      /no stored file/i,
    );

    const after = await harness.repos.documents.findTextIndex(first.id);
    expect(after).toEqual(before);
    expect(await harness.repos.documents.findTextContent(first.id)).toContain('servo amplifier');
    expect(await harness.repos.documents.findTextIndex(second.id)).toBeNull();
  });

  it('refuses a technician, because it decides what the library can find', async () => {
    const document = await upload(harness, master, pdfWith(DRIVE_MANUAL));
    await expect(reindexDocument(harness.as(technician), document)).rejects.toThrowError(
      /Only a Master can manage the technical library/i,
    );
  });
});

describe('who may open a revision’s file', () => {
  /*
   * The rule the PREVIEW and the DOWNLOAD both answer to — asserted on the
   * function rather than only through a route, so a second caller cannot get a
   * different answer.
   */
  const file = (over: Partial<Pick<TechnicalDocument, 'status' | 'uploadedBy'>> = {}) => ({
    status: 'current' as TechnicalDocument['status'],
    uploadedBy: technician.id,
    ...over,
  });

  it('serves a current revision to anybody who may read the library', () => {
    for (const actor of [master, coordinator, technician]) {
      expect(canOpenDocumentFile(actor, file())).toBe(true);
    }
  });

  it('serves an archived revision too, because the job that referenced it still resolves', () => {
    expect(canOpenDocumentFile(technician, file({ status: 'archived' }))).toBe(true);
  });

  it('keeps a pending upload to the office and to its own uploader', () => {
    const pending = file({ status: 'pending_approval', uploadedBy: technician.id });
    expect(canOpenDocumentFile(master, pending)).toBe(true);
    expect(canOpenDocumentFile(coordinator, pending)).toBe(true);
    expect(canOpenDocumentFile(technician, pending)).toBe(true);
    // Another technician: an unapproved manual followed on site is the risk
    // the approval step exists for.
    expect(canOpenDocumentFile(otherTechnician, pending)).toBe(false);
  });

  it('refuses an account that may not read the library at all', () => {
    expect(canOpenDocumentFile({ id: master.id, role: 'nobody' as never }, file())).toBe(false);
  });
});
