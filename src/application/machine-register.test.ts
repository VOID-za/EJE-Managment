import { beforeEach, describe, expect, it } from 'vitest';
import { createMachine, removeMachine, updateMachine } from './machine-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { loadJobView } from './job-view';
import { runSearch } from './search';
import {
  asCustomerId,
  asMachineId,
  asSiteId,
  isMachineConfirmed,
  machineLabel,
  type Machine,
} from '@/domain';

/**
 * The machine register.
 *
 * Two things matter beyond "it saves": the customer's own machine number, which
 * is what they quote on the telephone, and that removing a machine can never
 * cost EJE the jobs carried out on it.
 */

const master = seedUser('user-master-elmarie');
const coordinator = seedUser('user-coord-christene');
const technician = seedUser('user-tech-sipho');

const NEW_MACHINE = {
  customerId: asCustomerId('cust-abc'),
  siteId: asSiteId('site-abc-jhb'),
  manufacturer: 'Mazak',
  model: 'QT-200',
  serialNumber: 'MZ-QT200-11902',
  machineNumber: '',
  machineType: 'CNC Lathe' as const,
  year: 2021,
  installationDate: '2021-04-12',
  controlSystem: 'Mazatrol SmoothG',
  notes: '',
};

const stored = async (harness: Harness, id: string): Promise<Machine | null> =>
  (await harness.repos.machines.list({ includeArchived: true })).find(
    (machine) => machine.id === id,
  ) ?? null;

describe('the customer’s own machine number', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('is optional, and a machine without one keeps working', async () => {
    const machine = await createMachine(harness.as(master), NEW_MACHINE);
    expect(machine.machineNumber).toBe('');
    expect(machineLabel(machine)).toBe('Mazak QT-200');
    expect(isMachineConfirmed(machine)).toBe(true);
  });

  it('leads the machine’s name when the customer uses one', async () => {
    const machine = await createMachine(harness.as(master), {
      ...NEW_MACHINE,
      machineNumber: 'STM1',
    });
    expect(machineLabel(machine)).toBe('STM1 — Mazak QT-200');
  });

  it('is searchable on its own', async () => {
    await createMachine(harness.as(master), { ...NEW_MACHINE, machineNumber: 'STM3' });

    const results = await runSearch(harness.repos, master, 'STM3');
    const machines = results.filter((result) => result.category === 'machine');

    expect(machines).toHaveLength(1);
    expect(machines[0]!.matchedOn).toBe('Machine number');
    expect(machines[0]!.title).toBe('STM3 — Mazak QT-200');
  });

  it('can be added to a machine that never had one, and the change is audited', async () => {
    const machine = await createMachine(harness.as(master), NEW_MACHINE);
    const saved = await updateMachine(harness.as(coordinator), {
      ...machine,
      machineNumber: 'STM2',
    });
    expect(saved.machineNumber).toBe('STM2');
    expect((await stored(harness, machine.id))?.machineNumber).toBe('STM2');

    // The trail names the field that changed, not merely that something did.
    const events = await harness.repos.activity.list();
    const entry = events.find(
      (event) => event.type === 'machine_updated' && event.actorId === coordinator.id,
    );
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('machine number — → STM2');
  });
});

describe('protections that must survive the new fields', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('still refuses a duplicate serial number', async () => {
    await createMachine(harness.as(master), NEW_MACHINE);
    await expect(
      createMachine(harness.as(master), { ...NEW_MACHINE, machineNumber: 'STM9' }),
    ).rejects.toThrow(/already on the register/i);
  });

  it('refuses a duplicate serial even against a machine that has been withdrawn', async () => {
    const machine = await createMachine(harness.as(master), NEW_MACHINE);
    const removal = await removeMachine(harness.as(master), machine);
    expect(removal.outcome).toBe('deleted');

    // Deleted outright, so the serial is genuinely free again.
    await expect(createMachine(harness.as(master), NEW_MACHINE)).resolves.toBeDefined();
  });

  it('still marks a technician’s addition as awaiting approval', async () => {
    const machine = await createMachine(harness.as(technician), NEW_MACHINE);
    expect(isMachineConfirmed(machine)).toBe(false);
    expect(machine.approval).toBe('pending_approval');
  });
});

describe('removing a machine', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('deletes one that no job was ever carried out on', async () => {
    const machine = await createMachine(harness.as(coordinator), NEW_MACHINE);
    const result = await removeMachine(harness.as(coordinator), machine);

    expect(result.outcome).toBe('deleted');
    expect(await stored(harness, machine.id)).toBeNull();
  });

  it('archives one with job history, and that job still names it', async () => {
    const job = await harness.repos.jobs.findByJobNumber('EJE-1044');
    expect(job?.machineId).not.toBeNull();
    const machine = await harness.repos.machines.findById(job!.machineId!);
    expect(machine).not.toBeNull();

    const result = await removeMachine(harness.as(master), machine!);
    expect(result.outcome).toBe('archived');

    const live = await harness.repos.machines.list();
    expect(live.map((candidate) => candidate.id)).not.toContain(machine!.id);

    const view = await loadJobView(harness.repos, 'EJE-1044');
    expect(view).not.toBeNull();
    expect(view!.machine?.id).toBe(machine!.id);
  });

  it('is refused to a technician', async () => {
    const machine = await harness.repos.machines.findById(asMachineId('machine-abc-lv40'));
    await expect(removeMachine(harness.as(technician), machine!)).rejects.toBeInstanceOf(
      WorkflowError,
    );
  });
});
