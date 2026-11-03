import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addAdditionalCharge,
  addDeliveryNoteReferencePhoto,
  addPart,
  captureSignature,
  issueJobCard,
  setCollectionMethod,
  setMediaVisibility,
  startSignature,
} from './job-operations';
import { createJob } from './job-creation';
import { editJobDetails } from './job-details';
import { loadJobView } from './job-view';
import { loadFinalDocumentFile } from './final-document';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { WorkflowError } from './errors';
import { buildJobCardModel, documentPhotos } from '@/lib/job-card/model';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { editableDetailFields, type Job } from '@/domain';

/**
 * TR-REF-PHOTO-1, DN-SITE-OPT-1, DN-SIMPLIFY-1 (3 November 2026).
 *
 * The office photographs the delivery note that came in with a Test & Repair
 * job's parts — an INTERNAL reference for the technician, never on the job
 * card. And the Delivery Note gets simpler: no site needed, no order or
 * reference number, no Additional Charges.
 */
const coordinator = seedUser('user-coord-christene');
const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');

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

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

const register = async () => {
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);
  return { customer: customer!, site: sites[0]!, contact: contacts.find((contact) => contact.siteId === null) ?? contacts[0]! };
};

const raise = async (jobType: Job['jobType'], over: Record<string, unknown> = {}, as = coordinator): Promise<Job> => {
  const { customer, site, contact } = await register();
  return createJob(harness.as(as), {
    customerId: customer.id, siteId: site.id, contactId: contact.id, machineId: null, jobType, priority: null,
    scheduledDate: null, scheduledEndDate: null, orderNumber: '', referenceNumber: '', deliveryNote: '',
    faultDescription: jobType === 'breakdown' ? 'Spindle fault.' : '', primaryTechnicianId: jobType === 'test_and_repair' ? technician.id : null,
    courierCollection: false, additionalTechnicianIds: [], deliveryDate: jobType === 'delivery_note' ? '2026-11-03' : null,
    ...over,
  } as never);
};

describe('TR-REF-PHOTO-1: the delivery-note photo on a Test & Repair job', () => {
  it('the office adds it as an INTERNAL reference; the technician sees it on the job', async () => {
    const job = await raise('test_and_repair');
    const saved = await addDeliveryNoteReferencePhoto(harness.as(coordinator), job, { fileName: 'delivery-note.jpg', contentType: 'image/jpeg', bytes: JPEG });
    const photo = saved.photos.find((item) => item.purpose === 'delivery_note_reference');
    expect(photo).toMatchObject({ kind: 'photo', visibility: 'internal', caption: 'Delivery note (reference)' });
    // The technician opening — then accepting — the job sees it.
    const seen = await loadJobView(harness.repos, job.jobNumber, technician);
    expect(seen?.job.photos.some((item) => item.id === photo!.id)).toBe(true);
    const accepted = await acceptJob(harness.as(technician), seen!.job);
    expect(accepted.photos.some((item) => item.id === photo!.id)).toBe(true);
  });

  it('is NEVER on the job card: excluded from the document photos and the model', async () => {
    const job = await raise('test_and_repair');
    const saved = await addDeliveryNoteReferencePhoto(harness.as(coordinator), job, { fileName: 'delivery-note.jpg', contentType: 'image/jpeg', bytes: JPEG });
    expect(documentPhotos(saved)).toHaveLength(0);
    // Even if it were (wrongly) marked customer-facing, it stays off the document.
    const forced: Job = { ...saved, photos: saved.photos.map((item) => ({ ...item, visibility: 'customer_facing' as const })) };
    expect(documentPhotos(forced)).toHaveLength(0);
    const view = (await loadJobView(harness.repos, job.jobNumber))!;
    const model = buildJobCardModel({ ...view, job: saved, generatedAt: '2026-11-03T10:00:00.000Z' });
    expect(JSON.stringify(model)).not.toContain('delivery-note.jpg');
  });

  it('stays internal: it cannot be shown to the customer', async () => {
    const job = await raise('test_and_repair');
    const saved = await addDeliveryNoteReferencePhoto(harness.as(coordinator), job, { fileName: 'delivery-note.jpg', contentType: 'image/jpeg', bytes: JPEG });
    const id = saved.photos.find((item) => item.purpose === 'delivery_note_reference')!.id;
    const accepted = await acceptJob(harness.as(technician), saved);
    expect(await codeOf(setMediaVisibility(harness.as(technician), accepted, id, 'customer_facing'))).toBe('reference_photo_internal');
  });

  it('is kept when the job’s details are edited', async () => {
    const job = await raise('test_and_repair');
    const saved = await addDeliveryNoteReferencePhoto(harness.as(coordinator), job, { fileName: 'delivery-note.jpg', contentType: 'image/jpeg', bytes: JPEG });
    const edited = await editJobDetails(harness.as(coordinator), saved, { changes: { orderNumber: 'PO-55' }, expected: { orderNumber: saved.orderNumber } });
    expect(edited.photos.filter((item) => item.purpose === 'delivery_note_reference')).toHaveLength(1);
  });

  it('only the office adds it, and only on a Test & Repair job', async () => {
    const job = await raise('test_and_repair');
    expect(await codeOf(addDeliveryNoteReferencePhoto(harness.as(technician), job, { fileName: 'x.jpg', contentType: 'image/jpeg', bytes: JPEG }))).toBe('not_permitted');
    const breakdown = await raise('breakdown');
    expect(await codeOf(addDeliveryNoteReferencePhoto(harness.as(coordinator), breakdown, { fileName: 'x.jpg', contentType: 'image/jpeg', bytes: JPEG }))).toBe('not_applicable_to_job_type');
  });
});

