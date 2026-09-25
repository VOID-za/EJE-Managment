import { beforeEach, describe, expect, it } from 'vitest';
import {
  canResendCustomerCopy,
  canSubmitJobCard,
  canEditJobRecord,
  isFinalized,
  type Job,
  type UserRole,
} from '@/domain';
import {
  acceptJob,
  addLabour,
  captureSignature,
  issueJobCard,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  retryJobCardDelivery,
  returnToCustomerSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
  updateLabour,
} from './job-operations';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import {
  buildHarness,
  confirmDelivery,
  historicalMasterReview,
  seedUser,
  type Harness,
} from './test-harness';

/**
 * THE NORMAL SIGNED JOURNEY HAS NO OFFICE STEP. MASTER SCOPE CR-07.
 *
 * Confirmed 25 September 2026, and it reverses a rule this codebase had
 * enforced since `d979aa9`. The journey the business actually runs is:
 *
 *   accept → work → write-up → customer signature → signed → TECHNICIAN
 *   submits → customer is emailed → delivery confirmed → closed
 *
 * A Master and a Coordinator are not asked, not notified and not permitted on
 * any of it. The office review exists for exactly one thing — a customer who
 * REFUSED to sign — and that workflow is unchanged and asserted here beside
 * the normal one, because the two sharing a status is precisely how they got
 * conflated in the first place.
 *
 * Everything below goes through the real operations. A negative case is an
 * operation refusing, never a button being absent.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');
const EMAIL = 'pieter@example-demo.co.za';
const RECIPIENT = 'Pieter Nel';

const codesFrom = async (run: () => Promise<unknown>): Promise<readonly string[]> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof WorkflowError) return error.violations.map((v) => v.code);
    throw error;
  }
  throw new Error('That was expected to be refused, and was not.');
};

const signedJob = async (harness: Harness, jobNumber = 'EJE-1048'): Promise<Job> => {
  const context = harness.as(technician);
  const view = await loadJobView(harness.repos, jobNumber);
  let job = await acceptJob(context, view!.job);
  job = await saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Stripped and rebuilt the spindle drive cooling circuit.',
  });
  job = await addLabour(context, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 4,
    description: '',
  });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  return captureSignature(context, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M 10 40 L 60 10 L 110 40',
  });
};

/* ------------------------------------------------------------------ *
 * The journey itself.
 * ------------------------------------------------------------------ */

