import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGEMENT_REQUIRED_AREAS,
  CORRECTED_AREAS,
  acknowledgementRequiredFor,
  awaitsAcknowledgement,
  isFinalized,
  type Job,
} from '@/domain';
import {
  acceptJob,
  addLabour,
  addNote,
  captureSignature,
  recordSignatureRefusal,
  resolveSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
  submitJobCard,
} from './job-operations';
import {
  listJobCorrections,
  loadCorrectionDocument,
  raiseJobCorrection,
  recordCorrectionAcknowledgement,
} from './job-corrections';
import { pdfPageTexts } from '@/lib/pdf/inspect';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * CORRECTING A JOB CARD EJE HAVE ALREADY ISSUED. BD-02, IMMUT-9, AUD-3.
 *
 * THE GAP THESE CLOSE was an acceptance blocker: a signed job card with a
 * genuine error had no remedy at any layer. Every one of the cases below used
 * to be unanswerable — not refused, simply impossible.
 *
 * WHAT HAS TO HOLD, from the owner's rule:
 *
 *   - the original job card, its signature, its date and its bytes are
 *     untouched (the first test, and the immutability suite that already
 *     exists);
 *   - a MASTER raises it; nobody else;
 *   - the reason, the author, the timestamp, the affected areas and a
 *     reference to the original are all recorded;
 *   - the correction does not invalidate the signature;
 *   - acknowledgement, where required, is recorded explicitly and once;
 *   - the original and the correction are both still readable.
 */
const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

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
  job = await saveCompletionReport(tech, job, {
    ...job.completionReport,
    workPerformed: 'Replaced the spindle drive cooling fan.',
  });
  job = await startCompletion(tech, job);
  return startSignature(tech, job);
};

/** A job card signed by the customer and submitted — a document they hold. */
const issuedAndSigned = async (harness: Harness): Promise<Job> => {
  const atSignature = await workToSignature(harness);
  const signed = await captureSignature(harness.as(technician), atSignature, {
    customerName: 'Pieter',
    customerSurname: 'Nel',
    strokeData: 'M0,0 L1,1',
  });
  const result = await submitJobCard(
    harness.as(technician),
    signed,
    'pieter@abc-engineering-demo.co.za',
    'Pieter Nel',
  );
  return result.job;
};

const RAISE = {
  reason: 'The labour hours were captured against the wrong rate.',
  narrative: 'Three hours were charged at the after-hours rate and should have been normal time.',
  areas: ['labour', 'charges'],
  // BD-27: a correction to labour and charges must be acknowledged.
  acknowledgementRequired: true,
} as const;

