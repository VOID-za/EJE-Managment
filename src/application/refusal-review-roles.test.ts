import { beforeEach, describe, expect, it } from 'vitest';
import { canEditJobRecord, canTransition, type Job } from '@/domain';
import {
  acceptJob,
  addLabour,
  addNote,
  captureSignature,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  returnToCustomerSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
  updateLabour,
} from './job-operations';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * WHO OWNS A REFUSED JOB CARD, AND HOW IT ENDS. MASTER SCOPE REF-7, REF-8, REF-11.
 *
 * Three defects found in VPS acceptance testing, all in this one workflow:
 *
 *  1. The technician kept edit rights and was offered the way back into a job
 *     they had already handed over.
 *  2. Returning it for signature produced "cannot move from customer_signature
 *     to customer_signature" — the seeded refusal sat in a state the operation
 *     never produces.
 *  3. "Without Customer Signature" recorded the outcome and moved nothing, so
 *     the job carried on showing Review, Closed and a Capture Signature button.
 *
 * Each has a case here, and the illegal transitions are asserted directly
 * rather than inferred from an operation refusing.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const refusedJob = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  const tech = harness.as(technician);
  let job = await acceptJob(tech, view!.job);
  job = await addLabour(tech, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 3,
    description: 'Spindle drive repair',
  });
  job = await saveCompletionReport(tech, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await startCompletion(tech, job);
  job = await startSignature(tech, job);
  return recordSignatureRefusal(tech, job, {
    reason: 'The planner disputes the hours and will not sign.',
  });
};

describe('the technician, after recording the refusal', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    refused = await refusedJob(harness);
  });

  it('submitted it successfully, and it is with the office', () => {
    expect(refused.status).toBe('review');
    expect(refused.signature).toBeNull();
    expect(refused.signatureRefusals).toHaveLength(1);
  });

  it('can still READ it — the refusal information is theirs to see', async () => {
    const view = await loadJobView(harness.repos, refused.jobNumber);
    expect(view?.job.jobNumber).toBe(refused.jobNumber);
    expect(view?.job.signatureRefusals[0]?.reason).toContain('disputes the hours');
  });

  it('is READ-ONLY: no edit', async () => {
    expect(canEditJobRecord('technician', refused)).toBe(false);
    await expect(
      addNote(harness.as(technician), refused, 'Trying to edit.', false),
    ).rejects.toBeInstanceOf(WorkflowError);
    await expect(
      updateLabour(harness.as(technician), refused, refused.labour[0]!.id, {
        date: '2026-09-17',
        rateType: 'double',
        hours: 9,
        description: 'Trying to change the hours',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('cannot return it for signature', async () => {
    await expect(
      returnToCustomerSignature(harness.as(technician), refused, 'Let me try again.'),
    ).rejects.toThrow(/cannot be returned for signature by you/i);
  });

  it('cannot resolve the refusal — neither outcome is theirs', async () => {
    await expect(
      resolveSignatureRefusal(harness.as(technician), refused, 'Close it.'),
    ).rejects.toThrow(/cannot be resolved by you/i);
  });

  it('cannot capture another signature on it', async () => {
    await expect(
      captureSignature(harness.as(technician), refused, {
        customerName: 'Somebody',
        customerSurname: 'Else',
        strokeData: 'M0,0 L1,1',
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe('OUTCOME A — Customer Signature', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    refused = await refusedJob(harness);
  });

  it('is review -> customer_signature, not customer_signature -> itself', async () => {
    expect(canTransition('review', 'customer_signature')).toBe(true);
    expect(canTransition('customer_signature', 'customer_signature')).toBe(false);

    const returned = await returnToCustomerSignature(
      harness.as(master),
      refused,
      'Hours confirmed against the order.',
    );
    expect(returned.status).toBe('customer_signature');
  });

  it('is open to the COORDINATOR as well as the Master', async () => {
    const returned = await returnToCustomerSignature(
      harness.as(coordinator),
      refused,
      'Confirmed with the planner.',
    );
    expect(returned.status).toBe('customer_signature');
  });

  it('refuses a job that is not in office review, and says why', async () => {
    /*
     * THE ACCEPTANCE-TEST FAILURE, REPRODUCED. The seeded EJE-2018 sat at
     * `customer_signature` with an outstanding refusal — a state
     * `recordSignatureRefusal` never produces — and returning it for signature
     * asked the state machine to move it from `customer_signature` to
     * `customer_signature`. The generic transition error named two identical
     * statuses and explained nothing.
     *
     * Built through the repository, the way the bad fixture did, because no
     * operation can produce it.
     */
    const stuck = await harness.repos.jobs.save({ ...refused, status: 'customer_signature' });

    await expect(
      returnToCustomerSignature(harness.as(master), stuck, ''),
    ).rejects.toThrow(/not in office review/i);
  });

  it('proceeds through the normal flow once the customer signs', async () => {
    const returned = await returnToCustomerSignature(harness.as(master), refused, '');
    const signed = await captureSignature(harness.as(technician), returned, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0,0 L1,1',
    });

    expect(signed.status).toBe('review');
    expect(signed.signature).not.toBeNull();
    // And it is now final: the signature rule takes over.
    expect(canEditJobRecord('master', signed)).toBe(false);
  });
});

describe('OUTCOME B — Without Customer Signature', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    refused = await refusedJob(harness);
  });

  it('closes the job immediately', async () => {
    const closed = await resolveSignatureRefusal(harness.as(master), refused, 'Invoice to proceed.');
    expect(closed.status).toBe('closed');
    expect(closed.closedAt).not.toBeNull();
  });

  it('is open to the COORDINATOR as well as the Master', async () => {
    const closed = await resolveSignatureRefusal(harness.as(coordinator), refused, '');
    expect(closed.status).toBe('closed');
  });

  it('leaves NO signature step, NO review step and nothing editable', async () => {
    const closed = await resolveSignatureRefusal(harness.as(master), refused, '');

    expect(canTransition(closed.status, 'customer_signature')).toBe(false);
    expect(canTransition(closed.status, 'review')).toBe(false);
    expect(canTransition(closed.status, 'completion')).toBe(false);
    expect(canTransition(closed.status, 'awaiting_delivery')).toBe(false);

    for (const role of ['master', 'coordinator', 'technician'] as const) {
      expect(canEditJobRecord(role, closed), role).toBe(false);
    }
  });

  it('cannot be returned for signature afterwards, by anyone', async () => {
    const closed = await resolveSignatureRefusal(harness.as(master), refused, '');
    for (const who of [master, coordinator, technician]) {
      await expect(
        returnToCustomerSignature(harness.as(who), closed, 'Reopen it.'),
      ).rejects.toBeInstanceOf(WorkflowError);
    }
  });

  it('cannot have a signature captured afterwards, by anyone', async () => {
    const closed = await resolveSignatureRefusal(harness.as(master), refused, '');
    for (const who of [master, coordinator, technician]) {
      await expect(
        captureSignature(harness.as(who), closed, {
          customerName: 'Pieter',
          customerSurname: 'Nel',
          strokeData: 'M0,0 L1,1',
        }),
      ).rejects.toBeInstanceOf(WorkflowError);
    }
  });

  it('records the refusal, the resolution and the closure on the trail', async () => {
    const closed = await resolveSignatureRefusal(harness.as(master), refused, 'Invoice to proceed.');
    const trail = await harness.repos.activity.list(closed.id);
    const types = trail.map((entry) => entry.type);

    expect(types).toContain('customer_refused_to_sign');
    expect(types).toContain('signature_refusal_resolved');
    expect(types).toContain('job_closed');
  });
});
