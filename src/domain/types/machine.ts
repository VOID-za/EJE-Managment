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
 * WHERE A MACHINE HAS STOOD, AND SINCE WHEN. MACH-HIST.
 *
 * WHAT WAS WRONG WITHOUT THIS. `Machine.siteId` is the CURRENT site, so the
 * register could answer "where is it" and nothing could answer "where was it".
 * A job finished eighteen months ago resolved its machine and its site LIVE,
 * which reads like a record of where the work happened and is not one — the
 * machine may have been moved twice since. The job screen says so in words
 * today ("the register as it stands today") because there was nothing better
 * to say.
 *
 * ONE ROW PER MOVE, APPEND-ONLY, AND IT CARRIES BOTH ENDS. Both the site and
 * the customer, because a machine moving between a customer's own sites and a
 * machine being sold to another customer are the same event to the register
 * and very different events to EJE — and a history that recorded only the
 * destination could not answer "where was it before" without reading every
 * other row in order.
 *
 * `effectiveOn` IS THE DAY IT MOVED, NOT THE DAY SOMEBODY TYPED IT. The office
 * learns about a move after the fact: a technician arrives and the machine is
 * in the next bay. Recording the typing date would put the machine in the wrong
 * place for however long the paperwork took, which is precisely the question
 * this exists to answer.
 */
export interface MachineMovement {
  readonly id: string;
  readonly machineId: MachineId;
  /** Null on the FIRST record, which is where the machine was installed. */
  readonly fromSiteId: SiteId | null;
  readonly fromCustomerId: CustomerId | null;
  readonly toSiteId: SiteId;
  readonly toCustomerId: CustomerId;
  /** The day the machine actually moved, as the office states it. */
  readonly effectiveOn: IsoDate;
  /** Why, where anybody said. Free text, and usually empty. */
  readonly note: string;
  readonly recordedBy: UserId;
  readonly recordedAt: IsoDateTime;
}

/**
 * Where a machine stood on a given day, from its movement history.
 *
 * A PURE FUNCTION, and deliberately not wired into the job screen. What a
 * historical job card should SHOW — today's register, or the site as at the
 * day the work was done — is EJE's decision (#28), and it changes what a
 * customer reads on a document. This is the half that is not a decision: given
 * the history, the answer is computable, so the decision is a one-line wiring
 * change rather than a feature.
 *
 * Movements are read NEWEST-FIRST and the first one effective on or before the
 * date wins. A date before every movement returns null — not the installation
 * site, because "we do not know where it was then" and "it was here" are
 * different answers and only one of them is true.
 */
export const machineLocationAsAt = (
  movements: readonly MachineMovement[],
  on: IsoDate,
): { readonly siteId: SiteId; readonly customerId: CustomerId } | null => {
  const ordered = [...movements].sort((a, b) =>
    a.effectiveOn === b.effectiveOn
      ? b.recordedAt.localeCompare(a.recordedAt)
      : b.effectiveOn.localeCompare(a.effectiveOn),
  );
  const current = ordered.find((movement) => movement.effectiveOn <= on);
  return current === undefined
    ? null
    : { siteId: current.toSiteId, customerId: current.toCustomerId };
};

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
