import { deflateSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer, type ApiTestClient as Client } from '@/test/api-harness';
import type { LibrarySearchPage } from '@/application/library-search';

/**
 * THE LIBRARY'S FULL-TEXT SEARCH AND UPLOAD, OVER THE REAL ROUTES. LIB-5.
 *
 * What only the routes can answer for:
 *
 *  1. A SESSION IS REQUIRED for both, and no bytes come back without one.
 *  2. THE FILE IS SNIFFED, NOT BELIEVED. A JPEG renamed `.pdf` and declared as
 *     a PDF is refused by the bytes, not by the extension.
 *  3. THE UPLOAD ANSWERS HONESTLY about what it could index — including when it
 *     could not — and a technician's upload is still `pending_approval`.
 *  4. A MALFORMED QUERY IS A BAD REQUEST, and a query the application refuses
 *     comes back with the application's own wording.
 */
const pdf = (text: string): Uint8Array => {
  const content = deflateSync(Buffer.from(`BT /F1 11 Tf 40 800 Td (${text}) Tj ET\n`, 'latin1'));
  const body =
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
    `4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n${content.toString('latin1')}\nendstream\nendobj\n`;
  return new Uint8Array(Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1'));
};

/** A real JPEG header, so what refuses it is the sniffing and not the name. */
const jpeg = (): Uint8Array =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

const FIELDS = {
  name: 'Siemens 840D alarm list',
  description: 'Alarm numbers and the first thing to check.',
  documentType: 'service_manual',
  manufacturer: 'Siemens',
  machineModel: '840D',
  version: '1.0',
  tags: 'alarms,controls',
} as const;

interface UploadBody {
  readonly document: { readonly id: string; readonly status: string; readonly pageCount: number };
  readonly index: { readonly state: string; readonly characters: number; readonly failureReason: string };
}

describe('uploading a document with its file', () => {
  let master: Client;
  let technician: Client;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  it('refuses a request with no session', async () => {
    const stranger = new ApiTestClient();
    const answer = await stranger.upload('/api/library/upload', {
      name: 'manual.pdf',
      type: 'application/pdf',
      bytes: pdf('Nothing to see here at all, but enough words to index.'),
      fields: FIELDS,
    });
    expect(answer.status).toBe(401);
  });

  it('stores the file, indexes the text, and says what it found', async () => {
    const answer = await master.upload<UploadBody>('/api/library/upload', {
      name: 'siemens-840d-alarms.pdf',
      type: 'application/pdf',
      bytes: pdf('Alarm 300500 is a drive enable fault. Check terminal 64 before the module.'),
      fields: FIELDS,
    });

    expect(answer.status).toBe(200);
    expect(answer.data.document.status).toBe('current');
    expect(answer.data.document.pageCount).toBe(1);
    expect(answer.data.index.state).toBe('indexed');
    expect(answer.data.index.characters).toBeGreaterThan(40);
    // The storage key is an internal detail and is never handed to a client.
    expect(JSON.stringify(answer.raw)).not.toContain('library/');
  });

  it('refuses an image, by its bytes rather than by its name', async () => {
    const answer = await master.upload('/api/library/upload', {
      name: 'manual.pdf',
      type: 'application/pdf',
      bytes: jpeg(),
      fields: FIELDS,
    });
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.error)).toMatch(/PDF/);
  });

  it('refuses an upload with no name, rather than filing it as blank', async () => {
    const answer = await master.upload('/api/library/upload', {
      name: 'manual.pdf',
      type: 'application/pdf',
      bytes: pdf('A document with plenty of words in it, but no name on the form.'),
      fields: { ...FIELDS, name: '' },
    });
    expect(answer.status).toBe(400);
  });

  it('leaves a technician’s upload awaiting approval, and out of the search', async () => {
    const answer = await technician.upload<UploadBody>('/api/library/upload', {
      name: 'hoist.pdf',
      type: 'application/pdf',
      bytes: pdf('The hoist brake is adjusted through the castellated nut behind the cover.'),
      fields: { ...FIELDS, name: 'Hoist brake adjustment' },
    });
    expect(answer.status).toBe(200);
    expect(answer.data.document.status).toBe('pending_approval');

    const search = await technician.get<LibrarySearchPage>(
      '/api/library/search?q=castellated%20nut',
    );
    expect(search.status).toBe(200);
    expect(search.data.matched).toBe(0);
  });
});

