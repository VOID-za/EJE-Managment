import { loadEnvFiles } from '@/db/seed/env';
import { getDatabase } from '@/db/client';
import { createPostgresRepositories } from '@/data/postgres/repositories';
import { withTransaction } from '@/data/postgres/transaction';
import {
  ACTIVITY_RETENTION_DAYS,
  NOTIFICATION_RETENTION_DAYS,
  retentionReport,
  runRetention,
  type RetentionRecord,
} from '@/application/retention';

/**
 * `npm run retention` — the notification and activity retention (RETAIN-1/2).
 *
 *   --report  what the last purges did (the default; changes nothing)
 *   --run     run both purges now, whether or not they are due
 *
 * The application's worker runs them on its own schedule; this is for the
 * operator to see what happened, or to run them by hand. Each run is recorded
 * in the integration state store, never as an activity event.
 */
loadEnvFiles();

const describe = (label: string, record: RetentionRecord | null): string =>
  record === null
    ? `${label}: never run`
    : `${label}: last run ${record.ranAt}, deleted ${record.deleted} (everything before ${record.cutoff || 'unknown'})`;

const main = async (): Promise<void> => {
  const db = getDatabase();
  const force = process.argv.includes('--run');
  const result = await withTransaction(db, async (tx) => {
    const repos = createPostgresRepositories(tx);
    if (force) await runRetention(repos, new Date().toISOString(), { force: true });
    return retentionReport(repos);
  });
  console.log(`retention: notifications kept ${NOTIFICATION_RETENTION_DAYS} days, activity ${ACTIVITY_RETENTION_DAYS} days`);
  console.log(describe('notifications', result.notifications));
  console.log(describe('activity', result.activity));
  await db.$client.end({ timeout: 5 });
};

main().catch((cause: unknown) => {
  console.error('retention failed:', cause instanceof Error ? cause.message : cause);
  process.exit(1);
});
