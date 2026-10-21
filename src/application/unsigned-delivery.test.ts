import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import {
  acceptJob,
  addLabour,
  captureSignature,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
  submitJobCard,
} from './job-operations';
import {
  authoriseUnsignedDelivery,
  findUnsignedDeliveryAuthorisation,
  isUnsignedIssuedJob,
  retryUnsignedDelivery,
} from './unsigned-delivery';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * SENDING A JOB CARD THE CUSTOMER DID NOT SIGN. BD-06, DELIV-7, AUD-4.
 *
 * WHAT WAS TRUE BEFORE THIS, and it was an acceptance blocker: closing a job
 * without a signature sent the customer NOTHING. The document was rendered,
 * stored and downloadable, and the send was left as an open business decision.
 *
 * THE OWNER'S RULE, and every clause of it is a test below:
 *
 *   - no automatic delivery merely because the job closed unsigned;
 *   - a MASTER must explicitly authorise any exceptional delivery;
 *   - the authorising user, time, reason, document version and destination are
 *     recorded, and so is the outcome of every attempt;
 *   - nothing is sent to a recipient the existing rules did not select;
 *   - failures stay visible and retryable;
 *   - repeated retries do not produce uncontrolled duplicate messages.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const REASON = 'The customer asked for a copy for their insurer.';

const workToSignature = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  const tech = harness.as(technician);
  let job = await acceptJob(tech, view!.job);
  job = await addLabour(tech, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 3,
    description: 'Spindle drive repair',
  });
  job = await saveCompletionReport(tech, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await startCompletion(tech, job);
  return startSignature(tech, job);
};

/** The refusal outcome: closed, unsigned, with the document on file. */
const closedUnsigned = async (harness: Harness): Promise<Job> => {
  const refused = await recordSignatureRefusal(
    harness.as(technician),
    await workToSignature(harness),
    { reason: 'The customer would not sign.' },
  );
  return resolveSignatureRefusal(harness.as(master), refused, 'Issued without a signature.');
};

describe('closing without a signature, and what is NOT sent', () => {
  let harness: Harness;
  let closed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    closed = await closedUnsigned(harness);
  });

  /** The clause the whole feature rests on. */
  it('sends the customer NOTHING when the job closes unsigned', async () => {
    expect(closed.status).toBe('closed');
    expect(closed.signature).toBeNull();
    expect(closed.finalDocument).not.toBeNull();
    // No attempt, no authorisation, nothing in flight.
    expect(closed.delivery === null || closed.delivery.attempts === 0).toBe(true);
    expect(await findUnsignedDeliveryAuthorisation(harness.as(master), closed)).toBeNull();
    expect(await harness.outbox.list()).toHaveLength(0);
    expect(isUnsignedIssuedJob(closed)).toBe(true);
  });

  it('REFUSES a Coordinator authorising the send', async () => {
    // Closing without a signature is hers; deciding to send it anyway is not.
    await expect(
      authoriseUnsignedDelivery(harness.as(coordinator), closed, { reason: REASON }),
    ).rejects.toThrow(/cannot be sent to the customer by you/iu);
    expect(await harness.outbox.list()).toHaveLength(0);
  });

  it('REFUSES the technician who did the work', async () => {
    await expect(
      authoriseUnsignedDelivery(harness.as(technician), closed, { reason: REASON }),
    ).rejects.toThrow(/cannot be sent to the customer by you/iu);
  });

  it('REFUSES an authorisation with no reason', async () => {
    await expect(
      authoriseUnsignedDelivery(harness.as(master), closed, { reason: '  ' }),
    ).rejects.toThrow(/say why this is being sent/iu);
    expect(await harness.outbox.list()).toHaveLength(0);
  });

  it('REFUSES a retry before anything has been authorised', async () => {
    await expect(retryUnsignedDelivery(harness.as(master), closed)).rejects.toThrow(
      /has not been authorised/iu,
    );
    expect(await harness.outbox.list()).toHaveLength(0);
  });
});

