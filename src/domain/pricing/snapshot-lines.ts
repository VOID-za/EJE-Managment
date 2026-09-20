import type { Cents } from '../types/common';
import type { Job, PricingSnapshot } from '../types/job';
import type { SystemSettings } from '../types/settings';
import { calculateJobTotals } from './totals';

/**
 * Settings that will never be consulted.
 *
 * `calculateJobTotals` takes settings as the fallback for a job with no
 * snapshot. Here there is always a snapshot — that is the whole point — and
 * `resolveJobPricing` prefers it unconditionally, so this exists only to
 * satisfy the signature. Building it from the snapshot rather than reading the
 * settings row means this function cannot be made wrong by a rate change, and
 * cannot fail because a settings row is missing.
 */
const settingsFromSnapshot = (snapshot: PricingSnapshot): SystemSettings =>
  ({
    labourRates: snapshot.labourRates,
    calloutRate: snapshot.calloutRate,
    kilometreRate: snapshot.kilometreRate,
    vatPercentage: snapshot.vatPercentage,
  }) as SystemSettings;

/**
 * The priced lines, materialised at the moment the price was frozen.
 *
 * The snapshot stores the RATES, and totals are normally recomputed from the
 * job's current lines using them. That is correct only while the job cannot
 * change — and a Master may legitimately amend a job after the customer signed
 * but before it is issued (`master_amended_after_signature` exists because that
 * happens). Once they do, "what did the customer actually sign for?" has no
 * answer left anywhere.
 *
 * So the lines are written down. This is the projection that does it: a pure
 * function over `calculateJobTotals`, which is the one place prices are
 * computed. Nothing here calculates anything — it labels and orders what the
 * domain already worked out, so the persistence layer never has to.
 */

export type PricingLineKind = 'labour' | 'callout' | 'travel' | 'part';

export interface PricingSnapshotLine {
  readonly kind: PricingLineKind;
  /** The job line this was priced from. Null for the call-out, which has none. */
  readonly sourceLineId: string | null;
  /** Stable ordering, so a reread renders the document the same way. */
  readonly position: number;
  readonly description: string;
  readonly detail: string;
  readonly quantity: number;
  /** "hrs", "km", "ea". */
  readonly unit: string;
  readonly unitPrice: Cents;
  readonly lineTotal: Cents;
}

export interface PricingSnapshotTotals {
  readonly subtotal: Cents;
  readonly vat: Cents;
  readonly total: Cents;
}

export interface MaterialisedPricingSnapshot {
  readonly lines: readonly PricingSnapshotLine[];
  readonly totals: PricingSnapshotTotals;
}

/**
 * Prices the job at the given snapshot and writes the result down.
 *
 * The snapshot is passed explicitly, and applied to the job, so a caller
 * freezing a NEW one — where the job does not carry it yet — gets the same
 * answer as a reread of an already-frozen job.
 */
export const materialisePricingSnapshot = (
  job: Pick<Job, 'labour' | 'travel' | 'parts' | 'calloutApplied' | 'pricingSnapshot'>,
  snapshot: PricingSnapshot,
): MaterialisedPricingSnapshot => {
  const totals = calculateJobTotals(
    { ...job, pricingSnapshot: snapshot },
    settingsFromSnapshot(snapshot),
  );
  const lines: PricingSnapshotLine[] = [];
  let position = 0;

  const push = (
    kind: PricingLineKind,
    sourceLineId: string | null,
    line: { label: string; detail: string; quantity: number; unit: string; unitPrice: Cents; total: Cents },
  ): void => {
    lines.push({
      kind,
      sourceLineId,
      position: position++,
      description: line.label,
      detail: line.detail,
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      lineTotal: line.total,
    });
  };

  // The same order the document prints them in: labour, call-out, travel, parts.
  totals.labourLines.forEach((line, index) => {
    push('labour', job.labour[index]?.id ?? null, line);
  });
  totals.calloutLines.forEach((line) => {
    push('callout', null, line);
  });
  totals.travelLines.forEach((line, index) => {
    push('travel', job.travel[index]?.id ?? null, line);
  });
  totals.partLines.forEach((line, index) => {
    push('part', job.parts[index]?.id ?? null, line);
  });

  return {
    lines,
    totals: { subtotal: totals.subtotal, vat: totals.vat, total: totals.total },
  };
};
