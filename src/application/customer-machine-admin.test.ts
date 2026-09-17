import { beforeEach, describe, expect, it } from 'vitest';
import { createCustomer, createSite } from './customer-operations';
import { approveMachine, createMachine, updateMachine } from './machine-operations';
import { WorkflowError } from './errors';
import { buildHarness, seedUser, type Harness } from './test-harness';
import { asCustomerId, asSiteId, isMachineConfirmed, pendingMachines } from '@/domain';

/**
 * Adding customers and machines.
 *
 * The register belongs to the office: only a Master creates a customer. A
 * machine is different — a technician who finds one on site must be able to
 * record it and keep working, so it is added immediately but unconfirmed.
 */
const elmarie = seedUser('user-master-elmarie');
const sipho = seedUser('user-tech-sipho');

const NEW_CUSTOMER = {
  name: 'Zenith Precision Works',
  accountNumber: 'ZEN001',
  registrationNumber: '2019/447781/07',
  vatNumber: '4880299110',
  phone: '+27 11 555 0330',
  email: 'accounts@zenith-demo.co.za',
  industry: 'Precision machining',
  paymentTerms: '30 days from statement',
  site: {
    name: 'Zenith Germiston',
    addressLine1: '22 Anvil Street',
    addressLine2: '',
    city: 'Germiston',
    province: 'Gauteng',
    postalCode: '1401',
    accessNotes: 'Report to the gatehouse. Safety induction required.',
  },
  contact: {
    firstName: 'Marlize',
    lastName: 'Botha',
    position: 'Production Manager',
    email: 'marlize@zenith-demo.co.za',
    phone: '+27 82 555 0331',
    isPrimary: true,
  },
};

