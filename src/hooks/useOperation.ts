'use client';

import { useCallback, useState } from 'react';
import type { RuleViolation } from '@/domain';
import { ApiRequestError } from '@/api/client';
import { useApp } from '@/providers/AppProvider';

export interface OperationState {
  readonly running: boolean;
  readonly error: string | null;
  readonly violations: readonly RuleViolation[];
  clearError(): void;
}

export interface UseOperationResult extends OperationState {
  /**
   * Runs one API command.
   *
   * Errors are captured rather than thrown so callers can surface them; the
   * result is `true` when the command completed.
   */
  run(command: () => Promise<unknown>): Promise<boolean>;
  /**
   * The same, for a command whose RESULT the screen needs.
   *
   * Returns null when it was refused, which is distinguishable from a result
   * because the commands that use this return an object.
   */
  runFor<T>(command: () => Promise<T>): Promise<T | null>;
}

/**
 * Running a command against the server.
 *
 * WHAT CHANGED: the caller used to be handed an `OperationContext` and ran the
 * application operation itself, in the browser, against repositories it held.
 * Now it names a command and the SERVER runs the operation — with the actor
 * taken from the session cookie, inside a transaction, with its own
 * authorisation.
 *
 * WHAT DID NOT CHANGE: `RuleViolation`. A refusal still arrives with the exact
 * list of what is outstanding, so `RuleViolationNotice` renders the same thing
 * it always did. The refusal is simply now enforced somewhere a browser cannot
 * reach.
 */
export const useOperation = (): UseOperationResult => {
  const { invalidate, reportConnectionError } = useApp();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<readonly RuleViolation[]>([]);

  const execute = useCallback(
    async <T,>(command: () => Promise<T>): Promise<{ ok: boolean; value: T | null }> => {
      setRunning(true);
      setError(null);
      setViolations([]);
      try {
        const value = await command();
        // Something changed on the server, so everything on screen is stale.
        invalidate();
        reportConnectionError(null);
        return { ok: true, value };
      } catch (cause: unknown) {
        if (cause instanceof ApiRequestError) {
          setError(cause.message);
          setViolations(cause.violations);
          /*
           * A network failure is reported, never disguised.
           *
           * This phase is online-first: nothing is queued and nothing is
           * written locally, so the only honest thing to do with a failed
           * capture is say it did not happen.
           */
          if (cause.code === 'network') reportConnectionError(cause.message);
        } else {
          setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
        }
        return { ok: false, value: null };
      } finally {
        setRunning(false);
      }
    },
    [invalidate, reportConnectionError],
  );

  const run = useCallback(
    async (command: () => Promise<unknown>): Promise<boolean> => (await execute(command)).ok,
    [execute],
  );

  const runFor = useCallback(
    async <T,>(command: () => Promise<T>): Promise<T | null> => (await execute(command)).value,
    [execute],
  );

  const clearError = useCallback(() => {
    setError(null);
    setViolations([]);
  }, []);

  return { run, runFor, running, error, violations, clearError };
};
