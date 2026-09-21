import 'server-only';
import type { UploadedFile } from '@/services/ports';
import { ApiError } from './errors';

/**
 * What the server will accept as a file, decided by the server.
 *
 * NOTHING HERE TRUSTS THE BROWSER. The declared content type, the extension and
 * the declared size all arrive from the client and all three are ignored for
 * the purpose of deciding what the file IS. The bytes are sniffed and the
 * length is measured. A `.pdf` name on a Windows executable is refused by the
 * only part of the request that cannot be edited: its first few bytes.
 *
 * WHY THE LIST IS SHORT. These are the documents EJE attach to a job — a
 * customer's order, a quote, a drawing, a photograph of a nameplate. Every
 * format on it has a stable magic number, which is what makes sniffing
 * possible. Adding a format means adding a signature, deliberately.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The canonical type for a shape of bytes. `null` means "not on the list". */
interface Signature {
  readonly contentType: string;
  readonly extension: string;
  /** Bytes that must appear at `offset` for the file to be this type. */
  readonly magic: readonly number[];
  readonly offset: number;
}

const SIGNATURES: readonly Signature[] = [
  // %PDF-
  { contentType: 'application/pdf', extension: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d], offset: 0 },
  // PNG
  { contentType: 'image/png', extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], offset: 0 },
  // JPEG — SOI plus the marker that starts every variant.
  { contentType: 'image/jpeg', extension: 'jpg', magic: [0xff, 0xd8, 0xff], offset: 0 },
  // TIFF, little- and big-endian. Scanned orders still arrive this way.
  { contentType: 'image/tiff', extension: 'tif', magic: [0x49, 0x49, 0x2a, 0x00], offset: 0 },
  { contentType: 'image/tiff', extension: 'tif', magic: [0x4d, 0x4d, 0x00, 0x2a], offset: 0 },
];

/** WEBP is RIFF....WEBP: two checks at two offsets, so it gets its own arm. */
const isWebp = (bytes: Uint8Array): boolean =>
  bytes.length >= 12 &&
  bytes[0] === 0x52 &&
  bytes[1] === 0x49 &&
  bytes[2] === 0x46 &&
  bytes[3] === 0x46 &&
  bytes[8] === 0x57 &&
  bytes[9] === 0x45 &&
  bytes[10] === 0x42 &&
  bytes[11] === 0x50;

const matches = (bytes: Uint8Array, signature: Signature): boolean =>
  signature.magic.every((byte, index) => bytes[signature.offset + index] === byte);

/** The type these bytes actually are, or null if it is not one EJE accept. */
export const sniffContentType = (bytes: Uint8Array): Signature | null => {
  if (isWebp(bytes)) return { contentType: 'image/webp', extension: 'webp', magic: [], offset: 0 };
  return SIGNATURES.find((signature) => matches(bytes, signature)) ?? null;
};

export const ACCEPTED_CONTENT_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/webp',
];

/**
 * A file name safe to record and safe to hand back in a download header.
 *
 * NOT A PATH, and never used as one: the storage key is generated and the name
 * is metadata. This still strips directory separators and control characters,
 * because the name is echoed in `Content-Disposition` and written to a database
 * row, and a name carrying a newline can forge a header.
 */
export const safeFileName = (raw: string): string => {
  const base = raw.split(/[/\\]/u).pop() ?? '';
  const cleaned = base
    // Control characters, quotes and the separators a header would misread.
    .replace(/[\u0000-\u001f\u007f"';\\]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

  // A name that was nothing but path and punctuation still has to be called
  // something, and "document" is honest about knowing nothing more.
  return cleaned.length === 0 ? 'document' : cleaned.slice(0, 200);
};

/** Returns the error rather than throwing it, so `throw refuse(...)` narrows. */
const refuse = (message: string, code: string, detail: string): ApiError =>
  new ApiError('validation_failed', message, [{ code, message: detail }]);

export interface UploadCandidate {
  readonly fileName: string;
  /** What the browser CLAIMED. Recorded for the audit trail, never believed. */
  readonly declaredContentType: string;
  readonly bytes: Uint8Array;
}

/**
 * Validates an upload and returns what it actually is.
 *
 * The returned `contentType` is the SNIFFED one, so what is stored and what is
 * later served are both the server's finding rather than the client's claim.
 */
export const validateUpload = (candidate: UploadCandidate): UploadedFile => {
  if (candidate.bytes.length === 0) {
    throw refuse('That file is empty.', 'empty_file', 'An empty file has nothing to attach.');
  }
  if (candidate.bytes.length > MAX_UPLOAD_BYTES) {
    throw refuse(
      'That file is too large.',
      'file_too_large',
      `Attachments are limited to ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`,
    );
  }

  const sniffed = sniffContentType(candidate.bytes);
  if (sniffed === null) {
    /*
     * The message names the formats rather than what was sent.
     *
     * Telling somebody "that is a ZIP" is telling whoever is probing exactly
     * what the sniffer understood, and it is no help to the person with a
     * spreadsheet in their hand either.
     */
    throw refuse(
      'That file type cannot be attached.',
      'unsupported_file_type',
      'Attach a PDF or an image (PNG, JPEG, TIFF or WebP).',
    );
  }

  return {
    fileName: safeFileName(candidate.fileName),
    contentType: sniffed.contentType,
    bytes: candidate.bytes,
  };
};
