'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from './States';

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
  readonly align?: 'left' | 'right' | 'center';
  readonly className?: string;
  /** Hidden below the `lg` breakpoint so tables stay readable on a tablet. */
  readonly secondary?: boolean;
  readonly width?: string;
}

export interface DataTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T) => string;
  readonly onRowClick?: (row: T) => void;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly className?: string;
}

const ALIGN = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
} as const;

export const DataTable = <T,>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyTitle = 'Nothing to show',
  emptyDescription = 'There are no records matching the current filters.',
  className,
}: DataTableProps<T>) => {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div
      className={cn(
        'eje-scrollbar overflow-x-auto rounded-[var(--radius-card)] border border-steel-200 bg-white shadow-[var(--shadow-card)]',
        className,
      )}
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-steel-200 bg-steel-50">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width !== undefined ? { width: column.width } : undefined}
                className={cn(
                  'px-4 py-3 text-xs font-semibold tracking-wide text-steel-500 uppercase whitespace-nowrap',
                  ALIGN[column.align ?? 'left'],
                  column.secondary === true && 'hidden lg:table-cell',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
              className={cn(
                'border-b border-steel-100 last:border-b-0',
                onRowClick !== undefined && 'cursor-pointer transition-colors hover:bg-eje-50/50',
              )}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cn(
                    'px-4 py-3.5 align-middle text-steel-700',
                    ALIGN[column.align ?? 'left'],
                    column.secondary === true && 'hidden lg:table-cell',
                    column.className,
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
