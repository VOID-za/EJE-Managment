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
import { archivedAt, createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
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
    uploadedAt: instant('uploaded_at').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    index('machine_photos_machine_idx').on(table.machineId, table.uploadedAt),
    uniqueIndex('machine_photos_storage_key_key').on(table.storageKey),
  ],
);