describe('adding a customer', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('creates the company, its first site and its first contact', async () => {
    const created = await createCustomer(harness.as(elmarie), NEW_CUSTOMER);

    expect(created.customer.name).toBe('Zenith Precision Works');
    expect(created.site.customerId).toBe(created.customer.id);
    expect(created.contact?.siteId).toBe(created.site.id);

    const customers = await harness.repos.customers.list();
    expect(customers.some((customer) => customer.id === created.customer.id)).toBe(true);

    const sites = await harness.repos.customers.listSites(created.customer.id);
    expect(sites).toHaveLength(1);
  });

  it('makes the new customer and site available for raising a job', async () => {
    const created = await createCustomer(harness.as(elmarie), NEW_CUSTOMER);

    // Exactly the reads the new-job screen performs.
    const customers = await harness.repos.customers.list();
    const sites = await harness.repos.customers.listSites(created.customer.id);
    const contacts = await harness.repos.customers.listContacts(created.customer.id);

    expect(customers.map((customer) => customer.name)).toContain('Zenith Precision Works');
    expect(sites.map((site) => site.name)).toContain('Zenith Germiston');
    expect(contacts).toHaveLength(1);
  });

  it('refuses a duplicate customer name', async () => {
    await createCustomer(harness.as(elmarie), NEW_CUSTOMER);
    await expect(
      createCustomer(harness.as(elmarie), NEW_CUSTOMER),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses a customer with no street address', async () => {
    await expect(
      createCustomer(harness.as(elmarie), {
        ...NEW_CUSTOMER,
        site: { ...NEW_CUSTOMER.site, addressLine1: '  ' },
      }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses a technician creating a customer', async () => {
    await expect(
      createCustomer(harness.as(sipho), NEW_CUSTOMER),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses a technician adding a site', async () => {
    await expect(
      createSite(harness.as(sipho), asCustomerId('cust-abc'), NEW_CUSTOMER.site),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

const NEW_MACHINE = {
  customerId: asCustomerId('cust-abc'),
  siteId: asSiteId('site-abc-jhb'),
  manufacturer: 'Mazak',
  model: 'QT-200',
  serialNumber: 'MZ-QT200-11902',
  machineType: 'CNC Lathe' as const,
  year: 2021,
  installationDate: '2021-04-12',
  controlSystem: 'Mazatrol SmoothG',
  notes: '',
};

describe('adding a machine', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('puts a Master addition straight onto the official register', async () => {
    const machine = await createMachine(harness.as(elmarie), NEW_MACHINE);
    expect(isMachineConfirmed(machine)).toBe(true);
    expect(machine.approvedBy).toBe(elmarie.id);
  });

  it('leaves a technician addition usable but awaiting approval', async () => {
    const machine = await createMachine(harness.as(sipho), NEW_MACHINE);

    expect(machine.approval).toBe('pending_approval');
    expect(machine.approvedBy).toBeNull();
    // Usable immediately: work on site is never blocked waiting for the office.
    expect(machine.active).toBe(true);

    const listed = await harness.repos.machines.list();
    expect(listed.some((candidate) => candidate.id === machine.id)).toBe(true);
  });

  it('notifies every active Master that a machine needs approval', async () => {
    await createMachine(harness.as(sipho), NEW_MACHINE);

    const users = await harness.repos.users.list();
    const masters = users.filter((user) => user.role === 'master' && user.active);
    expect(masters.length).toBeGreaterThan(0);

    for (const master of masters) {
      const notifications = await harness.repos.notifications.list(master.id);
      expect(
        notifications.some((notification) => notification.type === 'machine_approval_request'),
      ).toBe(true);
    }
  });

  it('lets a Master confirm a technician addition onto the register', async () => {
    const pending = await createMachine(harness.as(sipho), NEW_MACHINE);
    const approved = await approveMachine(harness.as(elmarie), pending);

    expect(isMachineConfirmed(approved)).toBe(true);
    expect(approved.approvedBy).toBe(elmarie.id);

    const machines = await harness.repos.machines.list();
    expect(pendingMachines(machines).some((machine) => machine.id === approved.id)).toBe(false);
  });

  it('refuses a technician approving their own machine', async () => {
    const pending = await createMachine(harness.as(sipho), NEW_MACHINE);
    await expect(
      approveMachine(harness.as(sipho), pending),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('appears under its customer', async () => {
    const machine = await createMachine(harness.as(elmarie), NEW_MACHINE);
    const machines = await harness.repos.machines.list();
    const forCustomer = machines.filter(
      (candidate) => candidate.customerId === asCustomerId('cust-abc'),
    );
    expect(forCustomer.some((candidate) => candidate.id === machine.id)).toBe(true);
  });

  it('can be selected when creating a job, and carries its own history', async () => {
    const machine = await createMachine(harness.as(elmarie), NEW_MACHINE);

    // What the new-job screen and the machine history page each read.
    const selectable = await harness.repos.machines.list();
    expect(selectable.map((candidate) => candidate.id)).toContain(machine.id);

    const history = await harness.repos.jobs.list({ machineId: machine.id });
    expect(history).toHaveLength(0);
  });
});

describe('duplicate serial protection', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('refuses a serial that is already on the register', async () => {
    await createMachine(harness.as(elmarie), NEW_MACHINE);
    await expect(
      createMachine(harness.as(elmarie), { ...NEW_MACHINE, model: 'QT-250' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('ignores case and spacing when comparing serials', async () => {
    await expect(
      createMachine(harness.as(elmarie), { ...NEW_MACHINE, serialNumber: ' lw-v40-70214 ' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('refuses an edit that would collide with another machine', async () => {
    const machine = await createMachine(harness.as(elmarie), NEW_MACHINE);
    await expect(
      updateMachine(harness.as(elmarie), { ...machine, serialNumber: 'LW-V40-70214' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it('allows a machine to be saved with its own unchanged serial', async () => {
    const machine = await createMachine(harness.as(elmarie), NEW_MACHINE);
    const saved = await updateMachine(harness.as(elmarie), { ...machine, notes: 'Under warranty.' });
    expect(saved.notes).toBe('Under warranty.');
  });

  it('refuses a machine with no serial number', async () => {
    await expect(
      createMachine(harness.as(elmarie), { ...NEW_MACHINE, serialNumber: '' }),
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});
