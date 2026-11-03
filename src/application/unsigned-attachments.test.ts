import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  attachDocument,
  captureSignature,
  issueJobCard,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  saveCompletionReport,
  setCustomerEmailDocument,
  startCompletion,
  startSignature,
} from './job-operations';
import {
  authoriseUnsignedDelivery,
  findUnsignedDeliveryAuthorisation,
  retryUnsignedDelivery,
} from './unsigned-delivery';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { WorkflowError } from './errors';
import { EMAIL_ATTACHMENTS_MAX_BYTES, canChooseUnsignedCopyDocuments, type Job } from '@/domain';

/**
 * THE UNSIGNED JOB CARD CARRIES THE CHOSEN DOCUMENTS TOO. UNSIGNED-ATT-1 (3 November 2026).
 *
 * The signed job card email has carried the documents the office chose on the
 * job since JOB-ATT-3. A job card issued WITHOUT a signature, sent only when a
 * Senior Tech authorises it (BD-06), carried the PDF alone. It now carries the
 * same documents under the same rules: a selected document that is missing,
 * changed, invalid or too large refuses the send with the reason — never a
 * send without it. Simulated email only.
 */
const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const REASON = 'The customer asked for a copy for their insurer.';
const PDF = (body: string) => new TextEncoder().encode(`%PDF-1.4\n${body}\n%%EOF`);

let harness: Harness;
beforeEach(() => {
  harness = buildHarness();
});

const emails = () => harness.outbox.listSync().filter((entry) => entry.channel === 'email');

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof WorkflowError) return cause.violations[0]?.code ?? 'workflow_error';
    throw cause;
  }
  throw new Error('expected the operation to be refused');
};

