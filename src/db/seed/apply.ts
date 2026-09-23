import { eq, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database, DatabaseExecutor } from '@/db/client';
import * as schema from '@/db/schema';
import { syncReferenceData } from '@/db/reference-data';
import { createPostgresRepositories } from '@/data/postgres';
import { withTransaction } from '@/data/postgres/transaction';
import { hashPassword } from '@/server/auth/hashing';
import { SeedRefused } from './guards';
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
 * THE SEED ITSELF, with no opinion about which database it is pointed at.
 *
 * Two commands share every line of this file — `npm run db:seed` for a
 * developer's own database and `npm run db:seed:demo` for the staging
 * deployment — and they differ ONLY in the guard each one passes before calling
 * `applySeed`. That separation is the point: one dataset means the staging site
 * exercises exactly the records the tests and the development machines do, and
 * a guard that is easy to read because it is the only thing an entry point
 * contains.
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
  transfers: tally(),
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

/** A duration a person can read at a glance. */
export const took = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * One phase of the seed, announced BEFORE it runs.
 *
 * WHY IT IS WRITTEN IN TWO HALVES. The label goes out first and the timing
 * completes the line afterwards, so a run that is still working shows the phase
 * it is inside rather than nothing at all. The seed makes hundreds of
 * round-trips; against a database on the other end of an SSH tunnel each one
 * costs the better part of half a second, and a command that prints nothing for
 * minutes is indistinguishable from a command that has hung. It was not hung.
 */
export const phase = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  process.stdout.write(`  ${name.padEnd(26)}`);
  const at = Date.now();
  try {
    const result = await run();
    process.stdout.write(`done in ${took(Date.now() - at)}\n`);
    return result;
  } catch (cause) {
    process.stdout.write(`FAILED after ${took(Date.now() - at)}\n`);
    throw cause;
  }
};

/**
 * The ids a table already holds, in ONE round-trip.
 *
 * The seed asks "have I written this already?" for every record it knows about.
 * Asking the database that question once per record is a round-trip per record
 * — nine hundred of them for a full seed, which is nothing locally and six
 * minutes over a tunnel. The question is the same either way: is this id
 * present. So it is asked once per collection and answered from a set.
 *
 * The rule is unchanged, and so is the safety: a record whose id is already
 * there is left exactly as it is.
 */
const idsIn = async (
  tx: DatabaseExecutor,
  table: PgTable & { readonly id: AnyPgColumn },
): Promise<ReadonlySet<string>> => {
  const rows = await tx.select({ id: table.id }).from(table);
  return new Set(rows.map((row) => String(row.id)));
};

/** True when the migrations have been applied. */
export const schemaIsReady = async (db: Database): Promise<boolean> => {
  const rows = await db.execute<{ ready: boolean }>(
    sql`select to_regclass('public.users') is not null as ready`,
  );
  return [...rows][0]?.ready === true;
};

