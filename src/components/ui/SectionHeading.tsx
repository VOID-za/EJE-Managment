import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SectionHeadingProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly className?: string;
}

export const SectionHeading = ({
  title,
  description,
  action,
  className,
}: SectionHeadingProps) => (
  <div className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
    <div>
      <h2 className="text-lg font-semibold text-steel-900">{title}</h2>
      {description !== undefined && <p className="mt-0.5 text-sm text-steel-500">{description}</p>}
    </div>
    {action !== undefined && <div>{action}</div>}
  </div>
);

export interface DefinitionItem {
  readonly label: string;
  readonly value: ReactNode;
  readonly wide?: boolean;
}

/** Read-only key/value grid used across customer, machine and job detail pages. */
export const DefinitionGrid = ({
  items,
  columns = 2,
  className,
}: {
  readonly items: readonly DefinitionItem[];
  readonly columns?: 1 | 2 | 3;
  readonly className?: string;
}) => (
  <dl
    className={cn(
      'grid gap-x-6 gap-y-4',
      columns === 1 && 'grid-cols-1',
      columns === 2 && 'grid-cols-1 sm:grid-cols-2',
      columns === 3 && 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
      className,
    )}
  >
    {items.map((item) => (
      <div key={item.label} className={cn(item.wide === true && 'sm:col-span-2 lg:col-span-3')}>
        <dt className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
          {item.label}
        </dt>
        <dd className="mt-1 text-sm break-words text-steel-800">{item.value}</dd>
      </div>
    ))}
  </dl>
);
