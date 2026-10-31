import { beforeEach, describe, expect, it } from 'vitest';
import { createJob } from './job-creation';
import { WorkflowError } from './errors';
import { filterJobListRows } from './job-list-filters';
import { emptyJobListFilters } from './job-list-filters';
import { exportJobList } from './exports';
import { loadActiveJobList, loadJobView } from './job-view';
import { loadCalendar } from './calendar';
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
import {
  asContactId,
  asCustomerId,
  asMachineId,
  asSiteId,
  getJobTypeDefinition,
  JOB_TYPE_CODES,
  priorityRank,
  priorityLabelOrUngraded,
  type Job,
  type JobTypeCode,
  type User,
} from '@/domain';
import { buildJobCardModel } from '@/lib/job-card/model';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * A MACHINE AND A PRIORITY ARE NOT ALWAYS KNOWN. Create New Job §3A, §3B, §4.
 *
 * The owner asked that neither be mandatory on a BREAKDOWN or a TEST & REPAIR.
 * Both were effectively compulsory before: the machine because the requirement
 * was inferred from `capturesLabourAndTravel`, and the priority because the
 * column was NOT NULL and the form pre-selected the job type's default — so
 * every job carried a grading whether or not a person had made one.
 *
 * THE TWO THINGS THESE CASES GUARD, beyond "it is allowed":
 *
 *  1. NOTHING IS INVENTED. No machine is fabricated, the job is not attached to
 *     an arbitrary machine, and the priority is NULL rather than defaulted —
 *     because "Urgent" on a breakdown nobody graded is a grading no person
 *     chose, and afterwards nothing could tell it from a real one.
 *  2. THE REQUIREMENT SURVIVES WHERE IT BELONGS. An installation and a service
 *     are planned work booked against a known machine, and they still refuse
 *     both omissions.
 *
 * And the downstream readers — the list, the sort, the filters, the calendar,
 * the spreadsheet and the customer's job card — each handle the absence rather
 * than crashing or guessing.
 */
const master = seedUsers.find((user) => user.role === 'master')!;

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

const target = async (harness: Harness) => {
  const customers = await harness.repos.customers.list();
  const customer = customers[0]!;
  const sites = await harness.repos.customers.listSites(customer.id);
  const contacts = await harness.repos.customers.listContacts(customer.id);
  const machines = await harness.repos.machines.list();
  const machine = machines.find((candidate) => candidate.customerId === customer.id)!;
  return {
    customerId: asCustomerId(customer.id),
    siteId: asSiteId(sites[0]!.id),
    contactId: asContactId(contacts[0]!.id),
    machineId: asMachineId(machine.id),
  };
};

const input = async (harness: Harness, over: Record<string, unknown> = {}) => ({
  ...(await target(harness)),
  jobType: 'breakdown' as JobTypeCode,
  priority: null,
  scheduledDate: null,
  scheduledEndDate: null,
  orderNumber: '',
  referenceNumber: '',
  faultDescription: 'The line is down. Nobody can say which machine yet.',
  primaryTechnicianId: null,
  additionalTechnicianIds: [],
  courierCollection: false,
  deliveryNote: '',
  ...over,
});

/** The job card as it would be rendered, for the two cases that read it. */
const jobCardFor = async (harness: Harness, jobNumber: string) => {
  const view = await loadJobView(harness.repos, jobNumber);
  return buildJobCardModel({
    job: view!.job,
    customer: view!.customer,
    site: view!.site,
    contact: view!.contact,
    machine: view!.machine,
    settings: view!.settings,
    checklistTemplate: view!.checklistTemplate,
    users: view!.users,
    generatedAt: '2026-11-01T10:00:00.000Z',
  });
};

describe('which job types require a machine and a priority', () => {
  it('names them explicitly rather than inferring it from the charging flag', () => {
    const requiring = JOB_TYPE_CODES.filter((code) => getJobTypeDefinition(code).requiresMachine);
    expect([...requiring].sort()).toEqual(['installation', 'service']);

    // 31 October 2026 (the tester): Priority is optional on every job type.
    const grading = JOB_TYPE_CODES.filter((code) => getJobTypeDefinition(code).requiresPriority);
    expect(grading).toEqual([]);
  });
});

describe('a breakdown with no machine and no priority', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('is raised, and carries neither', async () => {
    const job = await createJob(harness.as(master), await input(harness, { machineId: null }));

    expect(job.status).toBe('open');
    expect(job.machineId).toBeNull();
    expect(job.priority).toBeNull();
  });

  it('keeps the machine when one IS given', async () => {
    const chosen = await target(harness);
    const job = await createJob(harness.as(master), await input(harness));
    expect(job.machineId).toBe(chosen.machineId);
  });

  it('keeps the priority when one IS chosen', async () => {
    const job = await createJob(harness.as(master), await input(harness, { priority: 'high' }));
    expect(job.priority).toBe('high');
  });

  it('PERSISTS the absence rather than filling it in on the way to storage', async () => {
    const job = await createJob(harness.as(master), await input(harness, { machineId: null }));
    const reloaded = await harness.repos.jobs.findById(job.id);
    expect(reloaded!.machineId).toBeNull();
    expect(reloaded!.priority).toBeNull();
  });
});

