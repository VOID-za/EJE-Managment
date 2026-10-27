import { beforeEach, describe, expect, it } from 'vitest';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * VIDEO IS NOT ACCEPTED. VIDEO-OFF-1, the owner's instruction of 27 October
 * 2026: photos and documents are the job's media; video is not used and is
 * removed from the supported workflow — refused at the API boundary, not only
 * hidden in the browser. (MEDIA-5's video capture is superseded.)
 *
 * Every way a video could arrive is tried here, and each is refused with
 * nothing stored: as a video, as a photograph, and as a job document.
 * Videos ALREADY on a job are kept; that is proved in the application tests,
 * where a historical video can be seeded.
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
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x00, 0x01, 0xff, 0xd9]);

interface MediaList {
  readonly photos: readonly { readonly id: string }[];
  readonly videos?: readonly { readonly id: string }[];
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

describe('VIDEO-OFF-1: a video is refused on every path', () => {
  let master: ApiTestClient;
  let sipho: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const siphoId = await technicianId(master, DEMO_USERS.technician);
    job = (await master.post<JobBody>('/api/jobs', { ...NEW_JOB, primaryTechnicianId: siphoId })).data;
    sipho = await signedInAs(DEMO_USERS.technician);
    expect((await sipho.post(`/api/jobs/${job.id}/accept`)).status).toBe(200);
  });

  const videosOnJob = async (): Promise<number> =>
    (
      await master.get<{ view: { job: { videos: readonly unknown[] } } }>(`/api/jobs/${job.jobNumber}`)
    ).data.view.job.videos.length;

  it.each([
    ['an MP4', 'spindle.mp4', 'video/mp4', MP4()],
    ['a MOV', 'clip.mov', 'video/quicktime', MOV],
    ['a WebM', 'recording.webm', 'video/webm', WEBM],
  ])('refuses %s sent as a video', async (_label, name, type, bytes) => {
    const response = await sipho.upload<MediaList>(`/api/jobs/${job.id}/media`, {
      name,
      type,
      bytes,
      fields: { kind: 'video' },
    });
    expect(response.status).toBe(400);
    expect((response.error?.violations ?? []).map((violation) => violation.code)).toContain('video_not_supported');
    expect(await videosOnJob()).toBe(0);
  });

  it('refuses an MP4 sent as a photograph — the bytes decide', async () => {
    const response = await sipho.upload<MediaList>(`/api/jobs/${job.id}/media`, {
      name: 'fault.jpg',
      type: 'image/jpeg',
      bytes: MP4(),
    });
    expect(response.status).toBe(400);
    expect((response.error?.violations ?? []).map((violation) => violation.code)).toContain('unsupported_file_type');
    expect(await videosOnJob()).toBe(0);
  });

  it('refuses a video sent as a job document', async () => {
    const response = await master.upload(`/api/jobs/${job.id}/attachments`, {
      name: 'noise.mp4',
      type: 'video/mp4',
      bytes: MP4(),
    });
    expect(response.status).toBe(400);
    expect((response.error?.violations ?? []).map((violation) => violation.code)).toContain('unsupported_file_type');
  });

  it('still takes a photograph', async () => {
    const response = await sipho.upload<MediaList>(`/api/jobs/${job.id}/media`, {
      name: 'nameplate.jpg',
      type: 'image/jpeg',
      bytes: JPEG,
    });
    expect(response.status).toBe(200);
    expect(response.data.photos).toHaveLength(1);
  });
});
