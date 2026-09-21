import type { RepositoryBundle } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import { PostgresActivityRepository } from './activity-repository';
import { PostgresAvailabilityRepository } from './availability-repository';
import { PostgresChatRepository } from './chat-repository';
import { PostgresChecklistTemplateRepository } from './checklist-template-repository';
import { PostgresCustomerRepository } from './customer-repository';
import { PostgresDocumentRepository } from './document-repository';
import { PostgresJobRepository } from './job-repository';
import { PostgresMachineRepository } from './machine-repository';
import { PostgresNotificationRepository } from './notification-repository';
import { PostgresOutboxRepository } from './outbox-repository';
import { PostgresSettingsRepository } from './settings-repository';
import { PostgresUserRepository } from './user-repository';

/**
 * The production repository bundle.
 *
 * ONE EXECUTOR FOR ALL OF THEM, and that is the point. `db` is either the pool
 * or an open transaction, and every repository built from this call writes
 * through it — so an operation that changes a job AND opens a participation row
 * AND appends an audit event either does all three or none. Building them
 * separately, each with its own handle, would make the all-or-nothing guarantee
 * a hope rather than a fact.
 *
 * Each instance is also ONE UNIT OF WORK. The repositories remember the row
 * versions they read so an optimistic update is checked against what the caller
 * actually reasoned about; a bundle shared between two requests would make that
 * check meaningless. Build one per request, inside `withTransaction`.
 */
export const createPostgresRepositories = (db: DatabaseExecutor): RepositoryBundle => ({
  jobs: new PostgresJobRepository(db),
  customers: new PostgresCustomerRepository(db),
  machines: new PostgresMachineRepository(db),
  users: new PostgresUserRepository(db),
  documents: new PostgresDocumentRepository(db),
  checklistTemplates: new PostgresChecklistTemplateRepository(db),
  activity: new PostgresActivityRepository(db),
  notifications: new PostgresNotificationRepository(db),
  settings: new PostgresSettingsRepository(db),
  availability: new PostgresAvailabilityRepository(db),
  chat: new PostgresChatRepository(db),
  outbox: new PostgresOutboxRepository(db),
});
