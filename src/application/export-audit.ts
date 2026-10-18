import type { User } from '@/domain';
import type { OperationContext } from './context';

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
export const EXPORT_AUDIT = {
  /** OFF until EJE answer BD-18. Nothing here writes to the trail. */
  recording: false,
  reason:
    'Whether an export is recorded on the audit trail is an open business decision (BD-18). The mechanism exists and writes nothing.',
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
  _context: OperationContext,
  record: ExportRecord,
): Promise<ExportAuditOutcome> => {
  if (!EXPORT_AUDIT.recording) {
    return { written: false, record, reason: EXPORT_AUDIT.reason };
  }
  /*
   * UNREACHABLE WHILE `recording` IS FALSE, and left as a refusal rather than
   * a half-written `audit()` call: an implementation that looks finished is
   * how an unapproved side effect gets switched on by somebody flipping a
   * boolean they found. BD-18 names what else has to be decided first.
   */
  throw new Error(
    'Export auditing is not implemented: BD-18 is open, and enabling it needs an event type, an activity-screen filter and a retention decision.',
  );
};
