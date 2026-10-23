import { roleLabel, userFullName, type User } from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';

/**
 * EVERY SPREADSHEET EXPORT IS RECORDED, AND KEPT. BD-18, ANSWERED.
 *
 * The owner answered BD-18 (#57) on 23 October 2026: audit all exports, and
 * retain the records indefinitely. So this file no longer has a switch.
 *
 * WHAT IT USED TO BE, because the history explains the shape. It began as a
 * mechanism that wrote NOTHING — `EXPORT_AUDIT.recording === false` — and then
 * as an environment variable, `EJE_EXPORT_AUDIT`, so that answering the
 * question would not need a release. Both were ways of not deciding on EJE's
 * behalf. The decision is made, so the conditional is gone: there is no
 * configuration that turns this off, which is what "audit all exports" means.
 *
 * THE THREE THINGS THAT MADE IT A DECISION, and what the answer settles:
 *
 *  1. WHAT THE TRAIL MEANS. Every other event on it is a CHANGE to a record;
 *     this is the first READ. The owner has accepted that, and the activity
 *     screen gives exports their own filter group so the two kinds stay
 *     distinguishable rather than mixed into "Record changes".
 *  2. WHAT THE OFFICE SEES. One group, on a screen only the office can read
 *     (`activity.viewAll` — a Master or a Coordinator, never a technician).
 *  3. WHAT EJE RETAIN ABOUT THEIR OWN STAFF. "Who exported the customer list,
 *     when, with which filters" is monitoring, and the owner has decided it is
 *     monitoring EJE want, kept indefinitely. NOTHING IN THIS SYSTEM EXPIRES
 *     OR DELETES AN AUDIT EVENT — there is no retention job, no sweeper and no
 *     TTL, so "indefinitely" is the behaviour rather than a promise. The
 *     backup carries the events with every other row.
 *
 * WHAT IS NEVER RECORDED: THE ROWS. An audit entry holding a copy of the
 * exported data would be a second, unreviewed store of the same customer
 * information, and a trail is supposed to say what happened rather than keep
 * the goods. No prices either, even now that the office may export them — the
 * record says which COLUMNS were taken, not what was in them.
 */
/** Which export was taken. Not a capability and not a route — a name. */
export type ExportKind = 'jobs' | 'closed-jobs';

/**
 * WHAT WOULD BE RECORDED, and as importantly what would not.
 *
 * The filters and the row count, because "who took what" is the whole value of
 * such a record. NOT the rows: an audit entry holding a copy of the exported
 * data would be a second, unreviewed store of the same customer information,
 * and a trail is supposed to say what happened rather than keep the goods.
 * No prices either, for the same reason the export carries none (BD-17).
 */
export interface ExportRecord {
  readonly kind: ExportKind;
  readonly actorId: string;
  readonly actorRole: User['role'];
  /** The filters as the request carried them, with no values expanded. */
  readonly filters: Readonly<Record<string, string>>;
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly takenAt: string;
}

export const describeExport = (input: {
  readonly kind: ExportKind;
  readonly actor: Pick<User, 'id' | 'role'>;
  readonly filters: Readonly<Record<string, string>>;
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly takenAt: string;
}): ExportRecord => ({
  kind: input.kind,
  actorId: input.actor.id,
  actorRole: input.actor.role,
  // Copied rather than referenced, and only the filter NAMES and values the
  // request itself carried — nothing is resolved into a customer's name here.
  filters: { ...input.filters },
  rowCount: input.rowCount,
  columns: [...input.columns],
  takenAt: input.takenAt,
});

export interface ExportAuditOutcome {
  /**
   * Always true since BD-18 was answered.
   *
   * Kept on the outcome rather than removed, because the export ROUTES read it
   * and a test asserts it — and because a field that is always true is a
   * cheaper thing to read than a comment claiming it.
   */
  readonly written: boolean;
  /** The record that was written, for a test to inspect. */
  readonly record: ExportRecord;
  readonly reason: string;
}

/**
 * THE BOUNDARY, AND IT WRITES. BD-18, answered.
 *
 * Called by both export routes, AFTER the file has been built — so an export
 * that was refused for authority or for being too large records nothing, which
 * is right: nothing left the building.
 *
 * WHAT IS WRITTEN: who, when, which export, which filters, how many rows and
 * which columns. NOT THE ROWS — an audit entry holding a copy of the exported
 * data would be a second, unreviewed store of the same customer information,
 * and a trail is supposed to say what happened rather than keep the goods.
 *
 * `jobId: null` because an export is not about one job. It appears on the
 * activity screen under its own "Exports" group, which is where somebody
 * looking for "who took the customer list" would look — and which keeps it
 * distinguishable from the record CHANGES that are every other event there.
 *
 * IT IS PERSISTED LIKE EVERY OTHER AUDIT EVENT, through `audit` into
 * `audit_events`, inside the caller's transaction. Nothing in this system
 * expires or deletes one.
 */
export const recordExport = async (
  context: OperationContext,
  record: ExportRecord,
): Promise<ExportAuditOutcome> => {
  await audit(context, {
    jobId: null,
    type: 'data_exported',
    summary: `${EXPORT_LABEL[record.kind]} exported: ${record.rowCount} row(s)`,
    detail:
      `${EXPORT_LABEL[record.kind]} downloaded as a spreadsheet by ${userFullName(context.actor)} ` +
      `(${roleLabel(context.actor.role)}). ` +
      `${record.rowCount} row(s), ${record.columns.length} column(s)` +
      `${describeFilters(record.filters)}.`,
    /*
     * THE FILTERS AS STRUCTURED CHANGE VALUES, which is how AUDIT-2 carries
     * anything a person may need to compare later. `from` is null for all of
     * them: an export does not change a value, it records one that was asked
     * for.
     */
    changes: Object.entries(record.filters)
      .filter(([, value]) => value.length > 0 && value !== 'all')
      .map(([field, value]) => ({ field, from: null, to: value })),
  });

  return { written: true, record, reason: '' };
};

/** How each export is named on the trail. Never invented twice. */
const EXPORT_LABEL: Readonly<Record<ExportKind, string>> = {
  jobs: 'The Jobs list',
  'closed-jobs': 'The closed-job archive',
};

/** The filters in one readable clause, or nothing when none were applied. */
const describeFilters = (filters: Readonly<Record<string, string>>): string => {
  const applied = Object.entries(filters).filter(
    ([, value]) => value.length > 0 && value !== 'all',
  );
  return applied.length === 0
    ? ', unfiltered'
    : `, filtered by ${applied.map(([field, value]) => `${field}=${value}`).join(', ')}`;
};