describe('searching inside the documents', () => {
  let master: Client;
  let technician: Client;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    technician = await signedInAs(DEMO_USERS.technician);
    const upload = await master.upload('/api/library/upload', {
      name: 'siemens-840d-alarms.pdf',
      type: 'application/pdf',
      bytes: pdf('Alarm 300500 is a drive enable fault. Check terminal 64 before the module.'),
      fields: FIELDS,
    });
    expect(upload.status).toBe(200);
  });

  it('refuses a request with no session', async () => {
    const stranger = new ApiTestClient();
    const answer = await stranger.get('/api/library/search?q=drive%20enable');
    expect(answer.status).toBe(401);
    expect(JSON.stringify(answer.raw)).not.toContain('Siemens');
  });

  it('finds the words inside the document, with a snippet', async () => {
    const answer = await technician.get<LibrarySearchPage>('/api/library/search?q=drive%20enable');
    expect(answer.status).toBe(200);
    expect(answer.data.matched).toBe(1);
    expect(answer.data.hits[0]?.document.name).toBe(FIELDS.name);
    expect(answer.data.hits[0]?.snippets.join(' ')).toContain('drive enable fault');
  });

  it('refuses a query with nothing in it, in the words the screen shows', async () => {
    const answer = await technician.get('/api/library/search?q=a');
    expect(answer.status).toBe(422);
    expect(answer.error?.violations[0]?.code).toBe('query_too_short');
  });

  it('refuses a page that is not a number, and one out of range', async () => {
    expect((await technician.get('/api/library/search?q=drive&page=none')).status).toBe(400);
    expect((await technician.get('/api/library/search?q=drive&page=9999')).status).toBe(422);
  });

  it('refuses a parameter nobody offers', async () => {
    const answer = await technician.get('/api/library/search?q=drive&status=archived');
    expect(answer.status).toBe(400);
  });
});