describe('raising a correction to an issued job card', () => {
  let harness: Harness;
  let issued: Job;

  beforeEach(async () => {
    harness = buildHarness();
    issued = await issuedAndSigned(harness);
  });

  it('leaves the ORIGINAL document, signature and dates exactly as they were', async () => {
    const before = issued.finalDocument;
    expect(before).not.toBeNull();

    await raiseJobCorrection(harness.as(master), issued, RAISE);

    const after = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(after?.finalDocument?.storageKey).toBe(before?.storageKey);
    expect(after?.finalDocument?.generatedAt).toBe(before?.generatedAt);
    expect(after?.finalDocument?.fileName).toBe(before?.fileName);
    expect(after?.finalDocument?.checksumSha256).toBe(before?.checksumSha256);
    // The signature is not invalidated, replaced or re-requested.
    expect(after?.signature?.customerName).toBe('Pieter');
    expect(isFinalized(after!)).toBe(true);
  });

  it('records the reason, the author, the areas and a reference to the original', async () => {
    const correction = await raiseJobCorrection(harness.as(master), issued, RAISE);

    expect(correction.sequence).toBe(1);
    expect(correction.reason).toBe(RAISE.reason);
    expect(correction.narrative).toBe(RAISE.narrative);
    expect(correction.raisedBy).toBe(master.id);
    expect(Number.isNaN(Date.parse(correction.raisedAt))).toBe(false);
    // The AREAS come back in the domain's own order, not the caller's.
    expect(correction.areas).toEqual(['labour', 'charges']);
    // THE REFERENCE TO THE ORIGINAL: the exact bytes the customer holds.
    expect(correction.correctsDocumentKey).toBe(issued.finalDocument?.storageKey);
  });

  it('produces its OWN document, which is not the job card', async () => {
    const correction = await raiseJobCorrection(harness.as(master), issued, RAISE);

    expect(correction.documentStorageKey).not.toBe(issued.finalDocument?.storageKey);
    expect(correction.documentFileName).toBe('EJE-1048-correction-1.pdf');
    expect(correction.documentSizeBytes).toBeGreaterThan(0);
    expect(correction.documentChecksumSha256).toMatch(/^[0-9a-f]{64}$/u);

    // And it is readable, by the people who may read the job card.
    const found = await loadCorrectionDocument(harness.as(master), issued, correction.id);
    expect(found).not.toBeNull();
    expect(found?.file.bytes.byteLength).toBe(correction.documentSizeBytes);
  });

  /**
   * THE ADDENDUM SAYS WHAT IT IS. Read out of the rendered bytes rather than
   * asserted about the model, because the thing that matters is what the
   * customer sees on the paper.
   */
  it('says on the paper that it is a correction and that the original stands', async () => {
    const correction = await raiseJobCorrection(harness.as(master), issued, RAISE);
    const found = await loadCorrectionDocument(harness.as(master), issued, correction.id);
    // Read out of the rendered PDF's own content streams, not off the bytes:
    // what matters is the text a person sees on the page.
    const text = pdfPageTexts(found!.file.bytes).join('\n');

    expect(text).toContain('CORRECTION TO JOB CARD');
    expect(text).toMatch(/STAND UNCHANGED/u);
    expect(text).toContain('EJE-1048');
  });

  it('numbers a second correction, and keeps the first', async () => {
    const first = await raiseJobCorrection(harness.as(master), issued, RAISE);
    const second = await raiseJobCorrection(harness.as(master), issued, {
      ...RAISE,
      reason: 'A part was listed twice.',
      narrative: 'The cooling fan appears twice; one line is removed.',
      areas: ['parts'],
    });

    expect(second.sequence).toBe(2);
    const all = await listJobCorrections(harness.as(master), issued);
    expect(all.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(all[0]?.reason).toBe(first.reason);
  });

  /* -- who may ------------------------------------------------------------- */

  it('REFUSES a Coordinator', async () => {
    await expect(raiseJobCorrection(harness.as(coordinator), issued, RAISE)).rejects.toThrow(
      /cannot raise a correction/iu,
    );
  });

  it('REFUSES the technician who did the work', async () => {
    await expect(raiseJobCorrection(harness.as(technician), issued, RAISE)).rejects.toThrow(
      /cannot raise a correction/iu,
    );
  });

  /* -- what it will not accept -------------------------------------------- */

  it('REFUSES a correction with no reason', async () => {
    await expect(
      raiseJobCorrection(harness.as(master), issued, { ...RAISE, reason: '   ' }),
    ).rejects.toThrow(/reason is required/iu);
  });

  it('REFUSES a correction that names no part of the job card', async () => {
    await expect(
      raiseJobCorrection(harness.as(master), issued, { ...RAISE, areas: [] }),
    ).rejects.toThrow(/which part of the job card/iu);
  });

  it('REFUSES an area it does not understand, rather than printing it', async () => {
    // An unrecognised area would otherwise reach the customer's addendum as a
    // label this build cannot render.
    await expect(
      raiseJobCorrection(harness.as(master), issued, { ...RAISE, areas: ['vibes'] }),
    ).rejects.toThrow(/which part of the job card/iu);
  });

  it('REFUSES a job that has issued nothing', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1049');
    await expect(
      raiseJobCorrection(harness.as(master), view!.job, RAISE),
    ).rejects.toThrow(/no issued job card/iu);
  });

  /** A correction is not a way back into the job card. */
  it('does not reopen the job for editing', async () => {
    await raiseJobCorrection(harness.as(master), issued, RAISE);
    const after = await harness.repos.jobs.findByJobNumber('EJE-1048');
    await expect(addNote(harness.as(master), after!, 'Anything.', true)).rejects.toThrow(
      /final/iu,
    );
  });
});

