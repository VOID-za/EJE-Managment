import { and, eq, sql } from 'drizzle-orm';
import { createDatabase, type Database } from '@/db/client';
import * as schema from '@/db/schema';
import { syncReferenceData } from '@/db/reference-data';
import { createPostgresRepositories } from '@/data/postgres';
import { withTransaction } from '@/data/postgres/transaction';
import { hashPassword } from '@/server/auth/hashing';
import { loadEnvFiles } from './env';
import { resolveSeedTarget, SeedRefused } from './guards';
import { DEMO_PASSWORD, seedPeople } from './people';
import { seedCustomers, seedContacts, seedMachines, seedSites } from './register';
import { seedChecklistTemplates } from './checklists';
import { HIGHEST_JOB_SEQUENCE, seedJobs, seedParticipation, seedTransfers } from './jobs';
import {
  seedAvailability,
  seedConversations,
  seedDocuments,
  seedMessages,
  seedNotifications,
  seedSettings,
} from './collaboration';
import { seedActivity } from './audit';

/**
 * The development seed.
 *
 * WHAT IT IS FOR: giving EJE a database they can sign into and review — real
 * login, real roles, real jobs at every stage — without anybody hand-typing
 * thirty records. Everything it writes is fictional and marked as such.
 *
 * WHAT IT NEVER DOES: drop, truncate or delete ANYTHING. There is no such
 * statement in this directory. A record it has already written is left exactly
 * as it is, which is what makes running it twice safe and what stops it
 * trampling work somebody did in the application afterwards.
 *
 * Every id is derived from a name (`src/db/seed/ids.ts`), so "have I written
 * this customer already?" is answered by looking the id up rather than by
 * guessing from a name somebody may have edited on screen.
 */
interface Counts {
  created: number;
  existing: number;
}

const tally = (): Counts => ({ created: 0, existing: 0 });

const report: Record<string, Counts> = {
  users: tally(),
  customers: tally(),
  sites: tally(),
  contacts: tally(),
  machines: tally(),
  'checklist templates': tally(),
  'library documents': tally(),
  jobs: tally(),
  'audit events': tally(),
  availability: tally(),
  conversations: tally(),
  messages: tally(),
  notifications: tally(),
};

const count = (kind: string, created: boolean): void => {
  const entry = report[kind];
  if (entry === undefined) return;
  if (created) entry.created += 1;
  else entry.existing += 1;
};

/** True when the migrations have been applied. */
const schemaIsReady = async (db: Database): Promise<boolean> => {
  const rows = await db.execute<{ ready: boolean }>(
    sql`select to_regclass('public.users') is not null as ready`,
  );
  return [...rows][0]?.ready === true;
};

