import 'server-only';
import type { z } from 'zod';
import type { User } from '@/domain';
import type { AppServices, OperationContext } from '@/application/context';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * What the API is allowed to do.
 *
 * A CLOSED REGISTRY, not a way to reach arbitrary repository methods. Each
 * entry names one application operation, declares the shape of its input, and
 * loads whatever entities that operation needs from ids — so a request carries
 * identifiers and values, never records. A client cannot hand the server a
 * `Job` object and have it stored.
 *
 * The URL is explicit and domain-oriented (`POST /api/jobs/<id>/accept`); this
 * is what those URLs resolve to. An action that is not in the registry is not
 * an endpoint, and is answered as not found.
 */
export interface CommandContext {
  readonly repos: RepositoryBundle;
  readonly services: AppServices;
  /** From the session. Never from the request. */
  readonly actor: User;
  /** Ready to hand to an application operation, carrying the session's actor. */
  readonly operation: OperationContext;
}

export interface CommandDefinition<TInput> {
  readonly schema: z.ZodType<TInput>;
  /** `target` is the resource id from the URL, already validated as present. */
  run(context: CommandContext, input: TInput, target: string): Promise<unknown>;
}

/**
 * A command with its input type erased, so a registry can hold many of them.
 *
 * The type is not lost, only hidden: `command()` closes over the real schema
 * and the real handler, and the cast happens exactly once, immediately after
 * the schema that guarantees it has run.
 */
export interface ErasedCommand {
  readonly schema: z.ZodType<unknown>;
  run(context: CommandContext, input: unknown, target: string): Promise<unknown>;
}

export const command = <TInput>(definition: CommandDefinition<TInput>): ErasedCommand => ({
  schema: definition.schema as z.ZodType<unknown>,
  run: (context, input, target) => definition.run(context, input as TInput, target),
});

export type CommandRegistry = Readonly<Record<string, ErasedCommand>>;

export const lookupCommand = (registry: CommandRegistry, action: string): ErasedCommand | null =>
  Object.hasOwn(registry, action) ? (registry[action] ?? null) : null;
