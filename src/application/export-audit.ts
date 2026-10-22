import { roleLabel, userFullName, type User } from '@/domain';
import type { OperationContext } from './context';
import { audit } from './audit';

/**
 * WHETHER AN EXPORT IS RECORDED IS NOT THIS FILE'S DECISION. BD-18.
 *
 * SEARCH-4 gave the office two spreadsheet exports. Issue #25 asked a third
 * question with them — *"is an export recorded in the audit trail (a bulk read
 * of customer data is worth a trail)?"* — and it has not been answered. This
 * file is the mechanism, built so that answering it is a one-line change and
 * so that NOT answering it costs nothing.
 *
 * IT WRITES NOTHING TODAY, deliberately and visibly:
 *
 *   `EXPORT_AUDIT.recording === false`
 *
 * and `recordExport` returns the record it WOULD have written. The export
 * routes call it, so the call site is real and tested rather than imagined, and
 * the activity trail is untouched — which `export-audit.test.ts` asserts by
 * counting events before and after an export.
 *
 * WHY NOT JUST WRITE THE EVENT AND BE DONE. Three reasons, each a change to
 * something the owner owns:
 *
 *  1. IT CHANGES WHAT THE TRAIL MEANS. Every event in it today is a CHANGE to
 *     a record — a job accepted, a line amended, a document approved. Reads are
 *     not on it, anywhere. Adding one kind of read makes the trail's silence
 *     about every other read significant in a way it was not before.
 *  2. IT CHANGES WHAT THE OFFICE SEES. The activity screen is where a Master
 *     looks for what happened to a job. A trail where every download of the
 *     Jobs list appears is a trail somebody has to filter before it is useful,
 *     and that is a decision about their screen, not a detail of an export.
 *  3. IT IS A NEW RETAINED RECORD ABOUT A PERSON. "Who exported the customer
 *     list, when, and with which filters" is monitoring of staff. Useful,
 *     defensible, and not something to switch on without asking.
 *
 * WHAT ENABLING IT WOULD TAKE, so the recommendation is precise rather than
 * "wire it up": set `recording` to true, add `data_exported` to
 * `ActivityEventType`, give it an icon and a filter group on the activity
 * screen, and decide retention. The `audit_events.type` column is `text`, so
 * no migration is needed. See BD-18 in `docs/SCOPE.md`.
 */
/**
 * WHETHER THIS DEPLOYMENT RECORDS EXPORTS. BD-18, and still EJE's to answer.
 *
 * IT IS NOW CONFIGURATION RATHER THAN A CONSTANT IN THE SOURCE, and the
 * difference matters in both directions:
 *
 *  - A boolean in a file is flipped by whoever is reading the file, which is
 *    how an unapproved record about EJE's own staff gets switched on by
 *    somebody who thought they were finishing a feature. An environment
 *    variable is a deployment decision, made by whoever administers the
 *    server, in the file where the other decisions of that kind live.
 *  - And it means ANSWERING BD-18 does not need a release. The write is built,
 *    tested and off; `EJE_EXPORT_AUDIT=on` turns it on.
 *
 * OFF ON EVERY DEPLOYMENT TODAY, which `export-audit.test.ts` asserts by
 * counting events before and after a real export. The three things that made
 * this a decision rather than a detail are unchanged and are listed above.
 */
export const exportAuditEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => (env.EJE_EXPORT_AUDIT ?? '').trim().toLowerCase() === 'on';

export const EXPORT_AUDIT = {
  /**
   * Whether the trail is written, read from the environment at call time.
   *
   * A getter rather than a value, so a test can set the variable and see the
   * change without reloading the module — and so nothing caches a decision
   * somebody made after the process started.
   */
  get recording(): boolean {
    return exportAuditEnabled();
  },
  reason:
    'Whether an export is recorded on the audit trail is an open business decision (BD-18). ' +
    'The mechanism is built and switched off: set EJE_EXPORT_AUDIT=on to record them.',
} as const;

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
  /** False while BD-18 is open. There is no other value today. */
  readonly written: boolean;
  /** The record that would have been written, for a test to inspect. */
  readonly record: ExportRecord;
  readonly reason: string;
}

/**
 * The boundary. Called by the export routes; writes nothing while BD-18 is open.
 *
 * It takes an `OperationContext` it does not currently use, and that is the
 * point: the signature is the one a real implementation needs (an actor, a
 * clock and a repository bundle), so switching it on is a change inside this
 * function rather than a change at every call site.
 */
export const recordExport = async (
  context: OperationContext,
  record: ExportRecord,
): Promise<ExportAuditOutcome> => {
  if (!EXPORT_AUDIT.recording) {
    return { written: false, record, reason: EXPORT_AUDIT.reason };
  }

  /*
   * THE WRITE, AND IT IS A REAL ONE NOW.
   *
   * It used to throw here, on the reasoning that an implementation which looks
   * finished is how an unapproved side effect gets switched on. That reasoning
   * was right about a BOOLEAN IN THE SOURCE and wrong about a deployment
   * variable: a server that sets `EJE_EXPORT_AUDIT=on` has decided, and
   * answering it with an exception would mean the exports stop working — which
   * is a worse answer than either yes or no.
   *
   * WHAT IS WRITTEN: who, when, which export, which filters, how many rows and
   * which columns. NOT THE ROWS — an audit entry holding a copy of the exported
   * data would be a second, unreviewed store of the same customer information,
   * and a trail is supposed to say what happened rather than keep the goods.
   *
   * `jobId: null` because an export is not about one job. It appears on the
   * activity screen under "Record changes" with the `export` icon, which is
   * where somebody looking for "who took the customer list" would look.
   */
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
