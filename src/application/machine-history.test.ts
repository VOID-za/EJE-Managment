import { beforeEach, describe, expect, it } from 'vitest';
import { updateMachine } from './machine-operations';
import { WorkflowError } from './errors';
import type { OperationContext } from './context';
import { createDemoRepositories } from '@/data/demo/repositories';
import { DemoStore } from '@/data/demo/demo-store';
import { SimulatedEmailService } from '@/services/simulated/email';
import { SimulatedOutbox } from '@/services/simulated/outbox';
import { SimulatedPdfService } from '@/services/simulated/pdf';
import { inMemoryFileStore, DemoStorageService } from '@/services/simulated/storage';
import { SequentialIdGenerator, SystemClock } from '@/services/simulated/system';
import { SimulatedWhatsAppService } from '@/services/simulated/whatsapp';
import { seedUsers } from '@/data/seed';
import { asSiteId, machineLocationAsAt, type MachineMovement } from '@/domain';
import type { RepositoryBundle } from '@/data/repositories';

/**
 * WHERE A MACHINE HAS STOOD, AND SINCE WHEN. MACH-HIST.
 *
 * `Machine.siteId` is the CURRENT site, so the register could answer "where is
 * it" and nothing could answer "where was it". A job finished eighteen months
 * ago resolves its machine and its site LIVE, which reads like a record of
 * where the work happened and is not one.
 *
 * WHAT IS ASSERTED HERE:
 *
 *  - a move is recorded as a move, with BOTH ENDS and the day it happened;
 *  - an amendment that does not move the machine records NOTHING, because a
 *    history full of "it stayed where it was" is a history nobody can read;
 *  - the day is the day it MOVED, which the office states, not the day the
 *    paperwork was done;
 *  - and `machineLocationAsAt` answers from the history, including answering
 *    NULL for a date the history cannot speak for.
 */
const master = seedUsers.find((user) => user.role === 'master')!;

interface Harness {
  readonly repos: RepositoryBundle;
  readonly context: OperationContext;
}

const build = (): Harness => {
  const store = new DemoStore();
  const repos = createDemoRepositories({ read: store.read, commit: store.commit });
  const clock = new SystemClock();
  const ids = new SequentialIdGenerator();
  const outbox = new SimulatedOutbox();
  return {
    repos,
    context: {
      repos,
      actor: master,
      services: {
        clock,
        ids,
        email: new SimulatedEmailService(outbox, clock, ids),
        whatsapp: new SimulatedWhatsAppService(outbox, clock, ids),
        pdf: new SimulatedPdfService(clock),
        storage: new DemoStorageService(inMemoryFileStore()),
      },
    },
  };
};

/** A machine, and a second site belonging to the SAME customer to move it to. */
const movable = async (harness: Harness) => {
  const machines = await harness.repos.machines.list();
  for (const machine of machines) {
    const sites = await harness.repos.customers.listSites(machine.customerId);
    const other = sites.find((site) => site.id !== machine.siteId);
    if (other !== undefined) return { machine, destination: asSiteId(other.id) };
  }
  throw new Error('the demonstration register has no customer with two sites');
};