describe('the normal signed journey, driven entirely by the technician', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('runs end to end with one actor, and closes on confirmed delivery', async () => {
    const tech = harness.as(technician);
    const signed = await signedJob(harness);

    expect(signed.status).toBe('review');
    expect(signed.signature).not.toBeNull();

    const issued = await issueJobCard(tech, signed, EMAIL, RECIPIENT);
    expect(issued.job.status).toBe('awaiting_delivery');

    const closed = await confirmDelivery(harness, tech, issued.job);
    expect(closed.status).toBe('closed');
  });

  it('is the submission that creates the customer’s copy and emails it', async () => {
    const signed = await signedJob(harness);
    expect(signed.finalDocument).toBeNull();
    expect(await harness.outbox.list()).toHaveLength(0);

    const issued = await issueJobCard(harness.as(technician), signed, EMAIL, RECIPIENT);

    expect(issued.job.finalDocument).not.toBeNull();
    const toCustomer = (await harness.outbox.list()).filter((entry) =>
      entry.to.includes(EMAIL),
    );
    expect(toCustomer).toHaveLength(1);
    // The document itself, attached — not a bare notification about it.
    expect(toCustomer[0]?.attachments.length).toBeGreaterThan(0);
  });

  it('does NOT close on a send the provider has merely accepted', async () => {
    const issued = await issueJobCard(
      harness.as(technician),
      await signedJob(harness),
      EMAIL,
      RECIPIENT,
    );
    // The whole point of the handshake: an accepted send is not a delivery.
    expect(issued.job.status).toBe('awaiting_delivery');
    expect(issued.job.closedAt).toBeNull();
  });

  it('asks the office for nothing, and tells them only once it is done', async () => {
    const tech = harness.as(technician);
    const signed = await signedJob(harness);

    // Signed, and the office inbox is untouched. Under the superseded rule
    // this filed "ready for office review" to both of them at this moment.
    for (const office of [master, coordinator]) {
      const inbox = await harness.repos.notifications.list(office.id);
      expect(inbox.filter((entry) => entry.jobId === signed.id), office.id).toHaveLength(0);
    }

    await issueJobCard(tech, signed, EMAIL, RECIPIENT);

    for (const office of [master, coordinator]) {
      const inbox = await harness.repos.notifications.list(office.id);
      const about = inbox.filter((entry) => entry.jobId === signed.id);
      expect(about, office.id).toHaveLength(1);
      // Told what happened, and pointed at the JOB — there is nothing to review.
      expect(about[0]?.link).toBe(`/jobs/${signed.jobNumber}`);
      expect(about[0]?.body).not.toMatch(/review|waiting for a Master/i);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Role negatives, on the server.
 * ------------------------------------------------------------------ */

describe('who may submit an ordinary signed job card', () => {
  let harness: Harness;
  let signed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    signed = await signedJob(harness);
  });

  it('the technician CAN', async () => {
    expect(canSubmitJobCard(technician, signed)).toBe(true);
    expect((await issueJobCard(harness.as(technician), signed, EMAIL, RECIPIENT)).job.status).toBe(
      'awaiting_delivery',
    );
  });

  it('the Coordinator CANNOT, and nothing happens when she tries', async () => {
    expect(canSubmitJobCard(coordinator, signed)).toBe(false);
    expect(
      await codesFrom(() => issueJobCard(harness.as(coordinator), signed, EMAIL, RECIPIENT)),
    ).toContain('not_permitted');

    const after = await harness.repos.jobs.findById(signed.id);
    expect(after?.status).toBe('review');
    expect(after?.finalDocument).toBeNull();
    expect(await harness.outbox.list()).toHaveLength(0);
  });

  it('the Master CANNOT either, however senior', async () => {
    expect(canSubmitJobCard(master, signed)).toBe(false);
    expect(
      await codesFrom(() => issueJobCard(harness.as(master), signed, EMAIL, RECIPIENT)),
    ).toContain('not_permitted');

    const after = await harness.repos.jobs.findById(signed.id);
    expect(after?.status).toBe('review');
    expect(after?.finalDocument).toBeNull();
    expect(await harness.outbox.list()).toHaveLength(0);
  });

  it('nobody in the office may edit it either — it is signed, so it is final', () => {
    expect(isFinalized(signed)).toBe(true);
    for (const role of ['master', 'coordinator', 'technician'] as const) {
      expect(canEditJobRecord(role, signed), role).toBe(false);
    }
  });

  it('an unrecognised role is granted nothing at all', () => {
    expect(canSubmitJobCard({ ...technician, role: 'nobody' as UserRole }, signed)).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The two exceptions, held deliberately.
 * ------------------------------------------------------------------ */

describe('the exceptions to "the technician submits it"', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('a PARTS collection is issued by whoever processed it at the counter', () => {
    /*
     * Unchanged, and it has to be: a parts collection is handed over at the
     * EJE counter, not on a customer's site, so the office processes it AND
     * issues it. The same exception `canAcceptJob` and `acceptJobRefusal`
     * already carry, in the same shape.
     */
    const parts = {
      status: 'review',
      jobType: 'parts',
      primaryTechnicianId: null,
      additionalTechnicianIds: [],
    } as const;
    expect(canSubmitJobCard(master, parts)).toBe(true);
    expect(canSubmitJobCard(coordinator, parts)).toBe(true);
    expect(canSubmitJobCard(technician, parts)).toBe(true);
  });

  it('whoever ATTENDED the machine submits it, even when that is a Master', async () => {
    /*
     * A Master may accept field work — `jobs.acceptField` is his, and only the
     * Coordinator is kept out of it. Without this he could be offered Accept
     * on a breakdown, drive out, do the work, take the signature, and then be
     * refused the last step of the job he had just done. The rule asks whether
     * the person is ON the job, which is the same question acceptance asks.
     */
    const second = buildHarness();
    const context = second.as(master);
    // EJE-1066 is in the open pool, so anybody who does field work may take it.
    const view = await loadJobView(second.repos, 'EJE-1066');
    let job = await acceptJob(context, view!.job);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Attended and repaired the machine myself.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: '',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    const mine = await captureSignature(context, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M 10 40 L 60 10',
    });

    expect(mine.primaryTechnicianId).toBe(master.id);
    expect(canSubmitJobCard(master, mine)).toBe(true);
    expect((await issueJobCard(context, mine, EMAIL, RECIPIENT)).job.status).toBe(
      'awaiting_delivery',
    );

    // And it is still not a way in for the office generally: the Coordinator
    // cannot be on a field job at all, so she cannot reach this branch.
    expect(canSubmitJobCard(coordinator, mine)).toBe(false);
  });

  it('does NOT let a Master submit a job somebody ELSE attended', async () => {
    const second = buildHarness();
    const theirs = await signedJob(second);
    expect(theirs.primaryTechnicianId).toBe(technician.id);
    expect(canSubmitJobCard(master, theirs)).toBe(false);
  });

  it('a job stranded in the retired Master Review stage can still be moved on', async () => {
    /*
     * Nothing can ENTER `submitted` any more. The jobs sitting in it entered
     * before the stage was retired, and a Master is the only person who could
     * ever move them: there is no technician journey to return them to, and
     * stranding a real customer's job card for ever is not an option.
     */
    const signed = await signedJob(harness);
    const historical = await historicalMasterReview(
      harness.repos,
      signed,
      '2026-09-18T09:00:00.000Z',
    );

    expect(canSubmitJobCard(master, historical)).toBe(true);
    expect(canSubmitJobCard(coordinator, historical)).toBe(false);
    expect(canSubmitJobCard(technician, historical)).toBe(false);

    expect((await issueJobCard(harness.as(master), historical, EMAIL, RECIPIENT)).job.status).toBe(
      'awaiting_delivery',
    );
  });
});

describe('re-sending a customer’s copy is a wider question', () => {
  let harness: Harness;
  let issued: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const signed = await signedJob(harness);
    // An address the simulated provider cannot deliver to, so the send fails
    // and there is something to retry.
    issued = (await issueJobCard(harness.as(technician), signed, 'not-an-address', RECIPIENT)).job;
  });

  it('is open to the technician who submitted it AND to the office', async () => {
    for (const role of ['technician', 'master', 'coordinator'] as const) {
      expect(canResendCustomerCopy(role), role).toBe(true);
    }

    for (const person of [technician, master, coordinator]) {
      const again = await retryJobCardDelivery(harness.as(person), issued, RECIPIENT);
      expect(again.job.status, person.id).toBe('awaiting_delivery');
    }
  });

  it('is refused to an account whose role grants nothing', async () => {
    const outsider = { ...technician, role: 'nobody' as never };
    expect(await codesFrom(() => retryJobCardDelivery(harness.as(outsider), issued, RECIPIENT))).not
      .toHaveLength(0);
  });

  it('re-sends the SAME document, never a re-rendered one', async () => {
    const before = issued.finalDocument;
    const again = await retryJobCardDelivery(harness.as(master), issued, RECIPIENT);
    expect(again.job.finalDocument).toEqual(before);
  });
});

/* ------------------------------------------------------------------ *
 * The refusal workflow, which is the ONLY office review there is.
 * ------------------------------------------------------------------ */

describe('the office review exists for a refusal and for nothing else', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const context = harness.as(technician);
    const view = await loadJobView(harness.repos, 'EJE-1048');
    let job = await acceptJob(context, view!.job);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the contactor and proved the circuit under load.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: '',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    refused = await recordSignatureRefusal(context, job, {
      reason: 'The planner disputes the hours and will not sign for them.',
    });
  });

  it('notifies BOTH the Master and the Coordinator — unlike a signature', async () => {
    for (const office of [master, coordinator]) {
      const inbox = await harness.repos.notifications.list(office.id);
      expect(
        inbox.filter((entry) => entry.type === 'signature_refused' && entry.jobId === refused.id),
        office.id,
      ).toHaveLength(1);
    }
  });

  it('makes the technician read-only, and refuses them every office action', async () => {
    const tech = harness.as(technician);
    expect(canEditJobRecord('technician', refused)).toBe(false);

    expect(await codesFrom(() => returnToCustomerSignature(tech, refused, ''))).toContain(
      'not_permitted',
    );
    expect(await codesFrom(() => resolveSignatureRefusal(tech, refused, ''))).toContain(
      'not_permitted',
    );
    expect(
      await codesFrom(() =>
        updateLabour(tech, refused, refused.labour[0]!.id, {
          date: '2026-09-17',
          rateType: 'normal',
          hours: 1,
          description: '',
        }),
      ),
    ).not.toHaveLength(0);
  });

  it('lets the Coordinator resolve it, and the Master too', async () => {
    for (const office of [coordinator, master]) {
      const second = buildHarness();
      const context = second.as(technician);
      const view = await loadJobView(second.repos, 'EJE-1048');
      let job = await acceptJob(context, view!.job);
      job = await saveCompletionReport(context, job, {
        ...job.completionReport,
        workPerformed: 'Replaced the contactor.',
      });
      job = await addLabour(context, job, {
        date: '2026-09-17',
        rateType: 'normal',
        hours: 2,
        description: '',
      });
      job = await startCompletion(context, job);
      job = await startSignature(context, job);
      const turnedAway = await recordSignatureRefusal(context, job, { reason: 'Refused.' });

      expect(
        (await returnToCustomerSignature(second.as(office), turnedAway, '')).status,
        office.id,
      ).toBe('customer_signature');
    }
  });

  it('OUTCOME A hands it back, and the technician then submits it normally', async () => {
    const returned = await returnToCustomerSignature(harness.as(coordinator), refused, '');
    expect(returned.status).toBe('customer_signature');

    const signed = await captureSignature(harness.as(technician), returned, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M 10 40 L 60 10',
    });
    expect(signed.status).toBe('review');

    // The office's part is over. From here it is the normal journey.
    expect(canSubmitJobCard(master, signed)).toBe(false);
    expect(canSubmitJobCard(coordinator, signed)).toBe(false);
    const issued = await issueJobCard(harness.as(technician), signed, EMAIL, RECIPIENT);
    expect((await confirmDelivery(harness, harness.as(technician), issued.job)).status).toBe(
      'closed',
    );
  });

  it('OUTCOME B closes it, with no signature or submission left to anyone', async () => {
    const closed = await resolveSignatureRefusal(harness.as(coordinator), refused, '');
    expect(closed.status).toBe('closed');
    expect(closed.signature).toBeNull();

    for (const person of [technician, master, coordinator]) {
      const context = harness.as(person);
      expect(await codesFrom(() => startSignature(context, closed)), person.id).not.toHaveLength(0);
      expect(
        await codesFrom(() => issueJobCard(context, closed, EMAIL, RECIPIENT)),
        person.id,
      ).not.toHaveLength(0);
      expect(
        await codesFrom(() => captureSignature(context, closed, {
          customerName: 'Pieter',
          customerSurname: 'Nel',
          strokeData: 'M 10 40 L 60 10',
        })),
        person.id,
      ).not.toHaveLength(0);
    }
  });
});
