import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  captureSignature,
  issueJobCard,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  returnToCustomerSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadJobRows, loadJobView } from './job-view';
import { buildHarness, confirmDelivery, seedUser, type Harness } from './test-harness';
import {
  can,
  canSeeSignatureRefusal,
  checkReadyForSubmission,
  currentRefusal,
  JOB_PROGRESS_STAGES,
  jobProgressPosition,
  jobStatusLabel,
  outstandingRefusal,
  redactRefusalsForViewer,
  refusalAwaitingResolution,
  signatureExceptionLabel,
  type Job,
} from '@/domain';
import { unresolvedRefusals } from '@/components/dashboard/dashboard-data';

/**
 * The correction loop: refused, put right, asked again.
 *
 * The rule these exist to hold is that a refusal is the START of something, not
 * the end of it. A customer who would not sign usually would not sign
 * SOMETHING — a figure, a description, work they say was not done — and the
 * answer is to correct the job card and put it back in front of them, carrying
 * everything already captured. Filing a note and posting the customer the
 * document they just objected to is not the answer, and these say so.
 */

const technician = seedUser('user-tech-sipho');
const otherTechnician = seedUser('user-tech-lerato');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

const REASON = 'The hours are wrong — we were only on site for one.';
const SECOND_REASON = 'Still disputes the call-out fee.';

const codesOf = async (run: Promise<unknown>): Promise<readonly string[]> => {
  try {
    await run;
  } catch (error) {
    const violations = (error as { violations?: readonly { code: string }[] }).violations ?? [];
    return violations.map((violation) => violation.code);
  }
  throw new Error('the operation was expected to refuse, and did not');
};

