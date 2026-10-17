'use client';

import { Icon } from '@/components/ui';
import type { CacheStatus } from '@/lib/pwa/cache-state';
import { cn } from '@/lib/cn';

/**
 * SAYS WHICH COPY THIS IS. PWA-6, OFF-8.
 *
 * The one rule: a screen showing cached records must say so, and say when they
 * arrived. A list that looks the same whether it is current or four days old
 * is the failure this exists to prevent — the technician trusts it either way,
 * and "that job was cancelled this morning" is precisely the kind of thing
 * that moves while a tablet is out of signal.
 *
 * Current data gets a quiet line; anything stale gets amber and a timestamp.
 * Neither ever claims more than it knows.
 */
export const CacheStatusNotice = ({
  status,
  className,
}: {
  readonly status: CacheStatus;
  readonly className?: string;
}) => (
  <div
    role="status"
    data-cache-state={status.kind}
    className={cn(
      'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
      status.stale
        ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100'
        : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300',
      className,
    )}
  >
    <Icon
      name={status.stale ? 'warning' : 'check'}
      className="mt-0.5 size-4 shrink-0"
      aria-hidden
    />
    <span className="min-w-0">
      <strong className="font-semibold">{status.title}.</strong> {status.detail}
    </span>
  </div>
);
