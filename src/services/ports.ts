import type {
  CorrectedArea,
  ChecklistTemplate,
  Contact,
  DeliveryState,
  Customer,
  DeliveryFailureKind,
  IsoDateTime,
  Job,
  Machine,
  Site,
  SystemSettings,
  User,
} from '@/domain';
export type { DeliveryFailureKind, DeliveryState } from '@/domain';
import { isDeliveryFailureKind } from '@/domain';
import type { PreparedPhoto } from '@/lib/pdf/image';

/**
 * Integration ports.
 *
 * Every outbound integration is declared here as an interface. The demo ships
 * simulated adapters that record what *would* have been sent into a visible
 * outbox; they never contact an external service. Phase 2 supplies real
 * adapters (Microsoft 365 Graph, WhatsApp Business Platform, a PDF renderer,
 * S3-compatible storage) against these same interfaces, so no business logic or
 * UI code changes.
 */

export type OutboxChannel = 'email' | 'whatsapp';

export interface OutboxEntry {
  readonly id: string;
  readonly channel: OutboxChannel;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly string[];
  readonly createdAt: IsoDateTime;
  /**
   * Whether this entry records a message that was never transmitted.
   *
   * `true` for the demonstration adapters, which write to the visible outbox
   * and contact nothing. `false` for a production adapter, whose `id` is the
   * provider's own message id — which is what makes the entry reconcilable
   * against a delivery report later.
   *
   * Widened from the literal `true` when the first real adapter arrived. Every
   * reader of this field already treats it as a boolean, and the simulated
   * adapters still set it to true, so nothing that displayed "simulated"
   * changed its mind about a demonstration entry.
   */
  readonly simulated: boolean;
  /**
   * What the provider says became of it.
   *
   * Kept on the entry so the outbox shows the truth rather than implying that
   * everything listed in it arrived.
   */
  readonly delivery: DeliveryState;
  readonly failureReason: string;
  /**
   * WHICH KIND of failure, where whatever reported it could say.
   *
   * A real delivery report classifies — a refused credential is not a full
   * mailbox. The demonstration outbox carries the field so the office screen
   * can show the SAME distinction it will show in production, rather than the
   * demo being the one place that cannot.
   */
  readonly failureKind?: DeliveryFailureKind | null;
}

export interface EmailMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments?: readonly { readonly fileName: string; readonly storageKey: string }[];
}

/**
 * What a provider tells us when we hand it a message.
 *
 * `pending_delivery` is the normal, honest answer: Microsoft 365 returns 202
 * the moment it accepts the message, which says nothing about whether the
 * customer's mailbox took it. `delivered` may only be returned by a provider
 * that has genuinely confirmed delivery to the recipient.
 */
export interface DeliveryReceipt {
  readonly messageId: string;
  readonly state: DeliveryState;
  readonly failureReason: string;
  /**
   * WHICH KIND of failure, where the transport can say.
   *
   * Optional, because a transport need not classify and the demonstration
   * adapters do not. The domain owns the vocabulary (`DeliveryFailureKind`):
   * whether a retry can work is the office's question, not a provider's.
   */
  readonly failureKind?: DeliveryFailureKind | null;
  /** The outbox record, where the adapter keeps one. */
  readonly entry: OutboxEntry | null;
}

/**
 * THE KIND OF FAILURE AN ADAPTER THREW, READ WITHOUT KNOWING THE ADAPTER.
 *
 * `services.email.send` rejects with whatever its transport raises — Graph's
 * `EmailSendFailed`, an `EmailNotConfigured`, a `TypeError` from something
 * nobody expected. The application has to record WHICH KIND of failure that
 * was, and must not import a concrete adapter to find out: the port is the
 * contract, so the contract is where this lives.
 *
 * Structural on purpose. An adapter that carries a `kind` from the domain's own
 * vocabulary is understood; anything else is `null`, which the record stores as
 * "unclassified" rather than guessing. That keeps a new transport free to say
 * nothing at all without pretending.
 */