describe('a test & repair job with no machine and no priority', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('is raised, and carries neither', async () => {
    const job = await createJob(
      harness.as(master),
      await input(harness, { jobType: 'test_and_repair', machineId: null }),
    );
    expect(job.machineId).toBeNull();
    expect(job.priority).toBeNull();
  });
});

describe('the types that still require them', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  for (const jobType of ['installation', 'service'] as const) {
    it(`refuses a ${jobType} with no machine`, async () => {
      const error = await createJob(
        harness.as(master),
        await input(harness, { jobType, machineId: null, priority: 'normal' }),
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).violations.map((v) => v.code)).toContain('machine_required');
    });

    it(`refuses a ${jobType} with no machine even when it has no priority either`, async () => {
      const error = await createJob(
        harness.as(master),
        await input(harness, { jobType, machineId: null, priority: null }),
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(WorkflowError);
      const codes = (error as WorkflowError).violations.map((v) => v.code);
      expect(codes).toContain('machine_required');
      expect(codes).not.toContain('priority_required');
    });

    it(`raises a ${jobType} with a machine and NO priority (Priority optional, 31 October 2026)`, async () => {
      const job = await createJob(harness.as(master), await input(harness, { jobType, priority: null }));
      expect(job.status).toBe('open');
      expect(job.machineId).not.toBeNull();
      expect(job.priority).toBeNull();
    });

    it(`keeps the priority a ${jobType} WAS given`, async () => {
      const job = await createJob(harness.as(master), await input(harness, { jobType, priority: 'high' }));
      expect(job.priority).toBe('high');
    });
  }
});

describe('a parts collection has no priority at all', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('stores null even when the request sends one, rather than the old default', async () => {
    const job = await createJob(
      harness.as(master),
      await input(harness, {
        jobType: 'parts',
        machineId: null,
        priority: 'urgent',
        faultDescription: '',
        orderNumber: 'PO-99812',
      }),
    );
    expect(job.priority).toBeNull();
  });
});

describe('what reads an ungraded job', () => {
  let harness: Harness;
  let ungraded: Job;
  beforeEach(async () => {
    harness = build();
    ungraded = await createJob(
      harness.as(master),
      await input(harness, { machineId: null, scheduledDate: '2026-11-02' }),
    );
  });

  it('SORTS it last, after every graded job, rather than first', () => {
    expect(priorityRank(null)).toBeGreaterThan(priorityRank('low'));
    expect(priorityRank(null)).toBeGreaterThan(priorityRank('urgent'));
  });

  it('shows it in the job list without a grade', async () => {
    const rows = await loadActiveJobList(harness.repos, master);
    const row = rows.find((candidate) => candidate.job.id === ungraded.id);
    expect(row).toBeDefined();
    expect(row!.job.priority).toBeNull();
  });

  it('is matched by the "all" priority filter and by NO specific grade', async () => {
    const rows = await loadActiveJobList(harness.repos, master);
    const all = filterJobListRows(rows, { ...emptyJobListFilters, status: 'all' }, master.id);
    expect(all.some((row) => row.job.id === ungraded.id)).toBe(true);

    for (const priority of ['low', 'normal', 'high', 'urgent'] as const) {
      const narrowed = filterJobListRows(
        rows,
        { ...emptyJobListFilters, status: 'all', priority },
        master.id,
      );
      expect(narrowed.some((row) => row.job.id === ungraded.id)).toBe(false);
    }
  });

  it('appears on the CALENDAR carrying the absence rather than a guess', async () => {
    const data = await loadCalendar(
      harness.repos,
      { from: '2026-11-01', to: '2026-11-03' },
      master,
    );
    // Narrowed on `kind`, because the calendar also carries availability
    // entries, which have no job number and no priority at all.
    const entry = data.entries.find(
      (candidate) => candidate.kind === 'job' && candidate.jobNumber === ungraded.jobNumber,
    );
    expect(entry).toBeDefined();
    expect(entry!.kind === 'job' && entry!.priority).toBeNull();
  });

  it('exports as "Not graded" rather than as an empty cell', async () => {
    const rows = await loadActiveJobList(harness.repos, master);
    const file = await exportJobList(harness.repos, master, {
      ...emptyJobListFilters,
      status: 'all',
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(file.csv).toContain('Not graded');
    expect(priorityLabelOrUngraded(null)).toBe('Not graded');
  });

  it('OMITS the priority row from the customer’s job card, rather than printing a blank', async () => {
    const model = await jobCardFor(harness, ungraded.jobNumber);
    const labels = model.jobDetails.map((detail) => detail.label);
    expect(labels).not.toContain('Priority');
    // The rest of the detail block is untouched.
    expect(labels).toContain('Job type');
  });

  it('PRINTS the priority row when the job has one', async () => {
    const graded = await createJob(harness.as(master), await input(harness, { priority: 'high' }));
    const model = await jobCardFor(harness, graded.jobNumber);
    expect(model.jobDetails.find((detail) => detail.label === 'Priority')?.value).toBe('High');
  });
});
