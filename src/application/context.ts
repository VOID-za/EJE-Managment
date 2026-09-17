import type { ActivityEventType, User } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';
import type {
  Clock,
  EmailService,
  IdGenerator,
  PdfService,
  StorageService,
  WhatsAppService,
} from '@/services/ports';

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
}