export const deliveryFailureKindOf = (error: unknown): DeliveryFailureKind | null => {
  const kind = (error as { readonly kind?: unknown } | null | undefined)?.kind;
  return isDeliveryFailureKind(kind) ? kind : null;
};

export interface EmailService {
  /**
   * Hands the message to the provider.
   *
   * Returns what the PROVIDER said, not what we hope happened. An
   * implementation must never return `delivered` because a request was
   * accepted — see `DeliveryState`.
   */
  send(message: EmailMessage): Promise<DeliveryReceipt>;
  /**
   * Asks the provider what became of a message it accepted earlier.
   *
   * In production this reads the delivery report (Graph message trace, or the
   * provider's webhook state). Returns null when the provider has no record.
   */
  deliveryState(messageId: string): Promise<DeliveryReceipt | null>;
  /**
   * Whether this deployment can hand a message to a provider at all, and in
   * plain words why not. PAY-06: the Finance package asks BEFORE it claims a
   * send, so an unconfigured deployment refuses up front instead of recording
   * a send that could never happen. Optional: an adapter that says nothing is
   * taken as ready, and its send() still decides.
   */
  readiness?(): { readonly ready: boolean; readonly detail: string };
}

export interface WhatsAppMessage {
  readonly to: string;
  /** Approved template name on the WhatsApp Business Platform. */
  readonly templateName: string;
  readonly parameters: readonly string[];
  readonly preview: string;
}

export interface WhatsAppService {
  send(message: WhatsAppMessage): Promise<OutboxEntry>;
  /**
   * Whether this deployment can send at all.
   *
   * Asked BEFORE anything is queued, so an operation can tell a technician
   * "WhatsApp is not set up on this system" instead of writing a message that
   * can never go and retrying it until its attempts run out. A deployment with
   * no configuration has `UnconfiguredWhatsAppService`, which answers false
   * and refuses every send; the simulated adapter answers true, because the
   * demonstration channel really does record what it was given.
   *
   * It is NOT a health check and must not be read as one: configured says the
   * credentials exist, never that Meta is reachable. Only a send finds that
   * out, which is what the outbox row is for.
   */
  readonly configured: boolean;
}

export interface OutboxReader {
  list(): Promise<readonly OutboxEntry[]>;
}

export interface GeneratedPdf {
  readonly storageKey: string;
  readonly fileName: string;
  readonly pageCount: number;
  readonly generatedAt: IsoDateTime;
  /**
   * True when this renderer is the application itself rather than a
   * server-side one. See `FinalDocument.renderedLocally`, which this becomes:
   * it describes the RENDERER, never the bytes (which are real either way) and
   * never the delivery (which is `job.delivery`).
   */
  readonly renderedLocally: boolean;
}

/**
 * Which copy of a customer document is being produced.
 *
 * `final` is the one copy a Master issues: it is emailed to the customer and
 * kept on the closed job for good, so its file name has to say that it is the
 * official final document rather than a working preview.
 */
export type PdfVariant = 'preview' | 'final';

/**
 * Everything a renderer needs to produce a customer document.
 *
 * Plain domain values rather than the application's `JobView`, so the port does
 * not depend on the layer above it and the Phase 2 server-side renderer can be
 * handed the same structure from a database row.
 */
export interface FinalDocumentSource {
  readonly job: Job;
  readonly customer: Customer;
  readonly site: Site;
  readonly contact: Contact | null;
  readonly machine: Machine | null;
  readonly settings: SystemSettings;
  readonly checklistTemplate: ChecklistTemplate | null;
  /** Everyone who could be named on the document, for resolving note authors. */
  readonly users: readonly User[];
  /**
   * The customer-facing photographs' own pixels, by attachment id.
   *
   * Loaded from storage by whoever renders — the server for the issued copy,
   * the browser (through the authorised media route) for the preview — because
   * the job record holds only a storage key, and a key is not an image. A
   * photograph missing from this map is drawn as a labelled box saying it could
   * not be shown, never as a blank that looks like a photograph.
   */
  readonly photoImages?: ReadonlyMap<string, PreparedPhoto>;
}

/** A rendered document: the bytes, and how many pages they actually are. */
export interface RenderedPdf {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
}

