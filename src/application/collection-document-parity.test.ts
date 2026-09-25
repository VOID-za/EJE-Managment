import { beforeEach, describe, expect, it } from 'vitest';
import {
  addPart,
  captureSignature,
  confirmJobCardDelivery,
  issueJobCard,
  setCollectionMethod,
  startSignature,
} from './job-operations';
import { createJob } from './job-creation';
import { loadFinalDocumentFile } from './final-document';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { buildJobCardModel } from '@/lib/job-card/model';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { checkReadyForSignature, checkReadyForSubmission, type Job } from '@/domain';

/**
 * The violation codes an operation refused with.
 *
 * Asserted rather than the message text, which is deliberately the generic
 * "not ready for customer signature" — the codes are the contract, and the
 * wording is free to improve without a test being rewritten to allow it.
 */
const refusalCodes = async (run: Promise<unknown>): Promise<readonly string[]> => {
  try {
    await run;
  } catch (error) {
    const violations = (error as { violations?: readonly { code: string }[] }).violations ?? [];
    return violations.map((violation) => violation.code);
  }
  throw new Error('the operation was expected to refuse, and did not');
};

/**
 * The collection note on screen and the one the customer receives are one document.
 *
 * `PartsCollectionNote` used to read the job record directly and build its own
 * header, details and parts table, while the issued PDF was built from
 * `buildJobCardModel`. Two renderers, one document, and they drifted exactly
 * where it matters: the screen left off the waybill and the customer's delivery
 * note, and the courier's PDF left off the goods entirely — a delivery note
 * with no delivery on it.
 *
 * Both now read the model, so the model is what these assert: whatever the
 * screen shows is, by construction, what the PDF prints.
 */

const master = seedUser('user-master-elmarie');

const WAYBILL = 'DAW-4471882';
const DELIVERY_NOTE = 'DN-55012';
const ORDER_NUMBER = 'PO-99321';

/** Raises a parts collection, captures a part, and sets who is collecting. */
const partsJob = async (
  harness: Harness,
  over: { courier: boolean; waybill?: string },
): Promise<Job> => {
  const context = harness.as(master);
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);

  let job = await createJob(context, {
    customerId: customer!.id,
    siteId: sites[0]!.id,
    contactId: contacts[0]!.id,
    machineId: null,
    jobType: 'parts',
    priority: 'normal',
    scheduledDate: '2026-09-20',
    scheduledEndDate: null,
    orderNumber: ORDER_NUMBER,
    referenceNumber: 'REF-77',
    deliveryNote: DELIVERY_NOTE,
    faultDescription: 'Spares for the Leadwell turret.',
    /*
     * RAISED TO NOBODY, AND NOT ACCEPTED BY ANYBODY. MASTER SCOPE CR-12.
     *
     * This used to name a technician, have that technician accept the job and
     * then capture against it. A parts collection has no technician and no
     * acceptance step: the office raises it at `completion` and works straight
     * through. The document under test is unchanged — which is the point of
     * keeping every assertion below exactly as it was.
     */
    primaryTechnicianId: null,
    // Who is collecting is decided at the COLLECTION step, below, not here.
    courierCollection: false,
    additionalTechnicianIds: [],
  });

  expect(job.status).toBe('completion');
  expect(job.primaryTechnicianId).toBeNull();

  job = await addPart(context, job, {
    partNumber: 'ENC-INC-1024',
    description: 'Incremental encoder, 1024 ppr',
    quantity: 2,
    unitPrice: 386_000,
  });
  return setCollectionMethod(context, job, {
    courier: over.courier,
    waybillNumber: over.waybill ?? (over.courier ? WAYBILL : ''),
  });
};

const modelFor = async (harness: Harness, job: Job) => {
  const view = await loadJobView(harness.repos, job.jobNumber);
  return buildJobCardModel({
    job,
    customer: view!.customer,
    site: view!.site,
    contact: view!.contact,
    machine: view!.machine,
    settings: view!.settings,
    checklistTemplate: view!.checklistTemplate,
    users: view!.users,
    generatedAt: '2026-09-20T10:00:00.000Z',
  });
};

