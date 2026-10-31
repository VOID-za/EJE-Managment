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
  /**
   * `document` is a PDF preview (PDF-VIEW-1): the whole screen on a phone, and
   * nearly all of it on a tablet or a desktop, with the document — not the
   * dialog — doing the scrolling, so there is one scrollbar and the page is as
   * large as the screen allows.
   */
  readonly size?: 'sm' | 'md' | 'lg' | 'xl' | 'document';
}

const SIZES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  document: 'h-[100dvh] max-h-[100dvh] max-w-6xl sm:h-[94dvh] sm:max-h-[94dvh]',
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

  /*
   * The latest `onClose`, without making the effect below depend on it.
   *
   * This is the whole bug that made every dialog unusable. The effect moves
   * focus to the dialog when it opens, and it used to list `onClose` as a
   * dependency. Callers pass a handler defined in their own render — the normal
   * thing to do — so its identity changed on every keystroke, the effect re-ran,
   * and focus was pulled out of the input the user was typing into. One
   * character per click, in every form in the application.
   *
   * A ref keeps Escape closing with the current handler while the effect runs
   * only when the dialog actually opens or closes.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Once, on open. Never again while the dialog is up.
    dialogRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className={cn('fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center', size === 'document' ? 'sm:p-3' : 'sm:p-6')}>
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
          // dvh: the height left once an on-screen keyboard is up, so the footer stays on screen.
          'relative flex w-full flex-col overflow-hidden bg-surface shadow-[var(--shadow-overlay)]',
          size === 'document' ? 'sm:rounded-[var(--radius-card)]' : 'max-h-[92dvh] rounded-t-2xl sm:rounded-[var(--radius-card)]',
          SIZES[size],
        )}
      >
        <header className={cn('flex items-start justify-between gap-4 border-b border-steel-200', size === 'document' ? 'px-4 py-3' : 'px-6 py-4')}>
          <div className="min-w-0">
            <h2 className={cn('font-semibold text-steel-900', size === 'document' ? 'text-base' : 'text-lg')}>{title}</h2>
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
          <div className={size === 'document' ? 'flex min-h-0 flex-1 flex-col' : 'eje-scrollbar flex-1 overflow-y-auto px-6 py-5'}>{children}</div>
        )}

        {footer !== undefined && (
          <footer
            className={cn(
              'flex gap-2 border-t border-steel-200 bg-steel-50 sm:flex-row sm:justify-end',
              // A document's three actions sit in one row even on a phone, so the page keeps the height.
              size === 'document' ? 'flex-row flex-wrap justify-end px-4 py-2.5' : 'flex-col-reverse px-6 py-4',
            )}
          >
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
