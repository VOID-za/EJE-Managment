/**
 * PostgreSQL-backed repositories.
 *
 * The demo repositories in `src/data/demo` and these coexist deliberately: the
 * browser demonstration keeps working while the production persistence is
 * proved, and `src/data/backend.ts` is the one module that chooses between
 * them.
 *
 * The boundary is `src/data/repositories/index.ts`. Both sides implement it,
 * and nothing in `src/domain` or `src/application` imports Drizzle, this
 * directory, or the demo store.
 */
export { createPostgresRepositories } from './repositories';
export { PostgresActivityRepository } from './activity-repository';
export { PostgresAvailabilityRepository } from './availability-repository';
export { PostgresChatRepository } from './chat-repository';
export { PostgresChecklistTemplateRepository } from './checklist-template-repository';
export { PostgresCustomerRepository } from './customer-repository';
export { PostgresDocumentRepository } from './document-repository';
export { PostgresJobRepository } from './job-repository';
export { PostgresMachineRepository } from './machine-repository';
export { PostgresNotificationRepository } from './notification-repository';
export { PostgresSettingsRepository } from './settings-repository';
export { PostgresUserRepository } from './user-repository';
export { withTransaction, ConcurrencyError } from './transaction';
export { VersionLedger, requireWritten } from './versions';
export { toDomainJob, toJobRow, vatPercentFromBasisPoints, vatBasisPointsFromPercent } from './job-mapper';
export type { JobRowSet } from './job-mapper';
