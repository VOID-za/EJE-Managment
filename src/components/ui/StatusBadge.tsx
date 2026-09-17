import type { JobPriority, JobStatus } from '@/domain';
import { jobStatusLabel, priorityLabel } from '@/domain';
import { Badge, type BadgeTone } from './Badge';
import { cn } from '@/lib/cn';

/**
 * Status colour is a business signal, not a styling choice, so the mapping lives
 * in one place and every screen inherits it.
 */
const STATUS_TONES: Record<JobStatus, BadgeTone> = {
  draft: 'neutral',
  open: 'blue',
  in_progress: 'violet',
  awaiting_spares: 'amber',
  completion: 'violet',
  customer_signature: 'violet',
  review: 'violet',
  submitted: 'green',
  closed: 'neutral',
  // Cancelled must never look like an active job, so it takes the danger tone.
  cancelled: 'red',
};

export const JobStatusBadge = ({
  status,
  size = 'md',
}: {
  readonly status: JobStatus;
  readonly size?: 'sm' | 'md';
}) => (
  <Badge tone={STATUS_TONES[status]} dot size={size}>
    {jobStatusLabel(status)}
  </Badge>
);

const PRIORITY_TONES: Record<JobPriority, BadgeTone> = {
  low: 'neutral',
  normal: 'outline',
  high: 'amber',
  urgent: 'red',
};

/** Urgent is deliberately the loudest thing on any screen it appears on. */
export const PriorityBadge = ({
  priority,
  size = 'md',
}: {
  readonly priority: JobPriority;
  readonly size?: 'sm' | 'md';
}) => {
  if (priority === 'urgent') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full bg-danger font-bold tracking-wide text-white uppercase',
          size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        )}
      >
        <svg viewBox="0 0 12 12" className="size-3" fill="currentColor" aria-hidden="true">
          <path d="M6 0.5 11.5 10.5H0.5L6 0.5Z" opacity="0.9" />
          <rect x="5.35" y="4" width="1.3" height="3.4" fill="var(--color-danger)" />
          <rect x="5.35" y="8.1" width="1.3" height="1.3" fill="var(--color-danger)" />
        </svg>
        Urgent
      </span>
    );
  }
  return (
    <Badge tone={PRIORITY_TONES[priority]} size={size}>
      {priorityLabel(priority)}
    </Badge>
  );
};
