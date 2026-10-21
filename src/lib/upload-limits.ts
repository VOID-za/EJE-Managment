/**
 * WHAT MAY BE UPLOADED, IN ONE PLACE BOTH SIDES CAN READ.
 *
 * WHY IT IS NOT IN `server/api/uploads.ts`. That module is `server-only`,
 * correctly — it holds the sniffer and the validators, and none of that belongs
 * in a browser bundle. But the LIMITS have to be said on screen before anybody
 * records anything: a technician who films for two minutes and is then told the
 * file is too large has lost the thing they were filming, and an office manager
 * who picks a 40 MB scan should be told the number before the upload, not after.
 *
 * So the numbers live here and `uploads.ts` imports them. One definition, used
 * by the rule and by the sentence that explains the rule, which is what stops
 * the screen promising something the server refuses.
 *
 * THE SERVER STILL DECIDES. Nothing here is a check — a client-side limit is a
 * courtesy, and the only limit that matters is the one applied to the bytes
 * that arrived.
 */

/** Documents and photographs. 25 MB covers a scanned multi-page order. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Videos. 60 MB, and the number is also a MEMORY BUDGET.
 *
 * `uploadRoute` reads the whole body before anything looks at it, so a limit of
 * N megabytes is a promise that this process can hold N megabytes per upload in
 * flight. At 60 MB a 1080p phone clip of roughly 40 seconds fits, which covers
 * "show the office what this machine is doing". A two-minute film does not, and
 * is refused with a message that says so rather than failing at some arbitrary
 * point.
 *
 * Longer clips need the upload streamed to disk rather than buffered. That is
 * the next piece of work if EJE want them — see `docs/SCOPE.md`, MEDIA-5.
 */
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;

/** The limit as a whole number of megabytes, for a sentence on a screen. */
export const megabytes = (bytes: number): number => Math.floor(bytes / (1024 * 1024));

export const UPLOAD_LIMIT_MB = megabytes(MAX_UPLOAD_BYTES);
export const VIDEO_LIMIT_MB = megabytes(MAX_VIDEO_BYTES);

/**
 * What a document upload accepts, as a sentence and as an `accept` attribute.
 *
 * THE TWO TOGETHER, because they were neither of them there: the customer and
 * machine document pickers had no `accept` at all, so a tablet offered every
 * file on the device and the refusal arrived only after a failed upload. The
 * `accept` list narrows the picker; the sentence is what a person reads.
 *
 * `accept` IS A HINT AND NOTHING MORE. A browser may ignore it, a file can be
 * renamed, and a picker on some Android builds shows everything regardless. It
 * saves a wasted upload; it is not a check.
 */
export const DOCUMENT_ACCEPT_ATTRIBUTE =
  'application/pdf,image/png,image/jpeg,image/tiff,image/webp,.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp';

export const DOCUMENT_TYPES_SENTENCE = `PDF or image (PNG, JPEG, TIFF, WebP), up to ${UPLOAD_LIMIT_MB} MB.`;

export const PHOTO_ACCEPT_ATTRIBUTE = 'image/png,image/jpeg,image/tiff,image/webp';

export const VIDEO_ACCEPT_ATTRIBUTE = 'video/mp4,video/quicktime,video/webm,video/3gpp';
