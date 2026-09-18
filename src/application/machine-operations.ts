import {
  approvalForNewMachine,
  asAttachmentId,
  asMachineId,
  can,
  findSerialClash,
  machineDisplayName,
  userFullName,
  type Attachment,
  type CustomerId,
  type Machine,
  type MachineType,
  type SiteId,
} from '@/domain';
import type { OperationContext } from './context';
import { audit, notifyMasters } from './audit';
import { WorkflowError } from './errors';
import type { RemovalResult } from './removal';

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
  /** The customer's own number for the machine. Optional — most have none. */
  readonly machineNumber: string;
  readonly machineType: MachineType;
  readonly year: number;
  readonly installationDate: string;
  readonly controlSystem: string;
  readonly notes: string;
  /**
   * Photographs of the machine as found.
   *
   * Demo note: no file is transferred. Each entry becomes an attachment record
   * with the storage key the production uploader will produce, which is what
   * the machine screen renders, so the model does not change when real uploads
   * arrive.
   */
  readonly photos?: readonly MachinePhotoInput[];
}

export interface MachinePhotoInput {
  readonly fileName: string;
  readonly caption: string;
  readonly sizeBytes: number;
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

  const photos: Attachment[] = [];
  for (const photo of input.photos ?? []) {
    const stored = await context.services.storage.put(photo.fileName, 'image/jpeg', null);
    photos.push({
      id: asAttachmentId(context.services.ids.next('att')),
      kind: 'photo',
      fileName: photo.fileName,
      caption: photo.caption,
      storageKey: stored.storageKey,
      uploadedAt: context.services.clock.now(),
      uploadedBy: context.actor.id,
      sizeBytes: photo.sizeBytes,
    });
  }

  const machine: Machine = {
    id: asMachineId(context.services.ids.next('machine')),
    customerId: input.customerId,
    siteId: input.siteId,
    manufacturer: required(input.manufacturer, 'manufacturer_required', 'A manufacturer is required.'),
    model: required(input.model, 'model_required', 'A model is required.'),
    serialNumber,
    machineNumber: input.machineNumber.trim(),
    machineType: input.machineType,
    year: input.year,
    installationDate: input.installationDate,
    controlSystem: input.controlSystem.trim(),
    notes: input.notes.trim(),
    photos,
    active: true,
    approval,
    createdBy: context.actor.id,
    approvedBy: approval === 'approved' ? context.actor.id : null,
    approvedAt: approval === 'approved' ? now : null,
    createdAt: now,
    archivedAt: null,
  };

  const saved = await context.repos.machines.save(machine);

  await audit(context, {
    jobId: null,
    type: 'machine_created',
    summary: `Machine added: ${machineDisplayName(saved)}`,
    detail:
      `Serial ${saved.serialNumber}. ` +
      (saved.photos.length > 0
        ? `${saved.photos.length} ${saved.photos.length === 1 ? 'photograph' : 'photographs'} attached. `
        : '') +
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

/**
 * Removes a machine from the register.
 *
 * Deleted outright when no job was ever carried out on it — a machine captured
 * against the wrong customer, or a duplicate caught before any work. Archived
 * once it has job history, because those jobs describe work on THIS machine and
 * a job card that could no longer name it would be worthless.
 */
export const removeMachine = async (
  context: OperationContext,
  machine: Machine,
): Promise<RemovalResult> => {
  if (!can(context.actor.role, 'machines.manage')) {
    throw new WorkflowError('Only the office can remove a machine from the register.', [
      {
        code: 'not_permitted',
        message: 'Technicians can add a machine they find on site, but not remove one.',
      },
    ]);
  }

  const jobs = await context.repos.jobs.list({ includeDeleted: true });
  const referencing = jobs.filter((job) => job.machineId === machine.id);
  const name = machineDisplayName(machine);

  if (referencing.length === 0) {
    await context.repos.machines.delete(machine.id);
    await audit(context, {
      jobId: null,
      type: 'machine_deleted',
      summary: `Machine deleted: ${name}`,
      detail: `Serial ${machine.serialNumber} removed by ${userFullName(context.actor)}. No job had ever been carried out on it.`,
    });
    return { outcome: 'deleted', message: `${name} has been deleted.` };
  }

  await context.repos.machines.save({
    ...machine,
    archivedAt: context.services.clock.now(),
  });
  await audit(context, {
    jobId: null,
    type: 'machine_archived',
    summary: `Machine archived: ${name}`,
    detail: `Serial ${machine.serialNumber} has ${referencing.length} ${referencing.length === 1 ? 'job' : 'jobs'} on record, so it is kept and withdrawn from the register rather than deleted.`,
  });
  return {
    outcome: 'archived',
    message: `${name} has been removed from the register. ${referencing.length} ${
      referencing.length === 1 ? 'job was' : 'jobs were'
    } carried out on it, so the machine is kept and that history still reads correctly.`,
  };
};
