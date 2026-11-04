import { beforeEach, describe, expect, it } from 'vitest';
import { buildJobCardModel } from '@/lib/job-card/model';
import { inspectPdf, pdfPlainText } from '@/lib/pdf/inspect';
import { renderJobCardPdf } from '@/services/simulated/job-card-pdf';
import {
  installationChecklist,
  latheServiceChecklist,
  millingServiceChecklist,
} from '@/data/checklists/source-checklists';
import { asChecklistTemplateId, type ChecklistTemplate, type Job } from '@/domain';
import {
  answerChecklistItem,
  completeChecklist,
  startChecklist,
} from './job-operations';
import { loadJobView, type JobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * THE COMPLETED SOURCE CHECKLIST, ON THE JOB CARD AND IN THE PDF. CHK-SRC-1.
 *
 * A completed Lathe checklist prints as the Lathe checklist: the chosen type,
 * the source's printed title, the header filled from the job, every row with
 * the source's own number, the handwritten line marked as handwritten, the
 * typed blanks, and the sign-off lines with the job's own names and signature.
 * A job completed on the earlier demonstration wording still prints that
 * wording — its own version, never the new one.
 */

const sipho = seedUser('user-tech-sipho');

/**
 * A layout problem EJE-1053's document has WITHOUT any checklist — its labour
 * line in the charges table (found 4 November 2026, reported, not part of
 * CHK-SRC-1). Excluded by its exact text, so any other problem, and any in the
 * checklist, still fails.
 */
const isPreExisting = (problem: string): boolean =>
  problem.startsWith('page 1: "Normal Time') && problem.endsWith('overlaps "4.00 hrs"');
const layoutProblems = (bytes: Uint8Array) =>
  inspectPdf(bytes).problems.filter((problem) => !isPreExisting(problem));
const GENERATED = '2026-11-04T15:00:00.000Z';

/** EJE-1053: a seeded service job in Completion with no checklist yet. */
const serviceJob = async (harness: Harness): Promise<Job> => {
  const job = (await harness.repos.jobs.findByJobNumber('EJE-1053'))!;
  return harness.repos.jobs.save({ ...job, primaryTechnicianId: sipho.id });
};

const answerAll = async (
  harness: Harness,
  job: Job,
  template: ChecklistTemplate,
): Promise<Job> => {
  let current = job;
  for (const item of template.sections.flatMap((section) => section.items)) {
    current = await answerChecklistItem(
      harness.as(sipho),
      current,
      item.id,
      { choice: 'pass' },
      {},
      template,
    );
  }
  return current;
};

const documentFor = (view: JobView, job: Job, template: ChecklistTemplate) => {
  const source = {
    job,
    customer: view.customer,
    site: view.site,
    contact: view.contact,
    machine: view.machine,
    settings: view.settings,
    checklistTemplate: template,
    users: view.users,
  };
  return {
    model: buildJobCardModel({ ...source, generatedAt: GENERATED }),
    pdf: renderJobCardPdf(source, 'test.pdf', GENERATED),
  };
};

describe('a completed Lathe checklist on the job card', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const completedLathe = async () => {
    let job = await startChecklist(harness.as(sipho), await serviceJob(harness), latheServiceChecklist);
    job = await answerAll(harness, job, latheServiceChecklist);
    const handwritten = latheServiceChecklist.sections[1]!.items[5]!;
    job = await answerChecklistItem(
      harness.as(sipho),
      job,
      handwritten.id,
      { choice: 'fail', notes: 'Battery low; replaced.' },
      {},
      latheServiceChecklist,
    );
    job = await completeChecklist(harness.as(sipho), job, latheServiceChecklist);
    const signed: Job = {
      ...job,
      signature: {
        customerName: 'Pieter',
        customerSurname: 'Nel',
        strokeData: 'demo-signature-pieter-nel',
        signedAt: '2026-11-04T14:00:00.000Z',
        declaration: 'I accept the work described.',
      },
    };
    const view = (await loadJobView(harness.repos, 'EJE-1053'))!;
    return { job: signed, view };
  };

  it('records the Lathe choice and renders the Lathe wording, not the Milling', async () => {
    const { job, view } = await completedLathe();
    expect(job.checklist?.checklistKind).toBe('service_lathe');
    const { model } = documentFor(view, job, latheServiceChecklist);

    expect(model.checklist?.checklistType).toBe('Service checklist: Lathe');
    expect(model.checklist?.documentTitle).toBe('PREVENTATIVE MAINTENACE CHECKLIST - LATHE');
    const texts = model.checklist!.sections.flatMap((section) => section.items.map((item) => item.text));
    expect(texts).toHaveLength(41);
    expect(texts).toContain('Check Turret alignment X and Z Axis');
    expect(texts).not.toContain('Check ATC box oil');
  });

  it('numbers rows as the paper does and marks the handwritten line', async () => {
    const { job, view } = await completedLathe();
    const { model } = documentFor(view, job, latheServiceChecklist);
    const electrical = model.checklist!.sections.find((section) => section.title === 'ELECTRICAL')!;
    expect(electrical.items.map((item) => item.number)).toEqual([
      '1', '2', '3', '4', '5', '', '', '6', '7', '8', '9', '10',
    ]);
    expect(electrical.items[5]).toMatchObject({
      text: 'Changed Fanuc control battery',
      answer: 'FAIL',
      note: 'Battery low; replaced.',
      sourceNote: 'Handwritten on the supplied source.',
    });
  });

  it('fills the printed header from the job and the sign-off from the job’s own signature', async () => {
    const { job, view } = await completedLathe();
    const { model } = documentFor(view, job, latheServiceChecklist);
    expect(model.checklist?.header.map((line) => line.label)).toEqual([
      'CUSTOMER:',
      'MACHINE MAKE:',
      'MACHINE MODEL:',
      'SERIAL NUMBER:',
      'DATE:',
    ]);
    expect(model.checklist?.header[0]?.value).toBe(view.customer.name);
    expect(model.checklist?.signatures.map((line) => line.label)).toEqual([
      'ENGINEER (SIGNATURE)',
      'CUSTOMER (SIGNATURE)',
    ]);
    expect(model.checklist?.signatures[0]?.value).toContain('Checklist completed in EJE by');
    expect(model.checklist?.signatures[1]?.value).toContain('Signed on this job card');
  });

  it('prints it in the PDF, readably, with the signature', async () => {
    const { job, view } = await completedLathe();
    const { pdf } = documentFor(view, job, latheServiceChecklist);
    const text = pdfPlainText(pdf.bytes);
    expect(text).toContain('Service checklist: Lathe');
    expect(text).toContain('PREVENTATIVE MAINTENACE CHECKLIST - LATHE');
    expect(text).toContain('Changed Fanuc control battery');
    expect(text).toContain('Handwritten on the supplied source.');
    expect(text).toContain('TAILSTOCK (if fitted)');
    expect(text).toContain('ENGINEER (SIGNATURE)');
    expect(layoutProblems(pdf.bytes)).toEqual([]);
    expect(inspectPdf(pdf.bytes).signature).not.toBeNull();
  });
});

