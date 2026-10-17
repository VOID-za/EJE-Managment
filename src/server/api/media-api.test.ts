import { beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * CAPTURING A PHOTOGRAPH, OVER THE REAL HTTP SURFACE. PWA-3, CR-09 Phase 3.
 *
 * WHAT THESE TESTS EXIST TO STOP COMING BACK. Until this route existed, a
 * photograph was a JSON body: a file name the browser invented and a size it
 * made up, recorded against the job with `storage.put(…, null)` behind it. The
 * job card then cited photographic evidence of work that had never been stored
 * anywhere. Every test below is about the same single property — THE BYTES ARE
 * REAL AND THEY ARE THE ONES THAT WENT UP — approached from a different angle:
 * the round trip, the sniffing, the refusals, and who may read one back.
 */
const jpeg = (label: string): Uint8Array => {
  const text = new TextEncoder().encode(label);
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xfe, 0x00, text.length + 2, ...text,
    0xff, 0xd9,
  ]);
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const PDF = new Uint8Array([
  ...new TextEncoder().encode('%PDF-1.4\n'),
  ...new TextEncoder().encode('a customer order, which is not a photograph'),
]);

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
}

interface PhotoList {
  readonly photos: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly caption: string;
    readonly visibility: string;
    readonly sizeBytes: number;
  }[];
}

const NEW_JOB = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: 'machine-abc-lv40',
  jobType: 'breakdown',
  priority: 'urgent',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: 'PO-88001',
  referenceNumber: '',
  faultDescription: 'Contactor burnt out.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

