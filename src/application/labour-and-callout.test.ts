import { beforeEach, describe, expect, it } from 'vitest';
import { buildJobCardModel } from '@/lib/job-card/model';
import {
  acceptJob,
  addLabour,
  setCalloutApplied,
  saveCompletionReport,
  updateLabour,
} from './job-operations';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { calculateJobTotals, type Job, type SystemSettings } from '@/domain';

/**
 * LABOUR IS HOURS; THE WRITE-UP IS WORDS. MASTER SCOPE LAB-1, COST-CALLOUT.
 *
 * The labour line's "Description of work" was asking the technician to describe
 * the job a second time, in a second place, on the same document as the
 * completion write-up — so a customer's job card could carry two different
 * accounts of what was done. The input is gone. The FIELD is not: lines
 * captured before the change keep what was written on them, and the document
 * still prints it, because rewriting history to match a new form is not a
 * migration anybody asked for.
 *
 * The call-out fee moved under Parts. That is where it is on the screen and
 * nowhere else: the rule, the rate and the arithmetic are untouched, which is
 * what the pricing cases here hold.
 */

const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');

/** The current charge-out rates, which is what an unsigned job prices at. */
let settings: SystemSettings;
const totals = (job: Job) => calculateJobTotals(job, settings);

const started = async (harness: Harness): Promise<Job> => {
  const context = harness.as(technician);
  const view = await loadJobView(harness.repos, 'EJE-1048');
  const job = await acceptJob(context, view!.job);
  return saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Stripped and rebuilt the spindle drive cooling circuit.',
  });
};

describe('labour without a description', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = buildHarness();
    settings = await harness.repos.settings.get();
    job = await started(harness);
  });

  it('is accepted, and prices exactly as a described line does', async () => {
    const plain = await addLabour(harness.as(technician), job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: '',
    });
    const described = await addLabour(harness.as(technician), plain, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Spindle drive repair',
    });

    const priced = totals(described);
    expect(described.labour).toHaveLength(2);
    expect(priced.labourLines[0]?.total).toBe(priced.labourLines[1]?.total);
    expect(priced.totalHours).toBe(6);
  });

  it('leaves the charge row’s detail empty rather than inventing one', async () => {
    const withLabour = await addLabour(harness.as(technician), job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: '',
    });
    const view = await loadJobView(harness.repos, 'EJE-1048');
    const model = buildJobCardModel({
      job: withLabour,
      customer: view!.customer,
      site: view!.site,
      contact: view!.contact,
      machine: view!.machine,
      settings: view!.settings,
      checklistTemplate: view!.checklistTemplate,
      users: view!.users,
      generatedAt: '2026-09-25T10:00:00.000Z',
    });

    const labourRow = model.charges?.rows[0];
    expect(labourRow?.quantity).toBe('2.00 hrs');
    expect(labourRow?.detail).toBe('');
  });

  it('KEEPS a historical description when the hours on that line are amended', async () => {
    /*
     * The case the removal must not break. A line captured under the old form
     * carries words; correcting the hours on it must not silently wipe them,
     * because the customer's job card prints them and the document on file
     * would then disagree with the record.
     */
    const withLabour = await addLabour(harness.as(technician), job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Fault finding on the spindle drive and control cabinet',
    });
    const lineId = withLabour.labour.at(-1)!.id;

    const amended = await updateLabour(harness.as(master), withLabour, lineId, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3.5,
      // What the dialog now sends for an existing line: the value it was given.
      description: 'Fault finding on the spindle drive and control cabinet',
    });

    expect(amended.labour.at(-1)?.hours).toBe(3.5);
    expect(amended.labour.at(-1)?.description).toBe(
      'Fault finding on the spindle drive and control cabinet',
    );
  });
});

describe('the call-out fee, after moving under Parts', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = buildHarness();
    settings = await harness.repos.settings.get();
    job = await addLabour(harness.as(technician), await started(harness), {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: '',
    });
  });

  it('is off until somebody turns it on — never inferred from the job type', () => {
    expect(job.jobType).toBe('breakdown');
    expect(job.calloutApplied).toBe(false);
    expect(totals(job).calloutTotal).toBe(0);
  });

  it('adds exactly the call-out rate to the subtotal, and nothing else', async () => {
    const before = totals(job);
    const charged = await setCalloutApplied(harness.as(technician), job, true);
    const after = totals(charged);

    expect(charged.calloutApplied).toBe(true);
    expect(after.calloutTotal).toBe(after.pricing.calloutRate);
    expect(after.subtotal).toBe(before.subtotal + after.pricing.calloutRate);
    expect(after.labourTotal).toBe(before.labourTotal);
    expect(after.travelTotal).toBe(before.travelTotal);
    expect(after.partsTotal).toBe(before.partsTotal);
  });

  it('can be taken off again, restoring the original total to the cent', async () => {
    const before = totals(job);
    const charged = await setCalloutApplied(harness.as(technician), job, true);
    const cleared = await setCalloutApplied(harness.as(technician), charged, false);

    expect(cleared.calloutApplied).toBe(false);
    expect(totals(cleared).total).toBe(before.total);
  });

  it('prints as its own charge row when applied, and no row when not', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1048');
    const render = (subject: Job) =>
      buildJobCardModel({
        job: subject,
        customer: view!.customer,
        site: view!.site,
        contact: view!.contact,
        machine: view!.machine,
        settings: view!.settings,
        checklistTemplate: view!.checklistTemplate,
        users: view!.users,
        generatedAt: '2026-09-25T10:00:00.000Z',
      });

    expect(
      render(job).charges?.rows.some((row) => row.description === 'Call-out'),
    ).toBe(false);

    const charged = await setCalloutApplied(harness.as(technician), job, true);
    expect(
      render(charged).charges?.rows.some((row) => row.description === 'Call-out'),
    ).toBe(true);
  });
});
