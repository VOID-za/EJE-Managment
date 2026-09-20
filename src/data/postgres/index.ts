/**
 * PostgreSQL-backed repositories.
 *
 * The demo repositories in `src/data/demo` and these coexist deliberately: the
 * browser demonstration keeps working while the production persistence is
 * migrated one aggregate at a time, starting with the job.
 *
 * The boundary is `src/data/repositories/index.ts`. Both sides implement it,
 * and nothing in `src/domain` or `src/application` imports Drizzle, this
 * directory, or the demo store.
 */
export { PostgresJobRepository } from './job-repository';
export { withTransaction, ConcurrencyError } from './transaction';
export { toDomainJob, toJobRow, vatPercentFromBasisPoints, vatBasisPointsFromPercent } from './job-mapper';
export type { JobRowSet } from './job-mapper';