/** A job with one document chosen for the customer, issued WITHOUT a signature. */
const issuedUnsigned = async (bytes: Uint8Array = PDF('order'), fileName = 'Order.pdf'): Promise<Job> => {
  const tech = harness.as(technician);
  let job = await acceptJob(tech, (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);
  job = await attachDocument(tech, job, { fileName, contentType: 'application/pdf', bytes, caption: '' });
  const chosen = job.attachments[job.attachments.length - 1]!;
  job = await setCustomerEmailDocument(tech, job, chosen.id, true);
  job = await addLabour(tech, job, { date: '2026-09-17', rateType: 'normal', hours: 3, description: 'Spindle drive repair' });
  job = await saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Replaced the fan.' });
  job = await startCompletion(tech, job);
  job = await startSignature(tech, job);
  const refused = await recordSignatureRefusal(tech, job, { reason: 'The customer would not sign.' });
  return resolveSignatureRefusal(harness.as(master), refused, 'Issued without a signature.');
};

const chosenOf = (job: Job) => job.attachments.find((attachment) => attachment.emailToCustomer === true)!;

describe('UNSIGNED-ATT-1: the unsigned copy carries the chosen documents', () => {
  it('sends the unsigned PDF AND every chosen document — the files, not links', async () => {
    const job = await issuedUnsigned();
    expect(job.signature).toBeNull();
    const result = await authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON });
    expect(result.delivery.state).not.toBe('failed');
    const sent = emails();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.attachments).toEqual([job.finalDocument!.fileName, 'Order.pdf']);
    expect(sent[0]?.subject).toMatch(/issued without signature/iu);
    expect(sent[0]?.body).toContain('with: Order.pdf');
    const trail = await harness.repos.activity.list(job.id);
    expect(trail.some((event) => event.detail.includes(`${job.finalDocument!.fileName}, Order.pdf`))).toBe(true);
  });

  it('still sends the PDF alone when nothing is chosen', async () => {
    let job = await issuedUnsigned();
    job = await setCustomerEmailDocument(harness.as(master), job, chosenOf(job).id, false);
    await authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON });
    expect(emails()[0]?.attachments).toEqual([job.finalDocument!.fileName]);
  });

  it('a Senior Tech may change the choice after issue, until the copy has gone; nobody else may', async () => {
    const job = await issuedUnsigned();
    expect(canChooseUnsignedCopyDocuments('master', job)).toBe(true);
    expect(canChooseUnsignedCopyDocuments('coordinator', job)).toBe(false);
    expect(await codeOf(setCustomerEmailDocument(harness.as(coordinator), job, chosenOf(job).id, false))).toBe('job_finalized');
    expect(await codeOf(setCustomerEmailDocument(harness.as(technician), job, chosenOf(job).id, false))).toBe('job_finalized');
    const sent = await authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON });
    expect(canChooseUnsignedCopyDocuments('master', sent.job)).toBe(false);
    expect(await codeOf(setCustomerEmailDocument(harness.as(master), sent.job, chosenOf(sent.job).id, false))).toBe('job_finalized');
  });

  it('REFUSES — nothing authorised, nothing sent — when a chosen file is missing', async () => {
    const job = await issuedUnsigned();
    await harness.services.storage.remove(chosenOf(job).storageKey);
    const refusal = authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON });
    await expect(refusal).rejects.toThrow(/was not sent to the customer/iu);
    expect(await codeOf(authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON }))).toBe('attachment_missing');
    expect(emails()).toHaveLength(0);
    expect(await findUnsignedDeliveryAuthorisation(harness.as(master), job)).toBeNull();
  });

  it('REFUSES when a chosen file has changed since it was chosen', async () => {
    const job = await issuedUnsigned();
    const chosen = chosenOf(job);
    await harness.services.storage.putDocument({ storageKey: chosen.storageKey, fileName: chosen.fileName, contentType: 'application/pdf', bytes: PDF('a different order') });
    try {
      await authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON });
      throw new Error('expected a refusal');
    } catch (cause) {
      expect(cause).toBeInstanceOf(WorkflowError);
      expect((cause as WorkflowError).violations[0]).toMatchObject({ code: 'attachment_changed' });
      expect((cause as WorkflowError).violations[0]?.message).toContain('Order.pdf');
    }
    expect(emails()).toHaveLength(0);
  });

  it('REFUSES when a chosen file is no longer a document a job may carry', async () => {
    const job = await issuedUnsigned();
    const chosen = chosenOf(job);
    const stored = (await harness.services.storage.getDocument(chosen.storageKey))!;
    // The same bytes, now recorded as a video — refused by the upload rule, not sent.
    await harness.services.storage.putDocument({ ...stored, contentType: 'video/mp4' });
    expect(await codeOf(authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON }))).toBe('attachment_invalid');
    expect(emails()).toHaveLength(0);
  });

  it('REFUSES over the provider limit, says so, and sends once the choice is narrowed', async () => {
    const big = new Uint8Array(EMAIL_ATTACHMENTS_MAX_BYTES + 10).fill(0x20);
    big.set(new TextEncoder().encode('%PDF-1.4\n'));
    let job = await issuedUnsigned(big, 'Huge drawing.pdf');
    try {
      await authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON });
      throw new Error('expected a refusal');
    } catch (cause) {
      expect((cause as WorkflowError).violations[0]).toMatchObject({ code: 'attachment_too_large' });
      expect((cause as WorkflowError).violations[0]?.message).toMatch(/at most 3\.0 MB/u);
    }
    expect(emails()).toHaveLength(0);
    job = await setCustomerEmailDocument(harness.as(master), job, chosenOf(job).id, false);
    await authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON });
    expect(emails()[0]?.attachments).toEqual([job.finalDocument!.fileName]);
  });

  it('a retry is held to the same checks: a file gone since the failed attempt refuses it', async () => {
    const job = await issuedUnsigned();
    await authoriseUnsignedDelivery(harness.as(master), job, { reason: REASON });
    const reread = (await harness.repos.jobs.findByJobNumber('EJE-1048'))!;
    const failed: Job = { ...reread, delivery: { ...reread.delivery!, state: 'failed', failureReason: 'Provider down.' } };
    await harness.repos.jobs.save(failed);
    await harness.services.storage.remove(chosenOf(failed).storageKey);
    expect(await codeOf(retryUnsignedDelivery(harness.as(master), failed))).toBe('attachment_missing');
    expect(emails()).toHaveLength(1);
  });

  it('leaves the SIGNED job card email as it was: PDF and chosen documents', async () => {
    const tech = harness.as(technician);
    let job = await acceptJob(tech, (await harness.repos.jobs.findByJobNumber('EJE-1048'))!);
    job = await attachDocument(tech, job, { fileName: 'Order.pdf', contentType: 'application/pdf', bytes: PDF('order'), caption: '' });
    job = await setCustomerEmailDocument(tech, job, job.attachments[job.attachments.length - 1]!.id, true);
    job = await addLabour(tech, job, { date: '2026-09-17', rateType: 'normal', hours: 3, description: 'Repair' });
    job = await saveCompletionReport(tech, job, { ...job.completionReport, workPerformed: 'Replaced the fan.' });
    job = await startCompletion(tech, job);
    job = await startSignature(tech, job);
    job = await captureSignature(tech, job, { customerName: 'Pieter', customerSurname: 'Nel', strokeData: 'M0,0 L1,1' });
    const issued = await issueJobCard(tech, job, 'pieter@abc-engineering.example', 'Pieter Nel');
    expect(canChooseUnsignedCopyDocuments('master', issued.job)).toBe(false);
    const sent = emails();
    expect(sent[sent.length - 1]?.attachments).toEqual([issued.job.finalDocument!.fileName, 'Order.pdf']);
    expect(await codeOf(authoriseUnsignedDelivery(harness.as(master), issued.job, { reason: REASON }))).toBe('already_signed');
  });
});
