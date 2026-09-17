import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/ui';

export interface Breadcrumb {
  readonly label: string;
  readonly href?: string;
}

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: string;
  readonly breadcrumbs?: readonly Breadcrumb[];
  readonly actions?: ReactNode;
  readonly meta?: ReactNode;
  readonly className?: string;
}

export const PageHeader = ({
  title,
  description,
  breadcrumbs,
  actions,
  meta,
  className,
}: PageHeaderProps) => (
  <div className={cn('mb-6', className)}>
    {breadcrumbs !== undefined && breadcrumbs.length > 0 && (
      <nav aria-label="Breadcrumb" className="mb-2">
        <ol className="flex flex-wrap items-center gap-1 text-xs text-steel-500">
          {breadcrumbs.map((crumb, index) => (
            <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
              {index > 0 && <Icon name="chevronRight" className="size-3 text-steel-300" />}
              {crumb.href === undefined ? (
                <span className="font-medium text-steel-600">{crumb.label}</span>
              ) : (
                <Link href={crumb.href} className="hover:text-eje-600 hover:underline">
                  {crumb.label}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>
    )}

    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-steel-900 sm:text-[28px]">
          {title}
        </h1>
        {description !== undefined && (
          <p className="mt-1.5 max-w-3xl text-sm text-steel-500">{description}</p>
        )}
        {meta !== undefined && <div className="mt-3">{meta}</div>}
      </div>
      {actions !== undefined && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  </div>
);
