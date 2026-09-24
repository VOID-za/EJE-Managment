import { beforeEach, describe, expect, it } from 'vitest';
import { canEditJobRecord, isFinalized, type Job } from '@/domain';
import {
  acceptJob,
  addLabour,
  addNote,
  addPart,
  captureSignature,
  recordSignatureRefusal,
  removeLineItem,
  returnToCustomerSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
  updateLabour,
} from './job-operations';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * A CUSTOMER-SIGNED JOB CARD IS LEGALLY FINAL. MASTER SCOPE CR-01 / IMMUT-1…7.
 *
 * "Once a customer has signed: NOTHING on the signed job card may be edited. A
 * Master may NOT reopen the signed job for editing. A Coordinator may NOT
 * reopen it. A Technician may NOT reopen it."
 *
 * EVERY ONE OF THESE CASES USED TO PASS THE OTHER WAY. The audit at `d979aa9`
 * ran them as probes against the real operations and all of them succeeded: a
 * Master added labour to a signed job, a Coordinator added a part at any price,
 * the technician amended their own, a signed labour line was DELETED and the
 * signed write-up was rewritten. Each was recorded on the audit trail, which
 * was the old requirement working correctly — and is exactly what the business
 * has now ruled out.
 *
 * THE OTHER HALF MATTERS JUST AS MUCH. A refusal is NOT a finalization: the
 * office must still be able to correct an unsigned job card and resubmit it.
 * Both land in `review`, so a rule written against the status would break the
 * refusal workflow. The second block below holds that it does not.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

/** EJE-1048 worked to the point the customer is asked to sign. */
const workToSignature = async (harness: Harness): Promise<Job> => {
  const view = await loadJobView(harness.repos, 'EJE-1048');
  const tech = harness.as(technician);
  let job = await acceptJob(tech, view!.job);
  job = await addLabour(tech, job, {
    date: '2026-09-17',
    rateType: 'normal',
    hours: 3,
    description: 'Spindle drive repair',
  });
  job = await addPart(tech, job, {
    partNumber: 'FAN-24V-80',
    description: 'Cooling fan',
    quantity: 1,
    unitPrice: 48500,
  });
  job = await saveCompletionReport(tech, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await startCompletion(tech, job);
  return startSignature(tech, job);
};

const sign = (harness: Harness, job: Job): Promise<Job> =>
  captureSignature(harness.as(technician), job, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });

describe('once the customer has signed', () => {
  let harness: Harness;
  let signed: Job;

  beforeEach(async () => {
    harness = buildHarness();
    signed = await sign(harness, await workToSignature(harness));
  });

  it('the record is final, whatever its status says', () => {
    expect(signed.status).toBe('review');
    expect(isFinalized(signed)).toBe(true);
  });

  it('is closed to all three roles', () => {
    expect(canEditJobRecord('master', signed)).toBe(false);
    expect(canEditJobRecord('coordinator', signed)).toBe(false);
    expect(canEditJobRecord('technician', signed)).toBe(false);
  });

  it('refuses a MASTER adding labour', async () => {
    await expect(
      addLabour(harness.as(master), signed, {
        date: '2026-09-18',
        rateType: 'double',
        hours: 99,
        description: 'Added after signature',
      }),
    ).rejects.toThrow(/final and cannot be changed/i);

    const reloaded = await harness.repos.jobs.findById(signed.id);
    expect(reloaded?.labour).toHaveLength(1);
  });

  it('refuses a COORDINATOR adding a part', async () => {
    await expect(
      addPart(harness.as(coordinator), signed, {
        partNumber: 'X-9',
        description: 'Added after signature',
        quantity: 5,
        unitPrice: 999999,
      }),
    ).rejects.toThrow(/final and cannot be changed/i);

    expect((await harness.repos.jobs.findById(signed.id))?.parts).toHaveLength(1);
  });

  it('refuses the TECHNICIAN who did the work', async () => {
    await expect(
      addLabour(harness.as(technician), signed, {
        date: '2026-09-18',
        rateType: 'normal',
        hours: 4,
        description: 'Technician after signature',
      }),
    ).rejects.toThrow(/final and cannot be changed/i);
  });

  it('refuses DELETION of signed evidence', async () => {
    const line = signed.labour[0]!;
    await expect(
      removeLineItem(harness.as(master), signed, 'labour', line.id),
    ).rejects.toThrow(/final and cannot be changed/i);

    expect((await harness.repos.jobs.findById(signed.id))?.labour).toHaveLength(1);
  });

  it('refuses REWRITING the signed completion write-up', async () => {
    await expect(
      saveCompletionReport(harness.as(master), signed, {
        ...signed.completionReport,
        workPerformed: 'Rewritten after the customer signed.',
      }),
    ).rejects.toThrow(/final and cannot be changed/i);

    const reloaded = await harness.repos.jobs.findById(signed.id);
    expect(reloaded?.completionReport.workPerformed).toBe(
      'Replaced the spindle drive cooling fan.',
    );
  });

  it('refuses amending an existing line', async () => {
    await expect(
      updateLabour(harness.as(master), signed, signed.labour[0]!.id, {
        date: '2026-09-17',
        rateType: 'double',
        hours: 40,
        description: 'Corrected',
      }),
    ).rejects.toThrow(/final and cannot be changed/i);
  });

  it('refuses a note, which is still a change to the signed card', async () => {
    await expect(
      addNote(harness.as(master), signed, 'Checked against the PO.', true),
    ).rejects.toThrow(/final and cannot be changed/i);
  });

  it('says why, in words the office can act on', async () => {
    const error = await addNote(harness.as(master), signed, 'Anything.', true).catch(
      (cause: Error) => cause,
    );
    expect(String(error)).toMatch(/final/i);
    expect(JSON.stringify(error)).toMatch(/customer has signed/i);
  });
});

