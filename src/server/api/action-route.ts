import 'server-only';
import type { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { notFound } from './errors';
import { parseWith, writeRoute } from './handler';
import { lookupCommand, type CommandRegistry } from './commands/types';

/**
 * `POST /api/<resource>/<id>/<action>`.
 *
 * The URL is explicit and domain-oriented — `/api/jobs/EJE-1048/accept` reads
 * as what it does — and the action is resolved against a CLOSED registry. An
 * action nobody wrote is not an endpoint, and is answered as not found rather
 * than as refused, because there is nothing there to be refused.
 *
 * This is what stops the API becoming a remote procedure call into the
 * repositories: every action is a named application operation with its own
 * schema, and no path takes a method name from the request.
 */
export interface ActionParams {
  readonly params: Promise<Record<string, string>>;
}

/**
 * The outer schema accepts any object; the COMMAND's schema is what validates.
 *
 * `writeRoute` has to parse the body before it knows which action is running,
 * so it takes the raw object and the command narrows it immediately — one
 * parse each, in the only order that works. Every command schema is `.strict()`,
 * so an unknown field is still refused.
 */
const anyObject = z.record(z.string(), z.unknown());

export const actionRoute =
  (resource: string, registry: CommandRegistry, idParam: string) =>
  async (request: NextRequest, context: ActionParams): Promise<NextResponse> => {
    const params = await context.params;
    const action = params.action ?? '';
    const target = params[idParam] ?? '';

    return writeRoute({
      operation: `${resource}.${action}`,
      schema: anyObject,
      handler: async (write) => {
        const command = lookupCommand(registry, action);
        if (command === null || target.length === 0) {
          throw notFound('There is no such action.');
        }

        return command.run(
          {
            repos: write.repos,
            services: write.services,
            actor: write.actor.user,
            operation: write.operation,
          },
          parseWith(command.schema, write.input),
          target,
        );
      },
    })(request);
  };
