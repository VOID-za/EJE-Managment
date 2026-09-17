import type { Attachment, CustomerId, IsoDate, IsoDateTime, MachineId, SiteId } from './common';

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
  readonly createdAt: IsoDateTime;
}

export const machineDisplayName = (machine: Pick<Machine, 'manufacturer' | 'model'>): string =>
  `${machine.manufacturer} ${machine.model}`;
