import { cn } from '@/lib/cn';

/**
 * Initial-based avatar. The colour is derived from the initials so the same
 * person is always the same colour without storing an avatar image.
 */
const PALETTE = [
  'bg-eje-100 text-eje-700',
  'bg-verdant-100 text-verdant-700',
  'bg-amber-eje-100 text-amber-eje-700',
  'bg-violet-eje-100 text-violet-eje-700',
  'bg-steel-200 text-steel-700',
] as const;

const SIZES = {
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-xs',
  lg: 'size-12 text-sm',
} as const;

export interface AvatarProps {
  readonly initials: string;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
  readonly title?: string;
}

export const Avatar = ({ initials, size = 'md', className, title }: AvatarProps) => {
  const seed = [...initials].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const palette = PALETTE[seed % PALETTE.length] ?? PALETTE[0];

  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold tracking-wide select-none',
        SIZES[size],
        palette,
        className,
      )}
    >
      {initials}
    </span>
  );
};
