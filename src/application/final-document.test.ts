import { beforeEach, describe, expect, it } from 'vitest';
import {
  FINAL_DOCUMENT_CONTENT_TYPE,
  canReadFinalDocument,
  loadFinalDocumentFile,
} from './final-document';
import {
  acceptJob,
  addLabour,
  captureSignature,
  saveCompletionReport,
  startCompletion,
  startSignature,
  issueJobCard,
} from './job-operations';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import { buildHarness, confirmDelivery, seedUser, type Harness } from './test-harness';
import { pdfPlainText } from '@/lib/pdf/inspect';
import type { Job } from '@/domain';

/**
 * Downloading a closed job's final document.
 *
 * The bug this covers: "Download Final PDF" opened the browser print dialog
 * instead of downloading a file, because no PDF ever existed — the PDF service
 * only produced a descriptor and storage discarded whatever it was handed. The
 * document is now rendered once, at issue, and written to storage; a download
 * reads those bytes back.
 *
 * So these assert the file, not the button: real PDF bytes, the stored name,
 * the same bytes every time, and nothing written to the job for looking at it.
 */

const master = seedUser('user-master-elmarie');
const technician = seedUser('user-tech-sipho');
const otherTechnician = seedUser('user-tech-deon');

const asText = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

/** EJE-1048 worked, signed, handed over and issued — a job closed in-session. */
const closeJob = async (harness: Harness): Promise<Job> => {
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
  /*
   * THE MASTER ISSUES IT. MASTER SCOPE §3.1, §7, §15.
   *
   * The technician's part ends at the signature: the job reaches the office at
   * Review and waits. Only `jobs.issueFinal` — the Master's alone — renders the
   * customer's copy and sends it, and the job closes only once the provider
   * confirms delivery.
   */
  const result = await issueJobCard(
    harness.as(master),
    job,
    'pieter.nel@abc-engineering-demo.co.za',
    'Pieter Nel',
  );
  return confirmDelivery(harness, harness.as(master), result.job);
};

describe('a closed job has a downloadable final document', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('has a final document recorded on it', async () => {
    const closed = await closeJob(harness);
    expect(closed.status).toBe('closed');
    expect(closed.finalDocument).not.toBeNull();
    expect(closed.finalDocument?.fileName).toBe('EJE-1048-Final-Job-Card.pdf');
  });

  it('serves the file under the name stored on the job', async () => {
    const closed = await closeJob(harness);
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    expect(file.fileName).toBe(closed.finalDocument?.fileName);
    expect(file.fileName).toBe('EJE-1048-Final-Job-Card.pdf');
    expect(file.storageKey).toBe(closed.finalDocument?.storageKey);
  });

  it('serves it as a PDF, not HTML', async () => {
    await closeJob(harness);
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    expect(file.contentType).toBe('application/pdf');
    expect(FINAL_DOCUMENT_CONTENT_TYPE).toBe('application/pdf');
  });

  it('serves actual PDF bytes, which a viewer would accept', async () => {
    await closeJob(harness);
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    const text = asText(file.bytes);

    expect(file.bytes.byteLength).toBeGreaterThan(1000);
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    // Not an HTML page wearing a .pdf name, which is what a hand-rolled Blob
    // of reconstructed markup would have been.
    expect(text).not.toContain('<html');
    expect(text).not.toContain('<!DOCTYPE');
  });

  it('carries the job card content, from the job as it was issued', async () => {
    await closeJob(harness);
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    const text = asText(file.bytes);

    // Extracted the way a reader sees it: PDF escapes brackets inside string
    // literals, so a raw byte search misses "ABC Engineering (Pty) Ltd".
    const plain = pdfPlainText((await loadFinalDocumentFile(harness.as(master), 'EJE-1048')).bytes);
    for (const value of [
      'EJE-1048',
      'EJE Industrial Electronics',
      'ABC Engineering (Pty) Ltd',
      'Johannesburg',
      'LW-V40-70214',
      'Replaced the spindle drive cooling fan.',
      'Pieter Nel',
    ]) {
      expect(plain, `the PDF does not carry ${value}`).toContain(value);
    }
    expect(text.startsWith('%PDF-')).toBe(true);
  });

  it('draws the captured signature geometry, not a typeset name', async () => {
    await closeJob(harness);
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    const text = asText(file.bytes);

    // The path operators the signature strokes produce, stroked in pure black.
    expect(text).toMatch(/[\d.]+ [\d.]+ m/);
    expect(text).toMatch(/[\d.]+ [\d.]+ l/);
    expect(text).toContain('0 0 0 RG');
  });
});

