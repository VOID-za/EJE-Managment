import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  archivedAt,
  createdAt,
  instant,
  primaryId,
  provenance,
  rowVersion,
  updatedAt,
} from './columns';
import { machineApproval } from './enums';
import { customers, sites } from './customers';
import { users } from './identity';
import { machineTypes } from './settings';

/**
 * The machine register.
 *
 * A technician on site may add a machine they find; it is usable immediately,
 * marked unconfirmed, until a Master approves it — so nobody is blocked from
 * capturing work against a machine that is genuinely there. See
 * `types/machine.ts`.
 */
export const machines = pgTable(
  'machines',
  {
    id: primaryId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),

    manufacturer: text('manufacturer').notNull(),
    model: text('model').notNull(),
    serialNumber: text('serial_number').notNull(),
    /**
     * The customer's OWN number for the machine, where they use one.
     *
     * Optional, free text, and separate from the serial number: Strucmac ask
     * for STM1, STM2, STM3 and the rating-plate serial means nothing to them.
     * Most customers have none, so an empty string rather than null keeps every
     * comparison in the domain simple.
     */
    machineNumber: text('machine_number').notNull().default(''),
    machineTypeCode: text('machine_type_code')
      .notNull()
      .references(() => machineTypes.code),
    year: integer('year').notNull(),
    installationDate: date('installation_date'),
    controlSystem: text('control_system').notNull().default(''),
    notes: text('notes').notNull().default(''),

    active: boolean('active').notNull().default(true),
    approval: machineApproval('approval').notNull().default('pending_approval'),
    createdBy: uuid('created_by').references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    approvedAt: instant('approved_at'),

    archivedAt: archivedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    /**
     * A serial number identifies one machine AT ONE CUSTOMER.
     *
     * Not globally unique: two customers can hold machines whose manufacturers
     * assigned the same serial, and refusing the second would be refusing real
     * data. Scoped to the customer, which is the duplicate that actually
     * matters — the same machine entered twice.
     */
    uniqueIndex('machines_customer_serial_key')
      .on(table.customerId, sql`lower(${table.serialNumber})`)
      .where(sql`${table.archivedAt} is null`),
    index('machines_serial_idx').on(sql`lower(${table.serialNumber})`),
    // Searchable on its own: smoke asserts "the machine number is searchable".
    index('machines_machine_number_idx')
      .on(sql`lower(${table.machineNumber})`)
      .where(sql`${table.machineNumber} <> ''`),
    index('machines_site_idx')
      .on(table.siteId)
      .where(sql`${table.archivedAt} is null`),
    index('machines_customer_idx')
      .on(table.customerId)
      .where(sql`${table.archivedAt} is null`),
    check('machines_year_plausible', sql`${table.year} between 1900 and 2200`),
  ],
);

/**
 * How a machine came to be approved. APPEND-ONLY.
 *
 * `machines.approval` is the current state, which the domain reads; this is the
 * record of who decided and when. Two tables because they answer two different
 * questions, and overwriting the second to answer the first loses the history.
 */
