import { describe, expect, it } from 'vitest';
import { calculateJobTotals, type JobTypeCode } from '@/domain';
import { buildJobCardModel } from '@/lib/job-card/model';
import { addPart, acceptJob } from './job-operations';
import { createJob } from './job-creation';
import { loadJobView } from './job-view';
import { buildHarness, seedUser } from './test-harness';

/**
 * PARTS-MULTI-1 (27 October 2026). Staff reported that only one part could be
 * added to a Parts or a Test & Repair job. The server never imposed a limit;
 * the dialog reopened holding the first part. These prove there is no limit
 * anywhere below the screen: every line is kept, priced and printed.
 */
const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');

const raise = async (jobType: JobTypeCode) => {
  const harness = buildHarness();
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);
  const machines = (await harness.repos.machines.list()).filter((machine) => machine.customerId === customer!.id);
  const job = await createJob(harness.as(master), {
    customerId: customer!.id,
    siteId: sites[0]!.id,
    contactId: contacts[0]!.id,
    machineId: jobType === 'parts' ? null : (machines[0]?.id ?? null),
    jobType,
    priority: null,
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: 'PO-MULTI',
    referenceNumber: '',
    deliveryNote: '',
    faultDescription: '',
    primaryTechnicianId: jobType === 'parts' ? null : technician.id,
    additionalTechnicianIds: [],
    courierCollection: false,
  });
  return { harness, job };
};

const PARTS = [
  { partNumber: 'ENC-1', description: 'Encoder', quantity: 1, unitPrice: 100_000 },
  { partNumber: 'SEAL-2', description: 'Seal kit', quantity: 3, unitPrice: 5_000 },
  { partNumber: 'FAN-3', description: 'Fan', quantity: 2, unitPrice: 12_500 },
];

describe.each(['parts', 'test_and_repair'] as const)('several parts on a %s job', (jobType) => {
  it('keeps every line, prices each, totals them, and prints them all', async () => {
    const { harness, job: created } = await raise(jobType);
    const actor = jobType === 'parts' ? master : technician;
    let job = jobType === 'parts' ? created : await acceptJob(harness.as(actor), created);
    for (const part of PARTS) job = await addPart(harness.as(actor), job, part);

    const reloaded = (await harness.repos.jobs.findByJobNumber(job.jobNumber))!;
    expect(reloaded.parts.map((part) => [part.partNumber, part.quantity, part.unitPrice])).toEqual(
      PARTS.map((part) => [part.partNumber, part.quantity, part.unitPrice]),
    );

    const settings = await harness.repos.settings.get();
    const totals = calculateJobTotals(reloaded, settings);
    expect(totals.partsTotal).toBe(100_000 + 3 * 5_000 + 2 * 12_500);

    const view = (await loadJobView(harness.repos, job.jobNumber))!;
    const model = buildJobCardModel({ ...view, generatedAt: '2026-10-27T10:00:00.000Z' });
    const printed = [...(model.charges?.rows ?? []), ...(model.collection?.lines ?? [])].map((row) =>
      'partNumber' in row ? row.partNumber : row.description,
    );
    for (const part of PARTS) expect(printed).toContain(part.partNumber);
  });
});
