import { beforeEach, describe, expect, it } from 'vitest';
import { standbyHolderOn, standbyWeekOf, type StandbyPosition, type User } from '@/domain';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { assignStandby, generateStandbyYear, publishStandbyYear, setStandbyEligibility } from './standby';
import {
  answerStandbyDaySwap,
  decideStandbyDaySwap,
  listStandbyDaySwaps,
  loadCurrentStandbyWeek,
  loadStandbyDayOptions,
  requestStandbyDaySwap,
  withdrawStandbyDaySwap,
} from './standby-days';
import { WorkflowError } from './errors';

/**
 * STANDBY DAY SWAPS. STANDBY-DAY-1 (2 November 2026).
 *
 * Today is Monday 2 November 2026. The owner's example: one technician holds
 * the main place on Saturday 7 November and another on Saturday 14 November;
 * they swap those two Saturdays — and nothing else moves.
 */
const NOW = '2026-11-02T08:00:00.000Z';
const SAT_7 = '2026-11-07';
const SAT_14 = '2026-11-14';
const SUN_8 = '2026-11-08';
const SUN_15 = '2026-11-15';

const coordinator = seedUser('user-coord-christene');
const master = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');
const riaan = seedUser('user-tech-riaan');
const thabo = seedUser('user-tech-thabo');
const francois = seedUser('user-tech-francois');
const andre = seedUser('user-tech-andre');
const naledi = seedUser('user-tech-naledi');
const deon = seedUser('user-tech-deon');
const lerato = seedUser('user-tech-lerato');
const PEOPLE = [sipho, riaan, thabo, francois, andre, naledi, deon, lerato];

let harness: Harness;
const as = (user: User) => harness.as(user);
const byId = (id: string | null): User => PEOPLE.find((person) => person.id === id)!;

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof WorkflowError) return cause.violations[0]?.code ?? 'workflow_error';
    throw cause;
  }
  throw new Error('expected the operation to be refused');
};

const scheduled = async () => {
  for (const user of [sipho, riaan]) await setStandbyEligibility(as(coordinator), { userId: user.id, main: true, helper: true, apprentice: false });
  for (const user of [thabo, francois]) await setStandbyEligibility(as(coordinator), { userId: user.id, main: false, helper: true, apprentice: false });
  for (const user of [andre, naledi, deon, lerato]) await setStandbyEligibility(as(coordinator), { userId: user.id, main: false, helper: false, apprentice: true });
  await generateStandbyYear(as(coordinator), {
    year: 2026,
    rotation: { main: [sipho.id, riaan.id], helper: [thabo.id, francois.id], apprentice_1: [andre.id, naledi.id], apprentice_2: [deon.id, lerato.id] },
  });
  await publishStandbyYear(as(coordinator), { year: 2026, acknowledgeIncomplete: false });
};

/** Who holds a place on a day, as the calendar now stands (week, then any day override). */
const holderOn = async (date: string, position: StandbyPosition): Promise<string | null> => {
  const weeks = await harness.repos.standby.listWeeks(standbyWeekOf(date), standbyWeekOf(date));
  const overrides = await harness.repos.standby.listDayOverrides(date, date);
  return standbyHolderOn(date, position, weeks, overrides);
};

