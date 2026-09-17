'use client';

import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useId } from 'react';
import { cn } from '@/lib/cn';

const CONTROL_BASE =
  'w-full rounded-[var(--radius-control)] border border-steel-300 bg-white text-steel-900 ' +
  'placeholder:text-steel-400 transition-colors ' +
  'hover:border-steel-400 focus:border-eje-500 focus:ring-2 focus:ring-eje-100 focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:bg-steel-50 disabled:text-steel-500';

interface FieldShellProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly error?: string;
  readonly required?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
}

const FieldShell = ({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: FieldShellProps) => (
  <div className={cn('flex flex-col gap-1.5', className)}>
    <label htmlFor={htmlFor} className="text-sm font-semibold text-steel-700">
      {label}
      {required === true && <span className="ml-1 text-signal-600">*</span>}
    </label>
    {children}
    {error !== undefined && error.length > 0 ? (
      <p className="text-xs font-medium text-signal-600">{error}</p>
    ) : (
      hint !== undefined && hint.length > 0 && <p className="text-xs text-steel-500">{hint}</p>
    )}
  </div>
);

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly containerClassName?: string;
}

export const TextField = ({
  label,
  hint,
  error,
  containerClassName,
  className,
  required,
  ...rest
}: TextFieldProps) => {
  const id = useId();
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={containerClassName}
    >
      <input
        id={id}
        required={required}
        aria-invalid={error !== undefined && error.length > 0}
        className={cn(CONTROL_BASE, 'h-11 px-3 text-sm', className)}
        {...rest}
      />
    </FieldShell>
  );
};

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly containerClassName?: string;
}

export const TextAreaField = ({
  label,
  hint,
  error,
  containerClassName,
  className,
  required,
  rows = 4,
  ...rest
}: TextAreaFieldProps) => {
  const id = useId();
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={containerClassName}
    >
      <textarea
        id={id}
        rows={rows}
        required={required}
        aria-invalid={error !== undefined && error.length > 0}
        className={cn(CONTROL_BASE, 'resize-y px-3 py-2.5 text-sm leading-relaxed', className)}
        {...rest}
      />
    </FieldShell>
  );
};

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly hint?: string;
  readonly error?: string;
  readonly placeholder?: string;
  readonly containerClassName?: string;
}

export const SelectField = ({
  label,
  options,
  hint,
  error,
  placeholder,
  containerClassName,
  className,
  required,
  ...rest
}: SelectFieldProps) => {
  const id = useId();
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={containerClassName}
    >
      <select
        id={id}
        required={required}
        aria-invalid={error !== undefined && error.length > 0}
        className={cn(CONTROL_BASE, 'h-11 px-3 text-sm', className)}
        {...rest}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
};
