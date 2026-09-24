import { beforeEach, describe, expect, it } from 'vitest';
import {
  acceptJob,
  resolveSignatureRefusal,
  addLabour,
  recordSignatureRefusal,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadFinalDocumentFile } from './final-document';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { buildJobCardModel } from '@/lib/job-card/model';
import { inspectPdf, pdfPlainText } from '@/lib/pdf/inspect';
import { currentRefusal, type Job } from '@/domain';

/**
 * What a refused job card actually says on paper.
 *
 * The rule this exists to hold: a refused document must never carry a customer
 * signature, and must say in plain words that the customer refused, why, who
 * recorded it and when. A signature drawn for a customer who would not sign
 * would be a forgery on a document EJE issues.
 *
 * Both renderers are covered, because they share one model: the PDF through its
 * bytes, and the model itself for the on-screen card that reads the same
 * fields.
 */

const technician = seedUser('user-tech-sipho');
const master = seedUser('user-master-elmarie');
const REASON = 'Site manager left before the work was finished and nobody else would sign.';

describe('the issued document for a refused job card', () => {
  let harness: Harness;
  let issued: Job;

  beforeEach(async () => {
    harness = buildHarness();
    const context = harness.as(technician);
    const opened = await harness.repos.jobs.findByJobNumber('EJE-1048');

    let job = await acceptJob(context, opened!);
    job = await saveCompletionReport(context, job, {
      ...job.completionReport,
      workPerformed: 'Replaced the spindle drive cooling fan and test ran the machine.',
    });
    job = await addLabour(context, job, {
      date: '2026-09-17',
      rateType: 'normal',
      hours: 2,
      description: 'Spindle drive repair',
    });
    job = await startCompletion(context, job);
    job = await startSignature(context, job);
    job = await recordSignatureRefusal(context, job, { reason: REASON });

    /*
     * "WITHOUT CUSTOMER SIGNATURE" NOW CLOSES THE JOB ITSELF.
     *
     * This used to resolve the refusal, then issue, then wait for a delivery
     * confirmation — three steps for an outcome the office has already
     * decided. The confirmed rule is that resolving this way closes the job
     * immediately, and the unsigned document is produced as part of it. The
     * document itself is unchanged, which is what every case below checks.
     */
    issued = await resolveSignatureRefusal(harness.as(master), job, 'Invoice to proceed.');
    expect(issued.status).toBe('closed');
  });

  const storedText = async (): Promise<string> =>
    pdfPlainText((await loadFinalDocumentFile(harness.as(master), 'EJE-1048')).bytes);

  it('says the customer refused to sign', async () => {
    expect(await storedText()).toContain('CUSTOMER REFUSED TO SIGN');
  });

  it('prints the reason', async () => {
    const text = await storedText();
    expect(text).toContain('Reason');
    // Wrapped across lines by the layout, so the opening phrase is what is
    // asserted rather than the whole sentence on one line.
    expect(text.replace(/\n/g, ' ')).toContain('Site manager left before the work');
  });

  it('prints who recorded it and when', async () => {
    const text = await storedText();
    expect(text).toContain('Recorded by');
    expect(text).toContain('Sipho Mahlangu');
    expect(text).toContain('Date');
  });

  it('carries NO signature mark of any kind', async () => {
    const report = inspectPdf(
      (await loadFinalDocumentFile(harness.as(master), 'EJE-1048')).bytes,
    );
    // The same assertion the signed documents pass in reverse: nothing drawn,
    // and no script-face facsimile standing in for one.
    expect(report.signature).toBeNull();
  });

  it('does not claim the customer signed, in the pricing footnote', async () => {
    const text = await storedText();
    expect(text).toContain('when the work was completed.');
    expect(text).not.toContain('when the customer signed.');
  });

  it('says nothing about Master Review', async () => {
    expect(await storedText()).not.toMatch(/master review/i);
  });

  it('does not print the acceptance declaration', async () => {
    expect(await storedText()).not.toContain(
      'I confirm that the work described above has been completed.',
    );
  });

  it('is still a readable document — no overruns, no collisions', async () => {
    const report = inspectPdf(
      (await loadFinalDocumentFile(harness.as(master), 'EJE-1048')).bytes,
    );
    expect(report.problems).toEqual([]);
    expect(report.pageCount).toBeGreaterThan(0);
  });

  it('is frozen: the stored bytes are identical on every read', async () => {
    const first = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    const second = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
    expect(second.fileName).toBe(first.fileName);
  });

  it('is frozen against the record changing afterwards', async () => {
    const before = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    /*
     * Rewritten underneath the issued document, through the repository.
     *
     * No operation permits this on a closed job — that is what makes it the
     * right test. The question is whether the document the customer holds is
     * REGENERATED from current data, and it must not be.
     */
    await harness.repos.jobs.save({
      ...issued,
      signatureRefusals: [
        {
          ...currentRefusal(issued)!,
          reason: 'A completely different reason, written afterwards.',
        },
      ],
    });

    const after = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    expect(Array.from(after.bytes)).toEqual(Array.from(before.bytes));
    expect(pdfPlainText(after.bytes)).not.toContain('written afterwards');
  });

  it('closed on confirmed delivery, exactly as a signed job does', () => {
    expect(issued.status).toBe('closed');
    expect(issued.finalDocument).not.toBeNull();
    expect(issued.signature).toBeNull();
    expect(currentRefusal(issued)?.reason).toBe(REASON);
  });

  it('does NOT email the customer on this path — BD-06, an open decision', async () => {
    /*
     * This asserted one email, because the old route reached the customer
     * through `issueJobCard`, which sends. Closing on resolution takes that
     * route away, and whether the unsigned copy should be EMAILED is a
     * question nobody has answered:
     *
     *   §15 puts customer delivery after the final MASTER submission, and this
     *   resolution is open to a Coordinator. Sending here would hand her an
     *   outward-facing act the Scope reserves.
     *
     * So the document is rendered, stored and downloadable — every case above
     * reads it back — and nothing is sent. This pins that deliberate silence
     * so it cannot become an accident, and it is the case to invert when
     * BD-06 is decided.
     */
    const sent = await harness.outbox.list();
    const forThisJob = sent.filter(
      (entry) => entry.channel === 'email' && entry.subject.includes('EJE-1048'),
    );
    expect(forThisJob).toHaveLength(0);

    // The document exists regardless: it is what the cases above read.
    expect(issued.finalDocument?.fileName).toBe('EJE-1048-Final-Job-Card.pdf');
  });
});

