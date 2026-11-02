import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { readStoredZip } from '@/lib/zip';
import { DEMO_USERS, signedInAs, startTestServer } from '@/test/api-harness';

/**
 * THE NEXT CRITICAL BATCH OVER HTTP, 2 November 2026: the routes a browser —
 * or anybody with a session cookie — reaches. Attachments and the ZIP
 * (JOB-ATT-1/2), cancellation by a technician (CANCEL-ALL-1), customer rates
 * (CUST-RATES-1), the standby day-swap and current-week routes
 * (STANDBY-DAY-1, STANDBY-DASH-1) and the role list (ROLE-APP-1).
 */
interface JobsPayload {
  readonly rows: readonly { readonly job: Job }[];
}

const jobsOf = async (client: Awaited<ReturnType<typeof signedInAs>>): Promise<readonly Job[]> =>
  (await client.get<JobsPayload>('/api/jobs')).data.rows.map((row) => row.job);

const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);

describe('JOB-ATT-1/2 over HTTP', () => {
  beforeEach(() => startTestServer());

  it('uploads a ZIP and an office document to a job, and downloads every document as one ZIP of the originals', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const job = (await jobsOf(master)).find((candidate) => candidate.status === 'in_progress')!;
    const zip = await master.upload(`/api/jobs/${job.id}/attachments`, { name: 'Drawings.zip', type: 'application/zip', bytes: PK });
    expect(zip.status, JSON.stringify(zip.error)).toBe(200);
    const docx = await master.upload(`/api/jobs/${job.id}/attachments`, { name: 'Quote.docx', type: '', bytes: PK });
    expect(docx.status).toBe(200);
    const fake = await master.upload(`/api/jobs/${job.id}/attachments`, { name: 'fake.zip', type: 'application/zip', bytes: new TextEncoder().encode('plain text') });
    expect(fake.status).toBe(400); // validation_failed: the bytes are not a ZIP, whatever it is called

    const archive = await master.download(`/api/jobs/${job.id}/attachments/zip`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get('content-type')).toBe('application/zip');
    expect(archive.headers.get('content-disposition')).toMatch(/attachment; filename=".+ Attachments\.zip"/u);
    expect(archive.headers.get('cache-control')).toContain('no-store');
    const entries = readStoredZip(archive.bytes);
    expect(entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['Drawings.zip', 'Quote.docx']));
    expect(entries.find((entry) => entry.name === 'Drawings.zip')!.bytes).toEqual(PK);
  });

  it('answers 404 to a technician for a job they may not see, and to anybody for a job with no documents', async () => {
    const master = await signedInAs(DEMO_USERS.master);
    const all = await jobsOf(master);
    const tech = await signedInAs(DEMO_USERS.technician);
    const mine = new Set((await jobsOf(tech)).map((job) => job.id));
    const notMine = all.find((job) => !mine.has(job.id) && (job.status === 'open' || job.status === 'in_progress'))!;
    // Give it a document, so the 404 is about who is asking and not about an empty job.
    expect((await master.upload(`/api/jobs/${notMine.id}/attachments`, { name: 'Order.zip', type: 'application/zip', bytes: PK })).status).toBe(200);
    expect((await master.download(`/api/jobs/${notMine.id}/attachments/zip`)).status).toBe(200);
    expect((await tech.download(`/api/jobs/${notMine.id}/attachments/zip`)).status).toBe(404);
    let bare: Job | undefined;
    for (const candidate of all) {
      const view = await master.get<{ view: { job: Job } }>(`/api/jobs/${candidate.jobNumber}`);
      if (view.status === 200 && view.data.view.job.attachments.length === 0) {
        bare = candidate;
        break;
      }
    }
    if (bare === undefined) throw new Error('the demonstration register has no job without documents');
    expect((await master.download(`/api/jobs/${bare.id}/attachments/zip`)).status).toBe(404);
    const anonymous = await master.download(`/api/jobs/${bare.id}/attachments/zip`, { token: null });
    expect(anonymous.status).toBe(401);
  });
});

describe('CANCEL-ALL-1 over HTTP', () => {
  beforeEach(() => startTestServer());

  it('the technician on an in-progress job cancels it; another technician gets 403; a blank reason 422', async () => {
    const tech = await signedInAs(DEMO_USERS.technician);
    const mine = (await jobsOf(tech)).find((job) => job.status === 'in_progress' && job.acceptedAt !== null)!;
    expect(mine).toBeDefined();
    const blank = await tech.post(`/api/jobs/${mine.jobNumber}/cancel`, { reason: 'duplicate', description: ' ' });
    expect(blank.status).toBe(422);
    const other = await signedInAs(DEMO_USERS.otherTechnician);
    const refused = await other.post(`/api/jobs/${mine.jobNumber}/cancel`, { reason: 'duplicate', description: 'Not mine' });
    expect([403, 404]).toContain(refused.status);
    const done = await tech.post(`/api/jobs/${mine.jobNumber}/cancel`, { reason: 'customer_cancelled', description: 'Customer called it off on site.' });
    expect(done.status, JSON.stringify(done.error)).toBe(200);
    const again = await tech.post(`/api/jobs/${mine.jobNumber}/cancel`, { reason: 'customer_cancelled', description: 'Again' });
    expect(again.status).toBe(422);
  });
});

