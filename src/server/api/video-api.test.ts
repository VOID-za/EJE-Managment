import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';
import { MAX_VIDEO_BYTES } from '@/server/api/uploads';

/**
 * CAPTURING A VIDEO ON A JOB, OVER THE REAL HTTP SURFACE. MEDIA-5.
 *
 * WHAT WAS THERE BEFORE: nothing, and honestly nothing. The panel said *"Video
 * capture is not available yet"* rather than offering a button that did
 * something else, and `job.videos` existed in the domain with no way to put
 * anything in it. The decision that blocked it was never about the upload — it
 * was about what a customer receives, and that part is still EJE's to answer
 * and still unanswered here.
 *
 * SO WHAT THESE TESTS PIN is the half that is engineering: a video is carried,
 * sniffed, stored, authorised and read back exactly like a photograph, with its
 * own size limit — and NOTHING about it reaches the customer's job card, which
 * is the part a decision would change.
 *
 * `kind` PICKS THE RULE; THE BYTES DECIDE THE FACT. Both wrong-way-round cases
 * are below, because a field the client controls must not be able to assert
 * what a file is.
 */

/** An ISO base media header: box length, `ftyp`, then the brand. */
const iso = (brand: string, label = ''): Uint8Array => {
  const text = new TextEncoder().encode(label);
  return new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x18,
    0x66,
    0x74,
    0x79,
    0x70,
    ...[...brand].map((character) => character.charCodeAt(0)),
    ...text,
  ]);
};

const MP4 = (label = 'spindle noise'): Uint8Array => iso('isom', label);
const MOV = iso('qt  ', 'an iPhone clip');
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
const HEIC = iso('heic', 'a still photograph in a video container');
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x01, 0xff, 0xd9]);

interface MediaList {
  readonly photos: readonly { readonly id: string; readonly sizeBytes: number }[];
  readonly videos: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly caption: string;
    readonly visibility: string;
    readonly sizeBytes: number;
  }[];
}

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
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
  orderNumber: 'PO-88002',
  referenceNumber: '',
  faultDescription: 'Intermittent noise from the spindle.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

const technicianId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