describe("the customer's acknowledgement of a correction", () => {
  let harness: Harness;
  let issued: Job;

  beforeEach(async () => {
    harness = buildHarness();
    issued = await issuedAndSigned(harness);
  });

  it('is REQUIRED when the Master said so, and outstanding until recorded', async () => {
    const correction = await raiseJobCorrection(harness.as(master), issued, {
      ...RAISE,
      acknowledgementRequired: true,
    });
    expect(correction.acknowledgement).toBe('required');
    expect(correction.acknowledged).toBeNull();
  });

  it('is recorded with who, how and when — by the office', async () => {
    const correction = await raiseJobCorrection(harness.as(master), issued, {
      ...RAISE,
      acknowledgementRequired: true,
    });

    // The COORDINATOR may record it: deciding a correction is needed is a
    // Master's, writing down what the customer said is clerical.
    const acknowledged = await recordCorrectionAcknowledgement(
      harness.as(coordinator),
      correction.id,
      { acknowledgedBy: 'Pieter Nel', method: 'By telephone', note: 'Accepted the revised hours.' },
    );

    expect(acknowledged.acknowledgement).toBe('recorded');
    expect(acknowledged.acknowledged?.acknowledgedBy).toBe('Pieter Nel');
    expect(acknowledged.acknowledged?.method).toBe('By telephone');
    expect(acknowledged.acknowledged?.recordedBy).toBe(coordinator.id);
    expect(Number.isNaN(Date.parse(acknowledged.acknowledged?.recordedAt ?? ''))).toBe(false);
  });

  it('is WRITE-ONCE', async () => {
    const correction = await raiseJobCorrection(harness.as(master), issued, {
      ...RAISE,
      acknowledgementRequired: true,
    });
    await recordCorrectionAcknowledgement(harness.as(master), correction.id, {
      acknowledgedBy: 'Pieter Nel',
      method: 'By telephone',
      note: '',
    });

    await expect(
      recordCorrectionAcknowledgement(harness.as(master), correction.id, {
        acknowledgedBy: 'Somebody else',
        method: 'By e-mail',
        note: '',
      }),
    ).rejects.toThrow(/already been acknowledged/iu);
  });

  it('REFUSES one on a correction that never asked for it', async () => {
    // Otherwise the addendum the customer holds — which says acknowledgement
    // is not required — would disagree with the record. (A dates correction:
    // BD-27 leaves that one to the Master's judgement.)
    const correction = await raiseJobCorrection(harness.as(master), issued, {
      ...RAISE,
      areas: ['dates'],
      acknowledgementRequired: false,
    });
    await expect(
      recordCorrectionAcknowledgement(harness.as(master), correction.id, {
        acknowledgedBy: 'Pieter Nel',
        method: 'By telephone',
        note: '',
      }),
    ).rejects.toThrow(/did not ask for an acknowledgement/iu);
  });

  it('REFUSES a technician recording one', async () => {
    const correction = await raiseJobCorrection(harness.as(master), issued, {
      ...RAISE,
      acknowledgementRequired: true,
    });
    await expect(
      recordCorrectionAcknowledgement(harness.as(technician), correction.id, {
        acknowledgedBy: 'Pieter Nel',
        method: 'By telephone',
        note: '',
      }),
    ).rejects.toThrow(/cannot record/iu);
  });
});