const technicianId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('capturing a photograph on a job', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const siphoId = await technicianId(master, DEMO_USERS.technician);
    job = (
      await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId })
    ).data;
    sipho = await signedInAs(DEMO_USERS.technician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
  });

  const capture = (
    client: ApiTestClient,
    options: {
      name?: string;
      type?: string;
      bytes?: Uint8Array;
      fields?: Record<string, string>;
      jobId?: string;
    } = {},
  ) =>
    client.upload<PhotoList>(`/api/jobs/${options.jobId ?? job.id}/media`, {
      name: options.name ?? 'contactor.jpg',
      type: options.type ?? 'image/jpeg',
      bytes: options.bytes ?? jpeg('contactor'),
      ...(options.fields === undefined ? {} : { fields: options.fields }),
    });

  it('records the photograph on the job', async () => {
    const uploaded = await capture(sipho, { fields: { caption: 'Burnt contactor' } });

    expect(uploaded.status).toBe(200);
    expect(uploaded.data.photos).toHaveLength(1);
    expect(uploaded.data.photos[0]?.fileName).toBe('contactor.jpg');
    expect(uploaded.data.photos[0]?.caption).toBe('Burnt contactor');
  });

  it('measures the size off the bytes rather than believing the client', async () => {
    const bytes = jpeg('a slightly longer label, for a different length');
    const uploaded = await capture(sipho, { bytes });

    // The old path took `sizeBytes` from the request and the tile said 2.1 MB
    // over a file that did not exist.
    expect(uploaded.data.photos[0]?.sizeBytes).toBe(bytes.length);
  });

  it('gives back the exact bytes that went up', async () => {
    const bytes = jpeg('the one and only frame');
    const uploaded = await capture(sipho, { bytes });
    const id = uploaded.data.photos[0]?.id ?? '';

    const download = await sipho.download(`/api/jobs/${job.id}/media/${id}`);

    expect(download.status).toBe(200);
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
  });

  it('serves it inline, as the type the SERVER sniffed, and never from a cache', async () => {
    const uploaded = await capture(sipho, { name: 'plate.png', type: 'text/html', bytes: PNG });
    const id = uploaded.data.photos[0]?.id ?? '';

    const download = await sipho.download(`/api/jobs/${job.id}/media/${id}`);

    // The browser claimed text/html. The bytes are a PNG and the bytes win.
    expect(download.headers.get('content-type')).toBe('image/png');
    // Inline, because a thumbnail has to render — safe only because the type
    // is a sniffed raster image and the response is sandboxed.
    expect(download.headers.get('content-disposition')).toContain('inline;');
    expect(download.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('cache-control')).toContain('no-store');
  });

  it('never hands the storage key back to the client', async () => {
    const uploaded = await capture(sipho);
    expect(JSON.stringify(uploaded.raw)).not.toContain('uploads/');
    expect(JSON.stringify(uploaded.raw)).not.toContain('storageKey');
  });

  it('carries the classification decided at capture. MEDIA-1', async () => {
    const uploaded = await capture(sipho, {
      fields: { caption: 'Leaking roof above the cabinet', visibility: 'internal' },
    });
    expect(uploaded.data.photos[0]?.visibility).toBe('internal');
  });

  it('defaults to customer-facing when nothing is said. MEDIA-1', async () => {
    const uploaded = await capture(sipho);
    expect(uploaded.data.photos[0]?.visibility).toBe('customer_facing');
  });

  it('refuses a classification that is not one of the two', async () => {
    const response = await capture(sipho, { fields: { visibility: 'customer_only' } });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.raw)).not.toContain('customer_only');
  });

  it('is visible on the job afterwards, with its real size', async () => {
    const bytes = jpeg('on the job');
    await capture(sipho, { bytes, fields: { caption: 'Nameplate' } });

    const view = await sipho.get<{
      view: { job: { photos: readonly { caption: string; sizeBytes: number }[] } };
    }>(`/api/jobs/${job.jobNumber}`);

    expect(view.data.view.job.photos[0]?.caption).toBe('Nameplate');
    expect(view.data.view.job.photos[0]?.sizeBytes).toBe(bytes.length);
  });

  it('attaches a second photograph rather than replaying the first', async () => {
    // Deliberately NOT idempotent: two taps are two photographs, which is what
    // the technician asked for both times.
    await capture(sipho, { bytes: jpeg('one') });
    const second = await capture(sipho, { bytes: jpeg('two') });
    expect(second.data.photos).toHaveLength(2);
  });

  /* -- what is not a photograph -------------------------------------------- */

  it('refuses a PDF, which belongs under Documents', async () => {
    const response = await capture(sipho, {
      name: 'order.pdf',
      type: 'application/pdf',
      bytes: PDF,
    });
    expect(response.status).toBe(400);
    expect((response.error?.violations ?? []).map((violation) => violation.code)).toContain(
      'unsupported_file_type',
    );
  });

  it('refuses a file whose bytes are not an image at all', async () => {
    const response = await capture(sipho, {
      name: 'photo.jpg',
      type: 'image/jpeg',
      bytes: new TextEncoder().encode('MZ\u0000\u0000 this is an executable'),
    });
    expect(response.status).toBe(400);
  });

  it('refuses an empty file', async () => {
    const response = await capture(sipho, { bytes: new Uint8Array() });
    expect(response.status).toBe(400);
  });

  it('refuses a request with no file at all', async () => {
    const response = await sipho.post(`/api/jobs/${job.id}/media`, {});
    expect(response.status).toBe(400);
  });

  /* -- who may ------------------------------------------------------------- */

  it('refuses an unauthenticated capture', async () => {
    const response = await new ApiTestClient().upload(`/api/jobs/${job.id}/media`, {
      name: 'x.jpg',
      type: 'image/jpeg',
      bytes: jpeg('x'),
    });
    expect(response.status).toBe(401);
  });

  it('refuses an unauthenticated read', async () => {
    const uploaded = await capture(sipho);
    const response = await new ApiTestClient().download(
      `/api/jobs/${job.id}/media/${uploaded.data.photos[0]?.id ?? ''}`,
    );
    expect(response.status).toBe(401);
  });

  it('refuses a technician who may not see the job — 404, not 403', async () => {
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);
    const response = await riaan.upload(`/api/jobs/${job.id}/media`, {
      name: 'x.jpg',
      type: 'image/jpeg',
      bytes: jpeg('x'),
    });
    // A job he may not see does not exist as far as he is concerned.
    expect(response.status).toBe(404);
  });

  it('refuses reading a photograph on a job the actor may not see', async () => {
    const uploaded = await capture(sipho);
    const riaan = await signedInAs(DEMO_USERS.otherTechnician);

    const response = await riaan.download(
      `/api/jobs/${job.id}/media/${uploaded.data.photos[0]?.id ?? ''}`,
    );
    expect(response.status).toBe(404);
    expect(response.bytes.length).toBeLessThan(200);
  });

  it('refuses a media id moved onto a different job', async () => {
    const uploaded = await capture(sipho);
    const second = await master.post<JobBody>('/api/jobs', {
      ...NEW_JOB,
      orderNumber: 'PO-88002',
    });

    // A REAL media id and a REAL job, and they are not related. The job is the
    // authority: the photograph must be on the job in the URL.
    const response = await master.download(
      `/api/jobs/${second.data.id}/media/${uploaded.data.photos[0]?.id ?? ''}`,
    );
    expect(response.status).toBe(404);
  });

  it('refuses a guessed media id on a job the actor may read', async () => {
    const response = await sipho.download(`/api/jobs/${job.id}/media/att-0001`);
    expect(response.status).toBe(404);
  });

  it('refuses a DOCUMENT id read through the media route', async () => {
    // The two collections are separate on purpose, and an id from one is not a
    // key to the other.
    const attached = await master.upload<{
      attachments: readonly { id: string }[];
    }>(`/api/jobs/${job.id}/attachments`, {
      name: 'order.pdf',
      type: 'application/pdf',
      bytes: PDF,
    });

    const response = await sipho.download(
      `/api/jobs/${job.id}/media/${attached.data.attachments[0]?.id ?? ''}`,
    );
    expect(response.status).toBe(404);
  });
});
