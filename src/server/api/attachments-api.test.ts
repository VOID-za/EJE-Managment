import { beforeEach, describe, expect, it } from 'vitest';
import { ApiTestClient, DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * Job attachments over the real HTTP surface: upload, retrieval, and every way
 * of trying to reach a file that is not yours.
 *
 * THE THING BEING PROVED. A storage key is not a credential and is never
 * treated as one. Authorisation happens before retrieval, against the JOB, using
 * the same visibility rule every other job read goes through — so editing the
 * URL gets somebody nowhere, and the refusal does not even confirm what exists.
 */
const PDF = new Uint8Array([
  ...new TextEncoder().encode('%PDF-1.4\n'),
  ...new TextEncoder().encode('the customer order'),
]);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

interface JobBody {
  readonly id: string;
  readonly jobNumber: string;
}

interface AttachmentList {
  readonly attachments: readonly { readonly id: string; readonly fileName: string }[];
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
  orderNumber: 'PO-77001',
  referenceNumber: '',
  faultDescription: 'Coolant pump alarming.',
  primaryTechnicianId: null,
  courierCollection: false,
  deliveryNote: '',
} as const;

describe('attaching a document to a job', () => {
  let master: ApiTestClient;
  let job: JobBody;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    job = (await master.post<JobBody>('/api/jobs', NEW_JOB)).data;
  });

  const attach = (
    client: ApiTestClient,
    jobId: string,
    name = 'customer-order.pdf',
    type = 'application/pdf',
    bytes: Uint8Array = PDF,
  ) => client.upload<AttachmentList>(`/api/jobs/${jobId}/attachments`, { name, type, bytes });

  it('uploads, and the job then carries it', async () => {
    const uploaded = await attach(master, job.id);

    expect(uploaded.status).toBe(200);
    expect(uploaded.data.attachments).toHaveLength(1);
    expect(uploaded.data.attachments[0]?.fileName).toBe('customer-order.pdf');
  });

  it('never hands the storage key back to the client', async () => {
    const uploaded = await attach(master, job.id);
    // There is no route that takes one, and no reason for a browser to hold
    // one. Leaking it would invite somebody to believe it is a way in.
    expect(JSON.stringify(uploaded.raw)).not.toContain('uploads/');
    expect(JSON.stringify(uploaded.raw)).not.toContain('storageKey');
  });

  it('keeps the metadata on the job, readable through the job', async () => {
    await attach(master, job.id);

    const view = await master.get<{
      view: { job: { attachments: readonly { fileName: string; sizeBytes: number }[] } };
    }>(`/api/jobs/${job.jobNumber}`);

    const [file] = view.data.view.job.attachments;
    expect(file?.fileName).toBe('customer-order.pdf');
    expect(file?.sizeBytes).toBe(PDF.length);
  });

  it('gives back the exact bytes that went up', async () => {
    const uploaded = await attach(master, job.id);
    const id = uploaded.data.attachments[0]?.id ?? '';

    const download = await master.download(`/api/jobs/${job.id}/attachments/${id}`);
    expect(download.status).toBe(200);
    expect(Array.from(download.bytes)).toEqual(Array.from(PDF));
  });

  it('serves it as a download, with the type the SERVER decided', async () => {
    const uploaded = await attach(master, job.id, 'order.pdf', 'text/html', PDF);
    const id = uploaded.data.attachments[0]?.id ?? '';

    const download = await master.download(`/api/jobs/${job.id}/attachments/${id}`);

    // The browser claimed text/html. The bytes are a PDF, and the bytes win —
    // otherwise an "attachment" could be made to run in this origin.
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(download.headers.get('content-disposition')).toContain('attachment;');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('cache-control')).toContain('no-store');
  });
});

describe('what the server will accept as a file', () => {
  let master: ApiTestClient;
  let jobId: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    jobId = (await master.post<JobBody>('/api/jobs', NEW_JOB)).data.id;
  });

  const attach = (name: string, type: string, bytes: Uint8Array) =>
    master.upload<AttachmentList>(`/api/jobs/${jobId}/attachments`, { name, type, bytes });

  it('accepts a PNG as well as a PDF', async () => {
    expect((await attach('plate.png', 'image/png', PNG)).status).toBe(200);
  });

  it('refuses an executable wearing a .pdf name', async () => {
    // THE CASE THE DECLARED TYPE CANNOT CATCH. Both the name and the header say
    // PDF; the first bytes say Windows executable, and those are the ones that
    // are not editable in a form.
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    const response = await attach('invoice.pdf', 'application/pdf', exe);

    expect(response.status).toBe(400);
    expect((response.error?.violations ?? []).map((v) => v.code)).toContain(
      'unsupported_file_type',
    );
  });

  it('refuses an empty file', async () => {
    expect((await attach('nothing.pdf', 'application/pdf', new Uint8Array())).status).toBe(400);
  });

  it('refuses a file beyond the size limit', async () => {
    const huge = new Uint8Array(26 * 1024 * 1024);
    huge.set(PDF, 0);
    const response = await attach('enormous.pdf', 'application/pdf', huge);

    expect(response.status).toBe(400);
    expect((response.error?.violations ?? []).map((v) => v.code)).toContain('file_too_large');
  });

  it('strips a path out of the file name rather than honouring it', async () => {
    const response = await attach('../../etc/passwd.pdf', 'application/pdf', PDF);

    expect(response.status).toBe(200);
    // The name is metadata, never a path — and it is recorded without the
    // directory somebody tried to put in it.
    expect(response.data.attachments[0]?.fileName).toBe('passwd.pdf');
  });

  it('refuses a request with no file in it', async () => {
    const response = await master.post(`/api/jobs/${jobId}/attachments`, {});
    expect(response.status).toBe(400);
  });
});

