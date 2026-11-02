import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { asUserId, STANDBY_POSITIONS, type StandbyWeek, type User } from '@/domain';
import type { Database } from '@/db/client';
import type { AppServices, OperationContext } from '@/application/context';
import { decideStandbySwap, requestStandbySwap } from '@/application/standby';
import { withRepositories } from '@/data/backend';
import { UuidGenerator } from '@/services/production/ids';
import { IDS, seedBaseline } from './test-fixtures';
import { openTestDatabase, testDatabaseUrl, truncateAll } from './test-database';
import { PostgresStandbyRepository } from './standby-repository';
import { PostgresUserRepository } from './user-repository';

/**
 * THE STANDBY CALENDAR ON PostgreSQL. STANDBY-1…8, migration 0045.
 *
 * What the database itself refuses (whatever the application does), that a
 * week is never overwritten and a place changes only while it holds who the
 * caller saw, and the two things only a real database can prove: two
 * approvals in two transactions at once let exactly one through, and an
 * approval that fails part-way leaves nothing behind.
 */
const url = testDatabaseUrl();
const describeDb = url === null ? describe.skip : describe;

const NOW = '2026-11-02T08:00:00.000Z';
const WEEK_A = '2027-03-01';
const WEEK_B = '2027-03-08';
const APPRENTICE_1 = '00000000-0000-4000-8000-0000000000a1';
const APPRENTICE_2 = '00000000-0000-4000-8000-0000000000a2';

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    const error = cause as { message?: string; cause?: { message?: string } };
    return `${error.message ?? ''} ${error.cause?.message ?? ''}`;
  }
  throw new Error('expected the database to refuse the statement');
};

const services = (): AppServices =>
  ({ clock: { now: () => NOW }, ids: new UuidGenerator() }) as unknown as AppServices;

