import { beforeEach, describe, expect, it } from 'vitest';
import {
  assignableToJobs,
  canAcceptJob,
  canSubmitJobCard,
  isAssignableTechnician,
  type UserRole,
} from '@/domain';
import { createJob, type NewJobInput } from './job-creation';
import {
  acceptJob,
  addAdditionalTechnician,
  addLabour,
  assignPrimaryTechnician,
  saveCompletionReport,
  transferJobToTechnician,
} from './job-operations';
import { ASSIGNMENT_TEMPLATE, TRANSFER_TEMPLATE } from './assignment-notice';
import { WorkflowError } from './errors';
import { buildHarness, dayOffset, seedUser, type Harness } from './test-harness';

/**
 * A SENIOR TECH CAN BE GIVEN A JOB. JOB-ASSIGN-ST-1 (7 November 2026).
 *
 * The Senior Tech (`master`) has always held `jobs.acceptField` — he may accept,
 * work and submit a job he is on — but every picker asked `isFieldRole`, so the
 * office could never put him on one. One rule now decides it for the server and
 * the screens alike (`assignableToJobs`), and these hold the server to it: a
 * Senior Tech is accepted as primary, as additional and on a transfer, told
 * exactly as a technician is told, and the Office, a disabled account and an id
 * nobody holds are still refused.
 */
const elmarie = seedUser('user-master-elmarie');
const johan = seedUser('user-master-johan');
const coordinator = seedUser('user-coord-christene');
const sipho = seedUser('user-tech-sipho');

const REASON = { reason: 'vehicle_problem' as const, description: '' };

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
    orderNumber: 'PO-77001',
    referenceNumber: '',
    faultDescription: 'Spindle drive tripping on start-up.',
    primaryTechnicianId: null,
    additionalTechnicianIds: [],
    courierCollection: false,
    deliveryNote: '',
    attachments: [],
    ...over,
  }) as unknown as NewJobInput;

const codesFrom = async (run: () => Promise<unknown>): Promise<readonly string[]> => {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof WorkflowError) return cause.violations.map((violation) => violation.code);
    throw cause;
  }
  throw new Error('Expected the operation to be refused, and it was not.');
};

describe('the one rule — who a job may be given to', () => {
  it('is a Technician, an Apprentice or a Senior Tech, and never the Office', () => {
    const roles: readonly UserRole[] = ['master', 'coordinator', 'technician', 'apprentice'];
    expect(roles.filter(assignableToJobs)).toEqual(['master', 'technician', 'apprentice']);
  });

  it('and only while the account is active', () => {
    expect(isAssignableTechnician(johan)).toBe(true);
    expect(isAssignableTechnician({ ...johan, active: false })).toBe(false);
    expect(isAssignableTechnician(coordinator)).toBe(false);
    expect(isAssignableTechnician(seedUser('user-tech-yusuf'))).toBe(false);
  });
});

describe('a Senior Tech on a new job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is accepted as the primary technician, and told as a technician is told', async () => {
    const job = await createJob(harness.as(elmarie), baseInput({ primaryTechnicianId: johan.id }));

    expect(job.primaryTechnicianId).toBe(johan.id);
    const notices = (await harness.repos.notifications.list(johan.id)).filter(
      (item) => item.jobId === job.id,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.type).toBe('job_assigned');

    const queued = (await harness.repos.outbox.list()).filter((m) => m.jobId === job.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ template: ASSIGNMENT_TEMPLATE, recipient: johan.mobile });

    const trail = await harness.repos.activity.list(job.id);
    const types = trail.map((event) => event.type);
    expect(types).toContain('job_assigned');
    expect(types).toContain('assignment_notified');
    // The trail names the Senior Tech who was given the job, and the person who gave it.
    expect(trail.find((event) => event.type === 'job_assigned')?.actorId).toBe(elmarie.id);
    expect(trail.some((event) => event.summary.includes('Johan Erasmus'))).toBe(true);
  });

  it('is accepted as an additional technician, and told too', async () => {
    const job = await createJob(
      harness.as(coordinator),
      baseInput({ primaryTechnicianId: sipho.id, additionalTechnicianIds: [johan.id] }),
    );

    expect(job.additionalTechnicianIds).toEqual([johan.id]);
    const notices = (await harness.repos.notifications.list(johan.id)).filter(
      (item) => item.jobId === job.id,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.type).toBe('job_assigned');
  });

  it('is dropped, not doubled, when named as his own assistant or twice', async () => {
    const job = await createJob(
      harness.as(elmarie),
      baseInput({ primaryTechnicianId: johan.id, additionalTechnicianIds: [johan.id, sipho.id, sipho.id] }),
    );
    expect(job.primaryTechnicianId).toBe(johan.id);
    expect(job.additionalTechnicianIds).toEqual([sipho.id]);
  });

  it('refuses the Office, a disabled Senior Tech and an id nobody holds', async () => {
    expect(
      await codesFrom(() =>
        createJob(harness.as(elmarie), baseInput({ primaryTechnicianId: coordinator.id })),
      ),
    ).toContain('not_a_field_technician');

    await harness.repos.users.save({ ...johan, active: false });
    expect(
      await codesFrom(() =>
        createJob(harness.as(elmarie), baseInput({ primaryTechnicianId: johan.id })),
      ),
    ).toContain('user_inactive');
    expect(
      await codesFrom(() =>
        createJob(
          harness.as(elmarie),
          baseInput({ primaryTechnicianId: sipho.id, additionalTechnicianIds: [johan.id] }),
        ),
      ),
    ).toContain('user_inactive');

    expect(
      await codesFrom(() =>
        createJob(harness.as(elmarie), baseInput({ primaryTechnicianId: 'user-nobody' })),
      ),
    ).toContain('user_inactive');
  });
});

