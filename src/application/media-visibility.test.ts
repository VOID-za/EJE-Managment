import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addMedia,
  captureSignature,
  saveCompletionReport,
  setMediaVisibility,
  startCompletion,
  startSignature,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { buildJobCardModel } from '@/lib/job-card/model';
import { loadJobView } from './job-view';
import type { Job } from '@/domain';

/**
 * WHO A PHOTOGRAPH IS FOR. MASTER SCOPE MEDIA-1, and MEDIA-2 with it.
 *
 * `job_media` had no classification, so there was no way to say that a
 * photograph was EJE's own — and `lib/job-card/model.ts` mapped EVERY photograph
 * onto the customer's document. A technician photographing a damaged part to
 * claim for it, or an unsafe installation to raise with the office, had its
 * caption printed on the job card the customer signed. MEDIA-2 was blocked on
 * exactly that: there was nothing to filter by.
 *
 * WHY THE FILTER IS HERE TOO, and not held back for MEDIA-2: a classification the
 * document ignores is a control that lies. Marking a photograph internal has to
 * mean something at the one place it exists to control, so `MEDIA-1` ships with
 * the one line that makes it true.
 *
 * THE DEFAULT IS `customer_facing`, and that is a decision worth stating. It is
 * what every photograph already was in effect — all of them were printed — so
 * recording them as anything else would reclassify records nobody reviewed,
 * including on signed job cards. New media defaults the same way and the
 * technician marks the exceptions.
 */
const technician = seedUser('user-tech-sipho');

describe('customer-facing and internal media', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const accepted = async (): Promise<Job> => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    return acceptJob(harness.as(technician), opened!);
  };

  const photo = (caption: string, visibility?: 'customer_facing' | 'internal') =>
    ({
      kind: 'photo' as const,
      fileName: `${caption.replace(/\s+/gu, '-')}.jpg`,
      caption,
      sizeBytes: 2_140_000,
      ...(visibility === undefined ? {} : { visibility }),
    });

  /** The captions the customer's document would actually print. */
  const documentCaptions = async (job: Job): Promise<readonly string[]> => {
    const view = await loadJobView(harness.repos, job.jobNumber);
    const model = buildJobCardModel({
      job,
      customer: view!.customer,
      site: view!.site,
      contact: view!.contact,
      machine: view!.machine,
      settings: view!.settings,
      checklistTemplate: view!.checklistTemplate,
      users: view!.users,
      generatedAt: '2026-09-27T10:00:00.000Z',
    });
    return model.photos.map((entry) => entry.caption);
  };

  /* -- the classification -------------------------------------------------- */

  it('records a photograph as customer-facing unless told otherwise', async () => {
    const job = await addMedia(harness.as(technician), await accepted(), photo('Spindle drive'));
    expect(job.photos[0]?.visibility).toBe('customer_facing');
  });

  it('records a photograph as internal when the technician says so', async () => {
    const job = await addMedia(
      harness.as(technician),
      await accepted(),
      photo('Leaking roof above the cabinet', 'internal'),
    );
    expect(job.photos[0]?.visibility).toBe('internal');
  });

  /* -- what MEDIA-2 was blocked on ----------------------------------------- */

  it('keeps an internal photograph OFF the customer document', async () => {
    const context = harness.as(technician);
    let job = await accepted();
    job = await addMedia(context, job, photo('Failed control transformer'));
    job = await addMedia(context, job, photo('Leaking roof above the cabinet', 'internal'));

    const captions = await documentCaptions(job);

    /*
     * THE WHOLE POINT. Before this, both captions were printed on the document
     * the customer signed — including the one about their leaking roof, which is
     * EJE's evidence and not part of the work done.
     */
    expect(captions).toEqual(['Failed control transformer']);
    // And the photograph is still ON the job: it is hidden from the customer,
    // not deleted from the record.
    expect(job.photos).toHaveLength(2);
  });

  it('prints no photographs section at all when every one is internal', async () => {
    const context = harness.as(technician);
    let job = await accepted();
    job = await addMedia(context, job, photo('Workshop note', 'internal'));

    // The document omits an empty section rather than printing a bare heading —
    // DOC-1 already decided that, and the filter must not defeat it.
    expect(await documentCaptions(job)).toEqual([]);
  });

  /* -- reclassifying ------------------------------------------------------- */

  it('reclassifies a photograph, and says what it was', async () => {
    const context = harness.as(technician);
    let job = await addMedia(context, await accepted(), photo('Damaged coupling'));
    const id = job.photos[0]!.id;

    job = await setMediaVisibility(context, job, id, 'internal');
    expect(job.photos[0]?.visibility).toBe('internal');
    expect(await documentCaptions(job)).toEqual([]);

    const trail = await harness.repos.activity.list(job.id);
    const event = trail.find((entry) => entry.type === 'photo_visibility_changed');
    expect(event?.summary).toContain('marked internal');
    // AUDIT-2: what it was, not only what it became.
    expect(event?.changes).toEqual([
      { field: 'media.visibility', from: 'customer_facing', to: 'internal' },
    ]);
  });

  it('puts an internal photograph back on the document', async () => {
    const context = harness.as(technician);
    let job = await addMedia(context, await accepted(), photo('Rating plate', 'internal'));
    const id = job.photos[0]!.id;

    job = await setMediaVisibility(context, job, id, 'customer_facing');

    expect(await documentCaptions(job)).toEqual(['Rating plate']);
  });

  it('writes nothing when the classification is already what was asked for', async () => {
    const context = harness.as(technician);
    const job = await addMedia(context, await accepted(), photo('Spindle drive'));
    const before = (await harness.repos.activity.list(job.id)).length;

    await setMediaVisibility(context, job, job.photos[0]!.id, 'customer_facing');

    // No audit row for a change that did not happen.
    expect((await harness.repos.activity.list(job.id)).length).toBe(before);
  });

  it('refuses a photograph that is not on the job', async () => {
    const refusal = await setMediaVisibility(
      harness.as(technician),
      await accepted(),
      'att-from-another-job',
      'internal',
    ).then(
      () => null,
      (error: unknown) => error as WorkflowError,
    );

    expect(refusal).toBeInstanceOf(WorkflowError);
    expect(refusal?.violations.map((violation) => violation.code)).toContain('media_not_on_job');
  });

  /* -- immutability -------------------------------------------------------- */

  it('cannot reclassify a photograph once the customer has signed', async () => {
    const context = harness.as(technician);
    let job = await accepted();
    job = await addMedia(context, job, photo('Failed transformer'));
    const id = job.photos[0]!.id;
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Replaced the transformer.',
    });
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the transformer.',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    job = await captureSignature(context, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    /*
     * IMMUT-7. The document the customer signed showed exactly the
     * customer-facing photographs of that moment. Reclassifying one afterwards
     * would change what a signed job card means, so it is refused — here, in the
     * repository's frozen fingerprint, and by `0007`'s trigger.
     */
    const refusal = await setMediaVisibility(context, job, id, 'internal').then(
      () => null,
      (error: unknown) => error as WorkflowError,
    );

    expect(refusal).toBeInstanceOf(WorkflowError);
    const stored = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(stored?.photos[0]?.visibility).toBe('customer_facing');
  });
});
