import 'server-only';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { asUserId, type IsoDateTime, type UserId } from '@/domain';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import type { AuthStore, CredentialRecord, NewSession, SessionRecord } from './store';

/**
 * Credentials and sessions, in PostgreSQL.
 *
 * The columns have existed since Phase 1 and nothing wrote one of them until
 * now; this is the code that was promised. It is the ONLY module that reads
 * `users.password_hash`, and it never returns it beyond `CredentialRecord`,
 * which never leaves the server.
 */
export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async findCredentialsByEmail(email: string): Promise<CredentialRecord | null> {
    // `users.email` is `citext`, so the comparison is case-insensitive in the
    // database rather than by lowering it here and hoping the index agrees.
    const rows = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        active: schema.users.active,
        passwordHash: schema.users.passwordHash,
        failedLoginCount: schema.users.failedLoginCount,
        lockedUntil: schema.users.lockedUntil,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return {
      userId: asUserId(row.id),
      email: row.email,
      active: row.active,
      passwordHash: row.passwordHash,
      failedLoginCount: row.failedLoginCount,
      lockedUntil: row.lockedUntil,
    };
  }

  async recordFailedLogin(userId: UserId, lockUntil: IsoDateTime | null): Promise<void> {
    await this.db
      .update(schema.users)
      .set({
        failedLoginCount: sql`${schema.users.failedLoginCount} + 1`,
        lockedUntil: lockUntil,
      })
      .where(eq(schema.users.id, userId));
  }

  async recordSuccessfulLogin(userId: UserId, at: IsoDateTime): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: at })
      .where(eq(schema.users.id, userId));
  }

  async createSession(session: NewSession): Promise<void> {
    await this.db.insert(schema.sessions).values({
      id: session.id,
      userId: session.userId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      ip: session.ip,
      userAgent: session.userAgent,
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      userId: asUserId(row.userId),
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      absoluteExpiresAt: row.absoluteExpiresAt,
      revokedAt: row.revokedAt,
    };
  }

  async touchSession(id: string, seenAt: IsoDateTime, expiresAt: IsoDateTime): Promise<void> {
    await this.db
      .update(schema.sessions)
      .set({ lastSeenAt: seenAt, expiresAt })
      .where(eq(schema.sessions.id, id));
  }

  async revokeSession(id: string, at: IsoDateTime, reason: string): Promise<void> {
    // Only a live session is revoked: re-revoking would rewrite when it ended.
    await this.db
      .update(schema.sessions)
      .set({ revokedAt: at, revokedReason: reason })
      .where(and(eq(schema.sessions.id, id), isNull(schema.sessions.revokedAt)));
  }

  async revokeSessionsForUser(userId: UserId, at: IsoDateTime, reason: string): Promise<number> {
    const revoked = await this.db
      .update(schema.sessions)
      .set({ revokedAt: at, revokedReason: reason })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
      .returning({ id: schema.sessions.id });
    return revoked.length;
  }
}
