import { can, type IsoDateTime, type Job } from '@/domain';
import type { OperationContext } from './context';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';
import { loadDocumentPhotos } from './document-photos';
import { StorageIntegrityFailed, type FinalDocumentSource, type StoredDocument } from '@/services/ports';

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
 * The current renderer.
 *
 * Bump this whenever the rendered document changes. Bytes written when a Master
 * ISSUED a job card are the historical document and are never re-rendered
 * whatever this says. Bytes written by the backfill below are a cache for
 * history that never had an issue event, and are re-rendered when this changes
 * — otherwise a browser that downloaded a seeded job's card once keeps that
 * first render for good, faults included, which is exactly what happened when
 * the signature was missing from it.
 *
 * v3: dates and times are read in EJE's business zone rather than the local
 * zone of whatever machine rendered them, and a courier's collection document
 * now lists the goods it is a note for.
 *
 * v4: the customer-facing photographs are drawn — the photograph itself, in a
 * grid — where v3 printed only a list of their captions.
 */
export const RENDERER_VERSION = 4;

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
  descriptor: {
    readonly storageKey: string;
    readonly fileName: string;
    readonly generatedAt: IsoDateTime;
  },
  source: FinalDocumentSource,
): Promise<number> => {
  // Stamped with the descriptor's own timestamp, so the file and the record
  // recorded on the job agree to the millisecond. The photographs are read
  // from storage here, on the server, because the job holds only their keys.
  const rendered = await context.services.pdf.render(
    { ...source, photoImages: await loadDocumentPhotos(context.services.storage, source.job) },
    'final',
    descriptor.generatedAt,
  );
  await context.services.storage.putDocument({
    storageKey: descriptor.storageKey,
    fileName: descriptor.fileName,
    contentType: FINAL_DOCUMENT_CONTENT_TYPE,
    bytes: rendered.bytes,
    renderer: RENDERER_VERSION,
    // Issued, not backfilled: these bytes are the historical document and are
    // never re-rendered, however the renderer changes later.
    backfilled: false,
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

  /*
   * DAMAGED BYTES ARE NOT "NO BYTES", AND MUST NOT FALL THROUGH TO THE
   * BACKFILL BELOW. BACKUP-1.
   *
   * The store raises when what is on the disk is not what was written with it.
   * If that were caught and treated as absence, the next few lines would
   * RE-RENDER the document and write it over the damaged file — replacing a
   * customer's signed job card with a new document carrying its date, and
   * destroying the evidence that anything had gone wrong. So it is turned into
   * a refusal the office can read, and nothing is written.
   */
  let stored: StoredDocument | null;
  try {
    stored = await context.services.storage.getDocument(descriptor.storageKey);
  } catch (cause) {
    if (!(cause instanceof StorageIntegrityFailed)) throw cause;
    throw new WorkflowError(`${job.jobNumber}'s job card on file is damaged.`, [
      {
        code: 'document_damaged',
        message:
          'The stored file is not the file that was issued, so it has not been opened. It must ' +
          'be restored from a backup — re-issuing would produce a different document carrying ' +
          'the original date.',
      },
    ]);
  }

  if (stored !== null) {
    const staleBackfill =
      stored.backfilled === true && stored.renderer !== RENDERER_VERSION;
    // An issued document is returned exactly as it was written, always.
    if (!staleBackfill) return stored;
  }

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
  // Stamped with the timestamp already recorded on the job, so this renders
  // byte-identically however many times it is called.
  const rendered = await context.services.pdf.render(
    { ...source, photoImages: await loadDocumentPhotos(context.services.storage, source.job) },
    'final',
    descriptor.generatedAt,
  );
  const document: StoredDocument = {
    storageKey: descriptor.storageKey,
    fileName: descriptor.fileName,
    contentType: FINAL_DOCUMENT_CONTENT_TYPE,
    bytes: rendered.bytes,
    renderer: RENDERER_VERSION,
    backfilled: true,
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
