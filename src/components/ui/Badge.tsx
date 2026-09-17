import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone =
  | 'neutral'
  | 'blue'
  | 'green'
  | 'amber'
  | 'red'
  | 'violet'
  | 'outline';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-steel-100 text-steel-700 ring-steel-200',
  blue: 'bg-eje-50 text-eje-700 ring-eje-200',
  green: 'bg-verdant-50 text-verdant-700 ring-verdant-200',
  amber: 'bg-amber-eje-50 text-amber-eje-700 ring-amber-eje-200',
  red: 'bg-signal-50 text-signal-700 ring-signal-200',
  violet: 'bg-violet-eje-50 text-violet-eje-700 ring-violet-eje-100',
  outline: 'bg-surface text-steel-600 ring-steel-300',
};

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
  readonly dot?: boolean;
  readonly className?: string;
  readonly size?: 'sm' | 'md';
}

export const Badge = ({
  children,
  tone = 'neutral',
  dot = false,
  size = 'md',
  className,
}: BadgeProps) => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 rounded-full font-semibold ring-1 ring-inset whitespace-nowrap',
      size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
      TONES[tone],
      className,
    )}
  >
    {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
    {children}
  </span>
);
