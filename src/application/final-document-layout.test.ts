import { beforeEach, describe, expect, it } from 'vitest';
import { loadFinalDocumentFile } from './final-document';
import { buildJobCardModel } from '@/lib/job-card/model';
import { inspectPdf, pdfPlainText, pdfText } from '@/lib/pdf/inspect';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';

/**
 * Whether the final PDF can actually be READ.
 *
 * The previous check asserted the document contained the right strings, and
 * passed while the customer's contact details ran under the panel beside them
 * and the signature box was empty. Correct text is not a readable document.
 *
 * So these measure the rendered page: nothing past a margin, nothing printed
 * over anything else, and a signature physically in the bytes.
 *
 * EJE-1044 is the regression fixture — a service job with a 15-item checklist,
 * measurements, notes, labour, a call-out, VAT, frozen pricing and a signature.
 */

const master = seedUser('user-master-elmarie');
const CLOSED = ['EJE-1044', 'EJE-1056', 'EJE-1057', 'EJE-1062', 'EJE-1039'] as const;

const inspect = async (harness: Harness, jobNumber: string) =>
  inspectPdf((await loadFinalDocumentFile(harness.as(master), jobNumber)).bytes);

describe('the final PDF is readable, not merely correct', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  for (const jobNumber of CLOSED) {
    it(`${jobNumber} has no text running past a margin or off the page`, async () => {
      const report = await inspect(harness, jobNumber);
      const overruns = report.problems.filter(
        (problem) => problem.includes('overruns') || problem.includes('off the page') || problem.includes('left of the margin'),
      );
      expect(overruns).toEqual([]);
    });

    it(`${jobNumber} prints nothing on top of anything else`, async () => {
      const report = await inspect(harness, jobNumber);
      expect(report.problems.filter((problem) => problem.includes('overlaps'))).toEqual([]);
    });

    it(`${jobNumber} has text on every page it declares`, async () => {
      const report = await inspect(harness, jobNumber);
      expect(report.pageCount).toBeGreaterThan(0);
      expect(report.problems.filter((problem) => problem.includes('no text'))).toEqual([]);
      for (let page = 1; page <= report.pageCount; page += 1) {
        expect(report.runs.some((run) => run.page === page), `page ${page}`).toBe(true);
      }
    });

    it(`${jobNumber} carries the customer's signature`, async () => {
      const report = await inspect(harness, jobNumber);
      // Physically present, one way or the other. This is the assertion that
      // fails if the signature box is empty.
      expect(report.signature, `${jobNumber} has no signature`).not.toBeNull();
    });
  }

  it('reports no geometry problems at all, across every closed job', async () => {
    for (const jobNumber of CLOSED) {
      const report = await inspect(harness, jobNumber);
      expect(report.problems, jobNumber).toEqual([]);
    }
  });
});

describe('EJE-1044, the regression fixture', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('renders the seeded signature as the same facsimile the screen shows', async () => {
    const report = await inspect(harness, 'EJE-1044');
    // EJE-1044's stored signature is a seed label, not captured geometry, and
    // the on-screen card renders it as the name in a script face. The PDF must
    // do the same, or the two documents disagree.
    expect(report.signature?.kind).toBe('facsimile');
    expect(report.signature).toMatchObject({ text: 'pieter nel' });
  });

  it('draws a captured signature as its real geometry, not as text', async () => {
    // A job signed in the application stores an `M… L…` path. Rendering it as
    // text would substitute a typeface for the mark the customer made.
    const view = await loadJobView(harness.repos, 'EJE-1044');
    const job = view!.job;
    await harness.repos.jobs.save({
      ...job,
      signature: { ...job.signature!, strokeData: 'M0.10,0.60 L0.30,0.20 L0.55,0.70 L0.85,0.25' },
      finalDocument: null,
    });
    const restored = await harness.repos.jobs.findByJobNumber('EJE-1044');
    await harness.repos.jobs.save({ ...restored!, finalDocument: job.finalDocument });

    const report = await inspect(harness, 'EJE-1044');
    expect(report.signature?.kind).toBe('drawn');
    expect(pdfText((await loadFinalDocumentFile(harness.as(master), 'EJE-1044')).bytes)).toContain(
      '0 0 0 RG',
    );
  });

  it('keeps the acceptance block and the signature on one page', async () => {
    const report = await inspect(harness, 'EJE-1044');
    const declaration = report.runs.find((run) => run.value.startsWith('I confirm'));
    const signedRow = report.runs.find((run) => run.value === 'Signed');
    const caption = report.runs.find((run) => run.value === 'Customer signature');

    expect(declaration).toBeDefined();
    expect(signedRow).toBeDefined();
    expect(caption).toBeDefined();
    // A signature on a different page from the declaration it belongs to is not
    // an acceptance.
    expect(declaration?.page).toBe(caption?.page);
    expect(signedRow?.page).toBe(caption?.page);
  });

  it('spends its pages on content rather than compressing everything onto one', async () => {
    const report = await inspect(harness, 'EJE-1044');
    expect(report.pageCount).toBe(2);
    // A crammed page was the visible symptom of the layout fault; the body text
    // sits at the on-screen document's scale, not shrunk to fit.
    const body = report.runs.filter((run) => run.size === 9);
    expect(body.length).toBeGreaterThan(40);
  });

  it('prices from the frozen snapshot, and names the frozen checklist version', async () => {
    const text = pdfText((await loadFinalDocumentFile(harness.as(master), 'EJE-1044')).bytes);
    expect(text).toContain('R 820,00');
    expect(text).toContain('R 2 870,00');
    expect(text).toContain('R 720,00');
    expect(text).toContain('R 3 590,00');
    expect(text).toContain('R 538,50');
    expect(text).toContain('R 4 128,50');
    expect(text).not.toContain('R 950,00');
    expect(text).toContain('1.0-DEMO');
  });

  it('carries every checklist value and note the screen shows', async () => {
    const text = pdfText((await loadFinalDocumentFile(harness.as(master), 'EJE-1044')).bytes);
    for (const value of [
      'SAFETY SYSTEMS',
      'ELECTRICAL',
      'MECHANICAL & LUBRICATION',
      'SERVICE CLOSE-OUT',
      'PASS',
      '38 °C',
      '3.1 V',
      '7 %',
      '6.2 bar',
      'YES',
      '15 of 15 items answered',
      'Within the 10-40',
    ]) {
      expect(text, `the PDF does not carry ${value}`).toContain(value);
    }
  });
});

