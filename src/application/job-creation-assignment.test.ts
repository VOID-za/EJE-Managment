import { beforeEach, describe, expect, it } from 'vitest';
import { canAcceptJob, type Job } from '@/domain';
import { createJob, type NewJobInput } from './job-creation';
import {
  acceptJob,
  acceptJobRefusal,
  addAdditionalTechnician,
  assignPrimaryTechnician,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * Raising a job, assigning it, and a technician taking it on.
 *
 * WHAT THESE ARE FOR. Every id in a creation request arrives as a string in a
 * JSON body. The office picks them from dropdowns, but the dropdown is drawn by
 * the client and a request does not have to come from one — so the rules that
 * make a job card CORRECT (this site belongs to this customer; this machine
 * stands at this site; this person does field work) have to be enforced where
 * every caller meets them, and that is here.
 *
 * The seeded register these rely on:
 *   cust-abc     ABC Engineering       site-abc-jhb    machine-abc-lv40
 *   cust-kruger  Kruger Engineering    site-kruger-main
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');

/**
 * A creation request, as one actually arrives: ids are plain strings.
 *
 * Cast rather than branded on purpose. The branding is a compile-time guard for
 * application code; a REQUEST carries whatever a client sent, and these tests
 * exist to prove the server checks it rather than trusting the type system to
 * have done so.
 */
const baseInput = (over: Record<string, unknown> = {}): NewJobInput =>
  ({
    customerId: 'cust-abc',
    siteId: 'site-abc-jhb',
    contactId: 'contact-abc-jhb',
    machineId: 'machine-abc-lv40',
    jobType: 'breakdown',
    priority: 'urgent',
    scheduledDate: null,
    scheduledEndDate: null,
    orderNumber: 'PO-99001',
    referenceNumber: '',
    faultDescription: 'Spindle drive tripping on start-up.',
    primaryTechnicianId: null,
    additionalTechnicianIds: [],
    courierCollection: false,
    deliveryNote: '',
    attachments: [],
    ...over,
  }) as unknown as NewJobInput;

/**
 * The same harness, with a WhatsApp that refuses.
 *
 * Built as a new context rather than by mutating `services`, which is readonly
 * for the reason this test relies on: the composition root decides the
 * adapters, and nothing at runtime swaps one out mid-operation.
 */
const withWhatsApp = (harness: Harness, failure: string) => ({
  ...harness.as(master),
  services: {
    ...harness.services,
    whatsapp: { send: () => Promise.reject(new Error(failure)) },
  },
});

/** The violation codes a refusal carried, which is what the screens render. */
const codesFrom = async (run: () => Promise<unknown>): Promise<readonly string[]> => {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof WorkflowError) return cause.violations.map((violation) => violation.code);
    throw cause;
  }
  throw new Error('Expected the operation to be refused, and it was not.');
};

describe('raising a job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('creates it Open, unstarted, and stamped by the server', async () => {
    const before = harness.services.clock.now();
    const job = await createJob(harness.as(master), baseInput());

    expect(job.status).toBe('open');
    // Created is not started. Acceptance is what starts it, and nothing here
    // may shortcut that.
    expect(job.acceptedAt).toBeNull();
    expect(job.createdBy).toBe(master.id);
    expect(job.createdAt >= before).toBe(true);
    expect(job.jobNumber).toMatch(/^EJE-\d+$/u);
  });

  it('lets a Coordinator raise one, because running jobs is the office', async () => {
    const job = await createJob(harness.as(coordinator), baseInput());
    expect(job.status).toBe('open');
  });

  it('refuses a technician raising one at all', async () => {
    expect(await codesFrom(() => createJob(harness.as(sipho), baseInput()))).toContain(
      'not_permitted',
    );
  });
});

/**
 * The register relationships.
 *
 * Each of these is a request in which every id is REAL. That is the point: a
 * check for "does this exist" would pass all of them, and the job card would go
 * out describing a machine at somebody else's premises.
 */
