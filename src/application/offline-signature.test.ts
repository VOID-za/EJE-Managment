import { beforeEach, describe, expect, it } from 'vitest';
import type { Job, User } from '@/domain';
import { documentIdentityFor } from '@/lib/job-card/document-identity';
import {
  acceptJob,
  addLabour,
  captureSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { acceptOfflineSignature, type HeldSignatureInput, type HeldRefusalInput } from './offline-signature';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * BD-23 — A SIGNATURE OR REFUSAL TAKEN WITH NO SIGNAL. Approved by the owner on
 * 27 October 2026.
 *
 * The contract, case by case: accepted only when the server's own
 * recomputation of the document equals the identity the tablet recorded;
 * otherwise nothing on the job changes and the evidence is kept as a referral
 * for the office. A failed check is never an acceptance, a replay never a
 * second write, and no signature is ever moved onto a different document.
 */

const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const readyToSign = async (): Promise<Job> => {
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
  return startSignature(context, job);
};

/** What the technician's tablet would compute from the view it was given. */
const identityShownTo = async (viewer: User, jobNumber = 'EJE-1048'): Promise<string> => {
  const view = await loadJobView(harness.repos, jobNumber, viewer);
  return documentIdentityFor({
    job: view!.job,
    customer: view!.customer,
    site: view!.site,
    contact: view!.contact,
    machine: view!.machine,
    settings: view!.settings,
    checklistTemplate: view!.checklistTemplate,
    users: view!.users,
  });
};

const held = (documentIdentity: string, overrides: Partial<HeldSignatureInput> = {}): HeldSignatureInput => ({
  captureId: '7b0c1a52-58e4-4f7e-9d0a-1c2b3d4e5f60',
  documentIdentity,
  pdfSha256: 'a'.repeat(64),
  capturedAt: '2026-10-27T09:15:00.000+02:00',
  customerName: 'Thandi',
  customerSurname: 'Mokoena',
  strokeData: 'M10 10 L40 40 L80 20',
  ...overrides,
});

const heldRefusal = (documentIdentity: string): HeldRefusalInput => ({
  captureId: '9c1d2b63-69f5-4a8f-8e1b-2d3c4e5f6a71',
  documentIdentity,
  pdfSha256: null,
  capturedAt: '2026-10-27T09:20:00.000+02:00',
  reason: 'The plant manager will not sign until the invoice is checked.',
});

const reload = async (): Promise<Job> => (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;

describe('a signature held offline, verified on arrival', () => {
  it('is accepted through the ordinary signature when the document is identical, with the evidence audited', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);

    const result = await acceptOfflineSignature(harness.as(technician), job, 'signature', held(identity));

    expect(result.outcome).toBe('accepted');
    const saved = await reload();
    expect(saved.status).toBe('review');
    expect(saved.signature?.customerName).toBe('Thandi');
    expect(saved.signature?.strokeData).toBe('M10 10 L40 40 L80 20');
    // The ordinary signature froze the rates, exactly as online.
    expect(saved.pricingSnapshot?.reason).toBe('customer_signature');

    const trail = await harness.repos.activity.list(job.id);
    const signed = trail.find((event) => event.type === 'customer_signed');
    expect(signed?.detail).toContain(identity);
    expect(signed?.detail).toContain('with no signal');
    expect(signed?.detail).toContain('identical');
    expect(await harness.repos.captureReferrals.list()).toHaveLength(0);
  });

  it('is NOT accepted when the document changed after it was shown — nothing on the job changes and the evidence is referred', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);
    // The office changes something printed on the job card meanwhile.
    const changed = await harness.repos.jobs.save({ ...job, orderNumber: 'PO-CHANGED-77' });

    const result = await acceptOfflineSignature(harness.as(technician), changed, 'signature', held(identity));

    expect(result.outcome).toBe('referred');
    if (result.outcome !== 'referred') return;
    expect(result.reason).toBe('document_changed');

    const saved = await reload();
    expect(saved.signature).toBeNull();
    expect(saved.status).toBe('customer_signature');
    expect(saved.pricingSnapshot).toBeNull();

    const referrals = await harness.repos.captureReferrals.list();
    expect(referrals).toHaveLength(1);
    expect(referrals[0]?.action).toBe('capture_signature_offline');
    expect(referrals[0]?.refusalCode).toBe('document_changed');
    expect(referrals[0]?.state).toBe('open');
    // The evidence itself is kept, not just a note that it existed.
    expect(referrals[0]?.payload.strokeData).toBe('M10 10 L40 40 L80 20');
    expect(referrals[0]?.payload.documentIdentity).toBe(identity);
    expect(referrals[0]?.technicianId).toBe(technician.id);

    const trail = await harness.repos.activity.list(job.id);
    expect(trail.some((event) => event.type === 'capture_referred')).toBe(true);
    expect(trail.some((event) => event.type === 'customer_signed')).toBe(false);
  });

  it('is NOT accepted when a rate changed, because the figures the customer saw are part of the document', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);
    const settings = await harness.repos.settings.get();
    await harness.repos.settings.save({
      ...settings,
      labourRates: { ...settings.labourRates, normal: settings.labourRates.normal + 10_000 },
    });

    const result = await acceptOfflineSignature(harness.as(technician), job, 'signature', held(identity));
    expect(result.outcome).toBe('referred');
    expect((await reload()).signature).toBeNull();
  });

  it('refers an identity it cannot verify (an unknown version) rather than comparing it', async () => {
    const job = await readyToSign();
    const result = await acceptOfflineSignature(
      harness.as(technician),
      job,
      'signature',
      held(`jcm0:${'b'.repeat(64)}`),
    );
    expect(result.outcome).toBe('referred');
    if (result.outcome === 'referred') expect(result.reason).toBe('document_unverifiable');
    expect((await reload()).signature).toBeNull();
  });

  it('answers a replay of an accepted capture as accepted, with no second write', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);
    await acceptOfflineSignature(harness.as(technician), job, 'signature', held(identity));
    const before = (await harness.repos.activity.list(job.id)).length;

    // The answer was lost; the tablet sends it again against the job as it is now.
    const again = await acceptOfflineSignature(harness.as(technician), await reload(), 'signature', held(identity));

    expect(again.outcome).toBe('accepted');
    expect((await harness.repos.activity.list(job.id)).length).toBe(before);
    expect(await harness.repos.captureReferrals.list()).toHaveLength(0);
  });

  it('keeps ONE referral for one capture sent twice', async () => {
    const job = await readyToSign();
    const changed = await harness.repos.jobs.save({ ...job, orderNumber: 'PO-CHANGED-78' });
    const stale = held(`jcm1:${'c'.repeat(64)}`);
    await acceptOfflineSignature(harness.as(technician), changed, 'signature', stale);
    await acceptOfflineSignature(harness.as(technician), await reload(), 'signature', stale);
    expect(await harness.repos.captureReferrals.list()).toHaveLength(1);
  });

  it('does not overwrite a signature taken online meanwhile; the held one is referred', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);
    await captureSignature(harness.as(technician), job, {
      customerName: 'Pieter',
      customerSurname: 'Botha',
      strokeData: 'M1 1 L2 2',
    });

    const result = await acceptOfflineSignature(harness.as(technician), await reload(), 'signature', held(identity));

    expect(result.outcome).toBe('referred');
    if (result.outcome === 'referred') expect(result.reason).toBe('already_signed');
    expect((await reload()).signature?.customerName).toBe('Pieter');
  });

  it('refers a capture for a job that is no longer at Customer Signature', async () => {
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
    const job = await acceptJob(harness.as(technician), opened!);
    const result = await acceptOfflineSignature(
      harness.as(technician),
      job,
      'signature',
      held(`jcm1:${'d'.repeat(64)}`),
    );
    expect(result.outcome).toBe('referred');
    if (result.outcome === 'referred') expect(result.reason).toBe('job_moved_on');
    expect((await reload()).status).toBe('in_progress');
  });

  it('is refused outright for somebody who is not a technician on the job — the office cannot present one', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);
    await expect(
      acceptOfflineSignature(harness.as(master), job, 'signature', held(identity)),
    ).rejects.toMatchObject({ violations: [{ code: 'not_on_job' }] });
    expect((await reload()).signature).toBeNull();
  });
});