/** Signs, issues and closes, returning the stored document's text. */
const issuedText = async (harness: Harness, job: Job): Promise<string> => {
  const signed = await captureSignature(harness.as(master), job, {
    customerName: 'Thabo',
    customerSurname: 'Dlamini',
    strokeData: 'M0,0 L1,1',
  });
  const result = await issueJobCard(
    harness.as(master),
    signed,
    'buyer@example-demo.co.za',
    'ABC Engineering',
  );
  harness.outbox.setDelivery(result.delivery.messageId, 'delivered');
  await confirmJobCardDelivery(harness.as(master), result.job);
  return pdfPlainText((await loadFinalDocumentFile(harness.as(master), job.jobNumber)).bytes);
};

describe('a customer collection', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = buildHarness();
    job = await partsJob(harness, { courier: false });
  });

  it('is titled a collection note, on the model both renderers read', async () => {
    const model = await modelFor(harness, job);
    expect(model.documentTitle).toBe('Parts Collection Note');
  });

  it('carries the order number, the delivery note and the collection method', async () => {
    const model = await modelFor(harness, job);
    const rows = new Map(model.jobDetails.map((row) => [row.label, row.value]));

    expect(rows.get('Order number')).toBe(ORDER_NUMBER);
    expect(rows.get('Delivery note')).toBe(DELIVERY_NOTE);
    expect(rows.get('Collection')).toBe('Customer collection');
    // No waybill on a customer collection: there is no consignment.
    expect(rows.has('Waybill')).toBe(false);
  });

  it('shows its prices, in the charges block both renderers use', async () => {
    const model = await modelFor(harness, job);
    expect(model.charges).not.toBeNull();
    expect(model.charges?.rows.map((row) => row.description)).toContain('ENC-INC-1024');
    // The goods block is for documents that withhold prices; this is not one.
    expect(model.collection).toBeNull();
  });

  it('prints on paper exactly what the model says', async () => {
    const model = await modelFor(harness, job);
    const text = await issuedText(harness, job);

    // The PDF sets its title in capitals; the words are the model's.
    expect(text.toUpperCase()).toContain(model.documentTitle.toUpperCase());
    expect(text).toContain(ORDER_NUMBER);
    expect(text).toContain(DELIVERY_NOTE);
    expect(text).toContain('Customer collection');
    expect(text).toContain('ENC-INC-1024');
    // A priced document, so the charges block is genuinely on it.
    expect(text).toContain(model.charges!.vatLabel);
    expect(text).toContain('Subtotal');
  });
});

describe('a courier collection', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = buildHarness();
    job = await partsJob(harness, { courier: true });
  });

  it('is titled a delivery note', async () => {
    const model = await modelFor(harness, job);
    expect(model.documentTitle).toBe('Delivery Note');
  });

  it('carries the waybill, which the screen used to leave off', async () => {
    const model = await modelFor(harness, job);
    const rows = new Map(model.jobDetails.map((row) => [row.label, row.value]));

    expect(rows.get('Collection')).toBe('Courier collection');
    expect(rows.get('Waybill')).toBe(WAYBILL);
    expect(rows.get('Delivery note')).toBe(DELIVERY_NOTE);
  });

  it('lists the goods without a single price, which the PDF used to leave off', async () => {
    const model = await modelFor(harness, job);

    expect(model.charges).toBeNull();
    expect(model.collection).not.toBeNull();
    expect(model.collection?.lines).toEqual([
      {
        partNumber: 'ENC-INC-1024',
        description: 'Incremental encoder, 1024 ppr',
        quantity: '2',
      },
    ]);
    expect(model.collection?.totalQuantity).toBe('2');
    // A count of goods, never a "Total" on a document with no money on it.
    expect(model.collection?.totalLabel).toBe('Items');
    expect(JSON.stringify(model.collection)).not.toContain('386');
    expect(JSON.stringify(model.collection)).not.toMatch(/R /);
  });

  it('prints the goods and the waybill, and no money at all', async () => {
    const text = await issuedText(harness, job);

    expect(text.toUpperCase()).toContain('DELIVERY NOTE');
    expect(text).toContain(WAYBILL);
    expect(text).toContain('Courier collection');
    // The goods the driver is carrying, which is the point of a delivery note.
    expect(text).toContain('ENC-INC-1024');
    expect(text).toContain('Items');

    for (const forbidden of ['VAT @', 'Subtotal', 'Amount', '3 860,00', '7 720,00']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/R [\d ]+,\d\d/);
  });
});

