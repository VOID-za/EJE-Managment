import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addNote,
  addPart,
  answerChecklistItem,
  returnJobToOpen,
  saveCompletionReport,
  startChecklist,
  submitJobCard,
  transferJobToTechnician,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, dayOffset, seedUser, type Harness } from './test-harness';
import { canTransferJob, type Job } from '@/domain';

/**
 * Job transfer.
 *
 * The rule that matters on site: handing a job on never loses the work already
 * captured against it. It is a status and ownership change on the SAME job —
 * same number, same photos, same labour, same checklist progress — so whoever
 * picks it up starts from where the last technician stopped.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');
const lerato = seedUser('user-tech-lerato');
const riaan = seedUser('user-tech-riaan');

const REASON = { reason: 'vehicle_problem' as const, description: '' };

/** EJE-1048 accepted by Sipho with real work captured against it. */
const workedJob = async (harness: Harness): Promise<Job> => {
  const found = await harness.repos.jobs.findByJobNumber('EJE-1048');
  let job = await acceptJob(harness.as(sipho), found!);
  job = await addLabour(harness.as(sipho), job, {
    date: dayOffset(0),
    rateType: 'normal',
    hours: 2.5,
    description: 'Stripped the spindle drive',
  });
  job = await addPart(harness.as(sipho), job, {
    partNumber: 'FAN-24V-80',
    description: 'Cooling fan',
    quantity: 1,
    unitPrice: 48500,
  });
  job = await addNote(harness.as(sipho), job, 'Customer asked about a quote.', false);
  job = await saveCompletionReport(harness.as(sipho), job, {
    ...job.completionReport,
    faultFindings: 'Fan seized.',
  });
  return job;
};

