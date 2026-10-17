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
 * (2) NOTHING ABOUT THE REGISTER'S PERMISSIONS TO *CHANGE* A MACHINE WAS
 * WIDENED. *Amended 18 October 2026: EJE answered BD-14* — a technician may
 * photograph an official machine when the photograph belongs to their work, and
 * "belongs to their work" is a fact the server checks rather than a claim the
 * client makes: the request names a job, and that job must be on this machine,
 * assigned to this actor, and still live. Everything else is unchanged and
 * asserted below: a technician still cannot edit a machine, cannot approve one,
 * and cannot photograph a machine they have no job on. A photograph never
 * alters a field and never alters approval.
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

  /**
   * A live job for Sipho on a machine that is ALREADY on the official register.
   *
   * The seeded `machine-abc-lv40` is approved, which is the point: BD-14 is
   * about official machines, and a fixture that used a pending one would prove
   * nothing.
   */
  const jobOnSeededMachine = async (): Promise<{
    machineId: string;
    jobId: string;
    jobNumber: string;
  }> => {
    const siphoId =
      (
        await master.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
      ).data.users.find((user) => user.email === DEMO_USERS.technician)?.id ?? '';

    const created = await master.post<{ id: string; jobNumber: string; machineId: string }>(
      '/api/jobs',
      {
        customerId: 'cust-abc',
        siteId: 'site-abc-jhb',
        contactId: 'contact-abc-jhb',
        machineId: 'machine-abc-lv40',
        jobType: 'breakdown',
        priority: 'urgent',
        scheduledDate: null,
        scheduledEndDate: null,
        orderNumber: 'PO-77990',
        referenceNumber: '',
        faultDescription: 'Spindle drive tripping.',
        primaryTechnicianId: siphoId,
        courierCollection: false,
        deliveryNote: '',
      },
    );
    expect(created.status).toBe(200);
    expect((await sipho.post(`/api/jobs/${created.data.id}/accept`)).status).toBe(200);
    return {
      machineId: 'machine-abc-lv40',
      jobId: created.data.id,
      jobNumber: created.data.jobNumber,
    };
  };

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

  it('refuses a technician photographing an official machine with NO job on it', async () => {
    const official = await raise(master, 'QT200-OFFICIAL-4');

    const response = await photograph(sipho, official.data.id);

    /*
     * BD-14 allows the photograph when it belongs to the technician's work. It
     * does not allow photographing any machine in the register, and this is
     * where that line sits: no job named, no photograph.
     *
     * 403 and not 422, which is the project's own distinction: 403 means
     * permanent for this actor as things stand, 422 means not yet.
     */
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.raw)).toMatch(/job of yours|change request/iu);
  });

  /* -- BD-14: the technician's own live job on that machine ---------------- */

  it('LETS a technician photograph an official machine from a live job of theirs', async () => {
    // The case BD-14 decided: the technician is standing at the machine
    // because a job of theirs is on it.
    const { machineId, jobId } = await jobOnSeededMachine();
    const bytes = png('rating plate, from the job');

    const uploaded = await photograph(sipho, machineId, {
      bytes,
      fields: { jobId, caption: 'Rating plate' },
    });

    expect(uploaded.status).toBe(200);
    expect(uploaded.data.photos.at(-1)?.caption).toBe('Rating plate');
    // The official record is untouched: still approved, nothing else changed.
    expect(uploaded.data.approval).toBe('approved');

    const download = await sipho.download(
      `/api/machines/${machineId}/photos/${uploaded.data.photos.at(-1)?.id ?? ''}`,
    );
    expect(download.status).toBe(200);
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
  });

  it('refuses a job id that is not on THIS machine', async () => {
    const { jobId } = await jobOnSeededMachine();
    const other = await raise(master, 'QT200-ELSEWHERE-1');

    // A real job of this technician's, and a real machine, which are not
    // related. Naming a job does not make a photograph relevant to it.
    const response = await photograph(sipho, other.data.id, { fields: { jobId } });
    expect(response.status).toBe(403);
  });

  it('refuses a job id belonging to ANOTHER technician', async () => {
    const { machineId, jobId } = await jobOnSeededMachine();
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);

    const response = await photograph(riaan, machineId, { fields: { jobId } });
    expect(response.status).toBe(403);
  });

  it('refuses a job that has been closed or cancelled', async () => {
    const { machineId, jobId, jobNumber } = await jobOnSeededMachine();
    // Cancellation is not available on an in-progress job, so this uses the
    // one route out that IS: the technician hands it back to the pool, which
    // takes them off the crew.
    expect(
      (
        await sipho.post(`/api/jobs/${jobId}/transfer_to_open`, {
          reason: 'requires_another_technician',
          description: 'Needs the drive specialist.',
        })
      ).status,
    ).toBe(200);

    const response = await photograph(sipho, machineId, { fields: { jobId } });
    expect(response.status).toBe(403);
    expect(jobNumber.length).toBeGreaterThan(0);
  });

  it('records the photograph against the job that authorised it', async () => {
    const { machineId, jobId, jobNumber } = await jobOnSeededMachine();
    await photograph(sipho, machineId, { fields: { jobId, caption: 'Nameplate' } });

    const view = await sipho.get<{
      activity: readonly { type: string; detail: string; summary: string }[];
    }>(`/api/jobs/${jobNumber}`);

    const event = view.data.activity.find((entry) => entry.type === 'machine_photographed');
    expect(event, JSON.stringify(view.data.activity.map((entry) => entry.type))).toBeDefined();
    // `machine_photographed`, NOT `machine_updated`: the record did not change.
    expect(event?.detail).toContain(jobNumber);
  });

  it('still refuses a technician CHANGING the machine they just photographed', async () => {
    // BD-14 granted a photograph and nothing else. This is the assertion that
    // keeps it that way.
    const { machineId, jobId } = await jobOnSeededMachine();
    expect((await photograph(sipho, machineId, { fields: { jobId } })).status).toBe(200);

    const edit = await sipho.post(`/api/machines/${machineId}/update`, {
      ...NEW_MACHINE,
      serialNumber: 'HA-ST20-33907',
      notes: 'Technician changed this.',
    });
    expect(edit.status).not.toBe(200);
    expect(edit.status).toBeLessThan(500);
  });

  it('refuses a technician photographing ANOTHER technician’s pending machine', async () => {
    const theirs = await raise(sipho, 'QT200-TECH-5');
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);

    const response = await photograph(riaan, theirs.data.id);
    expect(response.status).toBe(403);
    // Not their submission, and no job of theirs on it either.
    expect(JSON.stringify(response.raw)).toMatch(/job of yours|added yourself/iu);
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
