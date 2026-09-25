import { beforeEach, describe, expect, it } from 'vitest';
import {
  canAcceptJob,
  canEditJobRecord,
  isFinalized,
  refusalAwaitingResolution,
  type Job,
  type UserRole,
} from '@/domain';
import {
  acceptJob,
  addLabour,
  captureSignature,
  confirmJobCardDelivery,
  issueJobCard,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  returnToCustomerSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import { buildHarness, confirmDelivery, seedUser, type Harness } from './test-harness';

/**
 * THE ROLE MATRIX, WALKED RATHER THAN ASSERTED.
 *
 * The matrix EJE confirmed is not a list of permissions — it is a statement
 * about three journeys that share a state machine, and the defects found in
 * acceptance testing were all places where two of them had been conflated:
 *
 *  - A read-only rule written for a REFUSED job card was applied to a SIGNED
 *    one, so a technician who had done everything right was left with no
 *    action at all on their own job.
 *  - The Coordinator's refusal authority leaked into a generic "Review &
 *    submit job card" on ordinary signed jobs, which the server then refused.
 *  - The Coordinator was offered Accept on field work she may not accept.
 *
 * So each journey is walked here from end to end, and at every step the test
 * asks what the OTHER two roles are allowed. A permission table that is never
 * walked is a table that agrees with itself and with nothing else.
 */

/** The recipient the office would supply; the contact's own address. */
const EMAIL = 'pieter@example-demo.co.za';
const RECIPIENT = 'Pieter Nel';

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');
const otherTechnician = seedUser('user-tech-riaan');

const codesFrom = async (run: () => Promise<unknown>): Promise<readonly string[]> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof WorkflowError) return error.violations.map((v) => v.code);
    throw error;
  }
  throw new Error('That was expected to be refused, and was not.');
};

/** Whether the operation was ALLOWED. For the table, where both are expected. */
const allowed = async (run: () => Promise<unknown>): Promise<boolean> => {
  try {
    await run();
    return true;
  } catch (error) {
    if (error instanceof WorkflowError) return false;
    throw error;
  }
};

/** Takes a job as far as the signature step, exactly as a technician does. */
const readyForSignature = async (harness: Harness, jobNumber: string): Promise<Job> => {
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
  return startSignature(context, job);
};

const sign = async (harness: Harness, job: Job): Promise<Job> =>
  captureSignature(harness.as(technician), job, {
    customerName: 'Johan',
    customerSurname: 'Pretorius',
    strokeData: 'M 10 40 L 60 10 L 110 40',
  });

/* ------------------------------------------------------------------ *
 * A. The normal job, all the way through.
 * ------------------------------------------------------------------ */

describe('A — a normal job, accepted to closed', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('runs: accept, work, write-up, review, signature, signed, Master submission, closed', async () => {
    let job = await readyForSignature(harness, 'EJE-1048');
    expect(job.status).toBe('customer_signature');

    job = await sign(harness, job);
    // Signed lands at Review, which is the office's queue. Not closed, not
    // issued: the Master has not submitted it yet.
    expect(job.status).toBe('review');
    expect(job.signature).not.toBeNull();
    expect(refusalAwaitingResolution(job)).toBe(false);

    const issued = await issueJobCard(harness.as(master), job, EMAIL, RECIPIENT);
    expect(issued.job.status).toBe('awaiting_delivery');

    const closed = await confirmDelivery(harness, harness.as(master), issued.job);
    expect(closed.status).toBe('closed');
    expect(closed.finalDocument).not.toBeNull();
  });

  it('leaves the technician an action at Review — they are not stranded', async () => {
    const job = await sign(harness, await readyForSignature(harness, 'EJE-1048'));

    /*
     * THE BUG THIS EXISTS FOR: "now i went back page... now i cant do anything
     * as a tech".
     *
     * A refused job card is the office's and the technician is read-only on
     * it. A SIGNED one at the same status is not the same thing, and the
     * action bar tells them apart by asking this question rather than by
     * asking the status. If this is ever true for a signed job again, the
     * technician loses every action on the job they just finished.
     */
    expect(refusalAwaitingResolution(job)).toBe(false);
    // They may not EDIT it — it is signed, and a signed record is final — but
    // that is a different thing from having nowhere to go.
    expect(isFinalized(job)).toBe(true);
    expect(canEditJobRecord('technician', job)).toBe(false);
  });

  it('does not let the technician issue it — the final submission is the Master’s', async () => {
    const job = await sign(harness, await readyForSignature(harness, 'EJE-1048'));
    expect(await codesFrom(() => issueJobCard(harness.as(technician), job, EMAIL, RECIPIENT))).toContain(
      'not_permitted',
    );
  });
});

