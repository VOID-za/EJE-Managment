import { beforeEach, describe, expect, it } from 'vitest';
import type { Job } from '@/domain';
import {
  acceptJob,
  addLabour,
  addMedia,
  addNote,
  addPart,
  addTravel,
  cancelCompletion,
  captureSignature,
  recordSignatureRefusal,
  returnToCustomerSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { buildHarness, jpegFixture, seedUser, type Harness } from './test-harness';

/**
 * COMPLETE-CANCEL-1 (the owner's instruction of 27 October 2026). Cancelling
 * completion before the customer signs returns the job to In Progress with
 * EVERYTHING kept, from every pre-signature stage; it is refused once anybody
 * has signed or refused; and the job can be completed again afterwards.
 */
const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

/** A job with one of every capture on it. */
const workedJob = async (): Promise<Job> => {
  const tech = harness.as(technician);
  const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
  let job = await acceptJob(tech, opened!);
  job = await addLabour(tech, job, { date: '2026-10-27', rateType: 'normal', hours: 2, description: 'Fan' });
  job = await addTravel(tech, job, { date: '2026-10-27', kilometres: 42, description: 'To site' });
  job = await addPart(tech, job, { partNumber: 'FAN-1', description: 'Fan', quantity: 1, unitPrice: 10_000 });
  job = await addNote(tech, job, 'Gate 4 access', true);
  job = await addMedia(tech, job, { kind: 'photo', fileName: 'fan.jpg', caption: 'Fan', contentType: 'image/jpeg', bytes: jpegFixture('fan') });
  return saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Replaced the fan.' });
};

const captures = (job: Job) => ({
  labour: job.labour.map((entry) => [entry.id, entry.hours]),
  travel: job.travel.map((entry) => [entry.id, entry.kilometres]),
  parts: job.parts.map((entry) => [entry.id, entry.quantity]),
  notes: job.notes.map((note) => [note.id, note.body]),
  photos: job.photos.map((photo) => [photo.id, photo.checksumSha256]),
  report: job.completionReport,
  checklist: job.checklist,
});

const reload = async (): Promise<Job> => (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;

describe('cancelling completion before the customer signs', () => {
  it('from Completion: back to In Progress, every capture kept exactly', async () => {
    const tech = harness.as(technician);
    const before = await startCompletion(tech, await workedJob());
    const after = await cancelCompletion(tech, before);
    expect(after.status).toBe('in_progress');
    expect(captures(await reload())).toEqual(captures(before));
    const trail = await harness.repos.activity.list(before.id);
    expect(trail.some((event) => event.type === 'completion_cancelled')).toBe(true);
  });

  it('from Customer Signature (stepped back from the signature): back to In Progress, everything kept', async () => {
    const tech = harness.as(technician);
    let job = await startCompletion(tech, await workedJob());
    job = await startSignature(tech, job);
    expect(job.status).toBe('customer_signature');
    const after = await cancelCompletion(tech, job);
    expect(after.status).toBe('in_progress');
    expect(captures(await reload())).toEqual(captures(job));
  });

  it('can be completed again afterwards, and signed', async () => {
    const tech = harness.as(technician);
    let job = await cancelCompletion(tech, await startCompletion(tech, await workedJob()));
    job = await startCompletion(tech, job);
    job = await startSignature(tech, job);
    job = await captureSignature(tech, job, { customerName: 'A', customerSurname: 'B', strokeData: 'M0 0 L1 1' });
    expect(job.status).toBe('review');
    expect(job.labour).toHaveLength(1);
  });

  it('is refused once the customer has signed — a committed job is not reopened this way', async () => {
    const tech = harness.as(technician);
    let job = await startCompletion(tech, await workedJob());
    job = await startSignature(tech, job);
    job = await captureSignature(tech, job, { customerName: 'A', customerSurname: 'B', strokeData: 'M0 0 L1 1' });
    await expect(cancelCompletion(tech, job)).rejects.toMatchObject({ violations: [{ code: 'already_signed' }] });
    expect((await reload()).status).toBe('review');
  });

  it('is refused while a refusal waits for the office', async () => {
    const tech = harness.as(technician);
    let job = await startCompletion(tech, await workedJob());
    job = await startSignature(tech, job);
    job = await recordSignatureRefusal(tech, job, { reason: 'Disputes the hours.' });
    await expect(cancelCompletion(tech, job)).rejects.toBeDefined();
    expect((await reload()).status).toBe('review');
  });

  it('is refused after a refusal was returned for signature: its prices are frozen', async () => {
    const tech = harness.as(technician);
    let job = await startCompletion(tech, await workedJob());
    job = await startSignature(tech, job);
    job = await recordSignatureRefusal(tech, job, { reason: 'Disputes the hours.' });
    job = await returnToCustomerSignature(harness.as(master), job, 'Hours checked.');
    expect(job.status).toBe('customer_signature');
    expect(job.pricingSnapshot).not.toBeNull();
    await expect(cancelCompletion(tech, job)).rejects.toMatchObject({ violations: [{ code: 'pricing_frozen' }] });
    expect((await reload()).status).toBe('customer_signature');
  });

  it('is refused from In Progress (nothing to cancel) and on a parts collection', async () => {
    const tech = harness.as(technician);
    const job = await workedJob();
    await expect(cancelCompletion(tech, job)).rejects.toMatchObject({ violations: [{ code: 'not_in_completion' }] });
    await expect(cancelCompletion(tech, { ...job, status: 'completion', jobType: 'parts' })).rejects.toMatchObject({
      violations: [{ code: 'not_applicable_to_job_type' }],
    });
  });

  it('is refused to somebody who may not capture on the job', async () => {
    const tech = harness.as(technician);
    const job = await startCompletion(tech, await workedJob());
    await expect(cancelCompletion(harness.as(seedUser('user-tech-riaan')), job)).rejects.toBeDefined();
    expect((await reload()).status).toBe('completion');
  });
});
