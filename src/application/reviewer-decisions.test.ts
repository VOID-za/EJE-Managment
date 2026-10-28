import { beforeEach, describe, expect, it } from 'vitest';
import type { Job, JobTypeCode } from '@/domain';
import { businessToday } from '@/lib/business-time';
import { formatCurrency } from '@/lib/format';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { buildJobCardModel } from '@/lib/job-card/model';
import {
  canonicalJson,
  documentIdentityFor,
  identifiedContent,
  sha256Hex,
} from '@/lib/job-card/document-identity';
import { courierSignatureReference } from '@/lib/job-card/delivery-note';
import { DemoStorageService, inMemoryFileStore } from '@/services/simulated/storage';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { renderJobCardPdf } from '@/components/jobs/job-card-pdf';
import { loadTimesheet, saveTimesheetEntry } from './timesheets';
import {
  acceptJob,
  addLabour,
  addPart,
  cancelCompletion,
  captureSignature,
  issueJobCard,
  removeLineItem,
  saveCompletionReport,
  setCollectionMethod,
  startCompletion,
  startSignature,
  updatePart,
} from './job-operations';
import { acceptOfflineSignature } from './offline-signature';
import { createJob } from './job-creation';
import { loadJobView } from './job-view';
import { loadFinalDocumentFile } from './final-document';
import { generateDeliveryNote, issueDeliveryNote } from './delivery-note';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * THE OWNER'S DECISIONS OF 28 OCTOBER 2026 ON THE REVIEWER'S FEEDBACK.
 *
 * Shared call-outs are split by hand; parts lock at completion on every job
 * type with an In Progress stage; and a courier collection has a priced job
 * card AND a price-less Delivery Note, signed ONCE — on the Delivery Note —
 * with that one signature carried by both, online and offline, with a stale
 * tablet's capture quarantined rather than misattached. (The timesheet period,
 * its PDF Layout columns and the office notification are in
 * reviewer-feedback.test.ts, beside the rest of the timesheet.)
 */
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const master = seedUser('user-master-elmarie');

