import { cn } from '@/lib/cn';

/**
 * EJE wordmark. The bracket motif reads as an electronics enclosure and keeps
 * the identity industrial rather than corporate-generic.
 */
export const Logo = ({
  className,
  variant = 'dark',
}: {
  readonly className?: string;
  readonly variant?: 'dark' | 'light';
}) => (
  <span className={cn('inline-flex items-center gap-2.5', className)}>
    <span
      className={cn(
        'relative flex size-9 items-center justify-center rounded-[0.55rem] font-black tracking-tighter',
        variant === 'dark'
          ? 'bg-eje-500 text-white'
          : 'bg-surface text-eje-700 ring-1 ring-steel-200',
      )}
    >
      <span className="text-[13px]">EJE</span>
      <span
        className={cn(
          'absolute inset-x-1.5 bottom-1 h-px',
          variant === 'dark' ? 'bg-white/45' : 'bg-eje-300',
        )}
        aria-hidden="true"
      />
    </span>
    <span className="flex min-w-0 flex-col leading-tight">
      <span
        className={cn(
          'text-sm font-bold tracking-tight',
          variant === 'dark' ? 'text-white' : 'text-steel-900',
        )}
      >
        EJE Industrial
      </span>
      <span
        className={cn(
          'text-[11px] font-medium tracking-wide uppercase',
          variant === 'dark' ? 'text-chrome-dim' : 'text-chrome-faint',
        )}
      >
        Job Card System
      </span>
    </span>
  </span>
);
