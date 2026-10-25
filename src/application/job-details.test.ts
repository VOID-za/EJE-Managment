import { beforeEach, describe, expect, it } from 'vitest';
import { editJobDetails } from './job-details';
import { releaseDraft } from './job-creation';
import { WorkflowError } from './errors';
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
import { editableDetailFields, jobDetailValues, type Job, type User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * JOB-EDIT-1 (#72) — the office corrects a job's recorded details.
 *
 * Every rule asserted here is one the system already had, now applied to the
 * details too: who (`jobs.editDetails`), when (`assertEditable` — never after
 * signature), what (the fields the job type carries, validated as creation
 * validates them), and how it is recorded (from/to pairs, AUDIT-2).
 */
const master = seedUsers.find((user) => user.role === 'master')!;
const coordinator = seedUsers.find((user) => user.role === 'coordinator')!;
const technician = seedUsers.find((user) => user.role === 'technician')!;

interface Harness {
  readonly repos: RepositoryBundle;
  as(actor: User): OperationContext;
  job(number: string): Promise<Job>;
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
  return {
    repos,
    as: (actor: User) => ({ repos, actor, services }),
    job: async (number: string) => (await repos.jobs.findByJobNumber(number))!,
  };
};

/** The refusal's code, or 'not refused'. */
const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
    return 'not refused';
  } catch (error) {
    if (error instanceof WorkflowError) return error.violations[0]?.code ?? 'no code';
    throw error;
  }
};

/*
 * Seeded states this suite leans on (src/data/seed/jobs.ts): EJE-1048 an open
 * breakdown, EJE-1059 an open test & repair, EJE-1064 a parts collection at
 * completion, EJE-1060 a draft installation, EJE-1046 SIGNED, EJE-1056 closed
 * and EJE-1045 cancelled.
 */
let harness: Harness;
beforeEach(() => {
  harness = build();
});

describe('who may correct a job’s details', () => {
  it.each([
    ['a Master', master],
    ['a Coordinator', coordinator],
  ])('%s may', async (_label, actor) => {
    const job = await harness.job('EJE-1048');
    const saved = await editJobDetails(harness.as(actor), job, {
      changes: { orderNumber: 'PO-77120' },
      expected: { orderNumber: job.orderNumber },
    });
    expect(saved.orderNumber).toBe('PO-77120');
    expect((await harness.job('EJE-1048')).orderNumber).toBe('PO-77120');
  });

  it('a technician may not — even on a job they are working', async () => {
    const job = await harness.job('EJE-1061');
    const before = jobDetailValues(job);
    expect(
      await refusal(
        editJobDetails(harness.as(technician), job, {
          changes: { faultDescription: 'Rewritten by the technician.' },
          expected: { faultDescription: job.faultDescription },
        }),
      ),
    ).toBe('not_permitted');
    expect(jobDetailValues(await harness.job('EJE-1061'))).toEqual(before);
  });
});

describe('when: only while the job is editable', () => {
  it('refuses a SIGNED job and leaves the signed record exactly as it was', async () => {
    const job = await harness.job('EJE-1046');
    expect(job.signature).not.toBeNull();
    const before = await harness.job('EJE-1046');

    expect(
      await refusal(
        editJobDetails(harness.as(master), job, {
          changes: { orderNumber: 'PO-CHANGED-AFTER-SIGNING' },
          expected: { orderNumber: job.orderNumber },
        }),
      ),
    ).toBe('job_finalized');

    const after = await harness.job('EJE-1046');
    expect(after).toEqual(before);
    const trail = await harness.repos.activity.list(job.id);
    expect(trail.some((event) => event.type === 'job_details_edited')).toBe(false);
  });

  it.each(['EJE-1056', 'EJE-1045'])('refuses %s, which is closed or cancelled', async (number) => {
    const job = await harness.job(number);
    expect(
      await refusal(
        editJobDetails(harness.as(master), job, {
          changes: { referenceNumber: 'REF-LATE' },
          expected: { referenceNumber: job.referenceNumber },
        }),
      ),
    ).not.toBe('not refused');
    expect((await harness.job(number)).referenceNumber).toBe(job.referenceNumber);
  });

  it('allows a Master to edit a DRAFT, where the fault description may still be blank', async () => {
    const job = await harness.job('EJE-1060');
    const saved = await editJobDetails(harness.as(master), job, {
      changes: { faultDescription: '' },
      expected: { faultDescription: job.faultDescription },
    });
    expect(saved.faultDescription).toBe('');
    // …and the deferred check is asked again on release, as DRAFT-1 promises.
    expect(await refusal(releaseDraft(harness.as(master), saved))).toBe('fault_description_required');
  });
});

