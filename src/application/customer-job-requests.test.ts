import { beforeEach, describe, expect, it } from 'vitest';
import { raiseChangeRequest, resolveChangeRequest } from './change-request-operations';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { builtinPdfText } from '@/services/pdf-text';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import { asContactId, asJobId, type Job, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * A CUSTOMER'S REQUEST TO CHANGE SOMETHING ON A JOB. CUST-CR, the job half.
 *
 * The register half was built in October; this half was left because three
 * questions were unanswered. They are answered here the way the register half
 * answered its own, and each answer is asserted rather than described:
 *
 *  1. WHO RAISES ONE. The customer — who has no account in this system, so
 *     somebody at EJE writes down what they asked for. `raisedBy` is the EJE
 *     person who took the call; `requestedByContactId` is the customer contact
 *     who made it. Anybody who may SEE the job may record one, because the
 *     technician standing in the workshop is who it gets said to.
 *  2. WHAT IT MAY CHANGE. Nothing. There is no proposed value and no apply
 *     path — the same discipline as the register half.
 *  3. WHAT IT DOES TO A JOB IN PROGRESS. It becomes VISIBLE on the job, to
 *     whoever is working it. That is all, and it is the point.
 *
 * AND AFTER SIGNATURE: still recordable, because a customer querying an issued
 * job card is exactly when they ask — and BD-02 already decided what happens
 * next. Nothing here edits a signed job, because nothing can.
 */
const master = seedUsers.find((user) => user.role === 'master')!;
const coordinator = seedUsers.find((user) => user.role === 'coordinator')!;
const technician = seedUsers.find((user) => user.id === 'user-tech-sipho')!;
const otherTechnician = seedUsers.find((user) => user.id === 'user-tech-riaan')!;

interface Harness {
  readonly repos: RepositoryBundle;
  as(actor: User): OperationContext;
}

const build = (): Harness => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();
  const services = {
    clock,
    ids,
    email: new SimulatedEmailService(outbox, clock, ids),
    whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
    pdf: new SimulatedPdfService(clock),
    pdfText: builtinPdfText(),
    storage: new DemoStorageService(inMemoryFileStore()),
  };
  return { repos, as: (actor: User) => ({ repos, actor, services }) };
};

/** A job in progress, with the technician who is on it. */
const liveJob = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1061');
  return view!.job;
};

