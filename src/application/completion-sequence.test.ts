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
import { buildHarness, seedUser, type Harness } from './test-harness';
import {
  checkReadyForSignature,
  getJobTypeDefinition,
  signatoryLabelsFor,
  type Job,
  type JobTypeCode,
} from '@/domain';

/**
 * The rules the Complete Job wizard is built on.
 *
 * The wizard is a wrapper: it decides which steps to show and when Continue is
 * allowed by asking the domain, and it closes the job by calling the same
 * operations everything else calls. These assert the rules it asks about, so
 * the sequence on screen cannot drift from what the system will accept — and
 * so that nobody later "fixes" the wizard by teaching it its own rules.
 */

const technician = seedUser('user-tech-sipho');
/** MASTER SCOPE §3.1 — the final submission and every re-send are his. */
const master = seedUser('user-master-elmarie');

describe('which steps a job type gets', () => {
  it('requires a checklist for installation and service', () => {
    expect(getJobTypeDefinition('installation').checklistRequired).toBe(true);
    expect(getJobTypeDefinition('service').checklistRequired).toBe(true);
  });

  it('requires none for breakdown or test and repair', () => {
    expect(getJobTypeDefinition('breakdown').checklistRequired).toBe(false);
    expect(getJobTypeDefinition('test_and_repair').checklistRequired).toBe(false);
  });

  it('keeps a parts collection on its own footing, with no labour or travel', () => {
    const parts = getJobTypeDefinition('parts');
    expect(parts.capturesLabourAndTravel).toBe(false);
    expect(parts.checklistRequired).toBe(false);
    // And it is signed for by the collector, acknowledging receipt.
    expect(signatoryLabelsFor('parts').declaration).not.toBe(
      signatoryLabelsFor('breakdown').declaration,
    );
  });

  it.each(['breakdown', 'installation', 'service'] as JobTypeCode[])(
    '%s uses the customer work declaration, unchanged',
    (jobType) => {
      expect(signatoryLabelsFor(jobType).declaration).toBe(
        'I confirm that the work described above has been completed.',
      );
    },
  );

  it('asks a test and repair collector to confirm receipt, not the work', () => {
    // The unit is collected from the counter, often by a driver who did not
    // watch the repair and cannot honestly confirm it was done.
    expect(signatoryLabelsFor('test_and_repair').declaration).toBe(
      'I confirm that I have collected the items listed above.',
    );
    expect(getJobTypeDefinition('test_and_repair').collectedOnCompletion).toBe(true);
  });
});

describe('what holds each wizard step open', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('will not let a bare job reach signature, and says what is missing', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const job = await acceptJob(harness.as(technician), opened!);

    const readiness = checkReadyForSignature(job);
    expect(readiness.allowed).toBe(false);
    const codes = readiness.violations.map((violation) => violation.code);
    expect(codes).toContain('work_performed_required');
    expect(codes).toContain('labour_required');
  });

  it('clears once the write-up and the labour are captured', async () => {
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    let job = await acceptJob(context, opened!);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
    });

    expect(checkReadyForSignature(job).allowed).toBe(true);
  });

  it('separates the checklist violations from the rest, as the steps do', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1053');
    // Worked by whoever the service job is actually assigned to.
    const context = harness.as(seedUser(opened!.primaryTechnicianId ?? technician.id));
    let job = await acceptJob(context, opened!);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Six-monthly service completed.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 3,
      description: 'Preventative service',
    });

    const violations = checkReadyForSignature(job).violations;
    // A service job with everything but its checklist is held ONLY by the
    // checklist, which is what puts the technician on the checklist step.
    expect(violations.every((violation) => violation.code.startsWith('checklist'))).toBe(true);
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe('the close-out the wizard drives, end to end', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  /** Exactly the operations the wizard calls, in the order it calls them. */
  const throughTheWizard = async (): Promise<Job> => {
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');

    let job = await acceptJob(context, opened!);
    // Step 1 — completion.
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
    });
    job = await startCompletion(context, job);
    // Step 3 → 4 — moving onto the signature.
    job = await startSignature(context, job);
    // Step 4 — the customer signs.
    return captureSignature(context, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
  };

  it('leaves the job signed and at Review, with no Master Review anywhere', async () => {
    const signed = await throughTheWizard();
    expect(signed.status).toBe('review');
    expect(signed.signature).not.toBeNull();
    expect(signed.signature?.declaration).toBe(
      'I confirm that the work described above has been completed.',
    );
    // Freezes the pricing at the moment of signature, as it always did.
    expect(signed.pricingSnapshot).not.toBeNull();
    expect(signed.pricingSnapshot?.reason).toBe('customer_signature');
  });

  it('issues, stores the document and waits on delivery rather than closing', async () => {
    const signed = await throughTheWizard();
    const issued = await issueJobCard(harness.as(technician),
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );

    expect(issued.job.status).toBe('awaiting_delivery');
    expect(issued.delivery.state).toBe('pending_delivery');
    const stored = await harness.services.storage.getDocument(
      issued.job.finalDocument!.storageKey,
    );
    expect(stored!.bytes.byteLength).toBeGreaterThan(0);
  });

  it('closes on confirmed delivery, and never enters Master Review on the way', async () => {
    const signed = await throughTheWizard();
    const issued = await issueJobCard(harness.as(technician),
      signed,
      'customer@example-demo.co.za',
      'Pieter Nel',
    );
    harness.outbox.setDelivery(issued.delivery.messageId, 'delivered');
    const closed = await confirmJobCardDelivery(harness.as(master), issued.job);

    expect(closed.status).toBe('closed');

    const events = await harness.repos.activity.list(closed.id);
    const statuses = events.map((event) => event.type);
    expect(statuses).toContain('customer_signed');
    expect(statuses).toContain('job_closed');
    // Nothing in the whole sequence mentions the retired stage.
    expect(
      events.filter((event) => /master review/i.test(event.summary + event.detail)),
    ).toEqual([]);
  });

  it('does not ask for the signature again when delivery fails, and re-sends the same file', async () => {
    const signed = await throughTheWizard();
    const issued = await issueJobCard(harness.as(technician), signed, 'not-an-address', 'Pieter Nel');
    expect(issued.delivery.state).toBe('failed');

    const signatureBefore = issued.job.signature;
    const retried = await retryJobCardDelivery(harness.as(technician), issued.job, 'Pieter Nel');

    // Same document, same signature, one more attempt.
    expect(retried.job.finalDocument?.storageKey).toBe(issued.job.finalDocument?.storageKey);
    expect(retried.job.signature).toEqual(signatureBefore);
    expect(retried.delivery.attempts).toBe(2);
    expect(retried.job.status).toBe('awaiting_delivery');
  });
});
