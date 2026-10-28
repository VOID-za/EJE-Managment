import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import { DEMO_USERS, signedInAs, startTestServer, type ApiTestClient } from '@/test/api-harness';

/**
 * THE TEST & REPAIR FIELDS OVER THE REAL ROUTES. Test & Repair §4.
 *
 * The application tests prove the rules. What is left to the HTTP layer:
 *
 *  - the fields arrive FLAT, as a form posts them, and are grouped server-side;
 *  - the quantity is refused by the SCHEMA when it is zero or fractional (400),
 *    because "zero of them arrived" is not something a counter records;
 *  - a job type that does not capture them stores nothing rather than refusing,
 *    since a screen switching type sends what it had;
 *  - and the values come BACK on the job, so nothing between the operation and
 *    the response drops them.
 */
const raise = async (
  client: ApiTestClient,
  over: Record<string, unknown> = {},
): Promise<{ status: number; job?: Job; error?: unknown }> => {
  const response = await client.post<Job>('/api/jobs', {
    customerId: 'cust-abc',
    siteId: 'site-abc-jhb',
    contactId: 'contact-abc-jhb',
    machineId: null,
    jobType: 'test_and_repair',
    priority: null,
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: '',
    referenceNumber: '',
    faultDescription: '',
    primaryTechnicianId: null,
    additionalTechnicianIds: [],
    courierCollection: false,
    deliveryNote: '',
    ...over,
  });
  return { status: response.status, job: response.data, error: response.error };
};

const jobOf = async (client: ApiTestClient, jobNumber: string): Promise<Job> =>
  (await client.get<{ view: { job: Job } }>(`/api/jobs/${jobNumber}`)).data.view.job;

describe('raising a Test & Repair job over the API', () => {
  let master: ApiTestClient;

  beforeEach(async () => {
    startTestServer();
    master = await signedInAs(DEMO_USERS.master);
  });

  it('takes all seven fields and gives them back', async () => {
    const raised = await raise(master, {
      referenceNumber: 'CUST-REF-9931',
      deliveryNote: 'DN-55120',
      quoteNumber: 'Q-20451',
      repairPartNumber: '1FK7042-2AF71-1SG0',
      repairDescription: 'Servo motor, 3 kW',
      repairQuantity: 3,
      faultDescription: 'Reported overheating under load.',
    });

    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.job!.quoteNumber).toBe('Q-20451');
    expect(raised.job!.repairItem).toEqual({
      partNumber: '1FK7042-2AF71-1SG0',
      description: 'Servo motor, 3 kW',
      quantity: 3,
    });

    // And on a fresh read, so nothing on the way out dropped them.
    const reread = await jobOf(master, raised.job!.jobNumber);
    expect(reread.repairItem.quantity).toBe(3);
    expect(reread.deliveryNote).toBe('DN-55120');
  });

  it('accepts the job with NONE of them, including no fault description', async () => {
    const raised = await raise(master);

    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.job!.faultDescription).toBe('');
    expect(raised.job!.quoteNumber).toBe('');
    expect(raised.job!.repairItem.quantity).toBeNull();
  });

  it('still REFUSES a breakdown with no fault description — 422', async () => {
    const raised = await raise(master, {
      jobType: 'breakdown',
      machineId: 'machine-abc-lv40',
      priority: 'urgent',
      faultDescription: '   ',
    });
    expect(raised.status).toBe(422);
  });

  it('refuses a quantity of zero by SCHEMA — 400', async () => {
    expect((await raise(master, { repairQuantity: 0 })).status).toBe(400);
  });

  it('refuses a negative and a fractional quantity by SCHEMA — 400', async () => {
    expect((await raise(master, { repairQuantity: -2 })).status).toBe(400);
    expect((await raise(master, { repairQuantity: 1.5 })).status).toBe(400);
  });

  it('accepts a part number with NO quantity', async () => {
    const raised = await raise(master, { repairPartNumber: 'ABC-123' });
    expect(raised.status).toBe(200);
    expect(raised.job!.repairItem.partNumber).toBe('ABC-123');
    expect(raised.job!.repairItem.quantity).toBeNull();
  });

  it('CLEARS them on a breakdown rather than storing a hidden quote number', async () => {
    const raised = await raise(master, {
      jobType: 'breakdown',
      machineId: 'machine-abc-lv40',
      priority: 'urgent',
      faultDescription: 'Spindle will not start.',
      quoteNumber: 'Q-SHOULD-NOT-STICK',
      repairPartNumber: 'NOPE',
      repairQuantity: 9,
    });

    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.job!.quoteNumber).toBe('');
    expect(raised.job!.repairItem.partNumber).toBe('');
    expect(raised.job!.repairItem.quantity).toBeNull();
  });

  it('CLEARS the repair item on a parts collection, and keeps its quote number with no order number (PARTS-01/02)', async () => {
    const raised = await raise(master, {
      jobType: 'parts',
      orderNumber: '',
      quoteNumber: 'Q-PARTS-9',
      repairPartNumber: 'X',
    });

    expect(raised.status, JSON.stringify(raised.error)).toBe(200);
    expect(raised.job!.quoteNumber).toBe('Q-PARTS-9');
    expect(raised.job!.orderNumber).toBe('');
    expect(raised.job!.repairItem.partNumber).toBe('');
  });
});