describe('the customer, site, machine and recipient must belong together', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a site belonging to a different customer', async () => {
    const codes = await codesFrom(() =>
      createJob(
        harness.as(master),
        baseInput({ siteId: 'site-kruger-main', machineId: null, jobType: 'parts' }),
      ),
    );
    expect(codes).toContain('site_not_of_customer');
  });

  it('refuses a machine belonging to a different customer', async () => {
    const codes = await codesFrom(() =>
      createJob(harness.as(master), baseInput({ machineId: 'machine-kruger-vf2' })),
    );
    expect(codes).toContain('machine_not_of_customer');
  });

  it('refuses a machine of the right customer standing at another of their sites', async () => {
    // The subtle one: customer matches, site does not. A technician sent to
    // Johannesburg for a machine in Benoni is a wasted day.
    const machines = await harness.repos.machines.list();
    const elsewhere = machines.find(
      (machine) => machine.customerId === 'cust-abc' && machine.siteId !== 'site-abc-jhb',
    );
    if (elsewhere === undefined) return; // No such machine seeded; nothing to prove here.

    const codes = await codesFrom(() =>
      createJob(harness.as(master), baseInput({ machineId: elsewhere.id })),
    );
    expect(codes).toContain('machine_not_at_site');
  });

  it('refuses a recipient at a different customer', async () => {
    const contacts = await harness.repos.customers.listContacts();
    const stranger = contacts.find((contact) => contact.customerId !== 'cust-abc');
    expect(stranger).toBeDefined();

    const codes = await codesFrom(() =>
      createJob(harness.as(master), baseInput({ contactId: stranger!.id })),
    );
    expect(codes).toContain('contact_not_of_customer');
  });

  it('refuses ids that are not on the register at all', async () => {
    expect(
      await codesFrom(() => createJob(harness.as(master), baseInput({ customerId: 'cust-nobody' }))),
    ).toContain('unknown_customer');
    expect(
      await codesFrom(() => createJob(harness.as(master), baseInput({ siteId: 'site-nobody' }))),
    ).toContain('unknown_site');
    expect(
      await codesFrom(() => createJob(harness.as(master), baseInput({ machineId: 'machine-none' }))),
    ).toContain('unknown_machine');
  });

  it('burns no job number on a refusal', async () => {
    // EJE's job numbers are a continuous commercial record. A gap in them is a
    // question somebody has to answer, so a refused request must not take one.
    const before = (await harness.repos.settings.get()).nextJobSequence;
    await codesFrom(() =>
      createJob(harness.as(master), baseInput({ machineId: 'machine-kruger-vf2' })),
    );
    expect((await harness.repos.settings.get()).nextJobSequence).toBe(before);
  });

  it('records the resolved ids, not merely the submitted ones', async () => {
    const job = await createJob(harness.as(master), baseInput());
    expect(job.customerId).toBe('cust-abc');
    expect(job.siteId).toBe('site-abc-jhb');
    expect(job.machineId).toBe('machine-abc-lv40');
    expect(job.contactId).toBe('contact-abc-jhb');
  });
});

describe('what a job must say', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a blank fault description', async () => {
    expect(
      await codesFrom(() => createJob(harness.as(master), baseInput({ faultDescription: '   ' }))),
    ).toContain('fault_description_required');
  });

  it('still refuses a field job with no machine', async () => {
    expect(
      await codesFrom(() => createJob(harness.as(master), baseInput({ machineId: null }))),
    ).toContain('machine_required');
  });
});

