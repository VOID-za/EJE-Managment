import { check, index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, instant, primaryId } from './columns';
import { contacts, customers, sites } from './customers';
import { jobs } from './jobs';
import { machines } from './machines';
import { users } from './identity';

/**
 * A technician's report that the register is wrong, and what the office did
 * about it. MASTER SCOPE CUST-CR.
 *
 * THE ROW EXISTS BECAUSE THE REFUSAL ALREADY PROMISED IT. `assertManages`
 * refuses a technician's customer edit with "Technicians can view customers and
 * raise change requests, but not edit them", and the machine register says the
 * same. Both sentences predate this table by months; until now there was
 * nowhere to raise one, so a technician standing in front of a machine whose
 * serial number is wrong could read that they may report it and had no way to.
 *
 * `customer_id` IS `restrict`, like `capture_referrals.job_id`. A change request
 * is a record that somebody reported a problem with this customer's record,
 * which is history — deleting the customer to make the report disappear is the
 * one thing that must not be possible. The optional `site_id` and `machine_id`
 * are `restrict` for the same reason: a machine with an open report against it
 * cannot be quietly removed from under it.
 *
 * NOTHING HERE APPLIES ITSELF. There is no proposed-value column, and that is
 * deliberate rather than unfinished: a structured "change the serial to X" that
 * the system could apply would need EJE to answer who may approve what, and
 * whether an approved change reaches the jobs already carried out on that
 * machine (MACH-HIST, #28). Neither is settled, so the table carries the
 * technician's WORDS and the office's DECISION, and the office edits the
 * register themselves through the screens that already authorise it.
 *
 * `subject` AND `state` ARE TEXT, not enums, following `capture_referrals` and
 * `machine_approvals`: another subject or a third outcome is a business decision
 * and must not need a migration to record. The TypeScript unions in
 * `src/domain/types/change-request.ts` keep today's values honest.
 */
export const customerChangeRequests = pgTable(
  'customer_change_requests',
  {
    id: primaryId(),
    /** 'customer' | 'site' | 'machine' — see the domain union. */
    subject: text('subject').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'restrict' }),
    machineId: uuid('machine_id').references(() => machines.id, { onDelete: 'restrict' }),
    /**
     * THE JOB A CUSTOMER HAS ASKED FOR SOMETHING ON. CUST-CR, the job half.
     *
     * `restrict` like every other reference here: a job with a customer's
     * request against it cannot be deleted out from under the record of them
     * asking. Set on a `job` request and null on every other subject, both ways
     * round, which the CHECK below enforces.
     */
    jobId: uuid('job_id').references(() => jobs.id, { onDelete: 'restrict' }),
    /**
     * WHO AT THE CUSTOMER ASKED.
     *
     * `raised_by` is the EJE person who took the call; this is the customer
     * contact who made it. Nullable, because the office does not always know
     * which of four contacts telephoned — and a required field people fill in
     * with "the customer" is worse than an empty one.
     */
    requestedByContactId: uuid('requested_by_contact_id').references(() => contacts.id, {
      onDelete: 'restrict',
    }),
    /** What the technician says is wrong, in their own words. */
    details: text('details').notNull(),
    raisedBy: uuid('raised_by').references(() => users.id),
    raisedAt: instant('raised_at').notNull(),
    state: text('state').notNull().default('open'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: instant('resolved_at'),
    /** What the office did about it, in theirs. */
    resolutionNote: text('resolution_note').notNull().default(''),
    createdAt: createdAt(),
  },
  (table) => [
    // The office's screen: what is still waiting, oldest first.
    index('customer_change_requests_state_idx').on(table.state, table.raisedAt),
    index('customer_change_requests_customer_idx').on(table.customerId, table.raisedAt),
    index('customer_change_requests_raised_by_idx').on(table.raisedBy, table.raisedAt),
    // The job screen's own read: what the customer has asked for on this job.
    index('customer_change_requests_job_idx').on(table.jobId, table.raisedAt),
    // A report must say something. An empty one is a telephone call nobody made.
    check('customer_change_requests_details_present', sql`length(btrim(${table.details})) > 0`),
    /*
     * A RESOLVED REQUEST SAYS WHO AND WHEN. The state and the two columns cannot
     * disagree: "the office dealt with it" and "nobody is recorded as having
     * dealt with it" is the shape that makes an audit trail worthless.
     */
    check(
      'customer_change_requests_resolved_is_attributed',
      sql`(${table.state} = 'open') = (${table.resolvedAt} is null)`,
    ),
    check(
      'customer_change_requests_resolver_recorded',
      sql`${table.resolvedAt} is null or ${table.resolvedBy} is not null`,
    ),
    /*
     * A JOB REQUEST NAMES A JOB, AND NOTHING ELSE DOES. CUST-CR, the job half.
     *
     * An equivalence, so it refuses both halves: a `job` request with no job —
     * which is a request about nothing — and a `machine` request that happens
     * to carry a job id, which would put a customer's request on a job screen
     * under a heading about the register.
     */
    check(
      'customer_change_requests_job_matches_subject',
      sql`(${table.subject} = 'job') = (${table.jobId} is not null)`,
    ),
    // And only a customer's request has a customer contact behind it: on a
    // register report there is nobody at the customer who asked.
    check(
      'customer_change_requests_contact_is_for_a_job',
      sql`${table.requestedByContactId} is null or ${table.subject} = 'job'`,
    ),
  ],
);
