import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';
import type { CustomerDocument } from '@/domain';

/**
 * A CUSTOMER'S FILED PAPERWORK, THROUGH THE REAL ROUTES. October mandate §4.
 *
 * WHAT WAS MISSING. Jobs, machines, checklists and the library all carry
 * files; a customer carried none, so the signed service agreement and the
 * credit application lived in a mailbox.
 *
 * These are about the HTTP boundary, where the actor comes from a session and
 * every identifier comes from a browser:
 *
 *   - the office may attach and read; a technician may do NEITHER, and the
 *     refusal is the same whichever end they try;
 *   - a document id from one customer must not resolve under another customer's
 *     URL, and the refusal must not say which of the two was wrong;
 *   - what is stored is the server's finding about the bytes, never the
 *     browser's claim about the file.
 */
const PDF = '%PDF-1.4\nsigned service agreement\n%%EOF';
const CUSTOMER = 'cust-abc';

type DocumentRow = Omit<CustomerDocument, 'storageKey'>;

describe('customer documents', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;
  let technician: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  const attach = (
    client: ApiTestClient,
    customerId = CUSTOMER,
    body = PDF,
    name = 'service-agreement.pdf',
    type = 'application/pdf',
  ) =>
    client.upload<{ document: DocumentRow }>(`/api/customers/${customerId}/documents`, {
      name,
      type,
      bytes: new TextEncoder().encode(body),
      fields: { caption: 'Signed service agreement, 2026' },
    });

  it('lets the office attach a document, and records what it actually stored', async () => {
    const attached = await attach(master);
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);

    const document = attached.data.document;
    expect(document.fileName).toBe('service-agreement.pdf');
    expect(document.caption).toBe('Signed service agreement, 2026');
    // MEASURED, not asserted by the client.
    expect(document.sizeBytes).toBe(new TextEncoder().encode(PDF).byteLength);
    expect(document.checksumSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(document.provenance).toBe('genuine');
    // The key never leaves the server.
    expect(document).not.toHaveProperty('storageKey');
  });

  it('serves the SAME BYTES back, as an attachment', async () => {
    const attached = await attach(master);
    const file = await master.download(
      `/api/customers/${CUSTOMER}/documents/${attached.data.document.id}`,
    );

    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(file.bytes)).toBe(PDF);
    expect(file.headers.get('content-disposition')).toContain('attachment');
    // Never rendered in this origin: a file somebody uploaded must not become
    // part of the application.
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('cache-control')).toContain('no-store');
  });

  it('puts it on the office’s customer screen and NOT a technician’s', async () => {
    await attach(master);

    const office = await master.get<{ documents: readonly DocumentRow[] }>(
      `/api/customers/${CUSTOMER}`,
    );
    expect(office.data.documents).toHaveLength(1);

    // Empty in the RESPONSE, not hidden by the screen.
    const field = await technician.get<{ documents: readonly DocumentRow[] }>(
      `/api/customers/${CUSTOMER}`,
    );
    expect(field.status).toBe(200);
    expect(field.data.documents).toEqual([]);
  });

  /* -- who may, and who may not -------------------------------------------- */

  it('REFUSES a technician attaching one', async () => {
    const refused = await attach(technician);
    expect([403, 404]).toContain(refused.status);

    // And nothing was recorded by the attempt.
    const listed = await master.get<{ documents: readonly DocumentRow[] }>(
      `/api/customers/${CUSTOMER}/documents`,
    );
    expect(listed.data.documents).toEqual([]);
  });

  it('REFUSES a technician reading the list or the file', async () => {
    const attached = await attach(master);

    expect((await technician.get(`/api/customers/${CUSTOMER}/documents`)).status).toBe(403);
    const file = await technician.download(
      `/api/customers/${CUSTOMER}/documents/${attached.data.document.id}`,
    );
    expect([403, 404]).toContain(file.status);
  });

  it('lets a Coordinator attach one, because the register is theirs too', async () => {
    const attached = await attach(coordinator);
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);
  });

  /**
   * THE CROSS-CUSTOMER CASE, which is the one a URL invites. A document id is
   * real and the customer in the path is a different, equally real customer.
   */
  it('REFUSES a document id under another customer’s URL, with a 404', async () => {
    const attached = await attach(master);
    const others = await master.get<readonly { id: string }[]>('/api/customers');
    const other = others.data.find((row) => row.id !== CUSTOMER);
    expect(other, 'the demonstration data has only one customer').toBeDefined();

    const file = await master.download(
      `/api/customers/${other?.id ?? ''}/documents/${attached.data.document.id}`,
    );
    // A 404 rather than a 403: the response must not confirm that the document
    // exists somewhere else.
    expect(file.status).toBe(404);
  });

  it('answers 404 for a document id that is not a document at all', async () => {
    const file = await master.download(
      `/api/customers/${CUSTOMER}/documents/00000000-0000-4000-8000-00000000dead`,
    );
    expect(file.status).toBe(404);
  });

  /* -- what the server does not take the browser's word for ---------------- */

  it('REFUSES an executable wearing a PDF’s name', async () => {
    const refused = await attach(
      master,
      CUSTOMER,
      // ELF header: not a document, whatever the name and the declared type say.
      '\u007fELF\u0002\u0001\u0001\u0000and then some machine code',
    );
    expect(refused.status).toBe(400);
  });

  /* -- withdrawn, never deleted -------------------------------------------- */

  it('withdraws a document from the screen and KEEPS the file', async () => {
    const attached = await attach(master);
    const id = attached.data.document.id;

    const withdrawn = await master.post(
      `/api/customers/${CUSTOMER}/documents/${id}/withdraw`,
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBe(200);

    // Off the list the office reads…
    const listed = await master.get<{ documents: readonly DocumentRow[] }>(
      `/api/customers/${CUSTOMER}/documents`,
    );
    expect(listed.data.documents).toEqual([]);

    // …and the FILE is still there, because an audit of what was on file when
    // a decision was taken has to resolve afterwards.
    const file = await master.download(`/api/customers/${CUSTOMER}/documents/${id}`);
    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(file.bytes)).toBe(PDF);
  });

  it('REFUSES a technician withdrawing one', async () => {
    const attached = await attach(master);
    const refused = await technician.post(
      `/api/customers/${CUSTOMER}/documents/${attached.data.document.id}/withdraw`,
    );
    expect([403, 404, 422]).toContain(refused.status);

    // Still on file.
    const listed = await master.get<{ documents: readonly DocumentRow[] }>(
      `/api/customers/${CUSTOMER}/documents`,
    );
    expect(listed.data.documents).toHaveLength(1);
  });

  it('REFUSES withdrawing a document that belongs to another customer', async () => {
    const attached = await attach(master);
    const others = await master.get<readonly { id: string }[]>('/api/customers');
    const other = others.data.find((row) => row.id !== CUSTOMER);

    const refused = await master.post(
      `/api/customers/${other?.id ?? ''}/documents/${attached.data.document.id}/withdraw`,
    );
    expect([404, 422]).toContain(refused.status);
  });

  it('REFUSES a document for a customer that does not exist', async () => {
    const refused = await attach(master, '00000000-0000-4000-8000-0000000000ff');
    expect([403, 404, 422]).toContain(refused.status);
  });
});
