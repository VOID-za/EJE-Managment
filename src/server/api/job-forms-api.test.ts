import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE JOB FORMS, OVER THE REAL HTTP SURFACE. Customer, job form, attachments and
 * workflow changes (October 2026).
 *
 *  - Breakdown and Test & Repair are raised with no machine and no priority,
 *    and a Test & Repair with no fault description.
 *  - Test & Repair "What is the Job?": every field persists and comes back when
 *    the job is reopened — Date Received new, the rest reused — and "Who Is
 *    Doing the Job?" (the assigned technician) is kept.
 *  - Attachments: photographs and videos on a Breakdown or a Test & Repair; a
 *    Parts job takes PHOTOGRAPHS ONLY; a document or an executable is refused
 *    on its bytes, whatever it is called.
 *  - The Coordinator maintains the Rates and the Checklists, and nothing else
 *    of the system settings came with them.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18,
  ...new TextEncoder().encode('ftyp'),
  ...new TextEncoder().encode('isom'),
  0x00, 0x00, 0x02, 0x00,
  ...new TextEncoder().encode('isomiso2mp41'),
]);
const PDF = new TextEncoder().encode('%PDF-1.4\nthe customer order');
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

const FIELD_JOB = {
  customerId: 'cust-abc',
  siteId: 'site-abc-jhb',
  contactId: 'contact-abc-jhb',
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: '',
  referenceNumber: '',
  primaryTechnicianId: null,
  additionalTechnicianIds: [],
  courierCollection: false,
  deliveryNote: '',
} as const;

const jobOf = async (client: ApiTestClient, jobNumber: string): Promise<Job> =>
  (await client.get<{ view: { job: Job } }>(`/api/jobs/${jobNumber}`)).data.view.job;

const userId = async (client: ApiTestClient, email: string): Promise<string> =>
  (
    await client.get<{ users: readonly { id: string; email: string }[] }>('/api/admin')
  ).data.users.find((user) => user.email === email)?.id ?? '';

const codes = (response: { error?: unknown }): readonly string[] =>
  (
    (response.error as { violations?: readonly { code: string }[] } | undefined)?.violations ?? []
  ).map((violation) => violation.code);

describe('raising a Breakdown or a Test & Repair', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  it('raises a BREAKDOWN with no machine and no priority', async () => {
    const raised = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType: 'breakdown',
      machineId: null,
      priority: null,
      faultDescription: 'Line is down; machine not yet identified.',
    });
    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    const reread = await jobOf(master, raised.data.jobNumber);
    expect(reread.machineId).toBeNull();
    expect(reread.priority).toBeNull();
  });

  it('raises a TEST & REPAIR with no machine, no priority and no fault description', async () => {
    const raised = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType: 'test_and_repair',
      machineId: null,
      priority: null,
      faultDescription: '',
    });
    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    const reread = await jobOf(master, raised.data.jobNumber);
    expect(reread.machineId).toBeNull();
    expect(reread.priority).toBeNull();
    expect(reread.faultDescription).toBe('');
    expect(reread.dateReceived).toBeNull();
  });
});

