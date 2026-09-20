import { readRoute, writeRoute } from '@/server/api/handler';
import { createDocumentSchema, runCreateDocument } from '@/server/api/commands/office';
import { libraryView } from '@/server/api/views';

export const GET = readRoute('library.list', (context) =>
  libraryView({ repos: context.repos, services: context.services, actor: context.actor.user }),
);

/**
 * Adding a document.
 *
 * A Master's upload is current at once; a technician's waits for approval.
 * `addDocument` decides which, from the actor the session resolved.
 */
export const POST = writeRoute({
  operation: 'library.create',
  schema: createDocumentSchema,
  handler: (context) =>
    runCreateDocument(
      {
        repos: context.repos,
        services: context.services,
        actor: context.actor.user,
        operation: context.operation,
      },
      context.input,
    ),
});
