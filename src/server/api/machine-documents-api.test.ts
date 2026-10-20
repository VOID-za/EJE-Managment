import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';
import type { MachineDocument } from '@/domain';

/**
 * PAPER ABOUT ONE MACHINE, THROUGH THE REAL ROUTES. October mandate §4.
 *
 * WHAT WAS MISSING. A machine carried photographs and nothing else, so its
 * commissioning report, its compliance certificate and the calibration results
 * for that serial number had nowhere to live — the library files by MODEL, and
 * a photograph table renders a PDF as a broken image.
 *
 * WHAT IS DIFFERENT FROM A CUSTOMER'S PAPERWORK, and it is the whole point of
 * these tests: reading is decided by the DOCUMENT, not by the role alone. The
 * office reads everything; a technician reads what the office marked `field`.
 * So there are two refusals to prove and they must look the same from outside:
 * a document that does not exist, and one the office kept to itself.
 */
const PDF = '%PDF-1.4\nlaser calibration results\n%%EOF';
const MACHINE = 'machine-abc-lv40';

type DocumentRow = Omit<MachineDocument, 'storageKey'>;

describe('machine documents', () => {
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
    options: {
      readonly machineId?: string;
      readonly body?: string;
      readonly name?: string;
      readonly audience?: string;
    } = {},
  ) =>
    client.upload<{ document: DocumentRow }>(
      `/api/machines/${options.machineId ?? MACHINE}/documents`,
      {
        name: options.name ?? 'laser-calibration.pdf',
        type: 'application/pdf',
        bytes: new TextEncoder().encode(options.body ?? PDF),
        fields: {
          caption: 'Laser calibration, March 2026',
          ...(options.audience === undefined ? {} : { audience: options.audience }),
        },
      },
    );

  it('lets the office attach one, and records what it actually stored', async () => {
    const attached = await attach(master, { audience: 'field' });
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);

    const document = attached.data.document;
    expect(document.fileName).toBe('laser-calibration.pdf');
    expect(document.caption).toBe('Laser calibration, March 2026');
    // MEASURED, not asserted by the client.
    expect(document.sizeBytes).toBe(new TextEncoder().encode(PDF).byteLength);
    expect(document.checksumSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(document.audience).toBe('field');
    expect(document.provenance).toBe('genuine');
    // The key never leaves the server.
    expect(document).not.toHaveProperty('storageKey');
  });

  it('serves the SAME BYTES back, as an attachment', async () => {
    const attached = await attach(master);
    const file = await master.download(
      `/api/machines/${MACHINE}/documents/${attached.data.document.id}`,
    );

    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(file.bytes)).toBe(PDF);
    expect(file.headers.get('content-disposition')).toContain('attachment');
    // Never rendered in this origin, unlike a machine PHOTOGRAPH: a document
    // may be any type, and a photograph is checked against the raster list.
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
    expect(file.headers.get('cache-control')).toContain('no-store');
  });

  /* -- the audience, which is the rule this table exists to carry ---------- */

  it('DEFAULTS to office-only when nobody said', async () => {
    // The safe direction, and the one a forgetful upload lands on: a manual
    // left office-only is an inconvenience, an invoice in the field is not.
    const attached = await attach(master);
    expect(attached.data.document.audience).toBe('office_only');
  });

  it('shows a FIELD document to a technician, bytes and all', async () => {
    const attached = await attach(master, { audience: 'field' });

    const listed = await technician.get<{ documents: readonly DocumentRow[] }>(
      `/api/machines/${MACHINE}/documents`,
    );
    expect(listed.status).toBe(200);
    expect(listed.data.documents.map((row) => row.id)).toContain(attached.data.document.id);

    const file = await technician.download(
      `/api/machines/${MACHINE}/documents/${attached.data.document.id}`,
    );
    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(file.bytes)).toBe(PDF);
  });

  it('keeps an OFFICE-ONLY document out of a technician’s response entirely', async () => {
    const attached = await attach(master, { audience: 'office_only' });

    // Not hidden by a screen: ABSENT from what the server sent.
    const listed = await technician.get<{ documents: readonly DocumentRow[] }>(
      `/api/machines/${MACHINE}/documents`,
    );
    expect(listed.status).toBe(200);
    expect(listed.data.documents).toEqual([]);

    /*
     * AND THE FILE IS A 404, NOT A 403. A refusal that said "you may not read
     * this one" would tell a technician which machines carry paperwork the
     * office is keeping from them.
     */
    const file = await technician.download(
      `/api/machines/${MACHINE}/documents/${attached.data.document.id}`,
    );
    expect(file.status).toBe(404);
  });

  it('puts an office-only document on the office’s MACHINE SCREEN and not a technician’s', async () => {
    await attach(master, { audience: 'office_only' });

    const office = await master.get<{ documents: readonly DocumentRow[] }>(
      `/api/machines/${MACHINE}`,
    );
    expect(office.data.documents).toHaveLength(1);

    const field = await technician.get<{ documents: readonly DocumentRow[] }>(
      `/api/machines/${MACHINE}`,
    );
    expect(field.status).toBe(200);
    expect(field.data.documents).toEqual([]);
  });

  /* -- who may attach -------------------------------------------------------- */

  it('REFUSES a technician attaching one', async () => {
    const refused = await attach(technician, { audience: 'field' });
    expect([403, 404, 422]).toContain(refused.status);

    // And nothing was recorded by the attempt.
    const listed = await master.get<{ documents: readonly DocumentRow[] }>(
      `/api/machines/${MACHINE}/documents`,
    );
    expect(listed.data.documents).toEqual([]);
  });

  it('lets a Coordinator attach one, because the register is theirs too', async () => {
    const attached = await attach(coordinator);
    expect(attached.status, JSON.stringify(attached.error)).toBe(200);
  });

  /* -- what a URL invites ---------------------------------------------------- */

  it('REFUSES a document id under another machine’s URL, with a 404', async () => {
    const attached = await attach(master, { audience: 'field' });
    const others = await master.get<readonly { id: string }[]>('/api/machines');
    const other = others.data.find((row) => row.id !== MACHINE);
    expect(other, 'the demonstration data has only one machine').toBeDefined();

    const file = await master.download(
      `/api/machines/${other?.id ?? ''}/documents/${attached.data.document.id}`,
    );
    // A 404 rather than a 403: the response must not confirm that the document
    // exists somewhere else.
    expect(file.status).toBe(404);
  });

  it('answers 404 for a document id that is not a document at all', async () => {
    const file = await master.download(
      `/api/machines/${MACHINE}/documents/00000000-0000-4000-8000-00000000dead`,
    );
    expect(file.status).toBe(404);
  });

  it('REFUSES an executable wearing a PDF’s name', async () => {
    const refused = await attach(master, {
      // ELF header: not a document, whatever the name and the declared type say.
      body: '\u007fELF\u0002\u0001\u0001\u0000and then some machine code',
    });
    expect(refused.status).toBe(400);
  });

  it('REFUSES a document for a machine that does not exist', async () => {
    const refused = await attach(master, {
      machineId: '00000000-0000-4000-8000-0000000000ff',
    });
    expect([403, 404, 422]).toContain(refused.status);
  });

  /* -- withdrawn, never deleted --------------------------------------------- */

  it('withdraws a document from the screen and KEEPS the file', async () => {
    const attached = await attach(master, { audience: 'field' });
    const id = attached.data.document.id;

    const withdrawn = await master.post(`/api/machines/${MACHINE}/documents/${id}/withdraw`);
    expect(withdrawn.status, JSON.stringify(withdrawn.error)).toBe(200);

    const listed = await master.get<{ documents: readonly DocumentRow[] }>(
      `/api/machines/${MACHINE}/documents`,
    );
    expect(listed.data.documents).toEqual([]);

    // …and the FILE is still there, because an audit of what was on file when
    // a machine was signed off has to resolve afterwards.
    const file = await master.download(`/api/machines/${MACHINE}/documents/${id}`);
    expect(file.status).toBe(200);
    expect(new TextDecoder().decode(file.bytes)).toBe(PDF);
  });

  it('REFUSES a technician withdrawing one, even a field document', async () => {
    const attached = await attach(master, { audience: 'field' });
    const refused = await technician.post(
      `/api/machines/${MACHINE}/documents/${attached.data.document.id}/withdraw`,
    );
    expect([403, 404, 422]).toContain(refused.status);

    // Still on file.
    const listed = await master.get<{ documents: readonly DocumentRow[] }>(
      `/api/machines/${MACHINE}/documents`,
    );
    expect(listed.data.documents).toHaveLength(1);
  });
});