describe('a REFUSED job card is not finalized, and the office may correct it', () => {
  let harness: Harness;
  let refused: Job;

  beforeEach(async () => {
    harness = buildHarness();
    refused = await recordSignatureRefusal(harness.as(technician), await workToSignature(harness), {
      reason: 'The customer disputes the hours recorded.',
    });
  });

  it('lands in the same status as a signature, and is told apart by the signature', () => {
    expect(refused.status).toBe('review');
    expect(refused.signature).toBeNull();
    expect(isFinalized(refused)).toBe(false);
  });

  it('is open to the office and READ-ONLY to the technician', () => {
    /*
     * MASTER SCOPE REF-11. "From that point onward the technician is READ-ONLY
     * on that job… The technician may ONLY view the submitted job card and its
     * refusal information."
     *
     * This asserted `true` for the technician, and said so confidently: a job
     * at Review is the office's and `canEditJob` "has always said so". It did
     * not — it returned true for every role, which is exactly the defect
     * acceptance testing found. Handing the job over is the point at which it
     * stops being the technician's.
     */
    expect(canEditJobRecord('master', refused)).toBe(true);
    expect(canEditJobRecord('coordinator', refused)).toBe(true);
    expect(canEditJobRecord('technician', refused)).toBe(false);
  });

  it('lets a MASTER correct the disputed hours', async () => {
    const corrected = await updateLabour(harness.as(master), refused, refused.labour[0]!.id, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Hours corrected after the customer disputed them',
    });
    expect(corrected.labour[0]?.hours).toBe(2);
  });

  it('lets a COORDINATOR correct it too — she is the office', async () => {
    const corrected = await addNote(
      harness.as(coordinator),
      refused,
      'Spoke to the customer; hours agreed at two.',
      true,
    );
    expect(corrected.notes.some((note) => note.body.includes('hours agreed'))).toBe(true);
  });

  it('records the correction as a correction, attributed', async () => {
    // A LINE edit, not a note: `recordPostSignatureChange` is wired to the
    // captures that change what the customer is being asked to agree to —
    // labour, travel, parts, media and the write-up — and a note is commentary
    // beside the job card rather than a change to it.
    await updateLabour(harness.as(master), refused, refused.labour[0]!.id, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Hours corrected after the refusal',
    });
    const trail = await harness.repos.activity.list(refused.id);

    expect(trail.some((event) => event.type === 'job_card_corrected')).toBe(true);
    // And never as the retired post-signature amendment.
    expect(trail.some((event) => event.type === 'master_amended_after_signature')).toBe(false);
  });

  it('becomes immutable once it is signed after the correction', async () => {
    const corrected = await updateLabour(harness.as(master), refused, refused.labour[0]!.id, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Hours corrected',
    });

    // Outcome A of the refusal workflow, through the real operation rather
    // than by setting a status by hand.
    const backToCustomer = await returnToCustomerSignature(
      harness.as(master),
      corrected,
      'Hours corrected; returned for signature.',
    );
    expect(backToCustomer.status).toBe('customer_signature');
    const nowSigned = await sign(harness, backToCustomer);

    expect(isFinalized(nowSigned)).toBe(true);
    await expect(
      addNote(harness.as(master), nowSigned, 'One more thought.', true),
    ).rejects.toThrow(/final and cannot be changed/i);
  });
});

describe('a job issued WITHOUT a customer signature is final too', () => {
  it('is immutable once the document is with the customer', async () => {
    /*
     * Outcome B of the refusal workflow closes with `signature` still null, so
     * a rule written only against the signature would leave it editable for
     * ever. The customer is holding a document either way.
     */
    const harness = buildHarness();
    const refused = await recordSignatureRefusal(
      harness.as(technician),
      await workToSignature(harness),
      { reason: 'The customer would not sign.' },
    );

    const issued: Job = { ...refused, status: 'awaiting_delivery' };
    expect(isFinalized(issued)).toBe(true);
    expect(canEditJobRecord('master', issued)).toBe(false);

    const closed: Job = { ...refused, status: 'closed' };
    expect(isFinalized(closed)).toBe(true);
    expect(canEditJobRecord('master', closed)).toBe(false);
  });
});
