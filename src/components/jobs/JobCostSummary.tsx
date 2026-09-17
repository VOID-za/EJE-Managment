import { calculateJobTotals, type Job, type SystemSettings } from '@/domain';
import { Badge, Icon } from '@/components/ui';
import { formatCurrency, formatDate, formatHours, formatKilometres } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * Job costing summary.
 *
 * Every figure comes from `calculateJobTotals`, which is the same function the
 * invoice will use. Once a job is signed the figures come from its pricing
 * snapshot, and the panel says so — a signed total must never look like a live
 * one that could still move.
 */
export const JobCostSummary = ({
  job,
  settings,
  className,
}: {
  readonly job: Job;
  readonly settings: SystemSettings;
  readonly className?: string;
}) => {
  const totals = calculateJobTotals(job, settings);

  const rows = [
    { label: 'Labour', detail: formatHours(totals.totalHours), value: totals.labourTotal },
    ...(job.calloutApplied
      ? [{ label: 'Call-out', detail: 'Fixed fee', value: totals.calloutTotal }]
      : []),
    { label: 'Travel', detail: formatKilometres(totals.totalKilometres), value: totals.travelTotal },
    {
      label: 'Parts',
      detail: `${job.parts.length} ${job.parts.length === 1 ? 'line' : 'lines'}`,
      value: totals.partsTotal,
    },
  ];

  return (
    <div className={cn('rounded-[var(--radius-card)] bg-steel-50 p-4', className)}>
      <dl className="space-y-2.5">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-3 text-sm">
            <dt className="text-steel-600">
              {row.label}
              <span className="ml-1.5 text-xs text-steel-400">{row.detail}</span>
            </dt>
            <dd className="tabular font-medium text-steel-800">{formatCurrency(row.value)}</dd>
          </div>
        ))}

        <div className="flex items-baseline justify-between gap-3 border-t border-steel-200 pt-2.5 text-sm">
          <dt className="font-medium text-steel-700">Subtotal</dt>
          <dd className="tabular font-semibold text-steel-900">
            {formatCurrency(totals.subtotal)}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <dt className="text-steel-600">VAT @ {totals.pricing.vatPercentage}%</dt>
          <dd className="tabular text-steel-800">{formatCurrency(totals.vat)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-steel-300 pt-2.5">
          <dt className="text-sm font-semibold text-steel-900">Total</dt>
          <dd className="tabular text-lg font-bold text-steel-900">
            {formatCurrency(totals.total)}
          </dd>
        </div>
      </dl>

      {totals.priceFrozen ? (
        <p className="mt-3 flex items-start gap-1.5 border-t border-steel-200 pt-3 text-xs text-steel-500">
          <Icon name="check" className="mt-0.5 size-3.5 shrink-0 text-verdant-600" />
          <span>
            Priced at the rates in force when the customer signed on{' '}
            {formatDate(job.pricingSnapshot?.capturedAt ?? null)}. Later rate changes do not affect
            this job.
          </span>
        </p>
      ) : (
        <p className="mt-3 border-t border-steel-200 pt-3 text-xs text-steel-500">
          Priced at current rates. These figures are fixed when the customer signs.
        </p>
      )}
    </div>
  );
};

/** Compact marker for lists and headers. */
export const PricingFrozenBadge = ({ job }: { readonly job: Job }) =>
  job.pricingSnapshot === null ? null : (
    <Badge tone="neutral" size="sm">
      Rates fixed at signature
    </Badge>
  );