describe('a download returns the issued document, unchanged', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('returns identical bytes every time', async () => {
    await closeJob(harness);
    const first = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    const second = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    const third = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
    expect(Array.from(third.bytes)).toEqual(Array.from(first.bytes));
  });

  it('does not add a second pdf_generated audit event', async () => {
    const closed = await closeJob(harness);
    const generatedEvents = async (): Promise<number> =>
      (await harness.repos.activity.list(closed.id)).filter(
        (event) => event.type === 'pdf_generated',
      ).length;

    const atClose = await generatedEvents();
    // Exactly one: issuing the job card generated the document.
    expect(atClose).toBe(1);

    await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    expect(await generatedEvents()).toBe(1);
  });

  it('adds no audit event of any kind, because looking is not an event', async () => {
    const closed = await closeJob(harness);
    const before = await harness.repos.activity.list(closed.id);

    await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    expect(await harness.repos.activity.list(closed.id)).toHaveLength(before.length);
  });

  it('does not email the customer again', async () => {
    await closeJob(harness);
    const emails = (): number =>
      harness.outbox.listSync().filter((entry) => entry.channel === 'email').length;

    // One: the Master issued the job card.
    expect(emails()).toBe(1);

    await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    expect(emails()).toBe(1);
  });

  it('does not modify the closed job', async () => {
    const closed = await closeJob(harness);
    await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    const reread = await harness.repos.jobs.findByJobNumber('EJE-1048');
    expect(reread).toEqual(closed);
  });

  it('is unaffected by a rate change after closure', async () => {
    await closeJob(harness);
    const before = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');

    await harness.repos.settings.save({
      ...(await harness.repos.settings.get()),
      labourRates: { normal: 250000, overtime: 375000, double: 500000 },
      calloutRate: 200000,
      kilometreRate: 5000,
      vatPercentage: 25,
    });

    const after = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    // Byte for byte: the file was written at issue and is read back, so a rate
    // change cannot reach it even in principle.
    expect(Array.from(after.bytes)).toEqual(Array.from(before.bytes));
    expect(asText(after.bytes)).not.toContain('R 2 500,00');
  });

  it('reports the page count of the file that actually exists', async () => {
    const closed = await closeJob(harness);
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1048');
    const declared = /\/Count (\d+)/.exec(asText(file.bytes))?.[1];

    expect(declared).toBeDefined();
    expect(closed.finalDocument?.pageCount).toBe(Number(declared));
  });
});

describe('seeded closed jobs, which were issued before this demonstration', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('serves a final document for every one of them', async () => {
    for (const jobNumber of ['EJE-1056', 'EJE-1057', 'EJE-1062', 'EJE-1044', 'EJE-1039']) {
      const file = await loadFinalDocumentFile(harness.as(master), jobNumber);
      expect(asText(file.bytes).startsWith('%PDF-'), jobNumber).toBe(true);
      expect(file.contentType, jobNumber).toBe('application/pdf');
    }
  });

  it('matches the page count recorded on each job', async () => {
    for (const jobNumber of ['EJE-1056', 'EJE-1057', 'EJE-1062', 'EJE-1044', 'EJE-1039']) {
      const job = await harness.repos.jobs.findByJobNumber(jobNumber);
      const file = await loadFinalDocumentFile(harness.as(master), jobNumber);
      const declared = /\/Count (\d+)/.exec(asText(file.bytes))?.[1];
      expect(Number(declared), jobNumber).toBe(job?.finalDocument?.pageCount);
    }
  });

  it('names a parts collection a collection note, not a job card', async () => {
    const file = await loadFinalDocumentFile(harness.as(master), 'EJE-1062');
    expect(file.fileName).toBe('EJE-1062-Final-Parts-Collection-Note.pdf');
  });

  it('renders EJE-1044 at the rates and checklist version it was issued at', async () => {
    const text = asText((await loadFinalDocumentFile(harness.as(master), 'EJE-1044')).bytes);

    // The snapshot rate on the job, not the seeded current rate of R 950,00.
    expect(text).toContain('R 820,00');
    expect(text).not.toContain('R 950,00');
    expect(text).toContain('1.0-DEMO');
  });

  it('keeps serving the same bytes once written, after a rate change', async () => {
    const before = await loadFinalDocumentFile(harness.as(master), 'EJE-1044');
    await harness.repos.settings.save({
      ...(await harness.repos.settings.get()),
      labourRates: { normal: 250000, overtime: 375000, double: 500000 },
    });
    const after = await loadFinalDocumentFile(harness.as(master), 'EJE-1044');
    expect(Array.from(after.bytes)).toEqual(Array.from(before.bytes));
  });
});

describe('who may download a final document', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('lets a Master download any job', async () => {
    await closeJob(harness);
    await expect(loadFinalDocumentFile(harness.as(master), 'EJE-1048')).resolves.toBeDefined();
  });

  it('lets a technician download a job they worked', async () => {
    const closed = await closeJob(harness);
    expect(closed.primaryTechnicianId).toBe(technician.id);
    await expect(
      loadFinalDocumentFile(harness.as(technician), 'EJE-1048'),
    ).resolves.toBeDefined();
  });

  it('refuses a technician who was never on the job', async () => {
    const closed = await closeJob(harness);
    expect(canReadFinalDocument(closed, harness.as(otherTechnician))).toBe(false);
    await expect(
      loadFinalDocumentFile(harness.as(otherTechnician), 'EJE-1048'),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('resolves the file from the job, so another job cannot be reached', async () => {
    // A caller names a job number; it can never name a storage key. EJE-1044's
    // file is served for EJE-1044 and nothing else.
    const forOne = await loadFinalDocumentFile(harness.as(master), 'EJE-1044');
    const forAnother = await loadFinalDocumentFile(harness.as(master), 'EJE-1056');

    expect(forOne.storageKey).toBe('jobcards/final/EJE-1044.pdf');
    expect(forAnother.storageKey).toBe('jobcards/final/EJE-1056.pdf');
    expect(asText(forOne.bytes)).toContain('EJE-1044');
    expect(asText(forAnother.bytes)).not.toContain('EJE-1044');
  });

  it('refuses a job that has not been issued, rather than inventing a document', async () => {
    // EJE-1048 is seeded open: there is no final job card to hand over.
    await expect(loadFinalDocumentFile(harness.as(master), 'EJE-1048')).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });

  it('refuses a job number that does not exist', async () => {
    await expect(loadFinalDocumentFile(harness.as(master), 'EJE-9999')).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });
});