describe('a Senior Tech put on an existing job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is assigned as primary later, by the office, with the same notice and trail', async () => {
    const job = await createJob(harness.as(elmarie), baseInput());
    const saved = await assignPrimaryTechnician(harness.as(coordinator), job, johan.id, 'Johan Erasmus');

    expect(saved.primaryTechnicianId).toBe(johan.id);
    const notices = (await harness.repos.notifications.list(johan.id)).filter(
      (item) => item.jobId === job.id,
    );
    expect(notices.map((item) => item.type)).toEqual(['job_assigned']);
    const entry = (await harness.repos.activity.list(job.id)).find(
      (event) => event.type === 'job_assigned',
    );
    expect(entry?.summary).toBe('Job assigned to Johan Erasmus');
    expect(entry?.actorId).toBe(coordinator.id);
  });

  it('is added as an additional technician once, however often he is added', async () => {
    const job = await createJob(harness.as(elmarie), baseInput({ primaryTechnicianId: sipho.id }));
    const once = await addAdditionalTechnician(harness.as(elmarie), job, johan.id, 'Johan Erasmus');
    const twice = await addAdditionalTechnician(harness.as(elmarie), once, johan.id, 'Johan Erasmus');

    expect(twice.additionalTechnicianIds).toEqual([johan.id]);
    const notices = (await harness.repos.notifications.list(johan.id)).filter(
      (item) => item.jobId === job.id,
    );
    expect(notices).toHaveLength(1);
    const added = (await harness.repos.activity.list(job.id)).filter(
      (event) => event.type === 'technician_added',
    );
    expect(added.map((event) => event.summary)).toEqual(['Johan Erasmus added to the job']);
  });

  it('still refuses the Office, a disabled account and an unknown id on assignment', async () => {
    const job = await createJob(harness.as(elmarie), baseInput());
    expect(
      await codesFrom(() => assignPrimaryTechnician(harness.as(elmarie), job, coordinator.id, 'x')),
    ).toContain('not_a_field_technician');
    expect(
      await codesFrom(() => addAdditionalTechnician(harness.as(elmarie), job, coordinator.id, 'x')),
    ).toContain('not_a_field_technician');
    expect(
      await codesFrom(() =>
        assignPrimaryTechnician(harness.as(elmarie), job, 'user-nobody' as typeof johan.id, 'x'),
      ),
    ).toContain('unknown_user');

    await harness.repos.users.save({ ...johan, active: false });
    expect(
      await codesFrom(() => assignPrimaryTechnician(harness.as(elmarie), job, johan.id, 'x')),
    ).toContain('user_inactive');
    expect(
      await codesFrom(() => addAdditionalTechnician(harness.as(elmarie), job, johan.id, 'x')),
    ).toContain('user_inactive');
  });

  it('a technician cannot assign a Senior Tech, any more than anybody else', async () => {
    const job = await createJob(harness.as(elmarie), baseInput());
    expect(
      await codesFrom(() => assignPrimaryTechnician(harness.as(sipho), job, johan.id, 'x')),
    ).toContain('not_permitted');
  });
});

describe('a job transferred to a Senior Tech', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const accepted = async () =>
    acceptJob(harness.as(sipho), (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);

  it('makes him the primary, and tells him on the transfer template', async () => {
    const job = await accepted();
    const transferred = await transferJobToTechnician(harness.as(sipho), job, johan.id, REASON);

    expect(transferred.primaryTechnicianId).toBe(johan.id);
    const notice = (await harness.repos.notifications.list(johan.id)).find(
      (item) => item.type === 'job_transferred' && item.jobId === job.id,
    );
    expect(notice?.body).toContain('Sipho Mahlangu');
    const queued = (await harness.repos.outbox.list()).filter((m) => m.jobId === job.id).at(-1);
    expect(queued).toMatchObject({ template: TRANSFER_TEMPLATE, recipient: johan.mobile });
    const entry = (await harness.repos.activity.list(job.id)).find(
      (event) => event.type === 'job_transferred_to_technician',
    );
    expect(entry?.summary).toContain('Johan Erasmus');
  });

  it('refuses the Office and a disabled Senior Tech', async () => {
    const job = await accepted();
    expect(
      await codesFrom(() => transferJobToTechnician(harness.as(sipho), job, coordinator.id, REASON)),
    ).toContain('not_a_field_technician');
    await harness.repos.users.save({ ...johan, active: false });
    expect(
      await codesFrom(() => transferJobToTechnician(harness.as(sipho), job, johan.id, REASON)),
    ).toContain('user_inactive');
  });
});

describe('a Senior Tech assigned to a job works it as its technician', () => {
  it('accepts it, records work on it, and may submit it', async () => {
    const harness = buildHarness();
    const created = await createJob(harness.as(coordinator), baseInput({ primaryTechnicianId: johan.id }));

    expect(canAcceptJob(created, johan)).toBe(true);
    // Somebody else's job is still not his to take, whatever his seniority.
    expect(canAcceptJob(created, elmarie)).toBe(false);

    let job = await acceptJob(harness.as(johan), created);
    expect(job.status).toBe('in_progress');
    job = await addLabour(harness.as(johan), job, {
      date: dayOffset(0),
      rateType: 'normal',
      hours: 1.5,
      description: 'Reset the drive and tested under load.',
    });
    job = await saveCompletionReport(harness.as(johan), job, {
      ...job.completionReport,
      workPerformed: 'Reset the drive.',
    });
    expect(job.labour).toHaveLength(1);
    // Submitting is the attending technician's: his, and not another Senior Tech's.
    expect(canSubmitJobCard(johan, job)).toBe(true);
    expect(canSubmitJobCard(elmarie, job)).toBe(false);
  });
});