/* ------------------------------------------------------------------ *
 * B. Refusal, resolved by asking the customer again.
 * ------------------------------------------------------------------ */

describe('B — customer refuses, the office corrects it, Customer Signature', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const job = await readyForSignature(harness, 'EJE-1048');
    refused = await recordSignatureRefusal(harness.as(technician), job, {
      reason: 'The planner disputes the hours and will not sign for them.',
    });
  });

  it('puts the job with the office and makes the technician read-only', async () => {
    expect(refused.status).toBe('review');
    expect(refusalAwaitingResolution(refused)).toBe(true);
    expect(canEditJobRecord('technician', refused)).toBe(false);
    expect(canEditJobRecord('coordinator', refused)).toBe(true);
    expect(canEditJobRecord('master', refused)).toBe(true);
  });

  it('notified BOTH the Master and the Coordinator', async () => {
    for (const person of [master, coordinator]) {
      const inbox = await harness.repos.notifications.list(person.id);
      expect(
        inbox.filter((entry) => entry.type === 'signature_refused' && entry.jobId === refused.id),
      ).toHaveLength(1);
    }
  });

  it('did NOT notify the technician — it is not theirs to act on', async () => {
    const inbox = await harness.repos.notifications.list(technician.id);
    expect(inbox.filter((entry) => entry.type === 'signature_refused')).toHaveLength(0);
  });

  it('lets the Coordinator correct the card and return it for signature', async () => {
    const office = harness.as(coordinator);
    const corrected = await saveCompletionReport(office, refused, {
      ...refused.completionReport,
      workPerformed: 'Stripped and rebuilt the spindle drive cooling circuit. Hours corrected.',
    });

    const returned = await returnToCustomerSignature(office, corrected, 'Hours agreed with the planner.');

    // review -> customer_signature. NOT customer_signature -> itself, which is
    // the error acceptance testing reported.
    expect(returned.status).toBe('customer_signature');
    expect(refusalAwaitingResolution(returned)).toBe(false);
    expect(returned.signatureRefusals).toHaveLength(1);
    expect(returned.signatureRefusals[0]?.resolution).toBe('resubmitted');
    expect(returned.signatureRefusals[0]?.resolvedBy).toBe(coordinator.id);
  });

  it('does not duplicate the refusal record when it is resolved', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');
    expect(returned.signatureRefusals).toHaveLength(1);
  });

  it('continues through the ordinary signature workflow afterwards', async () => {
    const returned = await returnToCustomerSignature(harness.as(coordinator), refused, '');
    const signed = await sign(harness, returned);
    expect(signed.status).toBe('review');
    expect(signed.signature).not.toBeNull();

    // And from there it is an ordinary signed job: the Master submits it.
    const issued = await issueJobCard(harness.as(master), signed, EMAIL, RECIPIENT);
    const closed = await confirmDelivery(harness, harness.as(master), issued.job);
    expect(closed.status).toBe('closed');
  });

  it('records a second refusal beside the first, never over it', async () => {
    const returned = await returnToCustomerSignature(harness.as(coordinator), refused, '');
    const again = await recordSignatureRefusal(harness.as(technician), returned, {
      reason: 'Still will not sign.',
    });
    expect(again.signatureRefusals).toHaveLength(2);
    expect(again.signatureRefusals[0]?.resolution).toBe('resubmitted');
    expect(again.signatureRefusals[1]?.resolution).toBeNull();
  });

  it('refuses the technician every office action on it', async () => {
    const tech = harness.as(technician);
    expect(await codesFrom(() => returnToCustomerSignature(tech, refused, ''))).toContain(
      'not_permitted',
    );
    expect(await codesFrom(() => resolveSignatureRefusal(tech, refused, ''))).toContain(
      'not_permitted',
    );
    expect(await codesFrom(() => sign(harness, refused))).not.toHaveLength(0);
    expect(
      await codesFrom(() =>
        saveCompletionReport(tech, refused, {
          ...refused.completionReport,
          workPerformed: 'Rewritten by the technician after handing it over.',
        }),
      ),
    ).not.toHaveLength(0);
  });

  it('refuses ANOTHER technician too — it is not about whose job it was', async () => {
    expect(
      await codesFrom(() => returnToCustomerSignature(harness.as(otherTechnician), refused, '')),
    ).toContain('not_permitted');
  });
});