describe('recording what a customer asked for on a job', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = build();
    job = await liveJob(harness);
  });

  it('records the customer’s words against the job', async () => {
    const request = await raiseChangeRequest(harness.as(master), {
      subject: 'job',
      customerId: job.customerId,
      jobId: job.id,
      details: 'While you are on site, please also check the Y-axis bearing noise.',
    });

    expect(request.subject).toBe('job');
    expect(request.jobId).toBe(job.id);
    expect(request.state).toBe('open');
    // WHO TOOK THE CALL is the EJE person; the customer has no account here.
    expect(request.raisedBy).toBe(master.id);
  });

  it('records WHICH of the customer’s contacts asked', async () => {
    const contacts = await harness.repos.customers.listContacts(job.customerId);
    const asked = contacts[0]!;

    const request = await raiseChangeRequest(harness.as(master), {
      subject: 'job',
      customerId: job.customerId,
      jobId: job.id,
      requestedByContactId: asContactId(asked.id),
      details: 'Please bring the spare encoder as well.',
    });

    expect(request.requestedByContactId).toBe(asked.id);
  });

  it('REFUSES a contact who is not that customer’s', async () => {
    const contacts = await harness.repos.customers.listContacts();
    const foreign = contacts.find((contact) => contact.customerId !== job.customerId);

    await expect(
      raiseChangeRequest(harness.as(master), {
        subject: 'job',
        customerId: job.customerId,
        jobId: job.id,
        requestedByContactId: asContactId(foreign!.id),
        details: 'Anything',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('REFUSES a job that is not that customer’s', async () => {
    // One customer's words on another's job card is the failure this prevents.
    const jobs = await harness.repos.jobs.list();
    const foreign = jobs.find((candidate) => candidate.customerId !== job.customerId);

    await expect(
      raiseChangeRequest(harness.as(master), {
        subject: 'job',
        customerId: job.customerId,
        jobId: foreign!.id,
        details: 'Anything',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('REFUSES a job id on a request about the REGISTER', async () => {
    await expect(
      raiseChangeRequest(harness.as(master), {
        subject: 'machine',
        customerId: job.customerId,
        machineId: job.machineId,
        jobId: job.id,
        details: 'The serial number is wrong.',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('REFUSES a contact on a request about the REGISTER', async () => {
    // A report about the register comes from somebody at EJE, not the customer.
    const contacts = await harness.repos.customers.listContacts(job.customerId);
    await expect(
      raiseChangeRequest(harness.as(master), {
        subject: 'customer',
        customerId: job.customerId,
        requestedByContactId: asContactId(contacts[0]!.id),
        details: 'The accounts address bounces.',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('REFUSES a job that does not exist', async () => {
    await expect(
      raiseChangeRequest(harness.as(master), {
        subject: 'job',
        customerId: job.customerId,
        jobId: asJobId('job-that-does-not-exist'),
        details: 'Anything',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('REFUSES a `job` request with no job at all', async () => {
    await expect(
      raiseChangeRequest(harness.as(master), {
        subject: 'job',
        customerId: job.customerId,
        details: 'A request about nothing',
      }),
    ).rejects.toThrow(WorkflowError);
  });
});

describe('who may record one', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = build();
    job = await liveJob(harness);
  });

  it('lets the TECHNICIAN ON THE JOB record one, which is the point', async () => {
    /*
     * The customer says "while you are here, can you look at the Y axis too"
     * to the person standing in their workshop. If only the office could write
     * that down, it would not get written down.
     */
    const onTheJob = seedUsers.find((user) => user.id === job.primaryTechnicianId)!;

    const request = await raiseChangeRequest(harness.as(onTheJob), {
      subject: 'job',
      customerId: job.customerId,
      jobId: job.id,
      details: 'Also check the Y axis.',
    });

    expect(request.raisedBy).toBe(onTheJob.id);
  });

  it('REFUSES a technician who is not on the job and cannot see it', async () => {
    const stranger = [technician, otherTechnician].find(
      (candidate) => candidate.id !== job.primaryTechnicianId,
    )!;

    await expect(
      raiseChangeRequest(harness.as(stranger), {
        subject: 'job',
        customerId: job.customerId,
        jobId: job.id,
        details: 'A job I am not on',
      }),
    ).rejects.toThrow(WorkflowError);
  });
});

describe('what it does to the job', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = build();
    job = await liveJob(harness);
  });

  it('CHANGES NOTHING on the job itself', async () => {
    const before = await loadJobView(harness.repos, job.jobNumber);

    await raiseChangeRequest(harness.as(master), {
      subject: 'job',
      customerId: job.customerId,
      jobId: job.id,
      details: 'Please also replace the coolant hose.',
    });

    const after = await loadJobView(harness.repos, job.jobNumber);
    // Every field of the job, compared. A request is a message, not an edit.
    expect(after!.job).toEqual(before!.job);
  });

  it('IS VISIBLE on the job, to the technician working it', async () => {
    await raiseChangeRequest(harness.as(master), {
      subject: 'job',
      customerId: job.customerId,
      jobId: job.id,
      details: 'Also check the Y axis.',
    });

    const onTheJob = seedUsers.find((user) => user.id === job.primaryTechnicianId)!;
    const view = await loadJobView(harness.repos, job.jobNumber, onTheJob);

    expect(view!.customerRequests).toHaveLength(1);
    expect(view!.customerRequests[0]?.details).toMatch(/Y axis/u);
  });

  it('is on the JOB’s own audit trail, not only the office queue', async () => {
    await raiseChangeRequest(harness.as(master), {
      subject: 'job',
      customerId: job.customerId,
      jobId: job.id,
      details: 'Please also replace the coolant hose.',
    });

    const events = await harness.repos.activity.list(job.id);
    const recorded = events.find((event) => event.type === 'customer_change_requested');
    expect(recorded).toBeDefined();
    expect(recorded?.detail).toMatch(/[Nn]othing on the job has been changed/u);
  });

  it('does not appear on another job', async () => {
    await raiseChangeRequest(harness.as(master), {
      subject: 'job',
      customerId: job.customerId,
      jobId: job.id,
      details: 'Also check the Y axis.',
    });

    const jobs = await harness.repos.jobs.list();
    const other = jobs.find((candidate) => candidate.id !== job.id)!;
    const view = await loadJobView(harness.repos, other.jobNumber);
    expect(view!.customerRequests).toHaveLength(0);
  });
});

describe('the office’s decision', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = build();
    job = await liveJob(harness);
  });

  const raised = async () =>
    raiseChangeRequest(harness.as(master), {
      subject: 'job',
      customerId: job.customerId,
      jobId: job.id,
      details: 'Also check the Y axis.',
    });

  it('is recorded by the office, with a note that is required', async () => {
    const request = await raised();

    await expect(
      resolveChangeRequest(harness.as(master), request.id, { outcome: 'applied', note: '  ' }),
    ).rejects.toThrow(WorkflowError);

    const resolved = await resolveChangeRequest(harness.as(coordinator), request.id, {
      outcome: 'applied',
      note: 'Added the Y-axis check to the job and told Sipho.',
    });
    expect(resolved.state).toBe('applied');
    expect(resolved.resolvedBy).toBe(coordinator.id);
  });

  it('REFUSES a technician deciding, even the one on the job', async () => {
    const request = await raised();
    const onTheJob = seedUsers.find((user) => user.id === job.primaryTechnicianId)!;

    await expect(
      resolveChangeRequest(harness.as(onTheJob), request.id, {
        outcome: 'declined',
        note: 'Not doing it',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('still changes NOTHING on the job when the office says they did it', async () => {
    /*
     * "Applied" is the office saying a PERSON made the change. The system
     * makes none — the same rule as the register half, and the reason the
     * dialog does not offer a button that would be a lie.
     */
    const request = await raised();
    const before = await loadJobView(harness.repos, job.jobNumber);

    await resolveChangeRequest(harness.as(master), request.id, {
      outcome: 'applied',
      note: 'Added the Y-axis check to the job by hand.',
    });

    const after = await loadJobView(harness.repos, job.jobNumber);
    expect(after!.job).toEqual(before!.job);
  });

  it('refuses a second decision on the same request', async () => {
    const request = await raised();
    await resolveChangeRequest(harness.as(master), request.id, {
      outcome: 'applied',
      note: 'Done.',
    });
    await expect(
      resolveChangeRequest(harness.as(master), request.id, {
        outcome: 'declined',
        note: 'Changed my mind.',
      }),
    ).rejects.toThrow(WorkflowError);
  });
});

describe('a job the customer has already signed', () => {
  it('is STILL recordable, because that is when a customer queries one', async () => {
    /*
     * CR-01's finality is untouched: BD-02 answered what happens when an
     * ISSUED document is wrong, and it is a correction with its own addendum —
     * raised by a Master, leaving the original's bytes alone. Recording the
     * customer's query is the step before that decision, and refusing to
     * record it would mean the query lives in somebody's memory.
     */
    const harness = build();
    const jobs = await harness.repos.jobs.list();
    const signed = jobs.find((candidate) => candidate.signature !== null)!;
    const before = await loadJobView(harness.repos, signed.jobNumber);

    const request = await raiseChangeRequest(harness.as(master), {
      subject: 'job',
      customerId: signed.customerId,
      jobId: signed.id,
      details: 'The labour hours on the job card are wrong — we agreed three, not five.',
    });

    expect(request.state).toBe('open');
    // AND THE SIGNED JOB IS UNTOUCHED, which is the assertion that matters.
    const after = await loadJobView(harness.repos, signed.jobNumber);
    expect(after!.job).toEqual(before!.job);
    expect(after!.job.signature).not.toBeNull();
  });
});
