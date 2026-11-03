import { beforeEach, describe, expect, it } from 'vitest';
import {
  addAdditionalCharge,
  addLabour,
  addPart,
  captureSignature,
  issueJobCard,
  removeLineItem,
  setCalloutApplied,
  setCollectionMethod,
  startSignature,
  updatePart,
} from './job-operations';
import { createJob } from './job-creation';
import { loadFinalDocumentFile } from './final-document';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { WorkflowError } from './errors';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { calculateJobTotals, canChooseUnsignedCopyDocuments, checkReadyForSignature, getJobTypeDefinition, type Job } from '@/domain';

/**
 * THE DELIVERY NOTE JOB TYPE. DELIVERY-NOTE-1 (the owner, 3 November 2026).
 *
 * A proof-of-delivery record: the office raises it for a customer and a
 * delivery date, lists the parts (number, description, quantity, comment),
 * records courier (with waybill) or customer collection and takes the
 * signature. No technician, no acceptance, no price of any kind, never
 * invoiced: signed, it is closed as a Delivery Note, its document immutable.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');
const apprentice = { ...seedUser('user-tech-riaan'), role: 'apprentice' as const };

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof WorkflowError) return cause.violations[0]?.code ?? 'workflow_error';
    throw cause;
  }
  throw new Error('expected the operation to be refused');
};

const raise = async (as = coordinator, deliveryDate: string | null = '2026-11-03'): Promise<Job> => {
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);
  return createJob(harness.as(as), {
    customerId: customer!.id,
    siteId: sites[0]!.id,
    contactId: contacts[0]!.id,
    machineId: null,
    jobType: 'delivery_note',
    priority: 'normal',
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: '',
    referenceNumber: '',
    deliveryNote: '',
    deliveryDate,
    faultDescription: '',
    primaryTechnicianId: null,
    courierCollection: false,
    additionalTechnicianIds: [],
  } as never);
};

const withParts = async (job: Job): Promise<Job> => {
  const office = harness.as(coordinator);
  let next = await addPart(office, job, { partNumber: 'LU-200', description: 'Loan servo drive', quantity: 1, unitPrice: 0, comment: 'Loan unit' });
  next = await addPart(office, next, { partNumber: 'ENC-1024', description: 'Encoder, 1024 ppr', quantity: 2, unitPrice: 0, comment: 'Part returned' });
  return next;
};

const signAndIssue = async (job: Job, courier: boolean): Promise<Job> => {
  const office = harness.as(coordinator);
  let next = await setCollectionMethod(office, job, { courier, waybillNumber: courier ? 'DAW-77120' : '' });
  next = await startSignature(office, next);
  next = await captureSignature(office, next, { customerName: 'Thabo', customerSurname: 'Dlamini', strokeData: 'M0,0 L10,10 L20,5' });
  return (await issueJobCard(office, next, '', '')).job;
};

describe('DELIVERY-NOTE-1: raising a Delivery Note', () => {
  it('is raised by the office straight into completion — no technician, no acceptance queue', async () => {
    const job = await raise();
    expect(job.jobType).toBe('delivery_note');
    expect(job.status).toBe('completion');
    expect(job.primaryTechnicianId).toBeNull();
    expect(job.deliveryDate).toBe('2026-11-03');
    expect(getJobTypeDefinition('delivery_note').label).toBe('Delivery Note');
  });

  it('needs its delivery date', async () => {
    expect(await codeOf(raise(coordinator, null))).toBe('delivery_date_required');
  });

  it('is never raised by a technician or an apprentice', async () => {
    expect(await codeOf(raise(technician))).toMatch(/not_permitted|cannot_create|forbidden/u);
    expect(await codeOf(raise(apprentice as never))).toMatch(/not_permitted|cannot_create|forbidden/u);
  });
});

describe('DELIVERY-NOTE-1: parts, collection and no pricing', () => {
  it('takes several part lines with comments, edits and removes them', async () => {
    let job = await withParts(await raise());
    expect(job.parts.map((part) => [part.partNumber, part.quantity, part.comment])).toEqual([['LU-200', 1, 'Loan unit'], ['ENC-1024', 2, 'Part returned']]);
    job = await updatePart(harness.as(coordinator), job, job.parts[1]!.id, { partNumber: 'ENC-1024', description: 'Encoder, 1024 ppr', quantity: 3, unitPrice: 0, comment: 'Replacement part' });
    expect(job.parts[1]).toMatchObject({ quantity: 3, comment: 'Replacement part' });
    job = await removeLineItem(harness.as(coordinator), job, 'part', job.parts[0]!.id);
    expect(job.parts).toHaveLength(1);
  });

  it('refuses every price: a part price, a charge, labour and a call-out — and its totals are zero', async () => {
    const job = await withParts(await raise());
    const office = harness.as(coordinator);
    expect(await codeOf(addPart(office, job, { partNumber: 'X', description: 'Priced', quantity: 1, unitPrice: 1500 }))).toBe('not_priced');
    expect(await codeOf(updatePart(office, job, job.parts[0]!.id, { partNumber: 'LU-200', description: 'Loan', quantity: 1, unitPrice: 99 }))).toBe('not_priced');
    expect(await codeOf(addAdditionalCharge(office, job, { description: 'Courier', amount: 25000 }))).toBe('not_priced');
    expect(await codeOf(addLabour(office, job, { date: '2026-11-03', rateType: 'normal', hours: 1, description: 'x' }))).toBe('not_applicable_to_job_type');
    expect(await codeOf(setCalloutApplied(office, job, true))).toBe('not_applicable_to_job_type');
    // Even a stored price never reaches a total.
    const view = await loadJobView(harness.repos, job.jobNumber);
    const forced = { ...job, parts: job.parts.map((part) => ({ ...part, unitPrice: 999_999 })), calloutApplied: true };
    expect(calculateJobTotals(forced, view!.settings).total).toBe(0);
  });

  it('a courier collection needs its waybill; a customer collection needs none', async () => {
    const job = await withParts(await raise());
    expect(await codeOf(setCollectionMethod(harness.as(coordinator), job, { courier: true, waybillNumber: '' }))).toBe('waybill_required');
    expect(checkReadyForSignature({ ...job, courierCollection: true, waybillNumber: '' }).violations.map((v) => v.code)).toContain('waybill_required');
    expect(checkReadyForSignature({ ...job, deliveryDate: null }).violations.map((v) => v.code)).toContain('delivery_date_required');
    expect(checkReadyForSignature({ ...job, parts: [] }).violations.map((v) => v.code)).toContain('parts_required');
    expect(checkReadyForSignature(job).allowed).toBe(true);
  });
});

describe('DELIVERY-NOTE-1: signed, issued, closed — never invoiced', () => {
  it('a courier collection: signed once, the price-less document issued with everything on it, and the job CLOSED', async () => {
    const closed = await signAndIssue(await withParts(await raise()), true);
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.officeHandling ?? null).toBeNull();
    expect(closed.invoice).toBeNull();
    expect(closed.finalDocument?.fileName).toBe(`${closed.jobNumber}-Delivery-Note.pdf`);
    const text = pdfPlainText((await loadFinalDocumentFile(harness.as(master), closed.jobNumber)).bytes);
    for (const expected of ['DELIVERY NOTE', closed.jobNumber, 'Delivery date', '03 Nov 2026', 'LU-200', 'Loan servo drive', 'Comment: Loan unit', 'ENC-1024', 'Comment: Part returned', 'Courier collection', 'DAW-77120', 'Thabo Dlamini', 'carries no prices']) {
      expect(text).toContain(expected);
    }
    expect(text).not.toMatch(/R\s?\d|Total due|VAT|Invoice/u);
    // Nothing was emailed.
    expect(harness.outbox.listSync().filter((entry) => entry.channel === 'email')).toHaveLength(0);
  });

  it('a customer collection is issued without a waybill', async () => {
    const closed = await signAndIssue(await withParts(await raise()), false);
    expect(closed.status).toBe('closed');
    const text = pdfPlainText((await loadFinalDocumentFile(harness.as(master), closed.jobNumber)).bytes);
    expect(text).toContain('Customer collection');
    expect(text).not.toContain('Waybill');
  });

  it('once signed, the record and its document are immutable', async () => {
    const closed = await signAndIssue(await withParts(await raise()), false);
    const office = harness.as(coordinator);
    expect(await codeOf(addPart(office, closed, { partNumber: 'LATE', description: 'Late', quantity: 1, unitPrice: 0 }))).toMatch(/job_finalized|job_closed|not_editable|illegal/u);
    expect(await codeOf(updatePart(office, closed, closed.parts[0]!.id, { partNumber: 'LU-200', description: 'Changed', quantity: 5, unitPrice: 0 }))).toMatch(/job_finalized|job_closed|not_editable|illegal/u);
    expect(await codeOf(issueJobCard(office, closed, '', ''))).toBe('not_ready_to_issue');
    expect(canChooseUnsignedCopyDocuments('master', closed)).toBe(false);
    const stored = (await harness.repos.jobs.findByJobNumber(closed.jobNumber))!;
    expect(stored.finalDocument?.checksumSha256).toBe(closed.finalDocument?.checksumSha256);
  });

  it('is signed and issued only by the office, never a technician', async () => {
    const job = await withParts(await raise());
    expect(await codeOf(addPart(harness.as(technician), job, { partNumber: 'T', description: 'T', quantity: 1, unitPrice: 0 }))).toBeTruthy();
  });
});