describe('capturing a video on a job', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const siphoId = await technicianId(master, DEMO_USERS.technician);
    job = (await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId }))
      .data;
    sipho = await signedInAs(DEMO_USERS.technician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
  });

  const record = (
    client: ApiTestClient,
    options: {
      name?: string;
      type?: string;
      bytes?: Uint8Array;
      fields?: Record<string, string>;
      jobId?: string;
    } = {},
  ) =>
    client.upload<MediaList>(`/api/jobs/${options.jobId ?? job.id}/media`, {
      name: options.name ?? 'spindle.mp4',
      type: options.type ?? 'video/mp4',
      bytes: options.bytes ?? MP4(),
      fields: { kind: 'video', ...(options.fields ?? {}) },
    });

  it('records the video on the job, in its own list', async () => {
    const uploaded = await record(sipho, { fields: { caption: 'Noise at 1 200 rpm' } });

    expect(uploaded.status, JSON.stringify(uploaded.error)).toBe(200);
    expect(uploaded.data.videos).toHaveLength(1);
    expect(uploaded.data.videos[0]?.fileName).toBe('spindle.mp4');
    expect(uploaded.data.videos[0]?.caption).toBe('Noise at 1 200 rpm');
    // Not among the photographs, which is what the job card reads from.
    expect(uploaded.data.photos).toHaveLength(0);
  });

  it('measures the size off the bytes', async () => {
    const bytes = MP4('a rather longer label, for a different length');
    const uploaded = await record(sipho, { bytes });

    expect(uploaded.data.videos[0]?.sizeBytes).toBe(bytes.length);
  });

  it('gives back the exact bytes that went up', async () => {
    const bytes = MP4('the one and only clip');
    const uploaded = await record(sipho, { bytes });
    const id = uploaded.data.videos[0]?.id ?? '';

    const download = await sipho.download(`/api/jobs/${job.id}/media/${id}`);

    expect(download.status).toBe(200);
    expect(Array.from(download.bytes)).toEqual(Array.from(bytes));
  });

  it('serves it as the type the SERVER sniffed, sandboxed and never cached', async () => {
    const uploaded = await record(sipho, { name: 'clip.mov', type: 'text/html', bytes: MOV });
    const id = uploaded.data.videos[0]?.id ?? '';

    const download = await sipho.download(`/api/jobs/${job.id}/media/${id}`);

    // The browser claimed text/html. The bytes are a QuickTime file.
    expect(download.headers.get('content-type')).toBe('video/quicktime');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-security-policy')).toContain('sandbox');
    expect(download.headers.get('cache-control')).toContain('no-store');
    // Said rather than left to be inferred from a 200 that ignored a Range.
    expect(download.headers.get('accept-ranges')).toBe('none');
  });

  it('accepts a WebM, which is what a browser recorder writes', async () => {
    const uploaded = await record(sipho, { name: 'clip.webm', bytes: WEBM });
    expect(uploaded.status).toBe(200);
  });

  it('REFUSES a still photograph in a video container', async () => {
    // `ftyp` alone would have taken this and listed an HEIC as a video: a tile
    // with a play button that plays nothing.
    const refused = await record(sipho, { name: 'photo.heic', bytes: HEIC });
    expect(refused.status).toBe(400);
    expect(refused.error?.violations?.[0]?.code).toBe('unsupported_file_type');
  });

  it('REFUSES a JPEG sent as a video', async () => {
    const refused = await record(sipho, { name: 'clip.mp4', bytes: JPEG });
    expect(refused.status).toBe(400);
  });

  it('REFUSES an MP4 sent as a photograph', async () => {
    const refused = await sipho.upload<MediaList>(`/api/jobs/${job.id}/media`, {
      name: 'contactor.jpg',
      type: 'image/jpeg',
      bytes: MP4(),
      fields: { kind: 'photo' },
    });
    expect(refused.status).toBe(400);
  });

  it('REFUSES an MP4 on the document path', async () => {
    // A video is not a customer's order, and the document route's list is what
    // says so now that the sniffer recognises both.
    const refused = await sipho.upload(`/api/jobs/${job.id}/attachments`, {
      name: 'order.pdf',
      type: 'application/pdf',
      bytes: MP4(),
    });
    expect(refused.status).toBe(400);
  });

  it('REFUSES a clip past the video limit, before reading the body', async () => {
    const tooBig = new Uint8Array(MAX_VIDEO_BYTES + 1024);
    tooBig.set(MP4(), 0);
    const refused = await record(sipho, { bytes: tooBig });

    expect(refused.status).toBe(400);
    expect(refused.error?.violations?.[0]?.code).toBe('file_too_large');
  });

  /*
   * A CLIP LARGER THAN THE DOCUMENT LIMIT IS PROVED ELSEWHERE, deliberately.
   * `video-persistence.db.test.ts` sends 26 MB through the real filesystem
   * adapter, where a 26 MB write costs milliseconds. The demonstration store
   * keeps bytes as base64 in a snapshot, and base64-ing 26 MB in a test
   * process takes the better part of twenty seconds — a true test of nothing
   * except how the demonstration store holds bytes, paid for on every run.
   */

  it('is filed for the office, whatever the request asks for', async () => {
    /*
     * The panel does not offer the choice, and the server does not take it on
     * trust either: a request that asks for `customer_facing` gets internal.
     * The customer's job card is a PDF and cannot carry a video, so the other
     * answer would be a promise nobody can keep — and which answer is right is
     * EJE's to give. See docs/SCOPE.md, MEDIA-5.
     */
    const uploaded = await record(sipho, { fields: { visibility: 'customer_facing' } });
    expect(uploaded.data.videos[0]?.visibility).toBe('internal');
  });
});

describe('who may capture and read a video', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;
  let other: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const siphoId = await technicianId(master, DEMO_USERS.technician);
    job = (await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId }))
      .data;
    sipho = await signedInAs(DEMO_USERS.technician);
    other = await signedInAs(DEMO_USERS.otherTechnician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
  });

  it('refuses a technician who is not on the job, as not found', async () => {
    const refused = await other.upload(`/api/jobs/${job.id}/media`, {
      name: 'clip.mp4',
      type: 'video/mp4',
      bytes: MP4(),
      fields: { kind: 'video' },
    });

    // 404 and not 403: a job that is not theirs and a job that does not exist
    // must be indistinguishable from outside.
    expect(refused.status).toBe(404);
  });

  it('refuses another technician reading one back', async () => {
    const uploaded = await sipho.upload<MediaList>(`/api/jobs/${job.id}/media`, {
      name: 'clip.mp4',
      type: 'video/mp4',
      bytes: MP4(),
      fields: { kind: 'video' },
    });
    const id = uploaded.data.videos[0]?.id ?? '';

    const refused = await other.download(`/api/jobs/${job.id}/media/${id}`);
    expect(refused.status).toBe(404);
  });

  it('lets the office read one back', async () => {
    const uploaded = await sipho.upload<MediaList>(`/api/jobs/${job.id}/media`, {
      name: 'clip.mp4',
      type: 'video/mp4',
      bytes: MP4(),
      fields: { kind: 'video' },
    });
    const id = uploaded.data.videos[0]?.id ?? '';

    const read = await master.download(`/api/jobs/${job.id}/media/${id}`);
    expect(read.status).toBe(200);
  });
});
