import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, createdAt, instant, primaryId, rowVersion, updatedAt } from './columns';
import { users } from './identity';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });

/**
 * The customer record.
 *
 * DECISION 11 / the existing model: a customer has many sites and many
 * contacts, and the job card is addressed to a named CONTACT, never to the
 * company mailbox. `email` below is kept only because the demo carries it on
 * historical records — see the LEGACY note.
 */
export const customers = pgTable(
  'customers',
  {
    id: primaryId(),
    name: text('name').notNull(),
    accountNumber: text('account_number').notNull(),
    registrationNumber: text('registration_number').notNull().default(''),
    vatNumber: text('vat_number').notNull().default(''),
    phone: text('phone').notNull().default(''),

    /**
     * LEGACY. Not a job-card recipient.
     *
     * DECISION 4 is explicit: the selected contact's address is the intended
     * recipient and there is no automatic fallback. This column exists so
     * historical records that carried one are not silently rewritten, and is
     * never read by the issue path.
     */
    email: text('email').notNull().default(''),

    officeLine1: text('office_line1').notNull().default(''),
    officeLine2: text('office_line2').notNull().default(''),
    officeCity: text('office_city').notNull().default(''),
    officeProvince: text('office_province').notNull().default(''),
    officePostalCode: text('office_postal_code').notNull().default(''),

    industry: text('industry').notNull().default(''),
    paymentTerms: text('payment_terms').notNull().default(''),
    /** "Customer since": the date EJE started trading with them. */
    customerSince: instant('customer_since'),

    active: boolean('active').notNull().default(true),
    archivedAt: archivedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    uniqueIndex('customers_account_number_key').on(table.accountNumber),
    // Search and the customer picker both look the customer up by name.
    index('customers_name_idx').on(sql`lower(${table.name})`),
    index('customers_registration_number_idx')
      .on(table.registrationNumber)
      .where(sql`${table.registrationNumber} <> ''`),
  ],
);

/** Free-text notes against a customer. Append-only in practice; kept ordered by time. */
export const customerNotes = pgTable(
  'customer_notes',
  {
    id: primaryId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    authorId: uuid('author_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [index('customer_notes_customer_idx').on(table.customerId, table.createdAt)],
);

/**
 * A place work is carried out.
 *
 * Archived, never deleted, once a job has named it: `src/application/removal.ts`
 * states the rule — a closed job card that named a site has to keep naming it.
 */
export const sites = pgTable(
  'sites',
  {
    id: primaryId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    addressLine1: text('address_line1').notNull().default(''),
    addressLine2: text('address_line2').notNull().default(''),
    city: text('city').notNull().default(''),
    province: text('province').notNull().default(''),
    postalCode: text('postal_code').notNull().default(''),
    accessNotes: text('access_notes').notNull().default(''),
    /** For the site-location message a technician may send after accepting. */
    latitude: numeric('latitude', { precision: 9, scale: 6 }),
    longitude: numeric('longitude', { precision: 9, scale: 6 }),

    archivedAt: archivedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('sites_customer_idx')
      .on(table.customerId)
      .where(sql`${table.archivedAt} is null`),
    index('sites_name_idx').on(sql`lower(${table.name})`),
  ],
);

/**
 * A person at the customer.
 *
 * `email` is the job card's recipient (DECISION 4), so it is indexed and its
 * absence is something the office must be able to find and fix. It is NOT
 * globally unique — two people at different customers may share a shared
 * mailbox, and a uniqueness constraint here would refuse legitimate data.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: primaryId(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    /** Null when the contact acts for the whole customer rather than one site. */
    siteId: uuid('site_id').references(() => sites.id, { onDelete: 'restrict' }),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    position: text('position').notNull().default(''),
    email: citext('email').notNull().default(''),
    phone: text('phone').notNull().default(''),
    isPrimary: boolean('is_primary').notNull().default(false),

    /** Set when a job card to this address hard-bounced, so the office knows to fix it. */
    emailBouncedAt: instant('email_bounced_at'),

    archivedAt: archivedAt(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: rowVersion(),
  },
  (table) => [
    index('contacts_customer_idx')
      .on(table.customerId)
      .where(sql`${table.archivedAt} is null`),
    index('contacts_email_idx')
      .on(table.email)
      .where(sql`${table.email} <> ''`),
    // One primary contact per customer, among the ones still on the register.
    uniqueIndex('contacts_one_primary_per_customer')
      .on(table.customerId)
      .where(sql`${table.isPrimary} and ${table.archivedAt} is null`),
  ],
);
