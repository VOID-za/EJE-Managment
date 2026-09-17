import { JOB_PROGRESS_STAGES, jobStatusLabel, type JobStatus } from '@/domain';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/ui';

/**
 * Linear progress rail for the job lifecycle.
 *
 * Awaiting Spares is shown as an interruption of the current stage rather than
 * a stage of its own, because it can occur any number of times.
 */
export const JobProgressRail = ({ status }: { readonly status: JobStatus }) => {
  const effective: JobStatus = status === 'awaiting_spares' ? 'in_progress' : status;
  const currentIndex = JOB_PROGRESS_STAGES.indexOf(effective);

  return (
    <div className="eje-scrollbar overflow-x-auto pb-1">
      <ol className="flex min-w-max items-center gap-1">
        {JOB_PROGRESS_STAGES.map((stage, index) => {
          const done = currentIndex > index;
          const active = currentIndex === index;
          const interrupted = active && status === 'awaiting_spares';

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
                  {done ? <Icon name="check" className="size-3" /> : index + 1}
                </span>
                {interrupted ? 'Awaiting Spares' : jobStatusLabel(stage)}
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
