import { beforeEach, describe, expect, it } from 'vitest';
import type { AppNotification, Job } from '@/domain';
import {
  acceptJob,
  addLabour,
  captureSignature,
  issueJobCard,
  recordSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * WHO THE OFFICE HEARS FROM, AND WHEN. MASTER SCOPE §3.2, §7, §15, §22.
 *
 * §22 records the demo finding this file exists for: a technician finished a
 * job and the Coordinator learned nothing. Tracing it against §15 found two
 * separate problems, and both are asserted here.
 *
 *  1. THE SIGNED HAND-OVER RAISED NOTHING AT ALL. `job_submitted` was a
 *     declared NotificationType with no producer anywhere — the identically
 *     named thing at the issue path is an AUDIT event. §7 makes office review
 *     mandatory, and a review queue nobody is told about is not a workflow.
 *  2. "THE OFFICE" MEANT MASTERS. `notifyOffice` existed and was called from
 *     exactly one place in the codebase.
 *
 * A declared type is not a produced notification. Every case here asserts the
 * producer, the recipients, and that it was persisted against the right people
 * unread — not that a type exists.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const inboxOf = async (harness: Harness, userId: string): Promise<readonly AppNotification[]> =>
  harness.repos.notifications.list(userId as never);

const of = (notifications: readonly AppNotification[], type: string, jobId: string) =>
  notifications.filter((entry) => entry.type === type && entry.jobId === jobId);

/** EJE-1048 worked through to the point the customer is asked to sign. */
const workUpToSignature = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  const tech = harness.as(technician);

  let job = await acceptJob(tech, view!.job);
  job = await addLabour(tech, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 2,
    description: 'Spindle drive repair',
  });
  job = await saveCompletionReport(tech, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await startCompletion(tech, job);
  return startSignature(tech, job);
};

describe('the customer signs — the job reaches the office', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const ready = await workUpToSignature(harness);
    job = await captureSignature(harness.as(technician), ready, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
  });

  it('leaves the job at Review, for the office to act on', () => {
    expect(job.status).toBe('review');
  });

  it('notifies the MASTER', async () => {
    const raised = of(await inboxOf(harness, master.id), 'job_submitted', job.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.readAt).toBeNull();
  });

  it('notifies the COORDINATOR — the §22 finding', async () => {
    const raised = of(await inboxOf(harness, coordinator.id), 'job_submitted', job.id);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.readAt).toBeNull();
  });

  it('does not notify the technician who just did it', async () => {
    expect(of(await inboxOf(harness, technician.id), 'job_submitted', job.id)).toHaveLength(0);
  });

  it('links to the review screen, because reviewing is what is being asked', async () => {
    const raised = of(await inboxOf(harness, master.id), 'job_submitted', job.id);
    expect(raised[0]?.link).toBe(`/jobs/${job.jobNumber}/review`);
  });

  it('raises it exactly once per recipient', async () => {
    // A duplicate notification is an unread badge that lies about how much
    // work is waiting.
    for (const person of [master, coordinator]) {
      expect(of(await inboxOf(harness, person.id), 'job_submitted', job.id)).toHaveLength(1);
    }
  });
});

describe('the customer refuses — the confirmed refusal decision', () => {
  let harness: Harness;
  let job: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const ready = await workUpToSignature(harness);
    job = await recordSignatureRefusal(harness.as(technician), ready, {
      reason: 'The customer disputes the hours recorded.',
    });
  });

  it('notifies BOTH the Master and the Coordinator', async () => {
    /*
     * The confirmed decision, verbatim: "BOTH MASTER AND COORDINATOR receive
     * an in-app notification". §15 lists the Master; §3.2 puts the Coordinator
     * in the office and the decision settles it.
     */
    expect(of(await inboxOf(harness, master.id), 'signature_refused', job.id)).toHaveLength(1);
    expect(of(await inboxOf(harness, coordinator.id), 'signature_refused', job.id)).toHaveLength(1);
  });

  it('leaves both unread, so the office can see there is something to do', async () => {
    for (const person of [master, coordinator]) {
      const raised = of(await inboxOf(harness, person.id), 'signature_refused', job.id);
      expect(raised[0]?.readAt).toBeNull();
      expect(raised[0]?.handledAt).toBeNull();
    }
  });

  it('does not notify the technician who was turned away', async () => {
    expect(of(await inboxOf(harness, technician.id), 'signature_refused', job.id)).toHaveLength(0);
  });
});

describe('the final submission is the Master’s — §3.1, §7, §15', () => {
  let harness: Harness;
  let signed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const ready = await workUpToSignature(harness);
    signed = await captureSignature(harness.as(technician), ready, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
  });

  it('refuses the TECHNICIAN, and sends the customer nothing', async () => {
    /*
     * The audit's critical finding. A technician calling this was refused only
     * by the job's STATUS — so on a job at Review, as this one is, they would
     * have generated the final document and emailed the customer. §7:
     * "Technician submission … does not email the customer or finalise
     * closure."
     */
    const before = (await harness.outbox.list()).length;

    await expect(
      issueJobCard(harness.as(technician), signed, 'pieter@example-demo.co.za', 'Pieter Nel'),
    ).rejects.toThrow(/cannot be issued by you/i);

    const after = await harness.repos.jobs.findById(signed.id);
    expect(after?.status).toBe('review');
    expect(after?.finalDocument).toBeNull();
    expect(await harness.outbox.list()).toHaveLength(before);
  });

  it('refuses the COORDINATOR, who reviews and edits but does not deliver', async () => {
    await expect(
      issueJobCard(harness.as(coordinator), signed, 'pieter@example-demo.co.za', 'Pieter Nel'),
    ).rejects.toThrow(/cannot be issued by you/i);
    expect((await harness.repos.jobs.findById(signed.id))?.finalDocument).toBeNull();
  });

  it('lets the MASTER issue it, and only then is the customer emailed', async () => {
    const result = await issueJobCard(
      harness.as(master),
      signed,
      'pieter@example-demo.co.za',
      'Pieter Nel',
    );

    expect(result.job.status).toBe('awaiting_delivery');
    expect(result.job.finalDocument).not.toBeNull();
    const sent = await harness.outbox.list();
    const toCustomer = sent.filter((entry) => entry.to.includes('pieter@example-demo.co.za'));
    expect(toCustomer).toHaveLength(1);
    // The customer's copy, attached — not a bare notification.
    expect(toCustomer[0]?.attachments.length).toBeGreaterThan(0);
  });
});