/* ------------------------------------------------------------------ *
 * C. Refusal, resolved without a signature. The job ends.
 * ------------------------------------------------------------------ */

describe('C — customer refuses, the office closes it Without Customer Signature', () => {
  let harness: Harness;
  let closed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const job = await readyForSignature(harness, 'EJE-1048');
    const refused = await recordSignatureRefusal(harness.as(technician), job, {
      reason: 'The customer will not sign anything without their head office present.',
    });
    closed = await resolveSignatureRefusal(
      harness.as(coordinator),
      refused,
      'Invoice to proceed; head office notified.',
    );
  });

  it('CLOSES the job there and then', () => {
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
    expect(closed.signature).toBeNull();
  });

  it('produces the customer’s copy, recording the refusal rather than a signature', () => {
    expect(closed.finalDocument).not.toBeNull();
    expect(closed.finalDocument?.fileName).toContain('EJE-1048');
  });

  it('records the full outcome on the refusal', () => {
    const refusal = closed.signatureRefusals[0]!;
    expect(refusal.reason).toContain('head office');
    expect(refusal.recordedBy).toBe(technician.id);
    expect(refusal.recordedAt).not.toBeNull();
    expect(refusal.resolution).toBe('issued_unsigned');
    expect(refusal.resolvedBy).toBe(coordinator.id);
    expect(refusal.resolvedAt).not.toBeNull();
    expect(refusal.resolutionNote).toContain('Invoice to proceed');
  });

  it('offers NO further signature, review or submission step — to anyone', async () => {
    for (const role of ['master', 'coordinator', 'technician'] as const) {
      expect(canEditJobRecord(role, closed)).toBe(false);
    }
    expect(refusalAwaitingResolution(closed)).toBe(false);
    expect(isFinalized(closed)).toBe(true);

    // Every way back, refused at the server. The UI hides them; this is what
    // happens to a request that is made anyway.
    for (const actor of [master, coordinator, technician]) {
      const context = harness.as(actor);
      expect(await codesFrom(() => startSignature(context, closed))).not.toHaveLength(0);
      expect(await codesFrom(() => returnToCustomerSignature(context, closed, ''))).not.toHaveLength(
        0,
      );
      expect(await codesFrom(() => resolveSignatureRefusal(context, closed, ''))).not.toHaveLength(
        0,
      );
      expect(await codesFrom(() => startCompletion(context, closed))).not.toHaveLength(0);
    }
  });

  it('cannot be signed afterwards, by anyone', async () => {
    expect(await codesFrom(() => sign(harness, closed))).not.toHaveLength(0);
    expect(
      await codesFrom(() =>
        captureSignature(harness.as(master), closed, {
          customerName: 'Johan',
          customerSurname: 'Pretorius',
          strokeData: 'M 10 40 L 60 10',
        }),
      ),
    ).not.toHaveLength(0);
  });

  it('cannot be issued again — it is already finished', async () => {
    expect(
      await codesFrom(() => issueJobCard(harness.as(master), closed, EMAIL, RECIPIENT)),
    ).not.toHaveLength(0);
  });

  it('shrugs off a delivery confirmation rather than reopening anything', async () => {
    /*
     * The delivery poll is idempotent by design — it is how a provider's
     * report is applied, and reports arrive late, twice, or for jobs that have
     * moved on. What matters is that it cannot walk a CLOSED job backwards
     * into the delivery handshake it never entered.
     */
    const after = await confirmJobCardDelivery(harness.as(master), closed);
    expect(after.status).toBe('closed');
    expect(after).toEqual(closed);
  });

  it('is equally available to a Master — the office is both roles', async () => {
    const second = buildHarness();
    const job = await readyForSignature(second, 'EJE-1048');
    const refused = await recordSignatureRefusal(second.as(technician), job, {
      reason: 'Refused again, on a different job.',
    });
    expect((await resolveSignatureRefusal(second.as(master), refused, '')).status).toBe('closed');
  });
});

/* ------------------------------------------------------------------ *
 * D & E. What each role may NOT do.
 * ------------------------------------------------------------------ */

