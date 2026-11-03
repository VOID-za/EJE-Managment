import { beforeEach, describe, expect, it } from 'vitest';
import type { ApiTestClient } from '@/test/api-harness';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * TR-REF-PHOTO-1 and DN-SITE-OPT-1 over HTTP (3 November 2026): the office's
 * delivery-note photo through its own route (bytes sniffed, internal, office
 * only, Test & Repair only), and a Delivery Note raised without a site.
 */
const jpeg = (label: string): Uint8Array => {
  const text = new TextEncoder().encode(label);
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xfe, 0x00, text.length + 2, ...text, 0xff, 0xd9]);
};
const PDF = new Uint8Array([...new TextEncoder().encode('%PDF-1.4\n'), ...new TextEncoder().encode('not a photograph')]);

const BASE = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  machineId: null,
  priority: null,
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: '',
  referenceNumber: '',
  faultDescription: '',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

interface JobBody { readonly id: string; readonly jobNumber: string; readonly siteId: string | null }

describe('the Test & Repair delivery-note photo, over HTTP', () => {
  let office: ApiTestClient;
  let tech: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    office = await signedInAs(DEMO_USERS.coordinator);
    tech = await signedInAs(DEMO_USERS.technician);
    const created = await office.post<JobBody>('/api/jobs', { ...BASE, jobType: 'test_and_repair' });
    expect(created.status, JSON.stringify(created.error)).toBe(200);
    job = created.data;
  });

  const send = (client: ApiTestClient, file: { name: string; type: string; bytes: Uint8Array }, jobId = job.id) =>
    client.upload<{ id: string; visibility: string; purpose: string }>(`/api/jobs/${jobId}/reference-photo`, file);

  it('the office uploads it: stored INTERNAL and marked as the delivery-note reference, readable through the job', async () => {
    const sent = await send(office, { name: 'delivery-note.jpg', type: 'image/jpeg', bytes: jpeg('dn') });
    expect(sent.status, JSON.stringify(sent.error)).toBe(200);
    expect(sent.data).toMatchObject({ visibility: 'internal', purpose: 'delivery_note_reference' });
    expect(JSON.stringify(sent.data)).not.toContain('storage');
    const view = await office.get<{ view: { job: { photos: readonly { id: string; purpose?: string; visibility: string }[] } } }>(`/api/jobs/${job.jobNumber}`);
    expect(view.data.view.job.photos.find((photo) => photo.id === sent.data.id)).toMatchObject({ purpose: 'delivery_note_reference', visibility: 'internal' });
    const file = await office.get(`/api/jobs/${job.id}/media/${sent.data.id}`);
    expect(file.status).toBe(200);
  });

  it('refuses what is not a photograph, on its bytes — a PDF named .jpg', async () => {
    const sent = await send(office, { name: 'disguised.jpg', type: 'image/jpeg', bytes: PDF });
    expect(sent.status).toBeGreaterThanOrEqual(400);
    expect(sent.status).toBeLessThan(500);
  });

  it('refuses a file over the size limit (file_too_large)', async () => {
    const big = new Uint8Array(26 * 1024 * 1024);
    big.set(jpeg('big'));
    const sent = await send(office, { name: 'huge.jpg', type: 'image/jpeg', bytes: big });
    expect(sent.status).toBe(400);
    expect(JSON.stringify(sent.error)).toContain('file_too_large');
  });

  it('a technician does not add it; a breakdown takes none', async () => {
    const byTech = await send(tech, { name: 'x.jpg', type: 'image/jpeg', bytes: jpeg('x') });
    expect([403, 404, 422]).toContain(byTech.status);
    const breakdown = (await office.post<JobBody>('/api/jobs', { ...BASE, jobType: 'breakdown', faultDescription: 'Spindle fault.' })).data;
    const onBreakdown = await send(office, { name: 'x.jpg', type: 'image/jpeg', bytes: jpeg('x') }, breakdown.id);
    expect(onBreakdown.status).toBe(422);
  });
});

describe('a Delivery Note without a site, over HTTP', () => {
  it('is raised with no site; any other job type is refused without one', async () => {
    startTestServer();
    const office = await signedInAs(DEMO_USERS.coordinator);
    const note = await office.post<JobBody>('/api/jobs', { ...BASE, siteId: null, jobType: 'delivery_note', deliveryDate: '2026-11-03', orderNumber: 'PO-IGNORED' });
    expect(note.status, JSON.stringify(note.error)).toBe(200);
    expect(note.data.siteId).toBeNull();
    const view = await office.get<{ view: { siteRecorded: boolean; job: { orderNumber: string } } }>(`/api/jobs/${note.data.jobNumber}`);
    expect(view.status).toBe(200);
    expect(view.data.view.siteRecorded).toBe(false);
    expect(view.data.view.job.orderNumber).toBe('');
    const breakdown = await office.post('/api/jobs', { ...BASE, siteId: null, jobType: 'breakdown', faultDescription: 'Fault.' });
    expect(breakdown.status).toBe(422);
  });
});
