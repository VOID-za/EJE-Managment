import type { RuleViolation } from '@/domain';

/**
 * Raised when an operation is refused by a domain rule. Carries the violations
 * so the UI can explain precisely what is outstanding instead of showing a
 * generic failure.
 */
export class WorkflowError extends Error {
  readonly violations: readonly RuleViolation[];

  constructor(message: string, violations: readonly RuleViolation[] = []) {
    super(message);
    this.name = 'WorkflowError';
    this.violations = violations;
  }
}
