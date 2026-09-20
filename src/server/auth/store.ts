import 'server-only';
import type { IsoDateTime, UserId } from '@/domain';

/**
 * What authentication needs from persistence, and nothing more.
 *
 * A PORT rather than a repository, because credentials are not domain data.
 * Nothing in `src/domain` or `src/application` knows a password hash exists,
 * and `User` deliberately carries none — so an operation cannot leak one and a
 * screen cannot render one.
 *
 * Two implementations: PostgreSQL, and the demonstration store. Both are
 * server-side; the browser never sees either.
 */

/** The credential columns, which live beside the user and never travel with it. */
export interface CredentialRecord {
  readonly userId: UserId;
  readonly email: string;
  readonly active: boolean;
  /** Null until a password has been set. Such an account cannot sign in. */
  readonly passwordHash: string | null;
  readonly failedLoginCount: number;
  /** Set while the account is locked out after repeated failures. */
  readonly lockedUntil: IsoDateTime | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: UserId;
  readonly issuedAt: IsoDateTime;
  /** Sliding idle expiry, moved forward by activity. */
  readonly expiresAt: IsoDateTime;
  /** Hard ceiling, never extended. */
  readonly absoluteExpiresAt: IsoDateTime;
  readonly revokedAt: IsoDateTime | null;
}

export interface NewSession {
  readonly id: string;
  readonly userId: UserId;
  readonly tokenHash: string;
  readonly expiresAt: IsoDateTime;
  readonly absoluteExpiresAt: IsoDateTime;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuthStore {
  /** The credentials for an email address, or null. Case-insensitive. */
  findCredentialsByEmail(email: string): Promise<CredentialRecord | null>;
  /** Records a failed attempt and returns the new count. */
  recordFailedLogin(userId: UserId, lockUntil: IsoDateTime | null): Promise<void>;
  /** Clears the failure counter and stamps the sign-in. */
  recordSuccessfulLogin(userId: UserId, at: IsoDateTime): Promise<void>;

  createSession(session: NewSession): Promise<void>;
  /** Looks a session up by the hash of its token. Never by the token. */
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** Moves the sliding expiry forward. Never past the absolute ceiling. */
  touchSession(id: string, seenAt: IsoDateTime, expiresAt: IsoDateTime): Promise<void>;
  revokeSession(id: string, at: IsoDateTime, reason: string): Promise<void>;
  /** Every live session for one person. Used when an account is disabled. */
  revokeSessionsForUser(userId: UserId, at: IsoDateTime, reason: string): Promise<number>;
}
