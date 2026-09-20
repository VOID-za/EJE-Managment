import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addPart,
  captureSignature,
  issueJobCard,
  saveCompletionReport,
  setCollectionMethod,
  startCompletion,
  startSignature,
} from './job-operations';
import { createJob } from './job-creation';
import { loadFinalDocumentFile } from './final-document';
import { loadJobView } from './job-view';
import { buildHarness, confirmDelivery, seedUser, type Harness } from './test-harness';
import { buildJobCardModel } from '@/lib/job-card/model';
import { pdfPlainText } from '@/lib/pdf/inspect';
import {
  asLineItemId,
  buildPartsDocument,
  checkCollectionDetails,
  getJobTypeDefinition,
  JOB_TYPE_CODES,
  showsPricesOnCollectionDocument,
  type Job,
  type JobTypeCode,
} from '@/domain';

/**
 * What leaves the counter, and what the person collecting it is allowed to see.
 *
 * The commercial rule these hold: a courier collecting on a customer's behalf
 * must not be handed a document showing what the customer paid. It applies to
 * both things EJE hands over a counter — a box of parts, and a repaired unit —
 * and it is a property of the DOCUMENT. The prices stay on the job.
 */

const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

describe('which job types are collected', () => {
  it('is parts and test and repair, and nothing else', () => {
    const collected = JOB_TYPE_CODES.filter(
      (code) => getJobTypeDefinition(code).collectedOnCompletion,
    );
    expect([...collected].sort()).toEqual(['parts', 'test_and_repair']);
  });

  it('offers a delivery note on exactly those two', () => {
    const withNote = JOB_TYPE_CODES.filter(
      (code) => getJobTypeDefinition(code).capturesDeliveryNote,
    );
    expect([...withNote].sort()).toEqual(['parts', 'test_and_repair']);
  });

  it('leaves the site job types alone', () => {
    for (const code of ['breakdown', 'installation', 'service'] as JobTypeCode[]) {
      const definition = getJobTypeDefinition(code);
      expect(definition.collectedOnCompletion, code).toBe(false);
      expect(definition.capturesDeliveryNote, code).toBe(false);
      expect(definition.visitsSite, code).toBe(true);
    }
  });
});

describe('the waybill rule', () => {
  const job = (over: Partial<Job>): Pick<Job, 'jobType' | 'courierCollection' | 'waybillNumber'> =>
    ({ jobType: 'parts', courierCollection: false, waybillNumber: '', ...over }) as Job;

  it('requires one for a courier collection', () => {
    const check = checkCollectionDetails(job({ courierCollection: true }));
    expect(check.allowed).toBe(false);
    expect(check.violations[0]?.code).toBe('waybill_required');
  });

  it('accepts a courier collection that has one', () => {
    expect(
      checkCollectionDetails(job({ courierCollection: true, waybillNumber: 'DAW-4471' })).allowed,
    ).toBe(true);
  });

  it('rejects whitespace dressed up as one', () => {
    expect(
      checkCollectionDetails(job({ courierCollection: true, waybillNumber: '   ' })).allowed,
    ).toBe(false);
  });

  it('requires none for a customer collection', () => {
    expect(checkCollectionDetails(job({ courierCollection: false })).allowed).toBe(true);
  });

  it('does not apply to a job done on the customer’s site', () => {
    expect(
      checkCollectionDetails(job({ jobType: 'breakdown', courierCollection: true })).allowed,
    ).toBe(true);
  });
});

describe('who sees the prices', () => {
  const at = (jobType: JobTypeCode, courierCollection: boolean) =>
    showsPricesOnCollectionDocument({ jobType, courierCollection });

  it('shows them on a customer collection, for both collected types', () => {
    expect(at('parts', false)).toBe(true);
    expect(at('test_and_repair', false)).toBe(true);
  });

  it('withholds them from a courier, for both collected types', () => {
    expect(at('parts', true)).toBe(false);
    expect(at('test_and_repair', true)).toBe(false);
  });

  it('never withholds them from a job done on the customer’s site', () => {
    expect(at('breakdown', true)).toBe(true);
    expect(at('service', true)).toBe(true);
  });

  it('withholds them from the parts lines as well as the totals', () => {
    const parts = [
      {
        id: asLineItemId('prt-1'),
        partNumber: 'FAN-24V-80',
        description: 'Cooling fan',
        quantity: 2,
        unitPrice: 48500,
        capturedAt: '2026-09-18T09:00:00.000Z',
        capturedBy: technician.id,
      },
    ] as Job['parts'];

    const courier = buildPartsDocument({ jobType: 'parts', courierCollection: true, parts });
    expect(courier.showsPrices).toBe(false);
    expect(courier.subtotal).toBeNull();
    expect(courier.lines[0]?.unitPrice).toBeNull();
    expect(courier.lines[0]?.lineTotal).toBeNull();
    // The quantity is not a price, and the courier needs it to check the load.
    expect(courier.lines[0]?.quantity).toBe(2);

    const customer = buildPartsDocument({ jobType: 'parts', courierCollection: false, parts });
    expect(customer.showsPrices).toBe(true);
    expect(customer.subtotal).toBe(97000);
  });
});

