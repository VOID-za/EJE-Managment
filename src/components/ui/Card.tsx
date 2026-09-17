import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CardProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly padded?: boolean;
}

export const Card = ({ children, className, padded = true }: CardProps) => (
  <section
    className={cn(
      'rounded-[var(--radius-card)] border border-steel-200 bg-white shadow-[var(--shadow-card)]',
      padded && 'p-5',
      className,
    )}
  >
    {children}
  </section>
);

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

export const CardHeader = ({ title, description, action, className }: CardHeaderProps) => (
  <header className={cn('flex items-start justify-between gap-4', className)}>
    <div className="min-w-0">
      <h2 className="text-base font-semibold text-steel-900">{title}</h2>
      {description !== undefined && (
        <p className="mt-1 text-sm text-steel-500">{description}</p>
      )}
    </div>
    {action !== undefined && <div className="shrink-0">{action}</div>}
  </header>
);