describe('who may transfer a job', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('lets a technician transfer their own active job', async () => {
    const job = await workedJob(harness);
    expect(canTransferJob(sipho, job)).toBe(true);
  });

  it("refuses a technician transferring someone else's job", async () => {
    const job = await workedJob(harness);
    expect(canTransferJob(lerato, job)).toBe(false);

    await expect(
      returnJobToOpen(harness.as(lerato), job, REASON),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('lets a Master transfer any active job', async () => {
    const job = await workedJob(harness);
    expect(canTransferJob(elmarie, job)).toBe(true);
  });

  it('refuses to transfer a closed job', async () => {
    const closed = await harness.repos.jobs.findByJobNumber('EJE-1056');
    expect(closed?.status).toBe('closed');
    expect(canTransferJob(elmarie, closed!)).toBe(false);

    await expect(
      returnJobToOpen(harness.as(elmarie), closed!, REASON),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses to transfer a job already submitted for Master review', async () => {
    const submitted = await harness.repos.jobs.findByJobNumber('EJE-1055');
    expect(submitted?.status).toBe('submitted');
    await expect(
      returnJobToOpen(harness.as(elmarie), submitted!, REASON),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('requires a description when the reason is Other', async () => {
    const job = await workedJob(harness);
    await expect(
      returnJobToOpen(harness.as(sipho), job, { reason: 'other', description: '  ' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('returning a job to Open', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('moves it back to Open and releases the technician', async () => {
    const job = await workedJob(harness);
    const returned = await returnJobToOpen(harness.as(sipho), job, REASON);

    expect(returned.status).toBe('open');
    expect(returned.primaryTechnicianId).toBeNull();
    expect(returned.acceptedAt).toBeNull();
  });

  it('keeps every piece of work already captured', async () => {
    const job = await workedJob(harness);
    const returned = await returnJobToOpen(harness.as(sipho), job, REASON);

    expect(returned.labour).toHaveLength(job.labour.length);
    expect(returned.parts).toHaveLength(job.parts.length);
    expect(returned.notes).toHaveLength(job.notes.length);
    expect(returned.photos).toHaveLength(job.photos.length);
    expect(returned.completionReport.faultFindings).toBe('Fan seized.');
    expect(returned.faultDescription).toBe(job.faultDescription);
    expect(returned.jobNumber).toBe('EJE-1048');
  });

  it('keeps checklist progress', async () => {
    // EJE-1053 is a service job already in Completion, so it is workable as is.
    const template = (await harness.repos.checklistTemplates.findForJobType('service'))!;
    let job = (await harness.repos.jobs.findByJobNumber('EJE-1053'))!;
    job = await harness.repos.jobs.save({ ...job, primaryTechnicianId: sipho.id });
    job = await startChecklist(harness.as(sipho), job, template);
    const firstItem = template.sections[0]!.items[0]!;
    job = await answerChecklistItem(harness.as(sipho), job, firstItem.id, { choice: 'pass' });

    const answeredBefore = job.checklist!.responses.filter(
      (response) => response.answeredAt !== null,
    ).length;
    expect(answeredBefore).toBeGreaterThan(0);

    const returned = await returnJobToOpen(harness.as(sipho), job, REASON);
    expect(returned.checklist).not.toBeNull();
    expect(
      returned.checklist!.responses.filter((response) => response.answeredAt !== null),
    ).toHaveLength(answeredBefore);
  });

  it('leaves the scheduled date alone', async () => {
    const job = await workedJob(harness);
    const returned = await returnJobToOpen(harness.as(sipho), job, REASON);
    expect(returned.scheduledDate).toBe(job.scheduledDate);
  });

  it('lets another technician accept it and see the previous work', async () => {
    const job = await workedJob(harness);
    await returnJobToOpen(harness.as(sipho), job, REASON);

    const reopened = (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;
    const accepted = await acceptJob(harness.as(riaan), reopened);

    expect(accepted.status).toBe('in_progress');
    expect(accepted.primaryTechnicianId).toBe(riaan.id);
    expect(accepted.labour).toHaveLength(job.labour.length);
    expect(accepted.parts).toHaveLength(job.parts.length);
  });

  it('records the transfer on the activity trail with its reason', async () => {
    const job = await workedJob(harness);
    await returnJobToOpen(harness.as(sipho), job, {
      reason: 'sick_or_unavailable',
      description: 'Came down with flu overnight.',
    });

    const trail = await harness.repos.activity.list(job.id);
    const entry = trail.find((event) => event.type === 'job_transferred_to_open');
    expect(entry?.summary).toContain('Sipho Mahlangu');
    expect(entry?.summary).toContain('Open Jobs');
    expect(entry?.detail).toContain('Sick / unavailable');
    expect(entry?.detail).toContain('flu');
    expect(entry?.actorId).toBe(sipho.id);
  });
});

describe('transferring to a named technician', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('makes the receiving technician the primary, on the same job', async () => {
    const job = await workedJob(harness);
    const transferred = await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);

    expect(transferred.primaryTechnicianId).toBe(riaan.id);
    expect(transferred.jobNumber).toBe('EJE-1048');
    expect(transferred.id).toBe(job.id);
    expect(transferred.status).toBe('in_progress');
  });

  it('creates no second job', async () => {
    const before = await harness.repos.jobs.list();
    const job = await workedJob(harness);
    await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);
    const after = await harness.repos.jobs.list();

    expect(after).toHaveLength(before.length);
  });

  it('keeps all existing work', async () => {
    const job = await workedJob(harness);
    const transferred = await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);

    expect(transferred.labour).toHaveLength(job.labour.length);
    expect(transferred.parts).toHaveLength(job.parts.length);
    expect(transferred.notes).toHaveLength(job.notes.length);
  });

  it('notifies the receiving technician', async () => {
    const job = await workedJob(harness);
    await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);

    const notifications = await harness.repos.notifications.list(riaan.id);
    const transfer = notifications.find(
      (notification) => notification.type === 'job_transferred',
    );
    expect(transfer?.title).toContain('EJE-1048');
    expect(transfer?.body).toContain('Sipho Mahlangu');
  });

  it('records both technicians and the reason on the trail', async () => {
    const job = await workedJob(harness);
    await transferJobToTechnician(harness.as(sipho), job, riaan.id, {
      reason: 'customer_requested',
      description: 'Customer asked for Riaan, who fitted the machine.',
    });

    const trail = await harness.repos.activity.list(job.id);
    const entry = trail.find((event) => event.type === 'job_transferred_to_technician');
    expect(entry?.summary).toContain('Sipho Mahlangu');
    expect(entry?.summary).toContain('Riaan');
    expect(entry?.detail).toContain('Customer requested');
  });

  it('refuses a transfer to the technician who already holds it', async () => {
    const job = await workedJob(harness);
    await expect(
      transferJobToTechnician(harness.as(sipho), job, sipho.id, REASON),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses a transfer to a disabled account', async () => {
    const job = await workedJob(harness);
    const yusuf = seedUser('user-tech-yusuf');
    await expect(
      transferJobToTechnician(harness.as(sipho), job, yusuf.id, REASON),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('does not let a transferred job be submitted by the old technician path', async () => {
    const job = await workedJob(harness);
    const transferred = await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);
    await expect(
      submitJobCard(harness.as(elmarie), transferred, 'a@b.co.za', 'Customer'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});
