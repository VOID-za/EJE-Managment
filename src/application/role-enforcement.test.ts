import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addPart,
  issueJobCard,
  saveCompletionReport,
  startCompletion,
  startSignature,
  captureSignature,
} from './job-operations';
import { createCustomer, updateCustomer } from './customer-operations';
import { createMachine } from './machine-operations';
import { createUser, setUserActive } from './user-operations';
import { updateSettings } from './settings-operations';
import { loadClosedJobs, emptyClosedJobFilters } from './closed-jobs';
import { loadActivityFeed } from './activity-read';
import { runSearch } from './search';
import { WorkflowError } from './errors';
import { buildHarness, confirmDelivery, seedUser, type Harness } from './test-harness';
import { asCustomerId, asSiteId, type Job } from '@/domain';

/**
 * Authorisation, checked where it is actually enforced.
 *
 * Every assertion here calls an OPERATION or a READ, not a component. A screen
 * that hides a button proves nothing: the question is whether the system
 * refuses the work when the request arrives anyway, which is the only thing a
 * production API will be able to rely on.
 *
 * READS ARE COVERED TOO. They were not, and that was how the audit found four
 * screens whose only protection was a `can()` call rendered after the data had
 * already been loaded. A read that returns everything and trusts the caller to
 * show less is not authorised, it is merely tidy.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const sipho = seedUser('user-tech-sipho');
const lerato = seedUser('user-tech-lerato');

const NEW_CUSTOMER = {
  name: 'Strucmac Engineering',
  accountNumber: 'STM001',
  registrationNumber: '2015/112233/07',
  vatNumber: '4998877665',
  phone: '+27 11 555 0777',
  email: 'accounts@strucmac-demo.co.za',
  industry: 'Structural Fabrication',
  paymentTerms: '30 days',
  site: {
    name: 'Alberton',
    addressLine1: '9 Mill Road',
    addressLine2: '',
    city: 'Alberton',
    province: 'Gauteng',
    postalCode: '1449',
    accessNotes: '',
  },
  contact: null,
};

/** A seeded breakdown, open and assigned to Sipho. */
const openJobFor = async (harness: Harness, technicianId: string): Promise<Job> => {
  const jobs = await harness.repos.jobs.list({ statuses: ['open'] });
  const job = jobs.find((candidate) => candidate.jobType !== 'parts');
  expect(job).toBeDefined();
  return harness.repos.jobs.save({ ...job!, primaryTechnicianId: technicianId as Job['primaryTechnicianId'] });
};

