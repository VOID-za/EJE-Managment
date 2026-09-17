'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  readonly badge?: ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps {
  readonly tabs: readonly TabDefinition[];
  readonly activeId: string;
  readonly onChange: (id: string) => void;
  readonly className?: string;
}

export const Tabs = ({ tabs, activeId, onChange, className }: TabsProps) => (
  <div
    role="tablist"
    className={cn(
      'eje-scrollbar flex gap-1 overflow-x-auto border-b border-steel-200',
      className,
    )}
  >
    {tabs.map((tab) => {
      const active = tab.id === activeId;
      return (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active}
          disabled={tab.disabled === true}
          onClick={() => onChange(tab.id)}
          className={cn(
            'relative flex min-h-11 shrink-0 items-center gap-2 px-4 text-sm font-semibold whitespace-nowrap transition-colors',
            'disabled:cursor-not-allowed disabled:text-steel-300',
            active ? 'text-eje-700' : 'text-steel-500 hover:text-steel-800',
          )}
        >
          {tab.label}
          {tab.badge}
          {active && (
            <span
              className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-action"
              aria-hidden="true"
            />
          )}
        </button>
      );
    })}
  </div>
);