describe('DN-SITE-OPT-1 / DN-SIMPLIFY-1: the simpler Delivery Note', () => {
  it('is raised WITHOUT a site; the job opens with no site shown as one', async () => {
    const note = await raise('delivery_note', { siteId: null });
    expect(note.siteId).toBeNull();
    const view = await loadJobView(harness.repos, note.jobNumber);
    expect(view?.siteRecorded).toBe(false);
    expect(view?.site.name).toBe('No site recorded');
  });

  it('keeps a site that was chosen anyway', async () => {
    const { site } = await register();
    const note = await raise('delivery_note');
    expect(note.siteId).toBe(site.id);
  });

  it('every other job type still needs its site', async () => {
    for (const type of ['breakdown', 'test_and_repair', 'parts'] as const) {
      expect(await codeOf(raise(type, { siteId: null }))).toBe('site_required');
    }
  });

  it('records no order or reference number, whatever is sent, and offers neither for editing', async () => {
    const note = await raise('delivery_note', { siteId: null, orderNumber: 'PO-1', referenceNumber: 'REF-1' });
    expect([note.orderNumber, note.referenceNumber]).toEqual(['', '']);
    expect(editableDetailFields('delivery_note')).not.toContain('orderNumber');
    expect(editableDetailFields('delivery_note')).not.toContain('referenceNumber');
    expect(editableDetailFields('breakdown')).toContain('orderNumber');
  });

  it('takes no additional charge; signed and issued without a site, its document has no site line', async () => {
    let note = await raise('delivery_note', { siteId: null });
    const office = harness.as(coordinator);
    expect(await codeOf(addAdditionalCharge(office, note, { description: 'Courier', amount: 25000 }))).toBe('not_priced');
    note = await addPart(office, note, { partNumber: 'LU-200', description: 'Loan servo drive', quantity: 1, unitPrice: 0, comment: 'Loan unit' });
    note = await addPart(office, note, { partNumber: 'ENC-1024', description: 'Encoder', quantity: 2, unitPrice: 0, comment: 'Part returned' });
    note = await setCollectionMethod(office, note, { courier: false, waybillNumber: '' });
    note = await startSignature(office, note);
    note = await captureSignature(office, note, { customerName: 'Thabo', customerSurname: 'Dlamini', strokeData: 'M0,0 L10,10' });
    const closed = (await issueJobCard(office, note, '', '')).job;
    expect(closed.status).toBe('closed');
    const text = pdfPlainText((await loadFinalDocumentFile(harness.as(master), closed.jobNumber)).bytes);
    expect(text).toContain('LU-200');
    expect(text).toContain('Customer collection');
    expect(text).not.toContain('No site recorded');
  });
});
