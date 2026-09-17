import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './Button';

/** Loading, empty and error states are first-class: every list uses one. */

export const Skeleton = ({ className }: { readonly className?: string }) => (
  <div
    className={cn('animate-pulse rounded-[var(--radius-control)] bg-steel-200/70', className)}
    aria-hidden="true"
  />
);

export const LoadingPanel = ({ rows = 4, label }: { readonly rows?: number; readonly label?: string }) => (
  <div role="status" aria-live="polite" className="space-y-3">
    <span className="sr-only">{label ?? 'Loading'}</span>
    {Array.from({ length: rows }, (_, index) => (
      <div
        key={index}
        className="flex items-center gap-4 rounded-[var(--radius-card)] border border-steel-200 bg-white p-4"
      >
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
        <Skeleton className="h-6 w-20 rounded-full" />
      </div>
    ))}
  </div>
);

export interface EmptyStateProps {
  readonly title: string;
  readonly description: string;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
}

export const EmptyState = ({ title, description, icon, action, className }: EmptyStateProps) => (
  <div
    className={cn(
      'flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-steel-300 bg-steel-50/60 px-6 py-12 text-center',
      className,
    )}
  >
    <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-white text-steel-400 ring-1 ring-steel-200">
      {icon ?? (
        <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
          <path
            d="M4 7h16M4 12h16M4 17h10"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
    <p className="text-sm font-semibold text-steel-800">{title}</p>
    <p className="mt-1 max-w-md text-sm text-steel-500">{description}</p>
    {action !== undefined && <div className="mt-4">{action}</div>}
  </div>
);

export interface ErrorStateProps {
  readonly title?: string;
  readonly message: string;
  readonly onRetry?: () => void;
}

export const ErrorState = ({
  title = 'Something went wrong',
  message,
  onRetry,
}: ErrorStateProps) => (
  <div
    role="alert"
    className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-signal-200 bg-signal-50 px-6 py-10 text-center"
  >
    <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-white text-signal-600 ring-1 ring-signal-200">
      <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden="true">
        <path
          d="M12 8v5m0 3h.01M10.3 3.9 2.6 17.3A2 2 0 0 0 4.3 20.3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
    <p className="text-sm font-semibold text-signal-700">{title}</p>
    <p className="mt-1 max-w-md text-sm text-signal-600">{message}</p>
    {onRetry !== undefined && (
      <Button variant="secondary" className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    )}
  </div>
);
