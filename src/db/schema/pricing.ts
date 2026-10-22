import { sql } from 'drizzle-orm';
import { check, index, integer, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { cents, createdAt, instant, primaryId } from './columns';
import { pricingSnapshotReason } from './enums';
import { jobs } from './jobs';
import { signatureRefusals, jobSignatures } from './signatures';

/**
 * What the job was priced at, frozen. WRITE-ONCE.
 *
 * The rates are COPIED, not referenced. Storing a settings id would not be
 * enough: the settings row is mutable, so a later rate change would silently
 * re-price a job card the customer has already signed. The values themselves
 * are here so the arithmetic on a historical document can be reproduced exactly
 * as the customer saw it.
 *
 * A snapshot is taken at the signature stage — whether the customer signed or
 * refused — because in both cases the work happened and the figure is the
 * figure.
 */
export const pricingSnapshots = pgTable(
  'pricing_snapshots',
  {
    id: primaryId(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),

    /**
     * Which attempt this snapshot belongs to.
     *
     * Normally 1. A refusal corrected and resubmitted may produce a second
     * snapshot when the corrected card is signed, and the first one stays
     * exactly as it was — that is the whole point of not overwriting.
     */
    attempt: integer('attempt').notNull().default(1),
    /** The signature this priced, where there is one. */
    signatureId: uuid('signature_id').references(() => jobSignatures.id),
    /** The refusal this priced, where the customer would not sign. */
    refusalId: uuid('refusal_id').references(() => signatureRefusals.id),

    /* ---- the rates in force at that moment, copied ---- */
    labourNormalCents: cents('labour_normal_cents').notNull(),
    labourOvertimeCents: cents('labour_overtime_cents').notNull(),
    labourDoubleCents: cents('labour_double_cents').notNull(),
    calloutRateCents: cents('callout_rate_cents').notNull(),
    kilometreRateCents: cents('kilometre_rate_cents').notNull(),
    /** Hundredths of a percent: 1500 is 15%. */
    vatPercentBasisPoints: integer('vat_percent_basis_points').notNull(),

    /* ---- the totals that were actually shown ---- */
    /**
     * What the work came to BEFORE the discount, and the discount. COST-5.
     *
     * Both written down, because the question the office is asked afterwards is
     * "what was it before you came down" and the answer has to be in the record
     * rather than reconstructed by adding the lines back up. Nullable: every
     * snapshot taken before COST-5 existed has no discount to record and no
     * gross figure distinct from `subtotal_cents`, and a zero would claim a
     * measurement that was never taken.
     */
    grossSubtotalCents: cents('gross_subtotal_cents'),
    discountCents: cents('discount_cents'),
    subtotalCents: cents('subtotal_cents').notNull(),
    vatCents: cents('vat_cents').notNull(),
    totalCents: cents('total_cents').notNull(),

    capturedAt: instant('captured_at').notNull(),
    reason: pricingSnapshotReason('reason').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('pricing_snapshots_job_attempt_key').on(table.jobId, table.attempt),
    index('pricing_snapshots_job_idx').on(table.jobId),
    check(
      'pricing_snapshots_amounts_non_negative',
      sql`${table.subtotalCents} >= 0 and ${table.vatCents} >= 0 and ${table.totalCents} >= 0`,
    ),
    check('pricing_snapshots_attempt_positive', sql`${table.attempt} >= 1`),
    /*
     * COST-5. The discount cannot exceed the work, and the two new columns are
     * both present or both absent — a gross figure with no discount beside it
     * cannot be told from a snapshot written before this existed.
     */
    check(
      'pricing_snapshots_discount_within_gross',
      sql`(${table.grossSubtotalCents} is not null) = (${table.discountCents} is not null)
          and (${table.discountCents} is null or ${table.discountCents} >= 0)
          and (${table.grossSubtotalCents} is null
               or ${table.grossSubtotalCents} >= ${table.discountCents})`,
    ),
  ],
);

/**
 * The priced lines, as they stood. WRITE-ONCE.
 *
 * The demo stores only the RATES and recomputes line totals from the job's
 * current lines. That is correct only while the job cannot change, and a Master
 * may legitimately amend a job after the customer signed but before it is
 * issued — `master_amended_after_signature` exists precisely because that
 * happens. Materialising the lines here makes "what did the customer actually
 * sign for?" answerable from one row set, for ever.
 *
 * `source_line_id` points at the job line it came from and is deliberately NOT
 * a foreign key: the line may later be corrected or removed, and this record
 * must survive that untouched.
 */
export const pricingSnapshotLines = pgTable(
  'pricing_snapshot_lines',
  {
    id: primaryId(),
    snapshotId: uuid('snapshot_id')
      .notNull()
      .references(() => pricingSnapshots.id, { onDelete: 'cascade' }),
    /** `labour` | `travel` | `part` | `callout` | `additional_charge` | `discount`. */
    lineKind: text('line_kind').notNull(),
    /** The id of the job line this was priced from. Not an FK, by design. */
    sourceLineId: uuid('source_line_id'),
    position: integer('position').notNull(),

    description: text('description').notNull(),
    detail: text('detail').notNull().default(''),
    quantity: numeric('quantity', { precision: 12, scale: 2 }).notNull(),
    unitLabel: text('unit_label').notNull().default(''),
    unitPriceCents: cents('unit_price_cents').notNull(),
    lineTotalCents: cents('line_total_cents').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('pricing_snapshot_lines_position_key').on(table.snapshotId, table.position),
    index('pricing_snapshot_lines_snapshot_idx').on(table.snapshotId),
    /*
     * COST-5 MADE THIS STRICTER RATHER THAN LOOSER.
     *
     * It read "every amount is non-negative", which was right while every line
     * was work. A discount line is money OFF and its total is negative, so the
     * rule is now per kind: a discount must be strictly negative, everything
     * else non-negative. That refuses two rows the old check accepted — a
     * discount recorded as a positive amount, which would have been ADDED by
     * anything summing the lines, and a discount of zero.
     */
    check(
      'pricing_snapshot_lines_amounts_non_negative',
      sql`case when ${table.lineKind} = 'discount'
               then ${table.unitPriceCents} < 0 and ${table.lineTotalCents} < 0
               else ${table.unitPriceCents} >= 0 and ${table.lineTotalCents} >= 0
          end`,
    ),
  ],
);
