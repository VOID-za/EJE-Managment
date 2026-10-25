import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addPart,
  addTravel,
  recordSignatureRefusal,
  returnToCustomerSignature,
  saveCompletionReport,
  setCalloutApplied,
  startCompletion,
  startSignature,
  updateLabour,
  updateTravel,
} from './job-operations';
import { createJob } from './job-creation';
import { loadJobView } from './job-view';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { buildJobCardModel } from '@/lib/job-card/model';
import {
  asLineItemId,
  getJobTypeDefinition,
  JOB_TYPE_CODES,
  type Job,
  type User,
} from '@/domain';

/**
 * TECHNICIAN JOB CARDS, PARTS AND ORDINARY. Issue #73, Batch 2.
 *
 *  - An ORDINARY job keeps labour, travel kilometres, call-out and parts.
 *  - A PARTS job captures parts and additional charges only: no labour, no
 *    travel, no call-out, no completion write-up and no signature refusal —
 *    refused on the SERVER through every path, including the legacy edit
 *    paths, and left off the document.
 */
const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');

const codesOf = async (attempt: Promise<unknown>): Promise<readonly string[]> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof WorkflowError) return error.violations.map((violation) => violation.code);
    throw error;
  }
  throw new Error('expected a refusal');
};

const raiseParts = async (harness: Harness, actor: User = master): Promise<Job> => {
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);
  const job = await createJob(harness.as(actor), {
    customerId: customer!.id,
    siteId: sites[0]!.id,
    contactId: contacts[0]!.id,
    machineId: null,
    jobType: 'parts',
    priority: null,
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: 'PO-73-1',
    referenceNumber: '',
    deliveryNote: '',
    faultDescription: '',
    primaryTechnicianId: null,
    additionalTechnicianIds: [],
    courierCollection: false,
  });
  return addPart(harness.as(actor), job, {
    partNumber: 'ENC-1',
    description: 'Encoder',
    quantity: 1,
    unitPrice: 100_000,
  });
};

describe('the job type rules, stated once', () => {
  it('gives every type a write-up and a refusal workflow except a parts collection', () => {
    for (const code of JOB_TYPE_CODES) {
      const definition = getJobTypeDefinition(code);
      expect(definition.capturesCompletionWriteUp, code).toBe(code !== 'parts');
      expect(definition.allowsSignatureRefusal, code).toBe(code !== 'parts');
      expect(definition.capturesLabourAndTravel, code).toBe(code !== 'parts');
    }
  });
});