describe('D — the Coordinator does not gain Master submission powers', () => {
  let harness: Harness;
  let signed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    signed = await sign(harness, await readyForSignature(harness, 'EJE-1048'));
  });

  it('cannot make the final submission on an ordinary signed job', async () => {
    expect(await codesFrom(() => issueJobCard(harness.as(coordinator), signed, EMAIL, RECIPIENT))).toContain(
      'not_permitted',
    );
  });

  it('is not offered Accept on field work, and is refused it if she asks', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1065');
    const open = view!.job;
    expect(open.status).toBe('open');

    // The screen and the server, asked the same question about the same job.
    expect(canAcceptJob(open, coordinator)).toBe(false);
    expect(await codesFrom(() => acceptJob(harness.as(coordinator), open))).toContain(
      'not_field_technician',
    );
  });

  it('keeps every refusal power — that is the whole of her extra authority', async () => {
    const other = buildHarness();
    const refused = await recordSignatureRefusal(
      other.as(technician),
      await readyForSignature(other, 'EJE-1048'),
      { reason: 'Refused.' },
    );

    expect(canEditJobRecord('coordinator', refused)).toBe(true);
    expect((await returnToCustomerSignature(other.as(coordinator), refused, '')).status).toBe(
      'customer_signature',
    );
  });
});

describe('E — the technician keeps the whole normal workflow', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('accepts, captures, writes up, reviews and takes the signature', async () => {
    const job = await sign(harness, await readyForSignature(harness, 'EJE-1048'));
    expect(job.signature?.customerName).toBe('Johan');
    expect(job.status).toBe('review');
  });

  it('may still edit everything before the signature', async () => {
    const context = harness.as(technician);
    const view = await loadJobView(harness.repos, 'EJE-1048');
    let job = await acceptJob(context, view!.job);
    expect(canEditJobRecord('technician', job)).toBe(true);
    job = await startCompletion(
      context,
      await saveCompletionReport(context, job, {
        ...job.completionReport,
        workPerformed: 'Replaced the cooling fan.',
      }),
    );
    expect(canEditJobRecord('technician', job)).toBe(true);
  });

  it('may not resolve a refusal it recorded itself', async () => {
    const job = await readyForSignature(harness, 'EJE-1048');
    const refused = await recordSignatureRefusal(harness.as(technician), job, {
      reason: 'Refused on site.',
    });
    expect(await codesFrom(() => resolveSignatureRefusal(harness.as(technician), refused, ''))).toContain(
      'not_permitted',
    );
  });
});

/* ------------------------------------------------------------------ *
 * The matrix itself, stated once, as a table.
 * ------------------------------------------------------------------ */

describe('the confirmed role matrix', () => {
  const rows: readonly {
    readonly role: UserRole;
    readonly acceptsFieldWork: boolean;
    readonly finalSubmission: boolean;
    readonly resolvesRefusals: boolean;
    readonly editsRefusedCard: boolean;
  }[] = [
    {
      role: 'master',
      acceptsFieldWork: true,
      finalSubmission: true,
      resolvesRefusals: true,
      editsRefusedCard: true,
    },
    {
      role: 'coordinator',
      acceptsFieldWork: false,
      finalSubmission: false,
      resolvesRefusals: true,
      editsRefusedCard: true,
    },
    {
      role: 'technician',
      acceptsFieldWork: true,
      finalSubmission: false,
      resolvesRefusals: false,
      editsRefusedCard: false,
    },
  ];

  it.each(rows)('$role', async (row) => {
    const harness = buildHarness();
    const prepared = await readyForSignature(harness, 'EJE-1048');
    const refused = await recordSignatureRefusal(harness.as(technician), prepared, {
      reason: 'Refused.',
    });
    const signedHarness = buildHarness();
    const signed = await sign(signedHarness, await readyForSignature(signedHarness, 'EJE-1048'));
    const openView = await loadJobView(harness.repos, 'EJE-1065');

    const actor = seedUser(
      row.role === 'master'
        ? 'user-master-elmarie'
        : row.role === 'coordinator'
          ? 'user-coord-christene'
          : 'user-tech-sipho',
    );

    expect(canAcceptJob(openView!.job, actor)).toBe(row.acceptsFieldWork);
    expect(canEditJobRecord(row.role, refused)).toBe(row.editsRefusedCard);

    expect(
      await allowed(() => issueJobCard(signedHarness.as(actor), signed, EMAIL, RECIPIENT)),
    ).toBe(row.finalSubmission);
    expect(await allowed(() => resolveSignatureRefusal(harness.as(actor), refused, ''))).toBe(
      row.resolvesRefusals,
    );

    // A SIGNED job card is final for every role without exception, and a
    // CLOSED one too. No row of the matrix softens that.
    expect(canEditJobRecord(row.role, signed)).toBe(false);
  });
});
