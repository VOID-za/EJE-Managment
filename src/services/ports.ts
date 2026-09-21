import type {
  ChecklistTemplate,
  Contact,
  DeliveryState,
  Customer,
  IsoDateTime,
  Job,
  Machine,
  Site,
  SystemSettings,
  User,
} from '@/domain';
export type { DeliveryState } from '@/domain';

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
  /** The outbox record, where the adapter keeps one. */
  readonly entry: OutboxEntry | null;
}

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
}

export interface OutboxReader {
  list(): Promise<readonly OutboxEntry[]>;
}

export interface GeneratedPdf {
  readonly storageKey: string;
  readonly fileName: string;
  readonly pageCount: number;
  readonly generatedAt: IsoDateTime;
  readonly simulated: boolean;
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
}

export interface StorageService {
  /** Resolves a storage key to something the browser can display. */
  resolveUrl(storageKey: string): string;
  put(fileName: string, contentType: string, data: Blob | null): Promise<StoredFile>;
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
}

/** Injectable clock, so tests and seeds are not at the mercy of wall time. */
export interface Clock {
  now(): IsoDateTime;
}

export interface IdGenerator {
  next(prefix: string): string;
}
