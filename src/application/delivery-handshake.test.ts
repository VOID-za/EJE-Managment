import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  captureSignature,
  confirmJobCardDelivery,
  issueJobCard,
  retryJobCardDelivery,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { deliveryMessage, isDelivered, type Job } from '@/domain';

/**
 * The email handshake.
 *
 * The single rule under test: REQUESTED IS NOT SUCCESSFUL. A provider taking a
 * message off our hands tells us nothing about whether the customer received
 * it, so the job does not close, the screen does not say it was delivered, and
 * nothing anywhere pretends otherwise.
 *
 * Every assertion below goes through the real operations and the real adapter.
 * The adapter cannot return `delivered` on its own — only the stand-in for the
 * provider's delivery report can — which is what makes these three paths
 * reachable without anybody faking a success.
 */

/*
 * WHO SUBMITS, AND WHO MAY RE-SEND. MASTER SCOPE CR-07.
 *
 * Every fixture here used to issue as the MASTER, because §3.1 put the final
 * submission with him. EJE confirmed on 25 September 2026 that the normal
 * signed journey has no office step at all: the technician who did the work
 * submits it. The fixtures follow the rule rather than the rule following the
 * fixtures.
 *
 * A RE-SEND IS A DIFFERENT QUESTION and is deliberately wider — see
 * `canResendCustomerCopy`. The document already exists and the job is already
 * read-only, so re-sending changes nothing about the job; what it must not do
 * is wait for one person. The office sees the failure in the outbox, so the
 * office can re-send it too. The three negative cases below are rewritten to
 * that rule, not deleted.
 */
const technician = seedUser('user-tech-sipho');
const coordinator = seedUser('user-coord-christene');
const master = seedUser('user-master-elmarie');

const workAndSign = async (harness: Harness, jobNumber: string): Promise<Job> => {
  const opened = await harness.repos.jobs.findByJobNumber(jobNumber);
  expect(opened).not.toBeNull();
  const context = harness.as(technician);

  let job = await acceptJob(context, opened!);
  job = await addLabour(context, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 3,
    description: 'Spindle drive repair',
  });
  job = await saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan and cleared the alarm.',
  });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  return captureSignature(context, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });
};

describe('a send the provider has merely accepted', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('does not close the job, and does not claim delivery', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const result = await issueJobCard(harness.as(technician),
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );

    expect(result.delivery.state).toBe('pending_delivery');
    expect(isDelivered(result.delivery)).toBe(false);
    expect(result.job.status).toBe('awaiting_delivery');
    expect(result.job.closedAt).toBeNull();

    // The words on the screen. Nothing here may read as a success.
    const message = deliveryMessage(result.delivery, result.job.jobNumber);
    expect(message.toLowerCase()).toContain('pending');
    expect(message.toLowerCase()).not.toContain('delivered to');
  });

  it('still says pending when nothing has confirmed it since', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician),
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );

    // Asking again without a delivery report changes nothing.
    const rechecked = await confirmJobCardDelivery(harness.as(master), issued.job);
    expect(rechecked.status).toBe('awaiting_delivery');
    expect(rechecked.delivery?.state).toBe('pending_delivery');
    expect(rechecked.delivery?.confirmedAt).toBeNull();
  });

  it('has already written the customer’s copy to storage', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician),
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );

    const stored = await harness.services.storage.getDocument(
      issued.job.finalDocument!.storageKey,
    );
    expect(stored).not.toBeNull();
    expect(stored!.bytes.byteLength).toBeGreaterThan(0);
  });
});

describe('a confirmed delivery', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is the only thing that closes the job', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician),
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );
    expect(issued.job.status).toBe('awaiting_delivery');

    // The provider's delivery report arrives.
    harness.outbox.setDelivery(issued.delivery.messageId, 'delivered');
    const closed = await confirmJobCardDelivery(harness.as(master), issued.job);

    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.delivery?.state).toBe('delivered');
    expect(closed.delivery?.confirmedAt).not.toBeNull();
    expect(isDelivered(closed.delivery!)).toBe(true);

    const events = await harness.repos.activity.list(closed.id);
    expect(events.some((event) => event.type === 'job_closed')).toBe(true);
  });
});

