import { readRoute, writeRoute } from '@/server/api/handler';
import { createJobSchema, runCreateJob } from '@/server/api/commands/jobs';
import { jobsView } from '@/server/api/views';

/** The job list, as this actor may read it. DECISION 5 is applied in the read. */
export const GET = readRoute('jobs.list', (context) =>
  jobsView({ repos: context.repos, services: context.services, actor: context.actor.user }),
);

/** Raising a job. `createJob` refuses a role that may not, and allocates the number. */
export const POST = writeRoute({
  operation: 'jobs.create',
  schema: createJobSchema,
  handler: (context) =>
    runCreateJob(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
