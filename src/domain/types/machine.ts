import type {
  Attachment,
  CustomerId,
  IsoDate,
  IsoDateTime,
  MachineId,
  SiteId,
  UserId,
} from './common';
import type { Provenance } from './provenance';

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

/**
 * WHO MAY READ A MACHINE'S DOCUMENT. October mandate §4.
 *
 * The office chooses per document, which is MEDIA-1's answer to the same
 * question about job media: the audience is a property of the paper, not of
 * the table it sits in. A rating-plate manual and a wiring diagram are exactly
 * what a technician wants before driving out; a supplier's invoice for the
 * machine, or a warranty dispute, are not theirs to read.
 *
 * Named for who may read it rather than for what is hidden, so no call site
 * reads a double negative. `office_only` is what the server assumes when
 * nobody said — see `attachMachineDocument`.
 */
export type MachineDocumentAudience = 'field' | 'office_only';

/**
 * A FILE ATTACHED TO A MACHINE. October mandate §4.
 *
 * NOT a `machine_photos` row and not a library document, and both distinctions
 * are load-bearing:
 *
 *   - a PHOTOGRAPH is of the machine as it stands today, renders inline as a
 *     thumbnail, and is readable by anybody who may read the machine;
 *   - a LIBRARY document is EJE's own reference material, filed by manufacturer
 *     and MODEL, approved and versioned, and the same manual serves every
 *     Leadwell V-40 in the country;
 *   - THIS is paper about ONE machine — its commissioning report, its
 *     compliance certificate, the laser-calibration results for that serial
 *     number. Filing it against the model would make it wrong for every other
 *     machine of that model, and filing it as a photograph would render a PDF
 *     as a broken image.
 *
 * `sizeBytes` and `checksumSha256` are MEASURED by the server off the bytes it
 * stored — never supplied by a client, and never invented when no file exists.
 */
export interface MachineDocument {
  readonly id: string;
  readonly machineId: MachineId;
  readonly fileName: string;
  readonly caption: string;
  /** The server's sniffed type, not the browser's claim. */
  readonly contentType: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
  readonly audience: MachineDocumentAudience;
  readonly uploadedAt: IsoDateTime;
  readonly uploadedBy: UserId;
  readonly provenance: Provenance;
  /** Withdrawn by the office, and kept: the register's own rule. */
  readonly archivedAt: IsoDateTime | null;
}

/** Whether a technician standing at the machine may read this document. */
export const isFieldReadable = (document: Pick<MachineDocument, 'audience'>): boolean =>
  document.audience === 'field';

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
