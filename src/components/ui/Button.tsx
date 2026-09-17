import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-action text-white shadow-sm hover:bg-action-hover active:bg-action-active disabled:bg-steel-300 disabled:text-steel-500',
  secondary:
    'bg-surface text-steel-800 ring-1 ring-inset ring-steel-300 hover:bg-steel-50 active:bg-steel-100 disabled:text-steel-400 disabled:bg-steel-50',
  ghost:
    'bg-transparent text-steel-700 hover:bg-steel-100 active:bg-steel-200 disabled:text-steel-400',
  danger:
    'bg-danger text-white shadow-sm hover:bg-danger-hover active:bg-danger-hover disabled:bg-steel-300 disabled:text-steel-500',
  success:
    'bg-success text-white shadow-sm hover:bg-success-hover active:bg-success-hover disabled:bg-steel-300 disabled:text-steel-500',
};

/** Sizes keep a minimum 44px target so the UI stays usable with gloves on a tablet. */
const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-11 px-4 text-sm gap-2',
  lg: 'h-13 px-6 text-base gap-2.5',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly fullWidth?: boolean;
  readonly leadingIcon?: ReactNode;
  readonly trailingIcon?: ReactNode;
  readonly loading?: boolean;
}

export const Button = ({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  leadingIcon,
  trailingIcon,
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) => (
  <button
    type={type}
    disabled={disabled === true || loading}
    aria-busy={loading || undefined}
    className={cn(
      'inline-flex items-center justify-center rounded-[var(--radius-control)] font-semibold',
      'transition-colors duration-150 select-none',
      'disabled:cursor-not-allowed',
      VARIANTS[variant],
      SIZES[size],
      fullWidth && 'w-full',
      className,
    )}
    {...rest}
  >
    {loading ? <Spinner /> : leadingIcon}
    {children}
    {!loading && trailingIcon}
  </button>
);

const Spinner = () => (
  <svg
    className="size-4 animate-spin"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
    <path
      d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  </svg>
);
