import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  captureSignature,
  issueJobCard,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { removeSite, updateCustomer, updateSite } from './customer-operations';
import { removeMachine } from './machine-operations';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';
import type { Job } from '@/domain';

/**
 * WHAT A LATER REGISTER EDIT MAY AND MAY NOT CHANGE ABOUT A FINISHED JOB.
 *
 * The register is a living record: customers are renamed, sites are
 * reorganised, machines are withdrawn. A job carries the customer, site and
 * machine by IDENTIFIER, so the question these tests answer is which parts of a
 * finished job follow those records afterwards and which are fixed.
 *
 * TWO THINGS ARE FIXED, and they are the ones the customer has a copy of: the
 * issued PDF's bytes, and the pricing snapshot the signature froze. Those are
 * asserted here rather than argued, because they are what IMMUT-6 and CR-01
 * actually promise — the document EJE sent and the charges the customer signed.
 *
 * ONE THING IS NOT FIXED, and this pins it honestly rather than pretending
 * otherwise: the job SCREEN resolves the register live, so a customer renamed
 * today is shown under the new name on a job closed last year. Whether an
 * office screen should instead show the name as it was at the time is an open
 * question for EJE — it is the same question CUST-CR (#27) and MACH-HIST (#28)
 * circle, and it is not decided here. What this file refuses to allow is the
 * silent version of it: a register edit that changed the customer's own copy.
 *
 * AND A WITHDRAWN RECORD MUST NOT MAKE A JOB UNREADABLE. Archiving a site or
 * withdrawing a machine is an ordinary register action; a closed job pointing at
 * either still has to open, or EJE loses the ability to look at its own history
 * by tidying up.
 */
const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');

const workSignAndIssue = async (harness: Harness, jobNumber: string): Promise<Job> => {
  const opened = await harness.repos.jobs.findByJobNumber(jobNumber);
  if (opened === null) throw new Error(`${jobNumber} is not in the demonstration data`);

  const context = harness.as(technician);
  let job = await acceptJob(context, opened);
  job = await addLabour(context, job, {
    date: '2026-09-20',
    rateType: 'normal',
    hours: 2,
    description: 'Replaced the drive fan',
  });
  job = await saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the drive cooling fan and cleared the alarm.',
  });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  job = await captureSignature(context, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });
  const issued = await issueJobCard(context, job, 'accounts@example-demo.co.za', 'Pieter Nel');
  return issued.job;
};

describe('a register edit after the job card was issued', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('does not change one byte of the document the customer was sent', async () => {
    const issued = await workSignAndIssue(harness, 'EJE-1048');
    const key = issued.finalDocument?.storageKey ?? '';
    expect(key.length).toBeGreaterThan(0);

    const before = await harness.services.storage.getDocument(key);
    expect(before).not.toBeNull();

    const customer = await harness.repos.customers.findById(issued.customerId);
    expect(customer).not.toBeNull();
    await updateCustomer(harness.as(master), {
      ...customer!,
      name: 'ABC Engineering (Pty) Ltd — renamed after the fact',
    });

    const after = await harness.services.storage.getDocument(key);
    expect(after).not.toBeNull();
    // Byte for byte. The customer's copy and EJE's copy are the same file, and
    // a rename cannot reach inside it.
    expect(Buffer.from(after!.bytes).equals(Buffer.from(before!.bytes))).toBe(true);
    expect(after!.fileName).toBe(before!.fileName);
  });

  it('does not alter the charges the customer signed for', async () => {
    const issued = await workSignAndIssue(harness, 'EJE-1048');
    const frozen = issued.pricingSnapshot;
    expect(frozen).not.toBeNull();

    const site = (await harness.repos.customers.listSites(issued.customerId)).find(
      (candidate) => candidate.id === issued.siteId,
    );
    expect(site).toBeDefined();
    await updateSite(harness.as(master), { ...site!, name: 'Renamed site' });

    const reread = await harness.repos.jobs.findById(issued.id);
    expect(reread?.pricingSnapshot).toEqual(frozen);
  });

  /*
   * THE HONEST HALF. The screen resolves the register live, so the new name is
   * what an office screen shows for a closed job. That is current behaviour,
   * not a decision this test endorses — see the file header.
   */
  it('DOES show the new name on the screen, which is an open question and not a silent one', async () => {
    const issued = await workSignAndIssue(harness, 'EJE-1048');

    const customer = await harness.repos.customers.findById(issued.customerId);
    await updateCustomer(harness.as(master), { ...customer!, name: 'Renamed Engineering' });

    const view = await loadJobView(harness.repos, issued.jobNumber, master);
    expect(view?.customer.name).toBe('Renamed Engineering');
    // And the document that went to the customer still says what it said.
    expect(view?.job.finalDocument?.storageKey).toBe(issued.finalDocument?.storageKey);
  });

  it('still opens the job after its site has been withdrawn from the register', async () => {
    const issued = await workSignAndIssue(harness, 'EJE-1048');

    /*
     * The machine goes first, because the register refuses to withdraw a site
     * that still has machines standing on it — which is the right rule, and
     * means this test has to do what the office would do.
     */
    const machine = await harness.repos.machines.findById(issued.machineId!);
    await removeMachine(harness.as(master), machine!);

    const site = (await harness.repos.customers.listSites(issued.customerId)).find(
      (candidate) => candidate.id === issued.siteId,
    );
    await removeSite(harness.as(master), site!);

    const view = await loadJobView(harness.repos, issued.jobNumber, master);
    expect(view, 'archiving a site must not hide the jobs done at it').not.toBeNull();
    expect(view?.site.id).toBe(issued.siteId);
    expect(view?.site.archivedAt).not.toBeNull();
  });

  it('still opens the job after its machine has been withdrawn', async () => {
    const issued = await workSignAndIssue(harness, 'EJE-1048');
    expect(issued.machineId).not.toBeNull();

    const machine = await harness.repos.machines.findById(issued.machineId!);
    await removeMachine(harness.as(master), machine!);

    const view = await loadJobView(harness.repos, issued.jobNumber, master);
    expect(view, 'withdrawing a machine must not hide its service history').not.toBeNull();
    expect(view?.machine?.id).toBe(issued.machineId);
  });
});