describe('a completed Milling checklist and an Installation checklist', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('prints the Milling checklist, its closing line and its four sign-off lines', async () => {
    let job = await startChecklist(harness.as(sipho), await serviceJob(harness), millingServiceChecklist);
    job = await answerAll(harness, job, millingServiceChecklist);
    job = await completeChecklist(harness.as(sipho), job, millingServiceChecklist);
    const view = (await loadJobView(harness.repos, 'EJE-1053'))!;
    const { model, pdf } = documentFor(view, job, millingServiceChecklist);

    expect(model.checklist?.checklistType).toBe('Service checklist: Milling Machine / Machining Centre');
    expect(model.checklist?.closing).toBe('ALL CHECKS COMPLETE');
    expect(model.checklist?.signatures).toHaveLength(4);
    const text = pdfPlainText(pdf.bytes);
    expect(text).toContain('PREVENTATIVE MAINTENANCE CHECKLIST - MACHINING CENTRE');
    expect(text).toContain('ALL CHECKS COMPLETE');
    expect(layoutProblems(pdf.bytes)).toEqual([]);
  });

  it('prints Installation’s grouped item 7, its readings and its printed notes', async () => {
    const view = (await loadJobView(harness.repos, 'EJE-1053'))!;
    const voltage = installationChecklist.sections[0]!.items[1]!;
    const job: Job = {
      ...view.job,
      jobType: 'installation',
      checklist: {
        templateId: installationChecklist.id,
        templateVersion: '1.0',
        checklistKind: 'installation',
        responses: installationChecklist.sections[0]!.items.map((item) => ({
          itemId: item.id,
          choice: 'pass' as const,
          yesNo: null,
          measurement: null,
          text: '',
          notes: '',
          fieldValues: (item.id === voltage.id ? { r: '401', s: '399', t: '400' } : {}) as Readonly<Record<string, string>>,
          photos: [],
          answeredAt: '2026-11-04T09:00:00.000Z',
          answeredBy: sipho.id,
        })),
        completedAt: '2026-11-04T10:00:00.000Z',
        completedBy: sipho.id,
      },
    };
    const { model, pdf } = documentFor(view, job, installationChecklist);
    const items = model.checklist!.sections[0]!.items;
    expect(items.filter((item) => item.groupHeading.length > 0).map((item) => item.groupHeading)).toEqual([
      '7 Check all oil levels:',
    ]);
    expect(items[1]?.readings).toBe('R 401 · S 399 · T 400');
    expect(model.checklist?.header.find((line) => line.label === 'Installation date:')?.value).not.toBe('');
    const text = pdfPlainText(pdf.bytes);
    expect(text).toContain('Installation Procedure');
    expect(text).toContain('R 401 · S 399 · T 400');
    expect(text).toContain('If procedure is not filled in and correctly filled in, no training will be scheduled.');
    expect(layoutProblems(pdf.bytes)).toEqual([]);
  });
});

describe('a job completed on the earlier demonstration wording', () => {
  it('still renders its own version, never a source checklist', async () => {
    const harness = buildHarness();
    // EJE-1044: a closed service job, completed and signed against 1.0-DEMO.
    const view = (await loadJobView(harness.repos, 'EJE-1044'))!;
    expect(view.job.checklist?.templateId).toBe(asChecklistTemplateId('chk-service'));
    expect(view.job.checklist?.templateVersion).toBe('1.0-DEMO');
    expect(view.checklistTemplate?.version).toBe('1.0-DEMO');
    expect(view.checklistTemplate?.kind ?? null).toBeNull();

    const model = buildJobCardModel({ ...view, generatedAt: GENERATED });
    expect(model.checklist?.title).toContain('1.0-DEMO');
    expect(model.checklist?.checklistType).toBeNull();
    expect(model.checklist?.header).toEqual([]);
  });
});
