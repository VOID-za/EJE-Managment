import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  saveCompletionReport,
  setCollectionMethod,
  startCompletion,
} from './job-operations';
import { createJob } from './job-creation';
import { WorkflowError } from './errors';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import { isJobAtOrPastCompletion, type Job, type JobStatus, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * WHO IS COLLECTING IS NOT ASKED UNTIL THE WORK IS FINISHED. Job completion §6.
 *
 * The owner asked that the Counter Collection tick box not be available until
 * the job is finished. It was on the CREATE NEW JOB form for a workshop repair,
 * and the server took the answer from the request — so an answer days old,
 * recorded before anybody knew, decided what the collection document showed.
 *
 * WHY IT MATTERS, and it is not tidiness: who was EXPECTED and who TURNS UP are
 * different questions. A customer who said they would collect sends a driver
 * often enough that an early answer is a guess, and the cost of a wrong guess
 * is a COURIER HOLDING A DOCUMENT WITH THE CUSTOMER'S PRICES ON IT —
 * `showsPricesOnCollectionDocument` reads this flag.
 *
 * The same reasoning was already written down for a parts collection, where
 * creation has never carried the answer. These cases hold the workshop repair
 * to it too, at creation AND against a direct call.
 */
const master = seedUsers.find((user) => user.role === 'master')!;
const technician = seedUsers.find((user) => user.id === 'user-tech-sipho')!;

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
    storage: new DemoStorageService(inMemoryFileStore()),
  };
  return { repos, as: (actor: User) => ({ repos, actor, services }) };
};

const raiseWorkshopJob = async (harness: Harness, courierCollection = false): Promise<Job> => {
  const [customer] = await harness.repos.customers.list();
  const sites = await harness.repos.customers.listSites(customer!.id);
  const contacts = await harness.repos.customers.listContacts(customer!.id);
  const machines = await harness.repos.machines.list();
  const machine = machines.find((candidate) => candidate.siteId === sites[0]!.id);

  return createJob(harness.as(master), {
    customerId: customer!.id,
    siteId: sites[0]!.id,
    contactId: contacts[0]!.id,
    machineId: machine!.id,
    jobType: 'test_and_repair',
    priority: null,
    scheduledDate: '2026-09-20',
    scheduledEndDate: null,
    additionalTechnicianIds: [],
    orderNumber: '',
    referenceNumber: '',
    deliveryNote: '',
    faultDescription: '',
    primaryTechnicianId: technician.id,
    courierCollection,
  });
};

/** Takes the job to `completion`, which is what "finished" means here. */
const toCompletion = async (harness: Harness, job: Job): Promise<Job> => {
  const tech = harness.as(technician);
  let next = await acceptJob(tech, job);
  next = await saveCompletionReport(tech, next, {
    ...next.completionReport,
    workPerformed: 'Bench tested the drive and replaced the encoder coupling.',
  });
  next = await addLabour(tech, next, {
    date: '2026-09-20',
    rateType: 'normal',
    hours: 3,
    description: 'Bench test and repair',
  });
  return startCompletion(tech, next);
};

describe('which stages count as finished', () => {
  it('is completion onwards, and not a job still being worked', () => {
    const finished: readonly JobStatus[] = [
      'completion',
      'customer_signature',
      'review',
      'submitted',
      'closed',
    ];
    for (const status of finished) expect(isJobAtOrPastCompletion(status)).toBe(true);

    const unfinished: readonly JobStatus[] = [
      'draft',
      'open',
      'in_progress',
      'awaiting_spares',
      // A cancelled job is not "past completion" in any sense that should
      // unlock a close-out step. It never will be finished.
      'cancelled',
    ];
    for (const status of unfinished) expect(isJobAtOrPastCompletion(status)).toBe(false);
  });
});

describe('creation never records who is collecting', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('writes false on a workshop repair even when the request asks for a courier', async () => {
    const job = await raiseWorkshopJob(harness, true);
    expect(job.courierCollection).toBe(false);
    expect(job.waybillNumber).toBe('');
  });

  it('writes false on a parts collection too, as it always did', async () => {
    const [customer] = await harness.repos.customers.list();
    const sites = await harness.repos.customers.listSites(customer!.id);
    const contacts = await harness.repos.customers.listContacts(customer!.id);

    const job = await createJob(harness.as(master), {
      customerId: customer!.id,
      siteId: sites[0]!.id,
      contactId: contacts[0]!.id,
      machineId: null,
      jobType: 'parts',
      priority: null,
      scheduledDate: null,
      scheduledEndDate: null,
      additionalTechnicianIds: [],
      orderNumber: 'PO-99001',
      referenceNumber: '',
      deliveryNote: '',
      faultDescription: '',
      primaryTechnicianId: null,
      courierCollection: true,
    });
    expect(job.courierCollection).toBe(false);
  });
});

describe('setting it before the work is finished', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('is REFUSED on a job that has only just been raised', async () => {
    const job = await raiseWorkshopJob(harness);
    const error = await setCollectionMethod(harness.as(technician), job, {
      courier: true,
      waybillNumber: 'DAW-4471',
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).violations.map((v) => v.code)).toContain('job_not_completed');
  });

  it('is REFUSED while the work is in progress', async () => {
    const job = await acceptJob(harness.as(technician), await raiseWorkshopJob(harness));
    expect(job.status).toBe('in_progress');

    await expect(
      setCollectionMethod(harness.as(technician), job, {
        courier: true,
        waybillNumber: 'DAW-4471',
      }),
    ).rejects.toThrow(WorkflowError);
  });

  it('names the JOB TYPE first on a job nobody collects, not the stage', async () => {
    /*
     * A breakdown will NEVER have a collection, whatever its status. Being told
     * "it is not completed yet" would send somebody to wait for something that
     * was never going to help — so the type is answered first.
     */
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const error = await setCollectionMethod(harness.as(technician), opened!, {
      courier: true,
      waybillNumber: 'DAW-1',
    }).catch((cause: unknown) => cause);

    expect((error as WorkflowError).violations.map((v) => v.code)).toContain('not_a_collection');
  });
});

describe('setting it once the work IS finished', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('is ALLOWED at completion, which is where the wizard asks', async () => {
    const job = await toCompletion(harness, await raiseWorkshopJob(harness));
    expect(job.status).toBe('completion');

    const collected = await setCollectionMethod(harness.as(technician), job, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });

    expect(collected.courierCollection).toBe(true);
    expect(collected.waybillNumber).toBe('DAW-4471');
  });

  it('can still be corrected to a customer collection, clearing the waybill', async () => {
    const job = await toCompletion(harness, await raiseWorkshopJob(harness));
    const courier = await setCollectionMethod(harness.as(technician), job, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });
    const corrected = await setCollectionMethod(harness.as(technician), courier, {
      courier: false,
      waybillNumber: 'DAW-4471',
    });

    expect(corrected.courierCollection).toBe(false);
    expect(corrected.waybillNumber).toBe('');
  });

  it('still refuses a courier with no waybill, which was always the rule', async () => {
    const job = await toCompletion(harness, await raiseWorkshopJob(harness));
    await expect(
      setCollectionMethod(harness.as(technician), job, { courier: true, waybillNumber: '  ' }),
    ).rejects.toThrow(/waybill/iu);
  });

  it('records it on the audit trail', async () => {
    const job = await toCompletion(harness, await raiseWorkshopJob(harness));
    await setCollectionMethod(harness.as(technician), job, {
      courier: true,
      waybillNumber: 'DAW-4471',
    });

    const events = await harness.repos.activity.list(job.id);
    expect(events.some((event) => event.type === 'collection_method_set')).toBe(true);
  });
});
