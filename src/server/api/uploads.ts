import 'server-only';
import type { UploadedFile } from '@/services/ports';
import { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES, megabytes } from '@/lib/upload-limits';
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
/*
 * THE LIMITS COME FROM `@/lib/upload-limits`, and are re-exported here so
 * every caller that already imports them from this module keeps working.
 *
 * They moved because a limit has to be SAID ON A SCREEN before somebody
 * records a two-minute video or picks a 40 MB scan, and this module is
 * `server-only`. One definition, used by the rule and by the sentence that
 * explains it.
 */
export { MAX_UPLOAD_BYTES, MAX_VIDEO_BYTES };

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

/**
 * VIDEO CONTAINERS. MEDIA-5.
 *
 * WHAT A PHONE ACTUALLY PRODUCES, which is the only list worth having: an
 * Android camera writes MP4, an iPhone writes QuickTime, an older Android
 * writes 3GP, and a browser's own recorder writes WebM. Nothing else is
 * accepted, for the same reason the document list is short — a format with no
 * stable magic number cannot be sniffed, and a type that cannot be sniffed can
 * only be taken on the browser's word.
 *
 * MP4, MOV AND 3GP ARE ALL ISO BASE MEDIA FILES: four bytes of box length,
 * then `ftyp`, then a four-character brand. So the check is `ftyp` at offset 4
 * and the brand decides which it is — `isom`/`mp4`/`avc1`/`M4V` for MP4,
 * `qt  ` for QuickTime, `3gp` for 3GP. A brand nobody recognises is refused
 * rather than guessed at.
 *
 * WHY THE BRAND MATTERS AND NOT JUST `ftyp`: the same container carries audio
 * (`M4A`) and images (`heic`, `avif`). Accepting any `ftyp` would let an HEIC
 * photograph be filed as a video, which is a tile that will not play.
 */
const ISO_BRANDS: readonly { readonly prefix: string; readonly contentType: string; readonly extension: string }[] = [
  { prefix: 'isom', contentType: 'video/mp4', extension: 'mp4' },
  { prefix: 'iso2', contentType: 'video/mp4', extension: 'mp4' },
  { prefix: 'mp41', contentType: 'video/mp4', extension: 'mp4' },
  { prefix: 'mp42', contentType: 'video/mp4', extension: 'mp4' },
  { prefix: 'avc1', contentType: 'video/mp4', extension: 'mp4' },
  { prefix: 'M4V', contentType: 'video/mp4', extension: 'mp4' },
  { prefix: 'dash', contentType: 'video/mp4', extension: 'mp4' },
  { prefix: 'qt', contentType: 'video/quicktime', extension: 'mov' },
  { prefix: '3gp', contentType: 'video/3gpp', extension: '3gp' },
  { prefix: '3g2', contentType: 'video/3gpp', extension: '3gp' },
];

/** `ftyp` at offset 4, then a brand this accepts. */
const sniffIsoMedia = (bytes: Uint8Array): Signature | null => {
  if (bytes.length < 12) return null;
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return null;

  const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
  const match = ISO_BRANDS.find((candidate) => brand.startsWith(candidate.prefix));
  if (match === undefined) return null;
  return { contentType: match.contentType, extension: match.extension, magic: [], offset: 0 };
};

/** Matroska and WebM both open with the EBML header `1A 45 DF A3`. */
const isMatroska = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x1a &&
  bytes[1] === 0x45 &&
  bytes[2] === 0xdf &&
  bytes[3] === 0xa3;

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
  if (isMatroska(bytes)) return { contentType: 'video/webm', extension: 'webm', magic: [], offset: 0 };
  const iso = sniffIsoMedia(bytes);
  if (iso !== null) return iso;
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
 * The subset a PHOTOGRAPH may be. PWA-3.
 *
 * A camera capture is an image and nothing else. The document path accepts a
 * PDF because a customer's order arrives as one; a photograph of a machine does
 * not, and an endpoint that would take one is an endpoint that will eventually
 * be handed one by mistake. Both lists are sniffed, never declared.
 */
export const PHOTO_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/tiff',
  'image/webp',
];

/**
 * The subset a VIDEO may be. MEDIA-5.
 *
 * THE SIZE LIMIT IS AN ENGINEERING ONE AND IS NOT A BUSINESS RULE. Nobody at
 * EJE has said how long a clip may be, and nothing here decides it; what
 * `MAX_VIDEO_BYTES` decides is how much a single request may occupy, which is
 * a question about this server rather than about EJE's practice. The reasoning
 * for the number, including why it is also a memory budget, is in
 * `@/lib/upload-limits`.
 */