const day = (offset: number): string => {
  const date = new Date(`${businessToday()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
};

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const events = async (type: string) =>
  (await harness.repos.activity.list()).filter((event) => event.type === type);

// ---------------------------------------------------------------------------
describe('TS-08 — a shared call-out is split BY HAND; nothing divides it', () => {
  it('two technicians each enter their own R500 of a R1 000 call-out, marked shared, and neither amount moves', async () => {
    const a = await saveTimesheetEntry(harness.as(sipho), sipho.id, {
      date: day(1), customerName: 'ABC Engineering', overtimeHours: 0, doubleHours: 0, calloutAmount: 50000, calloutShared: true,
    });
    const b = await saveTimesheetEntry(harness.as(riaan), riaan.id, {
      date: day(1), customerName: 'ABC Engineering', overtimeHours: 0, doubleHours: 0, calloutAmount: 50000, calloutShared: true,
    });
    expect([a.calloutAmount, b.calloutAmount, a.calloutShared, b.calloutShared]).toEqual([50000, 50000, true, true]);

    // A third line elsewhere, and a correction of one of them: still nothing redistributed.
    await saveTimesheetEntry(harness.as(sipho), sipho.id, {
      date: day(2), customerName: 'Kruger', overtimeHours: 1, doubleHours: 0, calloutAmount: 45000,
    });
    const corrected = await saveTimesheetEntry(harness.as(sipho), sipho.id, {
      entryId: a.id, date: day(1), customerName: 'ABC Engineering', overtimeHours: 0.5, doubleHours: 0, calloutAmount: 50000, calloutShared: true,
    });
    expect(corrected.calloutAmount).toBe(50000);
    expect((await harness.repos.attendance.findEntry(b.id))?.calloutAmount).toBe(50000);
    const sheet = await loadTimesheet(harness.as(sipho), sipho.id, day(2), day(1));
    expect(sheet.totals.calloutAmount).toBe(95000);
    expect(formatCurrency(corrected.calloutAmount)).toBe(formatCurrency(50000));
  });

  it('the normal money rules still apply: whole cents, never negative, within the ceiling', async () => {
    for (const bad of [50000.5, -1, 100_000_001]) {
      await expect(
        saveTimesheetEntry(harness.as(sipho), sipho.id, {
          date: day(1), customerName: 'ABC', overtimeHours: 0, doubleHours: 0, calloutAmount: bad, calloutShared: true,
        }),
      ).rejects.toMatchObject({ violations: [{ code: 'invalid_callout_amount' }] });
    }
  });
});

// ---------------------------------------------------------------------------
const raise = async (jobType: JobTypeCode, opts: { technician?: boolean } = {}): Promise<Job> => {
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);
  const machines = await harness.repos.machines.list();
  const machine = machines.find((m) => m.siteId === sites[0]!.id) ?? null;
  const needsMachine = jobType === 'installation' || jobType === 'service' || jobType === 'breakdown';
  return createJob(harness.as(master), {
    customerId: customer!.id, siteId: sites[0]!.id, contactId: contacts[0]!.id,
    machineId: needsMachine ? machine?.id ?? null : null,
    jobType,
    priority: jobType === 'parts' ? null : 'normal',
    scheduledDate: jobType === 'installation' || jobType === 'service' ? day(0) : null,
    scheduledEndDate: jobType === 'installation' ? day(0) : null,
    additionalTechnicianIds: [], orderNumber: '', referenceNumber: 'REF-1', deliveryNote: '',
    faultDescription: jobType === 'parts' ? '' : 'Work to do.',
    primaryTechnicianId: opts.technician === false || jobType === 'parts' ? null : sipho.id,
    courierCollection: false, dateReceived: null,
    repairItem: { partNumber: jobType === 'test_and_repair' ? 'A06B-6117' : '', description: jobType === 'test_and_repair' ? 'Spindle amplifier' : '', quantity: jobType === 'test_and_repair' ? 1 : null },
    quoteNumber: '',
  });
};

const workedToCompletion = async (jobType: JobTypeCode): Promise<Job> => {
  const tech = harness.as(sipho);
  let job = await acceptJob(tech, await raise(jobType));
  job = await addLabour(tech, job, { date: day(0), rateType: 'normal', hours: 2, description: '' });
  job = await addPart(tech, job, { partNumber: 'PSU-77', description: 'Power supply board', quantity: 2, unitPrice: 15000 });
  job = await saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Repaired and tested.' });
  return job;
};

describe('TR-01 extended — parts lock at completion on EVERY job type with an In Progress stage', () => {
  for (const jobType of ['breakdown', 'installation', 'service', 'test_and_repair'] as const) {
    it(`${jobType}: open in progress; refused at completion and at the signature on every mutation; open again only by Cancel completion; final once signed`, async () => {
      const tech = harness.as(sipho);
      let job = await workedToCompletion(jobType);
      expect(job.status).toBe('in_progress');
      job = await addPart(tech, job, { partNumber: 'OK-1', description: 'before completion', quantity: 1, unitPrice: 100 });
      expect(job.parts).toHaveLength(2);

      job = await startCompletion(tech, job);
      const locked = { violations: [{ code: 'parts_locked_after_completion' }] };
      const tryAll = async (current: Job) => {
        await expect(addPart(tech, current, { partNumber: 'X', description: 'late', quantity: 1, unitPrice: 1 })).rejects.toMatchObject(locked);
        await expect(updatePart(tech, current, current.parts[0]!.id, { partNumber: 'PSU-77', description: 'changed', quantity: 9, unitPrice: 1 })).rejects.toMatchObject(locked);
        await expect(removeLineItem(tech, current, 'part', current.parts[0]!.id)).rejects.toMatchObject(locked);
        // The office's administrative capture is held to it too.
        await expect(addPart(harness.as(master), current, { partNumber: 'X', description: 'late', quantity: 1, unitPrice: 1 })).rejects.toMatchObject(locked);
      };
      await tryAll(job);
      // The checklist step (installation/service) is irrelevant to the rule: start the signature where it can be.
      const atSignature = await startSignature(tech, job).catch(() => null);
      if (atSignature !== null) {
        job = atSignature;
        expect(job.status).toBe('customer_signature');
        await tryAll(job);
      }
      expect((await harness.repos.jobs.findById(job.id))?.parts).toHaveLength(2);

      // The legitimate way back, and parts open there.
      job = await cancelCompletion(tech, job);
      expect(job.status).toBe('in_progress');
      job = await addPart(tech, job, { partNumber: 'OK-2', description: 'after cancelling', quantity: 1, unitPrice: 100 });
      expect(job.parts).toHaveLength(3);
    });
  }

  it('a SIGNED job cannot be repriced: the signed-record rule refuses before the parts rule', async () => {
    const tech = harness.as(sipho);
    let job = await workedToCompletion('breakdown');
    job = await startCompletion(tech, job);
    job = await startSignature(tech, job);
    job = await captureSignature(tech, job, { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L1,1' });
    await expect(addPart(harness.as(master), job, { partNumber: 'X', description: 'late', quantity: 1, unitPrice: 1 })).rejects.toMatchObject({
      violations: [{ code: 'job_finalized' }],
    });
  });

  it('the one exception, from the architecture: a Parts job records its goods AT completion', async () => {
    const job = await raise('parts');
    expect(job.status).toBe('completion');
    const withGoods = await addPart(harness.as(master), job, { partNumber: 'FAN-24', description: 'Fan', quantity: 2, unitPrice: 48500 });
    expect(withGoods.parts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
const CUSTOMER_EMAIL = 'customer@example-demo.co.za';

/** A Test & Repair, completed and collected by a courier, at the signature step. */
const courierAtSignature = async (h: Harness = harness): Promise<Job> => {
  const tech = h.as(sipho);
  const previous = harness;
  harness = h;
  let job = await workedToCompletion('test_and_repair');
  harness = previous;
  job = await startCompletion(tech, job);
  job = await setCollectionMethod(tech, job, { courier: true, waybillNumber: 'DAW-4471' });
  return startSignature(tech, job);
};

const viewIdentity = async (h: Harness, job: Job): Promise<string> => {
  const view = await loadJobView(h.repos, job.jobNumber, sipho);
  return documentIdentityFor({
    job: view!.job, customer: view!.customer, site: view!.site, contact: view!.contact, machine: view!.machine,
    settings: view!.settings, checklistTemplate: view!.checklistTemplate, users: view!.users,
  });
};

/** What an OLD tablet build identified for this job: the job card, under jcm1. */
const staleJobCardIdentity = async (h: Harness, job: Job): Promise<string> => {
  const view = await loadJobView(h.repos, job.jobNumber, sipho);
  const model = buildJobCardModel({
    job: view!.job, customer: view!.customer, site: view!.site, contact: view!.contact, machine: view!.machine,
    settings: view!.settings, checklistTemplate: view!.checklistTemplate, users: view!.users,
    generatedAt: '1970-01-01T00:00:00.000Z',
  });
  return `jcm1:${await sha256Hex(new TextEncoder().encode(canonicalJson(identifiedContent(model, view!.job))))}`;
};

const STROKES = 'M10,10 L60,40 L110,12';

describe('PARTS-03/04 — courier collection: a priced job card and a Delivery Note, ONE signature', () => {
  it('online: the courier signs once; both documents are issued, stored, associated, and carry that one signature', async () => {
    const tech = harness.as(sipho);
    let job = await courierAtSignature();
    // The document identified for signing is the Delivery Note's.
    expect(await viewIdentity(harness, job)).toMatch(/^dln1:/u);
    job = await captureSignature(tech, job, { customerName: 'Johan', customerSurname: 'Pretorius', strokeData: STROKES });
    expect((await events('customer_signed')).filter((event) => event.jobId === job.id).length).toBe(1);

    const issued = await issueJobCard(tech, job, CUSTOMER_EMAIL, 'Marlene Fourie');
    expect(issued.job.status).toBe('office_handling');
    expect(issued.emailedTo).toBe(CUSTOMER_EMAIL);
    const finalCard = issued.job.finalDocument!;
    const note = await harness.repos.deliveryNotes.findByJob(job.id);
    expect(note).not.toBeNull();
    expect(note).toMatchObject({
      jobCardDocumentKey: finalCard.storageKey,
      signedByName: 'Johan Pretorius',
      signedAt: job.signature!.signedAt,
      signatureSha256: await sha256Hex(new TextEncoder().encode(STROKES)),
    });
    expect(note!.storageKey).not.toBe(finalCard.storageKey);

    // Document B: the priced job card, for the customer and the office.
    const card = pdfPlainText((await loadFinalDocumentFile(harness.as(master), job.jobNumber)).bytes);
    const reference = courierSignatureReference(job)!;
    for (const expected of ['PSU-77', 'R 300,00', 'Subtotal', 'Johan Pretorius', 'Delivery Note', reference]) {
      expect(card, expected).toContain(expected);
    }
    // Document A: the stored Delivery Note — goods, the same signature reference, no price.
    const stored = await harness.services.storage.getDocument(note!.storageKey);
    const noteText = pdfPlainText(stored!.bytes);
    for (const expected of ['DELIVERY NOTE', 'PSU-77', 'DAW-4471', 'Johan Pretorius', reference]) {
      expect(noteText, expected).toContain(expected);
    }
    expect(noteText).not.toMatch(/R[\s ]\d/u);
    expect(noteText).not.toContain('Subtotal');

    // Retrieving it later returns the ISSUED bytes, not a re-render.
    const again = await generateDeliveryNote(harness.as(master), issued.job);
    expect(again.issued).toBe(true);
    expect(Buffer.from(again.base64, 'base64').equals(Buffer.from(stored!.bytes))).toBe(true);
    // Still exactly one signing act on the trail.
    expect((await events('customer_signed')).filter((event) => event.jobId === job.id).length).toBe(1);
  });

  it('a retried issue never writes a second Delivery Note', async () => {
    const tech = harness.as(sipho);
    let job = await courierAtSignature();
    job = await captureSignature(tech, job, { customerName: 'Johan', customerSurname: 'Pretorius', strokeData: STROKES });
    const issued = await issueJobCard(tech, job, CUSTOMER_EMAIL, 'Marlene Fourie');
    const first = await harness.repos.deliveryNotes.findByJob(job.id);
    const view = await loadJobView(harness.repos, job.jobNumber);
    const second = await issueDeliveryNote(
      harness.as(sipho),
      { job: issued.job, customer: view!.customer, site: view!.site, contact: view!.contact, settings: view!.settings, users: view!.users },
      'jobcards/final/somewhere-else.pdf',
      '2026-10-28T12:00:00.000Z',
    );
    expect(second).toEqual(first);
  });

  it('offline: a signature held against the Delivery Note is accepted on sync and carried by the job card; a resend does not duplicate it', async () => {
    let job = await courierAtSignature();
    const input = {
      captureId: '00000000-0000-4000-8000-000000000001',
      documentIdentity: await viewIdentity(harness, job),
      pdfSha256: null,
      capturedAt: '2026-10-28T09:00:00.000Z',
      customerName: 'Johan',
      customerSurname: 'Pretorius',
      strokeData: STROKES,
    };
    const first = await acceptOfflineSignature(harness.as(sipho), job, 'signature', input);
    expect(first.outcome).toBe('accepted');
    job = (await harness.repos.jobs.findById(job.id))!;
    expect(job.signature?.strokeData).toBe(STROKES);
    // The same capture sent again (a retry, a second sync): accepted, not doubled.
    const again = await acceptOfflineSignature(harness.as(sipho), job, 'signature', input);
    expect(again.outcome).toBe('accepted');
    expect((await events('customer_signed')).filter((event) => event.jobId === job.id).length).toBe(1);
    // And it issues as one signature on both documents.
    await issueJobCard(harness.as(sipho), job, CUSTOMER_EMAIL, 'Marlene Fourie');
    expect((await harness.repos.deliveryNotes.findByJob(job.id))?.signedByName).toBe('Johan Pretorius');
  });

  it('a STALE tablet build that identified the job card for a courier collection is QUARANTINED to Field Captures, never attached', async () => {
    const job = await courierAtSignature();
    const outcome = await acceptOfflineSignature(harness.as(sipho), job, 'signature', {
      captureId: '00000000-0000-4000-8000-000000000002',
      documentIdentity: await staleJobCardIdentity(harness, job),
      pdfSha256: null,
      capturedAt: '2026-10-28T09:00:00.000Z',
      customerName: 'Johan',
      customerSurname: 'Pretorius',
      strokeData: STROKES,
    });
    expect(outcome).toMatchObject({ outcome: 'referred', reason: 'document_changed' });
    const after = (await harness.repos.jobs.findById(job.id))!;
    expect(after.signature).toBeNull();
    expect(after.status).toBe('customer_signature');
  });

  it('a non-courier collection is unchanged: the job card is identified (jcm1) and signed as before', async () => {
    const tech = harness.as(sipho);
    let job = await workedToCompletion('test_and_repair');
    job = await startCompletion(tech, job);
    job = await setCollectionMethod(tech, job, { courier: false, waybillNumber: '' });
    job = await startSignature(tech, job);
    expect(await viewIdentity(harness, job)).toMatch(/^jcm1:/u);
    const outcome = await acceptOfflineSignature(harness.as(sipho), job, 'signature', {
      captureId: '00000000-0000-4000-8000-000000000003',
      documentIdentity: await viewIdentity(harness, job),
      pdfSha256: null,
      capturedAt: '2026-10-28T09:00:00.000Z',
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: STROKES,
    });
    expect(outcome.outcome).toBe('accepted');
    const issued = await issueJobCard(tech, (await harness.repos.jobs.findById(job.id))!, CUSTOMER_EMAIL, 'Pieter Nel');
    expect(await harness.repos.deliveryNotes.findByJob(issued.job.id)).toBeNull();
  });

  it('if the Delivery Note cannot be stored, NOTHING is issued: no handover is reported with a document missing', async () => {
    const files = inMemoryFileStore();
    const real = new DemoStorageService(files);
    const failing = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      getDocument: (key: string) => (key.endsWith('-delivery-note.pdf') ? Promise.resolve(null) : real.getDocument(key)),
    }) as DemoStorageService;
    const h = buildHarness({ storage: failing });
    let job = await courierAtSignature(h);
    job = await captureSignature(h.as(sipho), job, { customerName: 'Johan', customerSurname: 'Pretorius', strokeData: STROKES });
    await expect(issueJobCard(h.as(sipho), job, CUSTOMER_EMAIL, 'Marlene Fourie')).rejects.toMatchObject({
      violations: [{ code: 'delivery_note_not_stored' }],
    });
    const after = (await h.repos.jobs.findById(job.id))!;
    expect(after.finalDocument).toBeNull();
    expect(after.status).not.toBe('office_handling');
    expect(await h.repos.deliveryNotes.findByJob(job.id)).toBeNull();
    // The signature is not lost: it stays on the job for the retry.
    expect(after.signature?.strokeData).toBe(STROKES);
  });

  it('an existing issued job card is untouched by any of this: its stored bytes are returned exactly', async () => {
    const tech = harness.as(sipho);
    let job = await workedToCompletion('breakdown');
    job = await startCompletion(tech, job);
    job = await startSignature(tech, job);
    job = await captureSignature(tech, job, { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L1,1' });
    await issueJobCard(tech, job, CUSTOMER_EMAIL, 'Pieter Nel');
    const first = await loadFinalDocumentFile(harness.as(master), job.jobNumber);
    const second = await loadFinalDocumentFile(harness.as(master), job.jobNumber);
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
    // A preview render of the same job is a different file; the stored one is what is served.
    const view = await loadJobView(harness.repos, job.jobNumber);
    const clock = { now: () => '2030-01-01T00:00:00.000Z' };
    const preview = await renderJobCardPdf(view!, new SimulatedPdfService(clock), clock, new Map());
    expect(Buffer.from(preview.bytes).equals(Buffer.from(first.bytes))).toBe(false);
  });
});