export interface PdfService {
  /**
   * Produces the signed job card document. The demo returns a descriptor that
   * the on-screen job-card preview renders from live job data; production
   * renders the same model server-side into a real PDF.
   */
  generateJobCard(job: Job, variant?: PdfVariant): Promise<GeneratedPdf>;
  /**
   * Produces the parts collection note / courier delivery note.
   *
   * A separate method rather than a flag, because it is a different document:
   * different layout, different declaration, and — for a courier — different
   * content, since prices are withheld. Production will render it from the same
   * `buildPartsDocument` model the preview uses, so the courier's copy cannot
   * disagree with what was shown on screen.
   */
  generatePartsNote(job: Job, variant?: PdfVariant): Promise<GeneratedPdf>;
  /**
   * Renders the document to actual bytes.
   *
   * Separate from the two descriptor methods above because a descriptor is
   * cheap metadata for a preview, while this is the file itself — the one a
   * Master issues and a customer keeps. The demo renders it in the browser and
   * production renders the same source server-side; either way the bytes are
   * written to storage ONCE, at issue, and every later download returns those
   * same bytes rather than rendering again.
   */
  render(
    source: FinalDocumentSource,
    variant: PdfVariant,
    /** Stamped on the document, so a stored file renders identically every time. */
    generatedAt: IsoDateTime,
  ): Promise<RenderedPdf>;

  /**
   * THE CORRECTION ADDENDUM. BD-02, IMMUT-9, AUD-3.
   *
   * A SEPARATE METHOD RATHER THAN A VARIANT OF `render`, because it is a
   * different document made of different facts: `render` takes a job and draws
   * the job card, and a correction is a statement ABOUT a job card that must
   * not re-draw it. Passing a job here would make it possible, one day, for a
   * correction to be rendered from the job as it stands — which is the single
   * thing a frozen job card exists to prevent.
   */
  renderCorrection(source: CorrectionDocumentSource, fileName: string): Promise<RenderedPdf>;
}

/**
 * What an addendum is drawn from: the original by reference, and what the
 * correction says. Never the job.
 */
export interface CorrectionDocumentSource {
  readonly company: {
    readonly name: string;
    readonly address: string;
    readonly contactLine: string;
    readonly registrationLine: string;
  };
  readonly jobNumber: string;
  readonly customerName: string;
  readonly machineDescription: string;
  readonly original: {
    readonly fileName: string;
    readonly issuedAt: string;
    readonly signed: boolean;
  };
  readonly correction: {
    readonly sequence: number;
    readonly reason: string;
    readonly narrative: string;
    readonly areas: readonly CorrectedArea[];
    readonly raisedBy: string;
    readonly raisedAt: string;
    readonly acknowledgementRequired: boolean;
    readonly acknowledged: {
      readonly by: string;
      readonly method: string;
      readonly at: string;
      readonly note: string;
    } | null;
  };
  /** True only for a demonstration job. Stamped on every page when it is. */
  readonly simulated: boolean;
}

export interface StoredFile {
  readonly storageKey: string;
  readonly url: string;
}

/** A file held in storage, with the bytes. */
export interface StoredDocument {
  readonly storageKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** Which renderer produced them; see `StoredFileRecord`. */
  readonly renderer?: number;
  /** True when these bytes are a cache for history, not an issued document. */
  readonly backfilled?: boolean;
  /**
   * What the store MEASURED, set only on the way out.
   *
   * A caller writing a document does not supply these — the bytes are right
   * there and a supplied length could disagree with them. `getDocument` fills
   * them in from the bytes it actually read, which is what makes them worth
   * recording on `final_documents`: the row then says what is on the disk
   * rather than what somebody believed was going to be.
   */
  readonly sizeBytes?: number;
  readonly sha256?: string;
}