describe('a collection raised under CR-13 carries no description section', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('the model reports no description at all, rather than a placeholder', async () => {
    const job = await partsJob(harness, { courier: false });
    expect(job.faultDescription).toBe('');

    const model = await modelFor(harness, job);
    // Null, so both renderers skip the section. A placeholder string would
    // have printed a heading over "No fault description recorded."
    expect(model.faultDescription).toBeNull();
  });

  it('the issued PDF prints no Notes heading and no placeholder', async () => {
    const job = await partsJob(harness, { courier: false });
    const text = await issuedText(harness, job);

    expect(text).not.toContain('No fault description recorded');
    expect(text).not.toContain('Reported fault');
    // And it is a real collection note, not an empty document.
    expect(text).toContain('ENC-INC-1024');
  });

  it('a collection that WAS given one still prints it — older records are unchanged', async () => {
    const raised = await partsJob(harness, { courier: false });
    const withNote = await harness.repos.jobs.save({
      ...raised,
      faultDescription: 'Spares for the Leadwell turret, collected at the counter.',
    });

    const model = await modelFor(harness, withNote);
    expect(model.faultDescription).toContain('Leadwell turret');
  });
});

describe('the waybill, enforced by the workflow rather than by a screen', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** A courier collection carrying no waybill, built through the repository. */
  const courierWithoutWaybill = async (): Promise<Job> => {
    const job = await partsJob(harness, { courier: true });
    // Written directly, because no operation permits it — which is exactly
    // what makes it the right fixture: the question is whether the READINESS
    // RULE refuses it, not whether one screen happens to.
    return harness.repos.jobs.save({ ...job, waybillNumber: '   ' });
  };

  it('blocks a courier collection with no waybill at the readiness gate', async () => {
    const job = await courierWithoutWaybill();

    const readiness = checkReadyForSignature(job);
    expect(readiness.allowed).toBe(false);
    expect(readiness.violations.map((violation) => violation.code)).toContain('waybill_required');
  });

  it('refuses to move such a job onto the signature step', async () => {
    const job = await courierWithoutWaybill();
    expect(await refusalCodes(startSignature(harness.as(master), job))).toContain(
      'waybill_required',
    );
  });

  it('refuses to capture a signature on such a job', async () => {
    const job = await courierWithoutWaybill();
    expect(
      await refusalCodes(
        captureSignature(harness.as(master), job, {
          customerName: 'Thabo',
          customerSurname: 'Dlamini',
          strokeData: 'M0,0 L1,1',
        }),
      ),
    ).toContain('waybill_required');
  });

  it('refuses to submit such a job', async () => {
    /*
     * A courier job that genuinely reached Review, then lost its waybill.
     *
     * Blanking it through the repository is the only way to produce this —
     * `setCollectionMethod` refuses it and the readiness gate above refuses it
     * — which is exactly what makes it the right fixture for the submission
     * gate: the question is whether issuing re-checks, or trusts that whatever
     * got the job this far must have been valid.
     */
    const valid = await partsJob(harness, { courier: true });
    const atSignature = await startSignature(harness.as(master), valid);
    const signed = await captureSignature(harness.as(master), atSignature, {
      customerName: 'Thabo',
      customerSurname: 'Dlamini',
      strokeData: 'M0,0 L1,1',
    });
    const job = await harness.repos.jobs.save({ ...signed, waybillNumber: '   ' });
    expect(job.status).toBe('review');

    const submission = checkReadyForSubmission(job);
    expect(submission.allowed).toBe(false);
    expect(submission.violations.map((violation) => violation.code)).toContain('waybill_required');

    expect(
      await refusalCodes(
        issueJobCard(harness.as(master), job, 'buyer@example-demo.co.za', 'ABC Engineering'),
      ),
    ).toContain('waybill_required');
  });

  it('lets a courier collection through once it has one', async () => {
    const job = await partsJob(harness, { courier: true });
    expect(checkReadyForSignature(job).allowed).toBe(true);
    await expect(startSignature(harness.as(master), job)).resolves.toBeDefined();
  });

  it('asks a customer collection for no waybill at all', async () => {
    const job = await partsJob(harness, { courier: false });
    expect(job.waybillNumber).toBe('');
    expect(checkReadyForSignature(job).allowed).toBe(true);
    expect(
      checkReadyForSignature(job).violations.map((violation) => violation.code),
    ).not.toContain('waybill_required');
  });

  it('asks a job nobody collects for no waybill either', async () => {
    const breakdown = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(
      checkReadyForSignature({ ...breakdown!, courierCollection: true }).violations.map(
        (violation) => violation.code,
      ),
    ).not.toContain('waybill_required');
  });
});
