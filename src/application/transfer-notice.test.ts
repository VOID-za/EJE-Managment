import { beforeEach, describe, expect, it } from 'vitest';
import { acceptJob, transferJobToTechnician } from './job-operations';
import { ASSIGNMENT_TEMPLATE } from './assignment-notice';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * A TRANSFER REACHES THE RECEIVING TECHNICIAN ON WHATSAPP. WA-TRANSFER-1.
 *
 * It told them only in the application, so a technician on the road learned
 * they had been handed a breakdown when they next opened it. Now a transfer
 * queues the same approved template an assignment does (BD-25 records that the
 * wording is provisional) — on the outbox, inside the transaction, never sent
 * from the operation itself.
 */
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const REASON = { reason: 'vehicle_problem' as const, description: '' };

describe('the WhatsApp notice on a transfer', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const accepted = async () =>
    acceptJob(harness.as(sipho), (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);

  it('queues the approved assignment template to the receiving technician’s own number', async () => {
    const job = await accepted();
    const before = (await harness.repos.outbox.list()).filter((m) => m.jobId === job.id).length;

    await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);

    const queued = (await harness.repos.outbox.list()).filter((m) => m.jobId === job.id);
    expect(queued).toHaveLength(before + 1);
    const message = queued.at(-1)!;
    expect(message).toMatchObject({
      channel: 'whatsapp',
      template: ASSIGNMENT_TEMPLATE,
      recipient: riaan.mobile,
      state: 'pending',
    });
    expect(message.parameters[0]).toBe('EJE-1048');
    expect(message.preview).toContain('transferred to you');

    const trail = (await harness.repos.activity.list(job.id)).map((event) => event.summary);
    expect(trail).toContain(`Riaan van Wyk notified of the transfer`);
    // The in-app notice still carries the reason, and says WhatsApp went too.
    const notices = await harness.repos.notifications.list(riaan.id);
    const notice = notices.find((entry) => entry.type === 'job_transferred' && entry.jobId === job.id);
    expect(notice?.body).toContain('Reason');
    expect(notice?.channels).toEqual(['in_app', 'whatsapp']);
  });

  it('a technician with no mobile number is told in the app only — and the transfer stands', async () => {
    const job = await accepted();
    const stored = (await harness.repos.users.findById(riaan.id))!;
    await harness.repos.users.save({ ...stored, mobile: '' });

    const transferred = await transferJobToTechnician(harness.as(sipho), job, riaan.id, REASON);

    expect(transferred.primaryTechnicianId).toBe(riaan.id);
    expect((await harness.repos.outbox.list()).filter((m) => m.jobId === job.id && m.recipient === '')).toHaveLength(0);
    const trail = await harness.repos.activity.list(job.id);
    const failure = trail.find((event) => event.type === 'assignment_notification_failed');
    expect(failure?.detail).toContain('The transfer stands.');
  });
});
