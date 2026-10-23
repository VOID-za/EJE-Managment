import type { ActivityEventType, User, FieldChange} from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import type {
  Clock,
  EmailService,
  IdGenerator,
  PdfService,
  StorageService,
  WhatsAppService,
} from '@/services/ports';
import type { PdfTextService } from '@/services/pdf-text';

/**
 * Everything an application operation is allowed to touch.
 *
 * Operations are plain functions taking this context. They contain no React and
 * no direct storage access, so in Phase 2 the identical functions can run
 * server-side inside the REST API handlers.
 */
export interface AppServices {
  readonly email: EmailService;
  readonly whatsapp: WhatsAppService;
  readonly pdf: PdfService;
  /**
   * READING THE TEXT A PDF ALREADY CONTAINS. LIB-TEXT-1.
   *
   * A service rather than a direct call so the engine can be swapped: a
   * deployment with poppler reads a manual whose fonts are subset, and one
   * without it falls back to the byte reader. A test substitutes either, which
   * is what lets the index be proved without spawning a process.
   *
   * NOT the same thing as `pdf`, which WRITES EJE's own documents.
   */
  readonly pdfText: PdfTextService;
  readonly storage: StorageService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface OperationContext {
  readonly repos: RepositoryBundle;
  readonly services: AppServices;
  /** The signed-in user performing the operation. */
  readonly actor: User;
}

export interface AuditInput {
  readonly jobId: string | null;
  readonly type: ActivityEventType;
  readonly summary: string;
  readonly detail: string;
  /**
   * What changed, structured. AUDIT-2.
   *
   * Omitted by the great majority of callers, which record that something
   * happened rather than that a value moved. Supplied where an existing
   * recorded value was replaced — see `ActivityEvent.changes`.
   */
  readonly changes?: readonly FieldChange[];
}