/**
 * WHO MAY REACH A FILE.
 *
 * Every refusal below is the same 404. A job that does not exist, a job this
 * actor may not read, and an attachment belonging to another job are
 * indistinguishable from outside — which is what stops the endpoint being used
 * to ask which ids are real.
 */
describe('reaching an attachment that is not yours', () => {
  let master: ApiTestClient;
  let jobId: string;
  let jobNumber: string;
  let attachmentId: string;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    const created = await master.post<JobBody>('/api/jobs', NEW_JOB);
    jobId = created.data.id;
    jobNumber = created.data.jobNumber;

    const uploaded = await master.upload<AttachmentList>(`/api/jobs/${jobId}/attachments`, {
      name: 'customer-order.pdf',
      type: 'application/pdf',
      bytes: PDF,
    });
    attachmentId = uploaded.data.attachments[0]?.id ?? '';
    expect(attachmentId).not.toBe('');
  });

  it('refuses an unauthenticated download', async () => {
    const response = await new ApiTestClient().download(
      `/api/jobs/${jobId}/attachments/${attachmentId}`,
    );
    expect(response.status).toBe(401);
  });

  it('refuses an unauthenticated upload', async () => {
    const response = await new ApiTestClient().upload(`/api/jobs/${jobId}/attachments`, {
      name: 'x.pdf',
      type: 'application/pdf',
      bytes: PDF,
    });
    expect(response.status).toBe(401);
  });

  it('refuses a technician who may not see the job', async () => {
    // The job is unassigned but this technician is not on it and it is not in
    // the pool they can reach... and either way the JOB decides, not the file.
    const master2 = await signedInAs(DEMO_USERS.master);
    const assigned = await master2.post<JobBody>('/api/jobs', {
      ...NEW_JOB,
      orderNumber: 'PO-77002',
      primaryTechnicianId: (
        await master2.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
      ).data.users.find((user) => user.email === DEMO_USERS.technician)?.id,
    });
    const file = await master2.upload<AttachmentList>(
      `/api/jobs/${assigned.data.id}/attachments`,
      { name: 'private.pdf', type: 'application/pdf', bytes: PDF },
    );

    const other = await signedInAs(DEMO_USERS.otherTechnician);
    const response = await other.download(
      `/api/jobs/${assigned.data.id}/attachments/${file.data.attachments[0]?.id ?? ''}`,
    );

    expect(response.status).toBe(404);
    expect(response.bytes.length).toBeLessThan(200);
  });

  it('refuses an attachment id moved onto a different job', async () => {
    // A REAL attachment id, and a REAL job — and they are not related. The job
    // is the authority: the attachment must be on the job in the URL.
    const second = await master.post<JobBody>('/api/jobs', {
      ...NEW_JOB,
      orderNumber: 'PO-77003',
    });

    const response = await master.download(
      `/api/jobs/${second.data.id}/attachments/${attachmentId}`,
    );
    expect(response.status).toBe(404);
  });

  it('refuses a guessed attachment id on a job the actor may read', async () => {
    const response = await master.download(
      `/api/jobs/${jobId}/attachments/att-0000000000000000`,
    );
    expect(response.status).toBe(404);
  });

  it('refuses an upload onto a job the actor may not see', async () => {
    const master2 = await signedInAs(DEMO_USERS.master);
    const assigned = await master2.post<JobBody>('/api/jobs', {
      ...NEW_JOB,
      orderNumber: 'PO-77004',
      primaryTechnicianId: (
        await master2.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
      ).data.users.find((user) => user.email === DEMO_USERS.technician)?.id,
    });

    const other = await signedInAs(DEMO_USERS.otherTechnician);
    const response = await other.upload(`/api/jobs/${assigned.data.id}/attachments`, {
      name: 'pushed.pdf',
      type: 'application/pdf',
      bytes: PDF,
    });

    expect(response.status).toBe(404);
  });

  it('refuses a cross-site upload', async () => {
    const response = await master.upload(
      `/api/jobs/${jobId}/attachments`,
      { name: 'x.pdf', type: 'application/pdf', bytes: PDF },
      { crossSite: true },
    );
    expect(response.status).toBe(403);
  });

  it('lets the assigned technician read the job’s attachment', async () => {
    // The other half of the rule: somebody who MAY see the job may read what is
    // attached to it, because that is what it is there for.
    const admin = await master.get<{ users: readonly { id: string; email: string }[] }>(
      '/api/admin',
    );
    const siphoId = admin.data.users.find((u) => u.email === DEMO_USERS.technician)?.id ?? '';
    await master.post(`/api/jobs/${jobId}/assign_primary`, { technicianId: siphoId });

    const sipho = await signedInAs(DEMO_USERS.technician);
    const response = await sipho.download(`/api/jobs/${jobNumber}/attachments/${attachmentId}`);

    expect(response.status).toBe(200);
    expect(Array.from(response.bytes)).toEqual(Array.from(PDF));
  });
});
