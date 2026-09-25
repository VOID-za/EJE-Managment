import { beforeEach, describe, expect, it } from 'vitest';
import {
  canSubmitJobCard,
  canTakeOverSubmission,
  isSubmissionUncovered,
  submissionCover,
  isFinalized,
  canEditJobRecord,
  type Job,
} from '@/domain';
import {
  acceptJob,
  addLabour,
  addNote,
  captureSignature,
  issueJobCard,
  loadSubmissionCover,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  returnToCustomerSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
  takeOverSubmission,
  updateLabour,
} from './job-operations';
import { createAvailability } from './availability-operations';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import { loadFinalDocumentFile } from './final-document';
import { buildHarness, confirmDelivery, dayOffset, seedUser, type Harness } from './test-harness';

/**
 * THE EXCEPTIONAL TAKEOVER. MASTER SCOPE CR-08, resolving BD-09.
 *
 * CR-07 gave the final submission to the technician who attended the machine,
 * and that left one real hole: a job the customer had already SIGNED, whose
 * technician then left EJE or went on leave, had nobody who could send the
 * customer their copy. It sat finished and unsent.
 *
 * This is the rescue, and the cases below are as much about what it is NOT:
 *
 *  - not a submission right — on an ordinary signed job the office is refused;
 *  - not the refusal review — a refused job card is refused outright;
 *  - not an edit — the job is signed, so it is final, and a takeover changes
 *    nothing on it;
 *  - not a different document — the customer receives the identical bytes.
 *
 * "Unavailable" is not an opinion. It is a disabled account or a whole-day
 * absence on the availability register, which only a Master writes.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');
const otherTechnician = seedUser('user-tech-riaan');
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
  /*
   * ONE technician on the job, so these cases are about the rule rather than
   * about the seed. EJE-1048 ships with a second technician attending, which
   * is its own case — see "a second technician on the job who IS available",
   * which adds one back deliberately.
   */
  let job = await harness.repos.jobs.save({ ...view!.job, additionalTechnicianIds: [] });
  job = await acceptJob(context, job);
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

/** Puts the technician on leave today, the way the office actually does it. */
const sendOnLeave = async (harness: Harness, userId: string): Promise<void> => {
  await createAvailability(harness.as(master), {
    userId: userId as never,
    type: 'annual_leave',
    startDate: dayOffset(0),
    endDate: dayOffset(4),
    allDay: true,
    startTime: null,
    endTime: null,
    description: 'Annual leave.',
  });
};

/* ------------------------------------------------------------------ *
 * The normal rule is untouched.
 * ------------------------------------------------------------------ */