describe('what: the fields this job type carries, validated as creation validates them', () => {
  it('trims, as creation trims', async () => {
    const job = await harness.job('EJE-1048');
    const saved = await editJobDetails(harness.as(coordinator), job, {
      changes: { referenceNumber: '   CUST-REF-1   ' },
      expected: { referenceNumber: job.referenceNumber },
    });
    expect(saved.referenceNumber).toBe('CUST-REF-1');
  });

  it('refuses emptying a breakdown’s fault description — the creation rule', async () => {
    const job = await harness.job('EJE-1048');
    expect(
      await refusal(
        editJobDetails(harness.as(master), job, {
          changes: { faultDescription: '   ' },
          expected: { faultDescription: job.faultDescription },
        }),
      ),
    ).toBe('fault_description_required');
  });

  it('lets a Test & Repair job fill in what was booked in, and leave the fault blank', async () => {
    const job = await harness.job('EJE-1059');
    const saved = await editJobDetails(harness.as(coordinator), job, {
      changes: {
        repairPartNumber: '1FK7042-2AF71',
        repairDescription: 'Servo motor, 3 kW',
        repairQuantity: 2,
        quoteNumber: 'Q-20451',
        deliveryNote: 'DN-55120',
        faultDescription: '',
      },
      expected: {
        repairPartNumber: job.repairItem.partNumber,
        repairDescription: job.repairItem.description,
        repairQuantity: job.repairItem.quantity,
        quoteNumber: job.quoteNumber,
        deliveryNote: job.deliveryNote,
        faultDescription: job.faultDescription,
      },
    });
    expect(saved.repairItem).toEqual({
      partNumber: '1FK7042-2AF71',
      description: 'Servo motor, 3 kW',
      quantity: 2,
    });
    expect(saved.quoteNumber).toBe('Q-20451');
    expect(saved.deliveryNote).toBe('DN-55120');
    expect(saved.faultDescription).toBe('');
  });

  it('refuses a quantity that is not a positive whole number', async () => {
    const job = await harness.job('EJE-1059');
    expect(
      await refusal(
        editJobDetails(harness.as(master), job, {
          changes: { repairQuantity: 0 },
          expected: { repairQuantity: job.repairItem.quantity },
        }),
      ),
    ).toBe('invalid_quantity');
  });

  it('REFUSES a field the job type does not carry, rather than dropping it', async () => {
    const breakdown = await harness.job('EJE-1048');
    expect(
      await refusal(
        editJobDetails(harness.as(master), breakdown, {
          changes: { quoteNumber: 'Q-1' },
          expected: { quoteNumber: breakdown.quoteNumber },
        }),
      ),
    ).toBe('not_applicable_to_job_type');

    // A parts collection has no fault description at all (CR-13).
    const parts = await harness.job('EJE-1064');
    expect(
      await refusal(
        editJobDetails(harness.as(master), parts, {
          changes: { faultDescription: 'Something' },
          expected: { faultDescription: parts.faultDescription },
        }),
      ),
    ).toBe('not_applicable_to_job_type');
  });

  it('offers exactly the fields creation keeps for each type', () => {
    expect(editableDetailFields('breakdown')).toEqual([
      'orderNumber',
      'referenceNumber',
      'faultDescription',
    ]);
    expect(editableDetailFields('parts')).toEqual(['orderNumber', 'referenceNumber', 'deliveryNote']);
    expect(editableDetailFields('test_and_repair')).toEqual([
      'orderNumber',
      'referenceNumber',
      'quoteNumber',
      'deliveryNote',
      'dateReceived',
      'repairPartNumber',
      'repairDescription',
      'repairQuantity',
      'faultDescription',
    ]);
  });
});

