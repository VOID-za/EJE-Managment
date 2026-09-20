import 'server-only';
import type { IsoDateTime, User, UserId } from '@/domain';
import { DEMO_PASSWORD as SHARED } from '@/lib/demo-credentials';
import type { AuthStore, CredentialRecord, NewSession, SessionRecord } from './store';
import { hashPassword } from './passwords';

/**
 * Credentials and sessions for the DEMONSTRATION backend, in memory.
 *
 * THIS IS NOT A PRODUCTION CODE PATH and cannot become one by accident: it is
 * built only when `src/data/backend.ts` has explicitly selected the
 * demonstration store, which happens when `EJE_PERSISTENCE=demo` or when no
 * `DATABASE_URL` is configured at all. A production deployment that loses its
 * database gets an error, never this.
 *
 * WHAT IT DOES AND DOES NOT SIMULATE. The session, the cookie, the idle and
 * absolute expiries, the lockout counter and the Argon2id verification are all
 * the real implementations — the demonstration exercises the same login path a
 * technician will. What is fabricated is the CREDENTIAL: every seeded user
 * shares one password, stated on the sign-in screen, because there are no real
 * people behind the seeded names and inventing individual passwords would be
 * pretending otherwise.
 */
export const DEMO_PASSWORD = process.env.EJE_DEMO_PASSWORD ?? SHARED;

interface StoredSession extends SessionRecord {
  readonly tokenHash: string;
}

interface Failures {
  count: number;
  lockedUntil: IsoDateTime | null;
}

export class DemoAuthStore implements AuthStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly failures = new Map<string, Failures>();
  private sharedHash: Promise<string> | null = null;

  /** `listUsers` is the demonstration user register, which a Master can add to. */
  constructor(private readonly listUsers: () => Promise<readonly User[]>) {}

  async findCredentialsByEmail(email: string): Promise<CredentialRecord | null> {
    const users = await this.listUsers();
    const needle = email.trim().toLowerCase();
    const user = users.find((candidate) => candidate.email.toLowerCase() === needle);
    if (user === undefined) return null;

    this.sharedHash ??= hashPassword(DEMO_PASSWORD);
    const failure = this.failures.get(user.id) ?? { count: 0, lockedUntil: null };

    return {
      userId: user.id,
      email: user.email,
      active: user.active,
      passwordHash: await this.sharedHash,
      failedLoginCount: failure.count,
      lockedUntil: failure.lockedUntil,
    };
  }

  recordFailedLogin(userId: UserId, lockUntil: IsoDateTime | null): Promise<void> {
    const current = this.failures.get(userId) ?? { count: 0, lockedUntil: null };
    this.failures.set(userId, { count: current.count + 1, lockedUntil: lockUntil });
    return Promise.resolve();
  }

  recordSuccessfulLogin(userId: UserId): Promise<void> {
    this.failures.delete(userId);
    return Promise.resolve();
  }

  createSession(session: NewSession): Promise<void> {
    this.sessions.set(session.tokenHash, {
      id: session.id,
      userId: session.userId,
      tokenHash: session.tokenHash,
      issuedAt: new Date().toISOString(),
      expiresAt: session.expiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      revokedAt: null,
    });
    return Promise.resolve();
  }

  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return Promise.resolve(this.sessions.get(tokenHash) ?? null);
  }

  touchSession(id: string, _seenAt: IsoDateTime, expiresAt: IsoDateTime): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.id === id) this.sessions.set(hash, { ...session, expiresAt });
    }
    return Promise.resolve();
  }

  revokeSession(id: string, at: IsoDateTime): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.id === id && session.revokedAt === null) {
        this.sessions.set(hash, { ...session, revokedAt: at });
      }
    }
    return Promise.resolve();
  }

  revokeSessionsForUser(userId: UserId, at: IsoDateTime): Promise<number> {
    let revoked = 0;
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId && session.revokedAt === null) {
        this.sessions.set(hash, { ...session, revokedAt: at });
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }
}
