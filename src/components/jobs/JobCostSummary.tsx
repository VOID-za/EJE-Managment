import { calculateJobTotals, type Job, type SystemSettings } from '@/domain';
import { formatCurrency, formatHours, formatKilometres } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * Job costing summary. Every figure comes from `calculateJobTotals`, which is
 * the same function the invoice will use, so the demo cannot drift from the
 * real arithmetic.
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
          <dt className="text-steel-600">VAT @ {settings.vatPercentage}%</dt>
          <dd className="tabular text-steel-800">{formatCurrency(totals.vat)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 border-t border-steel-300 pt-2.5">
          <dt className="text-sm font-semibold text-steel-900">Total</dt>
          <dd className="tabular text-lg font-bold text-steel-900">
            {formatCurrency(totals.total)}
          </dd>
        </div>
      </dl>
    </div>
  );
};
