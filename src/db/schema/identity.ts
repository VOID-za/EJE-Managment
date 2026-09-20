import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  inet,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import { userRole } from './enums';

/** Case-insensitive text. Email addresses are compared without regard to case. */
const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

/**
 * People who use the system.
 *
 * The role lives here; the CAPABILITIES do not. `src/domain/access.ts` holds the
 * matrix, it is a closed set with a test asserting its contents, and making it
 * rows would move a reviewed rule into data nobody reviews. A future per-user
 * override is an additive table, not a rewrite.
 *
 * The credential columns exist but NOTHING IN THIS PHASE WRITES OR READS THEM.
 * Authentication is a later phase; the schema is here so that phase is a code
 * change rather than a migration against live data.
 */
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    initials: text('initials').notNull(),
    email: citext('email').notNull(),
    mobile: text('mobile').notNull().default(''),
    role: userRole('role').notNull(),
    jobTitle: text('job_title').notNull().default(''),

    /* ---- credentials: schema only, unused until the authentication phase ---- */
    /** argon2id encoded hash, parameters included. Null until a password is set. */
    passwordHash: text('password_hash'),
    passwordSetAt: instant('password_set_at'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: instant('locked_until'),
    lastLoginAt: instant('last_login_at'),

    /** A disabled account keeps every job it ever worked; it simply cannot sign in. */
    active: boolean('active').notNull().default(true),
    disabledAt: instant('disabled_at'),
    // Self-referencing, so the explicit return type is required to break the
    // circular inference Drizzle would otherwise have to resolve.
    disabledBy: uuid('disabled_by').references((): AnyPgColumn => users.id),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('users_email_key').on(table.email),
    // Assignment, notification fan-out and the technician pickers all ask for
    // active people of a role.
    index('users_role_active_idx').on(table.role).where(sql`${table.active}`),
  ],
);

/**
 * Server-side sessions. SCHEMA ONLY in this phase.
 *
 * Opaque tokens rather than JWTs, because disabling an account has to take
 * effect on the next request rather than at the next expiry. Only the SHA-256
 * of the cookie value is stored, so a database leak yields no usable session.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256(token). The raw token exists only in the cookie. */
    tokenHash: text('token_hash').notNull(),
    issuedAt: createdAt(),
    /** Sliding idle expiry. */
    expiresAt: instant('expires_at').notNull(),
    /** Hard ceiling, never extended. */
    absoluteExpiresAt: instant('absolute_expires_at').notNull(),
    lastSeenAt: instant('last_seen_at'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    revokedAt: instant('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_key').on(table.tokenHash),
    index('sessions_user_active_idx')
      .on(table.userId)
      .where(sql`${table.revokedAt} is null`),
    index('sessions_expires_at_idx').on(table.expiresAt),
  ],
);