describe('a Master authorising the send', () => {
  let harness: Harness;
  let closed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    closed = await closedUnsigned(harness);
  });

  it('records who, when, why, which document and to whom', async () => {
    await authoriseUnsignedDelivery(harness.as(master), closed, { reason: REASON });

    const authorisation = await findUnsignedDeliveryAuthorisation(harness.as(master), closed);
    expect(authorisation).not.toBeNull();
    expect(authorisation?.authorisedBy).toBe(master.id);
    expect(authorisation?.reason).toBe(REASON);
    // THE DOCUMENT VERSION: the exact bytes, by storage key.
    expect(authorisation?.documentKey).toBe(closed.finalDocument?.storageKey);
    /*
     * THE DESTINATION is the job's own contact person, resolved by the same
     * rule the ordinary delivery path uses — never a company mailbox and never
     * supplied by the caller. The document's `issuedTo` is deliberately EMPTY
     * on an unsigned job card, because nothing was e-mailed when it was
     * issued; filling it in then would have made a document that was never
     * sent claim a destination.
     */
    expect(closed.finalDocument?.issuedTo).toBe('');
    expect(authorisation?.recipient).toMatch(/@/u);
    expect(Number.isNaN(Date.parse(authorisation?.authorisedAt ?? ''))).toBe(false);
  });

  it('sends it, and records the attempt on the job', async () => {
    const result = await authoriseUnsignedDelivery(harness.as(master), closed, { reason: REASON });

    expect(result.delivery.attempts).toBe(1);
    const authorisation = await findUnsignedDeliveryAuthorisation(harness.as(master), closed);
    expect(result.delivery.to).toBe(authorisation?.recipient);
    expect(await harness.outbox.list()).toHaveLength(1);
  });

  /**
   * THE MESSAGE MUST NOT CALL IT SIGNED. The ordinary path's mail says "signed
   * job card" because every document it sends is one; reusing it here would
   * e-mail a customer who refused to sign a message telling them they had.
   */
  it('does not tell the customer they signed it', async () => {
    await authoriseUnsignedDelivery(harness.as(master), closed, { reason: REASON });

    const sent = (await harness.outbox.list())[0];
    expect(JSON.stringify(sent)).not.toMatch(/signed job card/iu);
    expect(JSON.stringify(sent)).toMatch(/without a customer signature/iu);
  });

  /** The job was closed and stays closed: the resolution ended it. */
  it('does not change the job’s status', async () => {
    const result = await authoriseUnsignedDelivery(harness.as(master), closed, { reason: REASON });
    expect(result.job.status).toBe('closed');

    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reread?.status).toBe('closed');
  });

  it('REFUSES a second authorisation, and says to retry instead', async () => {
    await authoriseUnsignedDelivery(harness.as(master), closed, { reason: REASON });
    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');

    await expect(
      authoriseUnsignedDelivery(harness.as(master), reread!, { reason: 'Again.' }),
    ).rejects.toThrow(/already been authorised/iu);
    // And nothing was sent a second time by the attempt.
    expect(await harness.outbox.list()).toHaveLength(1);
  });

  it('REFUSES a job that was SIGNED — that path needs no authorisation', async () => {
    const signedHarness = buildHarness();
    const atSignature = await workToSignature(signedHarness);
    const signed = await captureSignature(signedHarness.as(technician), atSignature, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });
    const submitted = await submitJobCard(
      signedHarness.as(technician),
      signed,
      'pieter@abc-engineering-demo.co.za',
      'Pieter Nel',
    );

    await expect(
      authoriseUnsignedDelivery(signedHarness.as(master), submitted.job, { reason: REASON }),
    ).rejects.toThrow(/was signed by the customer/iu);
  });
});

describe('retrying a failed send', () => {
  let harness: Harness;
  let closed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    closed = await closedUnsigned(harness);
  });

  it('needs no second authorisation: the decision stands', async () => {
    await authoriseUnsignedDelivery(harness.as(master), closed, { reason: REASON });
    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');

    const retried = await retryUnsignedDelivery(harness.as(master), reread!);
    expect(retried.delivery.attempts).toBe(2);
    expect(await harness.outbox.list()).toHaveLength(2);
  });

  /**
   * NOT WHILE ONE IS IN FLIGHT. `sending` is recorded BEFORE the provider is
   * called, so a second press would send a second copy — and with two copies
   * neither the customer nor EJE can tell which is the record.
   */
  it('REFUSES a retry while an attempt is still with the provider', async () => {
    await authoriseUnsignedDelivery(harness.as(master), closed, { reason: REASON });
    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');

    const inFlight: Job = {
      ...reread!,
      delivery: {
        ...reread!.delivery!,
        state: 'sending',
        updatedAt: harness.services.clock.now(),
      },
    };
    await harness.repos.jobs.save(inFlight);

    await expect(retryUnsignedDelivery(harness.as(master), inFlight)).rejects.toThrow(
      /being sent right now/iu,
    );
    expect(await harness.outbox.list()).toHaveLength(1);
  });

  it('REFUSES a retry by anybody but a Master', async () => {
    await authoriseUnsignedDelivery(harness.as(master), closed, { reason: REASON });
    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');

    await expect(retryUnsignedDelivery(harness.as(coordinator), reread!)).rejects.toThrow(
      /cannot be re-sent by you/iu,
    );
  });
});
