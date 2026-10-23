import { beforeEach, describe, expect, it } from 'vitest';
import { createJob } from './job-creation';
import { addLabour, addNote, addPart } from './job-operations';
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
import {
  asContactId,
  asCustomerId,
  asMachineId,
  asSiteId,
  getJobTypeDefinition,
  hasRepairItem,
  JOB_TYPE_CODES,
  type JobTypeCode,
  type User,
} from '@/domain';
import { buildJobCardModel } from '@/lib/job-card/model';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * THE TEST & REPAIR FIELDS. Test & Repair §4.
 *
 * The owner listed seven fields for this form. THREE ALREADY EXISTED and are
 * untouched — the reference number, the delivery note (`capturesDeliveryNote`
 * has been true for this type since it was written) and the fault description,
 * which is now OPTIONAL here. FOUR ARE NEW: the part number, the description
 * and the quantity of the unit booked in, and the customer's quote number.
 *
 * THE DISTINCTION THAT MATTERS, and the reason these are not `job_parts`: this
 * is what came IN on the counter, and `job_parts` is what was CONSUMED in
 * repairing it. A customer sends in three identical sensors and EJE fit one new
 * connector to each — two separate facts about one job, and collapsing them
 * would make either the collection note or the invoice wrong.
 *
 * AND QUOTE NUMBER IS NOT ON A PARTS COLLECTION. The owner struck it out there.
 * A parts collection is reconciled by its order number, which that type already
 * requires.
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

const input = async (harness: Harness, over: Record<string, unknown> = {}) => {
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
    jobType: 'test_and_repair' as JobTypeCode,
    priority: null,
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: '',
    referenceNumber: '',
    faultDescription: '',
    primaryTechnicianId: null,
    additionalTechnicianIds: [],
    courierCollection: false,
    deliveryNote: '',
    ...over,
  };
};

describe('which job types capture the repair fields', () => {
  it('is Test & Repair, and only Test & Repair', () => {
    const item = JOB_TYPE_CODES.filter((code) => getJobTypeDefinition(code).capturesRepairItem);
    expect(item).toEqual(['test_and_repair']);

    const quote = JOB_TYPE_CODES.filter((code) => getJobTypeDefinition(code).capturesQuoteNumber);
    expect(quote).toEqual(['test_and_repair']);
  });

  it('does NOT put the quote number on a parts collection', () => {
    // The owner struck it out there. A collection is reconciled by its order
    // number, which that type already requires.
    expect(getJobTypeDefinition('parts').capturesQuoteNumber).toBe(false);
    expect(getJobTypeDefinition('parts').requiresOrderNumber).toBe(true);
  });

  it('keeps the delivery note on both, because both are reconciled by one', () => {
    expect(getJobTypeDefinition('test_and_repair').capturesDeliveryNote).toBe(true);
    expect(getJobTypeDefinition('parts').capturesDeliveryNote).toBe(true);
  });
});

describe('raising a Test & Repair job with every field filled in', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  const full = {
    referenceNumber: 'CUST-REF-9931',
    deliveryNote: 'DN-55120',
    quoteNumber: 'Q-20451',
    repairItem: {
      partNumber: '  1FK7042-2AF71-1SG0  ',
      description: '  Servo motor, 3 kW  ',
      quantity: 3,
    },
    faultDescription: 'Reported overheating under load.',
  };

  it('stores all seven, trimmed', async () => {
    const job = await createJob(harness.as(master), await input(harness, full));

    expect(job.referenceNumber).toBe('CUST-REF-9931');
    expect(job.deliveryNote).toBe('DN-55120');
    expect(job.quoteNumber).toBe('Q-20451');
    expect(job.repairItem.partNumber).toBe('1FK7042-2AF71-1SG0');
    expect(job.repairItem.description).toBe('Servo motor, 3 kW');
    expect(job.repairItem.quantity).toBe(3);
    expect(job.faultDescription).toBe('Reported overheating under load.');
  });

  it('PERSISTS them, so they survive a reload rather than living in the screen', async () => {
    const job = await createJob(harness.as(master), await input(harness, full));
    const reloaded = await harness.repos.jobs.findById(job.id);

    expect(reloaded!.quoteNumber).toBe('Q-20451');
    expect(reloaded!.repairItem).toEqual({
      partNumber: '1FK7042-2AF71-1SG0',
      description: 'Servo motor, 3 kW',
      quantity: 3,
    });
  });

  it('reads them back through the job VIEW, which is what the screen uses', async () => {
    const job = await createJob(harness.as(master), await input(harness, full));
    const view = await loadJobView(harness.repos, job.jobNumber);
    expect(view!.job.repairItem.partNumber).toBe('1FK7042-2AF71-1SG0');
    expect(view!.job.quoteNumber).toBe('Q-20451');
  });

  it('SURVIVES the rest of the job — labour, a part and a discount', async () => {
    /*
     * "PERSIST THROUGH EDITS" is the requirement, and this is the shape that
     * matters in practice: every later operation saves the WHOLE job, so a
     * field a handler forgot to carry would be silently blanked by the next
     * thing anybody did. Nothing asserts that per operation, so it is asserted
     * once across a representative sequence.
     */
    const job = await createJob(harness.as(master), await input(harness, full));

    const withLabour = await addLabour(harness.as(master), job, {
      date: '2026-10-23',
      rateType: 'normal',
      hours: 2.5,
      description: 'Bench test and rewind',
    });
    const withPart = await addPart(harness.as(master), withLabour, {
      partNumber: 'BRG-6205',
      description: 'Bearing',
      quantity: 2,
      unitPrice: 14_500,
    });
    const withNote = await addNote(
      harness.as(master),
      withPart,
      'Rewound and tested on the bench.',
      false,
    );
    const reloaded = (await harness.repos.jobs.findById(job.id))!;

    for (const stage of [withLabour, withPart, withNote, reloaded]) {
      expect(stage.quoteNumber).toBe('Q-20451');
      expect(stage.repairItem).toEqual({
        partNumber: '1FK7042-2AF71-1SG0',
        description: 'Servo motor, 3 kW',
        quantity: 3,
      });
      expect(stage.referenceNumber).toBe('CUST-REF-9931');
      expect(stage.deliveryNote).toBe('DN-55120');
    }

    // The part FITTED is not the unit BOOKED IN, which is the whole design.
    expect(reloaded.parts.map((part) => part.partNumber)).toEqual(['BRG-6205']);
  });

  it('reaches the closed-job ARCHIVE EXPORT, which is where the office reconciles', async () => {
    const job = await createJob(harness.as(master), await input(harness, full));
    const summary = (await harness.repos.jobs.listSummaries()).find(
      (candidate) => candidate.id === job.id,
    );
    /*
     * THROUGH THE SUMMARY, which is the narrow row the list path produces —
     * not the full job. A field missing from the summary is a column that is
     * empty on PostgreSQL and full in the demonstration store, which is the
     * worst of both.
     */
    expect(summary?.quoteNumber).toBe('Q-20451');
    expect(summary?.repairItem.partNumber).toBe('1FK7042-2AF71-1SG0');
    expect(summary?.repairItem.quantity).toBe(3);
  });
});

