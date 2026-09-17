import { Icon } from '@/components/ui';

/** Explanatory banner used across the administration panels. */
export const AdminNotice = ({
  title,
  body,
  tone = 'blue',
}: {
  readonly title: string;
  readonly body: string;
  readonly tone?: 'blue' | 'amber';
}) => (
  <div
    className={
      tone === 'amber'
        ? 'rounded-[var(--radius-card)] border border-amber-eje-200 bg-amber-eje-50 p-4'
        : 'rounded-[var(--radius-card)] border border-eje-200 bg-eje-50 p-4'
    }
  >
    <p
      className={
        tone === 'amber'
          ? 'flex items-center gap-2 text-sm font-semibold text-amber-eje-700'
          : 'flex items-center gap-2 text-sm font-semibold text-eje-800'
      }
    >
      <Icon name={tone === 'amber' ? 'warning' : 'settings'} className="size-4" />
      {title}
    </p>
    <p className="mt-1.5 text-sm leading-relaxed text-steel-700">{body}</p>
  </div>
);