describe('the Coordinator is an office role, not a field one', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses her a field job, whatever the screen offered', async () => {
    const job = await openJobFor(harness, sipho.id);
    const error = await acceptJob(harness.as(coordinator), job).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).violations[0]?.message).toMatch(
      /accepted by the technician attending/i,
    );
  });

  it('lets her process a parts collection end to end', async () => {
    const jobs = await harness.repos.jobs.list({ statuses: ['open'] });
    const parts = jobs.find((candidate) => candidate.jobType === 'parts');
    expect(parts).toBeDefined();

    let job = await acceptJob(harness.as(coordinator), {
      ...parts!,
      primaryTechnicianId: null,
    });
    job = await addPart(harness.as(coordinator), job, {
      partNumber: 'FAN-24V-80',
      description: 'Spindle drive cooling fan',
      quantity: 1,
      unitPrice: 48500,
    });
    job = await startCompletion(harness.as(coordinator), job);
    job = await startSignature(harness.as(coordinator), job);
    const signed = await captureSignature(harness.as(coordinator), job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    expect(signed.signature).not.toBeNull();
  });

  it('captures a technician’s work administratively without becoming the technician', async () => {
    const open = await openJobFor(harness, sipho.id);
    const job = await acceptJob(harness.as(sipho), open);

    const captured = await addLabour(harness.as(coordinator), job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Telephoned in by the technician',
    });

    const line = captured.labour.at(-1)!;
    // Whose work it is, and who wrote it down. Two different people.
    expect(line.technicianId).toBe(sipho.id);
    expect(line.capturedBy).toBe(coordinator.id);
    // And the job is still Sipho's.
    expect(captured.primaryTechnicianId).toBe(sipho.id);

    const events = await harness.repos.activity.list(job.id);
    const entry = events.find((event) => event.type === 'labour_added');
    expect(entry?.actorId).toBe(coordinator.id);
    expect(entry?.detail).toContain('Captured administratively');
  });

  it('manages customers and machines', async () => {
    const created = await createCustomer(harness.as(coordinator), NEW_CUSTOMER);
    expect(created.customer.name).toBe('Strucmac Engineering');

    const machine = await createMachine(harness.as(coordinator), {
      customerId: created.customer.id,
      siteId: created.site.id,
      manufacturer: 'Leadwell',
      model: 'V-40',
      serialNumber: 'LW-V40-99001',
      machineNumber: 'STM1',
      machineType: 'CNC Milling Machine',
      year: 2020,
      installationDate: '2020-02-02',
      controlSystem: 'Fanuc 0i-MF',
      notes: '',
    });
    expect(machine.approval).toBe('approved');
  });

  it('manages technicians but not Masters or other Coordinators', async () => {
    const technician = await createUser(harness.as(coordinator), {
      firstName: 'New',
      lastName: 'Technician',
      email: 'new.technician@eje-demo.co.za',
      mobile: '',
      jobTitle: 'Field Service Technician',
      role: 'technician',
    });
    expect(technician.role).toBe('technician');

    await expect(
      createUser(harness.as(coordinator), {
        firstName: 'Second',
        lastName: 'Coordinator',
        email: 'second.coordinator@eje-demo.co.za',
        mobile: '',
        jobTitle: 'Office Coordinator',
        role: 'coordinator',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);

    await expect(setUserActive(harness.as(coordinator), master, false)).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('cannot change the charge-out rates', async () => {
    const settings = await harness.repos.settings.get();
    await expect(
      updateSettings(harness.as(coordinator), { ...settings, vatPercentage: 20 }),
    ).rejects.toThrow(/Master/i);

    // And nothing was written on the way to refusing.
    expect((await harness.repos.settings.get()).vatPercentage).toBe(settings.vatPercentage);
  });

  it('reads closed jobs, which is what she invoices from', async () => {
    const page = await loadClosedJobs(harness.repos, coordinator, emptyClosedJobFilters);
    expect(page.rows.length).toBeGreaterThan(0);
  });
});

describe('a technician is held to their own work', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('cannot capture work on somebody else’s job', async () => {
    const open = await openJobFor(harness, sipho.id);
    const job = await acceptJob(harness.as(sipho), open);

    await expect(
      addLabour(harness.as(lerato), job, {
        date: '2026-09-17',
        rateType: 'normal',
        hours: 1,
        description: 'Not my job',
      }),
    ).rejects.toThrow(/not assigned to you/i);
  });

  it('cannot change the customer register', async () => {
    const customer = await harness.repos.customers.findById(asCustomerId('cust-abc'));
    await expect(
      updateCustomer(harness.as(sipho), { ...customer!, paymentTerms: 'Cash' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('cannot create a customer or a user', async () => {
    await expect(createCustomer(harness.as(sipho), NEW_CUSTOMER)).rejects.toBeInstanceOf(
      WorkflowError,
    );
    await expect(
      createUser(harness.as(sipho), {
        firstName: 'A',
        lastName: 'B',
        email: 'a.b@eje-demo.co.za',
        mobile: '',
        jobTitle: '',
        role: 'technician',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('adds a machine, but it waits for the office', async () => {
    const machine = await createMachine(harness.as(sipho), {
      customerId: asCustomerId('cust-abc'),
      siteId: asSiteId('site-abc-jhb'),
      manufacturer: 'Mazak',
      model: 'QT-200',
      serialNumber: 'MZ-QT200-40404',
      machineNumber: '',
      machineType: 'CNC Lathe',
      year: 2021,
      installationDate: '2021-04-12',
      controlSystem: '',
      notes: '',
    });
    expect(machine.approval).toBe('pending_approval');
  });
});

describe('issuing a job card', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** Works a seeded job through to a captured signature as its technician. */
  const workAndSign = async (jobNumber: string): Promise<Job> => {
    const opened = await harness.repos.jobs.findByJobNumber(jobNumber);
    const technician = seedUser(opened!.primaryTechnicianId ?? sipho.id);
    const context = harness.as(technician);

    let job = await acceptJob(context, opened!);
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Repair',
    });
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the cooling fan.',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    return captureSignature(context, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
  };

  /*
   * WHO MAKES THE FINAL SUBMISSION, AND THE ANSWER HAS CHANGED TWICE.
   *
   * It was shared by everybody, which let a technician email a customer with
   * no office involvement at all — the `95e9848` audit finding. It was then
   * narrowed to the MASTER under §3.1/§7/§15. EJE confirmed on 25 September
   * 2026 (CR-07) that the normal signed journey has no office step at all: the
   * technician who attended the machine and took the signature submits it.
   *
   * So both office cases below are inverted, and the technician case is the
   * positive one. The SHAPE of the assertion is unchanged — refused, and
   * nothing happened — which is the part that was never about who.
   */
  it('is REFUSED to the Coordinator — the office has no step in a signed job', async () => {
    const signed = await workAndSign('EJE-1048');

    await expect(
      issueJobCard(
        harness.as(coordinator),
        signed,
        'customer@example-demo.co.za',
        'Pieter Nel',
      ),
    ).rejects.toThrow(/cannot be submitted by you/i);

    // Refused, and nothing happened: no document, no send, no status change.
    const after = await harness.repos.jobs.findById(signed.id);
    expect(after?.status).toBe('review');
    expect(after?.finalDocument).toBeNull();
  });

  it('is REFUSED to the Master too, however senior — CR-07', async () => {
    const signed = await workAndSign('EJE-1048');

    await expect(
      issueJobCard(harness.as(master), signed, 'customer@example-demo.co.za', 'Pieter Nel'),
    ).rejects.toThrow(/cannot be submitted by you/i);

    const after = await harness.repos.jobs.findById(signed.id);
    expect(after?.status).toBe('review');
    expect(after?.finalDocument).toBeNull();
  });

  it('is done by the technician, and closes only on confirmed delivery', async () => {
    const signed = await workAndSign('EJE-1048');
    const context = harness.as(sipho);

    const issued = await issueJobCard(context, signed, 'customer@example-demo.co.za', 'Pieter Nel');
    expect(issued.job.status).toBe('awaiting_delivery');

    const closed = await confirmDelivery(harness, context, issued.job);
    expect(closed.status).toBe('closed');
  });
});

describe('reads are refused too, not merely hidden', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a technician the company-wide audit trail', async () => {
    const error = await loadActivityFeed(harness.repos, sipho).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).violations.map((violation) => violation.code)).toContain(
      'not_permitted',
    );
  });

  it('refuses a technician the closed-job archive', async () => {
    const error = await loadClosedJobs(harness.repos, sipho, emptyClosedJobFilters).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).violations.map((violation) => violation.code)).toContain(
      'not_permitted',
    );
  });

  it('withholds the staff register from a technician’s search', async () => {
    const results = await runSearch(harness.repos, sipho, 'Lerato');
    expect(results.filter((result) => result.category === 'technician')).toHaveLength(0);
  });

  it('gives the office both, because both are office records', async () => {
    for (const person of [master, coordinator]) {
      const feed = await loadActivityFeed(harness.repos, person);
      expect(feed.events.length).toBeGreaterThan(0);

      const archive = await loadClosedJobs(harness.repos, person, emptyClosedJobFilters);
      expect(archive.rows.length).toBeGreaterThan(0);

      const people = await runSearch(harness.repos, person, 'Lerato');
      expect(people.filter((result) => result.category === 'technician').length).toBeGreaterThan(0);
    }
  });
});
