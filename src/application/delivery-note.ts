import {
  isJobAtOrPastCompletion,
  requiresDeliveryNote,
  type IsoDateTime,
  type IssuedDeliveryNote,
  type Job,
} from '@/domain';
import {
  buildDeliveryNoteModel,
  deliveryNoteFileName,
  deliveryNoteUnavailable,
  type DeliveryNoteInput,
} from '@/lib/job-card/delivery-note';
import { sha256Hex } from '@/lib/job-card/document-identity';
import { renderDeliveryNotePdf } from '@/services/simulated/delivery-note-pdf';
import type { OperationContext } from './context';
import { audit } from './audit';
import { WorkflowError } from './errors';
import { loadJobView } from './job-view';

/**
 * THE COURIER'S DELIVERY NOTE. PARTS-03, PARTS-04, PARTS-05, and the owner's
 * decisions of 28 October 2026.
 *
 * TWO DOCUMENTS, ONE SIGNATURE. A courier collection has the priced job card
 * (to the customer and the office) and the price-less Delivery Note (to the
 * courier). The courier signs ONCE, on the Delivery Note; that is the job's
 * signature, and the priced job card carries it with a note saying where it
 * was given. Nothing here fabricates a second signing act.
 *
 * ISSUED TOGETHER. When the job card is issued (`renderAndStoreFinalDocument`)
 * the Delivery Note is rendered, stored, read back and recorded in the same
 * operation — write-once, one per job, tied to the job card's storage key and
 * to the SHA-256 of the one signature. If it cannot be stored, the issue is
 * refused: a handover is never reported done with a document missing.
 */

const CONTENT_TYPE = 'application/pdf';

/** Where an issued Delivery Note's bytes live: beside the job card it goes with. */
export const deliveryNoteStorageKey = (jobCardStorageKey: string): string =>
  `${jobCardStorageKey.replace(/\.pdf$/u, '')}-delivery-note.pdf`;

/**
 * Renders, stores, proves and records the Delivery Note issued with a courier
 * collection's job card. Idempotent: a note already on file is returned as it
 * is, so a retried issue never writes a second one.
 */
export const issueDeliveryNote = async (
  context: OperationContext,
  input: DeliveryNoteInput,
  jobCardStorageKey: string,
  generatedAt: IsoDateTime,
): Promise<IssuedDeliveryNote> => {
  const { job } = input;
  const existing = await context.repos.deliveryNotes.findByJob(job.id);
  if (existing !== null) return existing;

  const rendered = renderDeliveryNotePdf(buildDeliveryNoteModel(input, generatedAt));
  const storageKey = deliveryNoteStorageKey(jobCardStorageKey);
  const fileName = deliveryNoteFileName(job);
  await context.services.storage.putDocument({
    storageKey,
    fileName,
    contentType: CONTENT_TYPE,
    bytes: rendered.bytes,
    renderer: 1,
    backfilled: false,
  });
  const stored = await context.services.storage.getDocument(storageKey);
  if (stored === null || stored.bytes.byteLength === 0) {
    throw new WorkflowError(`${job.jobNumber} could not be issued.`, [
      {
        code: 'delivery_note_not_stored',
        message:
          'The courier’s Delivery Note could not be stored, so neither document was issued. Try again.',
      },
    ]);
  }

  const note = await context.repos.deliveryNotes.record({
    id: context.services.ids.next('dln'),
    jobId: job.id,
    fileName,
    storageKey,
    pageCount: rendered.pageCount,
    sizeBytes: stored.sizeBytes ?? stored.bytes.byteLength,
    checksumSha256: stored.sha256 ?? null,
    generatedAt,
    generatedBy: context.actor.id,
    jobCardDocumentKey: jobCardStorageKey,
    signedByName:
      job.signature === null ? null : `${job.signature.customerName} ${job.signature.customerSurname}`,
    signedAt: job.signature?.signedAt ?? null,
    signatureSha256:
      job.signature === null ? null : await sha256Hex(new TextEncoder().encode(job.signature.strokeData)),
  });
  await audit(context, {
    jobId: job.id,
    type: 'delivery_note_generated',
    summary: `Delivery note issued with the job card for ${job.jobNumber}`,
    detail:
      `${fileName} (${rendered.pageCount} page${rendered.pageCount === 1 ? '' : 's'}), no prices, stored beside the priced job card. ` +
      (note.signedByName === null
        ? 'Not signed by a courier.'
        : `Signed once by ${note.signedByName} on the Delivery Note; the same signature is on the job card.`),
  });
  return note;
};

/**
 * The courier's Delivery Note for the office or the technician to print.
 *
 * Once issued, the STORED note is returned exactly as it was written — never
 * re-rendered. Before issue it is rendered from the job as it stands (with the
 * courier's signature once taken). Same visibility rule as every job action; a
 * courier collection at or past completion only; the job and its job card are
 * never changed. Each one produced is on the activity trail.
 */
export const generateDeliveryNote = async (
  context: OperationContext,
  job: Job,
): Promise<{ fileName: string; contentType: 'application/pdf'; base64: string; issued: boolean }> => {
  const unavailable = deliveryNoteUnavailable(job);
  if (unavailable !== null) {
    throw new WorkflowError(`${job.jobNumber} has no delivery note.`, [
      { code: 'delivery_note_not_applicable', message: unavailable },
    ]);
  }
  if (!isJobAtOrPastCompletion(job.status)) {
    throw new WorkflowError(`${job.jobNumber} has not been completed yet.`, [
      {
        code: 'job_not_completed',
        message: 'The delivery note is produced at the collection, once the work is finished.',
      },
    ]);
  }

  const issued = await context.repos.deliveryNotes.findByJob(job.id);
  if (issued !== null) {
    const stored = await context.services.storage.getDocument(issued.storageKey);
    if (stored === null) {
      throw new WorkflowError(`${job.jobNumber}'s issued delivery note is not in storage.`, [
        {
          code: 'delivery_note_missing',
          message: 'The issued Delivery Note must be restored from a backup; it is never re-rendered.',
        },
      ]);
    }
    await audit(context, {
      jobId: job.id,
      type: 'delivery_note_generated',
      summary: `Issued delivery note opened for ${job.jobNumber}`,
      detail: `${issued.fileName}, as issued ${issued.generatedAt}. The job card is unchanged.`,
    });
    return {
      fileName: issued.fileName,
      contentType: 'application/pdf',
      base64: Buffer.from(stored.bytes).toString('base64'),
      issued: true,
    };
  }

  const view = await loadJobView(context.repos, job.jobNumber, context.actor);
  if (view === null) throw new WorkflowError(`${job.jobNumber} could not be loaded.`);
  const generatedAt = context.services.clock.now();
  const model = buildDeliveryNoteModel(view, generatedAt);
  const rendered = renderDeliveryNotePdf(model);
  await audit(context, {
    jobId: job.id,
    type: 'delivery_note_generated',
    summary: `Delivery note produced for ${job.jobNumber}`,
    detail: `${model.items.length} item line${model.items.length === 1 ? '' : 's'}, no prices. Not yet issued; the job card is unchanged.`,
  });
  return {
    fileName: deliveryNoteFileName(job),
    contentType: 'application/pdf',
    base64: Buffer.from(rendered.bytes).toString('base64'),
    issued: false,
  };
};

/** Whether this job's issue must also issue a Delivery Note. */
export const issuesDeliveryNote = (job: Job): boolean => requiresDeliveryNote(job);
