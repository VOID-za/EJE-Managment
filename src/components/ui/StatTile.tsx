import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type StatTone = 'neutral' | 'blue' | 'amber' | 'red' | 'green' | 'violet';

const TONES: Record<StatTone, { accent: string; value: string; icon: string }> = {
  neutral: { accent: 'bg-steel-400', value: 'text-steel-900', icon: 'bg-steel-100 text-steel-600' },
  blue: { accent: 'bg-eje-500', value: 'text-steel-900', icon: 'bg-eje-50 text-eje-600' },
  amber: {
    accent: 'bg-amber-eje-500',
    value: 'text-steel-900',
    icon: 'bg-amber-eje-50 text-amber-eje-700',
  },
  red: { accent: 'bg-signal-500', value: 'text-signal-700', icon: 'bg-signal-50 text-signal-600' },
  green: {
    accent: 'bg-verdant-500',
    value: 'text-steel-900',
    icon: 'bg-verdant-50 text-verdant-600',
  },
  violet: {
    accent: 'bg-violet-eje-500',
    value: 'text-steel-900',
    icon: 'bg-violet-eje-50 text-violet-eje-700',
  },
};

export interface StatTileProps {
  readonly label: string;
  readonly value: number | string;
  readonly caption?: string;
  readonly tone?: StatTone;
  readonly icon?: ReactNode;
  readonly href?: string;
}

export const StatTile = ({
  label,
  value,
  caption,
  tone = 'neutral',
  icon,
  href,
}: StatTileProps) => {
  const palette = TONES[tone];

  const body = (
    <div className="relative flex h-full items-start gap-4 overflow-hidden rounded-[var(--radius-card)] border border-steel-200 bg-white p-5 shadow-[var(--shadow-card)] transition-shadow group-hover:shadow-[var(--shadow-raised)]">
      <span
        className={cn('absolute inset-y-0 left-0 w-1', palette.accent)}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 pl-1">
        <p className="text-xs font-semibold tracking-wide text-steel-500 uppercase">{label}</p>
        <p className={cn('tabular mt-2 text-3xl leading-none font-bold', palette.value)}>{value}</p>
        {caption !== undefined && <p className="mt-2 text-xs text-steel-500">{caption}</p>}
      </div>
      {icon !== undefined && (
        <span
          className={cn('flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)]', palette.icon)}
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
    </div>
  );

  if (href === undefined) return <div className="group h-full">{body}</div>;

  return (
    <Link href={href} className="group block h-full">
      {body}
    </Link>
  );
};
