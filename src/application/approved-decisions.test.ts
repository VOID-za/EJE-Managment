import { beforeEach, describe, expect, it } from 'vitest';
import { asCustomerId, type Job } from '@/domain';
import { documentPhotos } from '@/lib/job-card/model';
import { holdMedia, isHoldableMediaType, OFFLINE_VIDEO_REFUSAL } from '@/lib/pwa/pending-media';
import { raiseChangeRequest, resolveChangeRequest } from './change-request-operations';
import {
  acceptJob,
  addLabour,
  addMedia,
  captureSignature,
  saveCompletionReport,
  setMediaVisibility,
  startCompletion,
  startSignature,
  submitJobCard,
} from './job-operations';
import { updateMachine } from './machine-operations';
import { buildHarness, jpegFixture, seedUser, type Harness } from './test-harness';

/**
 * THE DECISIONS THE OWNER APPROVED ON 27 OCTOBER 2026 THAT NEEDED NO NEW
 * FEATURE — proved here, so "it already behaves that way" is a test result and
 * not an assertion. BD-23 and BD-27 have their own files
 * (`offline-signature.test.ts`, `job-corrections.test.ts`); the rest are
 * proved where the behaviour lives, listed in docs/SCOPE.md.
 */

const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');

/** A minimal MP4 header: what the upload route sniffs as video. */
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const inProgress = async (): Promise<Job> => {
  const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
  return acceptJob(harness.as(technician), opened!);
};

/**
 * A video recorded before VIDEO-OFF-1 (27 October 2026). No new video can be
 * added, so the historical case is seeded straight into the repository.
 */
const withHistoricalVideo = async (job: Job): Promise<Job> =>
  harness.repos.jobs.save({
    ...job,
    videos: [
      {
        id: 'att-historical-video',
        kind: 'video',
        visibility: 'internal',
        fileName: 'vibration.mp4',
        caption: 'Spindle vibration',
        storageKey: 'uploads/vibration.mp4',
        uploadedAt: '2026-10-20T08:00:00.000Z',
        uploadedBy: technician.id,
        sizeBytes: MP4.length,
        checksumSha256: null,
        provenance: 'genuine',
      } as unknown as Job['videos'][number],
    ],
  });

describe('VIDEO-OFF-1 — no new video, on any path; historical videos kept', () => {
  it('refuses a new video in the operation itself', async () => {
    await expect(
      addMedia(harness.as(technician), await inProgress(), {
        kind: 'video',
        fileName: 'vibration.mp4',
        caption: '',
        contentType: 'video/mp4',
        bytes: MP4,
      }),
    ).rejects.toMatchObject({ violations: [{ code: 'video_not_supported' }] });
  });

  it('keeps a historical video on the job, internal and unchanged', async () => {
    const job = await withHistoricalVideo(await inProgress());
    const reloaded = (await harness.repos.jobs.findByJobNumber(job.jobNumber))!;
    expect(reloaded.videos.map((video) => [video.fileName, video.visibility])).toEqual([['vibration.mp4', 'internal']]);
  });
});

describe('BD-26 — a video is internal and never reaches the customer', () => {
  it('a historical video cannot be reclassified as customer-facing', async () => {
    const job = await withHistoricalVideo(await inProgress());
    await expect(
      setMediaVisibility(harness.as(technician), job, 'att-historical-video', 'customer_facing'),
    ).rejects.toMatchObject({ violations: [{ code: 'video_internal_only' }] });
  });

  it('a historical video is never on the customer’s job card nor attached to their email', async () => {
    const tech = harness.as(technician);
    let job = await withHistoricalVideo(await inProgress());
    job = await addMedia(tech, job, {
      kind: 'photo',
      fileName: 'fan.jpg',
      caption: 'New fan',
      contentType: 'image/jpeg',
      bytes: jpegFixture('fan'),
    });
    job = await saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Replaced the fan.' });
    job = await addLabour(tech, job, { date: '2026-10-27', rateType: 'normal', hours: 1, description: '' });
    job = await startCompletion(tech, job);
    job = await startSignature(tech, job);
    job = await captureSignature(tech, job, { customerName: 'A', customerSurname: 'B', strokeData: 'M0 0 L1 1' });

    expect(documentPhotos(job).map((photo) => photo.fileName)).toEqual(['fan.jpg']);

    await harness.outbox.clear();
    await submitJobCard(tech, job, 'pieter@abc-engineering-demo.co.za', 'Pieter Nel');
    const sent = await harness.outbox.list();
    const attachments = sent.flatMap((entry) => ('attachments' in entry ? [...(entry.attachments as readonly string[])] : []));
    expect(attachments.length).toBeGreaterThan(0);
    for (const name of attachments) {
      expect(name).not.toMatch(/\.(mp4|webm|mov)$/iu);
      expect(name).not.toContain('vibration');
    }
  });
});

describe('BD-28 — an approved change request does not move a machine; the office does', () => {
  it('leaves the machine where it stands when a report about it is applied', async () => {
    const customerId = asCustomerId('cust-abc');
    const machine = (await harness.repos.machines.list()).find((candidate) => candidate.customerId === customerId)!;
    const raised = await raiseChangeRequest(harness.as(technician), {
      subject: 'machine',
      customerId,
      machineId: machine.id,
      details: 'This machine has been moved to the Pretoria site.',
    });
    await resolveChangeRequest(harness.as(master), raised.id, {
      outcome: 'applied',
      note: 'Office will move it on the register after confirming with the customer.',
    });

    const after = await harness.repos.machines.findById(machine.id);
    expect(after?.siteId).toBe(machine.siteId);
    expect(await harness.repos.machines.listMovements(machine.id)).toHaveLength(0);
  });

  it('refuses a technician moving a machine on the register', async () => {
    const machine = (await harness.repos.machines.list())[0]!;
    await expect(updateMachine(harness.as(technician), { ...machine, siteId: machine.siteId })).rejects.toMatchObject(
      { violations: [{ code: 'not_permitted' }] },
    );
  });
});

describe('BD-30 — a video is not held for later upload, and the technician is told why', () => {
  it('refuses a video in the device store itself, with the reason', async () => {
    const outcome = await holdMedia({
      userId: technician.id,
      jobId: 'job-1',
      jobNumber: 'EJE-1048',
      destination: { kind: 'job' } as never,
      file: new File([MP4], 'clip.mp4', { type: 'video/mp4' }),
      caption: '',
      idempotencyKey: 'k',
    });
    expect(outcome).toEqual({ held: false, reason: OFFLINE_VIDEO_REFUSAL });
    expect(OFFLINE_VIDEO_REFUSAL).toMatch(/video cannot be kept/iu);
  });

  it('holds photographs and only photographs', () => {
    expect(isHoldableMediaType('image/jpeg')).toBe(true);
    expect(isHoldableMediaType('video/mp4')).toBe(false);
    expect(isHoldableMediaType('video/webm')).toBe(false);
  });
});
