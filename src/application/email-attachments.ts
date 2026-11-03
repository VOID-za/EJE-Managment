import { EMAIL_ATTACHMENTS_MAX_BYTES, type CustomerEmailAttachment, type Job } from '@/domain';
import { jobAttachmentProblem } from '@/lib/upload-limits';
import type { AppServices } from './context';

/**
 * WHAT TRAVELS WITH A JOB CARD EMAIL, AND WHEN IT MAY NOT. JOB-ATT-3, UNSIGNED-ATT-1.
 *
 * The signed job card email (JOB-ATT-3, 2 November 2026) carries the documents
 * the office chose on the job. The unsigned copy a Senior Tech authorises
 * (BD-06) carried only the PDF; since 3 November 2026 it carries the same
 * documents, chosen the same way and held to the same rules. The selection and
 * the checks live here so the two paths cannot drift apart.
 */

/** The job's documents selected for the customer email, as an email records them. */
export const selectedCustomerDocuments = (job: Job): CustomerEmailAttachment[] =>
  job.attachments
    .filter((attachment) => attachment.emailToCustomer === true)
    .map((attachment) => ({ storageKey: attachment.storageKey, fileName: attachment.fileName, sha256: attachment.checksumSha256 }));

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export type EmailDocumentProblemCode =
  | 'attachment_missing'
  | 'attachment_changed'
  | 'attachment_invalid'
  | 'attachment_too_large';

export interface EmailDocumentProblem {
  readonly code: EmailDocumentProblemCode;
  readonly message: string;
}

const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);

/**
 * Why this job card and these documents cannot go out in one email, or null.
 *
 * Every file is read from storage and checked BEFORE anything is handed to the
 * provider: present, still a document a job may carry (the upload rule), still
 * the bytes that were chosen (the checksum), and all of it within what one
 * email can carry. Any one failing means nothing is sent — a selected document
 * is never silently left off.
 */
export const emailDocumentsProblem = async (
  services: Pick<AppServices, 'storage'>,
  jobCard: CustomerEmailAttachment,
  jobCardLabel: string,
  extras: readonly CustomerEmailAttachment[],
): Promise<EmailDocumentProblem | null> => {
  let total = 0;
  for (const extra of extras) {
    const stored = await services.storage.getDocument(extra.storageKey).catch(() => null);
    if (stored === null) {
      return {
        code: 'attachment_missing',
        message: `${extra.fileName} could not be read from storage. Nothing was sent: take it off the customer email, or attach it again, and retry.`,
      };
    }
    const invalid = jobAttachmentProblem({ name: extra.fileName, type: stored.contentType, size: stored.bytes.length });
    if (invalid !== null) {
      return {
        code: 'attachment_invalid',
        message: `${invalid} Nothing was sent: take it off the customer email and retry.`,
      };
    }
    if (extra.sha256 !== null) {
      const actual = stored.sha256 ?? (await sha256Hex(stored.bytes));
      if (actual.toLowerCase() !== extra.sha256.toLowerCase()) {
        return {
          code: 'attachment_changed',
          message: `${extra.fileName} no longer matches the document that was chosen for the customer. Nothing was sent: attach it again and retry.`,
        };
      }
    }
    total += stored.bytes.length;
  }
  const stored = await services.storage.getDocument(jobCard.storageKey).catch(() => null);
  if (stored === null) {
    return { code: 'attachment_missing', message: `The ${jobCardLabel} PDF could not be read from storage, so nothing was sent.` };
  }
  if (jobCard.sha256 !== null) {
    const actual = stored.sha256 ?? (await sha256Hex(stored.bytes));
    if (actual.toLowerCase() !== jobCard.sha256.toLowerCase()) {
      return { code: 'attachment_changed', message: `The stored PDF no longer matches the ${jobCardLabel}, so nothing was sent.` };
    }
  }
  total += stored.bytes.length;
  if (extras.length > 0 && total > EMAIL_ATTACHMENTS_MAX_BYTES) {
    return {
      code: 'attachment_too_large',
      message:
        `The ${jobCardLabel} and the ${extras.length} selected document(s) come to ${megabytes(total)} MB; one email can carry at most ` +
        `${megabytes(EMAIL_ATTACHMENTS_MAX_BYTES)} MB of attachments. Nothing was sent. Select fewer or smaller documents for the customer and retry, or send them separately.`,
    };
  }
  return null;
};