describe('a refused job card is corrected and asked for again', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
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
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    refused = await recordSignatureRefusal(context, job, { reason: REASON });
  });

  it('holds the job card until the office deals with it', () => {
    expect(refusalAwaitingResolution(refused)).toBe(true);
    const readiness = checkReadyForSubmission(refused);
    expect(readiness.allowed).toBe(false);
    expect(readiness.violations.map((violation) => violation.code)).toContain(
      'refusal_unresolved',
    );
  });

  it('lets a Master return the corrected card for signature', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, 'Hours fixed.');

    expect(returned.status).toBe('customer_signature');
    // The refusal is resolved and STAYS on the record, saying how.
    expect(returned.signatureRefusals).toHaveLength(1);
    expect(currentRefusal(returned)?.resolution).toBe('resubmitted');
    expect(currentRefusal(returned)?.resolvedBy).toBe(master.id);
    expect(currentRefusal(returned)?.reason).toBe(REASON);
    expect(outstandingRefusal(returned)).toBeNull();
  });

  it('lets a Coordinator do exactly the same', async () => {
    const returned = await returnToCustomerSignature(harness.as(coordinator), refused, '');
    expect(returned.status).toBe('customer_signature');
    expect(currentRefusal(returned)?.resolvedBy).toBe(coordinator.id);
  });

  it('refuses a technician, including the one who took the refusal', async () => {
    expect(await codesOf(returnToCustomerSignature(harness.as(technician), refused, ''))).toContain(
      'not_permitted',
    );
    expect(await codesOf(resolveSignatureRefusal(harness.as(technician), refused, ''))).toContain(
      'not_permitted',
    );

    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reread?.status).toBe('review');
    expect(refusalAwaitingResolution(reread!)).toBe(true);
  });

  it('carries every captured line back with it — nothing is re-captured', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');

    expect(returned.labour).toHaveLength(refused.labour.length);
    expect(returned.completionReport.workPerformed).toBe(refused.completionReport.workPerformed);
    expect(returned.pricingSnapshot).toEqual(refused.pricingSnapshot);
    expect(returned.completedAt).toBe(refused.completedAt);
  });

  it('audits the return, naming who did it and what they put right', async () => {
    await returnToCustomerSignature(harness.as(master), refused, 'Hours corrected to one.');

    const events = await harness.repos.activity.list(refused.id);
    const event = events.find((entry) => entry.type === 'returned_for_customer_signature');
    expect(event).toBeDefined();
    expect(event?.actorId).toBe(master.id);
    expect(event?.summary).toBe('Corrected job card returned for customer signature');
    expect(event?.detail).toContain('Elmarie Coetzee');
    expect(event?.detail).toContain('Hours corrected to one.');
  });

  /*
   * The correction loop must not leak the reason either.
   *
   * Every event this workflow writes goes on the same trail, under the same
   * read rules, so the rule is asserted across all of them rather than on the
   * one event that happened to carry the reason.
   */
  it('writes nothing about the customer’s reason onto the audit trail', async () => {
    await returnToCustomerSignature(harness.as(master), refused, 'Hours corrected to one.');

    const events = await harness.repos.activity.list(refused.id);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.detail, `${event.type} detail`).not.toContain(REASON);
      expect(event.summary, `${event.type} summary`).not.toContain(REASON);
    }
  });

  it('audits the office correcting the job card, keeping the technician’s original', async () => {
    const before = await harness.repos.activity.list(refused.id);
    const original = before.find((entry) => entry.type === 'completion_report_saved');
    expect(original).toBeDefined();

    await saveCompletionReport(harness.as(master), refused, {
      ...refused.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan. One hour on site.',
    });

    const after = await harness.repos.activity.list(refused.id);
    const correction = after.find((entry) => entry.type === 'job_card_corrected');
    expect(correction).toBeDefined();
    expect(correction?.actorId).toBe(master.id);
    expect(correction?.detail).toContain('after the customer refused to sign');

    // The technician's own submission is still in the trail, untouched.
    expect(after.find((entry) => entry.id === original!.id)).toEqual(original);
  });

  it('lets the customer sign the corrected card, and then issues normally', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');
    const signed = await captureSignature(harness.as(technician), returned, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    expect(signed.signature).not.toBeNull();
    expect(signed.status).toBe('review');
    // The refusal stays on the record; the customer's eventual signature does
    // not erase the fact that they turned the first card away.
    expect(signed.signatureRefusals).toHaveLength(1);
    expect(checkReadyForSubmission(signed).allowed).toBe(true);

    /*
     * AND FROM HERE IT IS AN ORDINARY SIGNED JOB. MASTER SCOPE CR-07.
     *
     * The office resolved the refusal and handed the card back; once the
     * customer signs it the normal journey resumes, which means the TECHNICIAN
     * submits it. This issued as the Master, under the superseded rule.
     */
    const result = await issueJobCard(
      harness.as(technician),
      signed,
      'accounts@example.com',
      'ABC Engineering',
    );
    const closed = await confirmDelivery(harness, harness.as(technician), result.job);
    expect(closed.status).toBe('closed');
    expect(closed.finalDocument).not.toBeNull();
  });

  it('records a second refusal beside the first, never over it', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');
    const again = await recordSignatureRefusal(harness.as(technician), returned, {
      reason: SECOND_REASON,
    });

    expect(again.signatureRefusals).toHaveLength(2);
    expect(again.signatureRefusals[0]?.reason).toBe(REASON);
    expect(again.signatureRefusals[0]?.resolution).toBe('resubmitted');
    expect(again.signatureRefusals[1]?.reason).toBe(SECOND_REASON);
    expect(again.signatureRefusals[1]?.resolution).toBeNull();
    expect(refusalAwaitingResolution(again)).toBe(true);
    expect(again.status).toBe('review');
  });

  it('notifies the office again on the second refusal', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');
    const before = (await harness.repos.notifications.list(master.id)).filter(
      (entry) => entry.type === 'signature_refused' && entry.handledAt === null,
    );
    expect(before).toHaveLength(0);

    await recordSignatureRefusal(harness.as(technician), returned, { reason: SECOND_REASON });

    const after = (await harness.repos.notifications.list(master.id)).filter(
      (entry) => entry.type === 'signature_refused' && entry.handledAt === null,
    );
    expect(after.length).toBeGreaterThan(0);
  });

  it('notifies the Coordinator too, not only Masters', async () => {
    const inbox = (await harness.repos.notifications.list(coordinator.id)).filter(
      (entry) => entry.type === 'signature_refused',
    );
    expect(inbox.length).toBeGreaterThan(0);
  });

  it('adds no status and no stage, however many times it goes round', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');
    const again = await recordSignatureRefusal(harness.as(technician), returned, {
      reason: SECOND_REASON,
    });

    expect(JOB_PROGRESS_STAGES).toHaveLength(6);
    expect(JOB_PROGRESS_STAGES.map(jobStatusLabel)).toEqual([
      'Open',
      'In Progress',
      'Completion',
      'Customer Signature',
      'Review',
      'Closed',
    ]);
    for (const job of [refused, returned, again]) {
      expect(job.status === 'review' || job.status === 'customer_signature').toBe(true);
      expect(job.status).not.toBe('submitted');
      expect(jobProgressPosition(job.status).interruption).toBeNull();
    }
    expect(signatureExceptionLabel(again)).toBe('Customer refused to sign');
    expect(signatureExceptionLabel(returned)).toBeNull();
  });

  it('cannot be resolved twice', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');
    expect(await codesOf(returnToCustomerSignature(harness.as(master), returned, ''))).toContain(
      'already_resolved',
    );
  });
});

