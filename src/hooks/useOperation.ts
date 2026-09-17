'use client';

import { useCallback, useState } from 'react';
import { WorkflowError } from '@/application/errors';
import type { OperationContext } from '@/application/context';
import type { RuleViolation } from '@/domain';
import { useApp } from '@/providers/AppProvider';

export interface OperationState {
  readonly running: boolean;
  readonly error: string | null;
  readonly violations: readonly RuleViolation[];
  clearError(): void;
}

export interface UseOperationResult extends OperationState {
  /**
   * Runs an application operation with the current user as the actor. Errors
   * are captured rather than thrown so callers can surface them in the UI; the
   * result is `true` when the operation completed.
   */
  run(operation: (context: OperationContext) => Promise<unknown>): Promise<boolean>;
}

export const useOperation = (): UseOperationResult => {
  const { operationContext } = useApp();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [violations, setViolations] = useState<readonly RuleViolation[]>([]);

  const run = useCallback(
    async (operation: (context: OperationContext) => Promise<unknown>): Promise<boolean> => {
      setRunning(true);
      setError(null);
      setViolations([]);
      try {
        await operation(operationContext());
        return true;
      } catch (cause: unknown) {
        if (cause instanceof WorkflowError) {
          setError(cause.message);
          setViolations(cause.violations);
        } else {
          setError(cause instanceof Error ? cause.message : 'The action could not be completed.');
        }
        return false;
      } finally {
        setRunning(false);
      }
    },
    [operationContext],
  );

  const clearError = useCallback(() => {
    setError(null);
    setViolations([]);
  }, []);

  return { run, running, error, violations, clearError };
};
