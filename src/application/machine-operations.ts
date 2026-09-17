import {
  approvalForNewMachine,
  asMachineId,
  can,
  findSerialClash,
  machineDisplayName,
  userFullName,
  type CustomerId,
  type Machine,
  type MachineType,
  type SiteId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit, notifyMasters } from './audit';
import { WorkflowError } from './errors';

/**
 * Machine register operations.
 *
 * A technician who finds an unrecorded machine on site can add it and carry on
 * working: the machine is usable immediately but marked unconfirmed until a
 * Master approves it onto the official register. Duplicate serial numbers are
 * refused for everyone — two records for one physical asset would split its
 * history.
 */
export interface NewMachineInput {
  readonly customerId: CustomerId;
  readonly siteId: SiteId;
  readonly manufacturer: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly machineType: MachineType;
  readonly year: number;
  readonly installationDate: string;
  readonly controlSystem: string;
  readonly notes: string;
}

const required = (value: string, code: string, message: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new WorkflowError(message, [{ code, message }]);
  return trimmed;
};

const assertSerialFree = async (
  context: OperationContext,
  serialNumber: string,
  excludingId?: string,
): Promise<void> => {
  const machines = await context.repos.machines.list();
  const clash = findSerialClash(machines, serialNumber, excludingId);
  if (clash === null) return;

  throw new WorkflowError(`Serial number ${clash.serialNumber} is already on the register.`, [
    {
      code: 'duplicate_serial',
      message: `It belongs to the ${machineDisplayName(clash)} already recorded against this customer.`,
    },
  ]);
};

export const createMachine = async (
  context: OperationContext,
  input: NewMachineInput,
): Promise<Machine> => {
  const serialNumber = required(
    input.serialNumber,
    'serial_required',
    'A serial number is required: it is how a machine is identified across jobs.',
  );
  await assertSerialFree(context, serialNumber);

  const approval = approvalForNewMachine(context.actor.role);
  const now = context.services.clock.now();

  const machine: Machine = {
    id: asMachineId(context.services.ids.next('machine')),
    customerId: input.customerId,
    siteId: input.siteId,
    manufacturer: required(input.manufacturer, 'manufacturer_required', 'A manufacturer is required.'),
    model: required(input.model, 'model_required', 'A model is required.'),
    serialNumber,
    machineType: input.machineType,
    year: input.year,
    installationDate: input.installationDate,
    controlSystem: input.controlSystem.trim(),
    notes: input.notes.trim(),
    photos: [],
    active: true,
    approval,
    createdBy: context.actor.id,
    approvedBy: approval === 'approved' ? context.actor.id : null,
    approvedAt: approval === 'approved' ? now : null,
    createdAt: now,
  };

  const saved = await context.repos.machines.save(machine);

  await audit(context, {
    jobId: null,
    type: 'machine_created',
    summary: `Machine added: ${machineDisplayName(saved)}`,
    detail:
      `Serial ${saved.serialNumber}. ` +
      (approval === 'approved'
        ? 'Added directly to the official register by the office.'
        : 'Added on site and awaiting Master approval.'),
  });

  if (approval === 'pending_approval') {
    await notifyMasters(context, {
      type: 'machine_approval_request',
      title: 'Machine awaiting approval',
      body: `${userFullName(context.actor)} added ${machineDisplayName(saved)} (serial ${saved.serialNumber}) on site. Confirm it onto the register.`,
    });
  }

  return saved;
};

export const approveMachine = async (
  context: OperationContext,
  machine: Machine,
): Promise<Machine> => {
  if (!can(context.actor.role, 'machines.manage')) {
    throw new WorkflowError('Only a Master can confirm a machine onto the register.', [
      { code: 'not_permitted', message: 'Technicians can add machines but not approve them.' },
    ]);
  }
  if (machine.approval === 'approved') return machine;

  const saved = await context.repos.machines.save({
    ...machine,
    approval: 'approved',
    approvedBy: context.actor.id,
    approvedAt: context.services.clock.now(),
  });

  await audit(context, {
    jobId: null,
    type: 'machine_approved',
    summary: `Machine confirmed: ${machineDisplayName(saved)}`,
    detail: `Serial ${saved.serialNumber} confirmed onto the official register by ${userFullName(context.actor)}.`,
  });
  return saved;
};

export const updateMachine = async (
  context: OperationContext,
  machine: Machine,
): Promise<Machine> => {
  if (!can(context.actor.role, 'machines.manage')) {
    throw new WorkflowError('Only a Master can change the official machine record.', [
      { code: 'not_permitted', message: 'Technicians can raise a change request instead.' },
    ]);
  }
  await assertSerialFree(context, machine.serialNumber, machine.id);

  const saved = await context.repos.machines.save(machine);
  await audit(context, {
    jobId: null,
    type: 'machine_updated',
    summary: `Machine updated: ${machineDisplayName(saved)}`,
    detail: `Serial ${saved.serialNumber} amended by ${userFullName(context.actor)}.`,
  });
  return saved;
};