describe('who may see a signature refusal', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
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
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    refused = await recordSignatureRefusal(context, job, { reason: REASON });
  });

  it('shows it to the technician whose job it is', () => {
    expect(canSeeSignatureRefusal(technician, refused)).toBe(true);
  });

  it('hides it from another technician', () => {
    expect(canSeeSignatureRefusal(otherTechnician, refused)).toBe(false);
  });

  it('shows it to a Master and to a Coordinator', () => {
    expect(canSeeSignatureRefusal(master, refused)).toBe(true);
    expect(canSeeSignatureRefusal(coordinator, refused)).toBe(true);
  });

  it('redacts the record itself, so there is nothing for a screen to render', () => {
    const asOther = redactRefusalsForViewer(refused, otherTechnician);
    expect(asOther.signatureRefusals).toEqual([]);
    expect(refusalAwaitingResolution(asOther)).toBe(false);
    // Everything else about the job is untouched: this is about the refusal,
    // not about hiding other people's work.
    expect(asOther.jobNumber).toBe(refused.jobNumber);
    expect(asOther.labour).toEqual(refused.labour);
  });

  /*
   * REWRITTEN FOR THE CONFIRMED BUSINESS DECISION (DECISION 5).
   *
   * The redaction this asserted is still in force and is still tested, one case
   * above, against `redactRefusalsForViewer` directly. What changed is the
   * LOADER: a technician who is not on this job, has never been on it, and has
   * not worked this machine is not handed the job at all now, so there are no
   * refusals on it to redact. The assertion moves to the stronger fact.
   *
   * The second half is unchanged and is the point of the test: the technician
   * whose job it is still reads her own refusal in full.
   */
  it('withholds the job entirely from another technician, refusal and all', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1048', otherTechnician);
    expect(view).toBeNull();

    // Which is the whole point: there is no screen, and no hand-typed URL,
    // that can show what the loader did not hand over.
    const own = await loadJobView(harness.repos, 'EJE-1048', technician);
    expect(own?.job.signatureRefusals).toHaveLength(1);
    expect(currentRefusal(own!.job)?.reason).toBe(REASON);
  });

  it('redacts it in every list another technician can read', async () => {
    const jobs = await harness.repos.jobs.list();
    const rows = await loadJobRows(harness.repos, jobs, otherTechnician);
    const row = rows.find((candidate) => candidate.job.jobNumber === 'EJE-1048');
    expect(row?.job.signatureRefusals).toEqual([]);

    const officeRows = await loadJobRows(harness.repos, jobs, coordinator);
    const officeRow = officeRows.find((candidate) => candidate.job.jobNumber === 'EJE-1048');
    expect(officeRow?.job.signatureRefusals).toHaveLength(1);
  });

  it('leaves the record whole for the operations, which enforce against the truth', async () => {
    // No viewer: this is the system reading its own record, not a person
    // reading a screen. The rules have to run against what actually happened.
    const view = await loadJobView(harness.repos, 'EJE-1048');
    expect(view?.job.signatureRefusals).toHaveLength(1);
  });

  it('keeps the office capability off a technician', () => {
    expect(can('technician', 'jobs.viewAnySignatureRefusal')).toBe(false);
    expect(can('master', 'jobs.viewAnySignatureRefusal')).toBe(true);
    expect(can('coordinator', 'jobs.viewAnySignatureRefusal')).toBe(true);
  });
});

describe('the refusal queue the office works from', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
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
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    refused = await recordSignatureRefusal(context, job, { reason: REASON });
  });

  const countFor = async (viewer: typeof master): Promise<number> => {
    const jobs = await harness.repos.jobs.list();
    return unresolvedRefusals(await loadJobRows(harness.repos, jobs, viewer)).length;
  };

  it('counts the outstanding refusal for a Master and for a Coordinator', async () => {
    expect(await countFor(master)).toBe(1);
    expect(await countFor(coordinator)).toBe(1);
  });

  it('shows another technician nothing at all', async () => {
    // Not a smaller number: the rows they were handed have no refusals on them.
    expect(await countFor(otherTechnician)).toBe(0);
  });

  it('still shows the submitting technician their own', async () => {
    expect(await countFor(technician)).toBe(1);
  });

  it('drops out of the count once the office returns the card for signature', async () => {
    await returnToCustomerSignature(harness.as(master), refused, '');
    expect(await countFor(master)).toBe(0);
  });

  it('drops out of the count when the office issues without a signature', async () => {
    await resolveSignatureRefusal(harness.as(master), refused, '');
    expect(await countFor(master)).toBe(0);
  });

  it('comes back when the customer refuses the corrected card', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');
    expect(await countFor(master)).toBe(0);

    await recordSignatureRefusal(harness.as(technician), returned, { reason: SECOND_REASON });
    expect(await countFor(master)).toBe(1);
  });
});
