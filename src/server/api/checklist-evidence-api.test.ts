import { beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * CHECKLIST EVIDENCE, OVER THE REAL HTTP SURFACE. CHK-EVIDENCE-1.
 *
 * WHAT THESE TESTS EXIST TO STOP COMING BACK. `add_checklist_photo` took an
 * item id and a file NAME in a JSON body, called `storage.put(…, null)`, and
 * recorded an attachment with a hard-coded 1.65 MB size. Those attachments are
 * what `completeChecklist` counts when a question is marked `photoRequired` —
 * so an installation checklist could be completed, and the customer's job card
 * could cite photographic evidence, over files that had never existed.
 *
 * Everything below is one property: THE EVIDENCE IS REAL, IT IS THE BYTES THAT
 * WENT UP, AND IT IS BOUND TO THE QUESTION AND THE TEMPLATE VERSION IT WAS
 * ANSWERED AGAINST.
 */
const png = (label: string): Uint8Array => {
  const text = new TextEncoder().encode(label);
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...text]);
};

const PDF = new Uint8Array([
  ...new TextEncoder().encode('%PDF-1.4\n'),
  ...new TextEncoder().encode('a quotation, which is not checklist evidence'),
]);

/** An installation job, because that is the type with a checklist. */
const NEW_JOB = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: 'machine-abc-lv40',
  jobType: 'installation',
  priority: 'normal',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: 'PO-77501',
  referenceNumber: '',
  faultDescription: 'New machine installation and commissioning.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

/** `inst-2` is the item the seeded template marks `photoRequired`. */
const PHOTO_ITEM = 'inst-2';

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
}

interface EvidenceList {
  readonly itemId: string;
  readonly photos: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly caption: string;
    readonly sizeBytes: number;
  }[];
}

