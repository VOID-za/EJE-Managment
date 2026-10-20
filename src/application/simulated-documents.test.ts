import { beforeEach, describe, expect, it } from 'vitest';
import { loadFinalDocumentFile } from './final-document';
import {
  acceptJob,
  addLabour,
  captureSignature,
  issueJobCard,
  saveCompletionReport,
  startCompletion,
  startSignature,
} from './job-operations';
import { loadJobView } from './job-view';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { pdfPageTexts, pdfPlainText } from '@/lib/pdf/inspect';
import { SIMULATED_NOTICE_PRINT } from '@/domain';
import type { Job } from '@/domain';

/**
 * A DEMONSTRATION DOCUMENT SAYS SO IN THE FILE, NOT ONLY ON THE SCREEN.
 * October mandate §1.1.
 *
 * The screen's badge disappears the moment a PDF is downloaded, emailed,
 * printed or filed — and a demonstration job card on somebody's desk, looking
 * exactly like an issued one, is the most expensive confusion this system could
 * create: a job card is the document a customer signs and a dispute is settled
 * by.
 *
 * So the stamp is in the bytes, on EVERY page. The two tests that matter are
 * the pair: a demonstration job card carries it everywhere, and a real one
 * carries it nowhere — because a stamp on a genuine document would be as bad a
 * lie in the other direction.
 */
const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');

describe('the stamp on a demonstration job card', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness();
  });

  const seededJobCard = async (): Promise<Job> => {
    const jobs = await harness.repos.jobs.list();
    const job = jobs.find((candidate) => candidate.finalDocument !== null);
    expect(job, 'the demonstration data carries no issued job card').toBeDefined();
    // The seed marks its own job cards, and nothing else does.
    expect(job?.finalDocument?.provenance).toBe('simulated');
    return job!;
  };

  it('is on EVERY page of a seeded job card', async () => {
    const job = await seededJobCard();
    const file = await loadFinalDocumentFile(harness.as(master), job.jobNumber);

    const pages = pdfPageTexts(file.bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const [index, text] of pages.entries()) {
      expect(text, `page ${index + 1} of ${job.jobNumber} carries no stamp`).toContain(
        SIMULATED_NOTICE_PRINT,
      );
    }
  });

  it('says the whole sentence, not an abbreviation', async () => {
    const job = await seededJobCard();
    const file = await loadFinalDocumentFile(harness.as(master), job.jobNumber);

    // A reader who has never seen this system has to understand it from the
    // page alone, which "DEMO" does not achieve.
    expect(pdfPlainText(file.bytes)).toContain('NOT A GENUINE EJE DOCUMENT');
  });

  /**
   * AND A REAL JOB CARD CARRIES NOTHING. The job is taken all the way through
   * the workflow here rather than faked, because the document under test is the
   * one the issue path produces.
   */
  it('is on NO page of a job card EJE actually issues', async () => {
    // Worked, signed and issued in-session through the real operations, so the
    // document under test is the one the issue path produces.
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
    job = await captureSignature(tech, job, {
      customerName: 'Pieter',
      customerSurname: 'Nel',
      strokeData: 'M0.100,0.600 L0.300,0.200 L0.500,0.700 L0.800,0.300',
    });
    const issued = await issueJobCard(
      tech,
      job,
      'pieter.nel@abc-engineering-demo.co.za',
      'Pieter Nel',
    );

    // Recorded as EJE's own document by the issue path, not by this test.
    expect(issued.job.finalDocument?.provenance).toBe('genuine');

    const file = await loadFinalDocumentFile(harness.as(master), issued.job.jobNumber);
    const pages = pdfPageTexts(file.bytes);
    expect(pages.length).toBeGreaterThan(0);
    for (const [index, text] of pages.entries()) {
      expect(text, `page ${index + 1} of a genuine job card is stamped`).not.toContain(
        SIMULATED_NOTICE_PRINT,
      );
    }
  });
});
