import { beforeEach, describe, expect, it } from 'vitest';
import {
  addStandbyDays,
  can,
  standbyPlanningLimit,
  standbyWeekEnd,
  standbyWeekOf,
  standbyWeekTiming,
  standbyWeeksOfYear,
  type StandbyPosition,
  type User,
} from '@/domain';
import { buildHarness, seedUser, type Harness } from './test-harness';
import {
  assignStandby,
  cancelStandbySwap,
  decideStandbySwap,
  generateStandbyYear,
  listStandbySwaps,
  loadStandbyCalendar,
  loadStandbySwapOptions,
  publishStandbyYear,
  requestStandbySwap,
  setStandbyEligibility,
  type StandbyCalendar,
} from './standby';
import { WorkflowError } from './errors';

/**
 * THE STANDBY CALENDAR. STANDBY-1…8 (2 November 2026).
 *
 * Every rule on the server, through the operations the routes call. Today is
 * fixed at Monday 2 November 2026: that week is in progress, 9 November is the
 * next week, 26 October has ended, and 2026 and 2027 can be planned.
 */
const NOW = '2026-11-02T08:00:00.000Z';
const CURRENT = '2026-11-02';
const PAST = '2026-10-26';

const master = seedUser('user-master-elmarie');
const otherMaster = seedUser('user-master-johan');
const coordinator = seedUser('user-coord-christene');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const thabo = seedUser('user-tech-thabo');
const francois = seedUser('user-tech-francois');
const andre = seedUser('user-tech-andre');
const naledi = seedUser('user-tech-naledi');
const deon = seedUser('user-tech-deon');
const lerato = seedUser('user-tech-lerato');
const yusuf = seedUser('user-tech-yusuf');

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof WorkflowError) return cause.violations[0]?.code ?? 'workflow_error';
    throw cause;
  }
  throw new Error('expected the operation to be refused');
};

let harness: Harness;
const as = (user: User) => harness.as(user);

const roster = async () => {
  for (const user of [sipho, riaan]) {
    await setStandbyEligibility(as(coordinator), { userId: user.id, main: true, helper: true, apprentice: false });
  }
  for (const user of [thabo, francois]) {
    await setStandbyEligibility(as(coordinator), { userId: user.id, main: false, helper: true, apprentice: false });
  }
  for (const user of [andre, naledi, deon, lerato]) {
    await setStandbyEligibility(as(coordinator), { userId: user.id, main: false, helper: false, apprentice: true });
  }
};

const ROTATION = {
  main: [sipho.id, riaan.id],
  helper: [thabo.id, francois.id],
  apprentice_1: [andre.id, naledi.id],
  apprentice_2: [deon.id, lerato.id],
};

const scheduled = async () => {
  await roster();
  await generateStandbyYear(as(coordinator), { year: 2026, rotation: ROTATION });
  await publishStandbyYear(as(coordinator), { year: 2026, acknowledgeIncomplete: false });
};

const calendar = (user: User, from = CURRENT, to = '2026-12-31'): Promise<StandbyCalendar> =>
  loadStandbyCalendar(as(user), from, to);

const holder = async (weekStart: string, position: StandbyPosition): Promise<string | null> => {
  const week = (await calendar(master)).weeks.find((candidate) => candidate.weekStart === weekStart);
  return week?.places.find((place) => place.position === position)?.userId ?? null;
};

/** The first two future weeks in which the given place is held by different people. */
const twoWeeks = async (position: StandbyPosition) => {
  const weeks = (await calendar(master)).weeks.filter((week) => week.timing === 'future');
  const first = weeks[0]!;
  const a = first.places.find((place) => place.position === position)!.userId!;
  const second = weeks.find((week) => {
    const other = week.places.find((place) => place.position === position)!.userId;
    return other !== null && other !== a && !week.places.some((place) => place.userId === a) && !first.places.some((place) => place.userId === other);
  })!;
  return {
    weekA: first.weekStart,
    userA: a,
    weekB: second.weekStart,
    userB: second.places.find((place) => place.position === position)!.userId!,
  };
};

