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
  /**
   * The customer's own number for the machine, where they use one.
   *
   * Strucmac label their machines STM1, STM2, STM3 and ask for them by that
   * number; the serial number on the rating plate means nothing to them.
   * Optional and free text, because it is the customer's convention rather than
   * ours, and most customers have none — an empty string for those.
   */
  readonly machineNumber: string;
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
  /**
   * When this machine was removed from the register.
   *
   * A machine with job history is archived rather than deleted, so the jobs
   * that were carried out on it still name it. See `Contact.archivedAt`.
   */
  readonly archivedAt: IsoDateTime | null;
}

export const isMachineConfirmed = (machine: Pick<Machine, 'approval'>): boolean =>
  machine.approval === 'approved';

export const machineDisplayName = (machine: Pick<Machine, 'manufacturer' | 'model'>): string =>
  `${machine.manufacturer} ${machine.model}`;

/**
 * How a machine is named where the customer has their own number for it.
 *
 * The customer's number leads, because that is what they say on the telephone;
 * the manufacturer and model follow so the office still knows what it is.
 */
export const machineLabel = (
  machine: Pick<Machine, 'manufacturer' | 'model' | 'machineNumber'>,
): string =>
  machine.machineNumber.trim().length > 0
    ? `${machine.machineNumber.trim()} — ${machineDisplayName(machine)}`
    : machineDisplayName(machine);
