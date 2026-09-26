import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addMedia,
  moveToAwaitingSpares,
  returnToInProgress,
  saveCompletionReport,
} from './job-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import type { Job } from '@/domain';

/**
 * WHAT A JOB IS WAITING FOR, AND SINCE WHEN. MASTER SCOPE SPARE-2.
 *
 * "Spares: description, notes, photo, request date" — and what existed was one
 * free-text `awaitingSparesReason`. It conflated the part somebody has to order
 * with whatever else was going on, had nowhere to put the photograph the
 * technician took of the part, and recorded no date at all, so nobody could say
 * how long a machine had been standing.
 *
 * Worse, `returnToInProgress` CLEARED it. The moment the part arrived, the only
 * record that the job had ever waited for one was gone.
 *
 * TWO READINGS ARE MADE EXPLICIT HERE, because the requirement is a four-word
 * list and neither is self-evident:
 *
 *  - "request date" is the moment the request was MADE, stamped from the clock.
 *    Not a date anybody types, and not an expected-return date — that would be a
 *    different field and is not invented here.
 *  - "photo" is a reference to one of the job's OWN photographs, not a second
 *    upload path. The technician photographs the part as a job photo anyway.
 */
const technician = seedUser('user-tech-sipho');

describe('a spares request', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const accepted = async (): Promise<Job> => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    return acceptJob(harness.as(technician), opened!);
  };

  it('records the description, the notes and the moment it was raised', async () => {
    const context = harness.as(technician);
    const job = await moveToAwaitingSpares(context, await accepted(), {
      description: 'Replacement IGBT module, Siemens 6SL3120-1TE21-0AA4.',
      notes: 'On back-order. Machine left isolated.',
    });

    expect(job.status).toBe('awaiting_spares');
    expect(job.sparesRequest?.description).toBe(
      'Replacement IGBT module, Siemens 6SL3120-1TE21-0AA4.',
    );
    expect(job.sparesRequest?.notes).toBe('On back-order. Machine left isolated.');
    expect(job.sparesRequest?.photoId).toBeNull();

    /*
     * FROM THE CLOCK, not from the caller — which is the point of the field.
     * Asserted as "a real instant, just now" rather than against a second
     * reading of the clock, because the harness clock is the system clock and
     * moves between the two.
     */
    const requestedAt = Date.parse(job.sparesRequest?.requestedAt ?? '');
    expect(Number.isNaN(requestedAt)).toBe(false);
    expect(Math.abs(Date.now() - requestedAt)).toBeLessThan(5_000);
  });

  it('refuses a request that does not say what is needed', async () => {
    const refusal = await moveToAwaitingSpares(harness.as(technician), await accepted(), {
      description: '   ',
      notes: 'Spoke to the supplier.',
    }).then(
      () => null,
      (error: unknown) => error as WorkflowError,
    );

    expect(refusal).toBeInstanceOf(WorkflowError);
    expect(refusal?.violations.map((violation) => violation.code)).toContain(
      'spares_description_required',
    );

    // And the job did not move: "awaiting spares" with nothing to order is not a
    // state this workflow has.
    const stored = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(stored?.status).toBe('in_progress');
    expect(stored?.sparesRequest).toBeNull();
  });

  it('carries no request at all on a job that has never waited', async () => {
    // Null, not a request whose every field is empty — the screens would have to
    // tell those apart, and would eventually get it wrong.
    expect((await accepted()).sparesRequest).toBeNull();
  });

  /* -- the photograph ------------------------------------------------------ */

  it('points at a photograph already on the job', async () => {
    const context = harness.as(technician);
    let job = await accepted();
    job = await addMedia(context, job, {
      kind: 'photo',
      fileName: 'nameplate.jpg',
      caption: 'Drive nameplate',
      storageKey: 'uploads/nameplate.jpg',
      sizeBytes: 2048,
      contentType: 'image/jpeg',
    } as never);
    const photoId = job.photos[0]?.id ?? '';
    expect(photoId).not.toBe('');

    job = await moveToAwaitingSpares(context, job, {
      description: 'IGBT module as per the nameplate.',
      photoId,
    });

    expect(job.sparesRequest?.photoId).toBe(photoId);
  });

  it('refuses a photograph that is not on this job', async () => {
    const refusal = await moveToAwaitingSpares(harness.as(technician), await accepted(), {
      description: 'IGBT module.',
      photoId: 'att-belonging-to-another-job',
    }).then(
      () => null,
      (error: unknown) => error as WorkflowError,
    );

    /*
     * An id from another job would put one customer's photograph on another
     * customer's job, and every screen would render it without asking whose it
     * was. Checked in the operation, not trusted from the request.
     */
    expect(refusal?.violations.map((violation) => violation.code)).toContain('photo_not_on_job');
  });

  /* -- the history survives ------------------------------------------------ */

  it('KEEPS the request when the job resumes', async () => {
    const context = harness.as(technician);
    const held = await moveToAwaitingSpares(context, await accepted(), {
      description: 'Spindle drive belt, Optibelt SK 1120.',
    });

    const resumed = await returnToInProgress(context, held);

    expect(resumed.status).toBe('in_progress');
    /*
     * THE CHANGE THAT MATTERS MOST. This used to be cleared, so a job that had
     * stood for three weeks looked exactly like one that never waited at all the
     * moment the part arrived.
     */
    expect(resumed.sparesRequest?.description).toBe('Spindle drive belt, Optibelt SK 1120.');
    expect(resumed.sparesRequest?.requestedAt).toBe(held.sparesRequest?.requestedAt);
  });

  it('says how long the job waited in the trail when it resumes', async () => {
    const context = harness.as(technician);
    const held = await moveToAwaitingSpares(context, await accepted(), {
      description: 'Encoder assembly.',
    });
    const resumed = await returnToInProgress(context, held);

    const trail = await harness.repos.activity.list(resumed.id);
    const resumeEvent = trail.find((event) => event.type === 'returned_to_in_progress');
    expect(resumeEvent?.detail).toContain('Encoder assembly.');
    // The clock does not move in this harness, so it is under a day.
    expect(resumeEvent?.detail).toContain('less than a day');
  });

  it('replaces the request when a job waits a second time', async () => {
    const context = harness.as(technician);
    const first = await moveToAwaitingSpares(context, await accepted(), {
      description: 'Contactor.',
    });
    const resumed = await returnToInProgress(context, first);
    const second = await moveToAwaitingSpares(context, resumed, {
      description: 'Encoder assembly.',
      notes: 'Different fault, found after the contactor was fitted.',
    });

    // A job may go in and out as many times as needed; what it is waiting for
    // NOW is the current request.
    expect(second.sparesRequest?.description).toBe('Encoder assembly.');
    expect(second.sparesRequest?.notes).toContain('Different fault');
  });

  /* -- immutability -------------------------------------------------------- */

  it('cannot be raised against a signed job card', async () => {
    const context = harness.as(technician);
    let job = await accepted();
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Fault-found.',
    });
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Diagnosed.',
    });

    /*
     * IMMUT-7. A signed job card is final, and a spares request is part of the
     * job record. `assertEditable` is asked before anything is written, so this
     * is refused for the same reason an amended labour line is.
     */
    const signedJob = { ...job, status: 'review' as const, signature: {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
      signedAt: '2026-09-20T12:00:00.000Z',
      declaration: 'I confirm that the work described above has been completed.',
    } };

    const refusal = await moveToAwaitingSpares(context, signedJob, {
      description: 'Another part.',
    }).then(
      () => null,
      (error: unknown) => error as WorkflowError,
    );

    expect(refusal).toBeInstanceOf(WorkflowError);
  });
});
