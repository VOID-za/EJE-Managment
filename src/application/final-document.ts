import { can, type Job } from '@/domain';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import type { FinalDocumentSource, StoredDocument } from '@/services/ports';

/**
 * The final document on a closed job: retrieval, not generation.
 *
 * The document a customer received is a historical record. It is rendered ONCE,
 * when a Master issues the job card, and its bytes are written to storage under
 * the key recorded on `job.finalDocument`. Every later view or download reads
 * those bytes back.
 *
 * Nothing here writes to the job, appends an audit event or sends an email.
 * Looking at old paperwork is not an event.
 */

export const FINAL_DOCUMENT_CONTENT_TYPE = 'application/pdf';

/**
 * Builds the renderer's input from the job's own stored record.
 *
 * Uses `loadJobView`, which resolves the checklist by the version recorded on
 * the job, and the job carries its frozen pricing snapshot — so the source is
 * the historical record, never today's rates, prices or checklist wording.
 */
const sourceFor = async (
  context: OperationContext,
  jobNumber: string,
): Promise<{ readonly source: FinalDocumentSource; readonly job: Job }> => {
  const view = await loadJobView(context.repos, jobNumber);
  if (view === null) throw new WorkflowError(`No job with the number ${jobNumber} exists.`, []);

  return {
    job: view.job,
    source: {
      job: view.job,
      customer: view.customer,
      site: view.site,
      contact: view.contact,
      machine: view.machine,
      settings: view.settings,
      checklistTemplate: view.checklistTemplate,
      users: view.users,
    },
  };
};

/**
 * Whether this actor may be handed this job's final document.
 *
 * Deliberately the same rule as seeing the job at all: a Master sees every job,
 * a technician sees the jobs they worked. The archive screen is Master-only
 * through `jobs.viewAll` and that is unchanged — this is the per-job check, so
 * a technician cannot pull down a document for a job they were never on.
 */
export const canReadFinalDocument = (job: Job, context: OperationContext): boolean => {
  if (can(context.actor.role, 'jobs.viewAll')) return true;
  return (
    job.primaryTechnicianId === context.actor.id ||
    job.additionalTechnicianIds.includes(context.actor.id)
  );
};

/**
 * Writes the final document's bytes to storage.
 *
 * Called once, from `submitJobCard`, at the moment the Master issues the job
 * card. Returns the true page count so the descriptor stored on the job
 * describes the file that actually exists.
 */
export const storeFinalDocument = async (
  context: OperationContext,
  job: Job,
  descriptor: { readonly storageKey: string; readonly fileName: string },
  source: FinalDocumentSource,
): Promise<number> => {
  const rendered = await context.services.pdf.render(source, 'final');
  await context.services.storage.putDocument({
    storageKey: descriptor.storageKey,
    fileName: descriptor.fileName,
    contentType: FINAL_DOCUMENT_CONTENT_TYPE,
    bytes: rendered.bytes,
  });
  return rendered.pageCount;
};

/**
 * Retrieves the file for a closed job's final document.
 *
 * Resolved from the JOB, never from a caller-supplied storage key: a request
 * names a job number, and the only file it can ever return is the one recorded
 * on that job.
 */
export const loadFinalDocumentFile = async (
  context: OperationContext,
  jobNumber: string,
): Promise<StoredDocument> => {
  const { job, source } = await sourceFor(context, jobNumber);

  if (!canReadFinalDocument(job, context)) {
    throw new WorkflowError(`You cannot open the job card for ${job.jobNumber}.`, [
      { code: 'not_permitted', message: 'Only the office and the technicians on this job can.' },
    ]);
  }

  const descriptor = job.finalDocument;
  if (descriptor === null) {
    throw new WorkflowError(`${job.jobNumber} has no final job card on file.`, [
      {
        code: 'no_final_document',
        message: 'A final job card exists only once a Master has issued and closed the job.',
      },
    ]);
  }

  const stored = await context.services.storage.getDocument(descriptor.storageKey);
  if (stored !== null) return stored;

  /*
   * No bytes yet. This is the seeded history: those jobs were closed before
   * this demonstration started, so there was never a moment at which a file
   * could be written for them, and a seed cannot ship binary content.
   *
   * Rendering here is a one-time backfill, NOT a regeneration: it renders from
   * the job's own frozen record — snapshot pricing, the checklist version
   * recorded on the job, the captured signature — so the result is the document
   * as issued, and it is written to storage so every subsequent download reads
   * the same bytes. The job itself is not touched, and no audit event is
   * written: this is a read.
   */
  const rendered = await context.services.pdf.render(source, 'final');
  const document: StoredDocument = {
    storageKey: descriptor.storageKey,
    fileName: descriptor.fileName,
    contentType: FINAL_DOCUMENT_CONTENT_TYPE,
    bytes: rendered.bytes,
  };
  await context.services.storage.putDocument(document);
  return document;
};

/** The job ids whose final document is already on disk. For tests and tooling. */
export const hasStoredFinalDocument = async (
  context: OperationContext,
  job: Job,
): Promise<boolean> => {
  if (job.finalDocument === null) return false;
  return (await context.services.storage.getDocument(job.finalDocument.storageKey)) !== null;
};