const seed = async (db: Database, options: { readonly resetPasswords: boolean }): Promise<void> => {
  await syncReferenceData(db);

  await withTransaction(db, async (tx) => {
    const repos = createPostgresRepositories(tx);

    /*
     * The rates everything is priced from.
     *
     * Read from the TABLE rather than through the repository, which refuses a
     * database with no settings row — correctly, because rates are business
     * data nothing should invent. Writing them is exactly what this seed is
     * for, and only when they are absent: a developer who changes a rate on
     * screen keeps their change.
     */
    const [settingsRow] = await tx
      .select({ id: schema.systemSettings.id })
      .from(schema.systemSettings)
      .limit(1);
    if (settingsRow === undefined) {
      await repos.settings.save(seedSettings);
    }

    /* ---- people, with real Argon2id hashes ---- */
    for (const { user, password } of seedPeople) {
      const existing = await repos.users.findById(user.id);
      if (existing === null) {
        await repos.users.save(user);
        count('users', true);
      } else {
        count('users', false);
      }

      const [row] = await tx
        .select({ hash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, user.id));

      if (row?.hash == null || options.resetPasswords) {
        await tx
          .update(schema.users)
          .set({
            passwordHash: await hashPassword(password),
            passwordSetAt: new Date().toISOString(),
            failedLoginCount: 0,
            lockedUntil: null,
          })
          .where(eq(schema.users.id, user.id));
      }
    }

    /* ---- the register ---- */
    for (const customer of seedCustomers) {
      const existing = await repos.customers.findById(customer.id);
      if (existing === null) await repos.customers.save(customer);
      count('customers', existing === null);
    }
    for (const site of seedSites) {
      const existing = await repos.customers.findSiteById(site.id);
      if (existing === null) await repos.customers.saveSite(site);
      count('sites', existing === null);
    }
    for (const contact of seedContacts) {
      const existing = await repos.customers.findContactById(contact.id);
      if (existing === null) await repos.customers.saveContact(contact);
      count('contacts', existing === null);
    }
    for (const machine of seedMachines) {
      const existing = await repos.machines.findById(machine.id);
      if (existing === null) await repos.machines.save(machine);
      count('machines', existing === null);
    }

    /* ---- checklists and the library ---- */
    for (const template of seedChecklistTemplates) {
      const existing = await repos.checklistTemplates.findByVersion(template.id, template.version);
      if (existing === null) await repos.checklistTemplates.save(template);
      count('checklist templates', existing === null);
    }
    for (const document of seedDocuments) {
      const existing = await repos.documents.findById(document.id);
      if (existing === null) await repos.documents.save(document);
      count('library documents', existing === null);
    }

    /* ---- the jobs ---- */
    for (const job of seedJobs) {
      const existing = await repos.jobs.findById(job.id);
      if (existing === null) await repos.jobs.save(job);
      count('jobs', existing === null);
    }
    for (const transfer of seedTransfers) {
      await repos.jobs.recordTransfer?.(transfer);
    }

    /*
     * The participation a live transfer would have opened and closed.
     *
     * Written straight to the table because there is no operation for "this
     * happened before the system existed" — which is what a seed is. It is an
     * INSERT of a closed row; nothing is updated and nothing is removed, and
     * the repository's own maintenance only ever touches OPEN rows, so this
     * cannot collide with it.
     */
    for (const entry of seedParticipation) {
      const [existing] = await tx
        .select({ id: schema.jobParticipants.id })
        .from(schema.jobParticipants)
        .where(
          and(
            eq(schema.jobParticipants.jobId, entry.jobId as string),
            eq(schema.jobParticipants.userId, entry.userId as string),
            eq(schema.jobParticipants.role, entry.role),
          ),
        )
        .limit(1);
      if (existing !== undefined) continue;

      await tx.insert(schema.jobParticipants).values({
        id: crypto.randomUUID(),
        jobId: entry.jobId as string,
        userId: entry.userId as string,
        role: entry.role,
        since: entry.since,
        until: entry.until,
        endedReason: entry.endedReason,
      });
    }

    /* ---- the trail ---- */
    const trail = await repos.activity.list();
    const seen = new Set(trail.map((entry) => entry.id as string));
    for (const entry of seedActivity) {
      const exists = seen.has(entry.id as string);
      if (!exists) await repos.activity.append(entry);
      count('audit events', !exists);
    }

    /* ---- calendar, chat and the bell ---- */
    for (const record of seedAvailability) {
      const existing = await repos.availability.findById(record.id);
      if (existing === null) await repos.availability.save(record);
      count('availability', existing === null);
    }
    for (const conversation of seedConversations) {
      const existing = await repos.chat.findConversation(conversation.id);
      if (existing === null) await repos.chat.saveConversation(conversation);
      count('conversations', existing === null);
    }
    for (const message of seedMessages) {
      const existing = await repos.chat.findMessage(message.id);
      if (existing === null) await repos.chat.saveMessage(message);
      count('messages', existing === null);
    }
    for (const notification of seedNotifications) {
      const mine = await repos.notifications.list(notification.recipientId);
      const exists = mine.some((entry) => entry.id === notification.id);
      if (!exists) await repos.notifications.create(notification);
      count('notifications', !exists);
    }
  });

  /*
   * Move the job-number sequence past the seeded numbers.
   *
   * `advance_job_number_sequence` only ever moves FORWARD — it is the function
   * the migration provides for exactly this — so running the seed against a
   * database that already has higher numbers cannot hand out a duplicate.
   */
  await db.execute(sql`select advance_job_number_sequence(${HIGHEST_JOB_SEQUENCE + 1})`);
};

const main = async (): Promise<void> => {
  const resetPasswords = process.argv.includes('--reset-passwords');

  // `next dev` reads these; a command-line script has to be told to.
  const files = loadEnvFiles();
  if (files.length > 0) console.log(`Read ${files.join(' and ')}.`);

  const target = resolveSeedTarget(process.env);

  console.log(`EJE development seed → ${target.databaseName} on ${target.host}`);
  console.log('This writes fictional demonstration data. It never deletes anything.\n');

  const db = createDatabase({ connectionString: target.url, maxConnections: 2 });
  try {
    if (!(await schemaIsReady(db))) {
      throw new SeedRefused(
        'That database has no EJE schema yet. Run `npm run db:migrate` against it first.',
      );
    }

    await seed(db, { resetPasswords });

    console.log('Seeded:');
    for (const [kind, counts] of Object.entries(report)) {
      const existing = counts.existing > 0 ? `, ${counts.existing} already present` : '';
      console.log(`  ${String(counts.created).padStart(3)} ${kind}${existing}`);
    }

    console.log('\nSign in at /dashboard with any of these DEVELOPMENT-ONLY accounts:');
    for (const { user } of seedPeople) {
      console.log(`  ${user.email.padEnd(30)} ${user.role.padEnd(12)} ${DEMO_PASSWORD}`);
    }
    console.log(
      '\nThese credentials are documented and are for development review only. ' +
        'Never create them on a production deployment.',
    );
  } finally {
    await db.$client.end({ timeout: 5 });
  }
};

main().catch((cause: unknown) => {
  if (cause instanceof SeedRefused) {
    console.error(`\nRefused: ${cause.message}\n`);
    process.exit(2);
  }
  console.error(cause);
  process.exit(1);
});