describe('a test and repair collected from the counter', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  /**
   * Raises a workshop repair, works it, and takes it to the signature step.
   *
   * A courier collection has its waybill recorded on the way, exactly as the
   * close-out wizard does it: the Collection step writes the answer and only
   * then does the job move onto the signature. `checkReadyForSignature` refuses
   * a courier collection with no waybill, which is the point of that rule, so a
   * fixture that skipped the step would be building a state no screen can
   * produce.
   */
  const workshopJob = async (over: {
    courier: boolean;
    deliveryNote?: string;
    /** The waybill recorded at the Collection step. Ignored for a customer collection. */
    waybill?: string;
  }): Promise<Job> => {
    const context = harness.as(master);
    const [customer] = await harness.repos.customers.list();
    const sites = await harness.repos.customers.listSites(customer!.id);
    const contacts = await harness.repos.customers.listContacts(customer!.id);
    const machines = await harness.repos.machines.list();
    const machine = machines.find((candidate) => candidate.customerId === customer!.id);

    let job = await createJob(context, {
      customerId: customer!.id,
      siteId: sites[0]!.id,
      contactId: contacts[0]!.id,
      machineId: machine!.id,
      jobType: 'test_and_repair',
      priority: 'normal',
      scheduledDate: '2026-09-20',
      scheduledEndDate: null,
      orderNumber: 'PO-99001',
      referenceNumber: 'WS-114',
      deliveryNote: over.deliveryNote ?? '',
      faultDescription: 'Spindle drive in for bench testing.',
      primaryTechnicianId: technician.id,
      courierCollection: over.courier,
    });

    const tech = harness.as(technician);
    job = await acceptJob(tech, job);
    job = await saveCompletionReport(tech, job, {
      ...job.completionReport,
      workPerformed: 'Bench tested the drive and replaced the encoder coupling.',
    });
    job = await addLabour(tech, job, {
      date: '2026-09-20',
      rateType: 'normal',
      hours: 3,
      description: 'Bench test and repair',
    });
    job = await addPart(tech, job, {
      partNumber: 'ENC-CPL-12',
      description: 'Encoder coupling',
      quantity: 1,
      unitPrice: 132000,
    });
    job = await startCompletion(tech, job);
    if (over.courier) {
      job = await setCollectionMethod(tech, job, {
        courier: true,
        waybillNumber: over.waybill ?? 'DAW-4471',
      });
    }
    return startSignature(tech, job);
  };

  it('stores the customer’s delivery note when they gave one', async () => {
    const job = await workshopJob({ courier: false, deliveryNote: 'DN-12345' });
    expect(job.deliveryNote).toBe('DN-12345');
  });

  it('is perfectly happy without one', async () => {
    const job = await workshopJob({ courier: false });
    expect(job.deliveryNote).toBe('');
  });

  it('prints the delivery note on the document, and nothing when there is none', async () => {
    const withNote = await workshopJob({ courier: false, deliveryNote: 'DN-12345' });
    const view = await loadJobView(harness.repos, withNote.jobNumber);
    const model = buildJobCardModel({
      job: withNote,
      customer: view!.customer,
      site: view!.site,
      contact: view!.contact,
      machine: view!.machine,
      settings: view!.settings,
      checklistTemplate: view!.checklistTemplate,
      users: view!.users,
      generatedAt: '2026-09-20T10:00:00.000Z',
    });
    const rows = model.jobDetails.map((row) => row.label);
    expect(rows).toContain('Delivery note');
    expect(model.jobDetails.find((row) => row.label === 'Delivery note')?.value).toBe('DN-12345');
  });

  it('records a courier collection with its waybill', async () => {
    const job = await workshopJob({ courier: true });
    const set = await setCollectionMethod(harness.as(technician), job, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });

    expect(set.courierCollection).toBe(true);
    expect(set.waybillNumber).toBe('DAW-4471');

    const events = await harness.repos.activity.list(set.id);
    const event = events.find((entry) => entry.type === 'collection_method_set');
    expect(event?.summary).toBe('Courier collection');
    expect(event?.detail).toContain('DAW-4471');
  });

  it('refuses a courier collection with no waybill', async () => {
    const job = await workshopJob({ courier: true });
    await expect(
      setCollectionMethod(harness.as(technician), job, { courier: true, waybillNumber: '' }),
    ).rejects.toThrow(/waybill/i);
  });

  it('clears the waybill when the customer collects after all', async () => {
    const job = await workshopJob({ courier: true });
    const courier = await setCollectionMethod(harness.as(technician), job, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });
    const customer = await setCollectionMethod(harness.as(technician), courier, {
      courier: false,
      waybillNumber: 'DAW-4471',
    });

    expect(customer.courierCollection).toBe(false);
    expect(customer.waybillNumber).toBe('');
  });

  it('will not set a collection on a job nobody collects', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    await expect(
      setCollectionMethod(harness.as(technician), opened!, {
        courier: true,
        waybillNumber: 'DAW-1',
      }),
    ).rejects.toThrow(/not collected/i);
  });

  /** Signs, issues and closes, returning the text of the stored document. */
  const issuedText = async (job: Job): Promise<string> => {
    const signed = await captureSignature(harness.as(technician), job, {
      customerName: 'Thabo',
      customerSurname: 'Dlamini',
      strokeData: 'M0,0 L1,1',
    });
    const result = await issueJobCard(
      harness.as(coordinator),
      signed,
      'accounts@example.com',
      'ABC Engineering',
    );
    await confirmDelivery(harness, harness.as(coordinator), result.job);
    return pdfPlainText(
      (await loadFinalDocumentFile(harness.as(coordinator), job.jobNumber)).bytes,
    );
  };

  it('gives the courier a document with no prices on it', async () => {
    const job = await workshopJob({ courier: true, deliveryNote: 'DN-98765' });
    const collected = await setCollectionMethod(harness.as(technician), job, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });
    const text = await issuedText(collected);

    /*
     * What it MUST NOT say.
     *
     * "VAT" alone would match EJE's own VAT registration number in the letter
     * head, which is not a price and belongs on every document EJE issues. The
     * charges block is what must be absent, so the charges block is what is
     * asserted: its labels, and the money itself.
     */
    for (const forbidden of ['VAT @', 'Subtotal', 'Total', '1 320,00', '320,00', 'Amount']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/R\u00a0[\d\u00a0]+,\d\d/);
    // What it must: enough to identify the consignment.
    expect(text).toContain('Courier collection');
    expect(text).toContain('DAW-4471');
    expect(text).toContain('DN-98765');
    expect(text).toContain('Thabo');
  });

  it('gives the customer a document that does show the prices', async () => {
    const job = await workshopJob({ courier: false });
    const collected = await setCollectionMethod(harness.as(technician), job, {
      courier: false,
      waybillNumber: '',
    });
    const text = await issuedText(collected);

    expect(text).toContain('Customer collection');
    expect(text).toContain('VAT');
    expect(text).toContain('Total');
  });

  it('keeps the prices on the job either way', async () => {
    const job = await workshopJob({ courier: true });
    const collected = await setCollectionMethod(harness.as(technician), job, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });

    // Withheld from the DOCUMENT, never deleted from the record: EJE still has
    // to invoice this, and still has to cost it.
    expect(collected.parts[0]?.unitPrice).toBe(132000);
    expect(collected.labour[0]?.hours).toBe(3);

    // And the rates freeze at the signature exactly as they always have.
    const signed = await captureSignature(harness.as(technician), collected, {
      customerName: 'Thabo',
      customerSurname: 'Dlamini',
      strokeData: 'M0,0 L1,1',
    });
    expect(signed.pricingSnapshot).not.toBeNull();
    expect(signed.parts[0]?.unitPrice).toBe(132000);
  });
});