describe('recorded: every moved field as a from/to pair (AUDIT-2)', () => {
  it('records each changed field, and only those', async () => {
    const job = await harness.job('EJE-1059');
    await editJobDetails(harness.as(coordinator), job, {
      changes: { orderNumber: 'PO-1', referenceNumber: job.referenceNumber, quoteNumber: 'Q-9' },
      expected: {
        orderNumber: job.orderNumber,
        referenceNumber: job.referenceNumber,
        quoteNumber: job.quoteNumber,
      },
    });
    const events = (await harness.repos.activity.list(job.id)).filter(
      (event) => event.type === 'job_details_edited',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(coordinator.id);
    expect(events[0]!.changes).toEqual([
      { field: 'details.orderNumber', from: job.orderNumber, to: 'PO-1' },
      { field: 'details.quoteNumber', from: job.quoteNumber, to: 'Q-9' },
    ]);
  });

  it('an edit that moves nothing saves nothing and records nothing', async () => {
    const job = await harness.job('EJE-1048');
    const result = await editJobDetails(harness.as(master), job, {
      changes: { orderNumber: `  ${job.orderNumber}  ` },
      expected: { orderNumber: job.orderNumber },
    });
    expect(result).toBe(job);
    const trail = await harness.repos.activity.list(job.id);
    expect(trail.some((event) => event.type === 'job_details_edited')).toBe(false);
  });
});

describe('stale edits: two people correcting the same job', () => {
  it('refuses an edit made against values that have since changed, and keeps the first', async () => {
    const opened = await harness.job('EJE-1048');

    // A colleague corrects the order number first…
    await editJobDetails(harness.as(master), opened, {
      changes: { orderNumber: 'PO-FIRST' },
      expected: { orderNumber: opened.orderNumber },
    });

    // …and this editor, working from the copy opened earlier, is refused.
    const fresh = await harness.job('EJE-1048');
    expect(
      await refusal(
        editJobDetails(harness.as(coordinator), fresh, {
          changes: { orderNumber: 'PO-SECOND' },
          expected: { orderNumber: opened.orderNumber },
        }),
      ),
    ).toBe('job_details_changed');
    expect((await harness.job('EJE-1048')).orderNumber).toBe('PO-FIRST');
  });

  it('does NOT refuse because a DIFFERENT field moved in the meantime', async () => {
    const opened = await harness.job('EJE-1048');
    await editJobDetails(harness.as(master), opened, {
      changes: { referenceNumber: 'REF-BY-COLLEAGUE' },
      expected: { referenceNumber: opened.referenceNumber },
    });
    const fresh = await harness.job('EJE-1048');
    const saved = await editJobDetails(harness.as(coordinator), fresh, {
      changes: { orderNumber: 'PO-MINE' },
      expected: { orderNumber: opened.orderNumber },
    });
    expect(saved.orderNumber).toBe('PO-MINE');
    expect(saved.referenceNumber).toBe('REF-BY-COLLEAGUE');
  });

  it('refuses a change that does not say what it replaces', async () => {
    const job = await harness.job('EJE-1048');
    expect(
      await refusal(
        editJobDetails(harness.as(master), job, {
          changes: { orderNumber: 'PO-BLIND' },
          expected: {},
        }),
      ),
    ).toBe('job_details_changed');
  });
});
