import { asc, eq, sql } from 'drizzle-orm';
import { asUserId, type User, type UserId } from '@/domain';
import type { UserRepository } from '@/data/repositories';
import type { DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { VersionLedger, requireWritten } from './versions';
import { isUuid } from './identifiers';

type UserRow = typeof schema.users.$inferSelect;

const toDomainUser = (row: UserRow): User => ({
  id: asUserId(row.id),
  firstName: row.firstName,
  lastName: row.lastName,
  initials: row.initials,
  email: row.email,
  mobile: row.mobile,
  role: row.role,
  jobTitle: row.jobTitle,
  active: row.active,
  createdAt: row.createdAt,
});

/**
 * People, in PostgreSQL.
 *
 * NO CREDENTIALS ARE READ OR WRITTEN HERE. The columns exist — authentication
 * is a later phase and the schema is ready for it — and this repository does
 * not touch one of them, so nothing in this phase can set, compare or leak a
 * password.
 *
 * A DISABLED USER IS NEVER REMOVED. `save` writes `active: false`, and the
 * historical jobs and the audit trail keep naming the person who did the work.
 * There is no delete method because there is no business case for one.
 */
export class PostgresUserRepository implements UserRepository {
  private readonly versions = new VersionLedger();

  constructor(private readonly db: DatabaseExecutor) {}

  async list(): Promise<readonly User[]> {
    // Disabled people included: the caller filters with `activeUsers` when it
    // wants only the people currently working at EJE.
    const rows = await this.db
      .select()
      .from(schema.users)
      .orderBy(asc(schema.users.firstName), asc(schema.users.lastName));
    this.versions.rememberAll(rows);
    return rows.map(toDomainUser);
  }

  async findById(id: UserId): Promise<User | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    this.versions.rememberAll(rows);
    return rows[0] === undefined ? null : toDomainUser(rows[0]);
  }

  async save(user: User): Promise<User> {
    const existing = await this.db
      .select({ version: schema.users.version, disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, user.id))
      .limit(1);

    const current = existing[0];

    if (current === undefined) {
      const inserted = await this.db
        .insert(schema.users)
        .values({
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          initials: user.initials,
          email: user.email,
          mobile: user.mobile,
          role: user.role,
          jobTitle: user.jobTitle,
          active: user.active,
          createdAt: user.createdAt,
        })
        .returning();
      this.versions.rememberAll(inserted);
      return toDomainUser(inserted[0]!);
    }

    const expected = this.versions.expected(user.id, current.version);
    const updated = await this.db
      .update(schema.users)
      .set({
        firstName: user.firstName,
        lastName: user.lastName,
        initials: user.initials,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
        jobTitle: user.jobTitle,
        active: user.active,
        /*
         * When the account was switched off, stamped once.
         *
         * Reactivating clears it, because the column answers "is this account
         * currently disabled, and since when?" — who disabled whom and why is
         * the audit trail's job, and it keeps every one of them.
         */
        disabledAt: user.active ? null : (current.disabledAt ?? sql`now()`),
        updatedAt: sql`now()`,
        version: expected + 1,
      })
      .where(sql`${schema.users.id} = ${user.id} and ${schema.users.version} = ${expected}`)
      .returning();

    const written = requireWritten(updated, 'User', user.email, expected);
    this.versions.remember(written.id, written.version);
    return toDomainUser(written);
  }
}