describe('recording a machine’s move', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = build();
  });

  it('records BOTH ENDS when the site changes', async () => {
    const { machine, destination } = await movable(harness);

    await updateMachine(harness.context, { ...machine, siteId: destination });

    const movements = await harness.repos.machines.listMovements(machine.id);
    expect(movements).toHaveLength(1);
    expect(movements[0]?.fromSiteId).toBe(machine.siteId);
    expect(movements[0]?.toSiteId).toBe(destination);
    // The customer at both ends too: a move between a customer's own sites and
    // a machine being sold are the same event to the register and very
    // different events to EJE.
    expect(movements[0]?.fromCustomerId).toBe(machine.customerId);
    expect(movements[0]?.toCustomerId).toBe(machine.customerId);
    expect(movements[0]?.recordedBy).toBe(master.id);
  });

  it('records NOTHING when the machine did not move', async () => {
    /*
     * The amendment that is not a movement. Without this the history fills
     * with rows saying the machine stayed where it was, every time somebody
     * corrects a serial number — and a history nobody can read is worse than
     * none, because it looks like one.
     */
    const { machine } = await movable(harness);

    await updateMachine(harness.context, { ...machine, notes: 'Second encoder fitted 2024.' });

    expect(await harness.repos.machines.listMovements(machine.id)).toHaveLength(0);
  });

  it('takes the day the machine MOVED, not the day it was typed', async () => {
    const { machine, destination } = await movable(harness);

    await updateMachine(
      harness.context,
      { ...machine, siteId: destination },
      '2026-09-14',
      'Moved to the new bay after the workshop extension.',
    );

    const [movement] = await harness.repos.machines.listMovements(machine.id);
    expect(movement?.effectiveOn).toBe('2026-09-14');
    expect(movement?.note).toMatch(/workshop extension/u);
    // And the moment it was WRITTEN DOWN is kept separately, because "when did
    // it move" and "when did we find out" are different questions.
    expect(movement?.recordedAt).not.toBe('2026-09-14');
  });

  it('defaults the day to today, which is right for a move as it happens', async () => {
    const { machine, destination } = await movable(harness);
    await updateMachine(harness.context, { ...machine, siteId: destination });

    const [movement] = await harness.repos.machines.listMovements(machine.id);
    expect(movement?.effectiveOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('keeps every move, newest first', async () => {
    const { machine, destination } = await movable(harness);
    const moved = await updateMachine(
      harness.context,
      { ...machine, siteId: destination },
      '2026-03-01',
    );
    await updateMachine(harness.context, { ...moved, siteId: machine.siteId }, '2026-08-01');

    const movements = await harness.repos.machines.listMovements(machine.id);
    expect(movements).toHaveLength(2);
    expect(movements[0]?.effectiveOn).toBe('2026-08-01');
    expect(movements[1]?.effectiveOn).toBe('2026-03-01');
    // The second move's starting point is the first move's destination, so the
    // history reads as a chain without anybody having to join it up.
    expect(movements[0]?.fromSiteId).toBe(destination);
  });

  it('says on the audit trail that the site changed', async () => {
    const { machine, destination } = await movable(harness);
    await updateMachine(harness.context, { ...machine, siteId: destination });

    const events = await harness.repos.activity.list(undefined);
    const updated = events.find((event) => event.type === 'machine_updated');
    expect(updated?.detail).toMatch(/site/u);
  });

  it('is still REFUSED to a site that is not the customer’s', async () => {
    // Unchanged by MACH-HIST, and asserted here because recording a move must
    // not become a way round the register's own consistency rule.
    const { machine } = await movable(harness);
    const machines = await harness.repos.machines.list();
    const foreign = machines.find((candidate) => candidate.customerId !== machine.customerId);

    await expect(
      updateMachine(harness.context, { ...machine, siteId: foreign!.siteId }),
    ).rejects.toThrow(WorkflowError);
    expect(await harness.repos.machines.listMovements(machine.id)).toHaveLength(0);
  });
});

describe('where a machine stood on a given day', () => {
  /*
   * The overrides are loose strings rather than branded ids, and cast once
   * here: these are fixtures for a PURE function, so the ids need only be
   * distinguishable from each other, and branding every literal would bury
   * what each case is about.
   */
  const movement = (over: Record<string, string | null> = {}): MachineMovement =>
    ({
      id: `mov-${Math.random()}`,
      machineId: 'machine-1',
      fromSiteId: 'site-a',
      fromCustomerId: 'cust-1',
      toSiteId: 'site-b',
      toCustomerId: 'cust-1',
      effectiveOn: '2026-06-01',
      note: '',
      recordedBy: 'user-1',
      recordedAt: '2026-06-02T09:00:00.000Z',
      ...over,
    }) as MachineMovement;

  it('answers with the move in force on that day', () => {
    const history = [
      movement({ effectiveOn: '2026-06-01', toSiteId: 'site-b' }),
      movement({ effectiveOn: '2026-01-15', toSiteId: 'site-a', fromSiteId: null, fromCustomerId: null }),
    ];

    expect(machineLocationAsAt(history, '2026-07-01')?.siteId).toBe('site-b');
    expect(machineLocationAsAt(history, '2026-06-01')?.siteId).toBe('site-b');
    // The day BEFORE the move: still at the old site, which is the whole point.
    expect(machineLocationAsAt(history, '2026-05-31')?.siteId).toBe('site-a');
  });

  it('answers NULL for a date the history cannot speak for', () => {
    /*
     * Not the installation site, and not a guess. Nothing was backfilled when
     * this record was added, so "we do not know where it was then" is the true
     * answer — and it is a different answer from "it was here".
     */
    const history = [movement({ effectiveOn: '2026-06-01' })];
    expect(machineLocationAsAt(history, '2026-01-01')).toBeNull();
    expect(machineLocationAsAt([], '2026-06-01')).toBeNull();
  });

  it('breaks a tie on the same day by which was recorded second', () => {
    const history = [
      movement({
        effectiveOn: '2026-06-01',
        toSiteId: 'site-c',
        recordedAt: '2026-06-03T09:00:00.000Z',
      }),
      movement({
        effectiveOn: '2026-06-01',
        toSiteId: 'site-b',
        recordedAt: '2026-06-02T09:00:00.000Z',
      }),
    ];
    // Two moves stated as effective on one day: the later correction wins.
    expect(machineLocationAsAt(history, '2026-06-01')?.siteId).toBe('site-c');
  });

  it('follows the machine when it changes hands', () => {
    const history = [
      movement({
        effectiveOn: '2026-06-01',
        fromCustomerId: 'cust-1',
        toCustomerId: 'cust-2',
        toSiteId: 'site-z',
      }),
    ];
    const at = machineLocationAsAt(history, '2026-06-02');
    expect(at?.customerId).toBe('cust-2');
    expect(at?.siteId).toBe('site-z');
  });
});
