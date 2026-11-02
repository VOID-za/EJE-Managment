import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { asCustomerId, asUserId, STANDBY_POSITIONS, type StandbyDaySwap, type StandbyWeek, type User } from '@/domain';
import type { Database } from '@/db/client';
import type { AppServices, OperationContext } from '@/application/context';
import { answerStandbyDaySwap, decideStandbyDaySwap, requestStandbyDaySwap } from '@/application/standby-days';
import { withRepositories } from '@/data/backend';
import { UuidGenerator } from '@/services/production/ids';
import { IDS, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresStandbyRepository } from './standby-repository';
import { PostgresUserRepository } from './user-repository';
import { PostgresCustomerRepository } from './customer-repository';
import { withTransaction } from './transaction';

/**
 * MIGRATION 0047 ON PostgreSQL — the next critical batch, 2 November 2026.
 *
 * The Apprentice role and its standby places (ROLE-APP-1); customers' rate
 * option and Custom Rates (CUST-RATES-1); a job document chosen for the
 * customer email and the email's extra attachments, fixed once written
 * (JOB-ATT-3); and the day swap with its day overrides (STANDBY-DAY-1) — what
 * the database itself refuses, and an approval that is all or nothing.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const NOW = '2026-11-02T08:00:00.000Z';
const WEEK_A = '2027-03-01';
const WEEK_B = '2027-03-08';
const SAT_A = '2027-03-06';
const SAT_B = '2027-03-13';
const SUN_A = '2027-03-07';
const SUN_B = '2027-03-14';
const APPRENTICE = '00000000-0000-4000-8000-0000000000b1';

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    const error = cause as { message?: string; cause?: { message?: string } };
    return `${error.message ?? ''} ${error.cause?.message ?? ''}`;
  }
  throw new Error('expected the database to refuse the statement');
};

const services = (): AppServices => ({ clock: { now: () => NOW }, ids: new UuidGenerator() }) as unknown as AppServices;

describeDb('migration 0047 — the next critical batch', () => {
  let db: Database;
  let repo: PostgresStandbyRepository;
  let tech: User;
  let other: User;
  let coordinator: User;

  const week = (weekStart: string, holders: Partial<Record<(typeof STANDBY_POSITIONS)[number], string>>): StandbyWeek => ({
    id: crypto.randomUUID(),
    weekStart,
    status: 'draft',
    publishedBy: null,
    publishedAt: null,
    createdBy: asUserId(IDS.master),
    createdAt: NOW,
    assignments: STANDBY_POSITIONS.map((position) => ({
      position,
      userId: holders[position] === undefined ? null : asUserId(holders[position]!),
      assignedBy: holders[position] === undefined ? null : asUserId(IDS.master),
      assignedAt: holders[position] === undefined ? null : NOW,
    })),
  });

  const run = <T,>(actor: User, work: (context: OperationContext) => Promise<T>) =>
    withRepositories((repos) => work({ repos, services: services(), actor }), db);

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    // ROLE-APP-1: an Apprentice account is a row like any other.
    await db.execute(sql`insert into users (id, first_name, last_name, initials, email, role) values (${APPRENTICE}, 'Ayanda', 'Apprentice', 'AA', 'ayanda@example-test.co.za', 'apprentice')`);
    repo = new PostgresStandbyRepository(db);
    for (const id of [IDS.technician, IDS.otherTechnician]) {
      await repo.saveEligibility({ userId: asUserId(id), main: true, helper: false, apprentice: false, updatedBy: asUserId(IDS.master), updatedAt: NOW });
    }
    await repo.saveEligibility({ userId: asUserId(APPRENTICE), main: false, helper: false, apprentice: true, updatedBy: asUserId(IDS.master), updatedAt: NOW });
    await repo.createWeeks([
      week(WEEK_A, { main: IDS.technician, apprentice_1: APPRENTICE }),
      week(WEEK_B, { main: IDS.otherTechnician }),
    ]);
    await repo.publishWeeks([WEEK_A, WEEK_B], asUserId(IDS.master), NOW);
    const users = new PostgresUserRepository(db);
    tech = (await users.findById(asUserId(IDS.technician)))!;
    other = (await users.findById(asUserId(IDS.otherTechnician)))!;
    coordinator = (await users.findById(asUserId(IDS.coordinator)))!;
  });

  it('ROLE-APP-1: an apprentice holds an apprentice standby place; an office account still may not', async () => {
    expect((await repo.findWeek(WEEK_A))!.assignments.find((place) => place.position === 'apprentice_1')!.userId).toBe(APPRENTICE);
    expect(await refusal(db.execute(sql`update standby_assignments set user_id = ${IDS.coordinator} where position = 'apprentice_2' and week_id = (select id from standby_weeks where week_start = ${WEEK_B})`))).toMatch(/technician or apprentice/u);
  });

  it('CUST-RATES-1: every existing customer is on Default Rates; the option is checked; Custom Rates are stored whole', async () => {
    const counts = await db.execute(sql`select count(*) filter (where rate_mode = 'default')::int as d, count(*)::int as n from customers`);
    const row = (counts as unknown as { d: number; n: number }[])[0]!;
    expect(row.d).toBe(row.n);
    expect(await refusal(db.execute(sql`update customers set rate_mode = 'cheap'`))).toMatch(/customers_rate_mode_known/u);
    const customers = new PostgresCustomerRepository(db);
    const first = (await customers.list())[0]!;
    await customers.save({ ...first, rateMode: 'custom' });
    expect((await customers.findById(first.id))?.rateMode).toBe('custom');
    const saved = await customers.saveCustomRates({
      customerId: asCustomerId(first.id),
      labourRates: { normal: 100000, overtime: 150000, double: 200000 },
      calloutRate: 80000,
      testBenchFee: 40000,
      kilometreRate: 2000,
      vatPercentage: 15,
      updatedBy: IDS.master,
      updatedAt: NOW,
    });
    expect(saved).toMatchObject({ calloutRate: 80000, vatPercentage: 15, labourRates: { double: 200000 } });
    expect(await refusal(db.execute(sql`update customer_rates set callout_rate_cents = -1`))).toMatch(/customer_rates_non_negative/u);
  });

  it('JOB-ATT-3: an email’s extra attachments are fixed once written', async () => {
    const jobs = await db.execute(sql`select id from jobs limit 1`);
    const jobId = (jobs as unknown as { id: string }[])[0]?.id ?? null;
    const id = crypto.randomUUID();
    await db.execute(sql`insert into email_messages (id, idempotency_key, event, job_id, state, created_at, updated_at, extra_attachments) values (${id}, ${`k-${id}`}, 'signed_job_card', ${jobId}, 'attention', now(), now(), ${JSON.stringify([{ storageKey: 'uploads/a', fileName: 'Order.pdf', sha256: null }])}::jsonb)`);
    expect(await refusal(db.execute(sql`update email_messages set extra_attachments = '[]'::jsonb where id = ${id}`))).toMatch(/fixed when it is written/u);
    const media = await db.execute(sql`select column_default, is_nullable from information_schema.columns where table_name = 'job_media' and column_name = 'email_to_customer'`);
    expect((media as unknown as { column_default: string; is_nullable: string }[])[0]).toMatchObject({ column_default: 'false', is_nullable: 'NO' });
  });

  const askAndAgree = async (): Promise<StandbyDaySwap> => {
    const swap = await run(tech, (context) =>
      requestStandbyDaySwap(context, {
        recipientId: other.id,
        kind: 'main',
        pairs: [
          { requesterDate: SAT_A, requesterPosition: 'main', recipientDate: SAT_B, recipientPosition: 'main' },
          { requesterDate: SUN_A, requesterPosition: 'main', recipientDate: SUN_B, recipientPosition: 'main' },
        ],
        reason: 'Wedding',
      }),
    );
    return run(other, (context) => answerStandbyDaySwap(context, swap.id, { approve: true }));
  };

  it('STANDBY-DAY-1: an approval exchanges exactly the chosen days, all of them, and nothing else', async () => {
    const swap = await askAndAgree();
    const approved = await run(coordinator, (context) => decideStandbyDaySwap(context, swap.id, { approve: true }));
    expect(approved.status).toBe('approved');
    const overrides = await repo.listDayOverrides(WEEK_A, '2027-03-14');
    expect(overrides.map((o) => `${o.date}/${o.position}/${o.userId}`).sort()).toEqual(
      [`${SAT_A}/main/${IDS.otherTechnician}`, `${SAT_B}/main/${IDS.technician}`, `${SUN_A}/main/${IDS.otherTechnician}`, `${SUN_B}/main/${IDS.technician}`].sort(),
    );
    // The weekly places themselves are untouched.
    expect((await repo.findWeek(WEEK_A))!.assignments[0]!.userId).toBe(IDS.technician);
    expect((await repo.findWeek(WEEK_B))!.assignments[0]!.userId).toBe(IDS.otherTechnician);
  });

  it('STANDBY-DAY-1: two Office approvals in two transactions let exactly one through', async () => {
    const swap = await askAndAgree();
    const results = await Promise.allSettled([
      run(coordinator, (context) => decideStandbyDaySwap(context, swap.id, { approve: true })),
      run({ ...coordinator, id: asUserId(IDS.master), role: 'master' }, (context) => decideStandbyDaySwap(context, swap.id, { approve: true })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await repo.listDayOverrides(WEEK_A, '2027-03-14')).toHaveLength(4);
  });

  it('STANDBY-DAY-1: an approval that fails part-way leaves nothing behind', async () => {
    const swap = await askAndAgree();
    // The other technician stops being eligible: the database refuses the second day's override.
    await db.execute(sql`update standby_eligibility set may_main = false where user_id = ${IDS.otherTechnician}`);
    const moves = [
      { date: SAT_A, position: 'main' as const, expectedUserId: asUserId(IDS.technician), userId: asUserId(IDS.otherTechnician) },
      { date: SAT_B, position: 'main' as const, expectedUserId: asUserId(IDS.otherTechnician), userId: asUserId(IDS.technician) },
    ];
    await expect(
      withTransaction(db, async (tx) => new PostgresStandbyRepository(tx).approveDaySwap({ id: swap.id, by: asUserId(IDS.coordinator), at: NOW, note: '' }, moves)),
    ).rejects.toBeDefined();
    expect(await repo.listDayOverrides(WEEK_A, '2027-03-14')).toHaveLength(0);
    expect((await repo.findDaySwap(swap.id))?.status).toBe('awaiting_office');
  });

  it('STANDBY-DAY-1: the database refuses what the rules forbid', async () => {
    const swap = await askAndAgree();
    // A day swap is never deleted, never rewritten, and moves only forward.
    expect(await refusal(db.execute(sql`delete from standby_day_swaps where id = ${swap.id}`))).toMatch(/cannot be deleted/u);
    expect(await refusal(db.execute(sql`update standby_day_swaps set pairs = '[]'::jsonb where id = ${swap.id}`))).toMatch(/fixed when a standby day swap is written|has_pairs/u);
    expect(await refusal(db.execute(sql`update standby_day_swaps set status = 'awaiting_recipient' where id = ${swap.id}`))).toMatch(/cannot go from/u);
    expect(await refusal(db.execute(sql`update standby_day_swaps set status = 'approved' where id = ${swap.id}`))).toMatch(/names who decided/u);
    expect(await refusal(db.execute(sql`update standby_day_swaps set status = 'approved', office_decided_by = requester_id, office_decided_at = now() where id = ${swap.id}`))).toMatch(/office_is_another/u);
    expect(await refusal(db.execute(sql`insert into standby_day_swaps (id, kind, requester_id, recipient_id, pairs, status, requested_at) values (${crypto.randomUUID()}, 'main', ${IDS.technician}, ${IDS.otherTechnician}, '[{}]'::jsonb, 'approved', now())`))).toMatch(/starts by waiting/u);
    // A day override is written only while its swap awaits the Office, only in a published week, only to an eligible person.
    const pending = await run(tech, (context) =>
      requestStandbyDaySwap(context, { recipientId: other.id, kind: 'main', pairs: [{ requesterDate: '2027-03-02', requesterPosition: 'main', recipientDate: '2027-03-09', recipientPosition: 'main' }] }),
    );
    expect(await refusal(db.execute(sql`insert into standby_day_overrides (id, date, position, user_id, swap_id) values (${crypto.randomUUID()}, '2027-03-02', 'main', ${IDS.otherTechnician}, ${pending.id})`))).toMatch(/only when the Office approves/u);
    expect(await refusal(db.execute(sql`insert into standby_day_overrides (id, date, position, user_id, swap_id) values (${crypto.randomUUID()}, '2027-05-01', 'main', ${IDS.otherTechnician}, ${swap.id})`))).toMatch(/published week/u);
    expect(await refusal(db.execute(sql`insert into standby_day_overrides (id, date, position, user_id, swap_id) values (${crypto.randomUUID()}, ${SAT_A}, 'main', ${IDS.coordinator}, ${swap.id})`))).toMatch(/technician or apprentice/u);
    await run(coordinator, (context) => decideStandbyDaySwap(context, swap.id, { approve: true }));
    expect(await refusal(db.execute(sql`delete from standby_day_overrides`))).toMatch(/cannot be deleted/u);
    expect(await refusal(db.execute(sql`update standby_day_overrides set date = '2027-03-03'`))).toMatch(/cannot be moved/u);
  });

  it('STANDBY-DAY-1: a day already in an active swap cannot be asked for again', async () => {
    await askAndAgree();
    const again = await refusal(
      run(tech, (context) =>
        requestStandbyDaySwap(context, { recipientId: other.id, kind: 'main', pairs: [{ requesterDate: SAT_A, requesterPosition: 'main', recipientDate: SAT_B, recipientPosition: 'main' }] }),
      ),
    );
    expect(again).toMatch(/already in another swap/u);
  });
});