describe('a failed delivery', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is reported as a failure, leaves the job open, and keeps the document', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    // A recipient the provider rejects outright.
    const issued = await issueJobCard(harness.as(technician), signed, 'not-an-address', 'Pieter Nel');

    expect(issued.delivery.state).toBe('failed');
    expect(issued.delivery.failureReason.length).toBeGreaterThan(0);
    expect(issued.job.status).toBe('awaiting_delivery');
    expect(issued.job.closedAt).toBeNull();

    // The document that was issued is still there to be re-sent.
    const stored = await harness.services.storage.getDocument(
      issued.job.finalDocument!.storageKey,
    );
    expect(stored!.bytes.byteLength).toBeGreaterThan(0);

    const message = deliveryMessage(issued.delivery, issued.job.jobNumber);
    expect(message.toLowerCase()).toContain('not');
  });

  it('can be retried, and the retry sends the SAME document', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician), signed, 'not-an-address', 'Pieter Nel');
    expect(issued.delivery.state).toBe('failed');

    // Re-sending puts EJE's document in the customer's hands again, so it is
    // the same Master-only act as sending it. §3.1, §15.
    const retried = await retryJobCardDelivery(
      harness.as(master),
      issued.job,
      'Pieter Nel',
    );

    expect(retried.delivery.attempts).toBe(2);
    expect(retried.documentFileName).toBe(issued.documentFileName);
    expect(retried.job.finalDocument?.storageKey).toBe(issued.job.finalDocument?.storageKey);
    // Same bad address, so it fails the same way rather than silently passing.
    expect(retried.delivery.state).toBe('failed');
    expect(retried.job.status).toBe('awaiting_delivery');
  });

  it('records every attempt on the audit trail', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician), signed, 'not-an-address', 'Pieter Nel');
    await retryJobCardDelivery(harness.as(master), issued.job, 'Pieter Nel');

    const events = await harness.repos.activity.list(issued.job.id);
    const deliveryEvents = events.filter((event) => event.type === 'delivery_state_changed');
    expect(deliveryEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('LETS the office re-send, because the office is who sees the failure', async () => {
    /*
     * THIS CASE IS INVERTED, AND DELIBERATELY. MASTER SCOPE CR-07.
     *
     * It asserted that a Coordinator may not re-send, because §3.1 made every
     * customer delivery the Master's. Under CR-07 the submission is the
     * technician's — which would have left a bounced customer copy waiting for
     * one field technician to come back off leave, while the office stared at
     * the failure in an outbox only they can read. Re-sending changes nothing
     * about the job: the document is already written and the record is already
     * final. So it is the one thing here that is wider than submitting.
     */
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician), signed, 'not-an-address', 'Pieter Nel');

    const again = await retryJobCardDelivery(harness.as(coordinator), issued.job, 'Pieter Nel');
    expect(again.job.status).toBe('awaiting_delivery');
    expect(again.documentFileName).toBe(issued.documentFileName);
  });

  it('lets a Master re-send too, for the same reason', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician), signed, 'not-an-address', 'Pieter Nel');

    expect(
      (await retryJobCardDelivery(harness.as(master), issued.job, 'Pieter Nel')).job.status,
    ).toBe('awaiting_delivery');
  });

  it('lets the technician who submitted it re-send it', async () => {
    /*
     * ALSO INVERTED. It read "a technician never delivers to a customer",
     * which stopped being true the moment CR-07 made the submission — the act
     * that emails the customer in the first place — the technician's own.
     */
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician), signed, 'not-an-address', 'Pieter Nel');

    expect(
      (await retryJobCardDelivery(harness.as(technician), issued.job, 'Pieter Nel')).job.status,
    ).toBe('awaiting_delivery');
  });

  it('refuses a retry from an account whose role grants nothing', async () => {
    const signed = await workAndSign(harness, 'EJE-1048');
    const issued = await issueJobCard(harness.as(technician), signed, 'not-an-address', 'Pieter Nel');

    // A corrupt or unrecognised role must grant nothing rather than everything.
    const outsider = { ...technician, role: 'nobody' as never };
    await expect(
      retryJobCardDelivery(harness.as(outsider), issued.job, 'Pieter Nel'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('the simulated adapter itself', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('never reports a delivery it cannot observe', async () => {
    const receipt = await harness.services.email.send({
      to: ['someone@example-demo.co.za'],
      subject: 'Anything',
      body: 'Anything',
    });
    expect(receipt.state).not.toBe('delivered');
    expect(receipt.state).toBe('pending_delivery');

    const entries = await harness.outbox.list();
    expect(entries.every((entry) => entry.delivery !== 'delivered')).toBe(true);
  });
});
