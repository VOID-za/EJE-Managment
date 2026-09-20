import { actionRoute } from '@/server/api/action-route';
import { JOB_COMMANDS } from '@/server/api/commands/jobs';

/** Every job action the API exposes. The registry is the whole list. */
export const POST = actionRoute('jobs', JOB_COMMANDS, 'jobId');
