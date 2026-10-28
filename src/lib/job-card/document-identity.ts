import { requiresDeliveryNote, type Job } from '@/domain';
import { buildDeliveryNoteModel, identifiedDeliveryNoteContent } from './delivery-note';
import { buildJobCardModel, type JobCardModel, type JobCardModelInput } from './model';

/**
 * THE IDENTITY OF THE DOCUMENT A CUSTOMER WAS SHOWN. BD-23 (approved by the
 * owner on 27 October 2026), OFF-5.
 *
 * A customer may now sign — or refuse — on a tablet with no signal. The job can
 * change on the server before that signature arrives, so the signature has to
 * say WHICH document it was given for, and the server has to be able to check
 * that claim against its own record rather than take the tablet's word for it.
 *
 * WHAT IS IDENTIFIED: the canonical job card model (`buildJobCardModel`) — the
 * one definition both the PDF and the on-screen card are drawn from, with every
 * figure already formatted and every label already decided. Not the PDF bytes:
 * those carry the moment they were generated and depend on how a photograph's
 * pixels were encoded, so two renders of the same job never match byte for
 * byte, and a check built on them would refer every offline signature to the
 * office. Not a client-supplied version number: the server holds no such
 * number, and inventing one would be a value the tablet could simply repeat.
 *
 * WHAT IS LEFT OUT, and why each is not part of what the customer agreed to:
 *
 *   - `footerLines` — the "Generated …" stamp is the time of rendering, not
 *     content, and the pricing line describes the snapshot that the signature
 *     itself creates.
 *   - `acceptance` and `refusal` — the OUTCOME blocks. They are what the
 *     customer adds to the document, not the document they were shown.
 *
 * WHAT IS ADDED: each customer-facing photograph's measured SHA-256, beside its
 * id, so a photograph replaced under the same caption is a different document.
 * A photograph nobody measured is identified by its id alone, which the server
 * reproduces exactly — it cannot vouch for those pixels, and says so by not
 * pretending to.
 *
 * THE SERVER RECOMPUTES THIS FROM ITS OWN RECORD, through the same function and
 * from the same view of the job the technician was given (`loadJobView` with
 * the technician as viewer), so a figure hidden from that technician is hidden
 * from both sides of the comparison. Equal identities mean the customer was
 * shown exactly the document the server would issue; anything else — a changed
 * line, a different rate, a missing view — is not accepted (see
 * `acceptOfflineSignature`).
 *
 * VERSIONED. The prefix names the shape that was hashed. A tablet running an
 * older build that hashed a different shape produces an identity the server
 * does not recognise, and that is refused and referred — never compared as if
 * it meant the same thing.
 */
export const DOCUMENT_IDENTITY_VERSION = 'jcm1';

/**
 * A COURIER COLLECTION IS SIGNED ON ITS DELIVERY NOTE (the owner's decision of
 * 28 October 2026, PARTS-03/04). So for such a job the document the signer was
 * shown — and therefore the document identified — is the Delivery Note, under
 * its own version prefix. An older tablet build that identified the job card
 * for a courier collection sends a `jcm1:` identity; the server computes a
 * `dln1:` one, the two never match, and the held signature is REFERRED to
 * Field Captures — never attached to a document the courier did not see.
 */
export const DELIVERY_NOTE_IDENTITY_VERSION = 'dln1';

export const DOCUMENT_IDENTITY_PATTERN = /^(jcm1|dln1):[0-9a-f]{64}$/;

export const isDocumentIdentity = (value: string): boolean => DOCUMENT_IDENTITY_PATTERN.test(value);

type IdentifiedModel = Omit<JobCardModel, 'footerLines' | 'acceptance' | 'refusal' | 'photos'> & {
  readonly photos: readonly {
    readonly id: string;
    readonly caption: string;
    readonly fileName: string;
    readonly sha256: string | null;
  }[];
};

/** The part of the model that is the document, with the photographs' measurements. */
export const identifiedContent = (model: JobCardModel, job: Pick<Job, 'photos'>): IdentifiedModel => {
  // Destructured out, not set to null, so the hashed shape has no key for them.
  const { footerLines: _footer, acceptance: _acceptance, refusal: _refusal, photos, ...rest } = model;
  const measured = new Map<string, string | null>(
    job.photos.map((photo) => [photo.id, photo.checksumSha256]),
  );
  return {
    ...rest,
    photos: photos.map((photo) => ({
      id: photo.id,
      caption: photo.caption,
      fileName: photo.fileName,
      sha256: measured.get(photo.id) ?? null,
    })),
  };
};

/**
 * JSON with its keys sorted at every depth.
 *
 * `JSON.stringify` keeps insertion order, and two builds — or the browser and
 * the server — constructing the same object in a different order would hash
 * differently. Arrays keep their order: the order of lines on a job card is
 * part of the document.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
};

const toHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Whether this runtime can compute one. A browser needs a secure context (HTTPS). */
export const canComputeDocumentIdentity = (): boolean =>
  typeof globalThis.crypto?.subtle?.digest === 'function';

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  toHex(await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource));

/**
 * The identity of the document drawn from these inputs.
 *
 * `generatedAt` is irrelevant to the answer (the footer is left out) and is
 * fixed here so a caller cannot make it matter.
 */
export const documentIdentityFor = async (
  input: Omit<JobCardModelInput, 'generatedAt'>,
): Promise<string> => {
  if (requiresDeliveryNote(input.job)) {
    const note = buildDeliveryNoteModel(
      {
        job: input.job,
        customer: input.customer,
        site: input.site,
        contact: input.contact,
        settings: input.settings,
        users: input.users,
      },
      '1970-01-01T00:00:00.000Z',
    );
    const canonical = canonicalJson(identifiedDeliveryNoteContent(note));
    return `${DELIVERY_NOTE_IDENTITY_VERSION}:${await sha256Hex(new TextEncoder().encode(canonical))}`;
  }
  const model = buildJobCardModel({ ...input, generatedAt: '1970-01-01T00:00:00.000Z' });
  const canonical = canonicalJson(identifiedContent(model, input.job));
  const digest = await sha256Hex(new TextEncoder().encode(canonical));
  return `${DOCUMENT_IDENTITY_VERSION}:${digest}`;
};
