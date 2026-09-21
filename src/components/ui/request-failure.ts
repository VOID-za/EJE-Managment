import type { ApiErrorCode } from '@/api/client';

/**
 * What a failed read should SAY, decided from the server's error code.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT A COMPONENT: it is the part that can be
 * wrong. "Something went wrong. Try again." on a 403 is a lie told to somebody
 * who did nothing wrong, and it also hides genuine failures — if every code
 * renders the same panel, a 500 and a refusal are indistinguishable to the
 * person looking at the screen and to anybody they report it to. So the mapping
 * is testable on its own, and the component only draws it.
 *
 * WHAT THIS IS NOT. It does not decide access, it reports it. The server has
 * already refused; nothing here can turn a refusal into data, and no screen
 * reads this to work out whether to fetch something. Authorization is a server
 * fact and this is its presentation.
 *
 * WHAT IT MUST NOT SAY. Never which capability was missing, which role would
 * have been enough, who to ask, or whether the record exists. "Not permitted"
 * and "not found" are deliberately different states because the API
 * deliberately answers 403 and 404 differently: a record the actor may not know
 * exists already comes back as 404, so by the time a 403 reaches here the
 * screen's existence is not a secret — only its contents are.
 */
export type FailureKind =
  /** Authenticated, and refused. An answer, not a fault. */
  | 'denied'
  /** No such record, or one this actor may not know exists. */
  | 'missing'
  /** The session has ended. */
  | 'signed_out'
  /** The request never reached EJE. */
  | 'offline'
  /** Somebody else changed it first. */
  | 'stale'
  /** Genuinely broken, and worth reporting. */
  | 'fault';

export interface FailurePresentation {
  readonly kind: FailureKind;
  readonly title: string;
  readonly message: string;
  /**
   * Whether "Try again" is offered.
   *
   * Offered only where repeating the request could plausibly succeed. A refusal
   * will be refused again for as long as this person holds this role, and a
   * button that re-refuses is how a screen tells somebody their problem is
   * intermittent when it is permanent.
   */
  readonly retryable: boolean;
}

/**
 * The refusal, in one sentence, with nothing in it the person must act on.
 *
 * The server's own message is deliberately NOT used for a refusal: it is
 * written for the API and names the screen ("The customer register is not
 * available to your role"), and a message written by the server is a message
 * that could one day name something it should not.
 */
const DENIED: Omit<FailurePresentation, 'kind'> = {
  title: 'You do not have access to this',
  /*
   * Deliberately does NOT say "ask a Master to change your access".
   *
   * Capabilities belong to a ROLE and are fixed in `access.ts`; nobody can
   * grant this screen to one person. Telling somebody otherwise sends them to
   * ask for something that cannot be done, which is worse than the generic
   * panel this replaced.
   */
  message:
    'Your role does not include this screen. If you need it for your work, speak to the office.',
  retryable: false,
};

export const describeFailure = (
  code: ApiErrorCode,
  message: string | null,
): FailurePresentation => {
  switch (code) {
    case 'forbidden':
      return { kind: 'denied', ...DENIED };

    case 'not_found':
      return {
        kind: 'missing',
        title: 'Not found',
        message: 'This record does not exist, or it is not one you have access to.',
        retryable: false,
      };

    case 'unauthenticated':
      return {
        kind: 'signed_out',
        title: 'Your session has ended',
        message: 'Sign in again to carry on.',
        retryable: false,
      };

    case 'network':
      return {
        kind: 'offline',
        title: 'No connection to the EJE server',
        message:
          message ?? 'Nothing was loaded. Check the connection on this device and try again.',
        retryable: true,
      };

    case 'version_conflict':
    case 'conflict':
      return {
        kind: 'stale',
        title: 'This has changed since you opened it',
        message: message ?? 'Somebody else changed it while you were working. Reload to see it.',
        retryable: true,
      };

    case 'rate_limited':
      return {
        kind: 'fault',
        title: 'Too many requests',
        message: message ?? 'Wait a moment and try again.',
        retryable: true,
      };

    /*
     * A refusal by the BUSINESS, not by authorization: the actor was entitled
     * to ask and the rules said no. It carries its own sentence, and that
     * sentence is the whole point of it.
     */
    case 'workflow_refused':
    case 'validation_failed':
      return {
        kind: 'fault',
        title: 'This could not be done',
        message: message ?? 'The request was refused.',
        retryable: false,
      };

    case 'internal_error':
    default:
      /*
       * The genuine fault, kept distinguishable from everything above. The
       * server has already logged what actually happened; this is all the
       * person is told, and it is the ONE case where "try again" is honest.
       */
      return {
        kind: 'fault',
        title: 'Something went wrong',
        message: message ?? 'This could not be loaded. Please try again.',
        retryable: true,
      };
  }
};

/** True when the screen was refused rather than broken. */
export const isDenied = (code: ApiErrorCode | null): boolean => code === 'forbidden';