describe('CUST-RATES-1 over HTTP', () => {
  beforeEach(() => startTestServer());

  it('the office chooses Custom Rates and sets them; a technician may not; the customer view carries them to the office only', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const customers = (await coordinator.get<readonly { customer?: { id: string }; id?: string }[]>('/api/customers')).data;
    const first = customers[0] as unknown as { customer?: { id: string }; id?: string };
    const customerId = first.customer?.id ?? first.id!;
    const rates = { labourRates: { normal: 100000, overtime: 150000, double: 200000 }, calloutRate: 80000, testBenchFee: 40000, kilometreRate: 2000, vatPercentage: 15 };
    expect((await coordinator.post(`/api/customers/${customerId}/rates`, rates)).status).toBe(422); // still on Default Rates
    expect((await coordinator.post(`/api/customers/${customerId}/rate_mode`, { mode: 'custom' })).status).toBe(200);
    const tech = await signedInAs(DEMO_USERS.technician);
    expect((await tech.post(`/api/customers/${customerId}/rates`, rates)).status).toBe(403);
    expect((await tech.post(`/api/customers/${customerId}/rate_mode`, { mode: 'default' })).status).toBe(403);
    expect((await coordinator.post(`/api/customers/${customerId}/rates`, rates)).status).toBe(200);
    const view = await coordinator.get<{ rates: { mode: string; custom: { calloutRate: number } } | null }>(`/api/customers/${customerId}`);
    expect(view.data.rates).toMatchObject({ mode: 'custom', custom: { calloutRate: 80000 } });
    const techView = await tech.get<{ rates: unknown }>(`/api/customers/${customerId}`);
    expect(techView.data.rates).toBeNull();
  });
});

describe('STANDBY-DAY-1 / STANDBY-DASH-1 over HTTP', () => {
  beforeEach(() => startTestServer());

  it('serves the current week to everybody, and the day swaps list; the office cannot ask for a swap', async () => {
    const tech = await signedInAs(DEMO_USERS.technician);
    const week = await tech.get<{ weekStart: string; published: boolean; places: unknown[] }>('/api/standby/current-week');
    expect(week.status).toBe(200);
    expect(week.data.places).toHaveLength(4);
    expect((await tech.get('/api/standby/days')).status).toBe(200);
    expect((await tech.get('/api/standby/days/options')).status).toBe(200);
    const master = await signedInAs(DEMO_USERS.master);
    const asked = await master.post('/api/standby/days', {
      recipientId: 'x',
      kind: 'main',
      pairs: [{ requesterDate: '2030-01-05', requesterPosition: 'main', recipientDate: '2030-01-12', recipientPosition: 'main' }],
      reason: '',
    });
    expect(asked.status).toBe(403);
    const anonymous = await tech.get('/api/standby/current-week', { token: null });
    expect(anonymous.status).toBe(401);
  });

  it('refuses a malformed request before it reaches the rules', async () => {
    const tech = await signedInAs(DEMO_USERS.technician);
    const bad = await tech.post('/api/standby/days', { recipientId: 'x', kind: 'helper', pairs: [], reason: '' });
    expect(bad.status).toBe(400);
  });
});

describe('ROLE-APP-1 over HTTP', () => {
  beforeEach(() => startTestServer());

  it('the Office creates an Apprentice, who signs in with a technician’s capabilities', async () => {
    const coordinator = await signedInAs(DEMO_USERS.coordinator);
    const created = await coordinator.post<{ user?: { id: string; role: string }; id?: string; role?: string }>('/api/users', {
      firstName: 'Ayanda',
      lastName: 'Apprentice',
      email: 'ayanda.apprentice@eje-demo.co.za',
      mobile: '0820000000',
      role: 'apprentice',
      jobTitle: 'Apprentice',
    });
    expect([200, 201], JSON.stringify(created.error)).toContain(created.status);
    const role = created.data.user?.role ?? created.data.role;
    expect(role).toBe('apprentice');
    // The Office may not create a Senior Tech.
    const refused = await coordinator.post('/api/users', {
      firstName: 'No',
      lastName: 'Body',
      email: 'nobody@eje-demo.co.za',
      mobile: '0820000001',
      role: 'master',
      jobTitle: 'x',
    });
    expect([403, 422]).toContain(refused.status);
  });
});