export const machineApprovals = pgTable(
  'machine_approvals',
  {
    id: primaryId(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    requestedBy: uuid('requested_by').references(() => users.id),
    requestedAt: instant('requested_at').notNull(),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: instant('decided_at'),
    /** `approved` or `rejected`. Free text so a future third outcome needs no migration. */
    decision: text('decision'),
    note: text('note').notNull().default(''),
    createdAt: createdAt(),
  },
  (table) => [index('machine_approvals_machine_idx').on(table.machineId, table.requestedAt)],
);

/**
 * Photographs of the machine itself.
 *
 * Separate from job media: a photo of the rating plate belongs to the MACHINE
 * and stays useful across every job ever done on it, while a photo of a burnt
 * contactor belongs to the job that found it. The demo held these inline on the
 * machine record; they are a table here for the same reason job media is — each
 * one has its own uploader, its own timestamp and its own file behind
 * `StorageService`.
 */
export const machinePhotos = pgTable(
  'machine_photos',
  {
    id: primaryId(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    caption: text('caption').notNull().default(''),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull().default(''),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    /**
     * SHA-256 of the stored bytes, so a damaged photograph can be told from a
     * lost one. Null for every row written before `0021` and for the seeded
     * demonstration photographs, which have no bytes.
     */
    checksumSha256: text('checksum_sha256'),
    uploadedAt: instant('uploaded_at').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    /** A photograph of a real machine, or a demonstration one. Mandate §1. */
    provenance: provenance(),
    createdAt: createdAt(),
  },
  (table) => [
    index('machine_photos_machine_idx').on(table.machineId, table.uploadedAt),
    uniqueIndex('machine_photos_storage_key_key').on(table.storageKey),
    check('machine_photos_provenance_known', sql`${table.provenance} in ('genuine', 'simulated', 'unknown')`),
  ],
);

/**
 * DOCUMENTS ABOUT ONE MACHINE. October mandate §4.
 *
 * Its own table rather than a row on `machine_photos` with a PDF in it: a
 * photograph renders inline as a thumbnail and is readable by anybody who may
 * read the machine, and a document is neither of those things. And not the
 * technical library, which files by manufacturer and MODEL — a commissioning
 * report for one serial number filed against the model would be wrong for
 * every other machine of that model.
 *
 * CASCADE, unlike `customer_documents`. A machine with job history is archived
 * rather than deleted (`src/application/removal.ts`), so the delete that this
 * key governs only ever happens to a machine nothing refers to at all — an
 * entry somebody created by mistake — and its paperwork should go with it.
 * `machine_photos` and `machine_approvals` are cascade for the same reason.
 */
export const machineDocuments = pgTable(
  'machine_documents',
  {
    id: primaryId(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    fileName: text('file_name').notNull(),
    caption: text('caption').notNull().default(''),
    /** The server's SNIFFED type, never the browser's claim. */
    contentType: text('content_type').notNull(),
    storageKey: text('storage_key').notNull(),
    /** Measured off the bytes that were stored. Never supplied by a client. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** SHA-256 of those bytes, so a damaged file can be told from a lost one. */
    checksumSha256: text('checksum_sha256'),
    /**
     * Who may read it: `field` or `office_only`. MEDIA-1's answer, applied to
     * machine paperwork.
     *
     * DEFAULTS TO `office_only`, which is the safe direction: a document
     * nobody classified is not shown to the field, and a manual somebody
     * forgot to mark is an inconvenience rather than a disclosure.
     */
    audience: text('audience').notNull().default('office_only'),
    uploadedAt: instant('uploaded_at').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    provenance: provenance(),
    archivedAt: archivedAt(),
    createdAt: createdAt(),
  },
  (table) => [
    index('machine_documents_machine_idx').on(table.machineId, table.uploadedAt),
    uniqueIndex('machine_documents_storage_key_key').on(table.storageKey),
    check('machine_documents_size_positive', sql`${table.sizeBytes} > 0`),
    check(
      'machine_documents_audience_known',
      sql`${table.audience} in ('field', 'office_only')`,
    ),
    check(
      'machine_documents_provenance_known',
      sql`${table.provenance} in ('genuine', 'simulated', 'unknown')`,
    ),
  ],
);

/**
 * WHERE A MACHINE HAS STOOD, AND SINCE WHEN. MACH-HIST.
 *
 * Append-only by convention and by the absence of any update path: nothing in
 * the application amends a movement, because a movement is something that
 * happened. A move recorded wrongly is corrected by recording the real one —
 * the same discipline as a correction to an issued job card.
 *
 * `from_*` ARE NULL ON THE FIRST ROW, which is where the machine was installed.
 * Both ends are stored so "where was it before" is one row rather than a scan
 * of every other row in order.
 *
 * EVERY FOREIGN KEY RESTRICTS. A site cannot be deleted out from under a
 * movement that names it — the history would then say the machine moved
 * somewhere that no longer exists, which is worse than refusing the delete.
 */
export const machineMovements = pgTable(
  'machine_movements',
  {
    id: primaryId(),
    machineId: uuid('machine_id')
      .notNull()
      .references(() => machines.id, { onDelete: 'cascade' }),
    fromSiteId: uuid('from_site_id').references(() => sites.id, { onDelete: 'restrict' }),
    fromCustomerId: uuid('from_customer_id').references(() => customers.id, {
      onDelete: 'restrict',
    }),
    toSiteId: uuid('to_site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    toCustomerId: uuid('to_customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** The day the machine moved, as the office states it. Not the typing day. */
    effectiveOn: date('effective_on').notNull(),
    note: text('note').notNull().default(''),
    recordedBy: uuid('recorded_by').references(() => users.id),
    recordedAt: instant('recorded_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // Read newest-first for one machine, which is the only query there is.
    index('machine_movements_machine_idx').on(table.machineId, table.effectiveOn),
    /*
     * A MOVE HAS TO MOVE SOMETHING.
     *
     * Both halves unchanged is not a movement — it is an edit to the serial
     * number that happened to save the site as well, and recording it would
     * fill the history with rows saying the machine stayed where it was. The
     * first row has no `from_*` at all and is admitted by the first arm.
     */
    check(
      'machine_movements_moves_something',
      sql`(${table.fromSiteId} is null and ${table.fromCustomerId} is null)
          or ${table.fromSiteId} <> ${table.toSiteId}
          or ${table.fromCustomerId} <> ${table.toCustomerId}`,
    ),
    // Both `from_*` or neither: half a starting point is not a starting point.
    check(
      'machine_movements_from_is_whole',
      sql`(${table.fromSiteId} is null) = (${table.fromCustomerId} is null)`,
    ),
  ],
);