describe('opening a stored document', () => {
  let master: Client;
  let coordinator: Client;
  let technician: Client;
  let otherTechnician: Client;
  let current: string;
  let pending: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    technician = await signedInAs(DEMO_USERS.technician);
    otherTechnician = await signedInAs(DEMO_USERS.otherTechnician);

    const published = await master.upload<UploadBody>('/api/library/upload', {
      name: 'siemens-840d-alarms.pdf',
      type: 'application/pdf',
      bytes: pdf('Alarm 300500 is a drive enable fault. Check terminal 64 before the module.'),
      fields: FIELDS,
    });
    current = published.data.document.id;

    const submitted = await technician.upload<UploadBody>('/api/library/upload', {
      name: 'hoist.pdf',
      type: 'application/pdf',
      bytes: pdf('The hoist brake is adjusted through the castellated nut behind the cover.'),
      fields: { ...FIELDS, name: 'Hoist brake adjustment' },
    });
    pending = submitted.data.document.id;
  });

  it('hands the stored bytes to anybody who may read the library', async () => {
    for (const client of [master, coordinator, technician]) {
      const answer = await client.download(`/api/library/${current}/file`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get('content-type')).toBe('application/pdf');
      expect(answer.headers.get('content-disposition')).toMatch(/attachment; filename="/);
      // The file itself, not a description of one.
      expect(new TextDecoder().decode(answer.bytes.subarray(0, 5))).toBe('%PDF-');
    }
  });

  /*
   * AN UNAPPROVED DOCUMENT IS NOT REFERENCE MATERIAL, and the refusal is a 404
   * rather than a 403 — the same answer a document that does not exist gets,
   * so the response cannot be used to ask what is waiting for approval.
   */
  it('refuses a pending upload to a technician who is not its uploader', async () => {
    const answer = await otherTechnician.download(`/api/library/${pending}/file`);
    expect(answer.status).toBe(404);
    expect(answer.bytes.byteLength === 0 || !answer.text.startsWith('%PDF-')).toBe(true);
  });

  it('serves a pending upload to the office that has to approve it, and to its uploader', async () => {
    for (const client of [master, coordinator, technician]) {
      expect((await client.download(`/api/library/${pending}/file`)).status).toBe(200);
    }
  });

  it('answers 404 for a record that has no stored file, and says so', async () => {
    // Every seeded document is metadata: there was no upload path when the
    // demonstration data was written.
    const library = await master.get<{ documents: readonly { id: string; name: string }[] }>(
      '/api/library',
    );
    const seeded = library.data.documents.find(
      (document) => document.id === 'doc-lw-v40-manual',
    );
    expect(seeded).toBeDefined();

    const answer = await master.download(`/api/library/${seeded?.id ?? ''}/file`);
    expect(answer.status).toBe(404);
    expect(JSON.stringify(answer.error)).toMatch(/never uploaded|no file stored/i);
  });

  it('refuses a request with no session', async () => {
    const stranger = new ApiTestClient();
    const answer = await stranger.download(`/api/library/${current}/file`);
    expect(answer.status).toBe(401);
    expect(answer.text.startsWith('%PDF-')).toBe(false);
  });

  it('never hands a storage key to a client', async () => {
    const library = await master.get('/api/library');
    expect(JSON.stringify(library.raw)).not.toContain('library/');
  });
});

describe('the revision named in the answer, and indexing again', () => {
  let master: Client;
  let technician: Client;
  let current: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    technician = await signedInAs(DEMO_USERS.technician);
    const published = await master.upload<UploadBody>('/api/library/upload', {
      name: 'siemens-840d-alarms.pdf',
      type: 'application/pdf',
      bytes: pdf('Alarm 300500 is a drive enable fault. Check terminal 64 before the module.'),
      fields: FIELDS,
    });
    current = published.data.document.id;
  });

  /*
   * THE PREVIEW CHECKS THIS HEADER against the revision it asked for, so that
   * a screen can never silently show a technician a different version of the
   * document they are working from.
   */
  it('names the revision and the version it served', async () => {
    const answer = await master.download(`/api/library/${current}/file`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('x-eje-document-revision')).toBe(current);
    expect(answer.headers.get('x-eje-document-version')).toBe(FIELDS.version);
    // And the bytes are a PDF, which is what the preview refuses to fake.
    expect(new TextDecoder().decode(answer.bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('re-indexes a revision for the office, and refuses a technician', async () => {
    const refused = await technician.post(`/api/library/${current}/reindex`);
    expect(refused.status).toBe(403);

    const again = await master.post<{ state: string; characters: number }>(
      `/api/library/${current}/reindex`,
    );
    expect(again.status).toBe(200);
    expect(again.data.state).toBe('indexed');
    expect(again.data.characters).toBeGreaterThan(20);

    // Idempotent: the library still reports one index for this revision.
    const library = await master.get<{ indexes: readonly { documentId: string }[] }>(
      '/api/library',
    );
    const rows = library.data.indexes.filter((index) => index.documentId === current);
    expect(rows).toHaveLength(1);
  });

  it('refuses a re-index of a record that has no stored file, with the reason', async () => {
    const answer = await master.post('/api/library/doc-lw-v40-manual/reindex');
    expect(answer.status).toBe(422);
    expect(JSON.stringify(answer.error)).toMatch(/never uploaded|no stored file/i);
  });
});