describe('Test & Repair: "What is the Job?"', () => {
  let master: ApiTestClient;
  let coordinator: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
    coordinator = await signedInAs(DEMO_USERS.coordinator);
  });

  it('keeps every field, and gives each back when the job is reopened', async () => {
    const technicianId = await userId(master, DEMO_USERS.technician);
    const raised = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType: 'test_and_repair',
      machineId: null,
      priority: null,
      dateReceived: '2026-10-20',
      repairPartNumber: 'A06B-6117-H209',
      repairDescription: 'Spindle amplifier module',
      repairQuantity: 2,
      faultDescription: 'Trips on power-up.',
      deliveryNote: 'WB-778812',
      referenceNumber: 'REF-55',
      quoteNumber: 'Q-20451',
      primaryTechnicianId: technicianId,
    });
    expect(raised.status, JSON.stringify(raised.error)).toBe(200);

    const reread = await jobOf(master, raised.data.jobNumber);
    expect(reread.dateReceived).toBe('2026-10-20');
    expect(reread.repairItem).toEqual({
      partNumber: 'A06B-6117-H209',
      description: 'Spindle amplifier module',
      quantity: 2,
    });
    expect(reread.faultDescription).toBe('Trips on power-up.');
    expect(reread.deliveryNote).toBe('WB-778812');
    expect(reread.referenceNumber).toBe('REF-55');
    expect(reread.quoteNumber).toBe('Q-20451');
    // "Who Is Doing the Job?" — the assigned technician, preserved.
    expect(reread.primaryTechnicianId).toBe(technicianId);
  });

  it('refuses a date received in the future, and allocates no job number for it', async () => {
    const before = await master.get<{ rows: readonly unknown[] }>('/api/jobs');
    const refused = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType: 'test_and_repair',
      machineId: null,
      priority: null,
      faultDescription: '',
      dateReceived: '2999-01-01',
    });
    expect(refused.status).toBe(422);
    expect(codes(refused)).toContain('date_received_invalid');
    const after = await master.get<{ rows: readonly unknown[] }>('/api/jobs');
    expect(after.data.rows.length).toBe(before.data.rows.length);
  });

  it('refuses a date that is not a real day', async () => {
    const refused = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType: 'test_and_repair',
      machineId: null,
      priority: null,
      faultDescription: '',
      dateReceived: '2026-02-30',
    });
    expect(refused.status).toBe(422);
    expect(codes(refused)).toContain('date_received_invalid');
  });

  it('refuses a quantity that is not a positive whole number', async () => {
    for (const repairQuantity of [0, -1, 1.5]) {
      const refused = await master.post<Job>('/api/jobs', {
        ...FIELD_JOB,
        jobType: 'test_and_repair',
        machineId: null,
        priority: null,
        faultDescription: '',
        repairQuantity,
      });
      expect(refused.status, String(repairQuantity)).toBe(400);
    }
  });

  it('stores no date received on a job type that books in no unit', async () => {
    const raised = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType: 'breakdown',
      machineId: null,
      priority: null,
      faultDescription: 'Alarm 401.',
      dateReceived: '2026-10-20',
    });
    expect(raised.status).toBe(200);
    expect((await jobOf(master, raised.data.jobNumber)).dateReceived).toBeNull();
  });

  it('lets the office correct the date received afterwards, and clear it', async () => {
    const raised = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType: 'test_and_repair',
      machineId: null,
      priority: null,
      faultDescription: '',
    });
    const jobNumber = raised.data.jobNumber;
    const set = await coordinator.post<Job>(`/api/jobs/${raised.data.id}/edit_details`, {
      changes: { dateReceived: '2026-10-21' },
      expected: { dateReceived: null },
    });
    expect(set.status, JSON.stringify(set.error)).toBe(200);
    expect((await jobOf(master, jobNumber)).dateReceived).toBe('2026-10-21');

    const cleared = await coordinator.post<Job>(`/api/jobs/${raised.data.id}/edit_details`, {
      changes: { dateReceived: null },
      expected: { dateReceived: '2026-10-21' },
    });
    expect(cleared.status, JSON.stringify(cleared.error)).toBe(200);
    expect((await jobOf(master, jobNumber)).dateReceived).toBeNull();
  });
});

