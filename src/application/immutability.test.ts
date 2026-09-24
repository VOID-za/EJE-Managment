import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  addLabour,
  addNote,
  addPart,
  captureSignature,
  issueJobCard,
  removeLineItem,
  saveCompletionReport,
  setCalloutApplied,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadFinalDocumentFile } from './final-document';
import { WorkflowError } from './errors';
import { buildHarness, confirmDelivery, seedUser, type Harness } from './test-harness';
import type { Job } from '@/domain';

/**
 * A job card the customer holds is final.
 *
 * The document has left the building the moment it is issued, so from that
 * point the record has to keep matching it. This is what stops the system
 * quietly disagreeing with a piece of paper somebody signed.
 */

const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');

const issue = async (harness: Harness): Promise<Job> => {
  const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');
  const context = harness.as(technician);

  let job = await acceptJob(context, opened!);
  job = await addLabour(context, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 2,
    description: 'Repair',
  });
  job = await saveCompletionReport(context, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await startCompletion(context, job);
  job = await startSignature(context, job);
  const signed = await captureSignature(context, job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });

  /*
   * The Master issues it. MASTER SCOPE §3.1/§7/§15: the technician's authority
   * ends at the signature; `jobs.issueFinal` is the Master's alone.
   */
  const result = await issueJobCard(
    harness.as(master),
    signed,
    'customer@example-demo.co.za',
    'Pieter Nel',
  );
  return result.job;
};

describe('a job whose card has been issued', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is locked the moment it is issued, before delivery is even confirmed', async () => {
    const issued = await issue(harness);
    expect(issued.status).toBe('awaiting_delivery');

    // Not a Master, not the Coordinator, not the technician who did the work.
    for (const actor of [technician, master, coordinator]) {
      await expect(
        addLabour(harness.as(actor), issued, {
          date: '2026-09-18',
          rateType: 'normal',
          hours: 1,
          description: 'An afterthought',
        }),
      ).rejects.toBeInstanceOf(WorkflowError);
    }
  });

  it('stays locked once it is closed', async () => {
    const issued = await issue(harness);
    harness.outbox.setDelivery(issued.delivery!.messageId, 'delivered');
    const closed = await confirmDelivery(harness, harness.as(technician), issued);
    expect(closed.status).toBe('closed');

    await expect(
      addPart(harness.as(master), closed, {
        partNumber: 'X',
        description: 'X',
        quantity: 1,
        unitPrice: 100,
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      setCalloutApplied(harness.as(master), closed, !closed.calloutApplied),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      removeLineItem(harness.as(master), closed, 'labour', closed.labour[0]!.id),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      addNote(harness.as(master), closed, 'One more thing', false),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('keeps handing back the same bytes that were issued', async () => {
    const issued = await issue(harness);
    harness.outbox.setDelivery(issued.delivery!.messageId, 'delivered');
    const closed = await confirmDelivery(harness, harness.as(technician), issued);

    const first = await loadFinalDocumentFile(harness.as(master), closed.jobNumber);
    const second = await loadFinalDocumentFile(harness.as(coordinator), closed.jobNumber);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.bytes.byteLength).toBe(first!.bytes.byteLength);
    expect(Array.from(second!.bytes.slice(0, 64))).toEqual(
      Array.from(first!.bytes.slice(0, 64)),
    );
  });

  it('keeps the pricing it was signed at when the rates change afterwards', async () => {
    const issued = await issue(harness);
    harness.outbox.setDelivery(issued.delivery!.messageId, 'delivered');
    const closed = await confirmDelivery(harness, harness.as(technician), issued);
    const frozen = closed.pricingSnapshot;
    expect(frozen).not.toBeNull();

    await harness.repos.settings.save({
      ...(await harness.repos.settings.get()),
      labourRates: { normal: 999999, overtime: 999999, double: 999999 },
      vatPercentage: 25,
    });

    const reread = await harness.repos.jobs.findByJobNumber(closed.jobNumber);
    expect(reread!.pricingSnapshot).toEqual(frozen);
  });
});
