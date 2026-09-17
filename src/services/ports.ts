import type { IsoDateTime, Job } from '@/domain';

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
  /** Always true in the demo. A real adapter records a provider message id. */
  readonly simulated: true;
}

export interface EmailMessage {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments?: readonly { readonly fileName: string; readonly storageKey: string }[];
}

export interface EmailService {
  /** Microsoft 365 / Graph in production. */
  send(message: EmailMessage): Promise<OutboxEntry>;
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

export interface PdfService {
  /**
   * Produces the signed job card document. The demo returns a descriptor that
   * the on-screen job-card preview renders from live job data; production
   * renders the same model server-side into a real PDF.
   */
  generateJobCard(job: Job): Promise<GeneratedPdf>;
  /**
   * Produces the parts collection note / courier delivery note.
   *
   * A separate method rather than a flag, because it is a different document:
   * different layout, different declaration, and — for a courier — different
   * content, since prices are withheld. Production will render it from the same
   * `buildPartsDocument` model the preview uses, so the courier's copy cannot
   * disagree with what was shown on screen.
   */
  generatePartsNote(job: Job): Promise<GeneratedPdf>;
}

export interface StoredFile {
  readonly storageKey: string;
  readonly url: string;
}

export interface StorageService {
  /** Resolves a storage key to something the browser can display. */
  resolveUrl(storageKey: string): string;
  put(fileName: string, contentType: string, data: Blob | null): Promise<StoredFile>;
}

/** Injectable clock, so tests and seeds are not at the mercy of wall time. */
export interface Clock {
  now(): IsoDateTime;
}

export interface IdGenerator {
  next(prefix: string): string;
}