describe('an ordinary signed job, whose technician is at work', () => {
  let harness: Harness;
  let signed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    signed = await signedJob(harness);
  });

  it('is submitted by the technician', async () => {
    expect(canSubmitJobCard(technician, signed)).toBe(true);
    expect((await issueJobCard(harness.as(technician), signed, EMAIL, RECIPIENT)).job.status).toBe(
      'awaiting_delivery',
    );
  });

  it('is NOT submittable by the Coordinator', async () => {
    expect(canSubmitJobCard(coordinator, signed)).toBe(false);
    expect(
      await codesFrom(() => issueJobCard(harness.as(coordinator), signed, EMAIL, RECIPIENT)),
    ).toContain('not_permitted');
  });

  it('is NOT submittable by the Master', async () => {
    expect(canSubmitJobCard(master, signed)).toBe(false);
    expect(
      await codesFrom(() => issueJobCard(harness.as(master), signed, EMAIL, RECIPIENT)),
    ).toContain('not_permitted');
  });

  it('offers the office NO takeover — there is nothing to rescue', async () => {
    const cover = await loadSubmissionCover(harness.as(master), signed);
    expect(cover.available).toEqual([technician.id]);
    expect(isSubmissionUncovered(cover)).toBe(false);

    expect(canTakeOverSubmission('master', signed, cover)).toBe(false);
    expect(canTakeOverSubmission('coordinator', signed, cover)).toBe(false);
  });

  it('refuses a takeover that is asked for anyway, and sends nothing', async () => {
    expect(
      await codesFrom(() => takeOverSubmission(harness.as(master), signed, EMAIL, RECIPIENT)),
    ).toContain('takeover_not_available');

    const after = await harness.repos.jobs.findById(signed.id);
    expect(after?.status).toBe('review');
    expect(after?.finalDocument).toBeNull();
    expect(await harness.outbox.list()).toHaveLength(0);
  });

  it('is not unlocked by a PART-DAY absence — an appointment is not being away', async () => {
    /*
     * The boundary, stated as a case. A two-hour appointment is modelled
     * separately from a whole day precisely because the technician is at work
     * either side of it; it is not grounds for the office to take their
     * submission away from them.
     */
    await createAvailability(harness.as(master), {
      userId: technician.id,
      type: 'appointment',
      startDate: dayOffset(0),
      endDate: dayOffset(0),
      allDay: false,
      startTime: '09:00',
      endTime: '11:00',
      description: 'Dentist.',
    });

    const cover = await loadSubmissionCover(harness.as(master), signed);
    expect(isSubmissionUncovered(cover)).toBe(false);
    expect(canTakeOverSubmission('master', signed, cover)).toBe(false);
  });

  it('is not unlocked by an absence on a DIFFERENT day', async () => {
    await createAvailability(harness.as(master), {
      userId: technician.id,
      type: 'annual_leave',
      startDate: dayOffset(7),
      endDate: dayOffset(10),
      allDay: true,
      startTime: null,
      endTime: null,
      description: 'Next week.',
    });

    expect(isSubmissionUncovered(await loadSubmissionCover(harness.as(master), signed))).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The exception itself.
 * ------------------------------------------------------------------ */

describe('a signed job whose technician is away', () => {
  let harness: Harness;
  let signed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    signed = await signedJob(harness);
    await sendOnLeave(harness, technician.id);
  });

  it('is uncovered, and says why', async () => {
    const cover = await loadSubmissionCover(harness.as(master), signed);
    expect(isSubmissionUncovered(cover)).toBe(true);
    expect(cover.blocked).toHaveLength(1);
    expect(cover.blocked[0]).toMatchObject({ kind: 'away', userId: technician.id });
  });

  it('lets the COORDINATOR take it over', async () => {
    const cover = await loadSubmissionCover(harness.as(coordinator), signed);
    expect(canTakeOverSubmission('coordinator', signed, cover)).toBe(true);

    const result = await takeOverSubmission(harness.as(coordinator), signed, EMAIL, RECIPIENT);
    expect(result.job.status).toBe('awaiting_delivery');
  });

  it('lets the MASTER take it over', async () => {
    expect((await takeOverSubmission(harness.as(master), signed, EMAIL, RECIPIENT)).job.status).toBe(
      'awaiting_delivery',
    );
  });

  it('still refuses a TECHNICIAN who is not on the job', async () => {
    // A takeover is the office's exception, not a way for any technician to
    // reach into somebody else's work.
    expect(
      await codesFrom(() =>
        takeOverSubmission(harness.as(otherTechnician), signed, EMAIL, RECIPIENT),
      ),
    ).toContain('not_permitted');
  });

  it('creates the customer delivery, exactly as a technician submission does', async () => {
    const result = await takeOverSubmission(harness.as(master), signed, EMAIL, RECIPIENT);

    expect(result.job.finalDocument).not.toBeNull();
    const toCustomer = (await harness.outbox.list()).filter((entry) => entry.to.includes(EMAIL));
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0]?.attachments.length).toBeGreaterThan(0);

    // And the handshake is the same one: an accepted send is not a delivery.
    expect(result.job.status).toBe('awaiting_delivery');
    expect((await confirmDelivery(harness, harness.as(master), result.job)).status).toBe('closed');
  });

  it('produces the IDENTICAL document the technician would have sent', async () => {
    /*
     * Byte for byte, against a second run of the same job submitted by the
     * technician. If a takeover could produce a different document it would be
     * a way to reissue a signed job card, which is the thing CR-01 exists to
     * prevent.
     */
    const theirs = buildHarness();
    const theirSigned = await signedJob(theirs);
    await issueJobCard(theirs.as(technician), theirSigned, EMAIL, RECIPIENT);
    const byTechnician = await loadFinalDocumentFile(theirs.as(master), 'EJE-1048');

    await takeOverSubmission(harness.as(master), signed, EMAIL, RECIPIENT);
    const byOffice = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    expect(byOffice.fileName).toBe(byTechnician.fileName);
    expect(Array.from(byOffice.bytes)).toEqual(Array.from(byTechnician.bytes));
  });

  it('CHANGES NOTHING on the signed job card', async () => {
    const before = await harness.repos.jobs.findById(signed.id);
    const result = await takeOverSubmission(harness.as(master), signed, EMAIL, RECIPIENT);

    // Everything the customer signed for, untouched.
    expect(result.job.signature).toEqual(before!.signature);
    expect(result.job.completionReport).toEqual(before!.completionReport);
    expect(result.job.labour).toEqual(before!.labour);
    expect(result.job.travel).toEqual(before!.travel);
    expect(result.job.parts).toEqual(before!.parts);
    expect(result.job.calloutApplied).toBe(before!.calloutApplied);
    expect(result.job.pricingSnapshot).toEqual(before!.pricingSnapshot);
    expect(result.job.primaryTechnicianId).toBe(before!.primaryTechnicianId);
  });

  it('gives the office no edit rights on the way through', async () => {
    expect(isFinalized(signed)).toBe(true);
    for (const role of ['master', 'coordinator', 'technician'] as const) {
      expect(canEditJobRecord(role, signed), role).toBe(false);
    }

    // Asked of the operations, not only of the predicate.
    const office = harness.as(master);
    expect(
      await codesFrom(() =>
        saveCompletionReport(office, signed, {
          ...signed.completionReport,
          workPerformed: 'Rewritten by the office before taking it over.',
        }),
      ),
    ).not.toHaveLength(0);
    expect(
      await codesFrom(() =>
        updateLabour(office, signed, signed.labour[0]!.id, {
          date: '2026-09-17',
          rateType: 'normal',
          hours: 99,
          description: '',
        }),
      ),
    ).not.toHaveLength(0);
    expect(await codesFrom(() => addNote(office, signed, 'A late note.', false))).not.toHaveLength(
      0,
    );
  });

  it('records WHO took over, for WHOM and WHY — distinctly from a submission', async () => {
    await takeOverSubmission(harness.as(coordinator), signed, EMAIL, RECIPIENT);

    const trail = await harness.repos.activity.list(signed.id);
    const takeover = trail.filter((event) => event.type === 'submission_taken_over');
    expect(takeover).toHaveLength(1);
    expect(takeover[0]?.actorId).toBe(coordinator.id);
    expect(takeover[0]?.summary).toContain('took over');
    expect(takeover[0]?.detail).toContain('Sipho');
    expect(takeover[0]?.detail).toMatch(/annual leave/i);
    expect(takeover[0]?.detail).toMatch(/nothing on the signed job card was changed/i);

    // The ordinary submission event is there too — the job card WAS submitted —
    // and the two are told apart by type rather than by reading the wording.
    expect(trail.filter((event) => event.type === 'job_submitted')).toHaveLength(1);
  });

  it('cannot be taken over twice', async () => {
    await takeOverSubmission(harness.as(master), signed, EMAIL, RECIPIENT);
    const issued = (await harness.repos.jobs.findById(signed.id))!;
    expect(
      await codesFrom(() => takeOverSubmission(harness.as(master), issued, EMAIL, RECIPIENT)),
    ).toContain('takeover_not_available');
  });
});