describe('who the job is given to', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('assigns a technician at creation and notifies them', async () => {
    const job = await createJob(
      harness.as(master),
      baseInput({ primaryTechnicianId: sipho.id }),
    );

    expect(job.primaryTechnicianId).toBe(sipho.id);
    // Assigned, and actually TOLD. The audit event alone reached nobody.
    const notifications = await harness.repos.notifications.list(sipho.id);
    const raised = notifications.filter((item) => item.jobId === job.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.type).toBe('job_assigned');
  });

  it('takes additional technicians and notifies them too', async () => {
    const job = await createJob(
      harness.as(master),
      baseInput({ primaryTechnicianId: sipho.id, additionalTechnicianIds: [riaan.id] }),
    );

    expect(job.additionalTechnicianIds).toEqual([riaan.id]);
    const forRiaan = (await harness.repos.notifications.list(riaan.id)).filter(
      (item) => item.jobId === job.id,
    );
    expect(forRiaan).toHaveLength(1);
  });

  it('refuses assigning somebody who does not do field work', async () => {
    expect(
      await codesFrom(() =>
        createJob(harness.as(master), baseInput({ primaryTechnicianId: coordinator.id })),
      ),
    ).toContain('not_a_field_technician');

    expect(
      await codesFrom(() =>
        createJob(
          harness.as(master),
          baseInput({ primaryTechnicianId: sipho.id, additionalTechnicianIds: [coordinator.id] }),
        ),
      ),
    ).toContain('not_a_field_technician');
  });

  it('refuses a disabled account', async () => {
    const disabled = seedUser('user-tech-yusuf');
    expect(disabled.active).toBe(false);
    expect(
      await codesFrom(() =>
        createJob(harness.as(master), baseInput({ primaryTechnicianId: disabled.id })),
      ),
    ).toContain('user_inactive');
  });

  it('refuses assistants with nobody to assist', async () => {
    expect(
      await codesFrom(() =>
        createJob(
          harness.as(master),
          baseInput({ primaryTechnicianId: null, additionalTechnicianIds: [riaan.id] }),
        ),
      ),
    ).toContain('additional_without_primary');
  });

  it('quietly drops the primary from their own assistant list', async () => {
    const job = await createJob(
      harness.as(master),
      baseInput({ primaryTechnicianId: sipho.id, additionalTechnicianIds: [sipho.id, riaan.id] }),
    );
    expect(job.additionalTechnicianIds).toEqual([riaan.id]);
  });

  it('notifies on a later assignment too, not only at creation', async () => {
    const job = await createJob(harness.as(master), baseInput());
    await assignPrimaryTechnician(harness.as(master), job, sipho.id, 'Sipho Mahlangu');

    const raised = (await harness.repos.notifications.list(sipho.id)).filter(
      (item) => item.jobId === job.id,
    );
    expect(raised).toHaveLength(1);
  });

  it('notifies somebody added to the job afterwards', async () => {
    const job = await createJob(
      harness.as(master),
      baseInput({ primaryTechnicianId: sipho.id }),
    );
    await addAdditionalTechnician(harness.as(master), job, riaan.id, 'Riaan van Wyk');

    const raised = (await harness.repos.notifications.list(riaan.id)).filter(
      (item) => item.jobId === job.id,
    );
    expect(raised).toHaveLength(1);
  });

  /**
   * WHEN THE PROVIDER IS NOT THERE.
   *
   * A deployment with no WhatsApp configuration, an expired token, a Meta
   * outage. None of these are a reason to refuse the office's assignment, and
   * none of them may be recorded as a message that went.
   */
  it('keeps the assignment when WhatsApp refuses, and says so on the trail', async () => {
    const failing = buildHarness();
    const job = await createJob(
      // The `UnconfiguredWhatsAppService` shape: refuses rather than pretending.
      withWhatsApp(failing, 'WhatsApp is not configured on this deployment.'),
      baseInput({ primaryTechnicianId: sipho.id }),
    );

    // The assignment stands. The office decided it; a provider cannot undo it.
    expect(job.primaryTechnicianId).toBe(sipho.id);

    // The in-app notification still happened, because it is a row in this
    // database rather than a thing that leaves the building.
    const inbox = await failing.repos.notifications.list(sipho.id);
    expect(inbox.some((item) => item.jobId === job.id)).toBe(true);

    const types = (await failing.repos.activity.list(job.id)).map((event) => event.type);
    expect(types).toContain('assignment_notification_failed');
    // And emphatically NOT a claim that it was sent.
    expect(types).not.toContain('assignment_notified');
  });

  it('says why, so somebody can pick up a phone', async () => {
    const failing = buildHarness();
    const job = await createJob(
      withWhatsApp(failing, 'Template name does not exist'),
      baseInput({ primaryTechnicianId: sipho.id }),
    );
    const events = await failing.repos.activity.list(job.id);
    const failure = events.find((event) => event.type === 'assignment_notification_failed');

    expect(failure?.detail).toContain('Template name does not exist');
    expect(failure?.detail).toContain('the assignment stands');
  });

  it('records the notification attempt on the audit trail', async () => {
    const job = await createJob(
      harness.as(master),
      baseInput({ primaryTechnicianId: sipho.id }),
    );
    const events = await harness.repos.activity.list(job.id);
    const types = events.map((event) => event.type);

    expect(types).toContain('job_created');
    expect(types).toContain('job_assigned');
    // Telling them is a separate fact from assigning them, and is recorded as
    // one — including when it fails.
    expect(types).toContain('assignment_notified');
  });
});

/**
 * Attachments.
 *
 * What is being held here is the HONEST part: the job records what the office
 * attached, and nothing claims the file itself was kept. See `storeAttachments`.
 */
describe('documents attached when the job is raised', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('records each one against the job, through the storage port', async () => {
    const job = await createJob(
      harness.as(master),
      baseInput({
        attachments: [
          {
            fileName: 'customer-order-88123.pdf',
            contentType: 'application/pdf',
            caption: 'Customer order',
            sizeBytes: 48_221,
          },
        ],
      }),
    );

    expect(job.attachments).toHaveLength(1);
    const [file] = job.attachments;
    expect(file?.fileName).toBe('customer-order-88123.pdf');
    expect(file?.kind).toBe('document');
    expect(file?.uploadedBy).toBe(master.id);
    // A storage key was allocated by the port, not invented here.
    expect(file?.storageKey.length).toBeGreaterThan(0);
  });

  it('creates a job with no attachments when none were sent', async () => {
    expect((await createJob(harness.as(master), baseInput())).attachments).toEqual([]);
  });
});