describe('the PDF and the screen render one document', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('puts every label and value from the shared model into the PDF', async () => {
    const view = await loadJobView(harness.repos, 'EJE-1044');
    const model = buildJobCardModel({
      job: view!.job,
      customer: view!.customer,
      site: view!.site,
      contact: view!.contact,
      machine: view!.machine,
      settings: view!.settings,
      checklistTemplate: view!.checklistTemplate,
      users: view!.users,
      generatedAt: view!.job.finalDocument!.generatedAt,
    });
    const text = pdfPlainText((await loadFinalDocumentFile(harness.as(master), 'EJE-1044')).bytes);

    // The model is what the on-screen card renders. Anything in it that the PDF
    // has dropped is a divergence between the two documents.
    const expected = [
      model.company.name,
      model.jobNumber,
      model.customer.name,
      ...model.customer.addressLines,
      model.machine!.title,
      ...model.machine!.rows.map((row) => row.value),
      ...model.jobDetails.map((row) => row.value),
      // Null only on a job type that collects no description — CR-13. EJE-1044
      // is a breakdown, so it has one, and the assertion below still runs.
      ...(model.faultDescription === null ? [] : [model.faultDescription]),
      ...model.workBlocks.map((block) => block.value),
      ...model.charges!.rows.map((row) => row.amount),
      model.charges!.total,
      model.checklist!.summary,
      ...model.checklist!.sections.map((section) => section.title.toUpperCase()),
      model.acceptance!.declaration,
      ...model.acceptance!.rows.map((row) => row.value),
      model.acceptance!.caption,
    ];

    // Long values wrap across lines in the PDF, so compare on the first words.
    for (const value of expected) {
      const probe = value.split(/\s+/).slice(0, 4).join(' ');
      expect(text, `the PDF is missing "${probe}"`).toContain(probe);
    }
  });

  it('uses the same section order as the on-screen document', async () => {
    const report = await inspect(harness, 'EJE-1044');
    const order = ['CUSTOMER', 'REPORTED FAULT', 'WORK CARRIED OUT', 'LABOUR, TRAVEL AND PARTS'];
    const positions = order.map((heading) => {
      const run = report.runs.find((candidate) => candidate.value === heading);
      expect(run, `the PDF has no ${heading} heading`).toBeDefined();
      // Later in the document means a higher page, or lower on the same page.
      return (run?.page ?? 0) * 10000 - (run?.y ?? 0);
    });
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

/**
 * Labels and their values must not touch.
 *
 * The label column was a fixed width that every label happened to fit — until
 * the customer's own machine number arrived. "Machine number" measures wider
 * than that column, so on a machine that HAS one the document printed
 * "Machine numberMID1", with the value hard against the label, on the copy the
 * customer keeps. Nothing caught it: the geometry check looks for overlap, and
 * two runs that merely abut do not overlap.
 *
 * So this measures the gap. EJE-1039 is the fixture, because its machine is one
 * of the few with a machine number recorded against it.
 */
describe('nothing is printed hard against the thing beside it', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  for (const jobNumber of CLOSED) {
    it(`${jobNumber} leaves a readable gap between every side-by-side run`, async () => {
      const report = await inspect(harness, jobNumber);

      const touching: string[] = [];
      for (const run of report.runs) {
        for (const other of report.runs) {
          if (run === other || run.page !== other.page) continue;
          // Same line, and `other` starts to the right of `run`.
          if (Math.abs(run.y - other.y) > 1) continue;
          if (other.x < run.x) continue;
          const gap = other.x - (run.x + run.width);
          if (gap >= 0 && gap < 2) {
            touching.push(`p${run.page}: "${run.value}" → "${other.value}" (gap ${gap.toFixed(2)}pt)`);
          }
        }
      }

      expect(touching, jobNumber).toEqual([]);
    });
  }

  it('gives the machine number room, and prints it', async () => {
    const report = await inspect(harness, 'EJE-1039');
    const label = report.runs.find((run) => run.value.includes('Machine number'));
    expect(label, 'EJE-1039 does not print a machine number label').toBeDefined();

    const value = report.runs.find(
      (run) => run.page === label!.page && Math.abs(run.y - label!.y) <= 1 && run.x > label!.x,
    );
    expect(value?.value.trim()).toBe('MID1');
    expect(value!.x - (label!.x + label!.width)).toBeGreaterThanOrEqual(2);
  });
});