export const applySeed = async (
  db: Database,
  options: { readonly resetPasswords: boolean },
): Promise<void> => {
  await phase('reference data', () => syncReferenceData(db));

  await withTransaction(db, async (tx) => {
    const repos = createPostgresRepositories(tx);

    await phase('settings and people', async () => {
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
      // Both questions this loop asks — is the account there, does it have a
      // hash — answered for everybody in one query.
      const accounts = new Map(
        (await tx.select({ id: schema.users.id, hash: schema.users.passwordHash }).from(schema.users))
          .map((row) => [String(row.id), row.hash]),
      );

      for (const { user, password } of seedPeople) {
        const known = accounts.has(user.id);
        if (!known) await repos.users.save(user);
        count('users', !known);

        const hash = accounts.get(user.id) ?? null;

        if (hash == null || options.resetPasswords) {
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

    
    });

    await phase('customer register', async () => {
      /* ---- the register ---- */
      const knownCustomers = await idsIn(tx, schema.customers);
      for (const customer of seedCustomers) {
        const fresh = !knownCustomers.has(customer.id);
        if (fresh) await repos.customers.save(customer);
        count('customers', fresh);
      }
      const knownSites = await idsIn(tx, schema.sites);
      for (const site of seedSites) {
        const fresh = !knownSites.has(site.id);
        if (fresh) await repos.customers.saveSite(site);
        count('sites', fresh);
      }
      const knownContacts = await idsIn(tx, schema.contacts);
      for (const contact of seedContacts) {
        const fresh = !knownContacts.has(contact.id);
        if (fresh) await repos.customers.saveContact(contact);
        count('contacts', fresh);
      }
      const knownMachines = await idsIn(tx, schema.machines);
      for (const machine of seedMachines) {
        const fresh = !knownMachines.has(machine.id);
        if (fresh) await repos.machines.save(machine);
        count('machines', fresh);
      }

    
    });

    await phase('checklists and library', async () => {
      /* ---- checklists and the library ---- */
      for (const template of seedChecklistTemplates) {
        const existing = await repos.checklistTemplates.findByVersion(template.id, template.version);
        if (existing === null) await repos.checklistTemplates.save(template);
        count('checklist templates', existing === null);
      }
      const knownDocuments = await idsIn(tx, schema.libraryDocuments);
      for (const document of seedDocuments) {
        const fresh = !knownDocuments.has(document.id);
        if (fresh) await repos.documents.save(document);
        count('library documents', fresh);
      }

    
    });

    await phase('jobs', async () => {
      /* ---- the jobs ---- */
      // `jobs.findById` assembles a whole job — technicians, parts, labour,
      // signatures. Asking it thirty times only to discard the answer was the
      // single most expensive thing the seed did.
      const knownJobs = await idsIn(tx, schema.jobs);
      for (const job of seedJobs) {
        const fresh = !knownJobs.has(job.id);
        if (fresh) await repos.jobs.save(job);
        count('jobs', fresh);
      }
      /*
       * The handovers, written once however often this runs.
       *
       * `recordTransfer` mints a fresh uuid on every call — correct for the
       * application, where each handover IS a new event, and the reason this
       * cannot be deduplicated by id the way everything else here is. The table
       * is append-only by trigger, so there is no upsert to fall back on
       * either. What identifies a transfer is therefore the event itself: which
       * job, between whom, at what moment.
       *
       * This was the one collection the seed grew on every run. It went
       * unnoticed because it was also the one collection the summary below did
       * not count; it is counted now.
       */
      const key = (entry: {
        jobId: unknown;
        fromUserId: unknown;
        toUserId: unknown;
        transferredAt: string;
      }): string =>
        [
          String(entry.jobId),
          String(entry.fromUserId),
          String(entry.toUserId),
          // Parsed rather than compared as text: the driver hands back an ISO
          // instant that need not be spelled the way the seed spelled it.
          Date.parse(entry.transferredAt),
        ].join('|');

      const knownTransfers = new Set(
        (
          await tx
            .select({
              jobId: schema.jobTransfers.jobId,
              fromUserId: schema.jobTransfers.fromUserId,
              toUserId: schema.jobTransfers.toUserId,
              transferredAt: schema.jobTransfers.transferredAt,
            })
            .from(schema.jobTransfers)
        ).map((row) => key({ ...row, transferredAt: String(row.transferredAt) })),
      );

      for (const transfer of seedTransfers) {
        const fresh = !knownTransfers.has(key(transfer));
        if (fresh) await repos.jobs.recordTransfer?.(transfer);
        count('transfers', fresh);
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
      const knownParticipation = new Set(
        (
          await tx
            .select({
              jobId: schema.jobParticipants.jobId,
              userId: schema.jobParticipants.userId,
              role: schema.jobParticipants.role,
            })
            .from(schema.jobParticipants)
        ).map((row) => `${String(row.jobId)}|${String(row.userId)}|${row.role}`),
      );

      for (const entry of seedParticipation) {
        const key = `${entry.jobId as string}|${entry.userId as string}|${entry.role}`;
        if (knownParticipation.has(key)) continue;

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

    
    });

    await phase('audit trail', async () => {
      /* ---- the trail ---- */
      const trail = await repos.activity.list();
      const seen = new Set(trail.map((entry) => entry.id as string));
      for (const entry of seedActivity) {
        const exists = seen.has(entry.id as string);
        if (!exists) await repos.activity.append(entry);
        count('audit events', !exists);
      }

    
    });

    await phase('calendar, chat, bell', async () => {
      /* ---- calendar, chat and the bell ---- */
      const knownAvailability = await idsIn(tx, schema.availability);
      for (const record of seedAvailability) {
        const fresh = !knownAvailability.has(record.id);
        if (fresh) await repos.availability.save(record);
        count('availability', fresh);
      }
      const knownConversations = await idsIn(tx, schema.chatConversations);
      for (const conversation of seedConversations) {
        const fresh = !knownConversations.has(conversation.id);
        if (fresh) await repos.chat.saveConversation(conversation);
        count('conversations', fresh);
      }
      const knownMessages = await idsIn(tx, schema.chatMessages);
      for (const message of seedMessages) {
        const fresh = !knownMessages.has(message.id);
        if (fresh) await repos.chat.saveMessage(message);
        count('messages', fresh);
      }
      // Was one `notifications.list(recipient)` PER notification, which read the
      // same person's bell over and over.
      const knownNotifications = await idsIn(tx, schema.notifications);
      for (const notification of seedNotifications) {
        const fresh = !knownNotifications.has(notification.id);
        if (fresh) await repos.notifications.create(notification);
        count('notifications', fresh);
      }
    });

  });

  /*
   * Move the job-number sequence past the seeded numbers.
   *
   * `advance_job_number_sequence` only ever moves FORWARD — it is the function
   * the migration provides for exactly this — so running the seed against a
   * database that already has higher numbers cannot hand out a duplicate.
   */
  await phase('job-number sequence', () =>
    db.execute(sql`select advance_job_number_sequence(${HIGHEST_JOB_SEQUENCE + 1})`),
  );
};


/** What the run wrote, and what it found already there. */
export const summarise = (startedAt: number): void => {
  console.log(`\nSeeded in ${took(Date.now() - startedAt)}:`);
  for (const [kind, counts] of Object.entries(report)) {
    const existing = counts.existing > 0 ? `, ${counts.existing} already present` : '';
    console.log(`  ${String(counts.created).padStart(3)} ${kind}${existing}`);
  }
};

/** The accounts, and the sentence that must always travel with them. */
export const announceAccounts = (where: string): void => {
  console.log(`\nSign in at /dashboard with any of these ${where} accounts:`);
  for (const { user } of seedPeople) {
    console.log(`  ${user.email.padEnd(30)} ${user.role.padEnd(12)} ${DEMO_PASSWORD}`);
  }
  console.log(
    '\nThese credentials are published in this repository and are DEMO ONLY. They exist so a ' +
      'test environment can be signed into. They must never be created on the live EJE ' +
      'deployment, and the live deployment must never reuse this password.',
  );
};

/** So an entry point can refuse a database with no schema in the same words. */
export const requireSchema = async (db: Database): Promise<void> => {
  await phase('checking the schema', async () => {
    if (!(await schemaIsReady(db))) {
      throw new SeedRefused(
        'That database has no EJE schema yet. Run `npm run db:migrate` against it first.',
      );
    }
  });
};

/**
 * The pool, closed on the way out whether the seed finished or failed.
 *
 * Without it the process keeps a socket open and a person watching a terminal
 * cannot tell "still working" from "finished and not exiting" — which is the
 * same confusion the phase lines above exist to end.
 */
export const closeConnection = async (db: Database): Promise<void> => {
  process.stdout.write('  closing the connection    ');
  await db.$client.end({ timeout: 5 });
  process.stdout.write('done\n');
};