describe('a job card issued WITHOUT a signature can be corrected too', () => {
  it('says on the addendum that the original was unsigned', async () => {
    const harness = buildHarness();
    const refused = await recordSignatureRefusal(
      harness.as(technician),
      await workToSignature(harness),
      { reason: 'The customer would not sign.' },
    );
    const closed = await resolveSignatureRefusal(harness.as(master), refused, 'Issued unsigned.');

    const correction = await raiseJobCorrection(harness.as(master), closed, RAISE);
    const found = await loadCorrectionDocument(harness.as(master), closed, correction.id);
    const text = pdfPageTexts(found!.file.bytes).join('\n');

    expect(text).toMatch(/without a customer signature/iu);
  });
});

describe('who may read a correction', () => {
  it('is whoever may read the job card it corrects', async () => {
    const harness = buildHarness();
    const issued = await issuedAndSigned(harness);
    const correction = await raiseJobCorrection(harness.as(master), issued, RAISE);

    // The technician who did the work sees it: they are the person who most
    // needs to know that EJE have corrected their job card.
    const theirs = await listJobCorrections(harness.as(technician), issued);
    expect(theirs.map((entry) => entry.id)).toContain(correction.id);
  });
});

describe('BD-27 — when the customer must acknowledge a correction (approved 27 October 2026)', () => {
  let harness: Harness;
  let issued: Job;
  beforeEach(async () => {
    harness = buildHarness();
    issued = await issuedAndSigned(harness);
  });

  it('REFUSES raising a price, quantity or described-work correction as not requiring acknowledgement', async () => {
    for (const area of ACKNOWLEDGEMENT_REQUIRED_AREAS) {
      await expect(
        raiseJobCorrection(harness.as(master), issued, { ...RAISE, areas: [area], acknowledgementRequired: false }),
        area,
      ).rejects.toMatchObject({ violations: [{ code: 'acknowledgement_required' }] });
    }
    // Refused means nothing was written.
    expect(await harness.repos.jobs.listCorrections(issued.id)).toHaveLength(0);
  });

  it('still refuses when such an area is listed beside one the Master decides', async () => {
    await expect(
      raiseJobCorrection(harness.as(master), issued, {
        ...RAISE,
        areas: ['dates', 'work_performed'],
        acknowledgementRequired: false,
      }),
    ).rejects.toMatchObject({ violations: [{ code: 'acknowledgement_required' }] });
  });

  it('leaves every other area to the Master, either way', async () => {
    for (const area of CORRECTED_AREAS.filter((candidate) => !ACKNOWLEDGEMENT_REQUIRED_AREAS.includes(candidate))) {
      expect(acknowledgementRequiredFor([area]), area).toBe(false);
    }
    const optional = await raiseJobCorrection(harness.as(master), issued, {
      ...RAISE,
      areas: ['customer_details'],
      acknowledgementRequired: false,
    });
    expect(optional.acknowledgement).toBe('not_required');
    const chosen = await raiseJobCorrection(harness.as(master), issued, {
      ...RAISE,
      areas: ['recommendations'],
      acknowledgementRequired: true,
    });
    expect(chosen.acknowledgement).toBe('required');
  });

  it('does not treat a required acknowledgement as given until somebody records it', async () => {
    const correction = await raiseJobCorrection(harness.as(master), issued, RAISE);
    expect(correction.acknowledgement).toBe('required');
    expect(awaitsAcknowledgement(correction)).toBe(true);
    expect(correction.acknowledged).toBeNull();

    const [stored] = await harness.repos.jobs.listCorrections(issued.id);
    expect(awaitsAcknowledgement(stored!)).toBe(true);

    const recorded = await recordCorrectionAcknowledgement(harness.as(master), correction.id, {
      acknowledgedBy: 'Pieter Nel',
      method: 'By telephone',
      note: '',
    });
    expect(recorded.acknowledgement).toBe('recorded');
    expect(awaitsAcknowledgement(recorded)).toBe(false);
  });
});
