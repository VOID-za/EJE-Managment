import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  saveCompletionReport,
  setCollectionMethod,
  startCompletion,
} from '@/application/job-operations';
import { createJob } from '@/application/job-creation';
import { loadJobView } from '@/application/job-view';
import { buildHarness, seedUser, type Harness } from '@/application/test-harness';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import type { Clock } from '@/services/ports';
import { renderJobCardPdf } from './job-card-pdf';

/**
 * THE PDF BUTTON ON THE REVIEW SCREENS PRODUCES THE RIGHT JOB CARD.
 *
 * `JobCardPdfButton` renders through `renderJobCardPdf`, the function the
 * inline preview uses too — so this proves the document the button opens: it
 * is a PDF, it is named for THIS job, and it carries what was saved on the job
 * — the Test & Repair "What is the Job?" fields and the collection answer
 * recorded at completion.
 */
const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const clock: Clock = { now: () => '2026-10-25T10:00:00.000Z' };

describe('the job card PDF behind the review-screen button', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  const workshopJobAtCompletion = async (courier: boolean) => {
    const context = harness.as(master);
    const [customer] = await harness.repos.customers.list();
    const sites = await harness.repos.customers.listSites(customer!.id);
    const contacts = await harness.repos.customers.listContacts(customer!.id);
    let job = await createJob(context, {
      customerId: customer!.id,
      siteId: sites[0]!.id,
      contactId: contacts[0]!.id,
      machineId: null,
      jobType: 'test_and_repair',
      priority: null,
      scheduledDate: null,
      scheduledEndDate: null,
      additionalTechnicianIds: [],
      orderNumber: '',
      referenceNumber: 'REF-55',
      deliveryNote: 'WB-778812',
      faultDescription: '',
      primaryTechnicianId: technician.id,
      courierCollection: false,
      dateReceived: '2026-10-20',
      repairItem: { partNumber: 'A06B-6117-H209', description: 'Spindle amplifier', quantity: 2 },
      quoteNumber: 'Q-20451',
    });
    const tech = harness.as(technician);
    job = await acceptJob(tech, job);
    job = await saveCompletionReport(tech, job, {
      ...job.completionReport,
      workPerformed: 'Bench tested and repaired.',
    });
    job = await addLabour(tech, job, { date: '2026-10-21', rateType: 'normal', hours: 2, description: '' });
    job = await startCompletion(tech, job);
    if (courier) job = await setCollectionMethod(tech, job, { courier: true, waybillNumber: 'DAW-4471' });
    return job;
  };

  it('is a PDF, named for this job', async () => {
    const job = await workshopJobAtCompletion(false);
    const view = await loadJobView(harness.repos, job.jobNumber);
    const rendered = await renderJobCardPdf(view!, new SimulatedPdfService(clock), clock);
    expect(new TextDecoder().decode(rendered.bytes.slice(0, 5))).toBe('%PDF-');
    expect(rendered.fileName).toContain(job.jobNumber);
    expect(rendered.pageCount).toBeGreaterThan(0);
  });

  it('carries the saved Test & Repair fields', async () => {
    const job = await workshopJobAtCompletion(false);
    const view = await loadJobView(harness.repos, job.jobNumber);
    const text = pdfPlainText((await renderJobCardPdf(view!, new SimulatedPdfService(clock), clock)).bytes);
    for (const expected of [
      job.jobNumber,
      'Date received',
      '2026-10-20',
      'A06B-6117-H209',
      'Spindle amplifier',
      'WB-778812',
      'REF-55',
      'Q-20451',
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it('carries the collection answer recorded at completion, not one made up at creation', async () => {
    const customer = pdfPlainText(
      (
        await renderJobCardPdf(
          (await loadJobView(harness.repos, (await workshopJobAtCompletion(false)).jobNumber))!,
          new SimulatedPdfService(clock),
          clock,
        )
      ).bytes,
    );
    expect(customer).toContain('Customer collection');

    const courierJob = await workshopJobAtCompletion(true);
    const courier = pdfPlainText(
      (
        await renderJobCardPdf(
          (await loadJobView(harness.repos, courierJob.jobNumber))!,
          new SimulatedPdfService(clock),
          clock,
        )
      ).bytes,
    );
    expect(courier).toContain('Courier collection');
  });
});
