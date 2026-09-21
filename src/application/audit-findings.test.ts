import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addAdditionalTechnician,
  assignPrimaryTechnician,
  captureSignature,
  issueJobCard,
  saveCompletionReport,
  startCompletion,
  startSignature,
  transferJobToTechnician,
} from './job-operations';
import { createJob } from './job-creation';
import { updateMachine } from './machine-operations';
import { updateCustomer, updateContact } from './customer-operations';
import { loadFinalDocumentFile } from './final-document';
import { buildHarness, confirmDelivery, seedUser, type Harness } from './test-harness';
import { asContactId, asCustomerId, asSiteId, asMachineId, type Job } from '@/domain';

/**
 * Regressions for the five faults the acceptance audit of fd12b03 found.
 *
 * Each one is written so it FAILS against the code as it was: none of them can
 * pass by accident, and none of them asserts on a screen — they go through the
 * operations, which is where the rules have to live.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const sipho = seedUser('user-tech-sipho');

/** Drives EJE-1048 through to a captured signature as its own technician. */
const workAndSign = async (harness: Harness): Promise<Job> => {
  const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
  const context = harness.as(sipho);

  let job = await acceptJob(context, opened!);
  job = await addLabour(context, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 2,
    description: 'Repair',
  });
  job = await saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the fan.',
  });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  return captureSignature(context, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });
};

const openFieldJob = async (harness: Harness): Promise<Job> => {
  const jobs = await harness.repos.jobs.list({ statuses: ['open'] });
  const job = jobs.find((candidate) => candidate.jobType !== 'parts');
  expect(job).toBeDefined();
  return job!;
};

describe('the job card goes to a contact, never to a company mailbox', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses to issue when the contact on the job has no email', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    // Take the address off the contact this job names.
    const contact = await harness.repos.customers.findContactById(opened!.contactId);
    await harness.repos.customers.saveContact({ ...contact!, email: '' });

    const signed = await workAndSign(harness);
    await expect(issueJobCard(harness.as(sipho), signed, '', 'Pieter Nel')).rejects.toThrow(
      /nobody to send the job card to/i,
    );

    // Refused BEFORE anything was produced: the job is still editable, so the
    // office can capture the address and issue normally.
    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reread!.status).toBe('review');
    expect(reread!.finalDocument).toBeNull();
    expect(reread!.delivery).toBeNull();
  });

  it('never falls back to the company address the customer record still carries', async () => {
    const customer = await harness.repos.customers.findById(asCustomerId('cust-abc'));
    // The legacy company address is still on the seeded customer record…
    expect(customer!.email.length).toBeGreaterThan(0);

    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const contact = await harness.repos.customers.findContactById(opened!.contactId);
    await harness.repos.customers.saveContact({ ...contact!, email: '' });

    const signed = await workAndSign(harness);

    // …and a fully worked, signed job with no contact address is refused rather
    // than quietly redirected to it. Nothing was sent.
    await expect(issueJobCard(harness.as(master), signed, '', 'Pieter Nel')).rejects.toThrow(
      /nobody to send the job card to/i,
    );
    expect(await harness.outbox.list()).toHaveLength(0);
  });
});

describe('a job is assigned to somebody who attends machines', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses to make the Coordinator the technician on a field job', async () => {
    const job = await openFieldJob(harness);
    await expect(
      assignPrimaryTechnician(harness.as(master), job, coordinator.id, 'Christene'),
    ).rejects.toThrow(/does not carry out field work/i);

    const reread = await harness.repos.jobs.findById(job.id);
    expect(reread!.primaryTechnicianId).not.toBe(coordinator.id);
  });

  it('refuses her as an additional technician too', async () => {
    const job = await openFieldJob(harness);
    await expect(
      addAdditionalTechnician(harness.as(master), job, coordinator.id, 'Christene'),
    ).rejects.toThrow(/does not carry out field work/i);
  });

  it('refuses a transfer to her', async () => {
    const job = await openFieldJob(harness);
    await expect(
      transferJobToTechnician(harness.as(master), job, coordinator.id, {
        reason: 'sick_or_unavailable',
        description: 'Testing that the office cannot be handed field work.',
      }),
    ).rejects.toThrow(/does not carry out field work/i);
  });

  it('refuses a technician assigning work at all', async () => {
    const job = await openFieldJob(harness);
    // Matched on the reason, not merely on "it threw": an availability clash
    // would also throw, and would prove nothing about authorisation.
    await expect(
      assignPrimaryTechnician(harness.as(sipho), job, seedUser('user-tech-lerato').id, 'Lerato'),
    ).rejects.toThrow(/cannot be assigned by you/i);
  });

  it('still allows a real technician', async () => {
    const job = await openFieldJob(harness);
    const saved = await assignPrimaryTechnician(harness.as(coordinator), job, sipho.id, 'Sipho');
    expect(saved.primaryTechnicianId).toBe(sipho.id);
  });
});