describe('every one of them is optional', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('raises the job with NOTHING but the customer, site, contact and type', async () => {
    const job = await createJob(harness.as(master), await input(harness));

    expect(job.status).toBe('open');
    expect(job.faultDescription).toBe('');
    expect(job.quoteNumber).toBe('');
    expect(hasRepairItem(job.repairItem)).toBe(false);
    expect(job.repairItem.quantity).toBeNull();
  });

  it('the FAULT DESCRIPTION is optional on this type and REQUIRED on a breakdown', async () => {
    expect(getJobTypeDefinition('test_and_repair').requiresFaultDescription).toBe(false);
    expect(getJobTypeDefinition('breakdown').requiresFaultDescription).toBe(true);

    // And the rule bites, rather than merely being recorded in a flag.
    const error = await createJob(
      harness.as(master),
      await input(harness, { jobType: 'breakdown', faultDescription: '   ' }),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).violations.map((v) => v.code)).toContain(
      'fault_description_required',
    );
  });

  it('takes a part number with no quantity, which is the counter’s reality', async () => {
    const job = await createJob(
      harness.as(master),
      await input(harness, {
        repairItem: { partNumber: 'ABC-123', description: '', quantity: null },
      }),
    );
    expect(job.repairItem.partNumber).toBe('ABC-123');
    expect(job.repairItem.quantity).toBeNull();
    expect(hasRepairItem(job.repairItem)).toBe(true);
  });
});

describe('a job type that does not capture them stores nothing', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('CLEARS a quote number sent on a breakdown, rather than storing a hidden one', async () => {
    const job = await createJob(
      harness.as(master),
      await input(harness, {
        jobType: 'breakdown',
        faultDescription: 'Spindle will not start.',
        quoteNumber: 'Q-SHOULD-NOT-STICK',
        repairItem: { partNumber: 'NOPE', description: 'NOPE', quantity: 9 },
      }),
    );

    // Not an error: a screen switching job type sends what it had, and a
    // refusal there would be a worse answer than storing nothing.
    expect(job.quoteNumber).toBe('');
    expect(hasRepairItem(job.repairItem)).toBe(false);
  });

  it('CLEARS them on a parts collection too', async () => {
    const job = await createJob(
      harness.as(master),
      await input(harness, {
        jobType: 'parts',
        machineId: null,
        orderNumber: 'PO-77123',
        quoteNumber: 'Q-STRUCK-OUT',
        repairItem: { partNumber: 'X', description: 'Y', quantity: 1 },
      }),
    );
    expect(job.quoteNumber).toBe('');
    expect(hasRepairItem(job.repairItem)).toBe(false);
  });
});

describe('the customer’s document', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  const cardFor = async (jobNumber: string) => {
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

  it('prints what was booked in, and the quote number', async () => {
    const job = await createJob(
      harness.as(master),
      await input(harness, {
        quoteNumber: 'Q-20451',
        repairItem: { partNumber: 'ABC-123', description: 'Servo motor', quantity: 2 },
      }),
    );

    const rows = await cardFor(job.jobNumber);
    const details = new Map(rows.jobDetails.map((row) => [row.label, row.value]));
    expect(details.get('Quote number')).toBe('Q-20451');
    expect(details.get('Part number')).toBe('ABC-123');
    expect(details.get('Unit')).toBe('Servo motor');
    expect(details.get('Quantity received')).toBe('2');
  });

  it('OMITS each row nobody filled in, rather than printing a dash on a signed document', async () => {
    const job = await createJob(harness.as(master), await input(harness));

    const labels = (await cardFor(job.jobNumber)).jobDetails.map((row) => row.label);
    expect(labels).not.toContain('Quote number');
    expect(labels).not.toContain('Part number');
    expect(labels).not.toContain('Unit');
    expect(labels).not.toContain('Quantity received');
  });

  it('omits them on a BREAKDOWN even if the columns somehow held values', async () => {
    const job = await createJob(
      harness.as(master),
      await input(harness, {
        jobType: 'breakdown',
        faultDescription: 'Spindle will not start.',
        quoteNumber: 'Q-20451',
      }),
    );

    const labels = (await cardFor(job.jobNumber)).jobDetails.map((row) => row.label);
    expect(labels).not.toContain('Quote number');
  });
});
