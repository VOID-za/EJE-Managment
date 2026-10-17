import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addChecklistPhoto,
  answerChecklistItem,
  completeChecklist,
  startChecklist,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, jpegFixture, seedUser, type Harness } from './test-harness';
import { asChecklistTemplateId, evaluateChecklist, type ChecklistTemplate, type Job } from '@/domain';

/**
 * A CHECKLIST IS COMPLETE WHEN THE TEMPLATE SAYS SO. CHK-GATE-1.
 *
 * THE DEFECT THIS FILE EXISTS TO STOP COMING BACK. `completeChecklist` used to
 * stamp `completedAt` on request and evaluate nothing at all. The runner
 * disabled its own *Complete checklist* button while items were outstanding,
 * and that was the whole of the enforcement — so a request made by hand, by an
 * older client, or by a tablet replaying a queue could complete an installation
 * checklist with every question blank.
 *
 * That is not a cosmetic difference. `checkReadyForCompletion` accepts a job
 * whose mandatory checklist carries a `completedAt`, and the customer's job
 * card reports the checklist as completed — so the document would have claimed
 * a commissioning checklist nobody had filled in.
 *
 * The four things the template can demand are each asserted below, through the
 * real operations: an answer to a required question, a note explaining a
 * failure, a note explaining a reading outside its range, and the evidence
 * photograph a question requires.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

const TEMPLATE_ID = asChecklistTemplateId('chk-gate-test');

/**
 * A four-question service checklist, built here rather than taken from the
 * seed: each question is one of the demands the gate has to enforce, and a
 * fixture with thirty questions would prove the same thing less clearly.
 */
const template = (): ChecklistTemplate => ({
  id: TEMPLATE_ID,
  name: 'Gate test checklist',
  description: 'One question per rule the completion gate enforces.',
  jobTypeCode: 'service',
  version: '1.0-GATE',
  status: 'current',
  sourceDocument: 'TEST CONTENT',
  updatedAt: '2026-10-01T08:00:00.000Z',
  sections: [
    {
      id: 'gate-section',
      title: 'Condition',
      description: '',
      items: [
        {
          id: 'gate-answer',
          text: 'Guarding in place',
          helpText: '',
          responseType: 'pass_fail_na',
          required: true,
          photoRequired: false,
          unit: null,
          expectedRange: null,
        },
        {
          id: 'gate-fail',
          text: 'Emergency stop functional',
          helpText: '',
          responseType: 'pass_fail_na',
          required: true,
          photoRequired: false,
          unit: null,
          expectedRange: null,
        },
        {
          id: 'gate-range',
          text: 'Supply voltage measured',
          helpText: '',
          responseType: 'measurement',
          required: true,
          photoRequired: false,
          unit: 'V',
          expectedRange: { min: 380, max: 420 },
        },
        {
          id: 'gate-photo',
          text: 'Spindle bearing condition photographed',
          helpText: '',
          responseType: 'pass_fail_na',
          required: true,
          photoRequired: true,
          unit: null,
          expectedRange: null,
        },
      ],
    },
  ],
});

/** A service job of Sipho's, accepted, with the test checklist started. */
const startedJob = async (harness: Harness): Promise<Job> => {
  await harness.repos.checklistTemplates.save(template());
  const found = await harness.repos.jobs.findByJobNumber('EJE-1048');
  if (found === null) throw new Error('EJE-1048 is not seeded');
  const service = await harness.repos.jobs.save({ ...found, jobType: 'service' });
  const accepted = await acceptJob(harness.as(sipho), service);
  return startChecklist(harness.as(sipho), accepted, template());
};

const complete = (harness: Harness, job: Job) =>
  completeChecklist(harness.as(sipho), job, template());