describe('photographs and videos, per job type', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  const raise = async (jobType: 'breakdown' | 'test_and_repair' | 'parts'): Promise<Job> => {
    const response = await master.post<Job>('/api/jobs', {
      ...FIELD_JOB,
      jobType,
      machineId: null,
      priority: null,
      faultDescription: jobType === 'breakdown' ? 'Coolant pump alarming.' : '',
      orderNumber: jobType === 'parts' ? 'PO-PHOTO-1' : '',
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    return response.data;
  };

  const attach = (job: Job, name: string, type: string, bytes: Uint8Array) =>
    master.upload<{ attachments: readonly { fileName: string }[] }>(
      `/api/jobs/${job.id}/attachments`,
      { name, type, bytes },
    );

  for (const jobType of ['breakdown', 'test_and_repair'] as const) {
    it(`${jobType}: takes a photograph AND a video, and the job shows both`, async () => {
      const job = await raise(jobType);
      expect((await attach(job, 'fault.png', 'image/png', PNG)).status).toBe(200);
      expect((await attach(job, 'noise.mp4', 'video/mp4', MP4)).status).toBe(200);
      const names = (await jobOf(master, job.jobNumber)).attachments.map((file) => file.fileName);
      expect(names).toEqual(expect.arrayContaining(['fault.png', 'noise.mp4']));
    });

    it(`${jobType}: refuses a PDF and an executable, whatever they are called`, async () => {
      const job = await raise(jobType);
      expect((await attach(job, 'order.pdf', 'application/pdf', PDF)).status).toBe(400);
      expect((await attach(job, 'photo.png', 'image/png', PDF)).status).toBe(400);
      expect((await attach(job, 'photo.jpg', 'image/jpeg', EXE)).status).toBe(400);
      expect((await jobOf(master, job.jobNumber)).attachments).toHaveLength(0);
    });
  }

  it('parts: takes a PHOTOGRAPH, and the job shows it', async () => {
    const job = await raise('parts');
    const response = await attach(job, 'goods.png', 'image/png', PNG);
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    expect((await jobOf(master, job.jobNumber)).attachments.map((file) => file.fileName)).toEqual([
      'goods.png',
    ]);
  });

  it('parts: REFUSES a video, on its bytes, even one called .png', async () => {
    const job = await raise('parts');
    const asVideo = await attach(job, 'clip.mp4', 'video/mp4', MP4);
    expect(asVideo.status).toBe(400);
    expect(JSON.stringify(asVideo.error)).toMatch(/photographs/i);
    expect((await attach(job, 'clip.png', 'image/png', MP4)).status).toBe(400);
    expect((await attach(job, 'note.pdf', 'application/pdf', PDF)).status).toBe(400);
    expect((await jobOf(master, job.jobNumber)).attachments).toHaveLength(0);
  });
});

describe('the Coordinator maintains the Rates and the Checklists', () => {
  let coordinator: ApiTestClient;
  let technician: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    coordinator = await signedInAs(DEMO_USERS.coordinator);
    technician = await signedInAs(DEMO_USERS.technician);
  });

  const settingsBody = async (client: ApiTestClient, vatPercentage: number) => {
    const { settings } = (
      await client.get<{ settings: Record<string, unknown> }>('/api/admin')
    ).data;
    const keep = [
      'companyName', 'companyRegistration', 'companyVatNumber', 'companyPhone', 'companyEmail',
      'companyAddress', 'labourRates', 'calloutRate', 'kilometreRate', 'jobNumberPrefix',
      'quietHoursStart', 'quietHoursEnd',
    ];
    return {
      ...Object.fromEntries(keep.map((key) => [key, settings[key]])),
      vatPercentage,
    };
  };

  it('changes the rates — and the change is what the system now holds', async () => {
    const response = await coordinator.send('PATCH', '/api/settings', {
      body: await settingsBody(coordinator, 16),
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    const reread = await coordinator.get<{ settings: { vatPercentage: number } }>('/api/admin');
    expect(reread.data.settings.vatPercentage).toBe(16);
  });

  it('creates a checklist template', async () => {
    const response = await coordinator.post<{ id: string; name: string }>('/api/checklists', {
      name: 'Coordinator-maintained service checklist',
      description: 'Drafted by the office.',
      jobTypeCode: 'service',
      sourceDocument: '',
    });
    expect(response.status, JSON.stringify(response.error)).toBe(200);
    expect(response.data.name).toBe('Coordinator-maintained service checklist');
  });

  it('refuses a technician both, with nothing written', async () => {
    const before = (await coordinator.get<{ settings: { vatPercentage: number } }>('/api/admin'))
      .data.settings.vatPercentage;
    const rates = await technician.send('PATCH', '/api/settings', {
      body: await settingsBody(coordinator, 42),
    });
    expect(rates.status).toBe(403);
    const checklist = await technician.post('/api/checklists', {
      name: 'Not mine to write',
      description: '',
      jobTypeCode: 'service',
      sourceDocument: '',
    });
    expect(checklist.status).toBe(403);
    expect(
      (await coordinator.get<{ settings: { vatPercentage: number } }>('/api/admin')).data.settings
        .vatPercentage,
    ).toBe(before);
  });

  it('still refuses the Coordinator the system settings that did not move (the demo reset)', async () => {
    const reset = await coordinator.post('/api/demo/reset', {});
    expect([403, 404]).toContain(reset.status);
  });
});