describe('raising a job is an operation, not a screen', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const INPUT = {
    customerId: asCustomerId('cust-abc'),
    siteId: asSiteId('site-abc-jhb'),
    contactId: asContactId('contact-abc-jhb'),
    machineId: asMachineId('machine-abc-lv40'),
    jobType: 'breakdown' as const,
    priority: 'normal' as const,
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: 'PO-1',
    referenceNumber: '',
    faultDescription: 'Spindle alarm.',
    primaryTechnicianId: null,
    courierCollection: false,
    deliveryNote: '',
    additionalTechnicianIds: [],
    attachments: [],
  };

  it('refuses a technician raising one, at the service layer', async () => {
    await expect(createJob(harness.as(sipho), INPUT)).rejects.toThrow(/raised by the office/i);
  });

  it('refuses raising one assigned to the office', async () => {
    await expect(
      createJob(harness.as(master), { ...INPUT, primaryTechnicianId: coordinator.id }),
    ).rejects.toThrow(/does not carry out field work/i);
  });

  it('raises one for the office, numbered and audited', async () => {
    const before = await harness.repos.settings.get();
    const job = await createJob(harness.as(coordinator), {
      ...INPUT,
      primaryTechnicianId: sipho.id,
    });

    expect(job.jobNumber).toBe(`${before.jobNumberPrefix}${before.nextJobSequence}`);
    expect(job.status).toBe('open');
    expect(job.createdBy).toBe(coordinator.id);

    // The sequence moved on, so the next job cannot take the same number.
    const after = await harness.repos.settings.get();
    expect(after.nextJobSequence).toBe(before.nextJobSequence + 1);

    const events = await harness.repos.activity.list(job.id);
    expect(events.some((event) => event.type === 'job_created')).toBe(true);
    expect(events.some((event) => event.type === 'job_assigned')).toBe(true);
    expect(events.every((event) => event.actorId === coordinator.id)).toBe(true);
  });
});

describe('the completion write-up leaves a trail', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('records who changed it, and says when the office did it for a technician', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const job = await acceptJob(harness.as(sipho), opened!);

    await saveCompletionReport(harness.as(coordinator), job, {
      ...job.completionReport,
      workPerformed: 'Telephoned in by the technician and typed up in the office.',
    });

    const events = await harness.repos.activity.list(job.id);
    const entry = events.find((event) => event.type === 'completion_report_saved');
    expect(entry).toBeDefined();
    expect(entry!.actorId).toBe(coordinator.id);
    expect(entry!.detail).toContain('workPerformed');
    expect(entry!.detail).toContain('Captured administratively');
  });

  it('does not record an event for a save that changed nothing', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const job = await acceptJob(harness.as(sipho), opened!);

    await saveCompletionReport(harness.as(sipho), job, { ...job.completionReport });

    const events = await harness.repos.activity.list(job.id);
    expect(events.filter((event) => event.type === 'completion_report_saved')).toHaveLength(0);
  });
});

describe('the issued document does not move, whatever the register does after', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('keeps identical bytes after the machine, machine number, customer and contact change', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const context = harness.as(sipho);

    let job = await acceptJob(context, opened!);
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Repair',
    });
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the fan.',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    const signed = await captureSignature(context, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    const issued = await issueJobCard(
      context,
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );
    const closed = await confirmDelivery(harness, context, issued.job);
    expect(closed.status).toBe('closed');

    const before = await loadFinalDocumentFile(harness.as(master), closed.jobNumber);

    // Everything §5 lists that is resolved from a live record, changed.
    const machine = await harness.repos.machines.findById(closed.machineId!);
    await updateMachine(harness.as(master), {
      ...machine!,
      machineNumber: 'STM9',
      serialNumber: 'CHANGED-AFTER-CLOSE',
      controlSystem: 'Something else',
    });
    const customer = await harness.repos.customers.findById(closed.customerId);
    await updateCustomer(harness.as(master), { ...customer!, name: 'Renamed After Close (Pty) Ltd' });
    const contact = await harness.repos.customers.findContactById(closed.contactId);
    await updateContact(harness.as(master), { ...contact!, firstName: 'Renamed' });

    const after = await loadFinalDocumentFile(harness.as(master), closed.jobNumber);

    expect(after.bytes.byteLength).toBe(before.bytes.byteLength);
    expect(Array.from(after.bytes)).toEqual(Array.from(before.bytes));
  });
});
