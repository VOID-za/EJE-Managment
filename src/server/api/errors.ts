import 'server-only';
import { NextResponse } from 'next/server';
import type { RuleViolation } from '@/domain';
import { WorkflowError } from '@/application/errors';
import { ConcurrencyError } from '@/data/postgres/transaction';

/**
 * What the API says when something goes wrong.
 *
 * ONE SHAPE, always:
 *
 *   { "error": { "code": "...", "message": "...", "violations": [...] } }
 *
 * so the browser has one thing to parse, and a category it can act on rather
 * than a sentence it has to match. `violations` is the existing
 * `WorkflowError.violations` — the precise list of what is outstanding — which
 * is what the screens already render and must keep rendering.
 *
 * WHAT NEVER CROSSES THIS BOUNDARY: stack traces, SQL, connection strings,
 * table names, password hashes, session tokens, and whether an email address
 * belongs to an account. An unexpected failure is logged on the server and
 * reported to the client as `internal_error` and nothing else.
 */
export type ApiErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'version_conflict'
  | 'rate_limited'
  | 'workflow_refused'
  | 'internal_error';

const STATUS: Record<ApiErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  version_conflict: 409,
  rate_limited: 429,
  // The request was well formed and the actor was entitled to make it; the
  // business refused it. 422 is the honest reading, and it keeps a refusal
  // distinguishable from a malformed body.
  workflow_refused: 422,
  internal_error: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly violations: readonly RuleViolation[] = [],
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthenticated = (message = 'Sign in to continue.'): ApiError =>
  new ApiError('unauthenticated', message);

export const forbidden = (message: string, violations: readonly RuleViolation[] = []): ApiError =>
  new ApiError('forbidden', message, violations);

/**
 * The answer for a record this actor may not read.
 *
 * NOT 403. Telling somebody "you are not allowed to see EJE-1061" confirms that
 * EJE-1061 exists, which is exactly what the visibility rule exists to prevent.
 * A job the actor may not see and a job number nobody ever issued give the same
 * answer, because they have to be indistinguishable.
 */
export const notFound = (message = 'Not found.'): ApiError => new ApiError('not_found', message);

export const rateLimited = (message: string, retryAfterSeconds: number): ApiError =>
  new ApiError('rate_limited', message, [], {
    'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });

/**
 * Authorization refusals come back as 403, everything else as 422.
 *
 * The application layer raises `WorkflowError` for both "you may not do this"
 * and "this cannot be done yet", and the difference matters to a client: one is
 * permanent for this actor, the other resolves once the work is done. The
 * existing violation codes already carry it.
 */
const PERMISSION_CODES = new Set([
  'not_permitted',
  /*
   * Accepting a job you may not accept.
   *
   * A Coordinator who does not do field work, or a technician reaching for a
   * job assigned to somebody else. Both are permanent for this actor on this
   * job — no amount of finishing the work makes them true — which is what
   * separates a 403 from the 422 that says "not yet".
   */
  'not_field_technician',
  'transfer_not_permitted',
  'delete_not_permitted',
  'master_not_editable',
  'role_not_assignable',
  'own_role',
  'self_disable',
]);

const fromWorkflowError = (error: WorkflowError): ApiError =>
  error.violations.some((violation) => PERMISSION_CODES.has(violation.code))
    ? new ApiError('forbidden', error.message, error.violations)
    : new ApiError('workflow_refused', error.message, error.violations);

/**
 * Turns anything thrown into the one response shape.
 *
 * The default arm is deliberately incurious: an error nobody anticipated is
 * reported as `internal_error` with a fixed sentence, whatever it actually
 * says. A driver error that quotes the failing SQL — which `postgres` does —
 * would otherwise hand the client the schema.
 */
export const toApiError = (cause: unknown): ApiError => {
  if (cause instanceof ApiError) return cause;
  if (cause instanceof WorkflowError) return fromWorkflowError(cause);
  if (cause instanceof ConcurrencyError) {
    return new ApiError(
      'version_conflict',
      'Somebody else changed this while you were working on it. Reload and try again.',
      [
        {
          code: 'version_conflict',
          message: 'Your copy is out of date. Refresh to see the current version.',
        },
      ],
    );
  }
  return new ApiError('internal_error', 'Something went wrong. Please try again.');
};

export const errorResponse = (error: ApiError): NextResponse =>
  NextResponse.json(
    {
      error: {
        code: error.code,
        message: error.message,
        violations: error.violations,
      },
    },
    { status: STATUS[error.code], headers: error.headers },
  );

/**
 * Logs what the client is not told.
 *
 * Server-side only, and never the request body: a login body contains a
 * password and a job body contains a customer's details.
 */
export const logUnexpected = (route: string, cause: unknown): void => {
  if (!(cause instanceof ApiError) && !(cause instanceof WorkflowError)) {
    console.error(`[api] ${route} failed`, cause);
  }
};