describe('a signed job whose technician has left EJE', () => {
  let harness: Harness;
  let signed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    signed = await signedJob(harness);
    const person = await harness.repos.users.findById(technician.id);
    await harness.repos.users.save({ ...person!, active: false });
  });

  it('is uncovered because the account is disabled', async () => {
    const cover = await loadSubmissionCover(harness.as(master), signed);
    expect(cover.blocked[0]).toEqual({ kind: 'account_disabled', userId: technician.id });
    expect(isSubmissionUncovered(cover)).toBe(true);
  });

  it('can be taken over, and says so on the trail', async () => {
    await takeOverSubmission(harness.as(master), signed, EMAIL, RECIPIENT);
    const trail = await harness.repos.activity.list(signed.id);
    expect(
      trail.find((event) => event.type === 'submission_taken_over')?.detail,
    ).toMatch(/account is disabled/i);
  });
});

describe('a second technician on the job who IS available', () => {
  it('keeps the job covered, so there is nothing for the office to take over', async () => {
    /*
     * The question is whether the JOB is stuck, not whether one person is
     * away. A colleague who attended it and is at work can submit it, so the
     * exception must stay shut.
     */
    const harness = buildHarness();
    const context = harness.as(technician);
    const view = await loadJobView(harness.repos, 'EJE-1048');
    let job = await harness.repos.jobs.save({
      ...view!.job,
      additionalTechnicianIds: [otherTechnician.id],
    });
    job = await acceptJob(context, job);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Attended together.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: '',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    const signed = await captureSignature(context, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M 10 40 L 60 10',
    });

    await sendOnLeave(harness, technician.id);

    const cover = await loadSubmissionCover(harness.as(master), signed);
    expect(cover.available).toEqual([otherTechnician.id]);
    expect(isSubmissionUncovered(cover)).toBe(false);
    expect(canTakeOverSubmission('master', signed, cover)).toBe(false);

    // And the colleague can indeed finish it.
    expect(
      (await issueJobCard(harness.as(otherTechnician), signed, EMAIL, RECIPIENT)).job.status,
    ).toBe('awaiting_delivery');
  });
});

