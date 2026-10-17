import { beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * MACHINE PHOTOGRAPHS, AND THE REGISTER'S RULES ABOUT THEM. MACH-PHOTO-1.
 *
 * TWO THINGS ARE BEING PROVED, and the second matters more than the first.
 *
 * (1) The photographs are real. `createMachine` used to take a file name and a
 * size the client made up and call `storage.put(…, null)`, so the register
 * displayed photographs that did not exist.
 *
 * (2) NOTHING ABOUT THE REGISTER'S PERMISSIONS WAS WIDENED to make that
 * possible. A technician may not change an official machine record — that is
 * the change-request process — so a technician may photograph only a machine
 * THEY raised, while it is still awaiting approval. On an approved machine they
 * are refused, and whether that should ever be allowed is a business decision
 * nobody has made (MACH-PHOTO-2). A photograph never approves a machine and
 * never alters its data.
 */
const png = (label: string): Uint8Array => {
  const text = new TextEncoder().encode(label);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...text]);
};

const PDF = new Uint8Array([
  ...new TextEncoder().encode('%PDF-1.4\n'),
  ...new TextEncoder().encode('not a photograph'),
]);

const NEW_MACHINE = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  manufacturer: 'Mazak',
  model: 'QT-200',
  serialNumber: 'QT200-55512',
  machineNumber: '',
  machineType: 'CNC Lathe',
  year: 2019,
  installationDate: '2019-06-01',
  controlSystem: 'Mazatrol',
  notes: '',
  active: true,
} as const;

interface MachineBody {
  readonly id: string;
  readonly approval: string;
  readonly photos: readonly { readonly id: string }[];
}

interface PhotoList {
  readonly approval: string;
  readonly photos: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly caption: string;
    readonly sizeBytes: number;
  }[];
}

