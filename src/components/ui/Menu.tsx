'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { cn } from '@/lib/cn';

export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Renders in the signal colour, for an action that takes something away. */
  readonly destructive?: boolean;
  readonly onSelect: () => void;
}

export interface MenuProps {
  /** What the trigger says. */
  readonly label: string;
  readonly items: readonly MenuItem[];
  /** Shown in place of the menu when there is nothing this person may do. */
  readonly emptyLabel?: string;
  readonly align?: 'left' | 'right';
  readonly trigger?: 'button' | 'plain';
  /** Rendered inside the trigger, before the label. */
  readonly leading?: ReactNode;
  /** A second line under the label, for the profile trigger. */
  readonly sublabel?: string;
  readonly className?: string;
  readonly triggerClassName?: string;
}

/**
 * A dropdown of actions behind one trigger.
 *
 * Exists because a row of four buttons per user made the Users table unreadable
 * and, worse, made an unauthorised action look like an available one that had
 * merely been greyed out. Here the menu carries ONLY what this person may
 * actually do, and an account with nothing available says so rather than
 * offering a menu that opens on nothing.
 *
 * Closing is handled with listeners registered once per open, reading their
 * callbacks through a ref: an effect that depends on a prop the parent
 * recreates every render re-runs on every keystroke, which is what made every
 * dialog in this application lose focus between characters.
 */
export const Menu = ({
  label,
  items,
  emptyLabel,
  align = 'right',
  trigger = 'button',
  leading,
  sublabel,
  className,
  triggerClassName,
}: MenuProps) => {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent): void => {
      const container = containerRef.current;
      if (container !== null && !container.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (items.length === 0) {
    return emptyLabel === undefined ? null : (
      <span className="text-xs whitespace-nowrap text-steel-400">{emptyLabel}</span>
    );
  }

  return (
    <div ref={containerRef} className={cn('relative inline-block text-left', className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] text-sm font-semibold transition-colors',
          trigger === 'button'
            ? 'h-11 bg-surface px-3.5 text-steel-800 ring-1 ring-steel-300 ring-inset hover:bg-steel-50'
            : 'px-2 py-1 text-steel-800 hover:bg-steel-100',
          triggerClassName,
        )}
      >
        {leading}
        {sublabel === undefined ? (
          <span className="whitespace-nowrap">{label}</span>
        ) : (
          <span className="hidden min-w-0 text-left leading-tight sm:block">
            <span className="block truncate text-xs font-semibold text-steel-800">{label}</span>
            <span className="block truncate text-[11px] font-medium text-steel-500">
              {sublabel}
            </span>
          </span>
        )}
        <Icon name="chevronDown" className="size-4 shrink-0 text-steel-400" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          className={cn(
            'absolute z-40 mt-1 min-w-52 overflow-hidden rounded-[var(--radius-card)] border border-steel-200 bg-surface py-1 shadow-[var(--shadow-raised)]',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                'flex min-h-11 w-full items-center gap-2.5 px-3.5 text-left text-sm font-medium transition-colors',
                item.destructive
                  ? 'text-signal-600 hover:bg-signal-50'
                  : 'text-steel-700 hover:bg-steel-100 hover:text-steel-900',
              )}
            >
              {item.icon}
              <span className="flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