/* ------------------------------------------------------------------ *
 * The refusal workflow stays entirely separate.
 * ------------------------------------------------------------------ */

describe('the refusal workflow does not use the takeover', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const context = harness.as(technician);
    const view = await loadJobView(harness.repos, 'EJE-1048');
    let job = await harness.repos.jobs.save({ ...view!.job, additionalTechnicianIds: [] });
    job = await acceptJob(context, job);
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
    refused = await recordSignatureRefusal(context, job, {
      reason: 'The planner disputes the hours.',
    });
    // Even with the technician away, a refusal is not a takeover case.
    await sendOnLeave(harness, technician.id);
  });

  it('refuses a takeover on an UNSIGNED, refused job card', async () => {
    const cover = await loadSubmissionCover(harness.as(master), refused);
    expect(canTakeOverSubmission('master', refused, cover)).toBe(false);
    expect(canTakeOverSubmission('coordinator', refused, cover)).toBe(false);

    expect(
      await codesFrom(() => takeOverSubmission(harness.as(master), refused, EMAIL, RECIPIENT)),
    ).toContain('takeover_not_available');
  });

  it('OUTCOME B still closes the job immediately', async () => {
    const closed = await resolveSignatureRefusal(harness.as(coordinator), refused, '');
    expect(closed.status).toBe('closed');
    expect(closed.signature).toBeNull();

    const cover = await loadSubmissionCover(harness.as(master), closed);
    expect(canTakeOverSubmission('master', closed, cover)).toBe(false);
  });

  it('OUTCOME A still returns it to the technician signature workflow', async () => {
    const returned = await returnToCustomerSignature(harness.as(coordinator), refused, '');
    expect(returned.status).toBe('customer_signature');

    // Not a takeover case either: there is no signature yet to submit.
    const cover = await loadSubmissionCover(harness.as(master), returned);
    expect(canTakeOverSubmission('master', returned, cover)).toBe(false);
  });

  it('becomes a takeover case only once it is SIGNED and the technician is away', async () => {
    const returned = await returnToCustomerSignature(harness.as(coordinator), refused, '');
    const signed = await captureSignature(harness.as(technician), returned, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M 10 40 L 60 10',
    });

    const cover = await loadSubmissionCover(harness.as(master), signed);
    expect(canTakeOverSubmission('master', signed, cover)).toBe(true);
    expect((await takeOverSubmission(harness.as(master), signed, EMAIL, RECIPIENT)).job.status).toBe(
      'awaiting_delivery',
    );
  });
});

/* ------------------------------------------------------------------ *
 * The rule itself, as a pure function.
 * ------------------------------------------------------------------ */

describe('submissionCover, asked directly', () => {
  const job = {
    status: 'review',
    jobType: 'breakdown',
    primaryTechnicianId: technician.id,
    additionalTechnicianIds: [],
  } as const;

  const people = [
    { ...technician, active: true },
    { ...master, active: true },
    { ...coordinator, active: true },
  ];

  it('reports the job unassigned when nobody on it could submit it', () => {
    const cover = submissionCover(
      { ...job, primaryTechnicianId: null },
      people,
      [],
      '2026-09-25',
    );
    expect(cover.unassigned).toBe(true);
    expect(isSubmissionUncovered(cover)).toBe(true);
  });

  it('ignores a CANCELLED absence, because a cancelled absence stops blocking', () => {
    const cover = submissionCover(
      job,
      people,
      [
        {
          id: 'a1',
          userId: technician.id,
          type: 'annual_leave',
          startDate: '2026-09-24',
          endDate: '2026-09-26',
          allDay: true,
          startTime: null,
          endTime: null,
          description: '',
          status: 'cancelled',
          createdBy: master.id,
          createdAt: '2026-09-20T08:00:00.000Z',
          cancelledBy: master.id,
          cancelledAt: '2026-09-23T08:00:00.000Z',
        },
      ],
      '2026-09-25',
    );
    expect(cover.available).toEqual([technician.id]);
  });

  it('ignores an absence belonging to somebody else', () => {
    const cover = submissionCover(
      job,
      people,
      [
        {
          id: 'a2',
          userId: otherTechnician.id,
          type: 'sick_leave',
          startDate: '2026-09-25',
          endDate: '2026-09-25',
          allDay: true,
          startTime: null,
          endTime: null,
          description: '',
          status: 'active',
          createdBy: master.id,
          createdAt: '2026-09-20T08:00:00.000Z',
          cancelledBy: null,
          cancelledAt: null,
        },
      ],
      '2026-09-25',
    );
    expect(cover.available).toEqual([technician.id]);
  });
});