/** The whole of two weeks, every day and every place — to prove what did NOT move. */
const snapshot = async () => {
  const out: Record<string, string | null> = {};
  for (const monday of ['2026-11-02', '2026-11-09']) {
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(Date.parse(`${monday}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      for (const position of ['main', 'helper', 'apprentice_1', 'apprentice_2'] as const) out[`${date}/${position}`] = await holderOn(date, position);
    }
  }
  return out;
};

beforeEach(() => {
  harness = buildHarness({ clock: { now: () => NOW } });
});

describe('the owner’s example: two Saturdays, and nothing else', () => {
  it('exchanges ONLY the chosen days, after the person asked and then the Office approve', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    expect(jc.id).not.toBe(ruan.id);
    const before = await snapshot();

    const swap = await requestStandbyDaySwap(as(jc), {
      recipientId: ruan.id,
      kind: 'main',
      pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }],
      reason: 'Family wedding',
    });
    expect(swap.status).toBe('awaiting_recipient');
    expect(await snapshot()).toEqual(before); // pending changes nothing

    const answered = await answerStandbyDaySwap(as(ruan), swap.id, { approve: true });
    expect(answered.status).toBe('awaiting_office');
    expect(await snapshot()).toEqual(before); // still nothing until the Office approves

    const approved = await decideStandbyDaySwap(as(coordinator), swap.id, { approve: true, note: 'Fine' });
    expect(approved.status).toBe('approved');
    const after = await snapshot();
    expect(after[`${SAT_7}/main`]).toBe(ruan.id);
    expect(after[`${SAT_14}/main`]).toBe(jc.id);
    // Every other day and every other place is exactly as it was.
    const changed = Object.keys(before).filter((slot) => before[slot] !== after[slot]).sort();
    expect(changed).toEqual([`${SAT_7}/main`, `${SAT_14}/main`]);
    expect(after[`${SUN_8}/main`]).toBe(jc.id);
    expect(after[`${SUN_15}/main`]).toBe(ruan.id);
    // The weekly schedule itself is untouched.
    const week = await harness.repos.standby.findWeek('2026-11-02');
    expect(week?.assignments.find((place) => place.position === 'main')?.userId).toBe(jc.id);
  });

  it('notifies each person at each stage and records every decision', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    const swap = await requestStandbyDaySwap(as(jc), {
      recipientId: ruan.id,
      kind: 'main',
      pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }],
    });
    const typesFor = async (user: User) => (await harness.repos.notifications.list(user.id)).map((note) => note.type);
    expect(await typesFor(ruan)).toContain('standby_day_swap_requested');
    expect(await typesFor(coordinator)).not.toContain('standby_day_swap_for_office'); // not before the person asked agrees
    await answerStandbyDaySwap(as(ruan), swap.id, { approve: true });
    expect(await typesFor(jc)).toContain('standby_day_swap_answered');
    expect(await typesFor(coordinator)).toContain('standby_day_swap_for_office');
    expect(await typesFor(master)).toContain('standby_day_swap_for_office');
    await decideStandbyDaySwap(as(master), swap.id, { approve: true });
    expect(await typesFor(jc)).toContain('standby_day_swap_decided');
    expect(await typesFor(ruan)).toContain('standby_day_swap_decided');
    const trail = (await harness.repos.activity.list()).map((event) => event.type);
    expect(trail).toEqual(expect.arrayContaining(['standby_day_swap_requested', 'standby_day_swap_accepted', 'standby_day_swap_approved']));
    const views = await listStandbyDaySwaps(as(jc));
    expect(views[0]).toMatchObject({ status: 'approved', requesterName: expect.any(String), officeDecidedByName: expect.any(String) });
  });
});

describe('several pairs: all or nothing', () => {
  it('exchanges every pair together', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    const swap = await requestStandbyDaySwap(as(jc), {
      recipientId: ruan.id,
      kind: 'main',
      pairs: [
        { requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' },
        { requesterDate: SUN_8, requesterPosition: 'main', recipientDate: SUN_15, recipientPosition: 'main' },
      ],
    });
    await answerStandbyDaySwap(as(ruan), swap.id, { approve: true });
    await decideStandbyDaySwap(as(coordinator), swap.id, { approve: true });
    expect([await holderOn(SAT_7, 'main'), await holderOn(SUN_8, 'main'), await holderOn(SAT_14, 'main'), await holderOn(SUN_15, 'main')]).toEqual([ruan.id, ruan.id, jc.id, jc.id]);
  });

  it('changes NONE of them when one has gone stale before the Office decides', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    const swap = await requestStandbyDaySwap(as(jc), {
      recipientId: ruan.id,
      kind: 'main',
      pairs: [
        { requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' },
        { requesterDate: SUN_8, requesterPosition: 'main', recipientDate: SUN_15, recipientPosition: 'main' },
      ],
    });
    await answerStandbyDaySwap(as(ruan), swap.id, { approve: true });
    const before = await snapshot();
    // The office gives the week of the 9th's main place to somebody else meanwhile.
    await assignStandby(as(coordinator), { weekStart: '2026-11-09', position: 'main', userId: jc.id, expectedUserId: ruan.id, reason: 'Ruan on leave' });
    const afterOffice = await snapshot();
    expect(await codeOf(decideStandbyDaySwap(as(coordinator), swap.id, { approve: true }))).toMatch(/assignment_changed|would_double_book/u);
    expect(await snapshot()).toEqual(afterOffice);
    expect(afterOffice[`${SAT_7}/main`]).toBe(before[`${SAT_7}/main`]);
    expect((await harness.repos.standby.findDaySwap(swap.id))?.status).toBe('awaiting_office');
    // It can still be rejected.
    expect((await decideStandbyDaySwap(as(coordinator), swap.id, { approve: false })).status).toBe('rejected');
  });
});

describe('denied, rejected, withdrawn: nothing changes', () => {
  const setUp = async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    const swap = await requestStandbyDaySwap(as(jc), {
      recipientId: ruan.id,
      kind: 'main',
      pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }],
    });
    return { jc, ruan, swap };
  };

  it('a denial by the person asked ends it', async () => {
    const { jc, ruan, swap } = await setUp();
    const before = await snapshot();
    expect((await answerStandbyDaySwap(as(ruan), swap.id, { approve: false, note: 'Cannot' })).status).toBe('denied');
    expect(await snapshot()).toEqual(before);
    expect((await harness.repos.notifications.list(jc.id)).map((note) => note.type)).toContain('standby_day_swap_answered');
    expect(await codeOf(decideStandbyDaySwap(as(coordinator), swap.id, { approve: true }))).toBe('already_decided');
  });

  it('a rejection by the Office ends it', async () => {
    const { ruan, swap } = await setUp();
    await answerStandbyDaySwap(as(ruan), swap.id, { approve: true });
    const before = await snapshot();
    expect((await decideStandbyDaySwap(as(coordinator), swap.id, { approve: false })).status).toBe('rejected');
    expect(await snapshot()).toEqual(before);
  });

  it('the requester withdraws before the person asked answers, and not after', async () => {
    const { jc, ruan, swap } = await setUp();
    expect(await codeOf(withdrawStandbyDaySwap(as(ruan), swap.id))).toBe('not_your_request');
    expect((await withdrawStandbyDaySwap(as(jc), swap.id)).status).toBe('withdrawn');
    const again = await requestStandbyDaySwap(as(jc), {
      recipientId: ruan.id,
      kind: 'main',
      pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }],
    });
    await answerStandbyDaySwap(as(ruan), again.id, { approve: true });
    expect(await codeOf(withdrawStandbyDaySwap(as(jc), again.id))).toBe('not_withdrawable');
  });
});

describe('who may do what', () => {
  it('nobody decides for anybody else, and the Office decides only after the person asked', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    const swap = await requestStandbyDaySwap(as(jc), {
      recipientId: ruan.id,
      kind: 'main',
      pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }],
    });
    expect(await codeOf(answerStandbyDaySwap(as(jc), swap.id, { approve: true }))).toBe('not_recipient');
    expect(await codeOf(answerStandbyDaySwap(as(coordinator), swap.id, { approve: true }))).toBe('not_recipient');
    expect(await codeOf(decideStandbyDaySwap(as(coordinator), swap.id, { approve: true }))).toBe('awaiting_recipient');
    expect(await codeOf(decideStandbyDaySwap(as(ruan), swap.id, { approve: true }))).toBe('not_permitted');
    await answerStandbyDaySwap(as(ruan), swap.id, { approve: true });
    expect(await codeOf(decideStandbyDaySwap(as(jc), swap.id, { approve: true }))).toBe('not_permitted');
    expect(await codeOf(answerStandbyDaySwap(as(ruan), swap.id, { approve: false }))).toBe('already_answered');
  });

  it('the office does not ask for swaps; a technician offers only their own days', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    expect(await codeOf(requestStandbyDaySwap(as(coordinator), { recipientId: ruan.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }] }))).toBe('not_permitted');
    // Ruan offering JC's Saturday as if it were his own.
    expect(await codeOf(requestStandbyDaySwap(as(ruan), { recipientId: jc.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }] }))).toBe('not_your_assignment');
  });

  it('an Apprentice (ROLE-APP-1) asks for and answers swaps exactly as a technician does', async () => {
    await scheduled();
    const giver = byId(await holderOn(SAT_7, 'apprentice_1'));
    const taker = byId(await holderOn(SAT_14, 'apprentice_1'));
    await harness.repos.users.save({ ...giver, role: 'apprentice' });
    await harness.repos.users.save({ ...taker, role: 'apprentice' });
    const asGiver = harness.as({ ...giver, role: 'apprentice' });
    const swap = await requestStandbyDaySwap(asGiver, {
      recipientId: taker.id,
      kind: 'apprentice',
      pairs: [{ requesterDate: SAT_7, requesterPosition: 'apprentice_1', recipientDate: SAT_14, recipientPosition: 'apprentice_1' }],
    });
    await answerStandbyDaySwap(harness.as({ ...taker, role: 'apprentice' }), swap.id, { approve: true });
    await decideStandbyDaySwap(as(coordinator), swap.id, { approve: true });
    expect(await holderOn(SAT_7, 'apprentice_1')).toBe(taker.id);
    expect(await holderOn(SAT_14, 'apprentice_1')).toBe(giver.id);
  });
});

describe('eligibility, kinds and double booking', () => {
  it('main stays main, apprentice stays apprentice; a helper’s place is not swapped', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const apprentice = byId(await holderOn(SAT_14, 'apprentice_1'));
    const helper = byId(await holderOn(SAT_7, 'helper'));
    expect(await codeOf(requestStandbyDaySwap(as(jc), { recipientId: apprentice.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'apprentice_1' }] }))).toBe('swap_kind_mismatch');
    expect(await codeOf(requestStandbyDaySwap(as(helper), { recipientId: jc.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'helper', recipientDate: SAT_14, recipientPosition: 'helper' }] }))).toBe('swap_kind_mismatch');
    // A person not eligible for the main place cannot be given one.
    expect(await codeOf(requestStandbyDaySwap(as(jc), { recipientId: apprentice.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }] }))).toMatch(/not_eligible|assignment_changed/u);
  });

  it('refuses a swap that would put somebody in two places on one day', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    // Ruan is made the HELPER for the week of the 2nd: taking JC's Saturday main place would double-book him.
    const helperBefore = await holderOn(SAT_7, 'helper');
    await assignStandby(as(coordinator), { weekStart: '2026-11-02', position: 'helper', userId: ruan.id, expectedUserId: helperBefore as never, reason: 'Cover' });
    expect(await codeOf(requestStandbyDaySwap(as(jc), { recipientId: ruan.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }] }))).toBe('would_double_book');
  });

  it('refuses past days, the same day twice, and a day already in another swap', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    const today = '2026-11-02';
    const todayHolder = byId(await holderOn(today, 'main'));
    expect(await codeOf(requestStandbyDaySwap(as(todayHolder), { recipientId: todayHolder.id === jc.id ? ruan.id : jc.id, kind: 'main', pairs: [{ requesterDate: today, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }] }))).toMatch(/day_not_swappable|not_your_assignment/u);
    expect(await codeOf(requestStandbyDaySwap(as(jc), { recipientId: ruan.id, kind: 'main', pairs: [
      { requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' },
      { requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SUN_15, recipientPosition: 'main' },
    ] }))).toBe('duplicate_day');
    await requestStandbyDaySwap(as(jc), { recipientId: ruan.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }] });
    expect(await codeOf(requestStandbyDaySwap(as(jc), { recipientId: ruan.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SUN_15, recipientPosition: 'main' }] }))).toBe('swap_pending');
  });

  it('lets exactly one of two simultaneous Office approvals through', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    const swap = await requestStandbyDaySwap(as(jc), { recipientId: ruan.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }] });
    await answerStandbyDaySwap(as(ruan), swap.id, { approve: true });
    const results = await Promise.allSettled([
      decideStandbyDaySwap(as(coordinator), swap.id, { approve: true }),
      decideStandbyDaySwap(as(master), swap.id, { approve: true }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await holderOn(SAT_7, 'main')).toBe(ruan.id);
  });

  it('the form offers my future days and other eligible people’s days of the same kind, minus those already in a swap', async () => {
    await scheduled();
    const jc = byId(await holderOn(SAT_7, 'main'));
    const options = await loadStandbyDayOptions(as(jc));
    expect(options.mine.some((option) => option.date === SAT_7 && option.position === 'main')).toBe(true);
    expect(options.mine.every((option) => option.date > '2026-11-02')).toBe(true);
    expect(options.people.every((person) => person.days.every((day) => day.kind === 'main'))).toBe(true);
  });
});

describe('the Overview: this week’s published standby', () => {
  it('shows the four places of the published current week, with any day an approved swap moved', async () => {
    await scheduled();
    const week = await loadCurrentStandbyWeek(as(sipho));
    expect(week).toMatchObject({ weekStart: '2026-11-02', weekEnd: '2026-11-08', published: true });
    expect(week.places.map((place) => place.position)).toEqual(['main', 'helper', 'apprentice_1', 'apprentice_2']);
    expect(week.places.every((place) => place.name !== null)).toBe(true);
    const jc = byId(await holderOn(SAT_7, 'main'));
    const ruan = byId(await holderOn(SAT_14, 'main'));
    const swap = await requestStandbyDaySwap(as(jc), { recipientId: ruan.id, kind: 'main', pairs: [{ requesterDate: SAT_7, requesterPosition: 'main', recipientDate: SAT_14, recipientPosition: 'main' }] });
    await answerStandbyDaySwap(as(ruan), swap.id, { approve: true });
    await decideStandbyDaySwap(as(coordinator), swap.id, { approve: true });
    const after = await loadCurrentStandbyWeek(as(coordinator));
    expect(after.dayChanges).toEqual([expect.objectContaining({ date: SAT_7, position: 'main' })]);
  });

  it('shows nothing from a draft — an empty state instead', async () => {
    for (const user of [sipho, riaan]) await setStandbyEligibility(as(coordinator), { userId: user.id, main: true, helper: true, apprentice: false });
    await generateStandbyYear(as(coordinator), { year: 2026, rotation: { main: [sipho.id, riaan.id] } });
    const week = await loadCurrentStandbyWeek(as(sipho));
    expect(week.published).toBe(false);
    expect(week.places.every((place) => place.name === null)).toBe(true);
    expect((await loadCurrentStandbyWeek(as(coordinator))).published).toBe(false);
  });
});
