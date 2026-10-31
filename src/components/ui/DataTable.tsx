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
  /**
   * Below the `lg` breakpoint this column folds into the first one: its value
   * is shown, labelled with its header, under the row's first cell. A portrait
   * tablet keeps every piece of information the desktop shows, without a table
   * that scrolls sideways — the column used to simply disappear there.
   */
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

  const folded = columns.filter((column, index) => index > 0 && column.secondary === true);

  return (
    <div
      className={cn(
        'eje-scrollbar overflow-x-auto rounded-[var(--radius-card)] border border-steel-200 bg-surface shadow-[var(--shadow-card)]',
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
              {columns.map((column, index) => (
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
                  {index === 0 && folded.length > 0 && (
                    <dl className="mt-2 space-y-1.5 text-left lg:hidden" data-folded-columns>
                      {folded.map((secondary) => (
                        <div key={secondary.key} className="min-w-0">
                          <dt className="text-xs font-semibold tracking-wide text-steel-500 uppercase">
                            {secondary.header}
                          </dt>
                          {/* A narrow first column: the value wraps rather than
                              being cut short with an ellipsis. */}
                          <dd className="min-w-0 text-steel-700 [&_.truncate]:overflow-visible [&_.truncate]:break-words [&_.truncate]:whitespace-normal [&_.whitespace-nowrap]:whitespace-normal">
                            {secondary.render(row)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