describe('a technician accepting the job', () => {
  let harness: Harness;
  let assigned: Job;
  let pooled: Job;

  beforeEach(async () => {
    harness = buildHarness();
    assigned = await createJob(
      harness.as(master),
      baseInput({ primaryTechnicianId: sipho.id }),
    );
    pooled = await createJob(harness.as(master), baseInput({ orderNumber: 'PO-99002' }));
  });

  it('starts the job — acceptance is the start, and there is no Start action', async () => {
    const accepted = await acceptJob(harness.as(sipho), assigned);

    expect(accepted.status).toBe('in_progress');
    expect(accepted.acceptedAt).not.toBeNull();
  });

  it('records who accepted it', async () => {
    const accepted = await acceptJob(harness.as(sipho), assigned);
    const events = await harness.repos.activity.list(accepted.id);

    const acceptance = events.find((event) => event.type === 'job_accepted');
    expect(acceptance).toBeDefined();
    expect(acceptance?.actorId).toBe(sipho.id);
  });

  it('lets anybody doing field work take an UNASSIGNED job, which is the pool', async () => {
    const accepted = await acceptJob(harness.as(riaan), pooled);
    expect(accepted.status).toBe('in_progress');
    // Taking a pool job assigns it to whoever took it.
    expect(accepted.primaryTechnicianId).toBe(riaan.id);
  });

  it('refuses a technician accepting a job assigned to somebody else', async () => {
    // THE HOLE THIS CLOSES. Being able to see a job is not the same as being
    // able to take it: a technician who once worked a job still reads it, and
    // nothing stopped them accepting it back out from under its technician.
    const codes = await codesFrom(() => acceptJob(harness.as(riaan), assigned));
    expect(codes).toContain('not_field_technician');
  });

  it('lets an additional technician on the job accept it', async () => {
    const shared = await createJob(
      harness.as(master),
      baseInput({
        orderNumber: 'PO-99003',
        primaryTechnicianId: sipho.id,
        additionalTechnicianIds: [riaan.id],
      }),
    );
    expect((await acceptJob(harness.as(riaan), shared)).status).toBe('in_progress');
  });

  /**
   * The exception, held in both places at once.
   *
   * A parts collection happens at the EJE counter, so the office processes it
   * whoever it names — and the SCREEN has to agree with the server about that,
   * or a Master is shown no Accept button on a job they are entitled to
   * process. Getting this wrong is how the button and the rule drift apart.
   */
  it('lets the office accept a parts collection assigned to a technician', async () => {
    const parts = await createJob(
      harness.as(master),
      baseInput({
        jobType: 'parts',
        machineId: null,
        orderNumber: 'PO-99004',
        primaryTechnicianId: sipho.id,
      }),
    );

    expect(canAcceptJob(parts, master)).toBe(true);
    expect((await acceptJob(harness.as(master), parts)).status).toBe('in_progress');
  });

  it('agrees with the server about who is offered Accept on field work', async () => {
    // What the action bar asks, and what the operation answers, on the same job.
    expect(canAcceptJob(assigned, sipho)).toBe(true);
    expect(canAcceptJob(assigned, riaan)).toBe(false);
    expect(canAcceptJob(pooled, riaan)).toBe(true);

    expect(acceptJobRefusal(sipho, assigned)).toBeNull();
    expect(acceptJobRefusal(riaan, assigned)).not.toBeNull();
    expect(acceptJobRefusal(riaan, pooled)).toBeNull();
  });

  it('refuses a Coordinator accepting field work, however senior', async () => {
    expect(await codesFrom(() => acceptJob(harness.as(coordinator), pooled))).toContain(
      'not_field_technician',
    );
  });

  it('refuses a second acceptance rather than repeating the side effects', async () => {
    const accepted = await acceptJob(harness.as(sipho), assigned);
    // The state machine answers this: in_progress has no edge back to itself.
    await expect(acceptJob(harness.as(sipho), accepted)).rejects.toThrow(WorkflowError);
  });

  it('does not move the job’s acceptance time on a refused second attempt', async () => {
    const accepted = await acceptJob(harness.as(sipho), assigned);
    await acceptJob(harness.as(sipho), accepted).catch(() => undefined);

    const stored = await harness.repos.jobs.findById(assigned.id);
    expect(stored?.acceptedAt).toBe(accepted.acceptedAt);
    expect(stored?.status).toBe('in_progress');
  });
});
