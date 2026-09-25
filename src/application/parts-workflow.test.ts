import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addPart,
  addTravel,
  assignPrimaryTechnician,
  captureSignature,
  confirmJobCardDelivery,
  issueJobCard,
  setCalloutApplied,
  setCollectionMethod,
  startSignature,
} from './job-operations';
import { createJob } from './job-creation';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import {
  canAcceptJob,
  canSubmitJobCard,
  checkReadyForSignature,
  getJobTypeDefinition,
  type Job,
  type User,
} from '@/domain';

/**
 * THE PARTS COLLECTION WORKFLOW, END TO END. MASTER SCOPE CR-12.
 *
 * A collection is a counter transaction, and it stopped being modelled as one.
 * It went through the field-service sequence — raise it, find it in the Jobs
 * list, accept it, process it — because that is how every job worked, and each
 * of those steps was a person standing at the counter waiting while somebody
 * clicked through a workflow built for a technician driving to a site.
 *
 * The journey now is: raise it → Parts → Review → Collection → Collector
 * signature → Signed → Submit collection note → delivery → closed. No
 * technician, no assignment, no acceptance, no labour, no travel, no call-out.
 *
 * What did NOT change, and is asserted here as well: the document, the
 * signature, the submission, the delivery handshake and the closing rule. A
 * collection note is issued, emailed once and closed on a confirmed delivery
 * exactly as a job card is.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const raise = async (
  harness: Harness,
  actor: User,
  over: Partial<Parameters<typeof createJob>[1]> = {},
): Promise<Job> => {
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);

  return createJob(harness.as(actor), {
    customerId: customer!.id,
    siteId: sites[0]!.id,
    contactId: contacts[0]!.id,
    machineId: null,
    jobType: 'parts',
    priority: 'urgent',
    scheduledDate: '2026-09-28',
    scheduledEndDate: null,
    orderNumber: 'PO-44120',
    referenceNumber: 'REF-PARTS-1',
    deliveryNote: 'DN-99001',
    faultDescription: 'Spindle drive spares for collection.',
    primaryTechnicianId: null,
    additionalTechnicianIds: [],
    courierCollection: false,
    ...over,
  });
};

const withParts = async (harness: Harness, actor: User, job: Job): Promise<Job> =>
  addPart(harness.as(actor), job, {
    partNumber: 'ENC-INC-1024',
    description: 'Incremental encoder, 1024 ppr',
    quantity: 2,
    unitPrice: 386_000,
  });

describe('raising a parts collection', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is office work: a Master raises one, and a Coordinator raises one', async () => {
    for (const actor of [master, coordinator]) {
      const job = await raise(harness, actor);
      expect(job.jobType, actor.role).toBe('parts');
      expect(job.createdBy, actor.role).toBe(actor.id);
    }
  });

  it('opens at its own close-out, not in the open pool', async () => {
    const job = await raise(harness, master);
    // `completion` is the existing stage whose next legal move is the customer
    // signature, which is exactly what a collection does next. No new status.
    expect(job.status).toBe('completion');
  });

  it('carries no technician, no schedule and no priority of its own', async () => {
    const job = await raise(harness, master);

    expect(job.primaryTechnicianId).toBeNull();
    expect(job.additionalTechnicianIds).toEqual([]);
    expect(job.acceptedAt).toBeNull();
    // Both were sent on the request and both are the server's to decide.
    expect(job.scheduledDate).toBeNull();
    expect(job.priority).toBe(getJobTypeDefinition('parts').defaultPriority);
  });

  it('refuses a request that names a technician, rather than quietly dropping it', async () => {
    await expect(raise(harness, master, { primaryTechnicianId: technician.id })).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('does not take the courier answer at creation — that is the collection step', async () => {
    const job = await raise(harness, master, { courierCollection: true });
    expect(job.courierCollection).toBe(false);
  });

  it('keeps the fields the counter reconciles by', async () => {
    const job = await raise(harness, master);
    expect(job.orderNumber).toBe('PO-44120');
    expect(job.referenceNumber).toBe('REF-PARTS-1');
    expect(job.deliveryNote).toBe('DN-99001');
  });

  it('still requires the customer order number, which is what ties the goods to the order', async () => {
    const job = await raise(harness, master, { orderNumber: '' });
    const withGoods = await withParts(harness, master, job);
    const readiness = checkReadyForSignature(withGoods);
    expect(readiness.allowed).toBe(false);
    expect(readiness.violations.map((violation) => violation.code)).toContain(
      'order_number_required',
    );
  });
});

describe('a parts collection is never accepted or assigned', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('offers Accept to nobody, and refuses it to everybody', async () => {
    const job = await raise(harness, master);

    for (const person of [master, coordinator, technician]) {
      expect(canAcceptJob(job, person), person.role).toBe(false);
      await expect(acceptJob(harness.as(person), job)).rejects.toBeInstanceOf(WorkflowError);
    }
  });

  it('refuses to assign a technician to one, even for the office', async () => {
    const job = await raise(harness, master);
    await expect(
      assignPrimaryTechnician(harness.as(master), job, technician.id, 'Sipho Mahlangu'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('a parts collection carries no labour, travel or call-out — on the SERVER', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses labour', async () => {
    const job = await raise(harness, master);
    await expect(
      addLabour(harness.as(master), job, {
        date: '2026-09-28',
        rateType: 'normal',
        hours: 2,
        description: 'Not applicable to a collection.',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses travel', async () => {
    const job = await raise(harness, master);
    await expect(
      addTravel(harness.as(master), job, {
        date: '2026-09-28',
        kilometres: 40,
        description: 'Nobody went anywhere.',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses a call-out fee', async () => {
    const job = await raise(harness, master);
    await expect(setCalloutApplied(harness.as(master), job, true)).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('accepts parts, which is the whole of what it captures', async () => {
    const job = await withParts(harness, master, await raise(harness, master));
    expect(job.parts).toHaveLength(1);
    expect(job.parts[0]?.partNumber).toBe('ENC-INC-1024');
    expect(job.labour).toEqual([]);
    expect(job.travel).toEqual([]);
    expect(job.calloutApplied).toBe(false);
  });
});

describe('the counter journey, start to finish', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** Raise → parts → collection → signature → issue, as one person. */
  const process = async (actor: User, courier: boolean): Promise<Job> => {
    let job = await raise(harness, actor);
    job = await withParts(harness, actor, job);
    job = await setCollectionMethod(harness.as(actor), job, {
      courier,
      waybillNumber: courier ? 'DSV-4471882' : '',
    });
    job = await startSignature(harness.as(actor), job);
    return captureSignature(harness.as(actor), job, {
      customerName: 'Thabo',
      customerSurname: 'Dlamini',
      strokeData: 'M0,0 L1,1',
    });
  };

  it('a Master takes it from raising the job to a signed collection note', async () => {
    const signed = await process(master, false);
    expect(signed.status).toBe('review');
    expect(signed.signature).not.toBeNull();
    expect(signed.signature?.declaration).toContain('collected');
  });

  it('a Coordinator does exactly the same, alone', async () => {
    const signed = await process(coordinator, false);
    expect(signed.status).toBe('review');
    expect(signed.signature?.customerName).toBe('Thabo');
  });

  it('the collection step is where the courier answer is recorded', async () => {
    const signed = await process(master, true);
    expect(signed.courierCollection).toBe(true);
    expect(signed.waybillNumber).toBe('DSV-4471882');
  });

  it('submitting emails the customer, moves it to awaiting delivery — and does NOT close it', async () => {
    const signed = await process(master, false);
    const result = await issueJobCard(
      harness.as(master),
      signed,
      'buyer@example.co.za',
      'Thabo Dlamini',
    );

    expect(result.job.status).toBe('awaiting_delivery');
    expect(result.job.closedAt).toBeNull();
    expect(result.emailedTo).toBe('buyer@example.co.za');
    expect(result.documentFileName).toContain('Collection-Note');

    // Through the same outbox every other customer copy goes through.
    const messages = await harness.outbox.list();
    expect(messages.some((entry) => entry.to === 'buyer@example.co.za')).toBe(true);
  });

  it('a confirmed delivery is what closes it', async () => {
    const signed = await process(master, false);
    const issued = await issueJobCard(
      harness.as(master),
      signed,
      'buyer@example.co.za',
      'Thabo Dlamini',
    );
    expect(issued.job.status).toBe('awaiting_delivery');

    // The provider's delivery report arrives, exactly as it does for a job card.
    harness.outbox.setDelivery(issued.delivery.messageId, 'delivered');
    const closed = await confirmJobCardDelivery(harness.as(master), issued.job);

    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
  });

  it('a technician cannot submit the collection note — the counter is the office', async () => {
    const signed = await process(master, false);
    expect(canSubmitJobCard(technician, signed)).toBe(false);
    await expect(
      issueJobCard(harness.as(technician), signed, 'buyer@example.co.za', 'Thabo Dlamini'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('field service is untouched', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('every other job type still schedules, prioritises, assigns and is accepted', async () => {
    for (const jobType of ['breakdown', 'installation', 'service', 'test_and_repair'] as const) {
      const definition = getJobTypeDefinition(jobType);
      expect(definition.officeProcessed, jobType).toBe(false);
      expect(definition.capturesLabourAndTravel, jobType).toBe(true);
    }
  });

  it('a breakdown is raised Open, assigned, accepted, and takes labour and travel', async () => {
    const [customer] = await harness.repos.customers.list();
    const sites = await harness.repos.customers.listSites(customer!.id);
    const contacts = await harness.repos.customers.listContacts(customer!.id);
    const machines = (await harness.repos.machines.list()).filter(
      (machine) => machine.customerId === customer!.id,
    );

    const job = await createJob(harness.as(master), {
      customerId: customer!.id,
      siteId: sites[0]!.id,
      contactId: contacts[0]!.id,
      machineId: machines[0]!.id,
      jobType: 'breakdown',
      priority: 'urgent',
      scheduledDate: '2026-09-28',
      scheduledEndDate: null,
      orderNumber: '',
      referenceNumber: '',
      deliveryNote: '',
      faultDescription: 'Machine stopped during operation.',
      primaryTechnicianId: technician.id,
      additionalTechnicianIds: [],
      courierCollection: false,
    });

    // Everything a collection no longer has, a breakdown still does.
    expect(job.status).toBe('open');
    expect(job.priority).toBe('urgent');
    expect(job.scheduledDate).toBe('2026-09-28');
    expect(job.primaryTechnicianId).toBe(technician.id);
    expect(canAcceptJob(job, technician)).toBe(true);

    const accepted = await acceptJob(harness.as(technician), job);
    expect(accepted.status).toBe('in_progress');

    const withLabour = await addLabour(harness.as(technician), accepted, {
      date: '2026-09-28',
      rateType: 'normal',
      hours: 3,
      description: '',
    });
    expect(withLabour.labour).toHaveLength(1);

    const withTravel = await addTravel(harness.as(technician), withLabour, {
      date: '2026-09-28',
      kilometres: 120,
      description: 'Isando to site',
    });
    expect(withTravel.travel).toHaveLength(1);

    const withCallout = await setCalloutApplied(harness.as(technician), withTravel, true);
    expect(withCallout.calloutApplied).toBe(true);
  });
});