describe('photographing a machine', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    sipho = await signedInAs(DEMO_USERS.technician);
  });

  const raise = (client: ApiTestClient, serial: string) =>
    client.post<MachineBody>('/api/machines', { ...NEW_MACHINE, serialNumber: serial });

  const photograph = (
    client: ApiTestClient,
    machineId: string,
    options: {
      name?: string;
      type?: string;
      bytes?: Uint8Array;
      fields?: Record<string, string>;
      key?: string;
    } = {},
  ) =>
    client.upload<PhotoList>(
      `/api/machines/${machineId}/photos`,
      {
        name: options.name ?? 'rating-plate.png',
        type: options.type ?? 'image/png',
        bytes: options.bytes ?? png('rating plate'),
        ...(options.fields === undefined ? {} : { fields: options.fields }),
      },
      options.key === undefined ? {} : { idempotencyKey: options.key },
    );

  /* -- the office ---------------------------------------------------------- */

  it('lets the office photograph a machine on the official register', async () => {
    const machine = await raise(master, 'QT200-OFFICE-1');
    expect(machine.data.approval).toBe('approved');

    const uploaded = await photograph(master, machine.data.id, {
      fields: { caption: 'Rating plate' },
    });

    expect(uploaded.status).toBe(200);
    expect(uploaded.data.photos).toHaveLength(1);
    expect(uploaded.data.photos[0]?.caption).toBe('Rating plate');
    // And the approval is untouched by a photograph.
    expect(uploaded.data.approval).toBe('approved');
  });

  it('gives back the exact bytes, authenticated', async () => {
    const machine = await raise(master, 'QT200-OFFICE-2');
    const bytes = png('the plate itself');
    const uploaded = await photograph(master, machine.data.id, { bytes });
    const id = uploaded.data.photos[0]?.id ?? '';

    const download = await sipho.download(`/api/machines/${machine.data.id}/photos/${id}`);

    // Readable by a technician: a machine's history is the most useful thing
    // to have before driving to it, and the photographs are part of it.
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(download.headers.get('content-disposition')).toContain('inline;');
    expect(download.headers.get('cache-control')).toContain('no-store');
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
  });

  it('measures the size off the bytes', async () => {
    const machine = await raise(master, 'QT200-OFFICE-3');
    const bytes = png('a label of some length');
    const uploaded = await photograph(master, machine.data.id, { bytes });
    expect(uploaded.data.photos[0]?.sizeBytes).toBe(bytes.length);
  });

  /* -- the technician's own submission ------------------------------------- */

  it('lets a technician photograph a machine THEY raised, while it awaits approval', async () => {
    const machine = await raise(sipho, 'QT200-TECH-1');
    // A technician's machine lands unconfirmed — unchanged by this batch.
    expect(machine.data.approval).toBe('pending_approval');

    const uploaded = await photograph(sipho, machine.data.id, {
      fields: { caption: 'As found on site' },
    });

    expect(uploaded.status).toBe(200);
    expect(uploaded.data.photos).toHaveLength(1);
    // STILL PENDING. A photograph is not an approval.
    expect(uploaded.data.approval).toBe('pending_approval');
  });

  it('refuses a technician photographing an APPROVED machine — MACH-PHOTO-2', async () => {
    const official = await raise(master, 'QT200-OFFICIAL-4');

    const response = await photograph(sipho, official.data.id);

    /*
     * 403 AND NOT 422, and the distinction is the project's own: 403 means
     * permanent for this actor, 422 means not yet. A technician photographing
     * an official machine is not a thing that becomes possible later — it is a
     * decision nobody has made (MACH-PHOTO-2) — so the refusal says so.
     */
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.raw)).toMatch(/official register|change request/iu);
  });

  it('refuses a technician photographing ANOTHER technician’s pending machine', async () => {
    const theirs = await raise(sipho, 'QT200-TECH-5');
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);

    const response = await photograph(riaan, theirs.data.id);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.raw)).toMatch(/added by somebody else/iu);
  });

  it('still refuses a technician CHANGING the machine record', async () => {
    // The permission this batch did not widen, asserted here so a later change
    // to the photo path cannot quietly take it with it.
    const machine = await raise(sipho, 'QT200-TECH-6');
    const response = await sipho.post(`/api/machines/${machine.data.id}/update`, {
      ...NEW_MACHINE,
      serialNumber: 'QT200-TECH-6',
      notes: 'Technician changed this.',
    });
    expect(response.status).not.toBe(200);
    expect(response.status).toBeLessThan(500);
  });

  it('still refuses a technician APPROVING a machine', async () => {
    const machine = await raise(sipho, 'QT200-TECH-7');
    await photograph(sipho, machine.data.id);
    const response = await sipho.post(`/api/machines/${machine.data.id}/approve`);
    expect(response.status).not.toBe(200);
  });

  /* -- retries and refusals ----------------------------------------------- */

  it('does NOT duplicate the photograph when the same capture is retried', async () => {
    const machine = await raise(master, 'QT200-RETRY-1');
    const bytes = png('sent once');
    const first = await photograph(master, machine.data.id, { bytes, key: 'machine-retry' });
    const retry = await photograph(master, machine.data.id, { bytes, key: 'machine-retry' });

    expect(retry.headers.get('Idempotent-Replay')).toBe('true');
    expect(retry.data.photos).toHaveLength(1);
    expect(retry.data.photos[0]?.id).toBe(first.data.photos[0]?.id);
  });

  it('refuses a PDF', async () => {
    const machine = await raise(master, 'QT200-PDF-1');
    const response = await photograph(master, machine.data.id, {
      name: 'quote.pdf',
      type: 'application/pdf',
      bytes: PDF,
    });
    expect(response.status).toBe(400);
  });

  it('refuses an unauthenticated upload and an unauthenticated read', async () => {
    const machine = await raise(master, 'QT200-AUTH-1');
    const uploaded = await photograph(master, machine.data.id);
    const id = uploaded.data.photos[0]?.id ?? '';

    expect(
      (
        await new ApiTestClient().upload(`/api/machines/${machine.data.id}/photos`, {
          name: 'x.png',
          type: 'image/png',
          bytes: png('x'),
        })
      ).status,
    ).toBe(401);
    expect(
      (await new ApiTestClient().download(`/api/machines/${machine.data.id}/photos/${id}`)).status,
    ).toBe(401);
  });

  it('refuses a photograph id moved onto a different machine', async () => {
    const first = await raise(master, 'QT200-CROSS-1');
    const second = await raise(master, 'QT200-CROSS-2');
    const uploaded = await photograph(master, first.data.id);
    const id = uploaded.data.photos[0]?.id ?? '';

    // A real id and a real machine that are not related: the machine in the
    // URL is the authority.
    const response = await master.download(`/api/machines/${second.data.id}/photos/${id}`);
    expect(response.status).toBe(404);
  });

  it('refuses a guessed id, and a machine that does not exist, with the same 404', async () => {
    const machine = await raise(master, 'QT200-GUESS-1');
    expect((await master.download(`/api/machines/${machine.data.id}/photos/att-0001`)).status).toBe(
      404,
    );
    expect(
      (await master.download('/api/machines/00000000-0000-0000-0000-000000000000/photos/att-0001'))
        .status,
    ).toBe(404);
  });

  it('never hands the storage key back', async () => {
    const machine = await raise(master, 'QT200-KEY-1');
    const uploaded = await photograph(master, machine.data.id);
    expect(JSON.stringify(uploaded.raw)).not.toContain('uploads/');
    expect(JSON.stringify(uploaded.raw)).not.toContain('storageKey');
  });
});