export const VIDEO_CONTENT_TYPES: readonly string[] = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/3gpp',
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
const validateAgainst = (
  candidate: UploadCandidate,
  rule: {
    readonly maxBytes: number;
    readonly allowed: readonly string[];
    readonly tooLarge: string;
    readonly wrongType: { readonly message: string; readonly detail: string };
  },
): UploadedFile => {
  if (candidate.bytes.length === 0) {
    throw refuse('That file is empty.', 'empty_file', 'An empty file has nothing to attach.');
  }
  /*
   * SIZE BEFORE TYPE, deliberately. "Too large" is something somebody can act
   * on; being told the type is wrong would send them converting a file that
   * was never going to fit.
   */
  if (candidate.bytes.length > rule.maxBytes) {
    throw refuse('That file is too large.', 'file_too_large', rule.tooLarge);
  }

  const sniffed = sniffContentType(candidate.bytes);
  /*
   * THE SNIFFED TYPE IS CHECKED AGAINST THE LIST, not merely required to be
   * recognised. Those were the same thing until video arrived, and then they
   * were not: the sniffer learned MP4, and `sniffed !== null` would have
   * quietly let a video be filed as a customer's order on the document path.
   * Every caller now names the types it accepts.
   *
   * The message names the formats rather than what was sent. Telling somebody
   * "that is a ZIP" tells whoever is probing exactly what the sniffer
   * understood, and it is no help to the person with a spreadsheet either.
   */
  if (sniffed === null || !rule.allowed.includes(sniffed.contentType)) {
    throw refuse(rule.wrongType.message, 'unsupported_file_type', rule.wrongType.detail);
  }

  return {
    fileName: safeFileName(candidate.fileName),
    contentType: sniffed.contentType,
    bytes: candidate.bytes,
  };
};

export const validateUpload = (candidate: UploadCandidate): UploadedFile =>
  validateAgainst(candidate, {
    maxBytes: MAX_UPLOAD_BYTES,
    allowed: ACCEPTED_CONTENT_TYPES,
    tooLarge: `Attachments are limited to ${megabytes(MAX_UPLOAD_BYTES)} MB.`,
    wrongType: {
      message: 'That file type cannot be attached.',
      detail: 'Attach a PDF or an image (PNG, JPEG, TIFF or WebP).',
    },
  });

/**
 * The same validation, narrowed to what a photograph may be. PWA-3.
 *
 * Shares `validateAgainst` rather than sitting beside it, so a photograph
 * cannot end up with a different sniffer or a different order of checks than a
 * document — only the list and the limit differ.
 */
export const validatePhotoUpload = (candidate: UploadCandidate): UploadedFile =>
  validateAgainst(candidate, {
    maxBytes: MAX_UPLOAD_BYTES,
    allowed: PHOTO_CONTENT_TYPES,
    tooLarge: `Photographs are limited to ${megabytes(MAX_UPLOAD_BYTES)} MB.`,
    wrongType: {
      message: 'That file is not a photograph.',
      detail: 'Attach an image (PNG, JPEG, TIFF or WebP). A PDF belongs under Documents.',
    },
  });

/**
 * WHAT MAY BE ATTACHED WHILE A JOB IS BEING RAISED. Create New Job §3C.
 *
 * A PHOTOGRAPH OR A VIDEO, AND NO DOCUMENT. The owner's reasoning is the
 * control's purpose: what is attached as a job is raised is what the caller
 * sent in — a photograph of the fault, a clip of the noise the machine is
 * making — and a PDF belongs where documents are kept and read. This route is
 * the ONLY caller of `/api/jobs/:jobId/attachments`, so narrowing it narrows
 * exactly that control: the Technical Library, the customer-document register
 * and the machine-document register each have their own route and keep
 * `validateUpload`, which still accepts a PDF.
 *
 * THE LIMIT FOLLOWS WHAT THE FILE ACTUALLY IS. A video is allowed the video
 * budget and a photograph is held to the photograph one, which is why the type
 * is sniffed BEFORE the rule is chosen rather than after. The ordering inside
 * `validateAgainst` is unchanged — empty, then size, then type — so an empty
 * file is still reported as empty, and a 60 MB PDF is still refused for its
 * TYPE rather than for its size, because converting it would not have helped.
 */
export const validateJobMediaUpload = (candidate: UploadCandidate): UploadedFile => {
  const sniffed = sniffContentType(candidate.bytes);
  const isVideo = sniffed !== null && VIDEO_CONTENT_TYPES.includes(sniffed.contentType);
  return validateAgainst(candidate, {
    maxBytes: isVideo ? MAX_VIDEO_BYTES : MAX_UPLOAD_BYTES,
    allowed: [...PHOTO_CONTENT_TYPES, ...VIDEO_CONTENT_TYPES],
    tooLarge: isVideo
      ? `Videos are limited to ${megabytes(MAX_VIDEO_BYTES)} MB — about 40 seconds at 1080p.`
      : `Photographs are limited to ${megabytes(MAX_UPLOAD_BYTES)} MB.`,
    wrongType: {
      message: 'Only photographs and videos can be attached to a new job.',
      detail:
        'Attach an image (PNG, JPEG, TIFF or WebP) or a video (MP4, MOV, WebM or 3GP). ' +
        'A PDF belongs in the Technical Library, or against the customer or the machine.',
    },
  });
};

/**
 * And what a VIDEO may be, with its own larger limit. MEDIA-5.
 *
 * The limit is the one place this path is genuinely more permissive, and it is
 * also a memory budget — see `MAX_VIDEO_BYTES`. Everything else is the same
 * machinery: the bytes are sniffed, the container's brand has to be one a
 * camera actually writes, and the name is sanitised before it reaches a row or
 * a header.
 */
export const validateVideoUpload = (candidate: UploadCandidate): UploadedFile =>
  validateAgainst(candidate, {
    maxBytes: MAX_VIDEO_BYTES,
    allowed: VIDEO_CONTENT_TYPES,
    tooLarge:
      `Videos are limited to ${megabytes(MAX_VIDEO_BYTES)} MB — about ` +
      '40 seconds at 1080p. Record a shorter clip, or photograph the fault instead.',
    wrongType: {
      message: 'That file is not a video this accepts.',
      detail: 'Record with the tablet camera, or choose an MP4, MOV, WebM or 3GP file.',
    },
  });