const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('attaching evidence to a checklist item', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const siphoId = await userId(master, DEMO_USERS.technician);
    job = (
      await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId })
    ).data;
    sipho = await signedInAs(DEMO_USERS.technician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
    expect((await sipho.post(`/api/jobs/${job.id}/start_checklist`)).status).toBe(200);
  });

  const attach = (
    client: ApiTestClient,
    options: {
      itemId?: string;
      name?: string;
      type?: string;
      bytes?: Uint8Array;
      fields?: Record<string, string>;
      key?: string;
      jobId?: string;
    } = {},
  ) =>
    client.upload<EvidenceList>(
      `/api/jobs/${options.jobId ?? job.id}/checklist/${options.itemId ?? PHOTO_ITEM}/photo`,
      {
        name: options.name ?? 'levelling.png',
        type: options.type ?? 'image/png',
        bytes: options.bytes ?? png('levelling reading'),
        ...(options.fields === undefined ? {} : { fields: options.fields }),
      },
      options.key === undefined ? {} : { idempotencyKey: options.key },
    );

  it('records the evidence against the item', async () => {
    const uploaded = await attach(sipho, { fields: { caption: 'Levelling across the table' } });

    expect(uploaded.status).toBe(200);
    expect(uploaded.data.itemId).toBe(PHOTO_ITEM);
    expect(uploaded.data.photos).toHaveLength(1);
    expect(uploaded.data.photos[0]?.caption).toBe('Levelling across the table');
  });

  it('measures the size off the bytes rather than inventing one', async () => {
    const bytes = png('a longer label, so the length differs');
    const uploaded = await attach(sipho, { bytes });
    // The old path recorded 1_650_000 for every photograph, always.
    expect(uploaded.data.photos[0]?.sizeBytes).toBe(bytes.length);
  });

  it('gives back the exact bytes, through the authenticated media route', async () => {
    const bytes = png('the one frame that matters');
    const uploaded = await attach(sipho, { bytes });
    const id = uploaded.data.photos[0]?.id ?? '';

    const download = await sipho.download(`/api/jobs/${job.id}/media/${id}`);

    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(download.headers.get('cache-control')).toContain('no-store');
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
  });

  it('stays on the item, and on the version that was answered', async () => {
    await attach(sipho, { fields: { caption: 'Levelling' } });

    const view = await sipho.get<{
      view: {
        job: {
          checklist: {
            templateVersion: string;
            responses: readonly {
              itemId: string;
              photos: readonly { caption: string }[];
            }[];
          };
        };
      };
    }>(`/api/jobs/${job.jobNumber}`);

    const checklist = view.data.view.job.checklist;
    // The INSTANCE carries the version, so the evidence is bound to the
    // wording the technician actually answered — a later version of the
    // checklist cannot re-point it.
    expect(checklist.templateVersion).toBe('1.0-DEMO');
    const answered = checklist.responses.find((response) => response.itemId === PHOTO_ITEM);
    expect(answered?.photos.map((photo) => photo.caption)).toEqual(['Levelling']);
    // And no other item picked it up.
    for (const response of checklist.responses) {
      if (response.itemId !== PHOTO_ITEM) expect(response.photos).toHaveLength(0);
    }
  });

  it('adds a second piece of evidence rather than replacing the first', async () => {
    await attach(sipho, { bytes: png('one'), fields: { caption: 'Before' } });
    const second = await attach(sipho, { bytes: png('two'), fields: { caption: 'After' } });

    expect(second.data.photos.map((photo) => photo.caption)).toEqual(['Before', 'After']);
  });

  it('does NOT duplicate the evidence when the same capture is retried', async () => {
    /*
     * The tablet sent it, the server stored it, and the answer was lost. The
     * retry carries the same key — see `usePhotoUpload` — and must be the
     * first answer rather than a second photograph on the record.
     */
    const bytes = png('sent once, answered twice');
    const first = await attach(sipho, { bytes, key: 'evidence-retry' });
    const retry = await attach(sipho, { bytes, key: 'evidence-retry' });

    expect(retry.status).toBe(200);
    expect(retry.headers.get('Idempotent-Replay')).toBe('true');
    expect(retry.data.photos).toHaveLength(1);
    expect(retry.data.photos[0]?.id).toBe(first.data.photos[0]?.id);
  });

  it('treats a DIFFERENT photograph under a reused key as a client bug', async () => {
    await attach(sipho, { bytes: png('first frame'), key: 'one-key-one-photo' });
    const other = await attach(sipho, { bytes: png('another frame'), key: 'one-key-one-photo' });

    expect(other.status).toBe(409);
  });

  /* -- what is not evidence ------------------------------------------------ */

  it('refuses a PDF', async () => {
    const response = await attach(sipho, {
      name: 'quote.pdf',
      type: 'application/pdf',
      bytes: PDF,
    });
    expect(response.status).toBe(400);
    expect((response.error?.violations ?? []).map((violation) => violation.code)).toContain(
      'unsupported_file_type',
    );
  });

  it('refuses bytes that are not an image, whatever the name says', async () => {
    const response = await attach(sipho, {
      name: 'evidence.png',
      type: 'image/png',
      bytes: new TextEncoder().encode('MZ\u0000\u0000 an executable'),
    });
    expect(response.status).toBe(400);
  });

  it('refuses an empty file', async () => {
    expect((await attach(sipho, { bytes: new Uint8Array() })).status).toBe(400);
  });

  /* -- who may ------------------------------------------------------------- */

  it('refuses an unauthenticated upload', async () => {
    const response = await new ApiTestClient().upload(
      `/api/jobs/${job.id}/checklist/${PHOTO_ITEM}/photo`,
      { name: 'x.png', type: 'image/png', bytes: png('x') },
    );
    expect(response.status).toBe(401);
  });

  it('refuses a technician who may not see the job — 404, not 403', async () => {
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);
    const response = await attach(riaan);
    expect(response.status).toBe(404);
  });

  it('refuses evidence pushed onto ANOTHER TECHNICIAN’S job by editing the URL', async () => {
    const riaanId = await userId(master, DEMO_USERS.otherTechnician);
    const theirs = await master.post<JobBody>('/api/jobs', {
      ...NEW_JOB,
      orderNumber: 'PO-77502',
      primaryTechnicianId: riaanId,
    });

    const response = await attach(sipho, { jobId: theirs.data.id });
    // 404 and not 403: a job he may not see does not exist as far as he is
    // concerned, and saying "forbidden" would confirm that it does.
    expect(response.status).toBe(404);
  });

  it('refuses evidence before the checklist has been started', async () => {
    const fresh = await master.post<JobBody>('/api/jobs', {
      ...NEW_JOB,
      orderNumber: 'PO-77503',
      primaryTechnicianId: await userId(master, DEMO_USERS.technician),
    });
    await sipho.post(`/api/jobs/${fresh.data.id}/accept`);

    const response = await attach(sipho, { jobId: fresh.data.id });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.raw)).toMatch(/checklist/iu);
  });

  it('never hands the storage key back', async () => {
    const uploaded = await attach(sipho);
    expect(JSON.stringify(uploaded.raw)).not.toContain('uploads/');
    expect(JSON.stringify(uploaded.raw)).not.toContain('storageKey');
  });
});
