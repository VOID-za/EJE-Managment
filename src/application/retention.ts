import type { IsoDateTime } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * RETENTION OF NOTIFICATIONS AND ACTIVITY. RETAIN-1, RETAIN-2 (the tester,
 * 2 November 2026).
 *
 *   NOTIFICATIONS are kept for 15 days: one 15 days old or older is deleted.
 *   ACTIVITY (the audit trail behind the Activity page and each job's history)
 *     is kept for 7 days: the cleanup runs every 7 days and deletes the events
 *     older than 7 days.
 *
 * ONLY THOSE RECORDS. A notification and an activity event are each a note
 * ABOUT something; deleting one never touches the job card, message, form,
 * document or signature it refers to — nothing has a foreign key into either
 * table, and these purges delete from those two tables and no other. Unread
 * counts and the Inbox are read from what remains, so they stay right.
 *
 * SAFE TO RUN REPEATEDLY: each purge is "delete what is older than the cutoff",
 * so a second run finds nothing more to delete. Each run is recorded — when,
 * the cutoff and how many — in the integration state store (one row per purge,
 * overwritten), NOT as an activity event, so the cleanup never creates the
 * trail it is cleaning.
 *
 * Run by the in-process worker (every minute it asks whether a purge is due:
 * notifications at most hourly, activity every 7 days) and by
 * \`npm run retention\` for a report or a run on demand.
 */
export const NOTIFICATION_RETENTION_DAYS = 15;
export const ACTIVITY_RETENTION_DAYS = 7;
export const ACTIVITY_CLEANUP_EVERY_DAYS = 7;
const NOTIFICATION_CLEANUP_EVERY_HOURS = 1;

export const NOTIFICATION_RETENTION_STATE = 'retention.notifications';
export const ACTIVITY_RETENTION_STATE = 'retention.activity';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface RetentionRecord {
  /** When the purge last ran. */
  readonly ranAt: IsoDateTime;
  /** Everything at or before this was eligible. */
  readonly cutoff: IsoDateTime;
  readonly deleted: number;
}

export interface RetentionRun {
  readonly notifications: RetentionRecord | null;
  readonly activity: RetentionRecord | null;
}

const minus = (now: IsoDateTime, ms: number): IsoDateTime => new Date(Date.parse(now) - ms).toISOString();

const lastRun = async (repos: RepositoryBundle, service: string): Promise<RetentionRecord | null> => {
  const state = await repos.integrations.findState(service);
  if (state === null) return null;
  try {
    const parsed = JSON.parse(state.summary) as Partial<RetentionRecord>;
    return { ranAt: state.fingerprint, cutoff: parsed.cutoff ?? '', deleted: parsed.deleted ?? 0 };
  } catch {
    return { ranAt: state.fingerprint, cutoff: '', deleted: 0 };
  }
};

const due = (previous: RetentionRecord | null, now: IsoDateTime, everyMs: number): boolean =>
  previous === null || Number.isNaN(Date.parse(previous.ranAt)) || Date.parse(now) - Date.parse(previous.ranAt) >= everyMs;

/** What the last runs did, for the report. */
export const retentionReport = async (repos: RepositoryBundle): Promise<RetentionRun> => ({
  notifications: await lastRun(repos, NOTIFICATION_RETENTION_STATE),
  activity: await lastRun(repos, ACTIVITY_RETENTION_STATE),
});

/**
 * Runs whichever purge is due — or both, with \`force\`. Answers what ran (null
 * for a purge that was not due).
 */
export const runRetention = async (
  repos: RepositoryBundle,
  now: IsoDateTime,
  options: { readonly force?: boolean } = {},
): Promise<RetentionRun> => {
  let notifications: RetentionRecord | null = null;
  if (options.force === true || due(await lastRun(repos, NOTIFICATION_RETENTION_STATE), now, NOTIFICATION_CLEANUP_EVERY_HOURS * HOUR)) {
    // "15 days old or older": created at or before now − 15 days.
    const cutoff = minus(now, NOTIFICATION_RETENTION_DAYS * DAY);
    const deleted = await repos.notifications.purgeCreatedAtOrBefore(cutoff);
    notifications = { ranAt: now, cutoff, deleted };
    await repos.integrations.saveState(NOTIFICATION_RETENTION_STATE, now, JSON.stringify({ cutoff, deleted }), now);
  }
  let activity: RetentionRecord | null = null;
  if (options.force === true || due(await lastRun(repos, ACTIVITY_RETENTION_STATE), now, ACTIVITY_CLEANUP_EVERY_DAYS * DAY)) {
    // "Older than 7 days": occurred before now − 7 days.
    const cutoff = minus(now, ACTIVITY_RETENTION_DAYS * DAY);
    const deleted = await repos.activity.purgeOccurredBefore(cutoff);
    activity = { ranAt: now, cutoff, deleted };
    await repos.integrations.saveState(ACTIVITY_RETENTION_STATE, now, JSON.stringify({ cutoff, deleted }), now);
  }
  return { notifications, activity };
};
