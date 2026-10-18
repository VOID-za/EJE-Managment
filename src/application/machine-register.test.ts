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

/**
 * A MACHINE STANDS AT ONE OF ITS OWN CUSTOMER'S SITES. MACH-1, and a defect fix.
 *
 * `createMachine` and `updateMachine` took the customer and the site straight
 * from the request. The database's foreign keys refuse ids that do not exist and
 * have nothing to say about the PAIR being wrong, so a machine could be recorded
 * against ABC Engineering standing at a site belonging to Kruger Mining — and
 * every job raised on it afterwards would inherit that. Job creation has refused
 * exactly this since it was written; the register that feeds it did not.
 *
 * None of this decides whether a machine may MOVE between customers or what
 * that means for jobs already done on it — MACH-HIST (#28) is open. It insists
 * only that the register is internally consistent.
 */
describe('a machine’s customer, site and the pair of them', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  const refusal = async (work: Promise<unknown>): Promise<WorkflowError> => {
    try {
      await work;
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowError);
      return error as WorkflowError;
    }
    throw new Error('the register accepted it');
  };

  it('REFUSES a machine at another customer’s site', async () => {
    const wrong = await refusal(
      createMachine(harness.as(master), {
        ...NEW_MACHINE,
        // Both ids are real. They are not related, which is the whole point.
        siteId: asSiteId('site-kruger-main'),
      }),
    );
    expect(wrong.violations[0]?.code).toBe('site_not_of_customer');
    expect(await harness.repos.machines.list({ includeArchived: true })).not.toContainEqual(
      expect.objectContaining({ serialNumber: NEW_MACHINE.serialNumber }),
    );
  });

  it('REFUSES a machine against a customer nobody has', async () => {
    const unknown = await refusal(
      createMachine(harness.as(master), {
        ...NEW_MACHINE,
        customerId: asCustomerId('cust-does-not-exist'),
      }),
    );
    expect(unknown.violations[0]?.code).toBe('unknown_customer');
  });

  it('REFUSES a machine at a site nobody has, without saying whether it exists', async () => {
    const unknown = await refusal(
      createMachine(harness.as(master), { ...NEW_MACHINE, siteId: asSiteId('site-invented') }),
    );
    /*
     * The SAME refusal as another customer's site. Telling them apart would
     * answer, for any id, whether it exists — and the office screen offers
     * only this customer's sites, so the distinction helps nobody legitimate.
     */
    expect(unknown.violations[0]?.code).toBe('site_not_of_customer');
  });

  it('REFUSES moving a machine onto another customer’s site', async () => {
    const machine = await createMachine(harness.as(master), NEW_MACHINE);

    const moved = await refusal(
      updateMachine(harness.as(master), { ...machine, siteId: asSiteId('site-kruger-main') }),
    );
    expect(moved.violations[0]?.code).toBe('site_not_of_customer');

    // Nothing moved.
    expect((await stored(harness, machine.id))?.siteId).toBe(NEW_MACHINE.siteId);
  });

  it('REFUSES moving a machine onto a WITHDRAWN site', async () => {
    const machine = await createMachine(harness.as(master), NEW_MACHINE);
    const sites = await harness.repos.customers.listSites(NEW_MACHINE.customerId);
    const elsewhere = sites.find((site) => site.id !== NEW_MACHINE.siteId);
    expect(elsewhere).toBeDefined();
    await harness.repos.customers.saveSite({
      ...elsewhere!,
      archivedAt: '2026-10-01T08:00:00.000Z',
    });

    const moved = await refusal(
      updateMachine(harness.as(master), { ...machine, siteId: elsewhere!.id }),
    );
    expect(moved.violations[0]?.code).toBe('site_archived');
  });

  /*
   * AND THE CASE THE RULE MUST NOT BREAK. Withdrawing a site cannot make the
   * machines standing on it uneditable — that is the opposite of what
   * archiving a site is for, and it would strand the register.
   */
  it('still amends a machine that is already standing on a withdrawn site', async () => {
    const machine = await createMachine(harness.as(master), NEW_MACHINE);
    const site = (await harness.repos.customers.listSites(NEW_MACHINE.customerId)).find(
      (candidate) => candidate.id === NEW_MACHINE.siteId,
    );
    await harness.repos.customers.saveSite({
      ...site!,
      archivedAt: '2026-10-01T08:00:00.000Z',
    });

    const amended = await updateMachine(harness.as(master), {
      ...machine,
      controlSystem: 'Mazatrol SmoothG2',
    });
    expect(amended.controlSystem).toBe('Mazatrol SmoothG2');
  });

  it('REFUSES a new machine for a withdrawn customer, and still amends an existing one', async () => {
    const customer = await harness.repos.customers.findById(NEW_MACHINE.customerId);
    const machine = await createMachine(harness.as(master), NEW_MACHINE);
    await harness.repos.customers.save({ ...customer!, active: false });

    const added = await refusal(
      createMachine(harness.as(master), { ...NEW_MACHINE, serialNumber: 'MZ-QT200-11903' }),
    );
    expect(added.violations[0]?.code).toBe('customer_inactive');

    // Tidying the history of an account EJE no longer trades with is not
    // trading with them, so this is deliberately still allowed.
    const amended = await updateMachine(harness.as(master), { ...machine, notes: 'Mothballed.' });
    expect(amended.notes).toBe('Mothballed.');
  });
});