describe('a PARTS job, on the server', () => {
  let harness: Harness;
  let job: Job;
  beforeEach(async () => {
    harness = buildHarness();
    job = await raiseParts(harness);
  });

  it('refuses labour, travel and a call-out fee', async () => {
    expect(
      await codesOf(addLabour(harness.as(master), job, { date: '2026-10-20', rateType: 'normal', hours: 1, description: '' })),
    ).toContain('not_applicable_to_job_type');
    expect(
      await codesOf(addTravel(harness.as(master), job, { date: '2026-10-20', kilometres: 10, description: '' })),
    ).toContain('not_applicable_to_job_type');
    expect(await codesOf(setCalloutApplied(harness.as(master), job, true))).toContain(
      'not_applicable_to_job_type',
    );
  });

  it('refuses a completion write-up', async () => {
    expect(
      await codesOf(
        saveCompletionReport(harness.as(master), job, {
          ...job.completionReport,
          workPerformed: 'Handed over the encoder.',
        }),
      ),
    ).toContain('not_applicable_to_job_type');
    expect((await harness.repos.jobs.findById(job.id))?.completionReport.workPerformed).toBe('');
  });

  it('refuses a signature refusal', async () => {
    // At the collector's signature, where a refusal would be recorded.
    const atSignature = await startSignature(harness.as(master), job);
    expect(
      await codesOf(recordSignatureRefusal(harness.as(master), atSignature, { reason: 'Wrong part.' })),
    ).toContain('not_applicable_to_job_type');
    const stored = await harness.repos.jobs.findById(job.id);
    expect(stored?.signatureRefusals).toHaveLength(0);
    expect(stored?.status).toBe('customer_signature');
  });

  it('refuses the LEGACY edit paths for labour and travel lines too', async () => {
    // A parts job that carries lines from before the server refused them.
    const legacy = await harness.repos.jobs.save({
      ...job,
      labour: [
        {
          id: asLineItemId('lab-legacy'),
          technicianId: technician.id,
          date: '2026-09-01',
          rateType: 'normal',
          hours: 1,
          description: '',
          capturedAt: '2026-09-01T10:00:00.000Z',
          capturedBy: master.id,
        },
      ],
      travel: [
        {
          id: asLineItemId('trv-legacy'),
          technicianId: technician.id,
          date: '2026-09-01',
          kilometres: 12,
          description: '',
          capturedAt: '2026-09-01T10:00:00.000Z',
          capturedBy: master.id,
        },
      ],
    });
    expect(
      await codesOf(
        updateLabour(harness.as(master), legacy, 'lab-legacy', { date: '2026-09-01', rateType: 'overtime', hours: 3, description: '' }),
      ),
    ).toContain('not_applicable_to_job_type');
    expect(
      await codesOf(
        updateTravel(harness.as(master), legacy, 'trv-legacy', { date: '2026-09-01', kilometres: 99, description: '' }),
      ),
    ).toContain('not_applicable_to_job_type');
    const stored = await harness.repos.jobs.findById(job.id);
    expect(stored?.labour[0]?.hours).toBe(1);
    expect(stored?.travel[0]?.kilometres).toBe(12);
  });

  it('still takes parts and additional charges — what it captures', async () => {
    const more = await addPart(harness.as(master), job, {
      partNumber: 'SEAL-2',
      description: 'Seal kit',
      quantity: 2,
      unitPrice: 5_000,
    });
    expect(more.parts).toHaveLength(2);
  });

  it('a refusal recorded BEFORE this rule can still be resolved — no job is stranded', async () => {
    const atSignature = await startSignature(harness.as(master), job);
    const legacy = await harness.repos.jobs.save({
      ...atSignature,
      status: 'review',
      signatureRefusals: [
        {
          refused: true,
          reason: 'Recorded before issue #73.',
          recordedBy: master.id,
          recordedAt: '2026-10-01T10:00:00.000Z',
          resolvedBy: null,
          resolvedAt: null,
          resolution: null,
          resolutionNote: '',
        },
      ],
    } as Job);
    const returned = await returnToCustomerSignature(harness.as(master), legacy, '');
    expect(returned.status).toBe('customer_signature');
  });

  it('prints no write-up on its document, whatever its fields hold', async () => {
    // Text left on the record from before the server refused it.
    await harness.repos.jobs.save({
      ...job,
      completionReport: { ...job.completionReport, workPerformed: 'Old text typed before the rule.' },
    });
    const view = await loadJobView(harness.repos, job.jobNumber);
    const model = buildJobCardModel({
      job: view!.job,
      customer: view!.customer,
      site: view!.site,
      contact: view!.contact,
      machine: view!.machine,
      settings: view!.settings,
      checklistTemplate: view!.checklistTemplate,
      users: view!.users,
      generatedAt: '2026-10-25T10:00:00.000Z',
    });
    expect(model.workBlocks).toEqual([]);
  });
});

describe('an ORDINARY job keeps everything it always captured', () => {
  it('takes labour, travel kilometres, a call-out fee, parts and the write-up', async () => {
    const harness = buildHarness();
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const tech = harness.as(technician);
    let job = await acceptJob(tech, opened!);
    job = await addLabour(tech, job, { date: '2026-10-20', rateType: 'overtime', hours: 2, description: '' });
    job = await addTravel(tech, job, { date: '2026-10-20', kilometres: 48, description: '' });
    job = await setCalloutApplied(tech, job, true);
    job = await addPart(tech, job, { partNumber: 'FAN-1', description: 'Fan', quantity: 1, unitPrice: 50_000 });
    job = await saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Fitted the fan.' });
    job = await startCompletion(tech, job);

    expect(job.labour[0]?.rateType).toBe('overtime');
    expect(job.travel[0]?.kilometres).toBe(48);
    expect(job.calloutApplied).toBe(true);
    expect(job.parts).toHaveLength(1);
    expect(job.completionReport.workPerformed).toBe('Fitted the fan.');

    // And the edit paths still work on an ordinary job.
    const edited = await updateLabour(tech, job, job.labour[0]!.id, {
      date: '2026-10-20',
      rateType: 'double',
      hours: 3,
      description: '',
    });
    expect(edited.labour[0]?.rateType).toBe('double');
    const travelled = await updateTravel(tech, edited, edited.travel[0]!.id, {
      date: '2026-10-20',
      kilometres: 52,
      description: '',
    });
    expect(travelled.travel[0]?.kilometres).toBe(52);
  });

  it('lets the TECHNICIAN on the job write the write-up — it is not a Master feature', async () => {
    const harness = buildHarness();
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const tech = harness.as(technician);
    const job = await acceptJob(tech, opened!);
    const saved = await saveCompletionReport(tech, job, {
      ...job.completionReport,
      faultFindings: 'Bearing noise.',
    });
    expect(saved.completionReport.faultFindings).toBe('Bearing noise.');
    // And a technician who is NOT on the job cannot.
    const other = seedUser('user-tech-lerato');
    expect(
      await codesOf(saveCompletionReport(harness.as(other), saved, { ...saved.completionReport, diagnosis: 'x' })),
    ).toContain('not_on_job');
  });
});