describe('the job card header', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const textOf = async (jobNumber: string): Promise<string> =>
    pdfPlainText((await loadFinalDocumentFile(harness.as(master), jobNumber)).bytes);

  it('carries the document name and the job number, and no workflow state', async () => {
    const text = await textOf('EJE-1044');
    const head = text.split('\n').slice(0, 14).join('\n');

    expect(head).toContain('JOB CARD');
    expect(head).toContain('EJE-1044');
    // None of EJE's internal state belongs at the top of a customer's document.
    for (const forbidden of ['Status:', 'Master Review', 'Awaiting Delivery', 'Review']) {
      expect(head, forbidden).not.toContain(forbidden);
    }
  });

  it('says nothing about job type or priority in the header', async () => {
    const head = (await textOf('EJE-1044')).split('\n').slice(0, 14).join('\n');
    expect(head).not.toMatch(/Breakdown|Installation|Service|Urgent|Normal|High|Low/);
  });

  it('still prints the job type and priority with the job’s own details', async () => {
    const text = await textOf('EJE-1044');
    expect(text).toContain('Job type');
    expect(text).toContain('Priority');
  });

  it('says nothing about any workflow status anywhere on the document', async () => {
    for (const jobNumber of ['EJE-1044', 'EJE-1056', 'EJE-1039', 'EJE-1062']) {
      const text = await textOf(jobNumber);
      expect(text, jobNumber).not.toContain('Status:');
      expect(text, jobNumber).not.toMatch(/master review/i);
    }
  });
});