describeDb('migration 0045 — the standby calendar', () => {
  let db: Database;
  let repo: PostgresStandbyRepository;
  let people: Record<'master' | 'coordinator' | 'technician' | 'otherTechnician', User>;

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

  const context = (actor: User): OperationContext => ({ repos: null as never, services: services(), actor });

  beforeAll(async () => {
    db = await openTestDatabase(url ?? '');
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await truncateAll(db);
    await seedBaseline(db);
    for (const [id, first, email] of [
      [APPRENTICE_1, 'Andre', 'andre@example-test.co.za'],
      [APPRENTICE_2, 'Deon', 'deon@example-test.co.za'],
    ] as const) {
      await db.execute(sql`insert into users (id, first_name, last_name, initials, email, role) values (${id}, ${first}, 'Apprentice', 'AA', ${email}, 'technician')`);
    }
    repo = new PostgresStandbyRepository(db);
    for (const id of [IDS.technician, IDS.otherTechnician]) {
      await repo.saveEligibility({ userId: asUserId(id), main: true, helper: false, apprentice: false, updatedBy: asUserId(IDS.master), updatedAt: NOW });
    }
    for (const id of [APPRENTICE_1, APPRENTICE_2]) {
      await repo.saveEligibility({ userId: asUserId(id), main: false, helper: false, apprentice: true, updatedBy: asUserId(IDS.master), updatedAt: NOW });
    }
    await repo.createWeeks([
      week(WEEK_A, { main: IDS.technician, apprentice_1: APPRENTICE_1 }),
      week(WEEK_B, { main: IDS.otherTechnician, apprentice_2: APPRENTICE_2 }),
    ]);
    await repo.publishWeeks([WEEK_A, WEEK_B], asUserId(IDS.master), NOW);
    const users = new PostgresUserRepository(db);
    people = {
      master: (await users.findById(asUserId(IDS.master)))!,
      coordinator: (await users.findById(asUserId(IDS.coordinator)))!,
      technician: (await users.findById(asUserId(IDS.technician)))!,
      otherTechnician: (await users.findById(asUserId(IDS.otherTechnician)))!,
    };
  });

  const ask = () =>
    withRepositories(
      (repos) =>
        requestStandbySwap(
          { ...context(people.technician), repos },
          { kind: 'main', weekStart: WEEK_A, counterpartId: IDS.otherTechnician, counterpartWeekStart: WEEK_B, reason: 'Wedding' },
        ),
      db,
    );

  it('never overwrites an existing week, and changes a place only while it holds who the caller saw', async () => {
    expect(await repo.createWeeks([week(WEEK_A, { main: IDS.otherTechnician })])).toEqual([]);
    expect((await repo.findWeek(WEEK_A))!.assignments[0]!.userId).toBe(IDS.technician);
    const stale = { weekStart: WEEK_A, position: 'main' as const, expectedUserId: asUserId(IDS.otherTechnician), userId: null, assignedBy: asUserId(IDS.master), assignedAt: NOW };
    expect(await repo.setAssignment(stale)).toBe(false);
    expect(await repo.setAssignment({ ...stale, expectedUserId: asUserId(IDS.technician) })).toBe(true);
    expect((await repo.findWeek(WEEK_A))!.assignments[0]!.userId).toBeNull();
  });

  it('refuses at the database what the rules forbid', async () => {
    expect(await refusal(db.execute(sql`insert into standby_weeks (id, week_start) values (gen_random_uuid(), '2027-03-02')`))).toMatch(/standby_weeks_starts_monday/u);
    expect(await refusal(db.execute(sql`update standby_weeks set status = 'draft', published_by = null, published_at = null where week_start = ${WEEK_A}`))).toMatch(/stays published/u);
    expect(await refusal(db.execute(sql`delete from standby_weeks where week_start = ${WEEK_A}`))).toMatch(/cannot be deleted/u);
    expect(await refusal(db.execute(sql`delete from standby_assignments`))).toMatch(/cannot be deleted/u);
    expect(await refusal(db.execute(sql`delete from standby_eligibility`))).toMatch(/cannot be deleted/u);
    // An apprentice in the main place; the coordinator (not a technician) anywhere.
    const place = (position: string, userId: string) =>
      db.execute(sql`update standby_assignments set user_id = ${userId} where position = ${position} and week_id = (select id from standby_weeks where week_start = ${WEEK_B})`);
    expect(await refusal(place('helper', APPRENTICE_1))).toMatch(/eligible/u);
    expect(await refusal(place('helper', IDS.coordinator))).toMatch(/eligible/u);
    // One person in two places of one week.
    await repo.saveEligibility({ userId: asUserId(IDS.otherTechnician), main: true, helper: true, apprentice: false, updatedBy: null, updatedAt: NOW });
    expect(await refusal(place('helper', IDS.otherTechnician))).toMatch(/standby_assignments_week_user_key/u);
    // An apprentice who is also a technician.
    expect(await refusal(db.execute(sql`update standby_eligibility set may_main = true where user_id = ${APPRENTICE_1}`))).toMatch(/standby_eligibility_apprentice_apart/u);
  });

  it('keeps a swap request whole: real places, one pending per place, decided once, never by the requester', async () => {
    // Naming a place the counterpart does not hold.
    const wrong = await refusal(
      repo.createSwapRequest({
        id: crypto.randomUUID(), kind: 'main', requesterId: asUserId(IDS.technician), requesterWeekStart: WEEK_A, requesterPosition: 'main',
        counterpartId: asUserId(IDS.master), counterpartWeekStart: WEEK_B, counterpartPosition: 'main', reason: '', status: 'pending',
        requestedAt: NOW, decidedBy: null, decidedAt: null, decisionNote: '', cancelledAt: null,
      }),
    );
    expect(wrong).toMatch(/actually hold/u);
    const request = await ask();
    expect(request.status).toBe('pending');
    // A second pending request for the same place is "not created", never a second row.
    expect(
      await repo.createSwapRequest({ ...(await repo.findSwapRequest(request.id))!, id: crypto.randomUUID() }),
    ).toBeNull();
    expect(await refusal(db.execute(sql`update standby_swap_requests set status = 'approved', decided_by = requester_id, decided_at = now() where id = ${request.id}`))).toMatch(/decided_by_another/u);
    expect(await refusal(db.execute(sql`update standby_swap_requests set reason = 'changed' where id = ${request.id}`))).toMatch(/only the outcome/u);
    await repo.rejectSwapRequest({ id: request.id, decidedBy: asUserId(IDS.coordinator), decidedAt: NOW, decisionNote: 'No' });
    expect(await repo.rejectSwapRequest({ id: request.id, decidedBy: asUserId(IDS.master), decidedAt: NOW, decisionNote: '' })).toBeNull();
    expect(await refusal(db.execute(sql`update standby_swap_requests set decision_note = 'rewritten' where id = ${request.id}`))).toMatch(/already rejected/u);
    expect(await refusal(db.execute(sql`delete from standby_swap_requests`))).toMatch(/cannot be deleted/u);
  });

  it('lets exactly one of two simultaneous approvals through, in two transactions', async () => {
    const request = await ask();
    const approve = (actor: User) =>
      withRepositories((repos) => decideStandbySwap({ ...context(actor), repos }, request.id, { decision: 'approve' }), db);
    const outcomes = await Promise.allSettled([approve(people.coordinator), approve(people.master)]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await repo.findWeek(WEEK_A))!.assignments[0]!.userId).toBe(IDS.otherTechnician);
    expect((await repo.findWeek(WEEK_B))!.assignments[0]!.userId).toBe(IDS.technician);
    // Every other place untouched.
    expect((await repo.findWeek(WEEK_A))!.assignments[2]!.userId).toBe(APPRENTICE_1);
    expect((await repo.findWeek(WEEK_B))!.assignments[3]!.userId).toBe(APPRENTICE_2);
    const notes = await db.execute(sql`select count(*)::int as n from notifications where type = 'standby_swap_decided'`);
    expect((notes as unknown as { n: number }[])[0]?.n ?? (notes as unknown as { rows: { n: number }[] }).rows?.[0]?.n).toBe(2);
  });

  it('leaves nothing behind when an approval fails part-way, or the calendar changed', async () => {
    const request = await ask();
    await expect(
      withRepositories(async (repos) => {
        const result = await repos.standby.approveSwapRequest({ id: request.id, decidedBy: asUserId(IDS.coordinator), decidedAt: NOW, decisionNote: '' });
        expect(result.ok).toBe(true);
        throw new Error('the request failed after the exchange');
      }, db),
    ).rejects.toThrow(/failed after the exchange/u);
    expect((await repo.findWeek(WEEK_A))!.assignments[0]!.userId).toBe(IDS.technician);
    expect((await repo.findWeek(WEEK_B))!.assignments[0]!.userId).toBe(IDS.otherTechnician);
    expect((await repo.findSwapRequest(request.id))!.status).toBe('pending');

    await repo.setAssignment({ weekStart: WEEK_B, position: 'main', expectedUserId: asUserId(IDS.otherTechnician), userId: null, assignedBy: asUserId(IDS.master), assignedAt: NOW });
    expect(await repo.approveSwapRequest({ id: request.id, decidedBy: asUserId(IDS.coordinator), decidedAt: NOW, decisionNote: '' })).toEqual({ ok: false, reason: 'assignment_changed' });
    expect((await repo.findWeek(WEEK_A))!.assignments[0]!.userId).toBe(IDS.technician);
    expect((await repo.findSwapRequest(request.id))!.status).toBe('pending');
  });
});