describe('completing a checklist', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a checklist with nothing answered at all', async () => {
    const job = await startedJob(harness);

    await expect(complete(harness, job)).rejects.toThrow(WorkflowError);

    // And nothing was stamped on the way out.
    const after = await harness.repos.jobs.findById(job.id);
    expect(after?.checklist?.completedAt).toBeNull();
    expect(after?.checklist?.completedBy).toBeNull();
  });

  it('names the outstanding questions in the refusal, by their own wording', async () => {
    const job = await startedJob(harness);

    const refusal = await complete(harness, job).catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(WorkflowError);
    const violations = (refusal as WorkflowError).violations;
    expect(violations.map((violation) => violation.code)).toContain('checklist_unanswered');
    expect(JSON.stringify(violations)).toContain('Guarding in place');
    // The same issues the runner is showing the technician, from the same
    // function — so the screen and the server cannot disagree about what is
    // outstanding.
    const progress = evaluateChecklist(template(), job.checklist);
    expect(violations).toHaveLength(progress.issues.length);
  });

  it('refuses a FAILED question whose finding has not been written down', async () => {
    let job = await startedJob(harness);
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-answer', { choice: 'pass' });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-fail', { choice: 'fail' });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-range', { measurement: 400 });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-photo', { choice: 'pass' });
    job = await withEvidence(harness, job);

    const refusal = await complete(harness, job).catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(WorkflowError);
    expect((refusal as WorkflowError).violations.map((violation) => violation.code)).toContain(
      'checklist_note_required',
    );

    // With the note, the same checklist completes.
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-fail', {
      notes: 'Station 2 mushroom head seized. Replacement quoted.',
    });
    const completed = await complete(harness, job);
    expect(completed.checklist?.completedAt).not.toBeNull();
  });

  it('refuses a reading outside its range with no explanation', async () => {
    let job = await startedJob(harness);
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-answer', { choice: 'pass' });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-fail', { choice: 'pass' });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-photo', { choice: 'pass' });
    job = await withEvidence(harness, job);
    // 300V on a 380–420V supply: a finding, whatever the technician meant.
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-range', { measurement: 300 });

    await expect(complete(harness, job)).rejects.toThrow(WorkflowError);

    job = await answerChecklistItem(harness.as(sipho), job, 'gate-range', {
      notes: 'Supply low at the isolator; the customer’s electrician was called.',
    });
    expect((await complete(harness, job)).checklist?.completedAt).not.toBeNull();
  });

  it('refuses a question whose evidence photograph was never attached', async () => {
    let job = await startedJob(harness);
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-answer', { choice: 'pass' });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-fail', { choice: 'pass' });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-range', { measurement: 400 });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-photo', { choice: 'pass' });

    const refusal = await complete(harness, job).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(WorkflowError);
    expect((refusal as WorkflowError).violations.map((violation) => violation.code)).toContain(
      'checklist_photo_required',
    );

    // The photograph is real bytes through the real path (CHK-EVIDENCE-1), and
    // the gate opens only once they are there.
    job = await withEvidence(harness, job);
    expect((await complete(harness, job)).checklist?.completedAt).not.toBeNull();
  });

  it('records who completed it, and when, once it is actually finished', async () => {
    let job = await startedJob(harness);
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-answer', { choice: 'pass' });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-fail', { choice: 'na' });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-range', { measurement: 400 });
    job = await answerChecklistItem(harness.as(sipho), job, 'gate-photo', { choice: 'pass' });
    job = await withEvidence(harness, job);

    const completed = await complete(harness, job);

    expect(completed.checklist?.completedBy).toBe(sipho.id);
    expect(completed.checklist?.completedAt).not.toBeNull();
    const trail = await harness.repos.activity.list(job.id);
    expect(trail.map((entry) => entry.type)).toContain('checklist_completed');
  });

  it('refuses a technician who is not on the job, before any of this', async () => {
    // The gate is a completeness rule, not a permission rule: the permission
    // rules still run first, and a Master is not the job's technician.
    const job = await startedJob(harness);
    await expect(
      completeChecklist(harness.as(elmarie), job, template()),
    ).rejects.toThrow(WorkflowError);
  });
});

/** Attaches the one evidence photograph the template demands. */
const withEvidence = async (harness: Harness, job: Job): Promise<Job> =>
  addChecklistPhoto(harness.as(sipho), job, 'gate-photo', {
    fileName: 'bearing.jpg',
    contentType: 'image/jpeg',
    bytes: jpegFixture('bearing'),
    caption: 'Bearing condition',
  });