/**
 * THE FILE IS THERE AND IT IS NOT THE FILE THAT WAS WRITTEN. BACKUP-1.
 *
 * Part of the PORT rather than of the filesystem adapter, because it is part of
 * the contract: a store that can tell damaged bytes from missing ones must say
 * so in a way the application can act on, and the application must not have to
 * import an adapter to catch it.
 *
 * Distinct from a null (nothing is stored here) and from a write failure
 * (nothing could be stored): nothing is wrong with the request, the stored
 * bytes are damaged, and the remedy is a restore rather than a retry. It is
 * raised rather than swallowed — handing out a document that fails its own
 * checksum is the one outcome a checksum exists to prevent — and it must never
 * be turned into a re-render, which would replace a customer's signed document
 * with a new one carrying its date.
 */
export class StorageIntegrityFailed extends Error {
  constructor(
    readonly storageKey: string,
    message: string,
  ) {
    super(message);
    this.name = 'StorageIntegrityFailed';
  }
}

/** A file the office or a technician actually uploaded, bytes and all. */
export interface UploadedFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface StorageService {
  /**
   * Resolves a storage key to something the browser can display.
   *
   * NEVER A PUBLIC URL, in any implementation. A storage key is not a
   * credential and must not become one: everything a browser can fetch goes
   * through an authenticated route that checks who is asking first. The
   * adapters return an inert reference, which is what makes an accidental
   * `<a href>` fail loudly rather than leak a customer's document.
   */
  resolveUrl(storageKey: string): string;
  /**
   * Stores an uploaded file's bytes, durably, under a key IT chooses.
   *
   * THE ONLY WAY TO GET A NEW KEY, and that is the point. There used to be a
   * second one — `put(fileName, contentType, null)` — which allocated a key
   * with NO BYTES behind it, for capture paths where the browser sent a file
   * name and a size it had made up. Every one of those paths now sends the
   * image and goes through here, so `put` was removed rather than left as the
   * one call in the system capable of recording a document that does not
   * exist. A metadata row offering a download for nothing is the defect
   * DEMO-1 §1.2 is about, and this is what makes it unreachable rather than
   * merely unused.
   *
   * An implementation either writes the bytes somewhere they survive a restart
   * or it raises — there is no third answer.
   *
   * The key is generated, never derived from the file name: a name is
   * user-controlled and a path built from one is a traversal waiting to happen.
   */
  storeUpload(file: UploadedFile): Promise<StoredFile>;
  /**
   * Writes a document at an explicit key, and reads it back.
   *
   * Explicit rather than generated, because a job's final document has to be
   * retrievable by the key recorded on the job — that is what makes it the same
   * file months later. In production these become a disk write and a read (then
   * an object-store put and a signed GET); no caller changes.
   */
  putDocument(document: StoredDocument): Promise<void>;
  getDocument(storageKey: string): Promise<StoredDocument | null>;
  /**
   * Deletes the bytes behind a key. FOR UNDOING A WRITE, AND NOTHING ELSE.
   *
   * WHY THIS EXISTS, and it is the only reason. Every upload path writes the
   * bytes FIRST and records the row afterwards, which is the right order: a
   * row pointing at a file that was never written is the failure that matters,
   * because it tells somebody a customer's document exists when it does not.
   * The cost of that order is the other direction — if the row cannot be
   * written, the bytes are already on disk with nothing pointing at them.
   * Nothing noticed, and nothing could remove them.
   *
   * So the unit of work remembers the keys it generated and calls this on the
   * ones whose transaction rolled back. See `trackStorageWrites`.
   *
   * WHAT IT IS NOT. It is not a document-deletion feature and must never
   * become one. EJE withdraw a document — the row is marked and the bytes are
   * kept, because the audit history is the point (CUST-DOC-1, MACH-DOC-1). A
   * signed job card may never be deleted at all. The only caller is the
   * rollback, plus `documents:reconcile --remove-orphans`, which an operator
   * has to ask for explicitly and which only ever offers files no row refers
   * to.
   *
   * IT IS BEST-EFFORT AND MUST NOT RAISE for a key that is not there: it runs
   * on a path that is already failing, and a cleanup that throws would replace
   * the real error with its own.
   */
  remove(storageKey: string): Promise<void>;
}

/** Injectable clock, so tests and seeds are not at the mercy of wall time. */
export interface Clock {
  now(): IsoDateTime;
}

export interface IdGenerator {
  next(prefix: string): string;
}
