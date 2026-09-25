import { describe, expect, it } from 'vitest';
import { buildJobCardModel } from './model';
import { loadJobView } from '@/application/job-view';
import { buildHarness } from '@/application/test-harness';
import { pdfPlainText } from '@/lib/pdf/inspect';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { SystemClock } from '@/services/simulated/system';
import type { JobCompletionReport } from '@/domain';

/**
 * WHAT THE CUSTOMER'S JOB CARD PRINTS OF THE WRITE-UP. MASTER SCOPE DOC-1.
 *
 * The rule: a field nobody filled in is not a heading. The document used to
 * print every optional heading with "Not recorded" under it, which reads as
 * four things the technician forgot rather than four things that did not apply
 * — on a document EJE issues to a customer.
 *
 * Work performed is mandatory before a customer may sign, so on any issued
 * document it is always there. Both halves are checked: the MODEL, which is
 * what both renderers read, and the PDF BYTES, which is what is actually
 * handed over.
 */

const EMPTY: JobCompletionReport = {
  faultFindings: '',
  diagnosis: '',
  workPerformed: '',
  recommendations: '',
  generalNotes: '',
};

const modelFor = async (report: Partial<JobCompletionReport>) => {
  const harness = buildHarness();
  const view = await loadJobView(harness.repos, 'EJE-1044');
  return buildJobCardModel({
    job: { ...view!.job, completionReport: { ...EMPTY, ...report } },
    customer: view!.customer,
    site: view!.site,
    contact: view!.contact,
    machine: view!.machine,
    settings: view!.settings,
    checklistTemplate: view!.checklistTemplate,
    users: view!.users,
    generatedAt: '2026-09-25T10:00:00.000Z',
  });
};

const labelsFor = async (report: Partial<JobCompletionReport>): Promise<readonly string[]> =>
  (await modelFor(report)).workBlocks.map((block) => block.label);

describe('the completion write-up on the customer job card', () => {
  it('prints nothing at all when every field is empty', async () => {
    expect(await labelsFor({})).toEqual([]);
  });

  it('prints only Work performed when only Work performed was filled in', async () => {
    expect(await labelsFor({ workPerformed: 'Replaced the cooling fan.' })).toEqual([
      'Work performed',
    ]);
  });

  it('prints one optional field and no heading for the other three', async () => {
    expect(
      await labelsFor({
        workPerformed: 'Replaced the cooling fan.',
        recommendations: 'Budget for a replacement spindle within twelve months.',
      }),
    ).toEqual(['Work performed', 'Recommendations']);
  });

  it('prints several, in the order the document reads', async () => {
    expect(
      await labelsFor({
        faultFindings: 'Coolant pooled under the cabinet.',
        workPerformed: 'Replaced the cooling fan.',
        generalNotes: 'Machine handed back running.',
      }),
    ).toEqual(['Fault findings', 'Work performed', 'General notes']);
  });

  it('prints all five when all five were filled in', async () => {
    expect(
      await labelsFor({
        faultFindings: 'Coolant pooled under the cabinet.',
        diagnosis: 'Failed cooling fan bearing.',
        workPerformed: 'Replaced the cooling fan.',
        recommendations: 'Budget for a replacement spindle.',
        generalNotes: 'Machine handed back running.',
      }),
    ).toEqual([
      'Fault findings',
      'Diagnosis',
      'Work performed',
      'Recommendations',
      'General notes',
    ]);
  });

  it('treats whitespace as empty — a field of spaces is not a section', async () => {
    expect(
      await labelsFor({ workPerformed: 'Replaced the cooling fan.', diagnosis: '   \n  ' }),
    ).toEqual(['Work performed']);
  });

  it('never prints "Not recorded" under a heading again', async () => {
    const model = await modelFor({
      workPerformed: 'Replaced the cooling fan.',
      diagnosis: '',
    });
    expect(model.workBlocks.map((block) => block.value)).not.toContain('Not recorded');
  });

  it('keeps the empty headings off the PDF itself, not just off the model', async () => {
    const harness = buildHarness();
    const view = await loadJobView(harness.repos, 'EJE-1044');
    const clock = new SystemClock();
    const pdf = new SimulatedPdfService(clock);

    const rendered = await pdf.render(
      {
        job: {
          ...view!.job,
          completionReport: {
            ...EMPTY,
            workPerformed: 'Replaced the spindle drive cooling fan and test ran the machine.',
          },
        },
        customer: view!.customer,
        site: view!.site,
        contact: view!.contact,
        machine: view!.machine,
        settings: view!.settings,
        checklistTemplate: view!.checklistTemplate,
        users: view!.users,
      },
      'final',
      '2026-09-25T10:00:00.000Z',
    );

    // The layout sets the headings in capitals, so the assertion reads the
    // text the way the page actually prints it.
    const text = pdfPlainText(rendered.bytes);
    expect(text).toContain('WORK PERFORMED');
    expect(text).toContain('Replaced the spindle drive cooling fan');
    for (const heading of ['FAULT FINDINGS', 'DIAGNOSIS', 'RECOMMENDATIONS', 'GENERAL NOTES']) {
      expect(text).not.toContain(heading);
    }
    expect(text).not.toContain('Not recorded');
  });
});
