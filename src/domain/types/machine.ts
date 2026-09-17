import type {
  Attachment,
  CustomerId,
  IsoDate,
  IsoDateTime,
  MachineId,
  SiteId,
  UserId,
} from './common';

/**
 * Machine types are a closed union in the demo. Phase 2 moves them to a
 * `machine_types` table administered by Masters; the union then becomes the
 * seeded contents of that table.
 */
export type MachineType =
  | 'CNC Milling Machine'
  | 'CNC Lathe'
  | 'Machining Centre'
  | 'Surface Grinder'
  | 'Press Brake'
  | 'Other';

/**
 * Whether the machine is part of the official customer record.
 *
 * A technician on site can add a machine they find, but the official register is
 * the office's: until a Master approves it the machine is visible and usable,
 * marked as unconfirmed, so nobody is blocked from capturing work against it.
 */
export type MachineApproval = 'approved' | 'pending_approval';

export interface Machine {
  readonly id: MachineId;
  readonly customerId: CustomerId;
  readonly siteId: SiteId;
  readonly manufacturer: string;
  readonly model: string;
  readonly serialNumber: string;
  readonly machineType: MachineType;
  readonly year: number;
  readonly installationDate: IsoDate;
  readonly controlSystem: string;
  readonly notes: string;
  readonly photos: readonly Attachment[];
  readonly active: boolean;
  readonly approval: MachineApproval;
  readonly createdBy: UserId;
  readonly approvedBy: UserId | null;
  readonly approvedAt: IsoDateTime | null;
  readonly createdAt: IsoDateTime;
}

export const isMachineConfirmed = (machine: Pick<Machine, 'approval'>): boolean =>
  machine.approval === 'approved';

export const machineDisplayName = (machine: Pick<Machine, 'manufacturer' | 'model'>): string =>
  `${machine.manufacturer} ${machine.model}`;
