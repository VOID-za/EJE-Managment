import 'server-only';
import { asActivityId, asUserId, type ActivityEventType, type UserId } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * Security events, written straight to the trail.
 *
 * Not through `application/audit.ts`, because that takes an `OperationContext`
 * carrying an ACTOR — and the events here are precisely the ones that may have
 * no actor. Somebody typing an unknown address at the sign-in screen is not a
 * user, and inventing one to satisfy a type would put a fiction on the audit
 * trail.
 *
 * WHAT IS NEVER RECORDED: the password that was typed, the session token that
 * was issued, or the hash of either. A trail that captures a mistyped password
 * captures a real one sooner or later, because people mistype into the wrong
 * field. The address that was tried IS recorded — that is the thing an office
 * investigating a lockout actually needs.
 */
export const recordSecurityEvent = async (
  repos: RepositoryBundle,
  input: {
    readonly type: ActivityEventType;
    readonly summary: string;
    readonly detail: string;
    /** Null when the address matched no account, so nobody did it. */
    readonly actorId: UserId | null;
    readonly occurredAt: string;
  },
): Promise<void> => {
  await repos.activity.append({
    id: asActivityId(crypto.randomUUID()),
    jobId: null,
    type: input.type,
    summary: input.summary,
    detail: input.detail,
    // An empty id is how the repositories say "no actor"; the column is
    // nullable precisely for this.
    actorId: input.actorId ?? asUserId(''),
    occurredAt: input.occurredAt,
  });
};