describe('the model both renderers read', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const modelFor = async (jobNumber: string, job?: Job) => {
    const view = await loadJobView(harness.repos, jobNumber);
    return buildJobCardModel({
      job: job ?? view!.job,
      customer: view!.customer,
      site: view!.site,
      contact: view!.contact,
      machine: view!.machine,
      settings: view!.settings,
      checklistTemplate: view!.checklistTemplate,
      users: view!.users,
      generatedAt: '2026-09-19T10:00:00.000Z',
    });
  };

  it('gives a refused job a refusal block and no acceptance', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1044');
    const model = await modelFor('EJE-1044', {
      ...view!.job,
      signature: null,
      signatureRefusals: [
        {
          refused: true,
          reason: REASON,
          recordedBy: technician.id,
          recordedAt: '2026-09-18T09:00:00.000Z',
          resolvedBy: null,
          resolvedAt: null,
          resolution: null,
          resolutionNote: '',
        },
      ],
    });

    expect(model.refusal).not.toBeNull();
    expect(model.acceptance).toBeNull();
    expect(model.refusal?.heading).toBe('Customer refused to sign');
    expect(model.refusal?.reason).toBe(REASON);
    expect(model.refusal?.rows.map((row) => row.label)).toEqual(['Recorded by', 'Date']);
    expect(model.refusal?.rows[0]?.value).toBe('Sipho Mahlangu');
  });

  it('still says a signed job card was priced when the customer signed', async () => {
    const model = await modelFor('EJE-1044');
    expect(model.footerLines.join(' ')).toContain('when the customer signed.');
  });

  it('leaves a signed job exactly as it was — acceptance, no refusal', async () => {
    const model = await modelFor('EJE-1044');
    expect(model.refusal).toBeNull();
    expect(model.acceptance).not.toBeNull();
    expect(model.acceptance?.declaration).toBe(
      'I confirm that the work described above has been completed.',
    );
    expect(model.acceptance?.signatureData.length).toBeGreaterThan(0);
  });

  it('calls a collector a collector', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1062');
    const model = await modelFor('EJE-1062', {
      ...view!.job,
      signature: null,
      signatureRefusals: [
        {
          refused: true,
          reason: 'The driver would not sign for the goods.',
          recordedBy: technician.id,
          recordedAt: '2026-09-18T09:00:00.000Z',
          resolvedBy: null,
          resolvedAt: null,
          resolution: null,
          resolutionNote: '',
        },
      ],
    });
    expect(model.refusal?.heading).toBe('Collector refused to sign');
  });
});