const userById = (id: string): User =>
  [sipho, riaan, thabo, francois, andre, naledi, deon, lerato].find((user) => user.id === id)!;

beforeEach(() => {
  harness = buildHarness({ clock: { now: () => NOW } });
});

describe('standby weeks — the calendar arithmetic', () => {
  it('counts 52 or 53 weeks a year by their Mondays, leap years and year boundaries included', () => {
    expect(standbyWeeksOfYear(2026)).toHaveLength(52);
    expect(standbyWeeksOfYear(2026)[0]).toBe('2026-01-05');
    expect(standbyWeeksOfYear(2026).at(-1)).toBe('2026-12-28');
    // A leap year starting on a Monday has 53 Mondays; one starting on a Wednesday has 52.
    expect(standbyWeeksOfYear(2024)).toHaveLength(53);
    expect(standbyWeeksOfYear(2020)).toHaveLength(52);
    expect(standbyWeeksOfYear(2018)).toHaveLength(53);
    // The week of 28 December 2026 runs into 2027 and belongs to 2026 only.
    expect(standbyWeekEnd('2026-12-28')).toBe('2027-01-03');
    expect(standbyWeekOf('2027-01-01')).toBe('2026-12-28');
    expect(standbyWeeksOfYear(2027)[0]).toBe('2027-01-04');
    // 29 February exists in a leap year's week and not otherwise.
    expect(addStandbyDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(standbyWeekOf('2028-02-29')).toBe('2028-02-28');
    expect(addStandbyDays('2027-02-28', 1)).toBe('2027-03-01');
  });

  it('knows a past, the current and a future week, and plans to the end of next year', () => {
    expect(standbyWeekTiming(PAST, CURRENT)).toBe('past');
    expect(standbyWeekTiming(CURRENT, '2026-11-08')).toBe('current');
    expect(standbyWeekTiming('2026-11-09', CURRENT)).toBe('future');
    expect(standbyPlanningLimit(CURRENT)).toBe('2027-12-31');
  });
});

describe('standby permissions', () => {
  it('gives the view to everybody, administration to the office and swap requests to the field', () => {
    for (const role of ['master', 'coordinator', 'technician'] as const) expect(can(role, 'standby.view')).toBe(true);
    expect(can('master', 'standby.manage')).toBe(true);
    expect(can('coordinator', 'standby.manage')).toBe(true);
    expect(can('technician', 'standby.manage')).toBe(false);
    expect(can('technician', 'standby.requestSwap')).toBe(true);
    expect(can('coordinator', 'standby.requestSwap')).toBe(false);
  });

  it('refuses a technician every administrative operation', async () => {
    await roster();
    const technician = as(sipho);
    expect(await codeOf(setStandbyEligibility(technician, { userId: sipho.id, main: true, helper: true, apprentice: false }))).toBe('not_permitted');
    expect(await codeOf(generateStandbyYear(technician, { year: 2026 }))).toBe('not_permitted');
    expect(await codeOf(publishStandbyYear(technician, { year: 2026, acknowledgeIncomplete: true }))).toBe('not_permitted');
    expect(
      await codeOf(assignStandby(technician, { weekStart: '2026-11-09', position: 'main', userId: sipho.id, expectedUserId: null, reason: '' })),
    ).toBe('not_permitted');
  });

  it('lets a Master do everything a Coordinator does', async () => {
    await roster();
    const result = await generateStandbyYear(as(master), { year: 2027, rotation: ROTATION });
    expect(result.created).toHaveLength(52);
    const published = await publishStandbyYear(as(otherMaster), { year: 2027, acknowledgeIncomplete: false });
    expect(published.published).toHaveLength(52);
  });
});

describe('standby eligibility — the office decides, the role does not', () => {
  it('puts only active technician accounts on the roster, and an apprentice apart', async () => {
    expect(await codeOf(setStandbyEligibility(as(master), { userId: coordinator.id, main: true, helper: false, apprentice: false }))).toBe('not_technician');
    expect(await codeOf(setStandbyEligibility(as(master), { userId: yusuf.id, main: true, helper: false, apprentice: false }))).toBe('user_inactive');
    expect(await codeOf(setStandbyEligibility(as(master), { userId: andre.id, main: true, helper: false, apprentice: true }))).toBe('apprentice_apart');
    const saved = await setStandbyEligibility(as(master), { userId: andre.id, main: false, helper: false, apprentice: true });
    expect(saved).toMatchObject({ apprentice: true, main: false, updatedBy: master.id });
    const trail = await harness.repos.activity.list();
    expect(trail.some((event) => event.type === 'standby_eligibility_changed' && event.summary.includes('André'))).toBe(true);
  });

  it('does not assume a technician account may take any place', async () => {
    expect(
      await codeOf(assignStandby(as(master), { weekStart: '2026-11-09', position: 'main', userId: sipho.id, expectedUserId: null, reason: '' })),
    ).toBe('not_eligible');
    // Refused before anything was written: no week was created for it.
    expect(await harness.repos.standby.findWeek('2026-11-09')).toBeNull();
  });
});

describe('generating and publishing a year', () => {
  it('creates the year’s remaining weeks as drafts from the office’s own order, hidden until published', async () => {
    await roster();
    const result = await generateStandbyYear(as(coordinator), { year: 2026, rotation: ROTATION });
    // From the current week (2 November) to 28 December: nine weeks; past weeks are never created.
    expect(result.created).toEqual(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14', '2026-12-21', '2026-12-28']);
    expect(result.placesFilled).toBe(36);
    const office = await calendar(coordinator);
    expect(office.weeks.every((week) => week.status === 'draft' && week.problems.length === 0)).toBe(true);
    // Week n of the year takes person n of each order — nothing else is assumed.
    const index = standbyWeeksOfYear(2026).indexOf('2026-11-09');
    expect(office.weeks[1]!.places.find((place) => place.position === 'main')!.userId).toBe(ROTATION.main[index % 2]);
    // A technician sees nothing of a draft.
    expect((await calendar(sipho)).weeks).toEqual([]);
    await publishStandbyYear(as(coordinator), { year: 2026, acknowledgeIncomplete: false });
    const field = await calendar(sipho);
    expect(field.weeks).toHaveLength(9);
    expect(field.weeks.every((week) => week.problems.length === 0)).toBe(true);
    expect(field.mine.length).toBeGreaterThan(0);
  });

  it('creates empty weeks when no order is given, and never overwrites anything on regeneration', async () => {
    await roster();
    const empty = await generateStandbyYear(as(coordinator), { year: 2026 });
    expect(empty.placesFilled).toBe(0);
    await assignStandby(as(coordinator), { weekStart: '2026-11-09', position: 'main', userId: riaan.id, expectedUserId: null, reason: '' });
    const again = await generateStandbyYear(as(coordinator), { year: 2026, rotation: { ...ROTATION, main: [sipho.id] } });
    expect(again.created).toEqual([]);
    // The office's own entry stays; only EMPTY places were filled.
    expect(await holder('2026-11-09', 'main')).toBe(riaan.id);
    expect(await holder('2026-11-16', 'main')).toBe(sipho.id);
  });

  it('leaves a published week exactly as it is when the year is generated again', async () => {
    await scheduled();
    const before = (await calendar(master)).weeks;
    await assignStandby(as(coordinator), { weekStart: '2026-11-16', position: 'helper', userId: null, expectedUserId: before[2]!.places[1]!.userId, reason: 'Thabo on leave' });
    const result = await generateStandbyYear(as(coordinator), { year: 2026, rotation: ROTATION });
    expect(result.created).toEqual([]);
    expect(result.placesFilled).toBe(0);
    expect(await holder('2026-11-16', 'helper')).toBeNull();
  });

  it('reports a place it could not fill rather than putting one person in two places', async () => {
    await roster();
    const result = await generateStandbyYear(as(coordinator), { year: 2026, rotation: { main: [sipho.id], helper: [sipho.id] } });
    expect(result.skipped.length).toBe(9);
    expect(result.skipped[0]).toMatchObject({ position: 'helper' });
  });

  it('refuses a year out of range and an order naming somebody who may not take the place', async () => {
    await roster();
    expect(await codeOf(generateStandbyYear(as(coordinator), { year: 2025 }))).toBe('year_out_of_range');
    expect(await codeOf(generateStandbyYear(as(coordinator), { year: 2028 }))).toBe('year_out_of_range');
    expect(await codeOf(generateStandbyYear(as(coordinator), { year: 2026, rotation: { main: [andre.id] } }))).toBe('not_eligible');
    expect(await codeOf(generateStandbyYear(as(coordinator), { year: 2026, rotation: { main: [yusuf.id] } }))).toBe('not_eligible');
  });

  it('will not publish empty places unless acknowledged, nor a week with somebody no longer eligible', async () => {
    await roster();
    await generateStandbyYear(as(coordinator), { year: 2026, rotation: { ...ROTATION, apprentice_2: [] } });
    expect(await codeOf(publishStandbyYear(as(coordinator), { year: 2026, acknowledgeIncomplete: false }))).toBe('incomplete_week');
    await setStandbyEligibility(as(coordinator), { userId: thabo.id, main: false, helper: false, apprentice: false });
    expect((await calendar(coordinator)).weeks.some((week) => week.problems.some((problem) => problem.code === 'not_eligible'))).toBe(true);
    expect(await codeOf(publishStandbyYear(as(coordinator), { year: 2026, acknowledgeIncomplete: true }))).toBe('not_eligible');
    await setStandbyEligibility(as(coordinator), { userId: thabo.id, main: false, helper: true, apprentice: false });
    const done = await publishStandbyYear(as(coordinator), { year: 2026, acknowledgeIncomplete: true });
    expect(done.published).toHaveLength(9);
    expect(done.incomplete).toHaveLength(9);
    expect(await codeOf(publishStandbyYear(as(coordinator), { year: 2026, acknowledgeIncomplete: true }))).toBe('nothing_to_publish');
    const trail = await harness.repos.activity.list();
    expect(trail.filter((event) => event.type === 'standby_schedule_published')).toHaveLength(1);
    expect(trail.filter((event) => event.type === 'standby_schedule_generated')).toHaveLength(1);
  });
});

describe('manual and emergency changes', () => {
  beforeEach(async () => {
    await scheduled();
  });

  it('STANDBY-NOREASON-1: a published week changes WITHOUT a reason, and who and when are still recorded', async () => {
    const current = await holder('2026-11-09', 'helper');
    const replacement = current === thabo.id ? francois : thabo;
    const other = replacement.id === thabo.id ? francois : thabo;
    // No reason at all: saved, audited with who and when, both people told.
    const silent = await assignStandby(as(coordinator), { weekStart: '2026-11-09', position: 'helper', userId: replacement.id, expectedUserId: current });
    expect(silent.emergency).toBe(false);
    const unexplained = (await harness.repos.activity.list()).find((entry) => entry.type === 'standby_assignment_changed')!;
    expect(unexplained.actorId).toBe(coordinator.id);
    expect(unexplained.occurredAt).toBeTruthy();
    expect(unexplained.detail).not.toContain('Reason:');
    expect(other.id).not.toBe(replacement.id);
  });

  it('records a reason when one is given, before and after, and tells both people', async () => {
    const current = await holder('2026-11-09', 'helper');
    const replacement = current === thabo.id ? francois : thabo;
    const result = await assignStandby(as(coordinator), {
      weekStart: '2026-11-09',
      position: 'helper',
      userId: replacement.id,
      expectedUserId: current,
      reason: 'Off sick',
    });
    expect(result.emergency).toBe(false);
    expect(await holder('2026-11-09', 'helper')).toBe(replacement.id);
    const event = (await harness.repos.activity.list()).find((entry) => entry.type === 'standby_assignment_changed')!;
    expect(event.changes).toEqual([{ field: 'standby.2026-11-09.helper', from: expect.any(String), to: `${replacement.firstName} ${replacement.lastName}` }]);
    expect(event.detail).toContain('Reason: Off sick');
    const told = (await harness.repos.notifications.list(replacement.id)).filter((note) => note.type === 'standby_assignment_changed');
    expect(told).toHaveLength(1);
    expect((await harness.repos.notifications.list(current as never)).filter((note) => note.type === 'standby_assignment_changed')).toHaveLength(1);
  });

  it('records a change to the week in progress as an emergency change', async () => {
    const current = await holder(CURRENT, 'main');
    const result = await assignStandby(as(master), { weekStart: CURRENT, position: 'main', userId: null, expectedUserId: current, reason: 'Vehicle breakdown' });
    expect(result.emergency).toBe(true);
    expect((await harness.repos.activity.list()).some((event) => event.type === 'standby_emergency_change')).toBe(true);
  });

  it('refuses a week that has ended, a person twice in one week, an ineligible person and a stale screen', async () => {
    expect(await codeOf(assignStandby(as(coordinator), { weekStart: PAST, position: 'main', userId: sipho.id, expectedUserId: null, reason: 'x' }))).toBe('week_past');
    expect(await codeOf(assignStandby(as(coordinator), { weekStart: '2026-11-10', position: 'main', userId: sipho.id, expectedUserId: null, reason: 'x' }))).toBe('invalid_week');
    const main = await holder('2026-11-09', 'main');
    const helper = await holder('2026-11-09', 'helper');
    const mainUser = userById(main!);
    // The main technician is eligible as a helper, but already holds a place that week.
    expect(await codeOf(assignStandby(as(coordinator), { weekStart: '2026-11-09', position: 'helper', userId: mainUser.id, expectedUserId: helper, reason: 'x' }))).toBe('duplicate_person');
    expect(await codeOf(assignStandby(as(coordinator), { weekStart: '2026-11-09', position: 'main', userId: andre.id, expectedUserId: main, reason: 'x' }))).toBe('not_eligible');
    expect(await codeOf(assignStandby(as(coordinator), { weekStart: '2026-11-09', position: 'main', userId: null, expectedUserId: andre.id, reason: 'x' }))).toBe('assignment_changed');
    expect(await codeOf(assignStandby(as(coordinator), { weekStart: '2028-01-03', position: 'main', userId: null, expectedUserId: null, reason: 'x' }))).toBe('beyond_planning_limit');
  });
});

describe('swap requests', () => {
  beforeEach(async () => {
    await scheduled();
  });

  it('A — a main technician swap exchanges only the two main places, once, after approval', async () => {
    const { weekA, userA, weekB, userB } = await twoWeeks('main');
    const before = (await calendar(master)).weeks;
    const requester = userById(userA);
    const pending = await requestStandbySwap(as(requester), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: 'Wedding' });
    expect(pending).toMatchObject({ status: 'pending', requesterPosition: 'main', counterpartPosition: 'main', stillValid: true });

    // A pending request changes nothing on the calendar, and is flagged on both weeks.
    const during = (await calendar(master)).weeks;
    expect(during.map((week) => week.places)).toEqual(before.map((week) => week.places));
    expect(during.find((week) => week.weekStart === weekA)!.pendingSwaps).toBe(1);
    expect(during.find((week) => week.weekStart === weekB)!.pendingSwaps).toBe(1);
    expect((await harness.repos.notifications.list(coordinator.id)).some((note) => note.type === 'standby_swap_requested')).toBe(true);

    const approved = await decideStandbySwap(as(coordinator), pending.id, { decision: 'approve', note: 'Fine' });
    expect(approved).toMatchObject({ status: 'approved', decidedBy: coordinator.id, decisionNote: 'Fine' });
    const after = (await calendar(master)).weeks;
    for (const week of after) {
      const was = before.find((candidate) => candidate.weekStart === week.weekStart)!;
      for (const place of week.places) {
        const old = was.places.find((candidate) => candidate.position === place.position)!.userId;
        if (place.position === 'main' && week.weekStart === weekA) expect(place.userId).toBe(userB);
        else if (place.position === 'main' && week.weekStart === weekB) expect(place.userId).toBe(userA);
        else expect(place.userId).toBe(old);
      }
    }
    // Both people are told, once; deciding again is refused and tells nobody again.
    for (const id of [userA, userB]) {
      expect((await harness.repos.notifications.list(id as never)).filter((note) => note.type === 'standby_swap_decided')).toHaveLength(1);
    }
    expect(await codeOf(decideStandbySwap(as(master), pending.id, { decision: 'approve' }))).toBe('already_decided');
    expect(await codeOf(decideStandbySwap(as(master), pending.id, { decision: 'reject' }))).toBe('already_decided');
    for (const id of [userA, userB]) {
      expect((await harness.repos.notifications.list(id as never)).filter((note) => note.type === 'standby_swap_decided')).toHaveLength(1);
    }
    const trail = (await harness.repos.activity.list()).find((event) => event.type === 'standby_swap_approved')!;
    expect(trail.changes).toHaveLength(2);
    expect(trail.detail).toContain(pending.id);
  });

  it('B — an apprentice swap exchanges only the two apprentice places', async () => {
    const weeks = (await calendar(master)).weeks.filter((week) => week.timing === 'future');
    const a = weeks[0]!;
    const userA = a.places.find((place) => place.position === 'apprentice_1')!.userId!;
    const b = weeks.find(
      (week) =>
        !week.places.some((place) => place.userId === userA) &&
        !a.places.some((place) => place.userId === week.places.find((p) => p.position === 'apprentice_2')!.userId),
    )!;
    const userB = b.places.find((place) => place.position === 'apprentice_2')!.userId!;
    const request = await requestStandbySwap(as(userById(userA)), { kind: 'apprentice', weekStart: a.weekStart, counterpartId: userB, counterpartWeekStart: b.weekStart, reason: '' });
    expect(request).toMatchObject({ requesterPosition: 'apprentice_1', counterpartPosition: 'apprentice_2', kind: 'apprentice' });
    await decideStandbySwap(as(master), request.id, { decision: 'approve' });
    const after = (await calendar(master)).weeks;
    const nextA = after.find((week) => week.weekStart === a.weekStart)!;
    const nextB = after.find((week) => week.weekStart === b.weekStart)!;
    expect(nextA.places.map((place) => place.userId)).toEqual(a.places.map((place) => (place.position === 'apprentice_1' ? userB : place.userId)));
    expect(nextB.places.map((place) => place.userId)).toEqual(b.places.map((place) => (place.position === 'apprentice_2' ? userA : place.userId)));
  });

  it('refuses the wrong kind of swap, a helper’s place and somebody else’s place', async () => {
    const { weekA, userA, weekB, userB } = await twoWeeks('main');
    const apprentice = (await calendar(master)).weeks.find((week) => week.weekStart === weekA)!.places.find((place) => place.position === 'apprentice_1')!.userId!;
    const helper = (await calendar(master)).weeks.find((week) => week.weekStart === weekA)!.places.find((place) => place.position === 'helper')!.userId!;
    // A main technician asking for an apprentice swap, an apprentice asking for a main swap.
    expect(await codeOf(requestStandbySwap(as(userById(userA)), { kind: 'apprentice', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' }))).toBe('swap_kind_mismatch');
    expect(await codeOf(requestStandbySwap(as(userById(apprentice)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' }))).toBe('swap_kind_mismatch');
    expect(await codeOf(requestStandbySwap(as(userById(helper)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' }))).toBe('helper_not_swappable');
    // Offering a place one does not hold — another technician's.
    expect(await codeOf(requestStandbySwap(as(userById(userB)), { kind: 'main', weekStart: weekA, counterpartId: userA, counterpartWeekStart: weekB, reason: '' }))).toBe('not_your_assignment');
    // Naming a counterpart who does not hold the place in that week.
    expect(await codeOf(requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: apprentice, counterpartWeekStart: weekB, reason: '' }))).toBe('counterpart_not_assigned');
    // The office does not ask; it changes the calendar directly.
    expect(await codeOf(requestStandbySwap(as(coordinator), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' }))).toBe('not_permitted');
    expect(await codeOf(requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekA, reason: '' }))).toBe('same_week');
  });

  it('refuses the week in progress and a counterpart who is no longer eligible or active', async () => {
    const current = (await calendar(master)).weeks.find((week) => week.weekStart === CURRENT)!;
    const mainNow = current.places.find((place) => place.position === 'main')!.userId!;
    const { weekB, userB } = await twoWeeks('main');
    const other = userB === mainNow ? (await twoWeeks('main')).userA : userB;
    expect(await codeOf(requestStandbySwap(as(userById(mainNow)), { kind: 'main', weekStart: CURRENT, counterpartId: other, counterpartWeekStart: weekB, reason: '' }))).toBe('week_not_swappable');

    const { weekA, userA, weekB: b2, userB: u2 } = await twoWeeks('main');
    await setStandbyEligibility(as(coordinator), { userId: u2, main: false, helper: true, apprentice: false });
    expect(await codeOf(requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: u2, counterpartWeekStart: b2, reason: '' }))).toBe('not_eligible');
  });

  it('refuses a duplicate and a conflicting pending request', async () => {
    const { weekA, userA, weekB, userB } = await twoWeeks('main');
    await requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' });
    expect(await codeOf(requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' }))).toBe('swap_pending');
    // The counterpart offering their already-requested place the other way round.
    expect(await codeOf(requestStandbySwap(as(userById(userB)), { kind: 'main', weekStart: weekB, counterpartId: userA, counterpartWeekStart: weekA, reason: '' }))).toBe('swap_pending');
    // Options no longer offer either place.
    const options = await loadStandbySwapOptions(as(userById(userA)));
    expect(options.mine.some((place) => place.weekStart === weekA && place.position === 'main')).toBe(false);
  });

  it('refuses to approve once the calendar changed, and changes nothing', async () => {
    const { weekA, userA, weekB, userB } = await twoWeeks('main');
    const request = await requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' });
    await assignStandby(as(master), { weekStart: weekB, position: 'main', userId: null, expectedUserId: userB, reason: 'Resigned' });
    expect((await listStandbySwaps(as(coordinator), 'pending'))[0]!.stillValid).toBe(false);
    const before = (await calendar(master)).weeks;
    expect(await codeOf(decideStandbySwap(as(coordinator), request.id, { decision: 'approve' }))).toBe('assignment_changed');
    expect((await calendar(master)).weeks).toEqual(before);
    expect((await harness.repos.standby.findSwapRequest(request.id))!.status).toBe('pending');
    // It can still be rejected.
    expect((await decideStandbySwap(as(coordinator), request.id, { decision: 'reject', note: 'Week changed' })).status).toBe('rejected');
  });

  it('a rejection changes nothing and tells only the requester; the requester may withdraw, nobody else', async () => {
    const { weekA, userA, weekB, userB } = await twoWeeks('main');
    const before = (await calendar(master)).weeks;
    const first = await requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: 'Exam' });
    expect(await codeOf(decideStandbySwap(as(userById(userB)), first.id, { decision: 'approve' }))).toBe('not_permitted');
    const rejected = await decideStandbySwap(as(coordinator), first.id, { decision: 'reject', note: 'Too short notice' });
    expect(rejected).toMatchObject({ status: 'rejected', decisionNote: 'Too short notice' });
    expect((await calendar(master)).weeks).toEqual(before);
    expect((await harness.repos.notifications.list(userA as never)).filter((note) => note.type === 'standby_swap_decided')).toHaveLength(1);
    expect((await harness.repos.notifications.list(userB as never)).filter((note) => note.type === 'standby_swap_decided')).toHaveLength(0);

    const second = await requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' });
    expect(await codeOf(cancelStandbySwap(as(userById(userB)), second.id))).toBe('not_permitted');
    expect((await cancelStandbySwap(as(userById(userA)), second.id)).status).toBe('cancelled');
    expect(await codeOf(cancelStandbySwap(as(userById(userA)), second.id))).toBe('already_decided');
    expect(await codeOf(decideStandbySwap(as(coordinator), second.id, { decision: 'approve' }))).toBe('already_decided');

    // History: the technician sees their own requests, the office all of them.
    expect((await listStandbySwaps(as(userById(userA)))).map((request) => request.status).sort()).toEqual(['cancelled', 'rejected']);
    expect(await listStandbySwaps(as(thabo))).toEqual([]);
    expect(await listStandbySwaps(as(coordinator), 'rejected')).toHaveLength(1);
    const types = (await harness.repos.activity.list()).map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(['standby_swap_requested', 'standby_swap_rejected', 'standby_swap_cancelled']));
  });

  it('lets exactly one of two simultaneous approvals through', async () => {
    const { weekA, userA, weekB, userB } = await twoWeeks('main');
    const request = await requestStandbySwap(as(userById(userA)), { kind: 'main', weekStart: weekA, counterpartId: userB, counterpartWeekStart: weekB, reason: '' });
    const outcomes = await Promise.allSettled([
      decideStandbySwap(as(coordinator), request.id, { decision: 'approve' }),
      decideStandbySwap(as(master), request.id, { decision: 'approve' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await holder(weekA, 'main')).toBe(userB);
    expect(await holder(weekB, 'main')).toBe(userA);
    expect((await harness.repos.notifications.list(userA as never)).filter((note) => note.type === 'standby_swap_decided')).toHaveLength(1);
  });
});

/**
 * STANDBY-ELIG-2 (the owner, 3 November 2026): a Senior Tech can be put on the
 * main and helper standby places by the Office — listed, never made eligible
 * automatically, never an apprentice place. The Office itself never stands by.
 */
describe('STANDBY-ELIG-2: a Senior Tech on the main standby roster', () => {
  it('is listed for the Office, but not eligible until the Office says so', async () => {
    const calendar = await loadStandbyCalendar(as(coordinator), '2026-11-02', '2026-11-08');
    const listed = calendar.people.find((person) => person.id === master.id);
    expect(listed).toMatchObject({ seniorTech: true, main: false, helper: false, apprentice: false });
    expect(calendar.people.some((person) => person.id === coordinator.id)).toBe(false);
  });

  it('is made eligible for main and helper, takes a main place, and is refused an apprentice place', async () => {
    await setStandbyEligibility(as(coordinator), { userId: master.id, main: true, helper: true, apprentice: false });
    expect(await codeOf(setStandbyEligibility(as(coordinator), { userId: master.id, main: false, helper: false, apprentice: true }))).toBe('senior_tech_main_helper');
    expect(await codeOf(setStandbyEligibility(as(coordinator), { userId: coordinator.id, main: true, helper: false, apprentice: false }))).toBe('not_technician');
    await assignStandby(as(coordinator), { weekStart: '2026-11-09', position: 'main', userId: master.id, expectedUserId: null });
    const week = await harness.repos.standby.findWeek('2026-11-09');
    expect(week?.assignments.find((place) => place.position === 'main')?.userId).toBe(master.id);
    const calendar = await loadStandbyCalendar(as(coordinator), '2026-11-09', '2026-11-15');
    expect(calendar.people.find((person) => person.id === master.id)).toMatchObject({ main: true, helper: true });
  });
});
