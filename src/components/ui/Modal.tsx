'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { Button, type ButtonVariant } from './Button';

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  readonly onClose: () => void;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg' | 'xl';
}

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
} as const;

export const Modal = ({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
}: ModalProps) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 bg-steel-950/45 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[92vh] w-full flex-col overflow-hidden bg-white shadow-[var(--shadow-overlay)]',
          'rounded-t-2xl sm:rounded-[var(--radius-card)]',
          SIZES[size],
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-steel-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-steel-900">{title}</h2>
            {description !== undefined && (
              <div className="mt-1 text-sm text-steel-500">{description}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 -mt-1 rounded-[var(--radius-control)] p-2 text-steel-400 hover:bg-steel-100 hover:text-steel-700"
          >
            <svg viewBox="0 0 20 20" className="size-5" fill="none" aria-hidden="true">
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        {children !== undefined && (
          <div className="eje-scrollbar flex-1 overflow-y-auto px-6 py-5">{children}</div>
        )}

        {footer !== undefined && (
          <footer className="flex flex-col-reverse gap-2 border-t border-steel-200 bg-steel-50 px-6 py-4 sm:flex-row sm:justify-end">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
};

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly confirmVariant?: ButtonVariant;
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Every destructive or irreversible action in the system routes through this
 * component, so the confirmation wording is consistent and nothing is ever
 * actioned on a single tap.
 */
export const ConfirmDialog = ({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) => (
  <Modal
    open={open}
    title={title}
    onClose={onCancel}
    size="sm"
    footer={
      <>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={busy}>
          {confirmLabel}
        </Button>
      </>
    }
  >
    <div className="text-sm leading-relaxed text-steel-700">{message}</div>
  </Modal>
);
