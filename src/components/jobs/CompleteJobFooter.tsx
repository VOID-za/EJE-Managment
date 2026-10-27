'use client';

import type { Job } from '@/domain';
import { Button, Card, Icon } from '@/components/ui';
import { jobs } from '@/api/endpoints';
import { useOperation } from '@/hooks/useOperation';
import { formatHours, formatKilometres } from '@/lib/format';

/**
 * COMPLETE JOB, AT THE BOTTOM OF THE IN PROGRESS PAGE. COMPLETE-POS-1, the
 * owner's instruction of 27 October 2026.
 *
 * Below the job's details and captures rather than up beside Awaiting Spares
 * and Transfer Job, so a technician reaches it after reviewing what they
 * recorded — and it says what that is, with the counts, before they press it.
 * The button does exactly what the old one did: moves the job into Completion
 * through the operation, then opens the guided close-out. Completion can be
 * cancelled from the wizard or the job screen until the customer signs.
 */
export const CompleteJobFooter = ({
  job,
  onChanged,
  onCompleteJob,
}: {
  readonly job: Job;
  readonly onChanged: () => void;
  readonly onCompleteJob: () => void;
}) => {
  const operation = useOperation();
  const hours = job.labour.reduce((sum, entry) => sum + entry.hours, 0);
  const kilometres = job.travel.reduce((sum, entry) => sum + entry.kilometres, 0);
  return (
    <Card className="mt-6">
      {/* The id is on this element because `Card` forwards only its own props. */}
      <div className="flex flex-wrap items-center justify-between gap-4" data-testid="complete-job-footer">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-steel-900">Finished the work?</p>
          <p className="mt-1 text-sm text-steel-600" data-testid="complete-job-summary">
            Recorded on this job: {job.labour.length} labour {job.labour.length === 1 ? 'line' : 'lines'} (
            {formatHours(hours)}), {formatKilometres(kilometres)}, {job.parts.length}{' '}
            {job.parts.length === 1 ? 'part' : 'parts'}, {job.notes.length} {job.notes.length === 1 ? 'note' : 'notes'}.
            Check them on <strong>Labour &amp; Parts</strong> and <strong>Notes</strong> before you complete.
          </p>
          {operation.error !== null && (
            <p role="alert" className="mt-2 text-sm font-medium text-signal-600">
              {operation.error}
            </p>
          )}
        </div>
        <Button
          size="lg"
          onClick={async () => {
            const ok = await operation.run(() => jobs.startCompletion(job.id));
            if (ok) {
              onChanged();
              onCompleteJob();
            }
          }}
          loading={operation.running}
          leadingIcon={<Icon name="wrench" className="size-5" />}
        >
          Complete job
        </Button>
      </div>
    </Card>
  );
};
