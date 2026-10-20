import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';
import type { Machine, TechnicalDocument } from '@/domain';

/**
 * WHAT THE API SAYS ABOUT DEMONSTRATION DATA. October mandate §1.
 *
 * The screen can only label what the server tells it, and before this the
 * server told it nothing: nine library documents, three machine photographs and
 * six job cards came back indistinguishable from EJE's own records — with file
 * sizes the seed had invented for bytes that do not exist.
 *
 * Two facts, asserted separately here because they are separate:
 *
 *   `provenance`  whose record it is. Recorded, never inferred.
 *   `storedFile`  whether there is anything to download. Nothing is, for a
 *                 record whose size is zero, and the response says so rather
 *                 than leaving each screen to guess.
 */
type LibraryRow = TechnicalDocument & { readonly storedFile: boolean };

describe('the library through the API', () => {
  let master: ApiTestClient;
  let technician: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  it('marks every seeded document as SIMULATED, and says it has no stored file', async () => {
    const response = await master.get<{ documents: readonly LibraryRow[] }>('/api/library');
    expect(response.status).toBe(200);

    const documents = response.data.documents;
    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) {
      expect(document.provenance, document.name).toBe('simulated');
      expect(document.storedFile, document.name).toBe(false);
      /*
       * AND NO INVENTED FILE FACTS. These were `18_442_000` bytes and `214`
       * pages for a manual nobody has ever uploaded, printed on screen beside
       * a download button.
       */
      expect(document.fileSizeBytes, document.name).toBe(0);
      expect(document.pageCount, document.name).toBe(0);
    }
  });

  it('does not leak a storage key while it is at it', async () => {
    const response = await master.get<{ documents: readonly LibraryRow[] }>('/api/library');
    for (const document of response.data.documents) {
      expect(document).not.toHaveProperty('storageKey');
    }
  });

  /**
   * A DOCUMENT SOMEBODY REALLY UPLOADS IS GENUINE, and the same response says
   * so — which is what makes the label above mean anything.
   */
  it('marks a REAL upload genuine, with the size and pages measured off the file', async () => {
    const pdf = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>endobj',
      '4 0 obj<</Length 44>>stream',
      'BT /F1 12 Tf 72 720 Td (Isolation procedure) Tj ET',
      'endstream endobj',
      'trailer<</Root 1 0 R>>',
      '%%EOF',
    ].join('\n');

    const uploaded = await master.upload<{ document: LibraryRow }>('/api/library/upload', {
      name: 'isolation-procedure.pdf',
      type: 'application/pdf',
      bytes: new TextEncoder().encode(pdf),
      fields: {
        name: 'Isolation Procedure',
        description: 'How to make a machine safe before work.',
        documentType: 'safety_procedure',
        manufacturer: '',
        machineModel: '',
        version: '1.0',
        tags: '',
      },
    });

    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(200);
    expect(uploaded.data.document.provenance).toBe('genuine');
    expect(uploaded.data.document.fileSizeBytes).toBe(new TextEncoder().encode(pdf).byteLength);
    expect(uploaded.data.document.pageCount).toBeGreaterThan(0);

    const listed = await technician.get<{ documents: readonly LibraryRow[] }>('/api/library');
    const row = listed.data.documents.find((entry) => entry.name === 'Isolation Procedure');
    expect(row?.provenance).toBe('genuine');
    expect(row?.storedFile).toBe(true);
  });

  /**
   * AND THE FILE ROUTE DOES NOT PRETEND. A record with no bytes answers 404
   * and says what the situation is; it does not serve an empty file, and
   * nothing is generated to stand in for the document.
   */
  it('refuses to serve a file for a record that has none, and says why', async () => {
    const listed = await master.get<{ documents: readonly LibraryRow[] }>('/api/library');
    const metadataOnly = listed.data.documents.find((entry) => !entry.storedFile);
    expect(metadataOnly, 'the demonstration library has no metadata-only record').toBeDefined();

    const file = await master.get(`/api/library/${metadataOnly?.id ?? ''}/file`);
    expect(file.status).toBe(404);
  });
});

describe('machine photographs through the API', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  it('marks the seeded photographs SIMULATED and reports no stored bytes', async () => {
    // The LIST is a summary and carries no photographs; the register's own
    // screen reads them off the machine, so that is what this asks for.
    const listed = await master.get<readonly { id: string }[]>('/api/machines');
    expect(listed.status).toBe(200);

    const machines = await Promise.all(
      listed.data
        .slice(0, 4)
        .map((row) => master.get<{ machine: Machine }>(`/api/machines/${row.id}`)),
    );
    const photographs = machines.flatMap((response) => response.data.machine?.photos ?? []);
    expect(photographs.length).toBeGreaterThan(0);
    for (const photo of photographs) {
      expect(photo.provenance, photo.fileName).toBe('simulated');
      // `1_842_000` was invented in the seed for an image that is not there.
      expect(photo.sizeBytes, photo.fileName).toBe(0);
    }
  });
});
