import {
  JOB_PROGRESS_STAGES,
  jobProgressPosition,
  jobStatusLabel,
  type JobStatus,
} from '@/domain';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/ui';

/**
 * Linear progress rail for the job lifecycle.
 *
 * The rail draws the six stages of the active workflow and nothing else. Where
 * a job sits, and whether something is holding it there — awaiting spares,
 * awaiting delivery, or the retired Master Review stage a historical job is
 * still in — is decided by `jobProgressPosition` in the domain, so the picture
 * and the state machine cannot drift apart.
 *
 * `exception` marks ONE stage that something went wrong at — today, a customer
 * who refused to sign. It is a flag ON a stage the rail already has, never an
 * extra step: a job that took an exception followed the same six stages as
 * every other job, and the rail must keep saying so.
 */
export const JobProgressRail = ({
  status,
  exception = null,
}: {
  readonly status: JobStatus;
  readonly exception?: { readonly stage: JobStatus; readonly label: string } | null;
}) => {
  const { index: currentIndex, interruption } = jobProgressPosition(status);
  const exceptionIndex =
    exception === null ? -1 : JOB_PROGRESS_STAGES.indexOf(exception.stage);

  return (
    <div className="eje-scrollbar overflow-x-auto pb-1">
      <ol className="flex min-w-max items-center gap-1">
        {JOB_PROGRESS_STAGES.map((stage, index) => {
          const done = currentIndex > index;
          const active = currentIndex === index;
          const flagged = exception !== null && exceptionIndex === index;
          const interrupted = (active && interruption !== null) || flagged;

          return (
            <li key={stage} className="flex items-center gap-1">
              <div
                className={cn(
                  'flex items-center gap-2 rounded-full py-1.5 pr-3.5 pl-1.5 text-xs font-semibold whitespace-nowrap transition-colors',
                  interrupted
                    ? 'bg-amber-eje-50 text-amber-eje-700 ring-1 ring-amber-eje-200'
                    : active
                      ? 'bg-action text-white'
                      : done
                        ? 'bg-verdant-50 text-verdant-700'
                        : 'bg-steel-100 text-steel-400',
                )}
              >
                <span
                  className={cn(
                    'flex size-5 items-center justify-center rounded-full text-[10px] font-bold',
                    interrupted
                      ? 'bg-amber-eje-500 text-white'
                      : active
                        ? 'bg-white/25 text-white'
                        : done
                          ? 'bg-verdant-500 text-white'
                          : 'bg-surface text-steel-400',
                  )}
                >
                  {flagged ? (
                    <Icon name="warning" className="size-3" />
                  ) : done ? (
                    <Icon name="check" className="size-3" />
                  ) : (
                    index + 1
                  )}
                </span>
                {flagged
                  ? `${jobStatusLabel(stage)} — ${exception.label}`
                  : interrupted
                    ? interruption
                    : jobStatusLabel(stage)}
              </div>
              {index < JOB_PROGRESS_STAGES.length - 1 && (
                <span
                  className={cn('h-px w-4', done ? 'bg-verdant-300' : 'bg-steel-200')}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
};