describe('a refusal held offline, verified on arrival', () => {
  it('is accepted through the ordinary refusal when the document is identical, and the office is told', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);

    const result = await acceptOfflineSignature(harness.as(technician), job, 'refusal', heldRefusal(identity));

    expect(result.outcome).toBe('accepted');
    const saved = await reload();
    expect(saved.status).toBe('review');
    expect(saved.signature).toBeNull();
    expect(saved.signatureRefusals).toHaveLength(1);
    expect(saved.signatureRefusals[0]?.reason).toContain('invoice is checked');

    const trail = await harness.repos.activity.list(job.id);
    expect(trail.find((event) => event.type === 'customer_refused_to_sign')?.detail).toContain(identity);
    const told = await harness.repos.notifications.list(master.id);
    expect(told.some((note) => note.type === 'signature_refused' && note.jobId === job.id)).toBe(true);
  });

  it('answers a replayed refusal as accepted without recording a second attempt', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);
    await acceptOfflineSignature(harness.as(technician), job, 'refusal', heldRefusal(identity));
    const again = await acceptOfflineSignature(harness.as(technician), await reload(), 'refusal', heldRefusal(identity));
    expect(again.outcome).toBe('accepted');
    expect((await reload()).signatureRefusals).toHaveLength(1);
  });

  it('is NOT accepted against a changed document; no refusal is recorded and the evidence is referred', async () => {
    const job = await readyToSign();
    const identity = await identityShownTo(technician);
    const changed = await harness.repos.jobs.save({ ...job, referenceNumber: 'REF-CHANGED' });

    const result = await acceptOfflineSignature(harness.as(technician), changed, 'refusal', heldRefusal(identity));

    expect(result.outcome).toBe('referred');
    const saved = await reload();
    expect(saved.signatureRefusals).toHaveLength(0);
    expect(saved.status).toBe('customer_signature');
    const [referral] = await harness.repos.captureReferrals.list();
    expect(referral?.action).toBe('record_refusal_offline');
    expect(referral?.payload.reason).toContain('invoice is checked');
  });

  it('is refused on a job type with no refusal workflow, as the online refusal is', async () => {
    const job = await readyToSign();
    const parts = await harness.repos.jobs.save({ ...job, jobType: 'parts' });
    await expect(
      acceptOfflineSignature(harness.as(technician), parts, 'refusal', heldRefusal(`jcm1:${'e'.repeat(64)}`)),
    ).rejects.toMatchObject({ violations: [{ code: 'not_applicable_to_job_type' }] });
  });
});
